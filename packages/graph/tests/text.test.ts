import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import type { CompiledRecord } from '@inventarch/language';
import { fold, load, search, serialize, tokenize } from '../src/index.js';
import { INDEXED_POSTINGS, buildTextIndex } from '../src/text.js';
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
describe('the size of the text index', () => {
  const record = (name: string, words: readonly string[]) =>
    ({
      identity: `local/definition/note/${name}`,
      displayName: name,
      discriminator: 'note',
      head: [{ key: 'says', value: { kind: 'string', text: words.join(' ') }, span: { line: 1, endLine: 1 } }],
      sections: [],
      cells: [],
      variants: [],
      requirements: [],
    }) as unknown as CompiledRecord;
  const words = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

  const identity = (name: string) => `local/definition/note/${name}`;
  const postings = (index: ReturnType<typeof buildTextIndex>) =>
    [...index.postings.values()].reduce((sum, posting) => sum + posting.size, 0);

  it('takes a word it has not seen for eight postings, up to its limit', () => {
    // Its discriminator is a word of the record too.
    const held = buildTextIndex([record('a', words(INDEXED_POSTINGS / 8 - 1, 'w'))]);
    expect(held.postings.size).toBe(INDEXED_POSTINGS / 8);
    expect(held.postings.has(`w${INDEXED_POSTINGS / 8 - 2}`)).toBe(true);
    const past = buildTextIndex([record('a', words(INDEXED_POSTINGS / 8, 'w'))]);
    expect(past.postings.size).toBe(INDEXED_POSTINGS / 8);
    expect(past.postings.has(`w${INDEXED_POSTINGS / 8 - 1}`)).toBe(false);
    // A record's length is what it holds, whatever the index took of it.
    expect(past.lengths.get(identity('a'))).toBe(INDEXED_POSTINGS / 8 + 1);
  });

  it('takes no posting of a word it knows past its limit, and keeps counting those it holds', () => {
    const shared = words(1_000, 'w'),
      names = Array.from({ length: 1_040 }, (_, index) => `r${index}`),
      index = buildTextIndex(names.map((name) => record(name, ['w0', ...shared, 'w0']))),
      last = identity(names.at(-1)!);
    expect(postings(index)).toBeLessThanOrEqual(INDEXED_POSTINGS);
    expect(postings(index)).toBeGreaterThan(INDEXED_POSTINGS - 16_000);
    expect(index.postings.get('w999')?.has(last)).toBe(false);
    expect(index.lengths.get(last)).toBe(1_004);
    const taken = names.filter((name) => index.postings.get('w0')?.has(identity(name))).at(-1)!;
    expect(index.postings.get('w0')?.get(identity(taken))).toBe(3);
  });

  it('finds what it holds past its limit, and nothing of what it did not take', () => {
    const first = record('a', words(INDEXED_POSTINGS / 8 - 1, 'w')),
      second = record('b', ['w1', 'neverindexed']),
      text = buildTextIndex([first, second]),
      graph = { text } as unknown as Parameters<typeof search>[0];
    expect(search(graph, 'w1').map((hit) => hit.identity)).toEqual([identity('a')]);
    expect(search(graph, 'neverindexed')).toEqual([]);
  });
});
