import { diag } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { parse } from './parser/index.js';
import { scan } from './scanner/index.js';
import type { ScanResult, Token } from './scanner/index.js';

export interface FormatResult {
  readonly text: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

function inventories(scanned: ScanResult): { comments: unknown[]; blanks: number[]; content: unknown[] } {
  return {
    comments: scanned.tokens
      .filter((t) => t.kind === 'comment')
      .map((t) => [t.line, t.text])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    blanks: scanned.trivia.filter((t) => t.kind === 'blank').map((t) => t.line),
    content: scanned.tokens.flatMap((t) => {
      switch (t.kind) {
        case 'comment':
        case 'indent':
        case 'dedent':
          return [];
        case 'pragma':
          return [[t.kind, t.version]];
        case 'newline':
          return [[t.kind, t.line, t.endLine, t.depth]];
        case 'word':
        case 'sigil':
          return [[t.kind, t.line, t.value]];
        case 'string':
        case 'prose':
          return [[t.kind, t.line, t.value, t.raw]];
        default:
          return [[t.kind, t.line]];
      }
    }),
  };
}

/** A host may reuse this guard before writing a candidate. It verifies preservation, not registry validity. */
export function checkFormatPreservation(source: string, output: string, path: string): readonly Diagnostic[] {
  const input = scan(source, path);
  const candidate = scan(output, path);
  const before = inventories(input);
  const after = inventories(candidate);
  const changed = (['comments', 'blanks', 'content'] as const).find(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (input.diagnostics.length === 0 && candidate.diagnostics.length === 0 && changed === undefined) return [];
  return [
    diag(
      'IA-LANG-FORMAT-LOSSY',
      path,
      1,
      `${path}: formatting changed ${changed ?? 'scanner validity'}; no output may be written`,
    ),
  ];
}

/** Scanner-driven whitespace formatting. Multiline values and physical trivia positions stay intact. */
export function format(source: string, path: string): FormatResult {
  const parsed = parse(source, path);
  if (parsed.diagnostics.length > 0) return { text: null, diagnostics: parsed.diagnostics };
  const scanned = scan(source, path);
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let pending: Token[] = [];
  let comment: Extract<ScanResult['tokens'][number], { kind: 'comment' }> | undefined;
  for (const token of scanned.tokens) {
    switch (token.kind) {
      case 'pragma':
        lines[0] = `#! ia ${token.version}`;
        break;
      case 'indent':
      case 'dedent':
        break;
      case 'comment':
        if (token.trailing) comment = token;
        break;
      case 'newline': {
        // Preserve scanner-owned raw multiline layout, including list comments on any physical line.
        if (token.line === token.endLine)
          lines[token.line - 1] =
            `${'  '.repeat(token.depth)}${render(pending)}${comment?.line === token.line ? ` ${comment.text}` : ''}`;
        pending = [];
        comment = undefined;
        break;
      }
      default:
        pending.push(token);
    }
  }
  const text = `${lines.join('\n')}\n`;
  const diagnostics = checkFormatPreservation(source, text, path);
  return { text: diagnostics.length === 0 ? text : null, diagnostics };
}

function render(tokens: readonly Token[]): string {
  let output = '';
  let previous: Token | undefined;
  for (const token of tokens) {
    const text =
      token.kind === 'string' || token.kind === 'prose'
        ? token.raw
        : token.kind === 'list-open'
          ? '['
          : token.kind === 'list-close'
            ? ']'
            : token.kind === 'list-sep'
              ? ','
              : token.value;
    const space =
      previous !== undefined &&
      token.kind !== 'list-close' &&
      token.kind !== 'list-sep' &&
      previous.kind !== 'list-open';
    output += `${space ? ' ' : ''}${text}`;
    previous = token;
  }
  return output;
}
