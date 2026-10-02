import { describe, expect, it } from 'vitest';
import { parse, buildRegistry, compile } from '../../src/index.js';
import type { CompiledRecord, Location } from '../../src/index.js';
import { resolveTarget, validatePool } from '../../src/semantic/resolve.js';
import type { EdgeReference } from '../../src/semantic/types.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const entry = (word: string) =>
  `    ${word} lowers to binding\n      category capability\n      facets [head, steward]\n      schema @schema actor`;
const source = parse(
  `#! ia 1.0
@system people
  provider "test"
  version "1.0.0"
  discriminators
${entry('agent')}
${entry('operator')}
@system machines
  provider "test"
  version "1.0.0"
  discriminators
${entry('service')}
@schema actor
  lowers to binding
  sections
    closed
`,
  'vocabulary.ia',
);
const built = buildRegistry([{ ...source, location }]);
const registry = built.registry;
function candidate(word: string, name: string, path: string, facet = 'head'): CompiledRecord {
  const result = compile(parse(`#! ia 1.0\n@${word} ${name}\n  facet ${facet}\n`, path).ast, registry, location, []);
  expect(result.diagnostics).toEqual([]);
  return result.records[0]!;
}
const ref = (name = 'Ada'): EdgeReference => ({ kind: 'ref', discriminator: 'agent', name });
const ada = candidate('agent', 'Ada', 'a.ia');
const bob = candidate('agent', 'Bob', 'b.ia');
const other = candidate('operator', 'Ada', 'operator.ia');
const machine = candidate('service', 'Ada', 'service.ia');
const steward = candidate('agent', 'Ada', 'steward.ia', 'steward');
function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));
}

describe('pure target resolution', () => {
  it('uses an admitted native vocabulary', () => expect(built.diagnostics).toEqual([]));
  it('distinguishes missing from resolved', () => {
    expect(resolveTarget(ref(), registry, [bob, other, machine, steward])).toEqual({ kind: 'missing' });
    expect(resolveTarget(ref(), registry, [ada, bob, other, machine, steward])).toEqual({
      kind: 'resolved',
      target: ada,
    });
  });
  it.each([2, 3])('refuses all %i candidates under every permutation', (count) => {
    const candidates = Array.from({ length: count }, (_, i) => candidate('agent', 'Ada', `${i}.ia`));
    for (const pool of permutations(candidates)) {
      expect(resolveTarget(ref(), registry, pool)).toEqual({ kind: 'ambiguous', candidates });
      expect(resolveTarget({ kind: 'identity', identity: ada.identity }, registry, pool)).toEqual({
        kind: 'ambiguous',
        candidates,
      });
    }
  });
  it('does not cross discriminators, owners, facets or names under permutation', () => {
    for (const pool of permutations([ada, other, machine, steward, bob]))
      expect(resolveTarget(ref(), registry, pool)).toEqual({ kind: 'resolved', target: ada });
  });
  it('resolves alternate facets only by full identity', () => {
    expect(resolveTarget(ref(), registry, [steward])).toEqual({ kind: 'missing' });
    expect(resolveTarget({ kind: 'identity', identity: steward.identity }, registry, [steward, ada])).toEqual({
      kind: 'resolved',
      target: steward,
    });
  });
  it('normalizes sigil names but keeps discriminators and qualified identities literal', () => {
    expect(resolveTarget(ref('ADA'), registry, [ada])).toEqual({ kind: 'resolved', target: ada });
    expect(resolveTarget({ kind: 'ref', discriminator: 'Agent', name: 'Ada' }, registry, [ada])).toEqual({
      kind: 'missing',
    });
    expect(resolveTarget({ kind: 'identity', identity: 'people/binding/head/Ada' }, registry, [ada])).toEqual({
      kind: 'missing',
    });
  });
  it.each(['act/Decision', 'REQ-WRK-PLN-02', 'does-not-exist'])(
    'preserves fragment %s without checking existence',
    (fragment) => {
      for (const reference of [ref(), { kind: 'identity' as const, identity: ada.identity }]) {
        expect(resolveTarget({ ...reference, fragment }, registry, [ada])).toEqual({
          kind: 'resolved',
          target: ada,
          fragment,
        });
        expect(resolveTarget({ ...reference, fragment }, registry, [])).toEqual({ kind: 'missing', fragment });
      }
    },
  );
  it('returns missing for an unregistered target, never bare-name fallback', () => {
    expect(resolveTarget({ kind: 'ref', discriminator: 'unknown', name: 'Ada' }, registry, [ada])).toEqual({
      kind: 'missing',
    });
  });
  it.each([
    { discriminator: 'unknown' },
    { system: 'wrong' },
    { kind: 'definition' },
    { facet: 'wrong' },
    { name: 'Ada' },
    { identity: 'people/binding/head/wrong' },
  ])('rejects inconsistent candidates as caller errors: %o', (change) => {
    const invalid = { ...ada, ...change } as CompiledRecord;
    expect(() => resolveTarget(ref(), registry, [invalid])).toThrow(TypeError);
  });
  it('checks all candidates even if an earlier one matched', () => {
    expect(() => resolveTarget(ref(), registry, [ada, { ...bob, system: 'wrong' }])).toThrow(TypeError);
  });
  it.each(['', 'a/b', 'two words'])('rejects a rendered but invalid candidate name: %s', (name) => {
    expect(() => validatePool(registry, [{ ...ada, name, identity: `people/binding/head/${name}` }])).toThrow(
      TypeError,
    );
  });
  it('rejects current-file pool entries after canonical path normalization', () => {
    expect(() => validatePool(registry, [ada], './a.ia')).toThrow(TypeError);
    expect(() =>
      validatePool(registry, [{ ...ada, source: { ...ada.source, path: 'folder\\a.ia' } }], 'folder/./a.ia'),
    ).toThrow(TypeError);
    expect(() => validatePool(registry, [ada], 'A.ia')).not.toThrow();
  });
  it('does not select by band or mutate inputs', () => {
    const lower = {
      ...ada,
      source: { ...ada.source, path: 'lower.ia' },
      placement: { ...ada.placement, band: 10 as const },
    };
    const pool = Object.freeze([lower, ada]);
    const before = JSON.stringify([pool, [...registry.registrations]]);
    expect(resolveTarget(Object.freeze(ref()), registry, pool).kind).toBe('ambiguous');
    expect(JSON.stringify([pool, [...registry.registrations]])).toBe(before);
  });
});
