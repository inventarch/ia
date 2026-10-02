import type {
  ChildNode,
  FieldNode,
  FileNode,
  ItemNode,
  RecordNode,
  SectionNode,
  Span,
  TriviaNode,
  Value,
} from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic, LangCode } from '../diagnostics.js';
import { scan } from '../scanner/index.js';
import type { Trivia } from '../scanner/index.js';
import type { StreamToken, Token } from '../scanner/tokens.js';
import { itemValue, spell, splitField } from './values.js';

export const LANGUAGE_VERSION = '1.0';
export const SUPPORTED_VERSIONS: readonly string[] = [LANGUAGE_VERSION];

export interface ParseResult {
  readonly ast: FileNode;
  readonly diagnostics: readonly Diagnostic[];
}

const DISCRIMINATOR_RE = /^[a-z][a-z0-9-]*$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** One logical line as the parser sees it: its tokens and its position. */
interface Line {
  readonly tokens: readonly Token[];
  readonly line: number;
  readonly endLine: number;
  readonly depth: number;
}

interface TrailingComment {
  readonly line: number;
  readonly text: string;
}

function linesOf(tokens: readonly StreamToken[]): { lines: Line[]; trailing: TrailingComment[] } {
  const lines: Line[] = [];
  const trailing: TrailingComment[] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    switch (t.kind) {
      case 'pragma':
      case 'indent':
      case 'dedent':
        break;
      case 'comment':
        if (t.trailing) trailing.push({ line: t.line, text: t.text });
        break;
      case 'newline':
        lines.push({ tokens: current, line: t.line, endLine: t.endLine, depth: t.depth });
        current = [];
        break;
      default:
        current.push(t);
    }
  }
  return { lines, trailing };
}

class Parser {
  index = 0;
  readonly diagnostics: Diagnostic[] = [];
  readonly recordSpans: Span[] = [];
  constructor(
    readonly lines: readonly Line[],
    readonly path: string,
    readonly fileEnd: number,
  ) {}

  peek(): Line | undefined {
    return this.lines[this.index];
  }

  refuse(code: LangCode, line: Line, message: string): void {
    this.diagnostics.push(diag(code, this.path, line.line, `${this.path}:${line.line}: ${message}`));
  }

  /** Skip every line deeper than `depth`: the block beneath something already refused. */
  skipDeeper(depth: number): void {
    while ((this.peek()?.depth ?? -1) > depth) this.index++;
  }

  /** Parse a header line into discriminator and name, or refuse it naming what was found. */
  header(line: Line): { discriminator: string; name: string } | undefined {
    const [first, second, third] = line.tokens;
    if (first?.kind !== 'sigil') {
      this.refuse(
        'IA-LANG-HEADER-MALFORMED',
        line,
        `a header is '@<discriminator> <name>'; found '${first === undefined ? '' : spell(first)}'`,
      );
      return undefined;
    }
    const discriminator = first.value.slice(1);
    if (!DISCRIMINATOR_RE.test(discriminator)) {
      this.refuse('IA-LANG-HEADER-MALFORMED', line, `discriminator '${discriminator}' must match [a-z][a-z0-9-]*`);
      return undefined;
    }
    if (second === undefined) {
      this.refuse('IA-LANG-HEADER-MALFORMED', line, `'@${discriminator}' is missing its name`);
      return undefined;
    }
    if (second.kind !== 'word' || !NAME_RE.test(second.value)) {
      this.refuse(
        'IA-LANG-HEADER-MALFORMED',
        line,
        `name '${spell(second)}' must match [A-Za-z][A-Za-z0-9-]* and carry no fragment`,
      );
      return undefined;
    }
    if (third !== undefined) {
      this.refuse('IA-LANG-HEADER-MALFORMED', line, `unexpected '${spell(third)}' after the name`);
      return undefined;
    }
    return { discriminator, name: second.value };
  }

