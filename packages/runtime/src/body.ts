import { KIND_LANES, SHAPE_ROWS } from '@inventarch/language';
import type { Band, Kind, Predicate } from '@inventarch/language';
import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { SCOPE_BODY_LIMITS, SCOPE_KEY_CAPS, SCOPE_KEY_DEFAULTS } from './scope-key.js';
import type { NormalizedScopeKey } from './scope-key.js';
import { seed } from './seed.js';
import type { Composed, Hop, Seat, SeedClass, SeedKey, Unknown } from './seed.js';
import { freeze } from './types.js';

/**
 * body(K): what a scope key hands over, apart from record text and the sections that later read cells and rules. It
 * is the seeding (`seed`) told as lines: the loaded records, pointers to the records met but not loaded, tallies for
 * what the pointer limit and the depth leave out, one pointer line per system of the home workspace, the records
 * captured with a workspace seat, counts and the two widening-key forms. It is a pure function of the key's value
 * and the admitted revision; how each key part was supplied is never part of it.
 */

/** How a line's record was reached: a C0 class from the seat, a directed-view row, or a loaded record's own field. */
export interface Reach {
  /** The record it was reached from: the seat for C0 (null at a location seat), else a loaded or reached record. */
  readonly from: string | null;
  readonly by: SeedClass | 'row';
  readonly predicate: Predicate | null;
  /** The row's spelling, the field path, the capture root, the word, the path or the claiming selection. */
  readonly spelling: string;
  readonly direction: 'out' | 'in' | null;
  /** The record whose source declares the row; null for composition. */
  readonly declaredOn: string | null;
}
/** One record as a line: identity, word, kind, lane, owner system, its steward, band, hop and how it was reached. */
export interface Line {
  readonly identity: string;
  readonly word: string;
  readonly kind: Kind;
  readonly lane: string;
  readonly system: string;
  readonly steward: string | null;
  readonly band: Band;
  readonly hop: number;
  readonly via: Reach | null;
}
export interface LoadedLine extends Line {
  /** Loaded outside the budget as a blocking rule. */
  readonly blocking: boolean;
}
/** Where a tally reaches out: the owner system's steward, the system record to re-seat at, and the read command. */
interface Owner {
  readonly steward: string | null;
  /** The owner system's @system record, the seat of a re-seating key; null when the system has none. */
  readonly seat: string | null;
  readonly read: string | null;
}
export interface PointerTally extends Owner {
  readonly word: string;
  readonly system: string;
  readonly count: number;
}
export interface FrontierTally extends Owner {
  readonly system: string;
  readonly kind: Kind;
  readonly count: number;
}
export interface CapturedTally {
  readonly word: string;
  readonly count: number;
}
export interface SystemLine {
  readonly system: string;
  readonly identity: string;
  /** The words the system registers, in the order it declares them. */
  readonly words: readonly string[];
  readonly band: Band;
  readonly steward: string | null;
  readonly read: string;
}
export interface BodyCounts {
  /** C0 without the seat and held records. */
  readonly composition: number;
  /** Seeds beyond the seat. */
  readonly seeds: number;
  /** Loaded records, the seat included. */
  readonly loaded: number;
  /** Ranked records the budget cut. */
  readonly truncated: number;
  /** Every pointer, listed or tallied. */
  readonly pointers: number;
  /** Pointers beyond the pointer limit. */
  readonly truncatedPointers: number;
  /** Records counted in the frontier tallies. */
  readonly frontier: number;
}
export interface Widening {
  /** The same key one hop deeper; null at the depth cap. */
  readonly deepen: SeedKey | null;
  /** The key a pointer, tally or system line re-seats with, its seat being that line's record. */
  readonly reseat: Omit<SeedKey, 'seat'>;
}
export interface PositionBody {
  readonly revision: string;
  readonly key: SeedKey;
  readonly seat: Seat;
  readonly loaded: readonly LoadedLine[];
  readonly pointers: readonly Line[];
  readonly tallies: readonly PointerTally[];
  readonly frontier: readonly FrontierTally[];
  readonly systems: readonly SystemLine[];
  readonly captured: readonly CapturedTally[];
  readonly counts: BodyCounts;
  readonly widening: Widening;
  readonly unknowns: readonly Unknown[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The command a line reaches out with; the body carries it so every renderer prints the same one. */
const readCommand = (identity: string): string => `ia read ${identity}`;
/**
 * The word filter's reach inside the body: a key's word keeps only its own word's records in every tally. It also
 * restricts C0, and so the seeds, in `seed`; loaded records and pointer lines keep every word, so a record a hop
 * loads stays whatever its word. To make the word restrict pointer lines too, apply this predicate to them here.
 */
const tallied = (key: SeedKey, node: Node): boolean => key.word === null || node.discriminator === key.word;

/** Tell the key's seeding as a body: loaded lines, pointers and their tallies, frontier, system lines and counts. */
export function positionBody(handle: ReadHandle, within: string, key: NormalizedScopeKey): PositionBody {
  const seeding = seed(handle, within, key),
    { seat } = seeding,
    row = SHAPE_ROWS[key.shape];
  // The runtime band is never read, as in seeding.
  const nodes = new Map(
    handle
      .snapshot({ within })
      .records.filter((node) => node.placement.kind !== 'runtime')
      .map((node) => [node.identity, node]),
  );
  const views = new Map<string, ReturnType<ReadHandle['directedView']>>();
  const view = (identity: string) => {
    let rows = views.get(identity);
    if (rows === undefined) views.set(identity, (rows = handle.directedView(identity, { within })));
    return rows;
  };

  const systems = new Map<string, Node>();
  for (const node of nodes.values()) if (node.discriminator === 'system') systems.set(node.name, node);
  const stewardOf = (system: Node): string | null =>
    view(system.identity).find(
      (entry) =>
        entry.kind === 'field-ref' && entry.direction === 'out' && entry.spelling === 'head.steward' && entry.other,
    )?.other ?? null;
  const owner = (name: string): Owner => {
    const system = systems.get(name);
    if (system === undefined) return { steward: null, seat: null, read: null };
    const steward = stewardOf(system);
    return { steward, seat: system.identity, read: readCommand(steward ?? system.identity) };
  };

  const lanes: readonly string[] = row.lanes,
    predicates: readonly string[] = row.predicates;
  const line = (node: Node, hop: number, via: Reach | null): Line => ({
    identity: node.identity,
    word: node.discriminator,
    kind: node.kind,
    lane: KIND_LANES[node.kind],
    system: node.system,
    steward: owner(node.system).steward,
    band: node.band,
    hop,
    via,
  });
  const composed = (entry: Composed): Reach => ({
    from: seat.identity,
    by: entry.class,
    predicate: null,
    spelling: entry.via,
    direction: entry.direction,
    declaredOn: null,
  });
  const rowReach = (hop: Hop): Reach => ({
    from: hop.from,
    by: 'row',
    predicate: hop.predicate,
    spelling: hop.spelling,
    direction: hop.direction,
    declaredOn: hop.declaredOn,
  });
  /** A held C0 record's class, by the same precedence C0 composes in: a seat field first, then the seat's kind. */
  const heldClass = (identity: string, via: string): Reach => {
    const field =
      seat.identity === null
        ? undefined
        : view(seat.identity).find((entry) => entry.kind === 'field-ref' && entry.other === identity);
    const by: SeedClass =
      field !== undefined
        ? 'field'
        : seat.kind === 'workspace'
          ? 'capture'
          : seat.kind === 'system'
            ? 'word'
            : via === seat.path
              ? 'declared'
              : 'claimant';
    return {
      from: seat.identity,
      by,
      predicate: null,
      spelling: via,
      direction: field?.direction ?? null,
      declaredOn: null,
    };
  };

  const composition = new Map(seeding.composition.map((entry) => [entry.identity, entry]));
  const reachOf = (identity: string, hop: number, via: Hop | null): Reach | null =>
    via !== null ? rowReach(via) : hop === 0 && composition.has(identity) ? composed(composition.get(identity)!) : null;
  const loadedSet = new Set(seeding.loaded);
  const ranked = new Map(seeding.ranked.map((entry) => [entry.identity, entry]));
  const loaded: LoadedLine[] = seeding.loaded.map((identity) => {
    const entry = ranked.get(identity);
    return {
      ...line(
        nodes.get(identity)!,
        entry?.hop ?? 0,
        entry === undefined ? null : reachOf(identity, entry.hop, entry.via),
      ),
      blocking: entry?.blocking ?? false,
    };
  });
  const hopOf = new Map(loaded.map((entry) => [entry.identity, entry.hop]));

  // Ptr = (C0 ∪ C ∪ outrows(L)) \ L, with the held records: one line per record, at the lowest hop it was met.
  const met = new Map<string, { hop: number; via: Reach }>();
  const meet = (identity: string, hop: number, via: Reach) => {
    if (loadedSet.has(identity) || !nodes.has(identity)) return;
    const known = met.get(identity);
    if (known === undefined || hop < known.hop) met.set(identity, { hop, via });
  };
  for (const entry of seeding.composition) meet(entry.identity, 0, composed(entry));
  for (const entry of seeding.ranked)
    if (!entry.loaded) meet(entry.identity, entry.hop, reachOf(entry.identity, entry.hop, entry.via)!);
  for (const entry of seeding.held)
    meet(
      entry.identity,
      entry.hop,
      typeof entry.via === 'string' ? heldClass(entry.identity, entry.via) : rowReach(entry.via),
    );
  const ahead: { identity: string; hop: number }[] = [];
  for (const from of seeding.loaded) {
    const hop = hopOf.get(from)!;
    for (const entry of view(from)) {
      if (!entry.consented || entry.other === null) continue;
      if (entry.kind === 'field-ref') {
        // The seat's field references in both directions are C0, already filtered by the word.
        if (from !== seat.identity && entry.direction === 'out')
          meet(entry.other, hop, {
            from,
            by: 'field',
            predicate: null,
            spelling: entry.spelling,
            direction: 'out',
            declaredOn: from,
          });
      } else if (!predicates.includes(entry.predicate!))
        meet(entry.other, hop + 1, {
          from,
          by: 'row',
          predicate: entry.predicate,
          spelling: entry.spelling,
          direction: entry.direction,
          declaredOn: entry.declaredOn,
        });
      else ahead.push({ identity: entry.other, hop: hop + 1 });
    }
  }
  const lane = (node: Node): number => {
    const index = lanes.indexOf(KIND_LANES[node.kind]);
    return index < 0 ? lanes.length : index;
  };
  const pointed = [...met].map(([identity, { hop, via }]) => line(nodes.get(identity)!, hop, via));
  pointed.sort(
    (a, b) =>
      b.band - a.band ||
      a.hop - b.hop ||
      lane(nodes.get(a.identity)!) - lane(nodes.get(b.identity)!) ||
      compare(a.identity, b.identity),
  );
  const limit = SCOPE_BODY_LIMITS.pointers,
    pointers = pointed.slice(0, limit);

  const tallies = new Map<string, PointerTally>();
  for (const entry of pointed.slice(limit)) {
    if (!tallied(seeding.key, nodes.get(entry.identity)!)) continue;
    const at = `${entry.word}\u0000${entry.system}`,
      known = tallies.get(at);
    tallies.set(
      at,
      known === undefined
        ? { word: entry.word, system: entry.system, count: 1, ...owner(entry.system) }
        : { ...known, count: known.count + 1 },
    );
  }

  // F: records one in-focus row beyond the loaded records that are neither loaded nor pointers, never entered.
  const beyond = new Set<string>();
  for (const { identity } of ahead)
    if (nodes.has(identity) && !loadedSet.has(identity) && !met.has(identity)) beyond.add(identity);
  const frontier = new Map<string, FrontierTally>();
  for (const identity of beyond) {
    const node = nodes.get(identity)!;
    if (!tallied(seeding.key, node)) continue;
    const at = `${node.system}\u0000${node.kind}`,
      known = frontier.get(at);
    frontier.set(
      at,
      known === undefined
        ? { system: node.system, kind: node.kind, count: 1, ...owner(node.system) }
        : { ...known, count: known.count + 1 },
    );
  }

  // Records captured under the workspace seat's authored roots, per word.
  const captured = new Map<string, number>();
  if (seat.kind === 'workspace')
    for (const member of handle.membership({ within })) {
      const node = nodes.get(member.identity);
      if (member.seat !== seat.identity || member.placement !== 'authored' || node === undefined) continue;
      if (tallied(seeding.key, node)) captured.set(node.discriminator, (captured.get(node.discriminator) ?? 0) + 1);
    }

  const lines: SystemLine[] = [];
  const home = seat.home === null ? undefined : nodes.get(seat.home);
  const composes =
    home === undefined
      ? [...systems.values()].filter((system) => system.placement.kind !== 'floor')
      : view(home.identity)
          .filter(
            (entry) =>
              entry.kind === 'field-ref' &&
              entry.direction === 'out' &&
              entry.spelling === 'composition.systems' &&
              entry.other !== null,
          )
          .map((entry) => nodes.get(entry.other!))
          .filter((system): system is Node => system?.discriminator === 'system');
  for (const system of new Set(composes)) {
    const steward = stewardOf(system);
    lines.push({
      system: system.name,
      identity: system.identity,
      words: system.sections
        .filter((section) => section.name === 'discriminators')
        .flatMap((section) => section.fields)
        .flatMap((field) => ('key' in field ? [field.key] : [])),
      band: system.band,
      steward,
      read: readCommand(steward ?? system.identity),
    });
  }
  lines.sort((a, b) => compare(a.identity, b.identity));

  const value = seeding.key;
  return freeze({
    revision: seeding.revision,
    key: value,
    seat,
    loaded,
    pointers,
    tallies: [...tallies.values()].sort((a, b) => compare(a.word, b.word) || compare(a.system, b.system)),
    frontier: [...frontier.values()].sort((a, b) => compare(a.system, b.system) || compare(a.kind, b.kind)),
    systems: lines,
    captured: [...captured].sort(([a], [b]) => compare(a, b)).map(([word, count]) => ({ word, count })),
    counts: {
      composition: seeding.composition.length,
      seeds: seeding.seeds.length,
      loaded: loaded.length,
      truncated: seeding.truncated,
      pointers: pointed.length,
      truncatedPointers: pointed.length - pointers.length,
      frontier: [...frontier.values()].reduce((sum, tally) => sum + tally.count, 0),
    },
    widening: {
      deepen: value.depth < SCOPE_KEY_CAPS.depth ? { ...value, depth: value.depth + 1 } : null,
      reseat: {
        shape: value.shape,
        phase: value.phase,
        primitive: value.primitive,
        depth: SCOPE_KEY_DEFAULTS.depth,
        budget: SCOPE_KEY_DEFAULTS.budget,
        word: null,
      },
    },
    unknowns: seeding.unknowns,
  });
}
