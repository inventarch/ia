import { describe, expect, it } from 'vitest';
import { AXES, MOVES, PREDICATE_PAIRS } from '../../src/taxonomy.js';
import { canonicalValue, valuesFor, verbOf } from '../../src/semantic/vocabulary.js';

const phrases = [
  ['governs', 'govern'],
  ['enforces', 'enforce'],
  ['grounds', 'ground'],
  ['constrains', 'constrain'],
  ['implements', 'implement'],
  ['produces', 'produce'],
  ['consumes', 'consume'],
  ['records lineage from', 'record-lineage-from'],
  ['grants access to', 'grant-access-to'],
  ['runs before', 'run-before'],
  ['triggers', 'trigger'],
  ['cites', 'cite'],
  ['supersedes', 'supersede'],
  ['requires', 'require'],
  ['uses', 'use'],
  ['forbids', 'forbid'],
  ['routes to', 'route'],
  ['lands at', 'land'],
];

describe('semantic vocabulary', () => {
  it.each(PREDICATE_PAIRS)('resolves active %s and inverse %s', (active, inverse) => {
    expect(verbOf(active)).toEqual({ predicate: active, direction: 'out' });
    expect(verbOf(inverse)).toEqual({ predicate: active, direction: 'in' });
  });
  it.each(phrases)('resolves present phrase %s', (phrase, predicate) => {
    expect(verbOf(phrase!)).toEqual({ predicate, direction: 'out' });
  });
  it.each(['Cites', 'routes', 'records lineage', 'useful', 'uses-by', 'constructor', ''])(
    'refuses unknown phrase %s',
    (phrase) => {
      expect(verbOf(phrase)).toBeUndefined();
    },
  );
  it('supplies the exact missing closed sets', () => {
    expect(valuesFor('lane')).toEqual([
      'authority',
      'contracts',
      'definitions',
      'templates',
      'enforcement',
      'bindings',
    ]);
    expect(valuesFor('shape')).toEqual(['context', 'governance', 'execution', 'sequence', 'learning']);
    expect(valuesFor('artifact-set')).toEqual([
      'inquiry',
      'decision',
      'contract',
      'product-definition',
      'execution',
      'operational',
      'evidence',
      'projection',
      'principle',
    ]);
    for (const axis of AXES) expect(valuesFor(axis)!.length).toBeGreaterThan(0);
  });
  it('canonicalizes values while keeping axes literal and prototype-safe', () => {
    expect(canonicalValue('primitive', 'mEmOrY')).toBe('Memory');
    expect(canonicalValue('phase', 'ACT')).toBe('act');
    expect(canonicalValue('severity', 'BLOCKING')).toBe('blocking');
    expect(canonicalValue('provenance', 'BOOTSTRAP')).toBe('bootstrap');
    expect(valuesFor('Phase')).toBeUndefined();
    expect(valuesFor('constructor')).toBeUndefined();
    expect(canonicalValue('predicate', 'used-by')).toBeUndefined();
  });
  it('keeps the five moves and excludes primitive-only values', () => {
    expect(valuesFor('move')).toEqual(MOVES);
    expect(MOVES).toEqual(['Observation', 'Execution', 'Delegation', 'Synthesis', 'Verification']);
    for (const primitive of ['Decision', 'Attention', 'Escalation'])
      expect(canonicalValue('move', primitive)).toBeUndefined();
  });
});
