import type { Predicate } from '../taxonomy.js';
import { ANY_ADOPTER, BUILTIN_SYSTEMS, FLOOR_CONSENT, FLOOR_SYSTEM } from './floor.js';
import type { ConsentRow, FrozenRegistry } from './types.js';

/** Decides whether a keyword is an adopter's word on the ledger being read; without one `any-adopter` matches nothing. */
export type AdopterTest = (keyword: string) => boolean;
const NO_ADOPTERS: AdopterTest = () => false;

function onSide(side: readonly string[] | '*', keyword: string, adopter: AdopterTest): boolean {
  if (side === '*') return true;
  // The marker names no word, so a keyword spelled like it is never a listed member.
  if (keyword === ANY_ADOPTER) return false;
  return side.includes(keyword) || (side.includes(ANY_ADOPTER) && adopter(keyword));
}

/**
 * Row-wise consent: some single row admits the predicate with `source` among its sources and `target` among its
 * targets. `*` matches every keyword; `any-adopter` matches the keywords `adopterOf` accepts. No ledger admits nothing.
 */
export function admits(
  rows: readonly ConsentRow[] | undefined,
  predicate: Predicate,
  source: string,
  target: string,
  adopterOf: AdopterTest = NO_ADOPTERS,
): boolean {
  return (rows ?? []).some(
    (row) =>
      row.predicate === predicate && onSide(row.sources, source, adopterOf) && onSide(row.targets, target, adopterOf),
  );
}

/** True when `name` requires `system`, directly or through the systems it requires; only systems in force are followed. */
function requires(registry: FrozenRegistry, name: string, system: string): boolean {
  const seen = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    for (const required of registry.systems.get(next)?.requires ?? []) {
      if (required.name === system) return true;
      pending.push(required.name);
    }
  }
  return false;
}

/**
 * The adopter test for `system`'s ledger (spec 4.2): a keyword is an adopter's word when its owning system is not a
 * built-in, is not `system` itself, and requires `system` directly or transitively. An unregistered keyword is nobody's.
 */
export function adopterOf(registry: FrozenRegistry, system: string): AdopterTest {
  return (keyword) => {
    const owner = registry.registrations.get(keyword)?.system;
    return (
      owner !== undefined && owner !== system && !BUILTIN_SYSTEMS.includes(owner) && requires(registry, owner, system)
    );
  };
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
  if (
    from.system === FLOOR_SYSTEM ||
    !admits(registry.consent.get(from.system), predicate, source, target, adopterOf(registry, from.system))
  )
    return 'source';
  if (to.system === FLOOR_SYSTEM) {
    if (targetFragment !== undefined || !admits(FLOOR_CONSENT, predicate, source, target)) return 'target';
  } else if (!admits(registry.consent.get(to.system), predicate, source, target, adopterOf(registry, to.system)))
    return 'target';
  return undefined;
}
