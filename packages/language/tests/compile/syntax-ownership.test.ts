import { describe, expect, it } from 'vitest';
import { parse, buildRegistry, compile } from '../../src/index.js';
import type { Location } from '../../src/index.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const built = buildRegistry([]);

describe('compile syntax ownership', () => {
  it.each([
    '    cites @schema x when',
    '    cites @schema x#',
    '    cites @schema x\n      when phase is "unfinished',
    '    cites @schema x\n       when phase is act',
  ])('refuses the owning record once without losing a valid sibling: %s', (line) => {
    const parsed = parse(`#! ia 1.0\n@schema broken\n  relationships\n${line}\n@schema intact\n`, 'a.ia');
    expect(parsed.diagnostics).toHaveLength(1);
    const serialized = JSON.parse(JSON.stringify(parsed.ast));
    expect(serialized.syntaxDiagnostics).toEqual(parsed.diagnostics);
    const result = compile(serialized, built.registry, location, []);
    expect(result.diagnostics).toEqual([]);
    expect(result.records.map((r) => r.name)).toEqual(['intact']);
  });

  it('attributes a trailing refused nested line to the nested record alone', () => {
    const parsed = parse(
      '#! ia 1.0\n@schema outer\n  children\n    @schema broken\n      relationships\n        cites @schema x when\n@schema sibling\n',
      'a.ia',
    );
    const result = compile(JSON.parse(JSON.stringify(parsed.ast)), built.registry, location, []);
    expect(result.diagnostics).toEqual([]);
    expect(result.records.map((r) => r.name)).toEqual(['outer', 'sibling']);
  });

  it('removes descendants of a syntax-refused enclosing record', () => {
    const parsed = parse(
      '#! ia 1.0\n@schema outer\n  broken "unfinished\n  children\n    @schema child\n@schema sibling\n',
      'a.ia',
    );
    expect(parsed.diagnostics).toHaveLength(1);
    expect(compile(parsed.ast, built.registry, location, []).records.map((r) => r.name)).toEqual(['sibling']);
  });

  it('does not change clean AST serialization', () => {
    expect(parse('#! ia 1.0\n@schema clean\n', 'a.ia').ast).not.toHaveProperty('syntaxDiagnostics');
    expect(parse('#! ia 1.0\n@schema clean\n', 'a.ia').ast).not.toHaveProperty('syntaxRecordSpans');
  });
  it.each(['@schema invalid when phase is act', 'unexpected top-level words'])(
    'preserves a valid preceding record beside a refused top-level construct: %s',
    (invalid) => {
      const parsed = parse(`#! ia 1.0\n@schema valid\n${invalid}\n@schema next\n`, 'a.ia');
      expect(parsed.diagnostics).toHaveLength(1);
      const result = compile(JSON.parse(JSON.stringify(parsed.ast)), built.registry, location, []);
      expect(result.records.map((r) => r.name)).toEqual(['valid', 'next']);
      expect(result.diagnostics).toEqual([]);
    },
  );
  it('keeps a malformed nested header independent of valid parent and sibling records', () => {
    const parsed = parse(
      '#! ia 1.0\n@schema parent\n  children\n    @schema child\n    @schema invalid when phase is act\n      body "consumed"\n    @schema next\n',
      'a.ia',
    );
    expect(parsed.diagnostics).toHaveLength(1);
    const result = compile(JSON.parse(JSON.stringify(parsed.ast)), built.registry, location, []);
    expect(result.records.map((r) => r.name)).toEqual(['parent', 'child', 'next']);
    expect(result.diagnostics).toEqual([]);
  });
});
