import { describe, expect, it } from 'vitest';
import { scan } from '../../src/scanner/index.js';

describe('scan', () => {
  it('emits pragma, tokens per line, indent and dedent events, and newlines', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "hi"\n', 'a.ia');
    expect(r.version).toBe('1.0');
    expect(r.tokens.map((t) => t.kind)).toEqual([
      'pragma',
      'sigil',
      'word',
      'newline',
      'indent',
      'word',
      'newline',
      'indent',
      'word',
      'string',
      'newline',
      'dedent',
      'dedent',
    ]);
  });

  it('carries comments as stream tokens and as trivia', () => {
    const r = scan('#! ia 1.0\n# top\n@law x # tail\n', 'a.ia');
    expect(r.tokens.filter((t) => t.kind === 'comment')).toEqual([
      { kind: 'comment', line: 2, text: '# top', trailing: false },
      { kind: 'comment', line: 3, text: '# tail', trailing: true },
    ]);
    expect(r.trivia).toEqual([{ kind: 'comment', line: 2, text: '# top' }]);
  });

  it('collects diagnostics from lines and tokens', () => {
    const r = scan('@law x\n  says "open\n', 'a.ia');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-PRAGMA-MISSING', 'IA-LANG-STRING-UNTERMINATED']);
  });

  it('drops the block beneath a line the tokenizer refuses, unjudged', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "open\n      because "why"\n    next "n"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-STRING-UNTERMINATED', 4]]);
    expect(r.tokens.filter((t) => t.kind === 'word').map((t) => t.value)).toEqual(['x', 'meaning', 'next']);
  });

  it('keeps comment tokens in line order across a dropped block', () => {
    const r = scan(
      '#! ia 1.0\n@law x\n  meaning\n    says "open\n      # inside\n      deeper "d" # trailing\n    next "n"\n',
      'a.ia',
    );
    expect(r.tokens.filter((t) => t.kind === 'comment').map((t) => t.line)).toEqual([5, 6]);
  });

  it('reports line and tokenizer diagnostics in source-line order', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "open\n  lifecycle\n    tags [a,\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-STRING-UNTERMINATED', 4],
      ['IA-LANG-LIST-UNTERMINATED', 6],
    ]);
  });

  it('drops a refused line from the stream entirely', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "open # c\n    answers "q"\n', 'a.ia');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-STRING-UNTERMINATED']);
    expect(r.tokens.filter((t) => t.kind === 'newline').map((t) => t.line)).toEqual([2, 3, 5]);
    expect(r.tokens.some((t) => t.kind === 'string' && t.value === 'q')).toBe(true);
    expect(r.tokens.some((t) => t.kind === 'word' && t.value === 'says')).toBe(false);
  });

  it('emits a list opener comment once, after the list newline and before the next line', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    tags [ # a\n      b,\n    ]\n    says "s"\n', 'a.ia');
    const kinds = r.tokens.map((t) =>
      t.kind === 'comment' ? `comment:${t.text}` : t.kind === 'word' ? `word:${t.value}` : t.kind,
    );
    const at = kinds.indexOf('comment:# a');
    expect(at).toBeGreaterThan(kinds.indexOf('list-close'));
    expect(at).toBeLessThan(kinds.indexOf('word:says'));
    expect(kinds.filter((k) => k === 'comment:# a')).toHaveLength(1);
  });

  it('keeps indent and dedent balanced across a refused line that the next line dedents from', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "open\n  answers "ok"\n', 'a.ia');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-STRING-UNTERMINATED']);
    expect(r.tokens.filter((t) => t.kind === 'indent')).toHaveLength(2);
    expect(r.tokens.filter((t) => t.kind === 'dedent')).toHaveLength(2);
  });

  it('closes every open depth at end of file', () => {
    const r = scan('#! ia 1.0\n@law x\n  meaning\n    says "a"\n', 'a.ia');
    expect(r.tokens.filter((t) => t.kind === 'dedent')).toHaveLength(2);
  });
});
