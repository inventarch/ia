import { SEVERITIES, SHAPE_ROWS } from '@inventarch/language';
import type { Band, Kind, Lane, Predicate } from '@inventarch/language';
import { digest, effectiveSeverity, laneOf, reaches } from '@inventarch/graph';
import type { ClaimMatch, DirectedEdgeRow, DirectedRow } from '@inventarch/graph';
import type { ReadHandle } from '@inventarch/db';
import { RuntimeError } from './errors.js';
import { SCOPE_KEY_CAPS, normalizeScopeKey, resolveScopeKey } from './scope-key.js';
import type { ResolvedScopeKey, ResolvedSeat, ScopeKey } from './scope-key.js';
import { freeze } from './types.js';

/**
 * The position body: body(K), position-and-projection §1, §6 (bound, order keys, quantification) and §7 (traversal),
 * design item 10; decision scope-key-caps. `position` returns it with its digest and the host note (design §1 and item
 * 11, R16).
 *
 * One scope key, resolved through one scope token, gives one body: the seat, the composition one level from it at cost
 * 0, the seeds the shape's kind or lane focus picks from it, the records reached by hops along the shape's predicate
 * focus, the blocking governance reserved outside the budget, the loaded set cut at the budget, the pointers and their
 * tallies, the frontier one hop past the loaded set, the unknowns, the counts and the two widening keys. It is a pure
 * function of the key and the admitted records the token reads, and only a whole-workspace token (db PT5) also reads
 * the admission findings it alone may disclose: no root path, token, time, request text or capture state enters it,
 * and nothing is written. Record bodies are never in it; `ia read` fetches one on demand. A record at runtime placement
 * (band 0) is never entered, listed, tallied or reached through (design §4, excluded; decision evidence-placement:
 * runtime-band evidence is admitted below authored and must not move what agents are given). The revision, the
 * database's seat and root decisions and admission's findings still read every placement (R15, R16).
 */

/** One way an entry was first reached: a row, a field reference, or one of the composition classes of design §7. */
export type PositionVia =
  /** One directed-view edge row read from `from`'s side, as the record that states it spelled it (G06b). */
  | {
      readonly by: 'row';
      readonly from: string;
      readonly predicate: Predicate;
      readonly spelling: string;
      readonly declaredBy: 'source' | 'target';
    }
  /** A typed field reference read from `from`'s side: `out` when `from` holds `field`, `in` when the entry does. */
  | { readonly by: 'field'; readonly from: string; readonly field: string; readonly direction: 'out' | 'in' }
  /** Capture membership at a workspace seat: the entry was captured under `root`, which the workspace declares. */
  | { readonly by: 'membership'; readonly root: string }
  /** Word membership at a @system seat: `system` registers the entry's word. */
  | { readonly by: 'word'; readonly system: string }
  /** A claimant of a location seat, with each of its selections that selects the path (graph G06c). */
  | { readonly by: 'claim'; readonly matches: readonly ClaimMatch[] }
  /** The record a location seat is declared at, and the rule that declares it (db D02b). */
  | { readonly by: 'declared-at'; readonly rule: 'system' | 'root' | 'repository' };
