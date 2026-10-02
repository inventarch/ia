import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { foldProse } from '../fold.js';
import type { Token } from './tokens.js';

export interface TokenizeResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Characters that end a word everywhere: whitespace (including the `\n` the scanner joins list lines with), a quote, an opening bracket. */
const WORD_END_ALWAYS: ReadonlySet<string> = new Set([' ', '\t', '\n', '"', '[']);
/** Characters that end a word only inside a list. Outside one they are ordinary content. */
const WORD_END_IN_LIST: ReadonlySet<string> = new Set([',', ']']);

/** Tokenize one logical line. `line` is the line's first source line. */
export function tokenizeLine(text: string, path: string, line: number): TokenizeResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = text.length;
  let i = 0;
  let lineNo = line; // source line of position i
  let lineStart = 0; // index in `text` where the current source line begins
  let depth = 0; // open lists
  const column = (at: number): number => at - lineStart + 1;
  const advancePastNewlines = (raw: string, start: number): void => {
    let nl = raw.indexOf('\n');
    while (nl >= 0) {
      lineNo++;
      lineStart = start + nl + 1;
      nl = raw.indexOf('\n', nl + 1);
    }
  };

  while (i < n) {
    const ch = text[i] ?? '';
    if (ch === '\n') {
      lineNo++;
      lineStart = i + 1;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    const col = column(i);

    if (text.startsWith('"""', i)) {
      const close = text.indexOf('"""', i + 3);
      if (close < 0) {
        // Reachable only by direct callers: the scanner refuses an unterminated span before this runs.
        diagnostics.push(
          diag('IA-LANG-PROSE-UNTERMINATED', path, lineNo, `${path}:${lineNo}: prose value has no closing """`),
        );
        return { tokens, diagnostics };
      }
      const raw = text.slice(i, close + 3);
      tokens.push({ kind: 'prose', value: foldProse(text.slice(i + 3, close)), raw, line: lineNo, column: col });
      advancePastNewlines(raw, i);
      i = close + 3;
      // Only whitespace may follow (the scanner already removed any comment). A `]` or `,`
      // here means prose was used as a list item, which the grammar does not allow.
      const rest = text.slice(i).trim();
      if (rest !== '') {
        diagnostics.push(
          diag(
            'IA-LANG-PROSE-TRAILING',
            path,
            lineNo,
            `${path}:${lineNo}: only whitespace or a comment may follow a closing """; found '${rest}'`,
          ),
        );
        return { tokens, diagnostics };
      }
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const c = text[j] ?? '';
        if (c === '\\') {
          const next = text[j + 1];
          if (next === '"' || next === '\\') {
            value += next;
            j += 2;
            continue;
          }
          value += c;
          j++;
          continue;
        }
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        if (c === '\n') break;
        value += c;
        j++;
      }
      if (!closed) {
        diagnostics.push(
          diag('IA-LANG-STRING-UNTERMINATED', path, lineNo, `${path}:${lineNo}: string has no closing quote`),
        );
        return { tokens, diagnostics };
      }
      tokens.push({ kind: 'string', value, raw: text.slice(i, j), line: lineNo, column: col });
      i = j;
      continue;
    }

    if (ch === '[') {
      depth++;
      tokens.push({ kind: 'list-open', line: lineNo, column: col });
      i++;
      continue;
    }
    if (depth > 0 && ch === ']') {
      depth--;
      tokens.push({ kind: 'list-close', line: lineNo, column: col });
      i++;
      continue;
    }
    if (depth > 0 && ch === ',') {
      tokens.push({ kind: 'list-sep', line: lineNo, column: col });
      i++;
      continue;
    }

    let j = i;
    while (j < n) {
      const c = text[j] ?? '';
      if (WORD_END_ALWAYS.has(c) || (depth > 0 && WORD_END_IN_LIST.has(c))) break;
      j++;
    }
    const word = text.slice(i, j);
    tokens.push(
      word.startsWith('@')
        ? { kind: 'sigil', value: word, line: lineNo, column: col }
        : { kind: 'word', value: word, line: lineNo, column: col },
    );
    i = j;
  }
  return { tokens, diagnostics };
}
