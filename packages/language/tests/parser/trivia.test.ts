import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';

describe('parse: trivia', () => {
  it('attaches leading comments and blank lines to the record that follows', () => {
    const r = parse('#! ia 1.0\n# one\n\n@law a\n  meaning\n    says "s"\n# two\n@law b\n', 'a.ia');
    expect(r.ast.trivia).toEqual([
      { kind: 'comment', line: 2, text: '# one', attachedTo: 0, trailing: false },
      { kind: 'blank', line: 3, attachedTo: 0, trailing: false },
      { kind: 'comment', line: 7, text: '# two', attachedTo: 1, trailing: false },
    ]);
  });

  it('attaches a trailing-of-file comment to the file', () => {
    const r = parse('#! ia 1.0\n@law a\n# end\n', 'a.ia');
    expect(r.ast.trivia).toEqual([{ kind: 'comment', line: 3, text: '# end', attachedTo: 'file', trailing: false }]);
  });

  it('keeps a same-line trailing comment with trailing true, attached to its record', () => {
    const r = parse('#! ia 1.0\n@law a\n  meaning # here\n', 'a.ia');
    expect(r.ast.trivia).toEqual([{ kind: 'comment', line: 3, text: '# here', attachedTo: 0, trailing: true }]);
  });

  it('attaches a header-line trailing comment to that record, and file-only trivia to the file', () => {
    const r = parse('#! ia 1.0\n@law a # here\n', 'a.ia');
    expect(r.ast.trivia).toEqual([{ kind: 'comment', line: 2, text: '# here', attachedTo: 0, trailing: true }]);
    const only = parse('#! ia 1.0\n# one\n\n# two\n', 'a.ia');
    expect(only.ast.records).toEqual([]);
    expect(only.ast.trivia.map((t) => t.attachedTo)).toEqual(['file', 'file', 'file']);
  });

  it('keeps a trailing comment inside a block the tokenizer dropped as trivia', () => {
    const r = parse('#! ia 1.0\n@law x\n  meaning\n    says "open\n      child "c" # note\n    next "n"\n', 'a.ia');
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-STRING-UNTERMINATED', 4]]);
    expect(r.ast.trivia).toEqual([{ kind: 'comment', line: 5, text: '# note', attachedTo: 0, trailing: false }]);
  });
});
