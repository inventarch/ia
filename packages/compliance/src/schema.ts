import { DIMENSION_PATHS, indexedResolver, isKind, resolveTarget } from '@inventarch/language';
import type {
  CompiledChild,
  CompiledEdge,
  CompiledField,
  CompiledRecord,
  CompiledSection,
  CompiledValue,
  EdgeReference,
  FrozenRegistry,
  ResolutionCandidate,
  SchemaDeclaration,
  SchemaEdge,
  SchemaField,
  Span,
} from '@inventarch/language';
import { isListType, matchesForm, matchesType } from './values.js';
import { assess } from './types.js';
import type { Assessment, CompCode, Finding } from './types.js';

/** Whether a typed reference field names at least one admitted record (W0-L2). Absent, no `IA-COMP-FIELD-REF-MISSING` warning is raised. */
export type ReferenceLookup = (reference: EdgeReference) => boolean;
/**
 * One lookup per pool array, built on first use and kept for the pool's lifetime, over language's `indexedResolver`:
 * the whole pool is validated once on first use (an inconsistent candidate anywhere in it faults that first lookup),
 * then each reference resolves against the candidates of its own name only, so a lookup is O(1) per reference.
 * `subject` also resolves when it is not in the pool.
 */
export function poolLookup(
  registry: FrozenRegistry,
  pool: readonly ResolutionCandidate[],
  subject?: ResolutionCandidate,
): ReferenceLookup {
  let byRegistry = lookups.get(pool);
  if (byRegistry === undefined) {
    byRegistry = new WeakMap();
    lookups.set(pool, byRegistry);
  }
  let indexed = byRegistry.get(registry);
  if (indexed === undefined) {
    indexed = lazily(() => indexedResolver(registry, pool));
    byRegistry.set(registry, indexed);
  }
  const resolver = indexed;
  return (reference) =>
    resolver()(reference).kind !== 'missing' ||
    (subject !== undefined && resolveTarget(reference, registry, [subject]).kind !== 'missing');
}
type Indexed = () => (reference: EdgeReference) => { readonly kind: string };
const lookups = new WeakMap<readonly ResolutionCandidate[], WeakMap<FrozenRegistry, Indexed>>();
function lazily<T>(build: () => T): () => T {
  let built: { value: T } | undefined;
  return () => (built ??= { value: build() }).value;
}

export function validateSchema(
  record: CompiledRecord,
  registry: FrozenRegistry,
  pool: readonly CompiledRecord[],
): Assessment {
  const all = [record, ...pool.filter((r) => !sameOccurrence(r, record))];
  const { findings, schema } = schemaStructure(record, registry, poolLookup(registry, pool, record));
  const add = schemaReporter(record, findings);
  if (schema !== undefined) {
    for (const rule of schema.edges) {
      const targets = new Set<string>();
      let uncertain = false;
      for (const author of all)
        for (const edge of author.edges) {
          if (edge.predicate !== rule.predicate) continue;
          if (sameOccurrence(author, record) && edge.direction === 'out') {
            const resolved = edge.target === null ? [] : all.filter((r) => r.identity === edge.target);
            if (resolved.length === 1) {
              const target = resolved[0]!;
              if (!matchesTarget(target, rule)) continue;
              if (edge.condition !== undefined) uncertain = true;
              else targets.add(`${target.identity}#${edge.fragment ?? ''}`);
            } else if (couldMatch(edge, rule, registry)) uncertain = true;
          } else if (edge.direction === 'in' && matchesTarget(author, rule)) {
            // Inbound assertion on another record: subject -> author in active direction.
            const refersHere =
              edge.target === record.identity ||
              (edge.target === null && resolveTarget(edge.reference, registry, [record]).kind === 'resolved');
            if (!refersHere) continue;
            if (edge.target === null || edge.condition !== undefined) uncertain = true;
            else targets.add(`${author.identity}#`);
          }
        }
      const minimum = rule.must && rule.cardinality !== 'optional' ? 1 : 0;
      const maximum = rule.cardinality === 'one-or-more' ? Infinity : 1;
      if (targets.size > maximum || (targets.size < minimum && !uncertain)) {
        add(
          'IA-COMP-EDGE-CARDINALITY',
          record.source,
          `${rule.predicate} ${rule.target} requires ${rule.must ? 'must' : 'may'} ${rule.cardinality}; found ${targets.size} definite targets`,
        );
      } else if (uncertain && (targets.size < minimum || maximum !== Infinity)) {
        add(
          'IA-COMP-EDGE-UNRESOLVED',
          record.source,
          `${rule.predicate} ${rule.target} ${rule.cardinality} cannot be decided with unresolved targets or conditions`,
          true,
        );
      }
    }
  }
  return assess('COMP-SCHEMA', record.identity, findings);
}