/** The pointer 9-tuple of design §7: (id, word, kind, lane, owner system, steward, band, hop, reaching row/field). */
export interface PositionRecord {
  readonly identity: string;
  readonly word: string;
  readonly kind: Kind;
  readonly lane: Lane;
  /** The owner system, the system that registers the record's word. */
  readonly system: string;
  /** The `head.steward` of the owner system's @system record, when the scope admits that record and it names one. */
  readonly steward?: string;
  readonly band: Band;
  /**
   * 0 for the seat, the seeds and a composition record no hop reaches; else the hop that first reached it (a
   * composition record a hop reaches included), or for a pointer read from a loaded record, that record's hop.
   */
  readonly hop: number;
  /** Absent for the seat; the first row that reached a hop-reached record, else its composition class. */
  readonly via?: PositionVia;
}
/** A loaded or reserved record: the tuple and the per-record digest (graph G13) of the occurrence the scope admits. */
export interface LoadedRecord extends PositionRecord {
  readonly digest: string;
}
/** The loaded entry of a seat that is no record: a location, or a workspace seat no record declares (`''`). */
export interface LoadedPlace {
  readonly path: string;
}
export type LoadedEntry = LoadedRecord | LoadedPlace;
export interface PositionPointer extends PositionRecord {
  readonly via: PositionVia;
  /** For a record outside the seat's closure, never entered: the @workspace whose declared root holds it, if any. */
  readonly workspace?: string;
}
/** The pointers past the listed ones, per (word, owner system). */
export interface PointerTally {
  readonly system: string;
  readonly word: string;
  readonly steward?: string;
  readonly count: number;
}
/** The frontier, per (owner system, kind): records one hop past the loaded set, never entered. */
export interface FrontierTally {
  readonly system: string;
  readonly kind: Kind;
  readonly steward?: string;
  readonly count: number;
}
export interface PositionUnknown {
  /**
   * `seat`: the seat's own unknown, or a location no record claims; `sources`: the seat's workspace declares no root,
   * or no workspace holds the seat; `finding`: an admission finding on a loaded record; `unread`: a narrowed scope,
   * which reads no admission finding.
   */
  readonly kind: 'seat' | 'sources' | 'finding' | 'unread';
  /** The record, workspace or path it is about. */
  readonly subject?: string;
  readonly code?: string;
  readonly path?: string;
  readonly line?: number;
  readonly message: string;
}
export interface PositionCounts {
  /** |C0|: the composition inside the seat's closure, after the word filter. */
  readonly composition: number;
  /** |Σ|, the seat included. */
  readonly seeds: number;
  /** |L|, the seat included. */
  readonly loaded: number;
  readonly rules: number;
  /** Every pointer, listed or tallied. */
  readonly pointers: number;
  readonly frontier: number;
  /** Seeds and reached records the budget left out of `loaded`; each is a pointer. */
  readonly truncatedLoaded: number;
  /** Pointers past the first 48, counted in the tallies. */
  readonly truncatedPointers: number;
}
export interface PositionWidening {
  /** (S, H, P, d + 1, n, w); absent at the depth cap. */
  readonly deeper?: ScopeKey;
  /** (x, H, P, 1, 16, no word): seat it at any pointer x; with no seat it is the repository's workspace. */
  readonly reseat: Pick<ScopeKey, 'shape' | 'phase' | 'depth' | 'budget'>;
}
export interface PositionBody {
  readonly format: 'ia.position-body.v1';
  /** The revision of the view the scope reads. */
  readonly revision: string;
  readonly key: ScopeKey;
  readonly seat: ResolvedSeat;
  /** The seat first, then the first n of the other seeds and the reached records, in the shape's order. */
  readonly loaded: readonly LoadedEntry[];
  /** The blocking governance candidates, reserved outside the budget, in the governance order. */
  readonly rules: readonly LoadedRecord[];
  /** The first 48 pointers in the shape's order. */
  readonly pointers: readonly PositionPointer[];
  readonly pointerTallies: readonly PointerTally[];
  readonly frontier: readonly FrontierTally[];
  readonly unknowns: readonly PositionUnknown[];
  readonly counts: PositionCounts;
  readonly widening: PositionWidening;
}
/** The host note's freshness: the capture `ia capture` last wrote against the revision the handle reads. */
export type Freshness = 'current' | 'stale' | 'no-capture';
/**
 * The host note (design §1): host state printed beside the body, never digested and never claimed identical across
 * hosts or working trees. Installed state is not reported before receipts exist (milestone position-packet).
 */
export interface HostNote {
  /** The revision of the handle's root view, which a capture is compared with. */
  readonly revision: string;
  /** The revision of the capture at `.ia/work/snapshot/current.json` (db D08a), when there is one. */
  readonly capturedRevision?: string;
  /** The revision of the previous root snapshot the handle retains (db D08), when it retains one. */
  readonly previousRevision?: string;
  /** `current` when the capture is at `revision`, `stale` when it is at another, `no-capture` when there is none. */
  readonly freshness: Freshness;
  /** The key used: the partial key completed by normalizeScopeKey, a location as the caller spelled it. */
  readonly key: ScopeKey;
}
/** The two outputs of a position (design §1), always printed together and never merged. */
export interface PositionOutput {
  readonly body: PositionBody;
  /** Graph's codec digest of `body`, its canonical JSON text's SHA-256. */
  readonly digest: string;
  readonly hostNote: HostNote;
}

