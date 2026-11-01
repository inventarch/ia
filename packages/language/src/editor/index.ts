import type { FileNode, RecordNode, Span } from '../ast.js';
import { parse, SUPPORTED_VERSIONS } from '../parser/index.js';
import { spell } from '../parser/values.js';
import { references } from '../references.js';
import type { TypedReference } from '../references.js';
import { scan } from '../scanner/index.js';
import { logicalLines, walk } from '../scanner/lines.js';
import { tokenizeLine } from '../scanner/tokenize.js';
import type { Token } from '../scanner/tokens.js';
import { draftValue } from './values.js';
import type { DraftSchema } from './values.js';
export { format, checkFormatPreservation } from '../formatter.js';
export { annotateRecord, appendRecord, addRelationship, relationshipConsent, setField } from './edit-source.js';
export type { RelationshipConsent } from './edit-source.js';
export { draftValue, encodeValue, SourceEditError } from './values.js';
export type { DraftField, DraftSchema, SourceEditReason } from './values.js';

/**
 * Minimal source serialization for a schema-backed form; admission remains a separate operation. Each value is spelled
 * as 2.0.0 spelled it (`draftValue`: text quoted, other types as given). A line break throws a plain Error, as it did in
 * 2.0.0; a value that would add a `when` condition or a comment, or that opens a string, prose or list it does not close,
 * throws SourceEditError. The strict typed spelling is `encodeValue`.
 */
export function draftSource(
  discriminator: string,
  name: string,
  schema: DraftSchema,
  values: Readonly<Record<string, string>>,
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(discriminator) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name))
    throw new Error('Invalid IA discriminator or record name');
  const sections = new Map<string, string[]>(),
    keys = new Set(schema.fields.map((f) => `${f.section}/${f.key}`));
  if (Object.keys(values).some((key) => !keys.has(key))) throw new Error('Draft contains an undeclared schema field');
  for (const section of schema.sections) if (section.must) sections.set(section.name, []);
  for (const field of schema.fields) {
    const value = values[`${field.section}/${field.key}`];
    if (value === undefined) continue;
    if (typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error('Form fields must be single-line; use the source draft for multiline prose or structure');
    const encoded = draftValue(field, value);
    const rows = sections.get(field.section) ?? [];
    rows.push(`${field.key} ${encoded}`);
    sections.set(field.section, rows);
  }
  return (
    `#! ia 1.0\n\n@${discriminator} ${name}\n` +
    [...sections]
      .sort(([a], [b]) => (a === 'head' ? -1 : b === 'head' ? 1 : 0))
      .map(([section, rows]) =>
        section === '' || section === 'head'
          ? rows.map((r) => `  ${r}\n`).join('')
          : `  ${section}\n${rows.map((r) => `    ${r}\n`).join('')}`,
      )
      .join('')
  );
}

export interface Position {
  readonly line: number;
  readonly character: number;
}
export interface Range {
  readonly start: Position;
  readonly end: Position;
}
export interface SourceToken {
  readonly token: Token;
  readonly range: Range;
}
export interface SourceReference extends TypedReference {
  readonly range: Range;
}
export interface SourceProjection {
  readonly ast: FileNode;
  readonly tokens: readonly SourceToken[];
  readonly references: readonly SourceReference[];
  readonly supported: boolean;
}
export const contains = (range: Range, at: Position): boolean =>
  (at.line > range.start.line || (at.line === range.start.line && at.character >= range.start.character)) &&
  (at.line < range.end.line || (at.line === range.end.line && at.character <= range.end.character));
export function lineRange(source: string | readonly string[], span: Span): Range {
  const lines = typeof source === 'string' ? source.split(/\r?\n/) : source,
    line = Math.max(0, Math.min(lines.length - 1, span.line - 1));
  const end = Math.max(line, Math.min(lines.length - 1, span.endLine - 1));
  return { start: { line, character: 0 }, end: { line: end, character: lines[end]?.length ?? 0 } };
}
export function recordsIn(ast: FileNode): readonly RecordNode[] {
  return ast.records.flatMap(function flatten(record): RecordNode[] {
    return [record, ...record.nested.flatMap(flatten)];
  });
}

