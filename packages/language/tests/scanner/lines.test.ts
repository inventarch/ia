import { describe, expect, it } from 'vitest';
import { logicalLines, trailingCommentIndex } from '../../src/scanner/lines.js';

const codes = (r: ReturnType<typeof logicalLines>) => r.diagnostics.map((d) => d.code);

describe('logicalLines', () => {
  it('reads the pragma and strips it from the lines', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n', 'a.ia');
    expect(r.version).toBe('1.0');
    expect(r.lines.map((l) => [l.line, l.depth, l.text])).toEqual([[2, 0, '@law x']]);
    expect(r.diagnostics).toEqual([]);
  });

  it('refuses a missing pragma at line 1', () => {
    const r = logicalLines('@law x\n', 'a.ia');
    expect(r.version).toBeUndefined();
    expect(codes(r)).toEqual(['IA-LANG-PRAGMA-MISSING']);
    expect(r.diagnostics[0]?.line).toBe(1);
  });

  it('passes an unsupported-looking version through for the parser to judge', () => {
    expect(logicalLines('#! ia 1.0.1\n', 'a.ia').version).toBe('1.0.1');
    expect(logicalLines('#! ia 01.0\n', 'a.ia').version).toBe('01.0');
  });

  it('requires the pragma to be exactly "#! ia " plus the version, allowing trailing whitespace', () => {
    expect(codes(logicalLines('#!ia 1.0\n', 'a.ia'))).toEqual(['IA-LANG-PRAGMA-MISSING']);
    expect(codes(logicalLines('#!  ia 1.0\n', 'a.ia'))).toEqual(['IA-LANG-PRAGMA-MISSING']);
    expect(logicalLines('#! ia 1.0   \n', 'a.ia').version).toBe('1.0');
  });

  it('ignores a leading byte-order mark', () => {
    const r = logicalLines('﻿#! ia 1.0\n@law x\n', 'a.ia');
    expect(r.version).toBe('1.0');
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x']);
  });

  it('refuses a tab in indentation and drops the line', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n\tmeaning\n', 'a.ia');
    expect(codes(r)).toEqual(['IA-LANG-INDENT-TAB']);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x']);
  });

  it('refuses odd indentation and measures depth without judging it', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n   meaning\n', 'a.ia');
    expect(codes(r)).toEqual(['IA-LANG-INDENT-STEP']);
    const r2 = logicalLines('#! ia 1.0\n@law x\n    says "deep"\n      deeper "x"\n', 'a.ia');
    expect(codes(r2)).toEqual([]);
    expect(r2.lines.map((l) => [l.text, l.depth])).toEqual([
      ['@law x', 0],
      ['says "deep"', 2],
      ['deeper "x"', 3],
    ]);
  });

  it('keeps whole-line comments and blank lines as trivia with their line numbers', () => {
    const r = logicalLines('#! ia 1.0\n# leading\n\n@law x\n  # inside\n  meaning\n', 'a.ia');
    expect(r.trivia).toEqual([
      { kind: 'comment', line: 2, text: '# leading' },
      { kind: 'blank', line: 3 },
      { kind: 'comment', line: 5, text: '# inside' },
    ]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning']);
  });

  it('applies the indentation rules to comment lines', () => {
    const odd = logicalLines('#! ia 1.0\n@law x\n   # odd\n', 'a.ia');
    expect(codes(odd)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(odd.trivia).toEqual([]);
    const ok = logicalLines('#! ia 1.0\n@law x\n  # fine\n    says "s"\n', 'a.ia');
    expect(codes(ok)).toEqual([]);
    expect(ok.trivia).toEqual([{ kind: 'comment', line: 3, text: '# fine' }]);
    expect(ok.lines.map((l) => l.text)).toEqual(['@law x', 'says "s"']);
  });

  it('drops the block beneath a line it refuses, unjudged, and keeps its comments as trivia', () => {
    const tab = logicalLines('#! ia 1.0\n@law x\n\tmeaning\n    says "a\n    # note\n  other\n', 'a.ia');
    expect(codes(tab)).toEqual(['IA-LANG-INDENT-TAB']);
    expect(tab.lines.map((l) => l.text)).toEqual(['@law x', 'other']);
    expect(tab.trivia).toEqual([{ kind: 'comment', line: 5, text: '# note' }]);
    const odd = logicalLines('#! ia 1.0\n@law x\n   meaning\n      says "a\n  other\n', 'a.ia');
    expect(codes(odd)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(odd.lines.map((l) => l.text)).toEqual(['@law x', 'other']);
  });

  it('drops a multi-line value that opens inside a dropped block, closer included, and never judges it', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n   odd "o"\n      says """a\n  b"""\n      tags [a,\n  b]\n  other\n',
      'a.ia',
    );
    expect(codes(r)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'other']);
    const open = logicalLines('#! ia 1.0\n@law x\n\tmeaning\n    says """never closed\n', 'a.ia');
    expect(codes(open)).toEqual(['IA-LANG-INDENT-TAB']);
  });

  it('keeps every comment inside a dropped block as trivia', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n   odd "o"\n      deep "d" # trailing\n      tags [a, # one\n  b] # two\n      says """a\n  b""" # note\n  other\n',
      'a.ia',
    );
    expect(codes(r)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(r.trivia.map((t) => (t.kind === 'comment' ? [t.line, t.text] : t.kind))).toEqual([
      [4, '# trailing'],
      [5, '# one'],
      [6, '# two'],
      [8, '# note'],
    ]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'other']);
  });

  it('keeps every line at or above one level past the last accepted line after a shallow refused line', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n  meaning\n    says "a"\n one "x"\n  lifecycle\n    state active\n',
      'a.ia',
    );
    expect(codes(r)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'says "a"', 'lifecycle', 'state active']);
    const ambient = logicalLines(
      '#! ia 1.0\n@law x\n  meaning\n    says "a"\n oops\n    next "n"\n    later "l"\n  lifecycle\n    state active\n',
      'a.ia',
    );
    expect(codes(ambient)).toEqual(['IA-LANG-INDENT-STEP']);
    expect(ambient.lines.map((l) => l.text)).toEqual([
      '@law x',
      'meaning',
      'says "a"',
      'next "n"',
      'later "l"',
      'lifecycle',
      'state active',
    ]);
  });

  it('drops the tab-indented block beneath a tab-indented line, and only that', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n  first "f"\n\tstray "s"\n\t\tkid "k"\n    space "p"\n  next "n"\n',
      'a.ia',
    );
    expect(codes(r)).toEqual(['IA-LANG-INDENT-TAB']);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'first "f"', 'space "p"', 'next "n"']);
  });

  it('splits a trailing comment outside a string and keeps a # inside a string', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    says "a # b" # note\n', 'a.ia');
    const last = r.lines[2];
    expect(last?.text).toBe('says "a # b"');
    expect(last?.trailingComment).toBe('# note');
  });

  it('treats a # right after a closing quote or bracket as a comment, and one inside a word as content', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n  meaning\n    says "x"# c\n    tags [a]# d\n    cites @contract y#REQ-1\n',
      'a.ia',
    );
    expect(r.lines.map((l) => [l.text, l.trailingComment])).toEqual([
      ['@law x', undefined],
      ['meaning', undefined],
      ['says "x"', '# c'],
      ['tags [a]', '# d'],
      ['cites @contract y#REQ-1', undefined],
    ]);
  });

  it('joins a multi-line prose value into one logical line and records its end line', () => {
    const src = '#! ia 1.0\n@law x\n  meaning\n    says """one\n      two\n\n      three"""\n  lifecycle\n';
    const r = logicalLines(src, 'a.ia');
    const says = r.lines[2];
    expect(says?.line).toBe(4);
    expect(says?.endLine).toBe(7);
    expect(says?.text).toBe('says """one\n      two\n\n      three"""');
    expect(r.lines[3]?.text).toBe('lifecycle');
    expect(r.trivia).toEqual([]);
  });

  it('refuses an unterminated prose value', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    says """open\n', 'a.ia');
    expect(codes(r)).toEqual(['IA-LANG-PROSE-UNTERMINATED']);
  });

  it('does not let a """ inside a trailing comment open a span', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    says x # note """\n  lifecycle\n@law y\n', 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'says x', 'lifecycle', '@law y']);
    expect(r.lines[2]?.trailingComment).toBe('# note """');
  });

  it('joins a multi-line list into one logical line and preserves whitespace inside quoted items', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    tags [\n      a,\n      "b  c",\n    ]\n', 'a.ia');
    expect(r.lines[2]?.text).toBe('tags [\na,\n"b  c",\n]');
    expect(r.lines[2]?.endLine).toBe(7);
  });

  it('keeps list continuation lines separate so a string cannot span two of them', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n  meaning\n    tags [\n      "a,\n      b",\n    ]\n  lifecycle\n',
      'a.ia',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'tags [\n"a,\nb",\n]', 'lifecycle']);
  });

  it('keeps comments on list lines as trivia and never as list content', () => {
    const src =
      '#! ia 1.0\n@law x\n  meaning\n    tags [ # opener\n      a, # first\n      # closing ] later\n      b,\n    ] # closer\n  lifecycle\n';
    const r = logicalLines(src, 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'tags [\na,\n\nb,\n]', 'lifecycle']);
    expect(r.lines[2]?.endLine).toBe(8);
    expect(r.trivia).toEqual([
      { kind: 'comment', line: 4, text: '# opener' },
      { kind: 'comment', line: 5, text: '# first' },
      { kind: 'comment', line: 6, text: '# closing ] later' },
      { kind: 'comment', line: 8, text: '# closer' },
    ]);
  });

  it('refuses an unterminated list', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    tags [\n      a,\n', 'a.ia');
    expect(codes(r)).toEqual(['IA-LANG-LIST-UNTERMINATED']);
  });

  it('never opens a list span from a line that ends inside a string', () => {
    const r = logicalLines('#! ia 1.0\n@law x\n  meaning\n    tags ["a, b]\n  lifecycle\n@law y\n', 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'tags ["a, b]', 'lifecycle', '@law y']);
  });

  it('resets string state at each list continuation line so a bad quote cannot swallow the file', () => {
    const r = logicalLines(
      '#! ia 1.0\n@law x\n  meaning\n    tags [\n      "a,\n      b,\n    ]\n  lifecycle\n',
      'a.ia',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'tags [\n"a,\nb,\n]', 'lifecycle']);
  });

  it('accepts CRLF line endings, including inside a prose span', () => {
    const r = logicalLines('#! ia 1.0\r\n@law x\r\n  meaning\r\n    says """a\r\n      b"""\r\n', 'a.ia');
    expect(r.lines.map((l) => l.text)).toEqual(['@law x', 'meaning', 'says """a\n      b"""']);
  });
});

describe('trailingCommentIndex', () => {
  it('finds a comment only outside strings and prose, after whitespace, a quote, a bracket or a comma', () => {
    expect(trailingCommentIndex('says "a" # b')).toBe(9);
    expect(trailingCommentIndex('says "x"# c')).toBe(8);
    expect(trailingCommentIndex('tags [a]# c')).toBe(8);
    expect(trailingCommentIndex('tags [a,# c')).toBe(8);
    expect(trailingCommentIndex('says "a\\" # b"')).toBe(-1);
    expect(trailingCommentIndex('says """one # two')).toBe(-1);
    expect(trailingCommentIndex('says """a " b""" # c')).toBe(17);
    expect(trailingCommentIndex('cites @law x#frag')).toBe(-1);
    expect(trailingCommentIndex('# whole')).toBe(0);
  });
});
