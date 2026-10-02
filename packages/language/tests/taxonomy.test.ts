import { describe, expect, it } from 'vitest';
import {
  AXES,
  BAND_OF,
  BANDS,
  CARDINALITIES,
  CATEGORIES,
  INVERSE_OF,
  KINDS,
  MOVES,
  PHASES,
  PLACEMENT_KINDS,
  PREDICATE_PAIRS,
  PREDICATES,
  PRIMITIVES,
  PROVENANCES,
  SEVERITIES,
  TEXT_FORMS,
  VALUE_TYPES,
  fieldTypeOf,
  isTextForm,
  isBand,
  isCardinality,
  isCategory,
  isKind,
  isPredicate,
  isProvenance,
  isValueType,
} from '../src/taxonomy.js';

describe('taxonomy embed', () => {
  it('holds the closed axes at their known sizes, each without duplicates', () => {
    const sizes: [readonly unknown[], number][] = [
      [KINDS, 7],
      [CATEGORIES, 15],
      [PREDICATE_PAIRS, 18],
      [PREDICATES, 18],
      [PHASES, 4],
      [PRIMITIVES, 6],
      [MOVES, 5],
      [AXES, 9],
      [SEVERITIES, 3],
      [PROVENANCES, 4],
      [BANDS, 5],
      [PLACEMENT_KINDS, 5],
      [VALUE_TYPES, 6],
      [CARDINALITIES, 3],
    ];
    for (const [set, size] of sizes) {
      expect(set).toHaveLength(size);
      expect(new Set(set.map((x) => JSON.stringify(x))).size).toBe(size);
    }
    const inverses = PREDICATE_PAIRS.map((p) => p[1]);
    expect(new Set(inverses).size).toBe(18);
    expect(inverses.some((i) => (PREDICATES as readonly string[]).includes(i))).toBe(false);
  });

  it('spells the kinds, phases, primitives and moves the specs name', () => {
    expect(KINDS).toEqual(['governance', 'contract', 'definition', 'template', 'check', 'policy', 'binding']);
    expect(PHASES).toEqual(['orient', 'plan', 'act', 'learn']);
    expect(PRIMITIVES).toEqual(['Memory', 'Attention', 'Inference', 'Decision', 'Escalation', 'Learning']);
    expect(MOVES).toEqual(['Observation', 'Execution', 'Delegation', 'Synthesis', 'Verification']);
    expect(INVERSE_OF.get('govern')).toBe('governed-by');
    expect(INVERSE_OF.get('record-lineage-from')).toBe('lineage-recorded-by');
  });

  it('maps every placement kind to a band and answers membership exactly', () => {
    expect(PLACEMENT_KINDS.map((k) => BAND_OF[k])).toEqual([100, 90, 50, 10, 0]);
    // BANDS is the literal tuple the Band type is derived from; it must never drift from the placement mapping.
    expect([...BANDS]).toEqual(PLACEMENT_KINDS.map((k) => BAND_OF[k]));
    expect(isKind('binding')).toBe(true);
    expect(isKind('Binding')).toBe(false);
    expect(isCategory('capability')).toBe(true);
    expect(isCategory('capabilities')).toBe(false);
    expect(isPredicate('cite')).toBe(true);
    expect(isPredicate('cites')).toBe(false);
    expect(isProvenance('workspace')).toBe(true);
    expect(isBand(90)).toBe(true);
    expect(isBand(75)).toBe(false);
    expect(isValueType('ref')).toBe(true);
    expect(isCardinality('one-or-more')).toBe(true);
  });

  it('keeps the text forms a closed language-owned table', () => {
    expect(TEXT_FORMS).toEqual(['iso-date']);
    expect(isTextForm('iso-date')).toBe(true);
    expect(isTextForm('rfc3339')).toBe(false);
  });

  it('reads a field type from words: a value type or list of one', () => {
    expect(fieldTypeOf(['text'])).toBe('text');
    expect(fieldTypeOf(['list', 'of', 'id'])).toBe('list of id');
    expect(fieldTypeOf(['list', 'of', 'lists'])).toBeUndefined();
    expect(fieldTypeOf(['string'])).toBeUndefined();
    expect(fieldTypeOf([])).toBeUndefined();
  });
});
