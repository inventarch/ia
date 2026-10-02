import { describe, expect, it } from 'vitest';
import { buildRegistry, compile, consentFor, parse } from '../../src/index.js';
import type { FrozenRegistry, Location } from '../../src/index.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const text = `#! ia 1.0
@system authors
  provider "fixture"
  version "1.0.0"
  discriminators
    note lowers to definition
      category representation
      facets [head]
      schema @schema note
  edges
    cite * using note
    ground * using note
@schema note
  lowers to definition
  sections
    open
`;
const source = (value: string, path = 'vocabulary.ia') => ({ ...parse(value, path), location });
const registry = buildRegistry([source(text)]).registry;
function edges(line: string, vocabulary: FrozenRegistry = registry) {
  const target = compile(source(text).ast, vocabulary, location, []).records.filter(
    (r) => r.discriminator === 'schema',
  );
  return compile(
    source(`#! ia 1.0\n@note example\n  relationships\n    ${line}\n`, 'example.ia').ast,
    vocabulary,
    location,
    target,
  );
}

describe('fixed floor schema citation consent', () => {
  it('admits whole schema references without a synthetic floor system', () => {
    expect(registry.systems.has('floor')).toBe(false);
    expect(consentFor(registry, 'cite', 'note', 'schema')).toBeUndefined();
    for (const ref of ['@schema note', 'floor/contract/head/note']) {
      const result = edges(`cites ${ref}`);
      expect(result.diagnostics).toEqual([]);
      expect(result.records[0]!.edges).toHaveLength(1);
    }
  });
  it('retains source refusal and grants no other floor target or predicate', () => {
    const consent = new Map(registry.consent);
    consent.set('authors', []);
    expect(consentFor({ ...registry, consent }, 'cite', 'note', 'schema')).toBe('source');
    expect(consentFor(registry, 'cite', 'note', 'system')).toBe('target');
    expect(consentFor(registry, 'cite', 'schema', 'schema')).toBe('source');
    expect(consentFor(registry, 'ground', 'note', 'schema')).toBe('target');
    expect(edges('grounds @schema note').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-UNCONSENTED']);
  });
  it('rejects a schema fragment while retaining normal conditional whole citations', () => {
    expect(edges('cites @schema note#fields').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-UNCONSENTED']);
    expect(edges('cites @schema note when phase is act').diagnostics).toEqual([]);
  });
  it('prevents an authored floor ledger from replacing the fixed narrow row', () => {
    const forged = source(
      '#! ia 1.0\n@system floor\n  provider "fixture"\n  version "1.0.0"\n  edges\n    ground * using *\n    cite * using *\n',
      'forged.ia',
    );
    const changed = buildRegistry([source(text), forged]).registry;
    expect(consentFor(changed, 'ground', 'note', 'schema')).toBe('target');
    expect(consentFor(changed, 'cite', 'note', 'system')).toBe('target');
    expect(consentFor(changed, 'cite', 'note', 'schema')).toBeUndefined();
  });
  it('shares no mutable built-in row or nested collection', () => {
    const rows = registry.consent.get('floor')!;
    expect(rows).toHaveLength(1);
    expect(() => (rows as unknown[]).pop()).toThrow();
    expect(() => (rows[0]!.targets as string[]).push('system')).toThrow();
    expect(() => {
      (rows[0]!.span as { line: number }).line = 5;
    }).toThrow();
    expect(consentFor(buildRegistry([source(text)]).registry, 'cite', 'note', 'system')).toBe('target');
  });
});
