import { CONDITION_AXES } from '@inventarch/language';
import { expect, it } from 'vitest';
import { classify, prepareCoordinate, scoreShapes } from '../src/index.js';

it.each([
  ['fix the parser', 'execution'],
  ['what exists', 'context'],
  ['before the next milestone', 'sequence'],
  ['capture the outcome', 'learning'],
  ['must not write', 'governance'],
  ['snowflakes', 'context'],
  ['run after learning the policy', 'governance'],
  ['run after learning', 'sequence'],
])('classifies %s as %s using native tie precedence', (text, shape) => {
  expect(classify(text)).toBe(shape);
});
it('marks every axis source without supplying missing phase or primitive', () => {
  const got = prepareCoordinate('write an agent', {});
  expect(Object.keys(got.sources).sort()).toEqual([...CONDITION_AXES].sort());
  expect(got.values).toEqual({ shape: 'execution', category: 'capability' });
  expect(got.sources.phase).toBe('absent');
  expect(got.sources.primitive).toBe('absent');
  expect(got.sources.shape).toBe('derived');
  expect(got.focus.kinds).toEqual(['binding', 'template']);
  expect(got.values.kind).toBeUndefined();
  expect(got.sources.kind).toBe('absent');
});
it('preserves declared phase, primitive, move and category over profile or derivation', () => {
  const got = prepareCoordinate(
    'implement',
    { phase: 'ACT', primitive: 'memory', move: 'verification', category: 'decision' },
    { profile: { category: 'rule', severity: 'blocking' } },
  );
  expect(got.values).toEqual({
    phase: 'act',
    primitive: 'Memory',
    move: 'Verification',
    category: 'decision',
    severity: 'blocking',
    shape: 'execution',
  });
  expect(got.sources.primitive).toBe('declared');
  expect(got.sources.category).toBe('declared');
  expect(got.sources.severity).toBe('profile');
});
it('uses profile category before shape defaults and skips an overridden classifier', () => {
  const got = prepareCoordinate(
    'write',
    {},
    {
      profile: { category: 'decision', shape: 'learning' },
      classifier: {
        classify: () => {
          throw new Error('should not run');
        },
      },
    },
  );
  expect(got.values.category).toBe('decision');
  expect(got.sources.category).toBe('profile');
  expect(got.sources.shape).toBe('profile');
  expect(
    prepareCoordinate(
      'write',
      { shape: 'sequence' },
      {
        classifier: {
          classify: () => {
            throw new Error('should not run');
          },
        },
      },
    ).sources.shape,
  ).toBe('declared');
});
it('marks a custom classifier output derived and validates it against the native domain', () => {
  const got = prepareCoordinate('anything', {}, { classifier: { classify: () => 'LEARNING' } });
  expect(got.values.shape).toBe('learning');
  expect(got.values.category).toBe('evidence');
  expect(() => prepareCoordinate('', {}, { classifier: { classify: () => 'invented' } })).toThrow(
    expect.objectContaining({ code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' }),
  );
  for (const value of [undefined, null, 42, ''])
    expect(() => prepareCoordinate('', {}, { classifier: { classify: () => value as string } })).toThrow(
      expect.objectContaining({ code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' }),
    );
});
it('refuses unknown declared/profile axes and profile impersonation of host declarations', () => {
  for (const input of [{ primitive: 'Thinking' }, { category: 'invented' }, { invent: 'axis' }])
    expect(() => prepareCoordinate('', input)).toThrow(
      expect.objectContaining({ code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' }),
    );
  expect(() => prepareCoordinate('', {}, { profile: { move: 'unknown' } })).toThrow(
    expect.objectContaining({ code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' }),
  );
  for (const profile of [{ phase: 'act' }, { primitive: 'Decision' }])
    expect(() => prepareCoordinate('', {}, { profile })).toThrow(
      expect.objectContaining({ code: 'IA-RUNTIME-REQUEST-INVALID' }),
    );
});
it('returns copied immutable coordinate values, source marks, focus lists and shape scores', () => {
  const profile = { category: 'rule' },
    got = prepareCoordinate('', {}, { profile });
  profile.category = 'event';
  expect(got.values.category).toBe('rule');
  expect(() => {
    (got.values as { category: string }).category = 'event';
  }).toThrow();
  expect(() => (got.focus.predicates as string[]).pop()).toThrow();
  expect(() => (scoreShapes('write') as unknown[]).pop()).toThrow();
});
