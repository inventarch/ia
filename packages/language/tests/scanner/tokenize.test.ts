import { describe, expect, it } from 'vitest';
import { tokenizeLine } from '../../src/scanner/tokenize.js';

const kinds = (text: string) => tokenizeLine(text, 'a.ia', 1).tokens.map((t) => t.kind);
const values = (text: string) =>
  tokenizeLine(text, 'a.ia', 1).tokens.map((t) =>
    t.kind === 'string' || t.kind === 'prose' || t.kind === 'word' || t.kind === 'sigil' ? t.value : t.kind,
  );

describe('tokenizeLine', () => {
  it('splits words and a sigil', () => {
    expect(values('cites @law sample-rule')).toEqual(['cites', '@law', 'sample-rule']);
    expect(kinds('cites @law x')).toEqual(['word', 'sigil', 'word']);
  });

  it('reads a quoted string with escapes and keeps its raw form', () => {
    const r = tokenizeLine('says "a \\"q\\" \\\\ b"', 'a.ia', 3);
    expect(r.tokens[1]).toEqual({ kind: 'string', value: 'a "q" \\ b', raw: '"a \\"q\\" \\\\ b"', line: 3, column: 6 });
  });

  it('handles empty and escaped strings exactly', () => {
    const r = tokenizeLine('a "" "\\\\" "\\x"', 'a.ia', 1);
    expect(r.tokens.map((t) => (t.kind === 'string' ? t.value : t.kind))).toEqual(['word', '', '\\', '\\x']);
    expect(tokenizeLine('says "a\\"', 'a.ia', 1).diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-STRING-UNTERMINATED',
    ]);
  });

  it('refuses an unterminated string', () => {
    const r = tokenizeLine('says "open', 'a.ia', 3);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-STRING-UNTERMINATED']);
  });

  it('reads prose, folds it, and refuses text after the closing delimiter', () => {
    const ok = tokenizeLine('says """one\n   two"""', 'a.ia', 1);
    expect(ok.tokens[1]).toMatchObject({ kind: 'prose', value: 'one two' });
    const bad = tokenizeLine('says """x""" tail', 'a.ia', 1);
    expect(bad.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-PROSE-TRAILING']);
  });

  it('handles prose delimiter edge cases', () => {
    expect(tokenizeLine('""""""', 'a.ia', 1).tokens[0]).toMatchObject({ kind: 'prose', value: '' });
    expect(tokenizeLine('""""a"""', 'a.ia', 1).tokens[0]).toMatchObject({ kind: 'prose', value: '"a' });
    expect(tokenizeLine('says """a""""', 'a.ia', 1).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-PROSE-TRAILING']);
    expect(tokenizeLine('says """open', 'a.ia', 1).diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-PROSE-UNTERMINATED',
    ]);
  });

  it('keeps structural words inside a string as content', () => {
    expect(values('says "lowers to body @x"')).toEqual(['says', 'lowers to body @x']);
  });

  it('reads a list with bare, quoted and sigil items and preserves inner whitespace of quoted items', () => {
    const r = tokenizeLine('tags [ a, "b  c", @law d ]', 'a.ia', 1);
    expect(r.tokens.map((t) => t.kind)).toEqual([
      'word',
      'list-open',
      'word',
      'list-sep',
      'string',
      'list-sep',
      'sigil',
      'word',
      'list-close',
    ]);
    const str = r.tokens[4];
    expect(str?.kind === 'string' && str.value).toBe('b  c');
  });

  it('treats a comma or closing bracket outside a list as part of a word', () => {
    expect(
      tokenizeLine('describes Orient, then plan', 'a.ia', 1).tokens.map((t) => (t.kind === 'word' ? t.value : t.kind)),
    ).toEqual(['describes', 'Orient,', 'then', 'plan']);
    expect(tokenizeLine('tags a]', 'a.ia', 1).tokens.map((t) => (t.kind === 'word' ? t.value : t.kind))).toEqual([
      'tags',
      'a]',
    ]);
  });

  it('makes a quote always open a string and a bare @ a sigil', () => {
    expect(
      tokenizeLine('says a"b"', 'a.ia', 1).tokens.map((t) =>
        t.kind === 'string' || t.kind === 'word' ? t.value : t.kind,
      ),
    ).toEqual(['says', 'a', 'b']);
    expect(tokenizeLine('"a"b', 'a.ia', 1).tokens.map((t) => t.kind)).toEqual(['string', 'word']);
    expect(tokenizeLine('cites @', 'a.ia', 1).tokens.map((t) => t.kind)).toEqual(['word', 'sigil']);
    expect(tokenizeLine('x@law', 'a.ia', 1).tokens.map((t) => t.kind)).toEqual(['word']);
    expect(tokenizeLine('tags []', 'a.ia', 1).tokens.map((t) => t.kind)).toEqual(['word', 'list-open', 'list-close']);
  });

  it('records the column of every token', () => {
    const r = tokenizeLine('primary Memory', 'a.ia', 1);
    expect(r.tokens.map((t) => t.column)).toEqual([1, 9]);
  });

  it('tokenizes newline-joined list text the way the scanner emits it', () => {
    const bare = tokenizeLine('tags [\na,\nb\n]', 'a.ia', 1);
    expect(bare.tokens.map((t) => (t.kind === 'word' ? t.value : t.kind))).toEqual([
      'tags',
      'list-open',
      'a',
      'list-sep',
      'b',
      'list-close',
    ]);
    const sigil = tokenizeLine('tags [\n@law d\n]', 'a.ia', 1);
    expect(sigil.tokens.map((t) => (t.kind === 'word' || t.kind === 'sigil' ? t.value : t.kind))).toEqual([
      'tags',
      'list-open',
      '@law',
      'd',
      'list-close',
    ]);
    const open = tokenizeLine('tags [\n"a,\nb",\n]', 'a.ia', 1);
    expect(open.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-STRING-UNTERMINATED']);
  });

  it('refuses prose used as a list item', () => {
    expect(tokenizeLine('tags ["""x"""]', 'a.ia', 1).diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-PROSE-TRAILING',
    ]);
    expect(tokenizeLine('tags [\n"""x""",\ny\n]', 'a.ia', 1).diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-PROSE-TRAILING',
    ]);
    expect(tokenizeLine('says """x"""   ', 'a.ia', 1).diagnostics).toEqual([]);
  });

  it('reports source lines for tokens and diagnostics on continuation lines, and UTF-16 columns within the line', () => {
    const r = tokenizeLine('tags [\na,\nb\n]', 'a.ia', 7);
    expect(r.tokens.map((t) => [t.kind, t.line, t.column])).toEqual([
      ['word', 7, 1],
      ['list-open', 7, 6],
      ['word', 8, 1],
      ['list-sep', 8, 2],
      ['word', 9, 1],
      ['list-close', 10, 1],
    ]);
    expect(tokenizeLine('tags [\n"open,\nb\n]', 'a.ia', 7).diagnostics[0]?.line).toBe(8);
    expect(tokenizeLine('says """a\n  b""" tail', 'a.ia', 3).diagnostics[0]?.line).toBe(4);
    expect(tokenizeLine('😀 x', 'a.ia', 1).tokens[1]?.column).toBe(4);
  });
});
