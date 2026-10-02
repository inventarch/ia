import { describe, expect, it } from 'vitest';
import { FLOOR_REGISTRATIONS } from '../../src/registry/floor.js';
import { mergeByName, mergeRegistrations } from '../../src/registry/merge.js';
import type { Entry, SystemDeclaration } from '../../src/registry/types.js';
import type { Band } from '../../src/taxonomy.js';
import { parse } from '../../src/parser/index.js';
import { extractSchemas } from '../../src/registry/schemas.js';

const span = (line: number) => ({ line, endLine: line });
const entry = (keyword: string, line = 1): Entry => ({
  keyword,
  kind: 'governance',
  category: 'rule',
  facets: ['head'],
  schema: keyword,
  span: span(line),
});
const system = (name: string, band: Band, entries: Entry[], path = `${name}.ia`): SystemDeclaration => ({
  name,
  displayName: name,
  provider: name,
  version: '1.0.0',
  requires: [],
  entries,
  consent: [],
  path,
  span: span(2),
  band,
});

describe('mergeByName', () => {
  it('lets a higher band shadow a lower one silently and refuses a same-band tie on both', () => {
    const a100 = system('a', 100, []);
    const a50 = system('a', 50, [], 'lower.ia');
    const one = mergeByName([a50, a100], '@system');
    expect(one.diagnostics).toEqual([]);
    expect(one.winners.get('a')).toBe(a100);
    const tie = mergeByName([a100, system('a', 100, [], 'other.ia')], '@system');
    expect(tie.winners.has('a')).toBe(false);
    expect(tie.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 'a.ia'],
      ['IA-LANG-IDENTITY-COLLISION', 'other.ia'],
    ]);
  });

  it.each([
    [100, 90],
    [90, 50],
    [50, 10],
    [10, 0],
  ] as const)('selects band %i over %i regardless of source order', (high, low) => {
    const higher = system('a', high, []);
    const lower = system('a', low, [], 'low.ia');
    for (const sources of [
      [higher, lower],
      [lower, higher],
    ]) {
      const result = mergeByName(sources, '@system');
      expect(result.winners.get('a')).toBe(higher);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('does not fall back when the winning name band collides', () => {
    const result = mergeByName(
      [system('a', 50, [], 'low.ia'), system('a', 100, [], 'one.ia'), system('a', 100, [], 'two.ia')],
      '@system',
    );
    expect(result.winners.size).toBe(0);
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 'one.ia'],
      ['IA-LANG-IDENTITY-COLLISION', 'two.ia'],
    ]);
    expect(result.diagnostics[0]?.message).toContain('two.ia:2');
  });

  it('silently shadows a lower-band name collision', () => {
    const high = system('a', 100, []);
    const result = mergeByName([system('a', 50, [], 'one.ia'), system('a', 50, [], 'two.ia'), high], '@system');
    expect(result.winners.get('a')).toBe(high);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports every winning-band participant while preserving independent names in order', () => {
    const result = mergeByName(
      [
        system('z', 50, []),
        system('a', 100, []),
        system('a', 100, [], 'two.ia'),
        system('a', 100, [], 'three.ia'),
        system('b', 50, []),
      ],
      '@system',
    );
    expect([...result.winners.keys()]).toEqual(['b', 'z']);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.every((d) => d.code === 'IA-LANG-IDENTITY-COLLISION')).toBe(true);
  });

  it('merges extracted schema names using the same identity and band rules', () => {
    const schema = (name: string, band: Band, path: string) => {
      const parsed = parse(`#! ia 1.0\n@schema ${name}\n  lowers to definition\n  sections\n    closed\n`, path);
      return extractSchemas(parsed.ast, band, parsed.diagnostics).schemas[0]!;
    };
    const lower = schema('Shared', 50, 'low.ia');
    const higher = schema('SHARED', 100, 'high.ia');
    expect(mergeByName([lower, higher], '@schema').winners.get('shared')).toBe(higher);
    const tie = mergeByName([lower, higher, schema('Shared', 100, 'other.ia')], '@schema');
    expect(tie.winners.size).toBe(0);
    expect(tie.diagnostics).toHaveLength(2);
    expect(tie.diagnostics.every((d) => d.message.includes('@schema'))).toBe(true);
  });

  it('handles an empty declaration set', () => {
    const result = mergeByName([], '@system');
    expect(result.winners.size).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('mergeRegistrations', () => {
  it('registers each keyword once with the floor first, higher band winning', () => {
    const r = mergeRegistrations(
      [system('gov', 100, [entry('law')]), system('old', 50, [entry('law'), entry('rule')])],
      FLOOR_REGISTRATIONS,
    );
    expect(r.diagnostics).toEqual([]);
    expect([...r.registrations.keys()]).toEqual(['system', 'schema', 'law', 'rule']);
    expect(r.registrations.get('law')).toMatchObject({
      system: 'gov',
      band: 100,
      kind: 'governance',
      category: 'rule',
      schema: 'law',
    });
    expect(r.registrations.get('rule')?.system).toBe('old');
  });

  it('blocks a keyword two systems register at the winning band, even above a lone lower provider', () => {
    const r = mergeRegistrations(
      [system('a', 100, [entry('law', 5)]), system('b', 100, [entry('law', 7)]), system('c', 50, [entry('law')])],
      FLOOR_REGISTRATIONS,
    );
    expect(r.registrations.has('law')).toBe(false);
    expect([...r.blocked]).toEqual(['law']);
    expect(r.diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([
      ['IA-LANG-DISCRIMINATOR-CONFLICT', 'a.ia', 5],
      ['IA-LANG-DISCRIMINATOR-CONFLICT', 'b.ia', 7],
    ]);
  });

  it('silently shadows lower-band keyword conflicts and orders minted keywords by name', () => {
    const result = mergeRegistrations(
      [
        system('z', 50, [entry('law'), entry('zeta')]),
        system('a', 50, [entry('law'), entry('alpha')]),
        system('high', 100, [entry('law')]),
      ],
      FLOOR_REGISTRATIONS,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.blocked.size).toBe(0);
    expect([...result.registrations.keys()]).toEqual(['system', 'schema', 'alpha', 'law', 'zeta']);
    expect(result.registrations.get('law')?.system).toBe('high');
  });

  it('preserves floor registrations even if a caller supplies a reserved candidate', () => {
    const result = mergeRegistrations([system('rogue', 100, [entry('system'), entry('schema')])], FLOOR_REGISTRATIONS);
    expect([...result.registrations.values()]).toEqual(FLOOR_REGISTRATIONS);
    expect(result.blocked.size).toBe(0);
    expect(result.diagnostics).toEqual([]); // Extraction owns the reserved-keyword diagnostic.
  });

  it('blocks only conflicting keywords and keeps the remaining floor and minted words', () => {
    const result = mergeRegistrations(
      [
        system('a', 100, [entry('law'), entry('rule')]),
        system('b', 100, [entry('law')]),
        system('c', 100, [entry('law')]),
      ],
      FLOOR_REGISTRATIONS,
    );
    expect([...result.registrations.keys()]).toEqual(['system', 'schema', 'rule']);
    expect([...result.blocked]).toEqual(['law']);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.every((d) => d.code === 'IA-LANG-DISCRIMINATOR-CONFLICT')).toBe(true);
  });
});
