import type { ConsentRow, Registration } from './types.js';

/** The system that owns the two structural words (spec 4.1) and the system name the kernel's closed axes use (spec 3.1). */
export const FLOOR_SYSTEM = 'floor';
export const TAXONOMY_SYSTEM = 'taxonomy';
/** Always visible; a `requires` naming one of these resolves without a record. */
export const BUILTIN_SYSTEMS: readonly string[] = [FLOOR_SYSTEM, TAXONOMY_SYSTEM];
/** No `@system` may register these (`IA-LANG-KEYWORD-RESERVED`). */
export const RESERVED_KEYWORDS: readonly string[] = ['system', 'schema'];

/** Fixed incoming-only schema citation permission; no authored floor declaration owns it. */
export const FLOOR_CONSENT: readonly ConsentRow[] = Object.freeze([
  Object.freeze({
    predicate: 'cite' as const,
    targets: Object.freeze(['schema']),
    sources: '*' as const,
    span: Object.freeze({ line: 1, endLine: 1 }),
  }),
]);

/**
 * The floor's registrations. Their schemas are the kernel records `floor/contract/head/system` and
 * `floor/contract/head/schema`, authored in plan 4; the registry does not require them to resolve,
 * because the shapes of `@system` and `@schema` are fixed by spec 4.2 and 4.3 and read by this package.
 */
export const FLOOR_REGISTRATIONS: readonly Registration[] = [
  {
    keyword: 'system',
    system: FLOOR_SYSTEM,
    kind: 'definition',
    category: 'boundary',
    facets: ['system'],
    schema: 'system',
    band: 10,
  },
  {
    keyword: 'schema',
    system: FLOOR_SYSTEM,
    kind: 'contract',
    category: 'representation',
    facets: ['head'],
    schema: 'schema',
    band: 10,
  },
];
