import { describe, expect, it } from 'vitest';
import { orderSystems } from '../../src/registry/order.js';
import type { SystemDeclaration } from '../../src/registry/types.js';
import { parse } from '../../src/parser/index.js';
import { extractSystems } from '../../src/registry/extract.js';
import { mergeByName, mergeRegistrations } from '../../src/registry/merge.js';
import { FLOOR_REGISTRATIONS } from '../../src/registry/floor.js';

const span = (line: number) => ({ line, endLine: line });
const system = (name: string, requires: string[]): SystemDeclaration => ({
  name,
  displayName: name,
  provider: name,
  version: '1.0.0',
  requires: requires.map((r, i) => ({ name: r, span: span(10 + i) })),
  entries: [],
  consent: [],
  path: `${name}.ia`,
  span: span(2),
  band: 100,
});
const winners = (...systems: SystemDeclaration[]) => new Map(systems.map((s) => [s.name, s]));

describe('orderSystems', () => {
  it('orders systems after what they require, ties by name, built-ins resolving without a record', () => {
    const r = orderSystems(
      winners(
        system('session', ['agent', 'workspace']),
        system('workspace', ['agent', 'compliance']),
        system('compliance', ['agent']),
        system('agent', ['taxonomy']),
        system('zeta', []),
      ),
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.order).toEqual(['agent', 'compliance', 'workspace', 'session', 'zeta']);
  });

  it('refuses a system requiring a name no system in force declares', () => {
    const r = orderSystems(winners(system('a', ['ghost']), system('b', [])));
    expect(r.diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([['IA-LANG-SYSTEM-MISSING', 'a.ia', 10]]);
    expect(r.order).toEqual(['b']);
    expect([...r.dropped]).toEqual(['a']);
  });

  it('refuses every member of a cycle once, naming the cycle, and orders the rest', () => {
    const r = orderSystems(
      winners(system('a', ['b']), system('b', ['c']), system('c', ['a']), system('d', ['a']), system('e', [])),
    );
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['IA-LANG-SYSTEM-CYCLE', 'a.ia'],
      ['IA-LANG-SYSTEM-CYCLE', 'b.ia'],
      ['IA-LANG-SYSTEM-CYCLE', 'c.ia'],
      ['IA-LANG-SYSTEM-MISSING', 'd.ia'],
    ]);
    expect(r.diagnostics[0]?.message).toContain('a -> b -> c -> a');
    expect(r.order).toEqual(['e']);
    expect([...r.dropped].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('chooses the alphabetically first currently ready system', () => {
    const result = orderSystems(winners(system('a', ['z']), system('b', []), system('z', [])));
    expect(result.diagnostics).toEqual([]);
    expect(result.order).toEqual(['b', 'z', 'a']);
  });

  it('is independent of source order and requirement order', () => {
    const one = orderSystems(winners(system('a', ['d', 'c']), system('b', []), system('c', []), system('d', [])));
    const two = orderSystems(winners(system('d', []), system('c', []), system('b', []), system('a', ['c', 'd'])));
    expect(one.order).toEqual(['b', 'c', 'd', 'a']);
    expect(two.order).toEqual(one.order);
    expect(one.diagnostics).toEqual([]);
    expect(two.diagnostics).toEqual([]);
  });

  it('refuses direct and transitive dependents of a missing requirement', () => {
    const result = orderSystems(
      winners(system('a', ['b']), system('b', ['ghost']), system('c', ['a']), system('z', [])),
    );
    expect(result.order).toEqual(['z']);
    expect([...result.dropped].sort()).toEqual(['a', 'b', 'c']);
    expect(result.diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([
      ['IA-LANG-SYSTEM-MISSING', 'a.ia', 10],
      ['IA-LANG-SYSTEM-MISSING', 'b.ia', 10],
      ['IA-LANG-SYSTEM-MISSING', 'c.ia', 10],
    ]);
  });

  it('finds every member of overlapping cycles once and names a real cycle through each', () => {
    const inputs = winners(
      system('a', ['b', 'c']),
      system('b', ['a']),
      system('c', ['b']),
      system('d', ['c']),
      system('z', []),
    );
    const result = orderSystems(inputs);
    expect(result.order).toEqual(['z']);
    const cycles = result.diagnostics.filter((d) => d.code === 'IA-LANG-SYSTEM-CYCLE');
    expect(cycles.map((d) => d.path)).toEqual(['a.ia', 'b.ia', 'c.ia']);
    for (const diagnostic of cycles) {
      const cycle = diagnostic.message.split('requires cycle ')[1]!.split(' -> ');
      expect(cycle[0]).toBe(diagnostic.path.replace('.ia', ''));
      expect(cycle.at(-1)).toBe(cycle[0]);
      for (let i = 1; i < cycle.length; i++)
        expect(inputs.get(cycle[i - 1]!)?.requires.some((r) => r.name === cycle[i])).toBe(true);
    }
    expect(result.diagnostics.filter((d) => d.code === 'IA-LANG-SYSTEM-MISSING').map((d) => d.path)).toEqual(['d.ia']);
  });

  it('refuses a self-cycle and preserves an independent system', () => {
    const result = orderSystems(winners(system('a', ['a']), system('b', [])));
    expect(result.order).toEqual(['b']);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-SYSTEM-CYCLE', 2]]);
    expect(result.diagnostics[0]?.message).toContain('a -> a');
  });

  it('finds disjoint cycles and does not mistake a dependent for a cycle member', () => {
    const result = orderSystems(
      winners(
        system('a', ['b']),
        system('b', ['a']),
        system('c', ['d']),
        system('d', ['c']),
        system('e', ['a']),
        system('f', ['e']),
        system('z', []),
      ),
    );
    expect(result.order).toEqual(['z']);
    expect(result.diagnostics.filter((d) => d.code === 'IA-LANG-SYSTEM-CYCLE').map((d) => d.path)).toEqual([
      'a.ia',
      'b.ia',
      'c.ia',
      'd.ia',
    ]);
    expect(result.diagnostics.filter((d) => d.code === 'IA-LANG-SYSTEM-MISSING').map((d) => d.path)).toEqual([
      'e.ia',
      'f.ia',
    ]);
  });

  it('reports a cycle even if a member also requires a nonexistent system', () => {
    const result = orderSystems(winners(system('a', ['b', 'ghost']), system('b', ['a'])));
    expect(result.order).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([
      ['IA-LANG-SYSTEM-CYCLE', 'a.ia', 2],
      ['IA-LANG-SYSTEM-MISSING', 'a.ia', 11],
      ['IA-LANG-SYSTEM-CYCLE', 'b.ia', 2],
    ]);
  });

  it('resolves both built-ins without returning synthetic declarations', () => {
    const result = orderSystems(winners(system('a', ['floor', 'taxonomy'])));
    expect(result.order).toEqual(['a']);
    expect(result.dropped.size).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not count a repeated valid requirement twice', () => {
    const result = orderSystems(winners(system('a', ['b', 'b']), system('b', []), system('c', [])));
    expect(result.order).toEqual(['b', 'a', 'c']);
    expect(result.diagnostics).toEqual([]);
  });

  it('handles an empty winner set', () => {
    const result = orderSystems(new Map());
    expect(result.order).toEqual([]);
    expect(result.dropped.size).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('orders extracted lowercase requirements after merging and never revives a shadowed declaration', () => {
    const source = (name: string, required: string, band: 50 | 100) => {
      const parsed = parse(
        `#! ia 1.0\n@system ${name}\n  provider "p"\n  version "1.0.0"\n  requires\n    - ${required}\n  discriminators\n    agent lowers to binding\n      category capability\n      facets [head]\n      schema @schema Agent\n`,
        `${name}-${band}.ia`,
      );
      const extracted = extractSystems(parsed.ast, band, parsed.diagnostics);
      expect(extracted.diagnostics).toEqual([]);
      return extracted.systems[0]!;
    };
    const merged = mergeByName(
      [source('Agent-System', 'taxonomy', 50), source('AGENT-SYSTEM', 'Missing', 100)],
      '@system',
    );
    const ordered = orderSystems(merged.winners);
    expect(ordered.order).toEqual([]);
    expect([...ordered.dropped]).toEqual(['agent-system']);
    expect(ordered.diagnostics[0]?.message).toContain("'missing'");
    const registrations = mergeRegistrations(
      ordered.order.map((name) => merged.winners.get(name)!),
      FLOOR_REGISTRATIONS,
    );
    expect([...registrations.registrations.keys()]).toEqual(['system', 'schema']);
  });
});
