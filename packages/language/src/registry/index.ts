import { BudgetExceeded, append, metered } from '../bounded.js';
import type { WorkBudget } from '../bounded.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { extractSystems } from './extract.js';
import { BUILTIN_SYSTEMS, FLOOR_CONSENT, FLOOR_REGISTRATIONS, FLOOR_SYSTEM, RESERVED_KEYWORDS } from './floor.js';
import { mergeByName, mergeRegistrations } from './merge.js';
import { orderSystems } from './order.js';
import { extractSchemas } from './schemas.js';
export { fieldTypeText } from './schemas.js';
import type { Entry, FrozenRegistry, Registration, SchemaDeclaration, Source, SystemDeclaration } from './types.js';

export { admits, adopterOf, consentFor } from './consent.js';
export type { AdopterTest } from './consent.js';
export {
  ANY_ADOPTER,
  BUILTIN_SYSTEMS,
  FLOOR_REGISTRATIONS,
  FLOOR_SYSTEM,
  RESERVED_KEYWORDS,
  TAXONOMY_SYSTEM,
} from './floor.js';
export { fieldOf, restAfter, sectionOf, spelledAs, stringOf } from './fields.js';
export type {
  ConsentRow,
  Entry,
  FrozenRegistry,
  Location,
  Placement,
  Registration,
  RequiredSystem,
  SchemaDeclaration,
  SchemaEdge,
  SchemaField,
  SchemaSection,
  Source,
  Steward,
  SystemDeclaration,
} from './types.js';

export interface RegistryResult {
  readonly registry: FrozenRegistry;
  readonly diagnostics: readonly Diagnostic[];
}

/** Diagnostics leave in path order, then line order, whichever stage found them. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

/**
 * The minting join at one location (spec 4.4): extract every @system without a vocabulary; band
 * merge; resolve and order requires; lower consent; resolve schemas. A word is joined or refused.
 * What extraction diagnoses spends `budget`, source by source: `refuse` is told of a source that exhausts it, which then
 * declares nothing and gives back what it spent. A source at runtime placement spends nothing. The join after extraction
 * says two lines for a system at most, its cycle and what it is missing, and one for any other declaration, and spends
 * `budget` as well; it belongs to no one source, so what exhausts it there is `BudgetExceeded`, and the caller decides
 * which source to go without.
 */
export function buildRegistry(
  sources: readonly Source[],
  budget?: WorkBudget,
  refuse?: (source: Source, error: BudgetExceeded) => void,
): RegistryResult {
  const diagnostics: Diagnostic[] = [];
  const systems: SystemDeclaration[] = [];
  const schemas: SchemaDeclaration[] = [];
  const refusedSchemas = new Set<string>();
  for (const source of sources) {
    const band = source.location.placement.band,
      spent = budget?.spent() ?? 0;
    let extracted: ReturnType<typeof extractSystems>, extractedSchemas: ReturnType<typeof extractSchemas>;
    try {
      [extracted, extractedSchemas] = metered(band === 0 ? undefined : budget, () => [
        extractSystems(source.ast, band, source.diagnostics),
        extractSchemas(source.ast, band, source.diagnostics),
      ]);
    } catch (error) {
      if (!(error instanceof BudgetExceeded) || refuse === undefined) throw error;
      budget?.restore(spent);
      refuse(source, error);
      continue;
    }
    append(diagnostics, source.diagnostics);
    append(systems, extracted.systems);
    append(diagnostics, extracted.diagnostics);
    append(schemas, extractedSchemas.schemas);
    append(diagnostics, extractedSchemas.diagnostics);
    for (const name of extractedSchemas.refused) refusedSchemas.add(name);
  }
  return metered(budget, () => joined(systems, schemas, refusedSchemas, diagnostics));
}

/** Band merge, requirements, registrations and schemas over what extraction found, added to its `diagnostics`. */
function joined(
  systems: readonly SystemDeclaration[],
  schemas: readonly SchemaDeclaration[],
  refusedSchemas: Set<string>,
  diagnostics: Diagnostic[],
): RegistryResult {
  const mergedSystems = mergeByName(systems, '@system');
  append(diagnostics, mergedSystems.diagnostics);
  const ordered = orderSystems(mergedSystems.winners);
  append(diagnostics, ordered.diagnostics);
  const inForce = ordered.order.map((name) => mergedSystems.winners.get(name)!);

  const merged = mergeRegistrations(inForce, FLOOR_REGISTRATIONS);
  append(diagnostics, merged.diagnostics);
  const mergedSchemas = mergeByName(schemas, '@schema');
  append(diagnostics, mergedSchemas.diagnostics);
  const entriesOf = new Map<string, Map<string, Entry>>();
  for (const system of inForce) {
    const entries = new Map<string, Entry>();
    for (const entry of system.entries) if (!entries.has(entry.keyword)) entries.set(entry.keyword, entry);
    entriesOf.set(system.name, entries);
  }
  // A winning-band collision already diagnosed the schema; it is refused, not missing.
  for (const schema of schemas) if (!mergedSchemas.winners.has(schema.name)) refusedSchemas.add(schema.name);

  const registrations = new Map<string, Registration>();
  for (const [keyword, registration] of merged.registrations) {
    if (RESERVED_KEYWORDS.includes(keyword)) {
      registrations.set(keyword, registration);
      continue;
    }
    const system = mergedSystems.winners.get(registration.system)!;
    const entry = entriesOf.get(system.name)!.get(keyword)!;
    const schema = mergedSchemas.winners.get(registration.schema);
    if (schema === undefined) {
      if (!refusedSchemas.has(registration.schema)) {
        diagnostics.push(
          diag(
            'IA-LANG-SCHEMA-MISSING',
            system.path,
            entry.span.line,
            `${system.path}:${entry.span.line}: '${keyword}' names @schema ${registration.schema}, which no visible file declares`,
          ),
        );
      }
      continue;
    }
    if (schema.kind !== registration.kind) {
      diagnostics.push(
        diag(
          'IA-LANG-SCHEMA-KIND-MISMATCH',
          system.path,
          entry.span.line,
          `${system.path}:${entry.span.line}: '${keyword}' lowers to ${registration.kind} but @schema ${registration.schema} lowers to ${schema.kind}`,
        ),
      );
      continue;
    }
    registrations.set(keyword, registration);
  }

  const registry: FrozenRegistry = Object.freeze({
    systems: new Map(inForce.map((s) => [s.name, s] as const)),
    order: [...BUILTIN_SYSTEMS, ...ordered.order.filter((name) => !BUILTIN_SYSTEMS.includes(name))],
    registrations,
    blocked: merged.blocked,
    schemas: mergedSchemas.winners,
    consent: new Map([...inForce.map((s) => [s.name, s.consent] as const), [FLOOR_SYSTEM, FLOOR_CONSENT]]),
  });
  return { registry, diagnostics: sortDiagnostics(diagnostics) };
}
