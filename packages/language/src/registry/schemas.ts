import type { ChildNode, FieldNode, FileNode, RecordNode, Value } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { VERB_PHRASES, verbOf } from '../semantic/vocabulary.js';
import {
  CARDINALITIES,
  KINDS,
  TEXT_FORMS,
  VALUE_TYPES,
  fieldTypeOf,
  isCardinality,
  isId,
  isKind,
  isTextForm,
} from '../taxonomy.js';
import type { Band, FieldType, Kind } from '../taxonomy.js';
import { conditionsIn, recordsIn } from './records.js';
import type { SchemaDeclaration, SchemaEdge, SchemaField, SchemaSection } from './types.js';

const KEYWORD = /^[a-z][a-z0-9-]*$/;
/** The three W0 narrowings a field type may carry after it: `in [...]` (id), `to <word>` (ref), `form <form>` (text). */
const NARROWING_WORDS: readonly string[] = ['in', 'to', 'form'];
type Narrowing = Pick<SchemaField, 'values' | 'target' | 'form'>;

/**
 * Reads the narrowing spelled after a field type, or returns why it is malformed. `words` starts at the narrowing
 * word; `value` is the row's value, which an `in [...]` set consumes so that row carries no description.
 */
function narrowingOf(type: FieldType, words: readonly string[], value: Value): Narrowing | string {
  const scalar = type.startsWith('list of ') ? type.slice(8) : type;
  const word = words[0];
  const argument = words[1];
  if (word === 'in') {
    if (scalar !== 'id') return '`in [...]` narrows id or list of id only';
    if (words.length !== 1 || value.kind !== 'list' || value.items.length === 0)
      return '`in` must be followed by a nonempty bracketed list of distinct ids: `as id in [a, b]`';
    const values: string[] = [];
    for (const item of value.items) {
      if (item.kind !== 'scalar' || !isId(item.text) || values.includes(item.text))
        return '`in` must be followed by a nonempty bracketed list of distinct ids: `as id in [a, b]`';
      values.push(item.text);
    }
    return { values };
  }
  if (word === 'to') {
    if (scalar !== 'ref') return '`to <word>` narrows ref or list of ref only';
    if (words.length !== 2 || argument === undefined || !KEYWORD.test(argument))
      return '`to` must name one discriminator: `as ref to <word>`';
    return { target: argument };
  }
  if (scalar !== 'text') return '`form <form>` narrows text or list of text only';
  if (words.length !== 2 || argument === undefined) return '`form` must name one text form: `as text form <form>`';
  if (!isTextForm(argument)) return `form '${argument}' is not a text form; admitted: ${TEXT_FORMS.join(', ')}`;
  return { form: argument };
}

/** The field type as the dialect spells it, narrowing included: `id in [a, b]`, `list of ref to task`, `text form iso-date`. */
export function fieldTypeText(field: {
  readonly type: string;
  readonly values?: readonly string[];
  readonly target?: string;
  readonly form?: string;
}): string {
  if (field.values !== undefined) return `${field.type} in [${field.values.join(', ')}]`;
  if (field.target !== undefined) return `${field.type} to ${field.target}`;
  if (field.form !== undefined) return `${field.type} form ${field.form}`;
  return field.type;
}

export interface ExtractedSchemas {
  readonly schemas: readonly SchemaDeclaration[];
  readonly diagnostics: readonly Diagnostic[];
  /** Lowercased names of `@schema` records that were present but refused, so a registration naming one is not also "missing". */
  readonly refused: ReadonlySet<string>;
}

/** Every `@schema`, including nested declarations. The caller retains parser diagnostics once. */
export function extractSchemas(ast: FileNode, band: Band, parserDiagnostics: readonly Diagnostic[]): ExtractedSchemas {
  const schemas: SchemaDeclaration[] = [];
  const diagnostics: Diagnostic[] = [];
  const refused = new Set<string>();
  for (const { record, errors } of recordsIn(ast, parserDiagnostics)) {
    if (record.discriminator !== 'schema') continue;
    const schema = errors.length > 0 ? undefined : schemaOf(record, ast.path, band, diagnostics);
    if (schema === undefined) refused.add(record.name.toLowerCase());
    else schemas.push(schema);
  }
  return { schemas, diagnostics, refused };
}

