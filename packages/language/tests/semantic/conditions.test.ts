import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { conditionOf, readTerms } from '../../src/semantic/conditions.js';
import { CONDITION_AXES, valuesFor } from '../../src/semantic/vocabulary.js';

const span = { line: 4, endLine: 5 };
const terms = (text: string, mode: 'condition' | 'selector' = 'condition') =>
  readTerms(text.split(' ').filter(Boolean), mode, 'a.ia', span);
function field(tail: string) {
  const result = parse(`#! ia 1.0\n@playbook demo\n  message "text"${tail}\n`, 'a.ia');
  expect(result.diagnostics).toEqual([]);
  return result.ast.records[0]!.head[0]!;
}

describe('condition terms', () => {
  it.each(CONDITION_AXES)('canonicalizes every %s value', (axis) => {
    for (const value of valuesFor(axis)!)
      expect(terms(`${axis} is ${value.toUpperCase()}`)).toEqual({ ok: true, terms: [{ axis, value }] });
  });
  it('canonicalizes conjunction order without changing input', () => {
    const words = ['severity', 'is', 'BLOCKING', 'and', 'phase', 'is', 'ACT'];
    expect(readTerms(words, 'condition', 'a.ia', span)).toEqual({
      ok: true,
      terms: [
        { axis: 'phase', value: 'act' },
        { axis: 'severity', value: 'blocking' },
      ],
    });
    expect(words[2]).toBe('BLOCKING');
  });
  it.each([
    '',
    'phase act',
    'phase IS act',
    'phase is act and',
    'phase is "act"',
    'phase is @act',
    'phase is [act]',
    'phase is act or phase is plan',
    'phase is act and phase is ACT',
    'phase is act and phase is plan',
  ])('refuses malformed terms once: %s', (text) => {
    expect(terms(text)).toMatchObject({
      ok: false,
      diagnostic: { code: 'IA-LANG-CONDITION-MALFORMED', path: 'a.ia', line: 4 },
    });
  });
  it.each(['Phase', 'unknown', 'toString'])('refuses an unknown literal name: %s', (axis) => {
    expect(terms(`${axis} is act`)).toMatchObject({
      ok: false,
      diagnostic: { code: 'IA-LANG-CONDITION-TERM-UNKNOWN' },
    });
  });
  it('refuses an unknown value and names the admitted values', () => {
    expect(terms('move is Decision')).toMatchObject({
      ok: false,
      diagnostic: { code: 'IA-LANG-CONDITION-VALUE-UNKNOWN', message: expect.stringContaining('Observation') },
    });
  });
});

describe('condition carriers', () => {
  it.each([' when phase is ACT', '\n    when phase is ACT'])('reads %s', (tail) => {
    expect(conditionOf(field(tail), 'a.ia')).toEqual({ ok: true, condition: [{ axis: 'phase', value: 'act' }] });
  });
  it('leaves absence absent', () => expect(conditionOf(field(''), 'a.ia')).toEqual({ ok: true }));
  it.each([
    ' when phase is act\n    when severity is blocking',
    '\n    when phase is act\n    when severity is blocking',
    '\n    when phase is "act"',
    '\n    when phase is act\n      extra "no"',
    '\n    when',
  ])('refuses the whole carrier without a fallback: %s', (tail) => {
    const result = conditionOf(field(tail), 'a.ia');
    expect(result).toMatchObject({ ok: false, diagnostic: { code: 'IA-LANG-CONDITION-MALFORMED' } });
    expect(result).not.toHaveProperty('condition');
  });
});