/** What an editor reads of a source that was refused without being parsed: nothing, whatever its text holds. */
export function unparsedProjection(path: string): SourceProjection {
  return {
    ast: { kind: 'file', path, version: '', records: [], trivia: [] },
    tokens: [],
    references: [],
    supported: false,
  };
}
/** The index of the first of `items`, which stand in line order, on `line` or past it. */
function firstOn<T>(items: readonly T[], line: number, lineOf: (item: T) => number): number {
  let from = 0,
    to = items.length;
  while (from < to) {
    const middle = (from + to) >>> 1;
    if (lineOf(items[middle]!) < line) from = middle + 1;
    else to = middle;
  }
  return from;
}
/** Scanner columns exclude layout; restore physical UTF-16 positions without lexing again. */
export function projectSource(source: string, path: string): SourceProjection {
  const parsed = parse(source, path),
    scanned = scan(source, path),
    lines = source.split(/\r?\n/);
  const tokens: SourceToken[] = scanned.tokens.flatMap((token) => {
    if (!('column' in token)) return [];
    const line = token.line - 1,
      indent = /^[\t ]*/.exec(lines[line] ?? '')![0].length;
    const start = { line, character: indent + token.column - 1 + (line === 0 && source.startsWith('\uFEFF') ? 1 : 0) };
    const parts = spell(token).split('\n');
    const end = {
      line: line + parts.length - 1,
      character: parts.length === 1 ? start.character + parts[0]!.length : parts.at(-1)!.length,
    };
    return [{ token, range: { start, end } }];
  });
  // Tokens stand in line order, so each reference finds its token from these, once, by line.
  const sigils: { readonly token: SourceToken; readonly next: SourceToken | undefined }[] = [],
    words = new Map<string, SourceToken[]>();
  tokens.forEach((t, index) => {
    if (t.token.kind === 'sigil') sigils.push({ token: t, next: tokens[index + 1] });
    else if (t.token.kind === 'word') {
      const row = words.get(t.token.value);
      if (row === undefined) words.set(t.token.value, [t]);
      else row.push(t);
    }
  });
  const uses = references(parsed.ast).flatMap((use): SourceReference[] => {
    if (use.reference.kind === 'identity') {
      const value = use.reference.identity + (use.reference.fragment === undefined ? '' : `#${use.reference.fragment}`),
        row = words.get(value) ?? [],
        found = row[firstOn(row, use.span.line, (t) => t.token.line)];
      return found === undefined || found.token.line > use.span.endLine ? [] : [{ ...use, range: found.range }];
    }
    const sigil = sigils[firstOn(sigils, use.span.line, (s) => s.token.token.line) + use.index];
    if (sigil === undefined || sigil.token.token.line > use.span.endLine) return [];
    const { token: start, next } = sigil;
    return next?.token.kind === 'word' ? [{ ...use, range: { start: start.range.start, end: next.range.end } }] : [];
  });
  return {
    ast: parsed.ast,
    tokens,
    references: uses,
    supported: (SUPPORTED_VERSIONS as readonly string[]).includes(parsed.ast.version),
  };
}

export interface CursorContext {
  readonly slot: 'none' | 'header' | 'section' | 'field' | 'value' | 'reference' | 'fragment';
  readonly range: Range;
  readonly prefix: string;
  readonly words: readonly string[];
  readonly record?: RecordNode;
  readonly section?: string;
  readonly discriminator?: string;
  readonly targetName?: string;
}
/** Recovery uses language scanner primitives and never supplies records for admission. */
export function cursorContext(
  source: string,
  path: string,
  at: Position,
  projection = projectSource(source, path),
): CursorContext {
  const lines = source.split(/\r?\n/),
    line = lines[at.line] ?? '',
    prefixLine = line.slice(0, at.character);
  const range = { start: at, end: at },
    none: CursorContext = { slot: 'none', range, prefix: '', words: [] };
  if (!projection.supported) return none;
  if (
    projection.tokens.some(
      (t) =>
        (t.token.kind === 'string' || t.token.kind === 'prose') &&
        contains(t.range, at) &&
        at.character !== t.range.end.character,
    )
  )
    return none;
  const prefixSource = [...lines.slice(0, at.line), prefixLine].join('\n');
  const logical = logicalLines(prefixSource, path);
  if (logical.diagnostics.some((d) => d.code === 'IA-LANG-PROSE-UNTERMINATED')) return none;
  const lexical = walk(prefixLine);
  if (lexical.commentAt >= 0 || lexical.endsInString || lexical.endsInProse) return none;
  const indent = /^[ \t]*/.exec(prefixLine)![0].length;
  const local = tokenizeLine(prefixLine.slice(indent), path, at.line + 1).tokens;
  const last = local.at(-1),
    trailingSpace = /\s$/.test(prefixLine);
  const prefix = !trailingSpace && last !== undefined ? spell(last) : '';
  const replace = { start: { line: at.line, character: at.character - prefix.length }, end: at };
  const words = local.filter((t) => t.kind === 'word' || t.kind === 'sigil').map((t) => t.value);
  const records = recordsIn(projection.ast).filter((r) => r.span.line <= at.line + 1);
  const record = records
    .filter((r) => /^[ ]*/.exec(lines[r.span.line - 1] ?? '')![0].length < indent || r.span.line === at.line + 1)
    .at(-1);
  const section = record?.sections
    .filter((s) => s.span.line <= at.line + 1 && /^[ ]*/.exec(lines[s.span.line - 1] ?? '')![0].length < indent)
    .at(-1)?.name;
  const base = {
    range: replace,
    prefix,
    words,
    ...(record === undefined ? {} : { record }),
    ...(section === undefined ? {} : { section }),
  };
  if (prefixLine.slice(indent).startsWith('@'))
    return { ...base, slot: local.length <= 1 && !trailingSpace ? 'header' : 'none' };
  const sigilIndex = local.map((t) => t.kind).lastIndexOf('sigil');
  if (sigilIndex >= 0) {
    const sigil = local[sigilIndex]!,
      name = local[sigilIndex + 1];
    if (sigil.kind === 'sigil' && (sigilIndex === local.length - 1 || sigilIndex === local.length - 2)) {
      const hash = name?.kind === 'word' ? name.value.indexOf('#') : -1;
      return {
        ...base,
        range: { start: { line: at.line, character: indent + sigil.column - 1 }, end: at },
        slot: hash >= 0 ? 'fragment' : 'reference',
        discriminator: sigil.value.slice(1),
        ...(name?.kind === 'word' ? { targetName: hash >= 0 ? name.value.slice(0, hash) : name.value } : {}),
      };
    }
  }
  const recordIndent = record === undefined ? -1 : /^[ ]*/.exec(lines[record.span.line - 1] ?? '')![0].length;
  if (record !== undefined && indent === recordIndent + 2 && local.length <= 1 && !trailingSpace)
    return { ...base, slot: 'section' };
  if (record === undefined) return { ...base, slot: 'header' };
  return { ...base, slot: local.length <= (trailingSpace ? 0 : 1) ? 'field' : 'value' };
}
