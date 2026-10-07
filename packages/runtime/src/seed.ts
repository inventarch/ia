import { KIND_LANES, SEVERITIES, SHAPE_ROWS } from '@inventarch/language';
import type { Band, Predicate } from '@inventarch/language';
import { DbError } from '@inventarch/db';
import type { MembershipRow, ReadHandle, SeatResolution } from '@inventarch/db';
import { effectiveSeverity } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import type { Shape } from './classify.js';
import type { NormalizedScopeKey } from './scope-key.js';
import { freeze } from './types.js';

/**
 * Seeding: which records a scope key loads, before anything is rendered. `seatOf` places the key's seat; `seed`
 * composes C0 one level from it, seeds the records in the shape's focus, hops along the shape's predicates over the
 * derived directed view, orders by the shape's order keys and cuts at the budget. Both read only through the supplied
 * scope token, and the result is a pure function of the key's value and the admitted revision.
 */

/** Where a seat sits: a @workspace, a @system, any other record, or a path (a location seat, which is no record). */
export type SeatKind = 'workspace' | 'system' | 'record' | 'location';
export interface Seat {
  readonly kind: SeatKind;
  /** The seat record; null for a location seat, or for the synthetic closure when no workspace seat is admitted. */
  readonly identity: string | null;
  /** The workspace-relative path of a location seat; null otherwise. */
  readonly path: string | null;
  /** The @workspace whose closure the seeding stays inside; null for the synthetic workspace closure. */
  readonly home: string | null;
  /** Names a location seat that nothing is declared at and nothing claims. */
  readonly unknown?: string;
}
/** The composition classes of C0, in the order a record that falls in several is classed. */
export const SEED_CLASSES = Object.freeze(['field', 'capture', 'word', 'declared', 'claimant'] as const);
export type SeedClass = (typeof SEED_CLASSES)[number];
/** One C0 record: how it composes with the seat (a field, a capture root, a word, a path or a claiming selection). */
export interface Composed {
  readonly identity: string;
  readonly class: SeedClass;
  readonly via: string;
  /** For a field reference: `out` when the seat holds it, `in` when it names the seat. */
  readonly direction: 'out' | 'in' | null;
}
/** The directed-view row a hop first reached a record by, read from the end it was reached from. */
export interface Hop {
  readonly from: string;
  readonly predicate: Predicate;
  readonly spelling: string;
  readonly direction: 'out' | 'in';
  readonly declaredOn: string;
}
/** A seed beyond the seat or a record a hop reached, in order; `blocking` ones are loaded outside the budget. */
export interface Ranked {
  readonly identity: string;
  readonly hop: number;
  readonly band: Band;
  readonly via: Hop | null;
  readonly blocking: boolean;
  readonly loaded: boolean;
}
/** A record met but never entered: open-band material, or another workspace's closure. `via` is a C0 via or a hop. */
export interface Held {
  readonly identity: string;
  readonly reason: 'open' | 'workspace';
  readonly hop: number;
  readonly via: string | Hop;
}
/** A row a loaded record declares that cannot be followed: a dangling target, or an edge refused for consent. */
export interface Unknown {
  readonly identity: string;
  readonly reason: 'dangling' | 'unconsented';
  readonly path: string;
  readonly line: number;
  readonly text: string;
}
/** The value of a scope key: what a seeding is a function of, without how each part was supplied. */
export interface SeedKey {
  readonly seat: string | null;
  readonly shape: Shape;
  readonly phase: string;
  readonly primitive: string;
  readonly depth: number;
  readonly budget: number;
  readonly word: string | null;
}
export interface Seeding {
  readonly revision: string;
  readonly key: SeedKey;
  readonly seat: Seat;
  /** C0 without the seat, held records and records of other words, by identity. */
  readonly composition: readonly Composed[];
  /** The C0 records in the shape's kind or lane focus, by identity. */
  readonly seeds: readonly string[];
  /** The seeds and every record the hops reached, under the shape's order. */
  readonly ranked: readonly Ranked[];
  /** The seat record, then the loaded ranked records in order. */
  readonly loaded: readonly string[];
  /** Ranked records cut by the budget; blocking rules are never cut. */
  readonly truncated: number;
  readonly held: readonly Held[];
  readonly unknowns: readonly Unknown[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The ends of a consent refusal's message: `<end> system refuses <predicate> from <from> to <to>`. */
const REFUSED = /^\S+ system refuses \S+ from (\S+) to (\S+)$/;
/** Runtime-band records are never read; open-band records are met but never composed, seeded or entered. */
const unread = (node: Node): boolean => node.placement.kind === 'runtime';
const open = (node: Node): boolean => node.placement.kind === 'open';
/** Rules whose effective severity is blocking are loaded outside the budget and never refused for it. */
const outsideBudget = (node: Node, key: NormalizedScopeKey): boolean =>
  node.kind === 'governance' && effectiveSeverity(node.dimensions, key.coordinate) === 'blocking';

interface Reading {
  readonly handle: ReadHandle;
  readonly within: string;
  readonly revision: string;
  readonly nodes: ReadonlyMap<string, Node>;
  readonly membership: ReadonlyMap<string, MembershipRow>;
  /** The workspace seat: the seat the empty path resolves to; null for the synthetic workspace closure. */
  readonly workspace: string | null;
}
function reading(handle: ReadHandle, within: string): Reading {
  const snapshot = handle.snapshot({ within }),
    // '' never lies in a system folder, so its seat is a workspace seat.
    workspace = handle.resolveSeat('', { within }).seat;
  return {
    handle,
    within,
    revision: snapshot.revision,
    nodes: new Map(snapshot.records.filter((node) => !unread(node)).map((node) => [node.identity, node])),
    membership: new Map(handle.membership({ within }).map((row) => [row.identity, row])),
    workspace: workspace.kind === 'workspace' ? workspace.identity : null,
  };
}
/**
 * Whether `seat`, the membership seat of the in-scope record `identity`, is a @system: read from the seat record when
 * it is in the scope, else from the seat rule at the record's path (a system folder seats its @system). Seats are
 * view-wide, so a scoped read can name a seat record it cannot read.
 */
function systemSeat(read: Reading, identity: string, seat: string): boolean {
  const node = read.nodes.get(seat);
  if (node !== undefined) return node.discriminator === 'system';
  const path = read.nodes.get(identity)?.source.path;
  if (path === undefined) return false;
  const at = read.handle.resolveSeat(path, { within: read.within }).seat;
  return at.kind === 'system' && at.identity === seat;
}
/**
 * The workspace closure a @system belongs to: its own membership seat when that is a workspace, else (an adopted
 * @system is its own seat, and one outside the scope has no row) the workspace seat.
 */
function systemClosure(read: Reading, system: string): string | null {
  const own = read.membership.get(system)?.seat ?? null;
  return own !== null && own !== system && !systemSeat(read, system, own) ? own : read.workspace;
}
/** The workspace closure a record is captured in: its membership seat, or the closure of the @system seating it. */
function closureOf(read: Reading, identity: string): string | null {
  const seat = read.membership.get(identity)?.seat ?? null;
  return seat !== null && systemSeat(read, identity, seat) ? systemClosure(read, seat) : seat;
}
interface Located {
  readonly seat: Seat;
  readonly node: Node | undefined;
  readonly location: SeatResolution | undefined;
}
function located(read: Reading, key: NormalizedScopeKey): Located {
  const { handle, within, nodes } = read;
  if (key.seat === null) {
    const identity = read.workspace;
    return {
      seat: { kind: 'workspace', identity, path: null, home: identity },
      node: identity === null ? undefined : nodes.get(identity),
      location: undefined,
    };
  }
  const node = nodes.get(key.seat);
  if (node !== undefined) {
    const kind =
      node.discriminator === 'workspace' ? 'workspace' : node.discriminator === 'system' ? 'system' : 'record';
    return {
      seat: {
        kind,
        identity: node.identity,
        path: null,
        home: kind === 'workspace' ? node.identity : closureOf(read, node.identity),
      },
      node,
      location: undefined,
    };
  }
  const outside = handle.get(key.seat);
  if (outside !== undefined && !unread(outside))
    throw new DbError('IA-DB-OUT-OF-SCOPE', `Seat ${key.seat} is outside the supplied scope`);
  const location = handle.resolveSeat(key.seat, { within }),
    claimed = [...location.declared, ...location.claimants.map((claim) => claim.identity)].some((identity) =>
      nodes.has(identity),
    ),
    at = location.seat;
  return {
    seat: {
      kind: 'location',
      identity: null,
      path: location.path,
      home: at.kind === 'workspace' || at.identity === null ? at.identity : systemClosure(read, at.identity),
      ...(claimed ? {} : { unknown: `no record claims ${location.path}` }),
    },
    node: undefined,
    location,
  };
}

/** Place the key's seat, read through `within`: the workspace when omitted, an admitted record, or else a path. */
export function seatOf(handle: ReadHandle, within: string, key: NormalizedScopeKey): Seat {
  return freeze({ ...located(reading(handle, within), key).seat });
}

/** A record outside the seat's workspace closure: another @workspace, or a record captured in one. */
function outsideHome(read: Reading, node: Node, home: string | null): boolean {
  if (node.discriminator === 'workspace') return node.identity !== home;
  const closure = closureOf(read, node.identity);
  return closure !== null && closure !== home;
}

/**
 * Seed the key's body: C0 (field references both ways, capture membership at a workspace seat, word membership at a
 * system seat, the declared records and claimants of a location seat), restricted to the key's word; seeds = C0 in the
 * shape's kind or lane focus; hops along the shape's predicates in either direction over the derived directed view up
 * to the depth; the shape's order keys; the budget counts records beyond the seat, blocking rules outside it.
 */
export function seed(handle: ReadHandle, within: string, key: NormalizedScopeKey): Seeding {
  const read = reading(handle, within),
    { nodes } = read,
    { seat, node: seatNode, location } = located(read, key),
    row = SHAPE_ROWS[key.shape];
  const met = new Map<string, Composed>();
  const compose = (identity: string, kind: SeedClass, via: string, direction: 'out' | 'in' | null = null) => {
    if (identity !== seat.identity && !met.has(identity)) met.set(identity, { identity, class: kind, via, direction });
  };
  if (seatNode !== undefined)
    for (const view of handle.directedView(seatNode.identity, { within }))
      if (view.kind === 'field-ref' && view.other !== null) compose(view.other, 'field', view.spelling, view.direction);
  if (seat.kind === 'workspace')
    for (const member of read.membership.values())
      if (member.seat === seat.identity) compose(member.identity, 'capture', member.root);
  if (seat.kind === 'system' && seatNode !== undefined)
    for (const member of nodes.values())
      if (member.system === seatNode.name) compose(member.identity, 'word', member.discriminator);
  if (location !== undefined) {
    for (const identity of location.declared) compose(identity, 'declared', location.path);
    for (const claim of location.claimants) compose(claim.identity, 'claimant', `${claim.field} ${claim.selection}`);
  }
  const held: Held[] = [],
    composition: Composed[] = [];
  for (const entry of [...met.values()].sort((a, b) => compare(a.identity, b.identity))) {
    const member = nodes.get(entry.identity);
    if (member === undefined || (key.word !== null && member.discriminator !== key.word)) continue;
    if (open(member)) held.push({ identity: entry.identity, reason: 'open', hop: 0, via: entry.via });
    else if (outsideHome(read, member, seat.home))
      held.push({ identity: entry.identity, reason: 'workspace', hop: 0, via: entry.via });
    else composition.push(entry);
  }
  const kinds: readonly string[] = row.kinds,
    lanes: readonly string[] = row.lanes;
  const seeds = composition
    .filter(({ identity }) => {
      const kind = nodes.get(identity)!.kind;
      return kinds.includes(kind) || lanes.includes(KIND_LANES[kind]);
    })
    .map(({ identity }) => identity);

  const reached = new Map<string, { hop: number; via: Hop | null }>(seeds.map((id) => [id, { hop: 0, via: null }]));
  const seen = new Set<string>([...seeds, ...held.map((entry) => entry.identity)]);
  if (seatNode !== undefined) seen.add(seatNode.identity);
  const predicates: readonly string[] = row.predicates;
  let frontier = [...(seatNode === undefined ? [] : [seatNode.identity]), ...seeds];
  for (let hop = 1; hop <= key.depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const from of frontier)
      for (const view of handle.directedView(from, { within })) {
        if (view.predicate === null || !predicates.includes(view.predicate) || !view.consented || view.other === null)
          continue;
        const target = nodes.get(view.other);
        if (target === undefined || seen.has(target.identity)) continue;
        seen.add(target.identity);
        const via: Hop = {
          from,
          predicate: view.predicate,
          spelling: view.spelling,
          direction: view.direction,
          declaredOn: view.declaredOn,
        };
        if (open(target)) held.push({ identity: target.identity, reason: 'open', hop, via });
        else if (outsideHome(read, target, seat.home))
          held.push({ identity: target.identity, reason: 'workspace', hop, via });
        else {
          reached.set(target.identity, { hop, via });
          next.push(target.identity);
        }
      }
    frontier = next.sort(compare);
  }

  const priming: readonly string[] = row.priming,
    governance = key.shape === 'governance';
  const prime = (identity: string): number =>
    Math.min(
      priming.length,
      ...handle
        .directedView(identity, { within })
        .filter((view) => view.consented && view.other !== null && view.predicate !== null)
        .map((view) => priming.indexOf(view.predicate!))
        .filter((index) => index >= 0),
    );
  const severity = (node: Node): number => {
    const index = SEVERITIES.indexOf(node.dimensions.severity as (typeof SEVERITIES)[number]);
    return index < 0 ? SEVERITIES.length : index;
  };
  const lane = (node: Node): number => {
    const index = lanes.indexOf(KIND_LANES[node.kind]);
    return index < 0 ? lanes.length : index;
  };
  const candidates = [...reached].map(([identity, { hop, via }]) => {
    const node = nodes.get(identity)!;
    return { identity, hop, via, node, prime: governance ? prime(identity) : 0 };
  });
  candidates.sort((a, b) =>
    governance
      ? a.prime - b.prime ||
        b.node.band - a.node.band ||
        a.hop - b.hop ||
        severity(a.node) - severity(b.node) ||
        compare(a.identity, b.identity)
      : b.node.band - a.node.band || a.hop - b.hop || lane(a.node) - lane(b.node) || compare(a.identity, b.identity),
  );
  let room = key.budget,
    truncated = 0;
  const ranked: Ranked[] = candidates.map(({ identity, hop, via, node }) => {
    const blocking = outsideBudget(node, key),
      loaded = blocking || room > 0;
    if (!blocking) {
      if (room > 0) room--;
      else truncated++;
    }
    return { identity, hop, band: node.band, via, blocking, loaded };
  });
  const loaded = [
    ...(seatNode === undefined ? [] : [seatNode.identity]),
    ...ranked.filter((entry) => entry.loaded).map((entry) => entry.identity),
  ];

  const refusals = handle.report.findings.filter((finding) => finding.code === 'IA-GRAPH-EDGE-UNCONSENTED');
  const unknowns: Unknown[] = [];
  for (const identity of loaded) {
    const node = nodes.get(identity)!;
    for (const view of handle.directedView(identity, { within }))
      if (view.other === null)
        unknowns.push({
          identity,
          reason: 'dangling',
          path: view.source.path,
          line: view.source.line,
          text: view.spelling,
        });
    for (const finding of refusals)
      if (
        finding.path === node.source.path &&
        finding.line >= node.source.line &&
        finding.line <= node.source.endLine
      ) {
        const prefix = `${finding.path}:${finding.line}: `,
          text = finding.message.startsWith(prefix) ? finding.message.slice(prefix.length) : finding.message,
          ends = REFUSED.exec(text);
        // Like a directed-view row, a refusal whose other end is outside the scope (or never read) is pruned.
        if (ends === null) continue;
        const [, from, to] = ends,
          other = from === identity ? to! : to === identity ? from! : undefined;
        if (other === undefined || !nodes.has(other)) continue;
        unknowns.push({ identity, reason: 'unconsented', path: finding.path, line: finding.line, text });
      }
  }
  unknowns.sort(
    (a, b) =>
      compare(a.identity, b.identity) || compare(a.path, b.path) || a.line - b.line || compare(a.reason, b.reason),
  );
  held.sort((a, b) => a.hop - b.hop || compare(a.identity, b.identity));
  return freeze({
    revision: read.revision,
    key: {
      seat: key.seat,
      shape: key.shape,
      phase: key.phase,
      primitive: key.primitive,
      depth: key.depth,
      budget: key.budget,
      word: key.word,
    },
    seat: { ...seat },
    composition: composition.map((entry) => ({ ...entry })),
    seeds,
    ranked,
    loaded,
    truncated,
    held: held.map((entry) => ({ ...entry, via: typeof entry.via === 'string' ? entry.via : { ...entry.via } })),
    unknowns,
  });
}
