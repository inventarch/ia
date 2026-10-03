import { expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import { fold, load, search, serialize, tokenize } from '../src/index.js';
import { registry } from './native.js';

const location = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
const source = {
  path: 'text.ia',
  location,
  text: '#! ia 1.0\n@playbook a\n  meaning\n    says "Crème 東京 quartz"\n@playbook b\n  meaning\n    says "Crème 東京 quartz"\n@playbook hidden\n  meaning\n    says "quartz quartz quartz ordinary ordinary ordinary ordinary"\n@playbook cells\n  cognition\n    orient\n      primary Memory\n      Memory means "uniquequokka"\n@playbook nested\n  meaning\n    parts\n      - "listneedle"\n      nested "deepneedle"\n    links [@playbook cells, "arrayneedle"]\n',
};
const parsed = parse(source.text, source.path);
const compiled = compile(parsed.ast, registry, location, []);
if (parsed.diagnostics.length > 0 || compiled.diagnostics.some((d) => d.severity === 'error'))
  throw new Error(JSON.stringify([...parsed.diagnostics, ...compiled.diagnostics]));
const options = { sources: [source], languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const graph = load(compiled.records, registry, options);
const id = (name: string) => `governance-system/definition/procedure/${name}`;
it('preserves donor Unicode folding, truncation and stopwords', () => {
  expect(fold('Ｃrème')).toBe('creme');
  expect(tokenize('The Crème 東京 x a 12 ' + 'z'.repeat(80))).toEqual(['creme', '東京', '12', 'z'.repeat(64)]);
});
it('deduplicates query terms, preserves matched term order, and resolves ties by identity', () => {
  expect(search(graph, 'creme')).toEqual(search(graph, 'Crème creme creme'));
  expect(search(graph, '東京 creme').map((h) => [h.identity, h.terms])).toEqual([
    [id('a'), ['東京', 'creme']],
    [id('b'), ['東京', 'creme']],
  ]);
});
it('uses scoped N, df and mean length, ignoring hidden and nonexistent records', () => {
  const visible = new Set([id('a'), id('b'), 'missing']);
  const scoped = search(graph, 'quartz', visible);
  const smaller = load(compiled.records.slice(0, 2), registry, options);
  expect(scoped).toEqual(search(smaller, 'quartz'));
  expect(scoped[0]!.score).toBeCloseTo(Math.log(1 + 0.5 / 2.5), 12);
  expect(scoped.some((h) => h.identity === id('hidden'))).toBe(false);
});
it('indexes decoded nested fields/items/lists/references without doubling semantic products', () => {
  expect(graph.text.postings.get('uniquequokka')?.get(id('cells'))).toBe(1);
  for (const word of ['listneedle', 'deepneedle', 'arrayneedle'])
    expect(search(graph, word)[0]!.identity).toBe(id('nested'));
  expect(search(graph, 'cells').some((h) => h.identity === id('nested'))).toBe(true);
});
it('returns no hits for empty/stopword/unknown queries or empty scopes', () => {
  for (const query of ['', 'the and', 'absentterm']) expect(search(graph, query)).toEqual([]);
  expect(search(graph, 'creme', new Set())).toEqual([]);
});
it('retains immutable postings/results and deterministic serialization', () => {
  expect(() => (graph.text.postings as Map<string, unknown>).clear()).toThrow();
  expect(() => (graph.text.postings.get('creme') as Map<string, number>).set(id('hidden'), 100)).toThrow();
  expect(() => (search(graph, 'creme')[0]!.terms as string[]).pop()).toThrow();
  expect(serialize(load([...compiled.records].reverse(), registry, options))).toBe(serialize(graph));
});
