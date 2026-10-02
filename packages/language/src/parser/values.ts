import type { ItemValue, ListItem, Value } from '../ast.js';
import { diag } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import type { Token } from '../scanner/tokens.js';

export interface SplitField {
  readonly key: string;
  /** The line's words before any string, prose, list or reference, in order; on a scalar line that is every word, the value's included. */
  readonly words: readonly string[];
  readonly value: Value;
  /** The `when` clause as words; a quoted string keeps its quotes so the condition reader can judge it. */
  readonly when?: readonly string[];
  /** Set when the whole line was words in the form `<key> is <value>`. */
  readonly assertive?: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

const DISCRIMINATOR_RE = /^[a-z][a-z0-9-]*$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]*(#[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)*)?$/;

type Ref = Extract<Value, { kind: 'ref' }>;

/** How a diagnostic names a token. Shared with the parser. */
export function spell(t: Token): string {
  switch (t.kind) {
    case 'list-open':
      return '[';
    case 'list-close':
      return ']';
    case 'list-sep':
      return ',';
    case 'string':
    case 'prose':
      return t.raw;
    case 'word':
    case 'sigil':
      return t.value;
  }
}

/** Read `@disc name[#fragment]` from a sigil token and the token after it; `undefined` after a refusal. */
function refFrom(sigil: Token, nameToken: Token | undefined, path: string, diagnostics: Diagnostic[]): Ref | undefined {
  const spelled = sigil.kind === 'sigil' ? sigil.value : '';
  const discriminator = spelled.slice(1);
  if (!DISCRIMINATOR_RE.test(discriminator)) {
    diagnostics.push(
      diag(
        'IA-LANG-REF-MALFORMED',
        path,
        sigil.line,
        `${path}:${sigil.line}: '${spelled}' is not a discriminator; expected @[a-z][a-z0-9-]*`,
      ),
    );
    return undefined;
  }
  const name = nameToken?.kind === 'word' ? nameToken.value : undefined;
  if (name === undefined || !NAME_RE.test(name)) {
    diagnostics.push(
      diag(
        'IA-LANG-REF-MALFORMED',
        path,
        sigil.line,
        `${path}:${sigil.line}: '@${discriminator}' must be followed by a name matching [A-Za-z][A-Za-z0-9-]* with an optional #fragment`,
      ),
    );
    return undefined;
  }
  const hash = name.indexOf('#');
  const bare = hash >= 0 ? name.slice(0, hash) : name;
  const fragment = hash >= 0 ? name.slice(hash + 1) : undefined;
  return {
    kind: 'ref',
    discriminator,
    name: bare,
    ...(fragment === undefined ? {} : { fragment }),
    raw: `@${discriminator} ${name}`,
  };
}

/** Read a list from `tokens[start]` (the `list-open`) to its `list-close`; returns the index after it. */
function listFrom(
  tokens: readonly Token[],
  start: number,
  path: string,
  line: number,
  diagnostics: Diagnostic[],
): { value: Value; next: number } {
  const items: ListItem[] = [];
  let pending: string[] = [];
  let sawItemSinceSep = false;
  let i = start + 1;
  const flush = (): void => {
    if (pending.length > 0) {
      items.push({ kind: 'scalar', text: pending.join(' ') });
      pending = [];
      sawItemSinceSep = true;
    }
  };
  const missingSeparator = (t: Token): void => {
    if (sawItemSinceSep || pending.length > 0)
      diagnostics.push(
        diag('IA-LANG-LIST-MALFORMED', path, t.line, `${path}:${t.line}: missing ',' between list items`),
      );
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    switch (t.kind) {
      case 'list-close':
        flush();
        return { value: { kind: 'list', items }, next: i + 1 };
      case 'list-sep':
        flush();
        if (!sawItemSinceSep)
          diagnostics.push(
            diag('IA-LANG-LIST-MALFORMED', path, t.line, `${path}:${t.line}: empty list item before ','`),
          );
        sawItemSinceSep = false;
        i++;
        continue;
      case 'list-open': {
        diagnostics.push(
          diag('IA-LANG-LIST-MALFORMED', path, t.line, `${path}:${t.line}: a list cannot contain a list`),
        );
        // Skip the nested list to its matching close, and count it as an item, so one mistake yields one diagnostic.
        let nested = 1;
        i++;
        while (i < tokens.length && nested > 0) {
          const k = tokens[i]!.kind;
          if (k === 'list-open') nested++;
          else if (k === 'list-close') nested--;
          i++;
        }
        sawItemSinceSep = true;
        continue;
      }
      case 'string':
        missingSeparator(t);
        flush();
        items.push({ kind: 'string', text: t.value, raw: t.raw });
        sawItemSinceSep = true;
        i++;
        continue;
      case 'prose':
        // The tokenizer refuses prose followed by `]` or `,`, so this is reachable only for a
        // prose token that ends an unclosed list; refuse it the same way rather than drop it.
        diagnostics.push(diag('IA-LANG-PROSE-TRAILING', path, t.line, `${path}:${t.line}: prose is not a list item`));
        sawItemSinceSep = true;
        i++;
        continue;
      case 'sigil': {
        missingSeparator(t);
        flush();
        const ref = refFrom(t, tokens[i + 1], path, diagnostics);
        // A refused ref still counts as the item, so a following ',' is not an empty item.
        sawItemSinceSep = true;
        if (ref !== undefined) {
          items.push(ref);
          i += 2;
          continue;
        }
        // The rest of a refused item is not judged again: skip to the next separator or the close.
        i++;
        let nested = 0;
        while (i < tokens.length) {
          const k = tokens[i]!.kind;
          if (k === 'list-open') nested++;
          else if (k === 'list-close') {
            if (nested === 0) break;
            nested--;
          } else if (k === 'list-sep' && nested === 0) break;
          i++;
        }
        continue;
      }
      case 'word':
        // A word after a string or sigil item, with no separator between, is a second item run together.
        if (sawItemSinceSep && pending.length === 0)
          diagnostics.push(
            diag('IA-LANG-LIST-MALFORMED', path, t.line, `${path}:${t.line}: missing ',' between list items`),
          );
        pending.push(t.value);
        i++;
        continue;
    }
  }
  diagnostics.push(diag('IA-LANG-LIST-UNTERMINATED', path, line, `${path}:${line}: list has no closing ]`));
  flush();
  return { value: { kind: 'list', items }, next: i };
}

/** Read one value starting at `tokens[at]`; returns the value (or `none` after a refused ref) and the index after it. */
function valueAt(
  tokens: readonly Token[],
  at: number,
  path: string,
  line: number,
  diagnostics: Diagnostic[],
): { value: Value; end: number } {
  const t = tokens[at]!;
  switch (t.kind) {
    case 'string':
      return { value: { kind: 'string', text: t.value, raw: t.raw }, end: at + 1 };
    case 'prose':
      return { value: { kind: 'prose', text: t.value, raw: t.raw }, end: at + 1 };
    case 'list-open': {
      const list = listFrom(tokens, at, path, line, diagnostics);
      return { value: list.value, end: list.next };
    }
    case 'sigil': {
      const ref = refFrom(t, tokens[at + 1], path, diagnostics);
      // After a refused ref the rest of the line is not judged again: one mistake, one diagnostic.
      return ref === undefined ? { value: { kind: 'none' }, end: tokens.length } : { value: ref, end: at + 2 };
    }
    case 'word':
    case 'list-sep':
    case 'list-close':
      // A depth-0 `,` or `]` never reaches here from the tokenizer; treat it as trailing.
      return { value: { kind: 'none' }, end: at };
  }
}

function trailing(tokens: readonly Token[], end: number, path: string, diagnostics: Diagnostic[]): void {
  const extra = tokens[end];
  if (extra !== undefined)
    diagnostics.push(
      diag(
        'IA-LANG-VALUE-TRAILING',
        path,
        extra.line,
        `${path}:${extra.line}: unexpected '${spell(extra)}' after the value`,
      ),
    );
}

/** Apply the key rule to a field line's tokens. */
export function splitField(tokens: readonly Token[], path: string, line: number): SplitField {
  const diagnostics: Diagnostic[] = [];

  // `when` is a keyword only at list depth 0, and never as the name token right after a sigil.
  let whenAt = -1;
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'list-open') depth++;
    else if (t.kind === 'list-close') depth--;
    else if (t.kind === 'sigil' && tokens[i + 1]?.kind === 'word') i++;
    else if (depth === 0 && t.kind === 'word' && t.value === 'when') {
      whenAt = i;
      break;
    }
  }
  const body = whenAt >= 0 ? tokens.slice(0, whenAt) : tokens;

  const firstValue = body.findIndex((t) => t.kind !== 'word');
  const words = (firstValue < 0 ? body : body.slice(0, firstValue)).flatMap((t) =>
    t.kind === 'word' ? [t.value] : [],
  );
  let key = words.join(' ');

  if (firstValue >= 0 && key === '') {
    // A value with no key is refused unread, its when clause included: one mistake, one diagnostic.
    const first = body[firstValue]!;
    diagnostics.push(
      diag(
        'IA-LANG-FIELD-KEY-MISSING',
        path,
        first.line,
        `${path}:${first.line}: a field needs a key before its value; found '${spell(first)}'`,
      ),
    );
    return { key, words, value: { kind: 'none' }, diagnostics };
  }

  let when: string[] | undefined;
  if (whenAt >= 0) {
    when = [];
    const clause = tokens.slice(whenAt + 1);
    if (clause.length === 0) {
      diagnostics.push(
        diag(
          'IA-LANG-VALUE-TRAILING',
          path,
          tokens[whenAt]!.line,
          `${path}:${tokens[whenAt]!.line}: 'when' has no condition after it`,
        ),
      );
    }
    for (const t of clause) {
      if (t.kind === 'word' || t.kind === 'sigil') when.push(t.value);
      else if (t.kind === 'string') when.push(t.raw);
      else {
        diagnostics.push(
          diag(
            'IA-LANG-VALUE-TRAILING',
            path,
            t.line,
            `${path}:${t.line}: unexpected '${spell(t)}' in a when clause; a condition is words, quoted strings and references only`,
          ),
        );
        break;
      }
    }
  }

  let value: Value = { kind: 'none' };
  let assertive: boolean | undefined;

  if (firstValue < 0) {
    if (words.length >= 3 && words[1] === 'is') {
      key = words[0] ?? '';
      value = { kind: 'scalar', text: words.slice(2).join(' ') };
      assertive = true;
    } else if (words.length >= 2) {
      key = words[0] ?? '';
      value = { kind: 'scalar', text: words.slice(1).join(' ') };
    }
  } else {
    const read = valueAt(body, firstValue, path, line, diagnostics);
    value = read.value;
    trailing(body, read.end, path, diagnostics);
  }

  return {
    key,
    words,
    value,
    ...(when === undefined ? {} : { when }),
    ...(assertive === undefined ? {} : { assertive }),
    diagnostics,
  };
}

