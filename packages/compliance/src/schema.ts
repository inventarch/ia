import { DIMENSION_PATHS, clipped, indexedResolver, isKind, listed, member, resolveTarget } from '@inventarch/language';
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

/**
 * Whether a typed reference field names at least one admitted record (C04a). Absent, no `IA-COMP-FIELD-REF-MISSING`
 * warning is raised.
 */
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
      // A rule names the relation from the record's side: `out` counts the record's active edges, `in` the edges whose
      // active target is the record. The record's own assertion in the rule's direction supplies the other endpoint as
      // its resolved target; another record's assertion in the opposite direction states the same relation from the
      // other end, so its author is the endpoint when that edge refers back to this record.
      for (const author of all)
        for (const edge of author.edges) {
          if (edge.predicate !== rule.predicate) continue;
          if (sameOccurrence(author, record) && edge.direction === rule.direction) {
            const resolved = edge.target === null ? [] : all.filter((r) => r.identity === edge.target);
            if (resolved.length === 1) {
              const target = resolved[0]!;
              if (!matchesTarget(target, rule)) continue;
              if (edge.condition !== undefined) uncertain = true;
              else targets.add(`${target.identity}#${edge.fragment ?? ''}`);
            } else if (couldMatch(edge, rule, registry)) uncertain = true;
          } else if (edge.direction !== rule.direction && matchesTarget(author, rule)) {
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
          `${rule.spelling} ${rule.target} requires ${rule.must ? 'must' : 'may'} ${rule.cardinality}; found ${targets.size} definite targets`,
        );
      } else if (uncertain && (targets.size < minimum || maximum !== Infinity)) {
        add(
          'IA-COMP-EDGE-UNRESOLVED',
          record.source,
          `${rule.spelling} ${rule.target} ${rule.cardinality} cannot be decided with unresolved targets or conditions`,
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
/** C33: how many entries one record's check lists. A record refused for one of them is refused whole. */
export const LISTED_FINDINGS = 64;
const NOT_LISTED = '; later entries of this record are not listed';
/** What a list of entries holds that decides its outcome, kept so that a check past the limit reads it once. */
const decided = new WeakMap<Finding[], { error: boolean; undecided: boolean }>();
export function schemaReporter(record: CompiledRecord, findings: Finding[]): Add {
  const held = decided.get(findings) ?? { error: false, undecided: false };
  decided.set(findings, held);
  return (code, span, message, warning = false) => {
    const undecided = code === 'IA-COMP-EDGE-UNRESOLVED' || code === 'IA-COMP-NOT-EVALUATED';
    if (findings.length >= LISTED_FINDINGS) {
      // Past the limit only what would change the outcome is added, and the last entry listed says the list is cut.
      const last = findings[LISTED_FINDINGS - 1] as { message: string };
      if (!last.message.endsWith(NOT_LISTED)) last.message += NOT_LISTED;
      if (warning ? !undecided || held.undecided : held.error) return;
    }
    held.error ||= !warning;
    held.undecided ||= undecided;
    findings.push({
      code,
      severity: warning ? 'warning' : 'error',
      path: record.source.path,
      ...span,
      identity: record.identity,
      message: clipped(`${record.source.path}:${span.line}: ${record.identity}: ${message}`, NOT_LISTED.length),
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

/** A schema's rules by what a record asks of them, read once: a schema of many rules is read for every record. */
interface RuleIndex {
  readonly sections: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
  readonly fields: ReadonlySet<string>;
}
const ruleIndexes = new WeakMap<SchemaDeclaration, RuleIndex>();
const fieldKey = (section: string, key: string): string => JSON.stringify([section, key]);
function ruleIndex(schema: SchemaDeclaration): RuleIndex {
  let index = ruleIndexes.get(schema);
  if (index === undefined) {
    index = {
      sections: new Set(schema.sections.map((rule) => rule.name)),
      optional: new Set(schema.sections.filter((rule) => !rule.must).map((rule) => rule.name)),
      fields: new Set(schema.fields.map((rule) => fieldKey(rule.section, rule.key))),
    };
    ruleIndexes.set(schema, index);
  }
  return index;
}

function validateFields(record: CompiledRecord, schema: SchemaDeclaration, add: Add, exists?: ReferenceLookup): void {
  const rules = ruleIndex(schema);
  const sectionsNamed = new Map<string, CompiledSection[]>();
  for (const section of record.sections) {
    const named = sectionsNamed.get(section.name);
    if (named === undefined) sectionsNamed.set(section.name, [section]);
    else named.push(section);
  }
  const missingSections = new Set<string>();
  for (const rule of schema.sections) {
    if (rule.must && rule.name !== 'head' && !sectionsNamed.has(rule.name)) {
      missingSections.add(rule.name);
      add('IA-COMP-SECTION-MISSING', record.source, `@schema ${schema.name} requires section '${rule.name}'`);
    }
  }
  const consumed = new Set([...record.variants, ...record.requirements].map((product) => spanKey(product.span)));
  if (schema.closed)
    for (const section of record.sections) {
      if (['cognition', 'activation'].includes(section.name)) continue;
      if (!rules.sections.has(section.name))
        add(
          'IA-COMP-SECTION-UNKNOWN',
          section.span,
          `closed @schema ${schema.name} does not admit section '${section.name}'`,
        );
      else validateKeys(record, schema, rules, consumed, section, add);
    }
  // A section's fields by key, each section read once however many rules ask of it.
  const keyed = new Map<string, Map<string, CompiledField[]>>();
  const fieldsAt = (section: string): ReadonlyMap<string, readonly CompiledField[]> => {
    let fields = keyed.get(section);
    if (fields === undefined) {
      fields = new Map();
      const roots =
        section === 'head' ? record.head : (sectionsNamed.get(section) ?? []).flatMap((s) => fieldsOnly(s.fields));
      for (const field of roots) {
        const same = fields.get(field.key);
        if (same === undefined) fields.set(field.key, [field]);
        else same.push(field);
      }
      keyed.set(section, fields);
    }
    return fields;
  };
  for (const rule of schema.fields) {
    if (missingSections.has(rule.section)) continue;
    const sections = sectionsNamed.get(rule.section) ?? [];
    if (rule.section !== 'head' && sections.length === 0 && rules.optional.has(rule.section)) continue;
    const matches = fieldsAt(rule.section).get(rule.key) ?? [];
    if (matches.length === 0 && rule.must)
      add(
        'IA-COMP-FIELD-MISSING',
        sections[0]?.span ?? record.source,
        `@schema ${schema.name} requires '${rule.section}.${rule.key}'`,
      );
    // C04: a declared non-list key is exactly one field; `list of T` is the only type a key may carry more than once.
    // One finding per rule, at the second occurrence.
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
      else {
        validateNarrowing(field, rule, add, exists);
        validateMandateMoves(record, rule, field, add);
      }
    }
  }
}

/**
 * C05's one exception (2026-10-12): a record whose word is `mandate` (agent-system registers it, as the runtime's
 * mandate resolver reads it) and whose schema declares `authority.moves`, as agent-system's does (`list of id`), states
 * its moves as one or more kernel moves, while the dialect has no non-empty list constraint. So a stated empty
 * `authority.moves` is IA-COMP-FIELD-VALUE at the field, each occurrence on its own; an absent one stays valid and
 * restricts no move. Keyed to another system's word as COMP-STEWARD keys the steward to agent-system's `agent`
 * (`systems.ts`, `validateSystems`).
 */
function validateMandateMoves(record: CompiledRecord, rule: SchemaField, field: CompiledField, add: Add): void {
  if (record.discriminator !== 'mandate' || rule.section !== 'authority' || rule.key !== 'moves') return;
  if (field.value.kind === 'list' && field.value.items.length === 0)
    add(
      'IA-COMP-FIELD-VALUE',
      field.span,
      "'authority.moves' must name at least one kernel move when stated; an absent authority.moves restricts no move",
    );
}

/**
 * C04b: under `closed`, a declared body section admits only the keys the schema declares for it; every other ordinary
 * field is `IA-COMP-FIELD-UNKNOWN` at its own span, nested children folded into their block's one finding. An ordinary
 * field is a compiled field the compiler left as a field. It is not one when:
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
function validateKeys(
  record: CompiledRecord,
  schema: SchemaDeclaration,
  rules: RuleIndex,
  consumed: ReadonlySet<string>,
  section: CompiledSection,
  add: Add,
): void {
  if (DIALECT_WORDS.includes(record.discriminator) || GRAMMAR_SECTIONS.includes(section.name)) return;
  for (const field of fieldsOnly(section.fields)) {
    if (rules.fields.has(fieldKey(section.name, field.key))) continue;
    if (DIMENSION_FIELDS.has(`${section.name}.${field.key}`) || consumed.has(spanKey(field.span))) continue;
    add(
      'IA-COMP-FIELD-UNKNOWN',
      field.span,
      `closed @schema ${schema.name} does not declare '${section.name}.${field.key}'`,
    );
  }
}

/** How many of a field's admitted values an entry names; a message states what is admitted, and a list can be long. */
const NAMED_VALUES = 32;
/** The W0 narrowings over a value that already matches its type; one finding per field and narrowing, list items included. */
function validateNarrowing(field: CompiledField, rule: SchemaField, add: Add, exists?: ReferenceLookup): void {
  const path = `'${rule.section}.${rule.key}'`;
  const items = field.value.kind === 'list' ? field.value.items : [field.value];
  const texts = items.filter((item): item is Extract<CompiledValue, { text: string }> => 'text' in item);
  if (rule.values !== undefined) {
    const outside = texts.filter((item) => !member(rule.values!, item.text));
    if (outside.length > 0)
      add(
        'IA-COMP-FIELD-VALUE',
        field.span,
        `${path} admits one of ${listed(rule.values, (value) => value, NAMED_VALUES)}; found ${listed(outside, (item) => JSON.stringify(item.text))}`,
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
        `${path} requires text form ${rule.form}; found ${listed(malformed, (item) => JSON.stringify(item.text))}`,
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
