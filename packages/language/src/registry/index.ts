import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { extractSystems } from './extract.js';
import { BUILTIN_SYSTEMS, FLOOR_CONSENT, FLOOR_REGISTRATIONS, FLOOR_SYSTEM, RESERVED_KEYWORDS } from './floor.js';
import { mergeByName, mergeRegistrations } from './merge.js';
import { orderSystems } from './order.js';
import { extractSchemas } from './schemas.js';
export { fieldTypeText } from './schemas.js';
import type { FrozenRegistry, Registration, SchemaDeclaration, Source, SystemDeclaration } from './types.js';

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
 */
export function buildRegistry(sources: readonly Source[]): RegistryResult {
  const diagnostics: Diagnostic[] = [];
  const systems: SystemDeclaration[] = [];
  const schemas: SchemaDeclaration[] = [];
  const refusedSchemas = new Set<string>();
  for (const source of sources) {
    const band = source.location.placement.band;
    diagnostics.push(...source.diagnostics);
    const extracted = extractSystems(source.ast, band, source.diagnostics);
    systems.push(...extracted.systems);
    diagnostics.push(...extracted.diagnostics);
    const extractedSchemas = extractSchemas(source.ast, band, source.diagnostics);
    schemas.push(...extractedSchemas.schemas);
    diagnostics.push(...extractedSchemas.diagnostics);
    for (const name of extractedSchemas.refused) refusedSchemas.add(name);
  }

  const mergedSystems = mergeByName(systems, '@system');
  diagnostics.push(...mergedSystems.diagnostics);
  const ordered = orderSystems(mergedSystems.winners);
  diagnostics.push(...ordered.diagnostics);
  const inForce = ordered.order.map((name) => mergedSystems.winners.get(name)!);

  const merged = mergeRegistrations(inForce, FLOOR_REGISTRATIONS);
  diagnostics.push(...merged.diagnostics);
  const mergedSchemas = mergeByName(schemas, '@schema');
  diagnostics.push(...mergedSchemas.diagnostics);
  // A winning-band collision already diagnosed the schema; it is refused, not missing.
  for (const schema of schemas) if (!mergedSchemas.winners.has(schema.name)) refusedSchemas.add(schema.name);

  const registrations = new Map<string, Registration>();
  for (const [keyword, registration] of merged.registrations) {
    if (RESERVED_KEYWORDS.includes(keyword)) {
      registrations.set(keyword, registration);
      continue;
    }
    const system = mergedSystems.winners.get(registration.system)!;
    const entry = system.entries.find((e) => e.keyword === keyword)!;
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