/** The value of a `- value` item line: `tokens` are the tokens after the dash. No key rule, no `is` form, no `when` clause; one list item only. */
export function itemValue(
  tokens: readonly Token[],
  path: string,
  line: number,
): { readonly value: ItemValue; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const first = tokens[0];
  if (first === undefined) {
    diagnostics.push(diag('IA-LANG-LIST-MALFORMED', path, line, `${path}:${line}: an item needs a value after '-'`));
    return { value: { kind: 'none' }, diagnostics };
  }
  if (first.kind === 'word') {
    const wordsEnd = tokens.findIndex((t) => t.kind !== 'word');
    const end = wordsEnd < 0 ? tokens.length : wordsEnd;
    const value: ItemValue = {
      kind: 'scalar',
      text: tokens
        .slice(0, end)
        .flatMap((t) => (t.kind === 'word' ? [t.value] : []))
        .join(' '),
    };
    trailing(tokens, end, path, diagnostics);
    return { value, diagnostics };
  }
  if (first.kind === 'prose' || first.kind === 'list-open') {
    // An item line holds one list item; prose or a list there is refused unread (spec 2.1, 2.4).
    diagnostics.push(
      diag(
        'IA-LANG-LIST-MALFORMED',
        path,
        line,
        `${path}:${line}: an item is a scalar, a string or a reference, not ${first.kind === 'prose' ? 'prose' : 'a list'}`,
      ),
    );
    return { value: { kind: 'none' }, diagnostics };
  }
  const read = valueAt(tokens, 0, path, line, diagnostics);
  const value = read.value;
  // `valueAt` on a string or sigil token yields a string, a reference or `none`; the guard above keeps the rest out.
  if (value.kind === 'prose' || value.kind === 'list' || value.kind === 'block')
    return { value: { kind: 'none' }, diagnostics };
  trailing(tokens, read.end, path, diagnostics);
  return { value, diagnostics };
}
