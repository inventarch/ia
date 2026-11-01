import { describe, expect, it } from 'vitest';
import { BudgetExceeded, WORK_COST, WorkBudget } from '../../src/bounded.js';
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

  it('keeps every token of a line longer than one call can take as arguments', () => {
    const words = 150_000;
    const { tokens, diagnostics } = scan(`#! ia 1.0\n@a b\n  k ${'w '.repeat(words)}\n`, 'a.ia');
    expect(diagnostics).toEqual([]);
    expect(tokens.filter((t) => t.kind === 'word' && t.value === 'w')).toHaveLength(words);
  });

  it('stops at its budget, spending one past it', () => {
    const budget = new WorkBudget(1_000);
    expect(() => scan(`#! ia 1.0\n@a b\n  k ${'w '.repeat(1_000_000)}\n`, 'a.ia', budget)).toThrow(BudgetExceeded);
    expect(budget.spent()).toBe(1_001);
  });

  it.each([
    ['blank lines', '\n'.repeat(5_000)],
    ['comment lines', '# c\n'.repeat(5_000)],
    ['lines dropped beneath a refused line', `\tx\n${'\t\t# c\n'.repeat(5_000)}`],
    ['lines of a multi-line value', `@a b\n  k """\n${'    prose\n'.repeat(5_000)}  """\n`],
    ['lines of a multi-line list', `@a b\n  k [\n${'    a,\n'.repeat(5_000)}  ]\n`],
    ['steps of indentation', `@a b\n${`${'  '.repeat(2_000)}k\nx\n`.repeat(5)}`],
  ])('charges %s as they are read', (_name, body) => {
    const budget = new WorkBudget(1_000);
    expect(() => scan(`#! ia 1.0\n${body}`, 'a.ia', budget)).toThrow(expect.objectContaining({ limit: 1_000 }));
  });

  it('charges every step of indentation, in and out', () => {
    const spent = (body: string) => {
      const budget = new WorkBudget(1_000_000);
      scan(`#! ia 1.0\n${body}`, 'a.ia', budget);
      return budget.spent();
    };
    const stepped = Array.from({ length: 100 }, (_, depth) => `${'  '.repeat(depth)}k\n`).join('');
    expect(spent(`${stepped}x\n`)).toBe(spent(`${'k\n'.repeat(100)}x\n`) + 2 * 99 * WORK_COST.token);
  });

  it('charges a long value for its length', () => {
    const value = (text: string) => {
      const budget = new WorkBudget(1_000_000);
      scan(`#! ia 1.0\n@a b\n  k ${text}\n`, 'a.ia', budget);
      return budget.spent();
    };
    const short = value('"v"');
    expect(value(`"${'v'.repeat(80_000)}"`)).toBe(short + 10_000);
    expect(value('v'.repeat(80_000))).toBe(short + 10_000);
    expect(value(`"""${'v'.repeat(79_994)}"""`)).toBe(short + 10_000);
  });

  it('charges every token of a list', () => {
    const budget = new WorkBudget(1_000);
    expect(() => scan(`#! ia 1.0\n@a b\n  k [${','.repeat(5_000)}]\n`, 'a.ia', budget)).toThrow(BudgetExceeded);
  });

  it('charges the diagnostics it reports, not only their lines', () => {
    const spent = (body: string) => {
      const budget = new WorkBudget(1_000_000);
      scan(`#! ia 1.0\n${body}`, 'a.ia', budget);
      return budget.spent();
    };
    expect(spent(' x\n'.repeat(100)) - spent('# x\n'.repeat(100))).toBeGreaterThanOrEqual(100 * WORK_COST.diagnostic);
  });

  it('charges a diagnostic once more for every 64 characters of its message', () => {
    const budget = new WorkBudget(1_000_000);
    budget.diagnostic(0);
    expect(budget.spent()).toBe(WORK_COST.diagnostic);
    budget.diagnostic(640);
    expect(budget.spent()).toBe(2 * WORK_COST.diagnostic + 10);
  });

  it('produces what an unbudgeted scan produces', () => {
    const text = '#! ia 1.0\n# note\n@law x\n  k "v" # trailing\n  list [a, @law y]\n  p """\n    prose\n  """\n';
    expect(scan(text, 'a.ia', new WorkBudget(1_000))).toEqual(scan(text, 'a.ia'));
  });

  it('reads a long prose value in time that grows with it', () => {
    const lines = 100_000,
      { tokens, diagnostics } = scan(`#! ia 1.0\n@a b\n  k """\n${'    prose\n'.repeat(lines)}  """\n`, 'a.ia');
    expect(diagnostics).toEqual([]);
    expect(tokens.find((t) => t.kind === 'prose')).toMatchObject({ kind: 'prose' });
  });
});
