import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { readVariants } from '../../src/semantic/variants.js';
import type { Spelling } from '../../src/compile/values.js';

function read(lines: string, spellings: readonly Spelling[] = []) {
  const parsed = parse(`#! ia 1.0\n@law demo\n  governance\n${lines}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return readVariants(parsed.ast.records[0]!, 'a.ia', spellings);
}
describe('governance variants', () => {
  it('keeps fallback, conditional clauses and distinct open keys', () => {
    const result = read('    requires "base"\n    requires "act" when phase is ACT\n    forbids "escape"');
    expect(result.variants).toEqual([
      { key: 'requires', value: { kind: 'string', text: 'base' }, span: { line: 4, endLine: 4 } },
      {
        key: 'requires',
        value: { kind: 'string', text: 'act' },
        condition: [{ axis: 'phase', value: 'act' }],
        span: { line: 5, endLine: 5 },
      },
      { key: 'forbids', value: { kind: 'string', text: 'escape' }, span: { line: 6, endLine: 6 } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  it('uses schema-spelled multiword keys without flattening typed values', () => {
    const result = read('    must retain evidence\n    must retain @law source#act/Memory', [['must', 'retain']]);
    expect(result.variants).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-VARIANT-DUPLICATE', 'IA-LANG-VARIANT-DUPLICATE']);
    const valid = read('    must retain evidence\n    must retain @law source#act/Memory when phase is act', [
      ['must', 'retain'],
    ]);
    expect(valid.variants.map((v) => [v.key, v.value])).toEqual([
      ['must retain', { kind: 'scalar', text: 'evidence' }],
      ['must retain', { kind: 'ref', discriminator: 'law', name: 'source', fragment: 'act/Memory' }],
    ]);
  });
  it('preserves prose, lists and structured-value markers', () => {
    const result = read(
      '    prose """retained prose"""\n    list [one, "two", @law source]\n    block\n      value "child"\n    empty',
    );
    expect(result.variants.map((v) => v.value)).toEqual([
      { kind: 'prose', text: 'retained prose' },
      {
        kind: 'list',
        items: [
          { kind: 'scalar', text: 'one' },
          { kind: 'string', text: 'two' },
          { kind: 'ref', discriminator: 'law', name: 'source' },
        ],
      },
      { kind: 'block' },
      { kind: 'none' },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  it('refuses all identical canonical conjunctions irrespective of order or case', () => {
    const result = read(
      '    requires "a" when phase is ACT and primitive is memory\n    requires "b"\n      when primitive is Memory and phase is act\n    requires "c" when phase is act and primitive is MEMORY\n    requires "fallback"',
    );
    expect(result.variants.map((v) => v.value)).toEqual([{ kind: 'string', text: 'fallback' }]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-VARIANT-DUPLICATE', 4],
      ['IA-LANG-VARIANT-DUPLICATE', 5],
      ['IA-LANG-VARIANT-DUPLICATE', 7],
    ]);
    expect(result.variants[0]!.span.line).toBe(8);
  });
  it('refuses repeated fallback across repeated governance sections', () => {
    const result = read('    requires "a"\n  governance\n    requires "b"\n    permits "keep"');
    expect(result.variants.map((v) => v.key)).toEqual(['permits']);
    expect(result.diagnostics.map((d) => d.line)).toEqual([4, 6]);
  });
  it('retains different conditions whose equal specificity may overlap', () => {
    const result = read('    requires "a" when phase is act\n    requires "b" when primitive is Decision');
    expect(result.variants).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });
  it('retains a child condition and its complete carrier span', () => {
    const result = read('    requires "act"\n      when phase is ACT');
    expect(result.variants).toEqual([
      {
        key: 'requires',
        value: { kind: 'string', text: 'act' },
        condition: [{ axis: 'phase', value: 'act' }],
        span: { line: 4, endLine: 5 },
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([
    ' when phase is missing',
    ' when phase is act\n      when phase is plan',
    '\n      extra\n        when phase is act',
  ])('never falls back after an invalid condition: %s', (tail) => {
    const result = read(`    requires "bad"${tail}\n    requires "valid fallback"`);
    expect(result.variants.map((v) => v.value)).toEqual([{ kind: 'string', text: 'valid fallback' }]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).not.toBe('IA-LANG-VARIANT-DUPLICATE');
  });
  it('excludes severity metadata from variant families', () => {
    const result = read('    severity blocking\n    severity advisory\n    requires "yes"');
    expect(result.variants.map((v) => v.key)).toEqual(['requires']);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([' when phase is act', '\n      when phase is act'])('forbids severity conditions: %s', (condition) => {
    const result = read(`    severity blocking${condition}`);
    expect(result.variants).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('refuses standalone when without making an obligation named when', () => {
    const result = read('    when phase is act');
    expect(result.variants).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('reads only the governance section: a subject section yields no variants and no diagnostics', () => {
    const parsed = parse(
      '#! ia 1.0\n@law demo\n  governance\n    severity blocking\n    requires "base"\n  subject\n    subject-word spec\n    subject-kind definition\n    covers ["docs/**"]\n',
      'a.ia',
    );
    expect(parsed.diagnostics).toEqual([]);
    const result = readVariants(parsed.ast.records[0]!, 'a.ia', []);
    expect(result.variants.map((v) => [v.key, v.value])).toEqual([['requires', { kind: 'string', text: 'base' }]]);
    expect(result.diagnostics).toEqual([]);
  });
  it('keeps nested declarations independent and item rows in structured data', () => {
    const result = read(
      '    requires "parent"\n    - note\n    @law child\n      governance\n        requires "child"',
    );
    expect(result.variants.map((v) => v.value)).toEqual([{ kind: 'string', text: 'parent' }]);
    expect(result.diagnostics).toEqual([]);
  });
});