  /** Parse children at `depth` until a shallower line. */
  children(depth: number, nested: RecordNode[]): ChildNode[] {
    const out: ChildNode[] = [];
    for (;;) {
      const line = this.peek();
      if (line === undefined || line.depth < depth) return out;
      if (line.depth > depth) {
        // Deeper than any child here can be: indented under an item, or stepped in more than one level.
        this.refuse('IA-LANG-INDENT-STEP', line, `depth ${line.depth} here; at most depth ${depth} can follow`);
        this.index++;
        this.skipDeeper(depth);
        continue;
      }
      const first = line.tokens[0];
      if (first?.kind === 'sigil') {
        const record = this.record(line, depth);
        if (record !== undefined) {
          out.push(record);
          nested.push(record);
        }
        continue;
      }
      if (first?.kind === 'word' && first.value === '-') {
        this.index++;
        const read = itemValue(line.tokens.slice(1), this.path, line.line);
        this.diagnostics.push(...read.diagnostics);
        const item: ItemNode = { kind: 'item', value: read.value, span: { line: line.line, endLine: line.endLine } };
        out.push(item);
        continue;
      }
      const field = this.field(line, depth, nested);
      if (field !== undefined) out.push(field);
    }
  }

  /** Parse a field line and its block; `undefined` when the line was refused (its block is still consumed). */
  field(line: Line, depth: number, nested: RecordNode[]): FieldNode | undefined {
    this.index++;
    const split = splitField(line.tokens, this.path, line.line);
    this.diagnostics.push(...split.diagnostics);
    // A value with no key is refused with its block, unjudged; nothing beneath it can leak into `nested`.
    if (split.key === '') {
      this.skipDeeper(depth);
      return undefined;
    }
    const children = this.children(depth + 1, nested);
    const endLine = children.length > 0 ? children[children.length - 1]!.span.endLine : line.endLine;
    // A bare key with children is a block; a refused value stays `none` so the refusal is visible.
    const value: Value =
      split.value.kind === 'none' && children.length > 0 && split.diagnostics.length === 0
        ? { kind: 'block' }
        : split.value;
    return {
      kind: 'field',
      key: split.key,
      words: split.words,
      value,
      ...(split.when === undefined ? {} : { when: split.when }),
      ...(split.assertive === undefined ? {} : { assertive: split.assertive }),
      span: { line: line.line, endLine },
      children,
    };
  }

  record(line: Line, depth: number): RecordNode | undefined {
    this.index++;
    const header = this.header(line);
    // A refused header takes its whole body with it, unjudged: one refusal, one diagnostic.
    if (header === undefined) {
      this.skipDeeper(depth);
      this.recordSpans.push({ line: line.line, endLine: (this.peek()?.line ?? this.fileEnd + 1) - 1 });
      return undefined;
    }
    const nested: RecordNode[] = [];
    const head: FieldNode[] = [];
    const sections: SectionNode[] = [];
    let sawSection = false;
    let endLine = line.endLine;
    for (;;) {
      const next = this.peek();
      if (next === undefined || next.depth <= depth) break;
      if (next.depth > depth + 1) {
        this.refuse(
          'IA-LANG-INDENT-STEP',
          next,
          `depth ${next.depth} here; at most depth ${depth + 1} can follow a header`,
        );
        this.index++;
        this.skipDeeper(depth + 1);
        continue;
      }
      const first = next.tokens[0];
      if (first?.kind === 'sigil') {
        this.refuse(
          'IA-LANG-HEADER-MALFORMED',
          next,
          'a nested record must be inside a section or a field block, not directly under a header',
        );
        this.index++;
        this.skipDeeper(depth + 1);
        continue;
      }
      if (first?.kind === 'word' && first.value === '-') {
        this.refuse('IA-LANG-LIST-MALFORMED', next, 'an item needs a field or a section above it');
        this.index++;
        this.skipDeeper(depth + 1);
        continue;
      }
      const isBare = next.tokens.length === 1 && first?.kind === 'word';
      if (isBare) {
        this.index++;
        const children = this.children(depth + 2, nested);
        const sectionEnd = children.length > 0 ? children[children.length - 1]!.span.endLine : next.endLine;
        sections.push({ kind: 'section', name: first.value, span: { line: next.line, endLine: sectionEnd }, children });
        sawSection = true;
        endLine = sectionEnd;
        continue;
      }
      if (sawSection) {
        // Refused before its block is read. A key-less line is refused for its missing key, not for its position.
        const split = splitField(next.tokens, this.path, next.line);
        if (split.key === '') this.diagnostics.push(...split.diagnostics);
        else
          this.refuse('IA-LANG-HEAD-FIELD-AFTER-SECTION', next, `head field '${split.key}' must precede every section`);
        this.index++;
        this.skipDeeper(depth + 1);
        continue;
      }
      const f = this.field(next, depth + 1, nested);
      if (f === undefined) continue;
      endLine = f.span.endLine;
      head.push(f);
    }
    this.recordSpans.push({ line: line.line, endLine: (this.peek()?.line ?? this.fileEnd + 1) - 1 });
    return {
      kind: 'record',
      discriminator: header.discriminator,
      name: header.name,
      head,
      sections,
      nested,
      span: { line: line.line, endLine },
    };
  }