/** Shared structural checks; graph supplies its own admitted active relationships. */
export function schemaStructure(
  record: CompiledRecord,
  registry: FrozenRegistry,
  exists?: ReferenceLookup,
): { findings: Finding[]; schema?: SchemaDeclaration } {
  const findings: Finding[] = [],
    add = schemaReporter(record, findings);
  const registration = registry.registrations.get(record.discriminator);
  const schema = registration === undefined ? undefined : registry.schemas.get(registration.schema);
  if (schema === undefined)
    add('IA-COMP-SCHEMA-MISSING', record.source, `no schema is available for '${record.discriminator}'`);
  else if (schema.kind !== record.kind || registration?.kind !== record.kind)
    add('IA-COMP-SCHEMA-KIND-MISMATCH', record.source, `@schema ${schema.name} does not lower to ${record.kind}`);
  else {
    validateFields(record, schema, add, exists);
    return { findings, schema };
  }
  return { findings };
}
export function schemaReporter(record: CompiledRecord, findings: Finding[]): Add {
  return (code, span, message, warning = false) => {
    findings.push({
      code,
      severity: warning ? 'warning' : 'error',
      path: record.source.path,
      ...span,
      identity: record.identity,
      message: `${record.source.path}:${span.line}: ${record.identity}: ${message}`,
    });
  };
}

type Add = (code: CompCode, span: Span, message: string, warning?: boolean) => void;
const fieldsOnly = (children: readonly CompiledChild[]): readonly CompiledField[] =>
  children.filter((c): c is CompiledField => 'key' in c);
/** Floor grammar sections the language reads itself: their children lower to edges, cells and selectors, never to ordinary fields. */
const GRAMMAR_SECTIONS: readonly string[] = ['relationships', 'cognition', 'activation'];
/** The two floor dialect words: the body of a `@schema` or `@system` record is the dialect the language reads (spec 4.2, 4.3), not fields. */
const DIALECT_WORDS: readonly string[] = ['schema', 'system'];
/** `section.key` paths the graph reads as kernel dimension coordinates (today `governance.severity`); the bare head paths never match a body field. */
const DIMENSION_FIELDS: ReadonlySet<string> = new Set(Object.values(DIMENSION_PATHS));
const spanKey = (span: Span): string => `${span.line}:${span.endLine}`;

function validateFields(record: CompiledRecord, schema: SchemaDeclaration, add: Add, exists?: ReferenceLookup): void {
  const missingSections = new Set<string>();
  for (const rule of schema.sections) {
    if (rule.must && rule.name !== 'head' && !record.sections.some((s) => s.name === rule.name)) {
      missingSections.add(rule.name);
      add('IA-COMP-SECTION-MISSING', record.source, `@schema ${schema.name} requires section '${rule.name}'`);
    }
  }
  if (schema.closed)
    for (const section of record.sections) {
      if (['cognition', 'activation'].includes(section.name)) continue;
      if (!schema.sections.some((r) => r.name === section.name))
        add(
          'IA-COMP-SECTION-UNKNOWN',
          section.span,
          `closed @schema ${schema.name} does not admit section '${section.name}'`,
        );
      else validateKeys(record, schema, section, add);
    }
  for (const rule of schema.fields) {
    if (missingSections.has(rule.section)) continue;
    const sections = record.sections.filter((s) => s.name === rule.section);
    if (
      rule.section !== 'head' &&
      sections.length === 0 &&
      schema.sections.some((s) => s.name === rule.section && !s.must)
    )
      continue;
    const roots = rule.section === 'head' ? record.head : sections.flatMap((s) => fieldsOnly(s.fields));
    const matches = roots.filter((field) => field.key === rule.key);
    if (matches.length === 0 && rule.must)
      add(
        'IA-COMP-FIELD-MISSING',
        sections[0]?.span ?? record.source,
        `@schema ${schema.name} requires '${rule.section}.${rule.key}'`,
      );
    // D3: a declared non-list key is exactly one field; `list of T` is the only type a key may carry more than once. One finding per rule, at the second occurrence.
    else if (matches.length > 1 && !isListType(rule.type))
      add(
        'IA-COMP-FIELD-DUPLICATE',
        matches[1]!.span,
        `'${rule.section}.${rule.key}' is declared once by @schema ${schema.name}; found ${matches.length} occurrences`,
      );
    for (const field of matches) {
      if (!matchesType(field.value, rule.type))
        add(
          'IA-COMP-FIELD-TYPE',
          field.span,
          `'${rule.section}.${rule.key}' requires ${rule.type}; found ${field.value.kind}`,
        );
      else validateNarrowing(field, rule, add, exists);
    }
  }
}

