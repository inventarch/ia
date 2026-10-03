import { expect, it } from 'vitest';
import { buildRegistry, compile, parse, KERNEL_DIGEST, LANGUAGE_VERSION } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { load } from '../src/index.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const vocabulary = `#! ia 1.0\n@system authors\n  provider "fixture"\n  version "1.0.0"\n  discriminators\n    note lowers to definition\n      category representation\n      facets [head]\n      schema @schema note\n  edges\n    cite * using note\n    ground * using note\n@schema note\n  lowers to definition\n  sections\n    open\n`;
function fixture(assertion: string, inverse = false, revoke = false) {
  const inputs = [
    vocabulary,
    inverse
      ? `#! ia 1.0\n@schema target\n  lowers to definition\n  sections\n    open\n  relationships\n    ${assertion}\n`
      : '#! ia 1.0\n@schema target\n  lowers to definition\n  sections\n    open\n',
    inverse ? '#! ia 1.0\n@note example\n' : `#! ia 1.0\n@note example\n  relationships\n    ${assertion}\n`,
  ].map((text, i) => ({ text, path: `${i}.ia`, location }));
  const sources = inputs.map((s) => ({ ...parse(s.text, s.path), location }));
  const registry = buildRegistry(sources).registry;
  const records = sources.flatMap((s) => compile(s.ast, registry, location, []).records);
  const consent = new Map(registry.consent);
  if (revoke) consent.set('authors', []);
  return load(
    records,
    { ...registry, consent },
    { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' },
  );
}
it('late-resolves whole schema citations with independent source consent', () => {
  const graph = fixture('cites @schema target');
  expect(graph.diagnostics).toEqual([]);
  expect(graph.edges.filter((e) => e.predicate === 'cite')).toHaveLength(1);
  expect(
    fixture('cites @schema target', false, true).diagnostics.some(
      (d) => d.code === 'IA-GRAPH-EDGE-UNCONSENTED' && d.message.includes(': source system refuses'),
    ),
  ).toBe(true);
});
it('refuses late schema fragments and ordinary ground, but preserves inverse other-end fragments', () => {
  for (const assertion of ['cites @schema target#fields', 'grounds @schema target'])
    expect(fixture(assertion).diagnostics.some((d) => d.code === 'IA-GRAPH-EDGE-UNCONSENTED')).toBe(true);
  const inverse = fixture('cited-by @note example#meaning', true);
  expect(inverse.diagnostics).toEqual([]);
  expect(inverse.edges.find((e) => e.predicate === 'cite')).toMatchObject({
    fragment: 'meaning',
    fragmentEndpoint: 'from',
    to: 'floor/contract/head/target',
  });
});