/** p, the listed pointer lines before the tallies (design §1: a rendering constant, not a key part). */
const LISTED = 48;
/** The depth and budget of a re-seat key (design §7). */
const RESEAT = { depth: 1, budget: 16 } as const;
const PRIMING: readonly string[] = SHAPE_ROWS.governance.priming;
/** The admission findings that make a loaded record's relations unknown: unresolved references and unconsented rows. */
const FINDINGS: ReadonlySet<string> = new Set([
  'IA-GRAPH-TARGET-MISSING',
  'IA-GRAPH-TARGET-AMBIGUOUS',
  'IA-GRAPH-EDGE-UNCONSENTED',
  'IA-COMP-FIELD-REF-MISSING',
]);
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The index of `value` in `list`, or the list's length for a value it does not hold: after every listed one. */
const rank = (list: readonly string[], value: string | undefined): number => {
  const at = value === undefined ? -1 : list.indexOf(value);
  return at < 0 ? list.length : at;
};

/** How far from the seat a record was first reached, and by what. */
interface Reach {
  readonly hop: number;
  readonly via?: PositionVia;
}
/**
 * The body, and K, the candidates before any truncation ({S} ∪ C0 ∪ Σ ∪ C, identity order): the applies-by-word
 * section, a later task, reserves its blocking matches over them as `rules` reserves R.
 */
interface Seated {
  readonly body: PositionBody;
  readonly candidates: readonly string[];
}

/**
 * R15: body(K) for the key `resolved` that resolveScopeKey returned for the same scope token `within`. Every read goes
 * through `within`, and admission findings are read only on a whole-workspace one (db PT5). A missing token, or a seat
 * at runtime placement, is IA-RUNTIME-REQUEST-INVALID, and an unknown, stale or closed token keeps its database code.
 */
export function positionBody(handle: ReadHandle, within: string, resolved: ResolvedScopeKey): PositionBody {
  return seated(handle, within, resolved).body;
}

/**
 * R16: the position of the partial key `partial` through the scope token `within`: body(K) for the key normalizeScopeKey
 * completes and resolveScopeKey resolves, its digest, and the host note. The key's parts are closed, so request text or
 * a token in it is refused as an unknown part, and nothing text-driven runs; the body reads no capture, and the note
 * reads the handle's capture pair, so writing a capture moves only the note. Refusals are those of the three steps.
 */
export function position(handle: ReadHandle, within: string, partial: Partial<ScopeKey> = {}): PositionOutput {
  const key = normalizeScopeKey(partial),
    body = positionBody(handle, within, resolveScopeKey(handle, within, key));
  const revision = handle.revision,
    captured = handle.capturedRevision,
    previous = handle.previousRevision;
  return freeze({
    body,
    digest: digest(body),
    hostNote: {
      revision,
      ...(captured === undefined ? {} : { capturedRevision: captured }),
      ...(previous === undefined ? {} : { previousRevision: previous }),
      freshness: captured === undefined ? 'no-capture' : captured === revision ? 'current' : 'stale',
      key,
    },
  });
}