/**
 * D1 (W0-L4, work-system design O-6, 2026-09-25): under `closed`, a declared body section admits only the keys the schema
 * declares for it; every other ordinary field is `IA-COMP-FIELD-UNKNOWN` at its own span, nested children folded into
 * their block's one finding. An ordinary field is a compiled field the compiler left as a field. It is not one when:
 *  - its section is floor grammar (`relationships` lower to edges, `cognition` to cells, `activation` to selectors),
 *    which the language reads and refuses itself;
 *  - the compiler consumed it as a semantic product: a governance variant clause (its span is one of `record.variants`;
 *    `readVariants` takes every `governance` field except `severity` and `when`) or a contract requirement clause
 *    (its span is one of `record.requirements`, the `REQ-*` lines under inputs, outputs, failures and their kin);
 *  - its `section.key` path is a kernel dimension (`DIMENSION_PATHS`, today `governance.severity`), which the graph
 *    reads as a coordinate, not a field.
 * Records of the two floor dialect words are exempt: a `@schema` body (`sections.must have`, `fields.may have`,
 * `edges.may`, `closed`) and a `@system` body are the dialect the language reads itself, not fields; `@schema schema`
 * is closed and declares no field. The head is a virtual section and stays open here.
 */
function validateKeys(record: CompiledRecord, schema: SchemaDeclaration, section: CompiledSection, add: Add): void {
  if (DIALECT_WORDS.includes(record.discriminator) || GRAMMAR_SECTIONS.includes(section.name)) return;
  const consumed = new Set([...record.variants, ...record.requirements].map((product) => spanKey(product.span)));
  for (const field of fieldsOnly(section.fields)) {
    if (schema.fields.some((rule) => rule.section === section.name && rule.key === field.key)) continue;
    if (DIMENSION_FIELDS.has(`${section.name}.${field.key}`) || consumed.has(spanKey(field.span))) continue;
    add(
      'IA-COMP-FIELD-UNKNOWN',
      field.span,
      `closed @schema ${schema.name} does not declare '${section.name}.${field.key}'`,
    );
  }
}

/** The W0 narrowings over a value that already matches its type; one finding per field and narrowing, list items included. */
function validateNarrowing(field: CompiledField, rule: SchemaField, add: Add, exists?: ReferenceLookup): void {
  const path = `'${rule.section}.${rule.key}'`;
  const items = field.value.kind === 'list' ? field.value.items : [field.value];
  const texts = items.filter((item): item is Extract<CompiledValue, { text: string }> => 'text' in item);
  if (rule.values !== undefined) {
    const outside = texts.filter((item) => !rule.values!.includes(item.text));
    if (outside.length > 0)
      add(
        'IA-COMP-FIELD-VALUE',
        field.span,
        `${path} admits one of ${rule.values.join(', ')}; found ${outside.map((item) => JSON.stringify(item.text)).join(', ')}`,
      );
  }
  if (rule.target !== undefined) {
    const references = items.filter((item): item is Extract<CompiledValue, { kind: 'ref' }> => item.kind === 'ref');
    const foreign = references.find((reference) => reference.discriminator !== rule.target);
    if (foreign !== undefined)
      add(
        'IA-COMP-FIELD-REF-TARGET',
        field.span,
        `${path} requires ref to ${rule.target}; found @${foreign.discriminator} ${foreign.name}`,
      );
    else if (exists !== undefined) {
      const missing = references.find(
        (reference) => !exists({ kind: 'ref', discriminator: reference.discriminator, name: reference.name }),
      );
      if (missing !== undefined)
        add(
          'IA-COMP-FIELD-REF-MISSING',
          field.span,
          `${path} names @${missing.discriminator} ${missing.name}, which no admitted record declares`,
          true,
        );
    }
  }
  if (rule.form !== undefined) {
    const malformed = texts.filter((item) => !matchesForm(item.text, rule.form!));
    if (malformed.length > 0)
      add(
        'IA-COMP-FIELD-FORM',
        field.span,
        `${path} requires text form ${rule.form}; found ${malformed.map((item) => JSON.stringify(item.text)).join(', ')}`,
      );
  }
}

function sameOccurrence(a: CompiledRecord, b: CompiledRecord): boolean {
  return a.identity === b.identity && a.source.path === b.source.path && a.source.line === b.source.line;
}
export function matchesTarget(record: CompiledRecord, rule: SchemaEdge): boolean {
  return isKind(rule.target) ? record.kind === rule.target : record.discriminator === rule.target;
}
export function couldMatch(edge: CompiledEdge, rule: SchemaEdge, registry: FrozenRegistry): boolean {
  if (edge.reference.kind === 'ref') {
    const registration = registry.registrations.get(edge.reference.discriminator);
    return isKind(rule.target) ? registration?.kind === rule.target : edge.reference.discriminator === rule.target;
  }
  const [system, kind, facet] = edge.reference.identity.split('/');
  if (isKind(rule.target)) return kind === rule.target;
  const registration = registry.registrations.get(rule.target);
  return (
    registration !== undefined &&
    registration.system === system &&
    registration.kind === kind &&
    registration.facets.includes(facet ?? '')
  );
}
