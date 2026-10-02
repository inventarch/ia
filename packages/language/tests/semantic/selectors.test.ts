import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { readSelectors } from '../../src/semantic/selectors.js';
import { AXES } from '../../src/taxonomy.js';
import { valuesFor } from '../../src/semantic/vocabulary.js';

function read(body: string) {
  const parsed = parse(`#! ia 1.0\n@playbook demo\n${body}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return readSelectors(parsed.ast.records[0]!, 'a.ia');
}
describe('selectors', () => {
  it.each(AXES)('admits every %s value', (axis) => {
    for (const value of valuesFor(axis)!) {
      const result = read(`  activation\n    activate when ${axis} is ${value.toUpperCase()}`);
      expect(result).toEqual({ selectors: [[{ axis, value }]], spans: [{ line: 4, endLine: 4 }], diagnostics: [] });
    }
  });
  it('keeps groups separate across repeated sections', () => {
    const result = read(
      '  activation\n    activate when phase is act and category is capability\n  activation\n    activate when phase is plan',
    );
    expect(result.selectors).toHaveLength(2);
    expect(result.spans.map((s) => s.line)).toEqual([4, 6]);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([
    ['activate', 'MALFORMED'],
    ['activate phase is act', 'MALFORMED'],
    ['activate when phase act', 'MALFORMED'],
    ['activate when phase is "act"', 'MALFORMED'],
    ['activate when phase is act and', 'MALFORMED'],
    ['activate when phase is act and phase is plan', 'MALFORMED'],
    ['activate when severity is blocking', 'AXIS-UNKNOWN'],
    ['activate when provenance is workspace', 'AXIS-UNKNOWN'],
    ['activate when Phase is act', 'AXIS-UNKNOWN'],
    ['activate when phase is missing', 'VALUE-UNKNOWN'],
    ['activate\n      when phase is act', 'MALFORMED'],
    ['- phase', 'MALFORMED'],
    ['activate when phase is act\n      extra "no"', 'MALFORMED'],
  ])('refuses a group once: %s', (line, suffix) => {
    const result = read(`  activation\n    ${line}\n    activate when phase is learn`);
    expect(result.selectors).toEqual([[{ axis: 'phase', value: 'learn' }]]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([`IA-LANG-SELECTOR-${suffix}`]);
    expect(result.spans).toHaveLength(1);
  });
  it('does not infer selectors from meaning, prose or a nested record', () => {
    const result = read(
      '  meaning\n    category context\n    describes "activate when phase is act"\n  activation\n    @playbook child\n      activation\n        activate when phase is act',
    );
    expect(result).toEqual({ selectors: [], spans: [], diagnostics: [] });
  });
});
