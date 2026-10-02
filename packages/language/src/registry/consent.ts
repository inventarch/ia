import type { Predicate } from '../taxonomy.js';
import { FLOOR_CONSENT, FLOOR_SYSTEM } from './floor.js';
import type { ConsentRow, FrozenRegistry } from './types.js';

function onSide(side: readonly string[] | '*', keyword: string): boolean {
  return side === '*' || side.includes(keyword);
}

/** Row-wise consent: some single row admits the predicate with `source` among its sources and `target` among its targets. No ledger admits nothing. */
export function admits(
  rows: readonly ConsentRow[] | undefined,
  predicate: Predicate,
  source: string,
  target: string,
): boolean {
  return (rows ?? []).some(
    (row) => row.predicate === predicate && onSide(row.sources, source) && onSide(row.targets, target),
  );
}

/**
 * Two-sided consent (spec 6.4): the source keyword's system must admit the edge and so must the
 * target keyword's. Returns the side that refused, or undefined when both admit. An unregistered
 * end is undefined too: that record is refused on its own (2.6), so no edge is judged twice.
 */
export function consentFor(
  registry: FrozenRegistry,
  predicate: Predicate,
  source: string,
  target: string,
  targetFragment?: string,
): 'source' | 'target' | undefined {
  const from = registry.registrations.get(source);
  const to = registry.registrations.get(target);
  if (from === undefined || to === undefined) return undefined;
  // The floor's built-in ledger is incoming only. It cannot grant outgoing authority,
  // including when an authored declaration happens to use the reserved owner name.
  if (from.system === FLOOR_SYSTEM || !admits(registry.consent.get(from.system), predicate, source, target))
    return 'source';
  if (to.system === FLOOR_SYSTEM) {
    if (targetFragment !== undefined || !admits(FLOOR_CONSENT, predicate, source, target)) return 'target';
  } else if (!admits(registry.consent.get(to.system), predicate, source, target)) return 'target';
  return undefined;
}