  file(): RecordNode[] {
    const records: RecordNode[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      const first = line.tokens[0];
      if (line.depth > 0 || first === undefined || first.kind !== 'sigil') {
        const found = first === undefined ? '' : spell(first);
        this.refuse(
          'IA-LANG-TOPLEVEL-UNEXPECTED',
          line,
          line.depth > 0
            ? 'indented line outside any record'
            : `expected a header '@<discriminator> <name>' at depth 0; found '${found}'`,
        );
        this.index++;
        // Only the block beneath the refused line is consumed; a stray sibling is its own mistake.
        this.skipDeeper(line.depth);
        continue;
      }
      const record = this.record(line, 0);
      if (record !== undefined) records.push(record);
    }
    return records;
  }
}

function attachTrivia(
  scanTrivia: readonly Trivia[],
  trailing: readonly TrailingComment[],
  records: readonly RecordNode[],
): TriviaNode[] {
  // A record's endLine is never below its first line, so the first record whose end is at or
  // past the trivia line is the one it precedes or lies within.
  const ends = records.map((r) => r.span.endLine);
  const owner = (line: number): number | 'file' => {
    for (let i = 0; i < ends.length; i++) if (line <= ends[i]!) return i;
    return 'file';
  };
  const out: TriviaNode[] = [];
  for (const t of scanTrivia) {
    out.push(
      t.kind === 'comment'
        ? { kind: 'comment', line: t.line, text: t.text, attachedTo: owner(t.line), trailing: false }
        : { kind: 'blank', line: t.line, attachedTo: owner(t.line), trailing: false },
    );
  }
  for (const t of trailing)
    out.push({ kind: 'comment', line: t.line, text: t.text, attachedTo: owner(t.line), trailing: true });
  return out.sort((a, b) => a.line - b.line);
}

/** Parse one file. Spec sections 1, 2, 9 and 11. */
export function parse(source: string, path: string): ParseResult {
  const scanned = scan(source, path);
  const empty: FileNode = { kind: 'file', path, version: scanned.version ?? '', records: [], trivia: [] };
  // A refused file reports only its refusal: nothing after line 1 is judged by this version's rules.
  if (scanned.version === undefined) {
    const diagnostics = scanned.diagnostics.filter((d) => d.code === 'IA-LANG-PRAGMA-MISSING');
    return { ast: { ...empty, syntaxDiagnostics: diagnostics, syntaxRecordSpans: [] }, diagnostics };
  }
  if (!SUPPORTED_VERSIONS.includes(scanned.version)) {
    const diagnostics = [
      diag(
        'IA-LANG-VERSION-UNSUPPORTED',
        path,
        1,
        `${path}:1: version ${scanned.version} is not supported; supported: ${SUPPORTED_VERSIONS.join(', ')}`,
      ),
    ];
    return { ast: { ...empty, syntaxDiagnostics: diagnostics, syntaxRecordSpans: [] }, diagnostics };
  }
  const diagnostics: Diagnostic[] = [...scanned.diagnostics];
  const { lines, trailing } = linesOf(scanned.tokens);
  const fileEnd = Math.max(
    1,
    ...lines.map((line) => line.endLine),
    ...diagnostics.map((diagnostic) => diagnostic.endLine ?? diagnostic.line),
  );
  const parser = new Parser(lines, path, fileEnd);
  const records = parser.file();
  diagnostics.push(...parser.diagnostics);
  const trivia = attachTrivia(scanned.trivia, trailing, records);
  diagnostics.sort((a, b) => a.line - b.line);
  const ast: FileNode = {
    kind: 'file',
    path,
    version: scanned.version,
    records,
    trivia,
    ...(diagnostics.length === 0
      ? {}
      : { syntaxDiagnostics: diagnostics, syntaxRecordSpans: parser.recordSpans.sort((a, b) => a.line - b.line) }),
  };
  // Scanner and parser diagnostics interleave by source line, not by which stage found them.
  return { ast, diagnostics };
}
