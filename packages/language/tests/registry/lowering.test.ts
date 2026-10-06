import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { extractSystems } from '../../src/registry/extract.js';

const extract = (source: string) => {
  const parsed = parse(source, 'sys.ia');
  const result = extractSystems(parsed.ast, 100, parsed.diagnostics);
  return { ...result, diagnostics: [...parsed.diagnostics, ...result.diagnostics].sort((a, b) => a.line - b.line) };
};
const HEAD = '#! ia 1.0\n@system s\n  provider "p"\n  version "1.0.0"\n  discriminators\n';
const entry = (rows: string) =>
  `${HEAD}    agent lowers to binding\n      category capability\n      facets [head]\n      schema @schema Agent\n${rows}`;

describe('lowering rows', () => {
  it('reads artifact-set, primitive and move as closed kernel values', () => {
    const { systems, diagnostics } = extract(
      entry('      artifact-set operational\n      primitive Attention\n      move Delegation\n'),
    );
    expect(diagnostics).toEqual([]);
    expect(systems[0]!.entries[0]).toMatchObject({
      keyword: 'agent',
      artifactSet: 'operational',
      primitive: 'Attention',
      move: 'Delegation',
    });
  });

  it('leaves an entry without the rows unchanged', () => {
    const { systems, diagnostics } = extract(entry(''));
    expect(diagnostics).toEqual([]);
    const first = systems[0]!.entries[0]!;
    expect('artifactSet' in first).toBe(false);
    expect('primitive' in first).toBe(false);
    expect('move' in first).toBe(false);
  });

  it('refuses a row whose value is outside the kernel and keeps the system', () => {
    for (const row of ['      artifact-set widget\n', '      primitive Guessing\n', '      move Wandering\n']) {
      const { systems, diagnostics } = extract(entry(row));
      expect(systems).toHaveLength(1);
      expect(systems[0]!.entries).toEqual([]);
      expect(diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REGISTRATION-INCOMPLETE', 10]]);
    }
  });
});