function schemaOf(
  record: RecordNode,
  path: string,
  band: Band,
  diagnostics: Diagnostic[],
): SchemaDeclaration | undefined {
  let ok = true;
  const malformed = (element: string, line: number, why: string): void => {
    diagnostics.push(
      diag('IA-LANG-SCHEMA-MALFORMED', path, line, `${path}:${line}: @schema ${record.name}: ${element} ${why}`),
    );
    ok = false;
  };

  // Conditions own their diagnostic; judging the same refused row again would report it twice.
  for (const section of record.sections)
    if (section.name === 'when') malformed('when', section.span.line, 'cannot open a schema condition block');
  for (const child of conditionsIn([
    ...record.head,
    ...record.sections.filter((section) => section.name !== 'when').flatMap((section) => section.children),
  ])) {
    malformed(`'${child.key}'`, child.span.line, 'carries a when clause; a schema states no conditions');
  }
  const flatRow = (child: ChildNode, element: string): child is FieldNode => {
    if (conditionsIn([child]).length > 0) return false;
    if (child.kind !== 'field') {
      malformed(element, child.span.line, 'holds field rows, not items or nested records');
      return false;
    }
    if (child.children.length > 0) {
      malformed(element, child.span.line, 'row cannot hold a child block');
      return false;
    }
    return true;
  };
  const blocks = (name: string) => record.sections.filter((section) => section.name === name);
  const rows = (name: string) => blocks(name).flatMap((section) => section.children);

  let kind: Kind | undefined;
  const lowersFields = record.head.filter((field) => field.words[0] === 'lowers' && field.words[1] === 'to');
  const lowers = lowersFields[0];
  for (const duplicate of lowersFields.slice(1))
    malformed('lowers to', duplicate.span.line, 'appears twice; it is written once');
  if (lowers === undefined) malformed('lowers to', record.span.line, 'is required: `lowers to <kind>`');
  else if (flatRow(lowers, 'lowers to')) {
    const named = lowers.words[2];
    if (lowers.value.kind !== 'scalar' || lowers.words.length !== 3 || named === undefined)
      malformed('lowers to', lowers.span.line, 'must name one bare kind: `lowers to <kind>`');
    else if (isKind(named)) kind = named;
    else {
      diagnostics.push(
        diag(
          'IA-LANG-KIND-UNKNOWN',
          path,
          lowers.span.line,
          `${path}:${lowers.span.line}: '${named}' is not a closed kind; admitted: ${KINDS.join(', ')}`,
        ),
      );
      ok = false;
    }
  }

  const sections: SchemaSection[] = [];
  let closed: boolean | undefined;
  const sectionsBlock = blocks('sections')[0];
  if (sectionsBlock === undefined)
    malformed('sections', record.span.line, 'is required: `must have`/`may have` lines ending with `closed` or `open`');
  else {
    const children = rows('sections');
    const terminators: { readonly field: FieldNode; readonly index: number; readonly valid: boolean }[] = [];
    let lastSectionAt = -1;
    let rowFault = false;
    children.forEach((child, index) => {
      const words = child.kind === 'field' ? child.words : [];
      const first = words[0];
      if (child.kind === 'field' && (first === 'closed' || first === 'open')) {
        const flat = flatRow(child, 'sections');
        const valid = flat && words.length === 1 && child.value.kind === 'none';
        terminators.push({ field: child, index, valid });
        if (valid) closed = first === 'closed';
        else if (flat) malformed('sections', child.span.line, 'terminator must be bare `closed` or `open`');
        return;
      }
      if (!flatRow(child, 'sections')) {
        rowFault = true;
        return;
      }
      const name = words[2];
      if (
        (first === 'must' || first === 'may') &&
        words[1] === 'have' &&
        words.length === 3 &&
        name !== undefined &&
        KEYWORD.test(name) &&
        child.value.kind === 'scalar'
      ) {
        lastSectionAt = index;
        if (sections.some((section) => section.name === name))
          malformed('sections', child.span.line, `lists '${name}' twice`);
        else sections.push({ name, must: first === 'must', span: child.span });
        return;
      }
      rowFault = true;
      malformed(
        'sections',
        child.span.line,
        'holds `must have <section>` or `may have <section>` lines, then `closed` or `open`',
      );
    });
    // A malformed terminator or already-refused trailing row must not also become a missing/end-position fault.
    const terminal = terminators[0];
    if (terminal === undefined && !rowFault)
      malformed('sections', sectionsBlock.span.line, 'must end with exactly one of `closed` or `open`');
    else if (terminators.length === 1 && terminal?.valid && terminal.index < lastSectionAt)
      malformed('sections', terminal.field.span.line, 'must end with exactly one of `closed` or `open`');
    for (const duplicate of terminators.slice(1))
      if (duplicate.valid)
        malformed('sections', duplicate.field.span.line, 'must end with exactly one of `closed` or `open`');
  }

  const fields: SchemaField[] = [];
  for (const child of rows('fields')) {
    const line = child.span.line;
    if (!flatRow(child, 'fields')) continue;
    const words = child.words;
    const first = words[0];
    const pathWord = words[2];
    if (
      (first !== 'must' && first !== 'may') ||
      words[1] !== 'have' ||
      pathWord === undefined ||
      words[3] !== 'as' ||
      words.length < 5
    ) {
      malformed('fields', line, 'entry must read `must have <section>.<key> as <type>` or `may have ...`');
      continue;
    }
    const [section, key, ...more] = pathWord.split('.');
    if (section === undefined || key === undefined || !KEYWORD.test(section) || key === '' || more.length > 0) {
      malformed('fields', line, `path '${pathWord}' must be <section>.<key>`);
      continue;
    }
    if (section === 'relationships') {
      diagnostics.push(
        diag(
          'IA-LANG-SCHEMA-EDGE-AS-FIELD',
          path,
          line,
          `${path}:${line}: @schema ${record.name}: '${pathWord}' states a relationship as a field; state it under \`edges\``,
        ),
      );
      ok = false;
      continue;
    }
    const typeWords = words.slice(4);
    const narrowAt = typeWords.findIndex((word) => NARROWING_WORDS.includes(word));
    const type = fieldTypeOf(narrowAt === -1 ? typeWords : typeWords.slice(0, narrowAt));
    if (type === undefined) {
      malformed(
        'fields',
        line,
        `type '${typeWords.join(' ')}' is not a value type; admitted: ${VALUE_TYPES.join(', ')}, or list of one`,
      );
      continue;
    }
    const narrowing = narrowAt === -1 ? {} : narrowingOf(type, typeWords.slice(narrowAt), child.value);
    if (typeof narrowing === 'string') {
      malformed('fields', line, narrowing);
      continue;
    }
    if (narrowing.values === undefined && child.value.kind !== 'scalar' && child.value.kind !== 'string') {
      malformed('fields', line, 'may carry only a quoted description after the type');
      continue;
    }
    if (fields.some((field) => field.section === section && field.key === key)) {
      malformed('fields', line, `lists '${pathWord}' twice`);
      continue;
    }
    const description = child.value.kind === 'string' ? child.value.text : undefined;
    fields.push({
      section,
      key,
      type,
      must: first === 'must',
      ...(description === undefined ? {} : { description }),
      ...narrowing,
      span: child.span,
    });
  }

  const edges: SchemaEdge[] = [];
  for (const child of rows('edges')) {
    const line = child.span.line;
    if (!flatRow(child, 'edges')) continue;
    const words = child.words;
    const first = words[0];
    // The verb is every word between the obligation and the trailing `<target> <cardinality>`, so a present phrase of
    // several words (`grants access to`) is one verb, like a relationships line.
    const spelling = words.slice(1, -2).join(' ');
    const target = words[words.length - 2];
    const cardinality = words[words.length - 1];
    if (
      child.value.kind !== 'scalar' ||
      words.length < 4 ||
      (first !== 'must' && first !== 'may') ||
      target === undefined ||
      cardinality === undefined
    ) {
      malformed('edges', line, 'entry must read `must <predicate> <kind or discriminator> <cardinality>` or `may ...`');
      continue;
    }
    const verb = verbOf(spelling);
    if (verb === undefined) {
      diagnostics.push(
        diag(
          'IA-LANG-PREDICATE-UNKNOWN',
          path,
          line,
          `${path}:${line}: '${spelling}' is not a predicate spelling; admitted: ${VERB_PHRASES.join(', ')}`,
        ),
      );
      ok = false;
      continue;
    }
    const { predicate, direction } = verb;
    if (!isCardinality(cardinality)) {
      malformed('edges', line, `cardinality '${cardinality}' must be one of ${CARDINALITIES.join(', ')}`);
      continue;
    }
    if (!KEYWORD.test(target)) {
      malformed('edges', line, `target '${target}' must spell a kind or discriminator: [a-z][a-z0-9-]*`);
      continue;
    }
    if (edges.some((edge) => edge.predicate === predicate && edge.direction === direction && edge.target === target)) {
      malformed('edges', line, `states '${spelling} ${target}' twice`);
      continue;
    }
    edges.push({ predicate, direction, spelling, target, must: first === 'must', cardinality, span: child.span });
  }

  if (!ok || kind === undefined || closed === undefined) return undefined;
  return {
    name: record.name.toLowerCase(),
    displayName: record.name,
    kind,
    sections,
    closed,
    fields,
    edges,
    path,
    span: record.span,
    band,
  };
}
