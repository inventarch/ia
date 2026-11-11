/**
 * The minimum `inventarch/language` base a set of `.ia` sources needs, computed statically from what its records use
 * against the compatibility index (one schema catalogue per published base of the major).
 *
 * A base fails a record where its schema would refuse it: a word the base doesn't register (but another base does), a
 * section or field its closed schema doesn't declare, a section or field it requires that the record lacks, a value
 * outside its closed set or text form, or a value of the wrong type or reference target. Words no base registers are the kit's own
 * and are ignored. The rules mirror compliance's schema admission (`packages/compliance/src/schema.ts`, C04/C04b/W0):
 * the head is open, `cognition` and `activation` are floor grammar, `relationships`/`cognition`/`activation` fields are
 * never ordinary fields, `governance` fields are variants or the `severity` dimension, a contract's `REQ-*` clauses are
 * requirements, and the two floor dialect words (`schema`, `system`) carry no ordinary fields. Relationship edges are
 * not compared: their targets and cardinality need the resolved graph, so only `ia floor --verify` (which validates on
 * each base) proves them. A source that does not parse is a `parse` gap on every base.
 */
import { matchesForm, matchesType } from '@inventarch/compliance';
import { REQUIREMENT_KINDS, isRequirementId, parse } from '@inventarch/language';
import type { CompiledValue, FieldNode, FieldType, RecordNode, TextForm, Value } from '@inventarch/language';
import { compareVersions } from './codec.js';

export interface CatalogueWord {
  closed: boolean;
  sections: { name: string; required: boolean }[];
  /** `values` is an `id` field's closed set, `target` a `ref` field's discriminator, `form` a `text` field's form. */
  fields: { path: string; type: string; required: boolean; values?: string[]; target?: string; form?: string }[];
  /** `target` is the closed kind or discriminator the rule counts, `cardinality` one of `one`, `one-or-more`, `optional`. */
  edges: { predicate: string; direction: 'out' | 'in'; target: string; required: boolean; cardinality: string }[];
}
export interface BaseCatalogue {
  version: string;
  archive: string;
  engine: string;
  language: string[];
  /** sha256 of the base's `records/language.ia`. */
  languageRecord: string;
  words: Record<string, CatalogueWord>;
}
export interface CompatIndex {
  format: 'ia.language-compat.v1';
  id: 'inventarch/language';
  major: number;
  bases: BaseCatalogue[];
}
export interface Gap {
  base: string;
  source: string;
  record: string;
  word: string;
  /** `parse`: the source does not parse; `key` is `<diagnostic code> at line <n>`, and `record`/`word` are '' when no record owns the line. */
  kind: 'word' | 'section' | 'field' | 'value' | 'form' | 'type' | 'required-section' | 'required-field' | 'parse';
  key: string;
}

/** One field line as authored: the words before its value, whether it was `<key> is <value>`, and its value. */
interface UsedField {
  readonly key: string;
  readonly words: readonly string[];
  readonly assertive: boolean;
  readonly value: Value;
}
interface UsedRecord {
  readonly source: string;
  readonly record: string;
  readonly word: string;
  readonly head: readonly UsedField[];
  readonly sections: readonly { readonly name: string; readonly fields: readonly UsedField[] }[];
}
/** A parse error, attributed to the record whose extent holds its line when there is one. */
interface UsedFault {
  readonly source: string;
  readonly record: string;
  readonly word: string;
  readonly key: string;
}
declare const opaque: unique symbol;
/** What a set of sources uses, read once and compared with any number of bases. Opaque to callers. */
export type Usage = { readonly [opaque]: true };
interface UsageData {
  readonly records: readonly UsedRecord[];
  readonly faults: readonly UsedFault[];
}

const usedField = (field: FieldNode): UsedField => ({
  key: field.key,
  words: field.words,
  assertive: field.assertive === true,
  value: field.value,
});
const fieldsOf = (children: readonly { readonly kind: string }[]): UsedField[] =>
  children.filter((child): child is FieldNode => child.kind === 'field').map(usedField);