function seated(handle: ReadHandle, within: string, resolved: ResolvedScopeKey): Seated {
  if (typeof within !== 'string' || within.length === 0)
    throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', 'Runtime reads require an explicit scope token');
  // A record at runtime placement (band 0) is no part of a body: neither the seat's composition, a seed, a hop or
  // waypoint, loaded, reserved, a pointer, tallied nor frontier, and no row or claim of one ranks or reaches another,
  // nor is one the record a location is declared at.
  const read = { within },
    snapshot = handle.snapshot(read),
    records = snapshot.records.filter((node) => node.placement.kind !== 'runtime'),
    nodes = new Map(records.map((node) => [node.identity, node])),
    rootOf = new Map(snapshot.membership.map((row) => [row.identity, row.root])),
    roots = handle.roots(read);
  const { key, seat, resolution, coordinate } = resolved,
    { kinds, lanes, predicates } = coordinate.focus,
    values = coordinate.values,
    seatId = seat.identity,
    word = key.word;
  if (seatId !== undefined && !nodes.has(seatId))
    throw new RuntimeError(
      'IA-RUNTIME-REQUEST-INVALID',
      snapshot.records.some((node) => node.identity === seatId)
        ? `The seat '${seatId}' is at runtime placement (band 0), which no position body enters`
        : `The seat '${seatId}' is not an admitted record in this scope`,
    );
  const viewed = new Map<string, readonly DirectedRow[]>();
  const rowsOf = (identity: string): readonly DirectedRow[] => {
    let rows = viewed.get(identity);
    if (rows === undefined)
      viewed.set(identity, (rows = handle.directedView(identity, read).filter((row) => nodes.has(row.counterpart))));
    return rows;
  };
  /** The word filter: with w set, only records of w are composition, seeds, loaded, pointers or tallied. */
  const wanted = (identity: string): boolean => word === undefined || nodes.get(identity)!.discriminator === word;
  /** The rows a hop may follow: edge rows, either direction, whose predicate is in the shape's focus. */
  const inFocus = (row: DirectedRow): row is DirectedEdgeRow =>
    row.kind !== 'field-ref' && predicates.includes(row.predicate);
  const viaRow = (from: string, row: DirectedRow): PositionVia =>
    row.kind === 'field-ref'
      ? { by: 'field', from, field: row.field, direction: row.direction }
      : { by: 'row', from, predicate: row.predicate, spelling: row.spelling, declaredBy: row.declaredBy };

  // A workspace's closure: the floor and adopted bands, and the members of its own declared roots, or, while it
  // declares none (or no workspace holds the seat), every record no workspace declares a root for. A record of another
  // workspace's root is never entered.
  const declared = new Set(roots.map((r) => r.root));
  const ownOf = (workspace: string | undefined): ReadonlySet<string> =>
    new Set(roots.filter((r) => r.workspace === workspace).map((r) => r.root));
  const holds = (own: ReadonlySet<string>, identity: string): boolean => {
    const band = nodes.get(identity)!.band,
      root = rootOf.get(identity)!;
    return band === 10 || band === 90 || (own.size > 0 ? own.has(root) : !declared.has(root));
  };
  // The seat's workspace: the seat itself when it is a @workspace; else, of the workspace whose declared root holds the
  // seat record's membership root (a location's: the record it is declared at) and the repository's own @workspace,
  // the first whose closure holds that record. When neither does, no workspace holds the seat: the seat is never
  // outside its own closure (design §1).
  const repository = (): string | undefined => {
    const at = handle.resolveSeat('', read).seat;
    return at !== undefined && nodes.get(at)?.discriminator === 'workspace' ? at : undefined;
  };
  const workspaceOf = (identity: string | undefined): string | undefined => {
    if (identity === undefined || !nodes.has(identity)) return repository();
    if (nodes.get(identity)!.discriminator === 'workspace') return identity;
    const root = rootOf.get(identity);
    if (root === undefined) return repository();
    const holder = roots.find((r) => reaches(r.root, root))?.workspace;
    return [holder, repository()].find((at) => at !== undefined && holds(ownOf(at), identity));
  };
  const home = workspaceOf(seat.kind === 'location' ? resolution?.seat : seatId),
    own = ownOf(home);
  const inside = (identity: string): boolean => holds(own, identity);

  // C0, at cost 0 and one level from the seat: its field references both ways; a workspace seat's capture members; a
  // @system seat's word members; a location's declared-at record and claimants. The first class to reach one names it.
  const composition = new Map<string, PositionVia>();
  const compose = (identity: string | undefined, via: PositionVia): void => {
    if (identity !== undefined && identity !== seatId && nodes.has(identity) && !composition.has(identity))
      composition.set(identity, via);
  };
  if (seatId !== undefined) {
    const node = nodes.get(seatId)!;
    for (const row of rowsOf(seatId)) if (row.kind === 'field-ref') compose(row.counterpart, viaRow(seatId, row));
    if (node.discriminator === 'workspace')
      for (const row of snapshot.membership)
        if (own.has(row.root)) compose(row.identity, { by: 'membership', root: row.root });
    if (node.discriminator === 'system')
      for (const record of records)
        if (record.system === node.name) compose(record.identity, { by: 'word', system: node.name });
  }
  if (seat.kind === 'location' && resolution !== undefined) {
    if (resolution.seat !== undefined) compose(resolution.seat, { by: 'declared-at', rule: resolution.by! });
    for (const claimant of resolution.claimants) compose(claimant.identity, { by: 'claim', matches: claimant.matches });
  }
  const c0 = new Map<string, PositionVia>(),
    boundary = new Map<string, Reach>();
  for (const [identity, via] of composition)
    if (wanted(identity)) {
      if (inside(identity)) c0.set(identity, via);
      else boundary.set(identity, { hop: 0, via });
    }
  // Σ = {S} ∪ {r ∈ C0 : kind(r) ∈ kind focus ∨ lane(r) ∈ lane focus}.
  const seeds = [...c0.keys()]
    .filter((identity) => {
      const node = nodes.get(identity)!;
      return kinds.includes(node.kind) || lanes.includes(laneOf(node));
    })
    .sort(order);

  // Hops 1..d from Σ over edge rows in predicate focus, either direction, never leaving the closure: a record outside
  // it is a pointer, not entered; with w set, a record of another word is a waypoint, followed, never loaded or listed.
  const reached = new Map<string, Reach>(seeds.map((identity) => [identity, { hop: 0, via: c0.get(identity)! }])),
    waypoints = new Set<string>();
  let level = [...(seatId === undefined ? [] : [seatId]), ...seeds];
  for (let hop = 1; hop <= key.depth; hop++) {
    const next: string[] = [];
    for (const from of level)
      for (const row of rowsOf(from)) {
        const to = row.counterpart;
        if (!inFocus(row) || to === seatId || reached.has(to) || boundary.has(to)) continue;
        if (!inside(to)) {
          if (wanted(to)) boundary.set(to, { hop, via: viaRow(from, row) });
          continue;
        }
        reached.set(to, { hop, via: viaRow(from, row) });
        if (!wanted(to)) waypoints.add(to);
        next.push(to);
      }
    level = next.sort(order);
  }
  const hopReached = [...reached.keys()].filter(
    (identity) => reached.get(identity)!.hop > 0 && !waypoints.has(identity),
  );
  const reachOf = (identity: string): Reach =>
    identity === seatId ? { hop: 0 } : (reached.get(identity) ?? { hop: 0, via: c0.get(identity)! });

  // The order keys of design §6, total: governance (prime, band ↓, hop, sev, id), every other shape (band ↓, hop,
  // lane, id). prime is the least priming index of a row incident to the record, sev its severity's rank.
  const sorted = (identities: Iterable<string>, hopOf: (identity: string) => number, governance: boolean) =>
    [...identities]
      .map((identity) => {
        const node = nodes.get(identity)!;
        return {
          identity,
          band: node.band,
          hop: hopOf(identity),
          prime: governance
            ? Math.min(
                PRIMING.length,
                ...rowsOf(identity).flatMap((row) => (row.kind === 'field-ref' ? [] : [rank(PRIMING, row.predicate)])),
              )
            : 0,
          sev: governance ? rank(SEVERITIES, effectiveSeverity(node.dimensions, values)) : 0,
          lane: governance ? 0 : rank(lanes, laneOf(node)),
        };
      })
      .sort(
        (a, b) =>
          a.prime - b.prime ||
          b.band - a.band ||
          a.hop - b.hop ||
          a.sev - b.sev ||
          a.lane - b.lane ||
          order(a.identity, b.identity),
      )
      .map((entry) => entry.identity);
  const governance = key.shape === 'governance',
    hopOfReach = (identity: string): number => reachOf(identity).hop;

  // K = {S} ∪ C0 ∪ Σ ∪ C before truncation. R, its blocking governance, is reserved outside n, then
  // L = {S} ∪ first n of sort(((Σ \ {S}) ∪ C) \ R).
  const candidates = new Set([...c0.keys(), ...hopReached]);
  const rules = sorted(
    [...candidates].filter((identity) => {
      const node = nodes.get(identity)!;
      return node.kind === 'governance' && effectiveSeverity(node.dimensions, values) === 'blocking';
    }),
    hopOfReach,
    true,
  );
  const reserved = new Set(rules);
  const pool = sorted(
    new Set([...seeds, ...hopReached].filter((identity) => !reserved.has(identity))),
    hopOfReach,
    governance,
  );
  const chosen = pool.slice(0, key.budget),
    entered = [...(seatId === undefined ? [] : [seatId]), ...chosen],
    inLoaded = new Set(entered);

  // Pointers: (C0 ∪ C ∪ the out-of-focus rows and field references of L) \ (L ∪ R), and the records outside the
  // closure that composition or a hop reached; each once, by the first that reaches it.
  const pointed = new Map<string, Reach>();
  const point = (identity: string, reach: Reach): void => {
    if (identity === seatId || inLoaded.has(identity) || reserved.has(identity) || pointed.has(identity)) return;
    if (wanted(identity)) pointed.set(identity, reach);
  };
  for (const identity of [...c0.keys(), ...hopReached]) point(identity, reachOf(identity));
  for (const [identity, reach] of boundary) point(identity, reach);
  for (const from of entered)
    for (const row of rowsOf(from))
      if (!inFocus(row)) point(row.counterpart, { hop: reachOf(from).hop, via: viaRow(from, row) });
  const pointers = sorted(pointed.keys(), (identity) => pointed.get(identity)!.hop, governance);

  // The frontier: hop d + 1 from L, records nothing above lists or reached, never entered.
  const frontier = new Set<string>();
  for (const from of entered)
    if (reachOf(from).hop === key.depth)
      for (const row of rowsOf(from)) {
        const to = row.counterpart;
        if (
          inFocus(row) &&
          wanted(to) &&
          to !== seatId &&
          !inLoaded.has(to) &&
          !reserved.has(to) &&
          !pointed.has(to) &&
          !reached.has(to) &&
          !boundary.has(to)
        )
          frontier.add(to);
      }

  /** The steward the @system `system` names in `head.steward`, when the scope admits that @system. */
  const stewardOf = (system: string): string | undefined => {
    const identity = `floor/definition/system/${system}`;
    return nodes.has(identity)
      ? rowsOf(identity).find(
          (row) => row.kind === 'field-ref' && row.field === 'head.steward' && row.direction === 'out',
        )?.counterpart
      : undefined;
  };
  const record = (identity: string, reach: Reach): PositionRecord => {
    const node = nodes.get(identity)!,
      steward = stewardOf(node.system);
    return {
      identity,
      word: node.discriminator,
      kind: node.kind,
      lane: laneOf(node),
      system: node.system,
      ...(steward === undefined ? {} : { steward }),
      band: node.band,
      hop: reach.hop,
      ...(reach.via === undefined ? {} : { via: reach.via }),
    };
  };
  const loadedRecord = (identity: string): LoadedRecord => ({
    ...record(identity, reachOf(identity)),
    digest: nodes.get(identity)!.digest,
  });
  const pointer = (identity: string): PositionPointer => {
    const reach = pointed.get(identity)!,
      holder = inside(identity) ? undefined : roots.find((r) => r.root === rootOf.get(identity))?.workspace;
    return { ...record(identity, reach), via: reach.via!, ...(holder === undefined ? {} : { workspace: holder }) };
  };
  /** Per-group counts, the groups in key order. */
  const tally = <T extends string>(
    identities: readonly string[],
    group: (identity: string) => readonly [string, T],
  ) => {
    const counts = new Map<string, { readonly system: string; readonly value: T; count: number }>();
    for (const identity of identities) {
      const [system, value] = group(identity),
        at = JSON.stringify([system, value]);
      const entry = counts.get(at) ?? { system, value, count: 0 };
      entry.count++;
      counts.set(at, entry);
    }
    return [...counts.values()].sort((a, b) => order(a.system, b.system) || order(a.value, b.value));
  };
  const withSteward = (system: string) => {
    const steward = stewardOf(system);
    return steward === undefined ? {} : { steward };
  };

  // Unknowns: the seat's, its workspace's sources, and on a whole-workspace scope the unresolved references and
  // unconsented rows admission found on a loaded record.
  const unknowns: PositionUnknown[] = [];
  if (seat.kind === 'location') {
    const path = seat.path!,
      declaredAt = resolution?.seat !== undefined && nodes.has(resolution.seat);
    if (!declaredAt && !resolution?.claimants.some((claimant) => nodes.has(claimant.identity)))
      unknowns.push({
        kind: 'seat',
        subject: path,
        message: `no record claims '${path}' and none is declared at it; widening key: the workspace`,
      });
    else if (!declaredAt)
      unknowns.push({
        kind: 'seat',
        subject: path,
        message: `no admitted record in this scope is declared at '${path}'`,
      });
  } else if (seat.unknown !== undefined)
    unknowns.push({ kind: 'seat', message: 'no admitted @workspace in this scope is declared at the repository root' });
  const fallback = 'its closure is the floor, the adopted records and every record no workspace declares a root for';
  if (home !== undefined && own.size === 0)
    unknowns.push({
      kind: 'sources',
      subject: home,
      message: `workspace declares no sources: ${home} has no capture members, and ${fallback}`,
    });
  else if (home === undefined && seat.kind !== 'workspace')
    unknowns.push({ kind: 'sources', message: `no @workspace holds the seat, and ${fallback}` });
  if (handle.isCompleteScope(within)) {
    const spans = entered.map((identity) => nodes.get(identity)!);
    for (const finding of handle.report.findings) {
      if (!FINDINGS.has(finding.code)) continue;
      // The innermost loaded record whose source span holds the finding's line.
      const subject = spans
        .filter((node) => node.source.path === finding.path && node.source.line <= finding.line)
        .filter((node) => finding.line <= node.source.endLine)
        .sort((a, b) => b.source.line - a.source.line)[0];
      if (subject !== undefined)
        unknowns.push({
          kind: 'finding',
          subject: subject.identity,
          code: finding.code,
          path: finding.path,
          line: finding.line,
          message: finding.message,
        });
    }
  } else
    unknowns.push({
      kind: 'unread',
      message: 'a narrowed scope reads no admission finding, so unresolved and unconsented rows are not named',
    });

  const listed = pointers.slice(0, LISTED),
    tallied = pointers.slice(LISTED),
    frontierIds = [...frontier];
  const body: PositionBody = {
    format: 'ia.position-body.v1',
    revision: snapshot.revision,
    key,
    seat,
    loaded: [
      seatId === undefined ? { path: seat.path ?? '' } : loadedRecord(seatId),
      ...chosen.map((identity) => loadedRecord(identity)),
    ],
    rules: rules.map((identity) => loadedRecord(identity)),
    pointers: listed.map(pointer),
    pointerTallies: tally(tallied, (identity) => [nodes.get(identity)!.system, nodes.get(identity)!.discriminator]).map(
      ({ system, value, count }) => ({ system, word: value, ...withSteward(system), count }),
    ),
    frontier: tally(frontierIds, (identity) => [nodes.get(identity)!.system, nodes.get(identity)!.kind]).map(
      ({ system, value, count }) => ({ system, kind: value, ...withSteward(system), count }),
    ),
    unknowns,
    counts: {
      composition: c0.size,
      seeds: seeds.length + 1,
      loaded: 1 + chosen.length,
      rules: rules.length,
      pointers: pointers.length,
      frontier: frontier.size,
      truncatedLoaded: pool.length - chosen.length,
      truncatedPointers: tallied.length,
    },
    widening: {
      ...(key.depth < SCOPE_KEY_CAPS.depth ? { deeper: { ...key, depth: key.depth + 1 } } : {}),
      reseat: { shape: key.shape, phase: key.phase, ...RESEAT },
    },
  };
  return freeze({
    body,
    candidates: [...(seatId === undefined ? [] : [seatId]), ...candidates].sort(order),
  });
}
