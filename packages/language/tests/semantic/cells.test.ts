import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { readCells } from '../../src/semantic/cells.js';
import { PHASES, PRIMITIVES } from '../../src/taxonomy.js';

function read(body: string) {
  const parsed = parse(`#! ia 1.0\n@playbook demo\n${body}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return readCells(parsed.ast.records[0]!, 'a.ia');
}
const underAct = (lines: string) => read(`  cognition\n    act\n${lines}`);

describe('cognition cells', () => {
  it.each(PHASES)('admits all six primitives in %s', (phase) => {
    const result = read(
      `  cognition\n    ${phase}\n${PRIMITIVES.map((p) => `      ${p} means "${p} text"`).join('\n')}`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.cells).toEqual(
      PRIMITIVES.map((primitive, i) => ({
        phase,
        primitive,
        primary: false,
        text: `${primitive} text`,
        span: { line: i + 5, endLine: i + 5 },
      })),
    );
  });
  it('marks a primary regardless of its authored order', () => {
    const result = underAct('      Decision means "do"\n      primary Decision\n      Memory means "recall"');
    expect(result.cells.map((c) => [c.primitive, c.primary])).toEqual([
      ['Decision', true],
      ['Memory', false],
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([' when phase is ACT', '\n        when phase is ACT'])('retains a valid condition: %s', (condition) => {
    const result = underAct(`      Decision means "do"${condition}`);
    expect(result.cells[0]).toMatchObject({ condition: [{ axis: 'phase', value: 'act' }] });
    expect(result.diagnostics).toEqual([]);
  });
  it('folds prose and retains multiline span', () => {
    const result = underAct('      Decision means """\n        First line\n        second line.\n      """');
    expect(result.cells[0]).toMatchObject({ text: 'First line second line.', span: { line: 5, endLine: 8 } });
  });
  it.each([
    '      decision means "bad"',
    '      Unknown means "bad"',
    '      Decision means bare',
    '      Decision means @playbook other',
    '      Decision means [a]',
    '      Decision said "bad"',
    '      Decision means "bad"\n        extra "bad"',
    '      - bad',
  ])('refuses only an invalid means: %s', (line) => {
    const result = underAct(`${line}\n      Memory means "good"`);
    expect(result.cells.map((c) => c.primitive)).toEqual(['Memory']);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CELL-MALFORMED']);
  });
  it.each([
    '      primary decision',
    '      primary Unknown',
    '      primary Decision extra',
    '      primary "Decision"',
    '      primary Decision\n        extra "bad"',
  ])('an invalid primary refuses the phase: %s', (line) => {
    const result = underAct(`${line}\n      Decision means "do"\n      Memory means "recall"`);
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CELL-MALFORMED']);
  });
  it.each([' when phase is act', '\n        when phase is act'])('forbids primary conditions: %s', (condition) => {
    const result = underAct(`      primary Decision${condition}\n      Decision means "do"`);
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('reports every repeated primary and refuses its phase', () => {
    const result = underAct(
      '      primary Decision\n      primary Memory\n      Decision means "do"\n      Memory means "recall"',
    );
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.line)).toEqual([5, 6]);
  });
  it('refuses a missing primary means without affecting another phase', () => {
    const result = read(
      '  cognition\n    act\n      primary Decision\n      Memory means "recall"\n    learn\n      Learning means "retain"',
    );
    expect(result.cells.map((c) => c.phase)).toEqual(['learn']);
    expect(result.diagnostics).toHaveLength(1);
  });
  it('suppresses missing-means noise when that means was refused', () => {
    const result = underAct(
      '      primary Decision\n      Decision means "do" when phase is missing\n      Memory means "recall"',
    );
    expect(result.cells.map((c) => [c.primitive, c.primary])).toEqual([['Memory', false]]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-VALUE-UNKNOWN']);
  });
  it('does not repeat a malformed primary-primitive line as missing means', () => {
    const result = underAct('      primary Decision\n      Decision said "do"\n      Memory means "recall"');
    expect(result.cells.map((c) => c.primitive)).toEqual(['Memory']);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CELL-MALFORMED']);
  });
  it('refuses all duplicate means participants without removing other primitives', () => {
    const result = underAct(
      '      primary Decision\n      Decision means "a"\n      Memory means "recall"\n      Decision means "b"\n      Decision means "c"',
    );
    expect(result.cells.map((c) => c.primitive)).toEqual(['Memory']);
    expect(result.diagnostics.map((d) => d.line)).toEqual([6, 8, 9]);
  });
  it('refuses repeated phase blocks across sections and keeps independent phases', () => {
    const result = read(
      '  cognition\n    act\n      Decision means "a"\n  cognition\n    act\n      Decision means "b"\n    learn\n      Learning means "retain"\n    act\n      Decision means "c"',
    );
    expect(result.cells.map((c) => c.phase)).toEqual(['learn']);
    expect(result.diagnostics.map((d) => d.line)).toEqual([4, 7, 11]);
  });
  it.each(['unknown', 'ACT', 'act extra', 'act "value"'])('refuses invalid phase %s', (phase) => {
    const result = read(`  cognition\n    ${phase}\n      Decision means "do"`);
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CELL-MALFORMED']);
  });
  it('refuses a conditioned phase as a unit', () => {
    const result = read('  cognition\n    act when phase is act\n      Decision means "do"');
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('names the replacement for legacy primary move syntax', () => {
    const result = underAct('      primary move Decision means "old"');
    expect(result.cells).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toContain('primary <Primitive>');
    for (const primitive of PRIMITIVES) expect(result.diagnostics[0]!.message).toContain(primitive);
  });
  it('forbids unsupported descendant conditions without an unconditional cell', () => {
    const result = underAct('      Decision means "do"\n        extra\n          when phase is act');
    expect(result.cells).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('keeps nested declarations independent', () => {
    const result = read(
      '  cognition\n    act\n      Decision means "parent"\n      @playbook child\n        cognition\n          act\n            Memory means "child"',
    );
    expect(result.cells.map((c) => c.text)).toEqual(['parent']);
    expect(result.diagnostics).toEqual([]);
  });
});