/** Reads every record (nested ones included) of every source; CRLF and LF read alike. */
export function usageOf(sources: readonly { path: string; text: string }[]): Usage {
  const records: UsedRecord[] = [],
    faults: UsedFault[] = [];
  const ordered = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, text } of ordered) {
    const { ast, diagnostics } = parse(text.replace(/\r\n/g, '\n'), path);
    const visit = (record: RecordNode): void => {
      records.push({
        source: path,
        record: record.name,
        word: record.discriminator,
        head: record.head.map(usedField),
        sections: record.sections.map((section) => ({ name: section.name, fields: fieldsOf(section.children) })),
      });
      record.nested.forEach(visit);
    };
    ast.records.forEach(visit);
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== 'error') continue;
      // An omitted line lies past its record's parsed span, but inside the attempted record's extent.
      const within = (span: { line: number; endLine: number }): boolean =>
        span.line <= diagnostic.line && diagnostic.line <= span.endLine;
      const extent = ast.syntaxRecordSpans?.find(within);
      const owner = ast.records.find((record) =>
        extent === undefined ? within(record.span) : record.span.line === extent.line,
      );
      faults.push({
        source: path,
        record: owner?.name ?? '',
        word: owner?.discriminator ?? '',
        key: `${diagnostic.code} at line ${diagnostic.line}`,
      });
    }
  }
  return { records, faults } satisfies UsageData as unknown as Usage;
}

/** Floor grammar sections: the language reads their children itself, so they never hold ordinary fields. */
const GRAMMAR_SECTIONS: readonly string[] = ['relationships', 'cognition', 'activation'];
/** Sections every closed schema admits without declaring them. */
const FLOOR_SECTIONS: readonly string[] = ['cognition', 'activation'];
/** The floor dialect words: their bodies are read by the language, not as fields. */
const DIALECT_WORDS: readonly string[] = ['schema', 'system'];
/** Head keys the language spells (spec 2.2; `packages/language/src/compile/spellings.ts` HEAD_SPELLINGS). */
const HEAD_SPELLINGS: readonly (readonly string[])[] = [
  ['facet'],
  ['version'],
  ['provider'],
  ['describes'],
  ['steward'],
  ['lowers', 'to'],
];

/** The key rule against spelled keys (`resolveKey` in `packages/language/src/compile/values.ts`). */
function resolved(field: UsedField, spellings: readonly (readonly string[])[]): { key: string; value: CompiledValue } {
  if (field.assertive || field.value.kind !== 'scalar') return { key: field.key, value: field.value };
  let best: readonly string[] | undefined;
  for (const spelling of spellings) {
    if (spelling.length === 0 || spelling.length > field.words.length) continue;
    if (!spelling.every((word, index) => field.words[index] === word)) continue;
    if (best === undefined || spelling.length > best.length) best = spelling;
  }
  if (best === undefined) return { key: field.key, value: field.value };
  const rest = field.words.slice(best.length);
  return {
    key: best.join(' '),
    value: rest.length === 0 ? { kind: 'none' } : { kind: 'scalar', text: rest.join(' ') },
  };
}
const split = (path: string): [string, string] => {
  const dot = path.indexOf('.');
  return [path.slice(0, dot), path.slice(dot + 1)];
};
/** Whether a field is a semantic product the compiler consumes rather than an ordinary field (compliance C04b). */
function consumed(word: string, section: string, field: UsedField, key: string): boolean {
  if (section === 'governance') return true; // a variant clause, or the `governance.severity` dimension
  return (
    word === 'contract' &&
    (REQUIREMENT_KINDS as readonly string[]).includes(section) &&
    field.words.length === 1 &&
    isRequirementId(key) &&
    (field.value.kind === 'string' || field.value.kind === 'prose')
  );
}

