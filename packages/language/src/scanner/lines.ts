import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';

export interface LogicalLine {
  /** 1-based first source line. */
  readonly line: number;
  /** 1-based last source line (equals `line` unless a prose or list span was joined). */
  readonly endLine: number;
  /** indent / 2 */
  readonly depth: number;
  /** Indentation stripped, trailing comment stripped, spans joined. */
  readonly text: string;
  /** A ` # ...` comment that followed content on the same line, if any. Comments on multi-line list lines go to trivia instead. */
  readonly trailingComment?: string;
}

export type Trivia =
  | { readonly kind: 'comment'; readonly line: number; readonly text: string }
  | { readonly kind: 'blank'; readonly line: number };

export interface LinesResult {
  readonly version?: string;
  readonly lines: readonly LogicalLine[];
  readonly trivia: readonly Trivia[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Exactly `#! ia <version>` with single spaces; the version's validity is the parser's judgement, not the scanner's. */
const PRAGMA_RE = /^#! ia (\S+)\s*$/;

/** A `#` begins a comment when preceded by one of these (or when it is the first character). */
const COMMENT_PRECEDERS: ReadonlySet<string> = new Set([' ', '\t', '"', ']', ',']);

export interface Walk {
  /** Index of the `#` that begins a trailing comment, or -1. Scanning stops there. */
  readonly commentAt: number;
  /** Net `[` minus `]` outside strings, prose and the comment. */
  readonly bracketDelta: number;
  /** True when the text ends inside an unclosed `"..."`. */
  readonly endsInString: boolean;
  /** True when the text ends inside an unclosed `"""`. */
  readonly endsInProse: boolean;
}

/**
 * One quote-aware pass over a line, or over a joined span. This is the only place in the
 * package that knows how `"`, `"""`, `[`, `]` and `#` interact.
 */
export function walk(text: string): Walk {
  let inString = false;
  let inProse = false;
  let bracketDelta = 0;
  let commentAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inProse) {
      if (text.startsWith('"""', i)) {
        inProse = false;
        i += 2;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (text.startsWith('"""', i)) {
      inProse = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '#' && (i === 0 || COMMENT_PRECEDERS.has(text[i - 1] ?? ''))) {
      commentAt = i;
      break;
    }
    if (ch === '[') bracketDelta++;
    else if (ch === ']') bracketDelta--;
  }
  return { commentAt, bracketDelta, endsInString: inString, endsInProse: inProse };
}

/** Index of a trailing comment's `#`, or -1. */
export function trailingCommentIndex(text: string): number {
  return walk(text).commentAt;
}

/** A multi-line value being joined. A `dropped` span lies inside a refused block: it is consumed and never emitted. */
type Span =
  | {
      readonly kind: 'prose';
      readonly line: number;
      readonly depth: number;
      readonly parts: string[];
      readonly dropped: boolean;
    }
  | {
      readonly kind: 'list';
      readonly line: number;
      readonly depth: number;
      readonly parts: string[];
      balance: number;
      readonly dropped: boolean;
    };

export function logicalLines(source: string, path: string): LinesResult {
  const diagnostics: Diagnostic[] = [];
  const lines: LogicalLine[] = [];
  const trivia: Trivia[] = [];
  const raw = (source.startsWith('﻿') ? source.slice(1) : source).split(/\r?\n/);
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();

  let version: string | undefined;
  const pragma = PRAGMA_RE.exec(raw[0] ?? '');
  if (pragma === null) {
    diagnostics.push(
      diag('IA-LANG-PRAGMA-MISSING', path, 1, `${path}: line 1 must be the pragma '#! ia <major>.<minor>'`),
    );
  } else {
    version = pragma[1];
  }

  let span: Span | null = null;
  // Depth of the last accepted line, and the drop in force after a tab or odd-indentation refusal: a refused
  // line's block produces nothing and is not judged. Widths are columns, a tab counting as one depth.
  let lastDepth = 0;
  let drop: { readonly widerThan: number; readonly tabWidth: number | undefined } | undefined;

  for (let index = pragma === null ? 0 : 1; index < raw.length; index++) {
    const lineNo = index + 1;
    const rawLine = raw[index] ?? '';

    if (span !== null && span.kind === 'prose') {
      span.parts.push(rawLine);
      const joined = span.parts.join('\n');
      const w = walk(joined);
      if (!w.endsInProse) {
        if (span.dropped) {
          // A dropped prose value's closer line: its comment stays trivia, and a list it opens is dropped too.
          if (w.commentAt >= 0)
            trivia.push({ kind: 'comment', line: lineNo, text: joined.slice(w.commentAt).trimEnd() });
          span =
            !w.endsInString && w.bracketDelta > 0
              ? { kind: 'list', line: lineNo, depth: 0, parts: [], balance: w.bracketDelta, dropped: true }
              : null;
        } else {
          const text = (w.commentAt >= 0 ? joined.slice(0, w.commentAt) : joined).trimEnd();
          lines.push({
            line: span.line,
            endLine: lineNo,
            depth: span.depth,
            text,
            ...(w.commentAt >= 0 ? { trailingComment: joined.slice(w.commentAt) } : {}),
          });
          span = null;
        }
      }
      continue;
    }

    if (span !== null) {
      // List continuation lines are layout-free: the formatter re-indents them, so they are
      // not indentation-checked. Comments on them are trivia at their own lines.
      const trimmed = rawLine.trim();
      if (trimmed === '') {
        trivia.push({ kind: 'blank', line: lineNo });
        span.parts.push('');
        continue;
      }
      if (trimmed.startsWith('#')) {
        trivia.push({ kind: 'comment', line: lineNo, text: trimmed });
        span.parts.push('');
        continue;
      }
      const w = walk(trimmed);
      if (w.commentAt >= 0) trivia.push({ kind: 'comment', line: lineNo, text: trimmed.slice(w.commentAt) });
      const code = (w.commentAt >= 0 ? trimmed.slice(0, w.commentAt) : trimmed).trimEnd();
      span.parts.push(code);
      span.balance += w.bracketDelta;
      if (span.balance <= 0) {
        // Joined with newlines, not spaces: a `"` left open on one line must not be closed
        // by a `"` on the next, and the tokenizer ends a string at a newline.
        if (!span.dropped)
          lines.push({ line: span.line, endLine: lineNo, depth: span.depth, text: span.parts.join('\n') });
        span = null;
      }
      continue;
    }

    if (rawLine.trim() === '') {
      trivia.push({ kind: 'blank', line: lineNo });
      continue;
    }

    const indentText = /^[ \t]*/.exec(rawLine)?.[0] ?? '';
    const content = rawLine.slice(indentText.length).trimEnd();
    const width = indentText.length + indentText.split('\t').length - 1;
    if (drop !== undefined) {
      if (
        width > drop.widerThan ||
        (drop.tabWidth !== undefined && width > drop.tabWidth && indentText.includes('\t'))
      ) {
        if (content.startsWith('#')) {
          trivia.push({ kind: 'comment', line: lineNo, text: content });
          continue;
        }
        // A dropped line's comment stays trivia; a dropped line that opens a multi-line value takes its continuation lines with it.
        const dropped = walk(content);
        if (dropped.commentAt >= 0)
          trivia.push({ kind: 'comment', line: lineNo, text: content.slice(dropped.commentAt) });
        if (dropped.endsInProse) span = { kind: 'prose', line: lineNo, depth: 0, parts: [content], dropped: true };
        else if (!dropped.endsInString && dropped.bracketDelta > 0)
          span = { kind: 'list', line: lineNo, depth: 0, parts: [], balance: dropped.bracketDelta, dropped: true };
        continue;
      }
      drop = undefined;
    }
    if (indentText.includes('\t') || indentText.length % 2 !== 0) {
      diagnostics.push(
        indentText.includes('\t')
          ? diag('IA-LANG-INDENT-TAB', path, lineNo, `${path}:${lineNo}: tab in indentation; use two spaces per depth`)
          : diag(
              'IA-LANG-INDENT-STEP',
              path,
              lineNo,
              `${path}:${lineNo}: indentation of ${indentText.length} is not a multiple of two`,
            ),
      );
      // The refused line's depth is unknowable, so its block is every following line deeper than one level past
      // the last accepted line, which the parser would refuse as a jump; after a tab, every following tab-indented
      // line wider than it as well, since a tab-indented parent has tab-indented children.
      drop = { widerThan: 2 * (lastDepth + 1), tabWidth: indentText.includes('\t') ? width : undefined };
      continue;
    }
    // Depth is structural: the parser judges how far a line may step in; the scanner only measures it.
    const depth = indentText.length / 2;

    // A comment line obeys the indentation rules above.
    if (content.startsWith('#')) {
      trivia.push({ kind: 'comment', line: lineNo, text: content });
      continue;
    }
    lastDepth = depth;

    const w = walk(content);
    const text = (w.commentAt >= 0 ? content.slice(0, w.commentAt) : content).trimEnd();
    const trailingComment = w.commentAt >= 0 ? content.slice(w.commentAt) : undefined;

    // The walk stopped at the comment, so a `"""` inside the comment cannot open a span.
    if (w.endsInProse) {
      span = { kind: 'prose', line: lineNo, depth, parts: [content], dropped: false };
      continue;
    }

    // A line that ends inside a string never opens a list; Task 4's tokenizer refuses the string.
    if (!w.endsInString && w.bracketDelta > 0) {
      if (trailingComment !== undefined) trivia.push({ kind: 'comment', line: lineNo, text: trailingComment });
      span = { kind: 'list', line: lineNo, depth, parts: [text], balance: w.bracketDelta, dropped: false };
      continue;
    }

    lines.push({
      line: lineNo,
      endLine: lineNo,
      depth,
      text,
      ...(trailingComment === undefined ? {} : { trailingComment }),
    });
  }

  if (span !== null && !span.dropped) {
    const code = span.kind === 'prose' ? 'IA-LANG-PROSE-UNTERMINATED' : 'IA-LANG-LIST-UNTERMINATED';
    diagnostics.push(
      diag(
        code,
        path,
        span.line,
        `${path}:${span.line}: ${span.kind === 'prose' ? 'prose value has no closing """' : 'list has no closing ]'}`,
      ),
    );
  }

  return { ...(version === undefined ? {} : { version }), lines, trivia, diagnostics };
}
