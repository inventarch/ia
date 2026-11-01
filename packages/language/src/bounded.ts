/**
 * Work that source text sizes stays linear in it. Two habits break that without looking wrong: a spread passes every item
 * as a call argument, which throws RangeError once a list outgrows the call stack, and a diagnostic per occurrence that
 * names every other occurrence grows with the square of them, so a small repetitive file exhausts the heap.
 */

/**
 * What each thing a source produces costs of one budget (spec L35), in units of about the heap and time one token takes
 * through every stage. One meter, not one limit per kind, because kinds add up: a source can hold as many records as a
 * limit on records admits, as many diagnostics as a limit on diagnostics admits, and both at once. A cost is paid where
 * the thing is produced, for everything later stages will do with it: a compiled field pays for its copy in each graph,
 * its index entries and the entry a check may report on it, so those stages meter nothing of their own.
 */
export const WORK_COST = Object.freeze({
  /** A token, a physical line or an indentation step. */
  token: 1,
  /** A diagnostic, and its copies in a report; a long message costs once more for every 64 characters. */
  diagnostic: 12,
  /** A record: its node in each graph, its verdicts and its index entries. */
  record: 24,
  /** A compiled field, list item, cell, selector, variant or requirement. */
  product: 4,
  /** An edge assertion: the edge, its assertion, both adjacency entries and the graph diagnostic it may raise. */
  edge: 12,
  /** One pair of a family of clauses, which compliance judges for overlap. */
  clausePair: 16,
});
/** Thrown the moment a budget is passed, so what would follow is never allocated. */
export class BudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`More than ${limit} units of work`);
    this.name = 'BudgetExceeded';
  }
}
/**
 * Spends as each stage produces, never after. Bytes and lines do not measure what a source costs: one line of a million
 * commas holds a million diagnostics, and six clean files of unknown verbs hold a million more once compiled. A budget
 * shared by several sources gives back what one of them spent when that source is refused, as nothing of it is kept.
 */
export class WorkBudget {
  #spent = 0;
  #reclaim: (() => boolean) | undefined;
  constructor(readonly limit: number) {}
  charge(units: number): void {
    this.#spent += units;
    while (this.#spent > this.limit) if (this.#reclaim?.() !== true) throw new BudgetExceeded(this.limit);
  }
  /**
   * While set, a budget that runs out asks `reclaim` to give something back before it refuses what is being spent, and
   * stops asking once it answers false: what spent most can be held by a stage before the one that runs out.
   */
  reclaiming(reclaim: (() => boolean) | undefined): void {
    this.#reclaim = reclaim;
  }
  token(count = 1): void {
    this.charge(count * WORK_COST.token);
  }
  /** One value of `length` characters: a token, and its length, which whatever indexes it reads again. */
  value(length: number): void {
    this.charge(WORK_COST.token + (length >>> 3));
  }
  diagnostic(length: number): void {
    this.charge(WORK_COST.diagnostic + (length >>> 6));
  }
  record(): void {
    this.charge(WORK_COST.record);
  }
  product(count = 1): void {
    this.charge(count * WORK_COST.product);
  }
  edge(): void {
    this.charge(WORK_COST.edge);
  }
  /**
   * A name of `length` that `count` things repeat: each later stage names a record by its identity, for everything the
   * record holds, and the name paid for itself once. Nothing for a name under 1 KiB, an edge's worth a KiB past that.
   */
  repeated(count: number, length: number): void {
    this.charge(count * (length >>> 10) * WORK_COST.edge);
  }
  /** One use of a declared list a later stage reads whole: nothing for a list of ordinary size, one unit per 64 rows. */
  scan(length: number): void {
    this.charge(length >>> 6);
  }
  spent(): number {
    return this.#spent;
  }
  restore(spent: number): void {
    this.#spent = spent;
  }
  /** Gives back what a source spent earlier, once it is refused, whatever other sources have spent since. */
  refund(units: number): void {
    this.#spent -= units;
  }
}
/**
 * The budget of the work in progress, so that what every stage constructs is charged where it is constructed: a
 * diagnostic through `diag`, which no path around a stage can miss. Work is synchronous, so one slot holds it; `metered`
 * sets it for one call and puts back what it found, and a call with no budget meters nothing, however it was reached.
 */
let current: WorkBudget | undefined;
export const meter = (): WorkBudget | undefined => current;
export function metered<T>(budget: WorkBudget | undefined, work: () => T): T {
  const outer = current;
  current = budget;
  try {
    return work();
  } finally {
    current = outer;
  }
}

/** How many occurrences one diagnostic names. A list that fits is written whole; a longer one counts the rest. */
export const NAMED_OCCURRENCES = 8;
/** How many systems one diagnostic names; a workspace's visible systems usually fit, so the message stays whole. */
export const NAMED_SYSTEMS = 32;

/** Appends every item to `target`, as `target.push(...items)` would for a list of any length. */
export function append<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** The first `limit` items, rendered and comma-separated, then how many more there are. */
export function listed<T>(items: readonly T[], render: (item: T) => string, limit: number = NAMED_OCCURRENCES): string {
  const named = items.slice(0, limit).map(render).join(', ');
  return items.length > limit ? `${named} and ${items.length - limit} more` : named;
}

/** `listed` over `items` without `self`, one of them, without reading past what it names. */
export function others<T>(items: readonly T[], self: T, render: (item: T) => string): string {
  const named = items
    .slice(0, NAMED_OCCURRENCES + 1)
    .filter((item) => item !== self)
    .slice(0, NAMED_OCCURRENCES);
  const more = items.length - 1 - named.length;
  return `${named.map(render).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * The most graph and compliance say at once, which no budget charges. What they report was paid for as one thing of a
 * record, and can repeat a name the record's own word spelled once, so a message holds this many characters in all,
 * what counts the rest and the `reserved` a caller will add among them: its own copy, as a slice would hold all of it.
 */
export const MESSAGE_LENGTH = 4_096;
const untold = (count: number): string => `... and ${count} more characters`;
export function clipped(message: string, reserved = 0): string {
  const room = MESSAGE_LENGTH - reserved;
  if (message.length <= room) return message;
  const kept = room - untold(message.length).length;
  return structuredClone(`${message.slice(0, kept)}${untold(message.length - kept)}`);
}

const memberSets = new WeakMap<readonly unknown[], ReadonlySet<unknown>>();
/** `list.includes(item)` for a declared list of any length: a list read per use costs its length per use. */
export function member<T>(list: readonly T[], item: T): boolean {
  if (list.length < 32) return list.includes(item);
  let set = memberSets.get(list);
  if (set === undefined) {
    set = new Set(list);
    memberSets.set(list, set);
  }
  return set.has(item);
}