function recordGaps(record: UsedRecord, schema: CatalogueWord, gap: (kind: Gap['kind'], key: string) => void): void {
  const { word } = record;
  const spellings = (section: string): (readonly string[])[] => {
    const declared = schema.fields
      .map((field) => split(field.path))
      .filter(([name]) => name === section)
      .map(([, key]) => key.split(' '));
    return section === 'head' ? [...HEAD_SPELLINGS, ...declared] : declared;
  };
  const missing = new Set<string>();
  for (const rule of schema.sections)
    if (rule.required && rule.name !== 'head' && !record.sections.some((section) => section.name === rule.name)) {
      missing.add(rule.name);
      gap('required-section', `${word}.${rule.name}`);
    }
  if (schema.closed)
    for (const section of record.sections) {
      if (FLOOR_SECTIONS.includes(section.name)) continue;
      if (!schema.sections.some((rule) => rule.name === section.name)) {
        gap('section', `${word}.${section.name}`);
        continue;
      }
      if (DIALECT_WORDS.includes(word) || GRAMMAR_SECTIONS.includes(section.name)) continue;
      const spelled = spellings(section.name);
      for (const field of section.fields) {
        const { key } = resolved(field, spelled);
        if (schema.fields.some((rule) => rule.path === `${section.name}.${key}`)) continue;
        if (!consumed(word, section.name, field, key)) gap('field', `${word}.${section.name}.${key}`);
      }
    }
  for (const rule of schema.fields) {
    const [name, key] = split(rule.path);
    if (missing.has(name)) continue;
    const sections = record.sections.filter((section) => section.name === name);
    if (
      name !== 'head' &&
      sections.length === 0 &&
      schema.sections.some((section) => section.name === name && !section.required)
    )
      continue;
    const spelled = spellings(name);
    const matches = (name === 'head' ? record.head : sections.flatMap((section) => section.fields))
      .map((field) => resolved(field, spelled))
      .filter((field) => field.key === key);
    const type = rule.type as FieldType;
    if (matches.length === 0) {
      if (rule.required) gap('required-field', `${word}.${rule.path}`);
      continue;
    }
    if (matches.length > 1 && !type.startsWith('list of ')) gap('type', `${word}.${rule.path}`);
    for (const { value } of matches) {
      if (!matchesType(value, type)) {
        gap('type', `${word}.${rule.path}`);
        continue;
      }
      const items = value.kind === 'list' ? value.items : [value];
      if (rule.values !== undefined)
        for (const item of items)
          if ('text' in item && !rule.values.includes(item.text)) gap('value', `${word}.${rule.path}=${item.text}`);
      if (rule.target !== undefined && items.some((item) => item.kind === 'ref' && item.discriminator !== rule.target))
        gap('type', `${word}.${rule.path}`);
      if (rule.form !== undefined)
        for (const item of items)
          if ('text' in item && !matchesForm(item.text, rule.form as TextForm))
            gap('form', `${word}.${rule.path}=${item.text}`);
    }
  }
}

/** Why `base` cannot read what `usage` uses, one gap per finding, in source order; empty when it can. */
export function gapsOn(usage: Usage, base: BaseCatalogue, index: CompatIndex): Gap[] {
  const { records, faults } = usage as unknown as UsageData;
  const known = new Set(index.bases.flatMap((entry) => Object.keys(entry.words)));
  const gaps: Gap[] = [];
  for (const fault of faults)
    gaps.push({
      base: base.version,
      source: fault.source,
      record: fault.record,
      word: fault.word,
      kind: 'parse',
      key: fault.key,
    });
  for (const record of records) {
    if (!known.has(record.word)) continue;
    const gap = (kind: Gap['kind'], key: string): void => {
      gaps.push({ base: base.version, source: record.source, record: record.record, word: record.word, kind, key });
    };
    const schema = Object.hasOwn(base.words, record.word) ? base.words[record.word] : undefined;
    if (schema === undefined) gap('word', record.word);
    else recordGaps(record, schema, gap);
  }
  return gaps;
}

/**
 * The lowest base from which every newer base reads `usage`: bases are scanned from the newest down and the scan stops
 * at the first one with gaps, which `gaps` then explains. `floor` is null when the newest base already has gaps.
 */
export function languageFloor(usage: Usage, index: CompatIndex): { floor: string | null; newest: string; gaps: Gap[] } {
  const bases = [...index.bases].sort((a, b) => compareVersions(a.version, b.version));
  const newest = bases[0];
  if (newest === undefined) throw new Error('The compatibility index lists no base');
  let floor: string | null = null;
  for (const base of bases) {
    const gaps = gapsOn(usage, base, index);
    if (gaps.length > 0) return { floor, newest: newest.version, gaps };
    floor = base.version;
  }
  return { floor, newest: newest.version, gaps: [] };
}
