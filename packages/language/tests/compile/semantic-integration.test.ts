import { describe, expect, it } from 'vitest';
import { parse, buildRegistry, compile } from '../../src/index.js';
import type { CompiledRecord, Location } from '../../src/index.js';
import { PREDICATES } from '../../src/taxonomy.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const words = [
  ['playbook', 'governance'],
  ['contract', 'contract'],
  ['case', 'check'],
] as const;
const vocabulary = parse(
  `#! ia 1.0\n@system work\n  provider "test"\n  version "1.0.0"\n  discriminators\n${words.map(([word, kind]) => `    ${word} lowers to ${kind}\n      category process\n      facets [head]\n      schema @schema ${word}`).join('\n')}\n  edges\n${PREDICATES.map((p) => `    ${p} * using *`).join('\n')}\n${words.map(([word, kind]) => `@schema ${word}\n  lowers to ${kind}\n  sections\n    open`).join('\n')}\n`,
  'vocabulary.ia',
);
const built = buildRegistry([{ ...vocabulary, location }]);
const registry = built.registry;
function run(body: string, path = 'a.ia', pool: readonly CompiledRecord[] = []) {
  const parsed = parse(`#! ia 1.0\n${body}\n`, path);
  expect(parsed.diagnostics).toEqual([]);
  return compile(parsed.ast, registry, location, pool);
}

describe('semantic compiler orchestration', () => {
  it('uses a valid explicit vocabulary', () => expect(built.diagnostics).toEqual([]));
  it.each([
    '@playbook first\n  relationships\n    cites @playbook second\n@playbook second',
    '@playbook second\n@playbook first\n  relationships\n    cites @playbook second',
  ])('resolves forward and backward references independently of source order', (body) => {
    const result = run(body);
    expect(result.diagnostics).toEqual([]);
    expect(result.records.find((r) => r.name === 'first')!.edges[0]!.target).toBe('work/governance/head/second');
  });
  it('resolves self, parent and nested targets after identity discovery', () => {
    const result = run(
      '@playbook parent\n  relationships\n    cites @playbook child\n    uses @playbook parent\n  children\n    @playbook child\n      relationships\n        cites @playbook parent',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.records[0]!.edges.map((e) => e.target)).toEqual([
      'work/governance/head/child',
      'work/governance/head/parent',
    ]);
    expect(result.records[1]!.edges.map((e) => e.target)).toEqual(['work/governance/head/parent']);
  });
  it('excludes identity collisions and their descendants before matching', () => {
    const result = run(
      '@playbook collision\n  children\n    @playbook child\n@playbook collision\n@playbook observer\n  relationships\n    cites @playbook collision\n    cites @playbook child',
    );
    expect(result.records.map((r) => r.name)).toEqual(['observer']);
    expect(result.records[0]!.edges.map((e) => e.target)).toEqual([null, null]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-IDENTITY-COLLISION',
      'IA-LANG-IDENTITY-COLLISION',
      'IA-LANG-EDGE-TARGET-MISSING',
      'IA-LANG-EDGE-TARGET-MISSING',
    ]);
    expect(result.sourceMap.map((m) => m.identity)).toEqual(['work/governance/head/observer']);
  });
  it('combines external and local candidates without picking one ambiguous occurrence', () => {
    const pool = run('@playbook target', 'external.ia').records;
    expect(
      run('@playbook observer\n  relationships\n    cites @playbook target', 'a.ia', pool).records[0]!.edges[0]!.target,
    ).toBe(pool[0]!.identity);
    const ambiguous = run(
      '@playbook target\n@playbook observer\n  relationships\n    cites @playbook target',
      'a.ia',
      pool,
    );
    expect(ambiguous.records[1]!.edges).toEqual([]);
    expect(ambiguous.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-TARGET-AMBIGUOUS']);
  });
  it('enforces external-pool consistency and current-file exclusion', () => {
    const record = run('@playbook target').records[0]!;
    expect(() => run('@playbook observer', './a.ia', [record])).toThrow(TypeError);
    expect(() => run('@playbook observer', 'elsewhere.ia', [{ ...record, system: 'wrong' }])).toThrow(TypeError);
  });
  it('populates every semantic array and its parallel spans while preserving raw fields', () => {
    const result = run(`@contract signature
  cognition
    act
      primary Decision
      Decision means """
        Act on the grounded request.
      """
        when phase is act
  activation
    activate when kind is contract
  governance
    severity blocking
    requires "baseline"
    requires "extra" when phase is act
  inputs
    REQ-A-1 "objective"
      when phase is act
  relationships
    governs @playbook method
@playbook method`);
    expect(result.diagnostics).toEqual([]);
    const record = result.records[0]!;
    const map = result.sourceMap[0]!;
    expect(record.cells).toHaveLength(1);
    expect(record.selectors).toEqual([[{ axis: 'kind', value: 'contract' }]]);
    expect(record.variants).toHaveLength(2);
    expect(record.requirements).toHaveLength(1);
    expect(record.edges).toHaveLength(1);
    for (const key of ['cells', 'variants', 'requirements', 'edges'] as const)
      expect(map[key]).toEqual(record[key].map((v) => v.span));
    expect(map.selectors).toEqual([{ line: 11, endLine: 11 }]);
    expect(map.cells).toEqual([{ line: 6, endLine: 9 }]);
    expect(map.requirements).toEqual([{ line: 17, endLine: 18 }]);
    expect(map.fields.some((field) => field.path === 'cognition.act.Decision means')).toBe(true);
    expect(record.sections.find((s) => s.name === 'relationships')!.fields).toHaveLength(1);
  });
  it('removes every local duplicate requirement and preserves survivor map spans', () => {
    const result = run(
      '@contract one\n  relationships\n    governs @playbook target\n  inputs\n    REQ-DUP "one"\n    REQ-GOOD "survives"\n@contract two\n  relationships\n    governs @playbook target\n  outputs\n    REQ-DUP "two"\n@playbook target',
    );
    expect(result.records[0]!.requirements.map((r) => r.id)).toEqual(['REQ-GOOD']);
    expect(result.records[1]!.requirements).toEqual([]);
    expect(result.sourceMap[0]!.requirements).toEqual([{ line: 7, endLine: 7 }]);
    expect(result.sourceMap[1]!.requirements).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-REQUIREMENT-DUPLICATE',
      'IA-LANG-REQUIREMENT-DUPLICATE',
    ]);
  });
  it('does not repeat bad binding or legacy dialect faults as unbound', () => {
    const contract = run('@contract one\n  relationships\n    governs "bad target"');
    expect(contract.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-MALFORMED']);
    const retired = run(
      '@contract one\n  binds "legacy" when phase is act\n  schema\n    field "old" when phase is act',
    );
    expect(retired.diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-CONTRACT-BINDS-RETIRED',
      'IA-LANG-CONTRACT-SCHEMA-SECTION',
    ]);
    const scenario = run(
      '@case one\n  verdict "pass" when phase is act\n  scenario\n    kind success\n    given "input"\n    request "act"\n    expected "output"\n    evaluator "review"\n  relationships\n    implements @contract missing#REQ-A when phase is unknown',
    );
    expect(scenario.diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-CASE-MALFORMED',
      'IA-LANG-CONDITION-VALUE-UNKNOWN',
    ]);
  });
  it('validates a complete case-to-contract-to-playbook chain', () => {
    const result = run(
      '@case example\n  scenario\n    kind success\n    given "input"\n    request "act"\n    expected "output"\n    evaluator "review"\n  relationships\n    implements @contract signature#REQ-A-1\n@contract signature\n  inputs\n    REQ-A-1 "objective"\n  relationships\n    governs @playbook method\n@playbook method',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.records[0]!.edges[0]).toMatchObject({ target: 'work/contract/head/signature', fragment: 'REQ-A-1' });
    expect(result.records[1]!.requirements[0]!.id).toBe('REQ-A-1');
  });
  it('collapses explicit registration ground without losing its authored field span', () => {
    const parsed = parse(
      '#! ia 1.0\n@system tiny\n  provider "test"\n  version "1.0.0"\n  discriminators\n    playbook lowers to governance\n      category process\n      facets [head]\n      schema @schema tiny\n  relationships\n    grounds @schema tiny\n@schema tiny\n  lowers to governance\n  sections\n    open\n',
      'tiny.ia',
    );
    const local = buildRegistry([{ ...parsed, location }]);
    const result = compile(parsed.ast, local.registry, location, []);
    expect([...local.diagnostics, ...result.diagnostics]).toEqual([]);
    expect(result.records[0]!.edges).toHaveLength(1);
    expect(result.sourceMap[0]!.edges).toEqual([{ line: 6, endLine: 9 }]);
    expect(result.sourceMap[0]!.fields).toContainEqual({
      path: 'relationships.grounds',
      span: { line: 11, endLine: 11 },
    });
  });
  it('lowers nested products independently of parent conditions', () => {
    const result = run(
      '@playbook parent\n  governance\n    requires "parent" when phase is plan\n  children\n    @playbook child\n      cognition\n        act\n          primary Decision when phase is act\n          Decision means "child"\n      governance\n        requires "child" when phase is act',
    );
    expect(result.records.map((r) => r.variants.map((v) => v.condition))).toEqual([
      [[{ axis: 'phase', value: 'plan' }]],
      [[{ axis: 'phase', value: 'act' }]],
    ]);
    expect(result.records[1]!.cells).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CONDITION-MISPLACED', 9]]);
  });
  it('returns one primary refusal and no product for malformed carriers', () => {
    const result = run(
      '@playbook one\n  cognition\n    act\n      Decision means "bad" when phase is unknown\n      Memory means "valid"\n  activation\n    activate when phase is unknown\n    activate when phase is act\n  governance\n    requires "bad" when phase is unknown\n    requires "valid"\n  relationships\n    cites @playbook one when phase is unknown\n  notes\n    state active when phase is act',
    );
    expect(result.diagnostics).toHaveLength(5);
    const [record] = result.records;
    expect(record!.cells.map((c) => c.primitive)).toEqual(['Memory']);
    expect(record!.selectors).toHaveLength(1);
    expect(record!.variants).toHaveLength(1);
    expect(record!.edges).toEqual([]);
    expect(result.sourceMap[0]!.cells).toEqual([{ line: 6, endLine: 6 }]);
    expect(result.sourceMap[0]!.selectors).toEqual([{ line: 9, endLine: 9 }]);
  });
  it('does not duplicate registry-owned conditions or emit schema fallback products', () => {
    const parsed = parse(
      '#! ia 1.0\n@system broken\n  provider "test" when phase is act\n  version "1.0.0"\n@schema shape\n  lowers to definition\n  sections\n    open\n  activation\n    activate when phase is unknown\n',
      'faults.ia',
    );
    const local = buildRegistry([{ ...parsed, location }]);
    const result = compile(parsed.ast, local.registry, location, []);
    expect([...local.diagnostics, ...result.diagnostics].map((d) => d.code)).toEqual([
      'IA-LANG-CONDITION-MISPLACED',
      'IA-LANG-SCHEMA-MALFORMED',
    ]);
    expect(result.records.find((r) => r.name === 'shape')!.selectors).toEqual([]);
  });
  it.each(['', '    note "nested fault" when phase is plan\n'])(
    'refuses a schema-level when block once through the registry owner: %s',
    (nested) => {
      const parsed = parse(
        `#! ia 1.0\n@schema shape\n  lowers to definition\n  sections\n    open\n  when\n    phase is act\n${nested}`,
        'faults.ia',
      );
      const local = buildRegistry([{ ...parsed, location }]);
      const result = compile(parsed.ast, local.registry, location, []);
      expect([...local.diagnostics, ...result.diagnostics].map((d) => [d.code, d.line])).toEqual([
        ['IA-LANG-SCHEMA-MALFORMED', 6],
      ]);
      expect(local.registry.schemas.has('shape')).toBe(false);
    },
  );
  it('aggregates parser refusal once and preserves a valid sibling semantic product', () => {
    const parsed = parse(
      '#! ia 1.0\n@playbook broken\n  relationships\n    cites @playbook good when\n@playbook good\n  cognition\n    act\n      Decision means "do"\n',
      'a.ia',
    );
    const local = buildRegistry([
      { ...vocabulary, location },
      { ...parsed, location },
    ]);
    const result = compile(JSON.parse(JSON.stringify(parsed.ast)), local.registry, location, []);
    expect([...local.diagnostics, ...result.diagnostics].map((d) => d.code)).toEqual(['IA-LANG-VALUE-TRAILING']);
    expect(result.records.map((r) => r.name)).toEqual(['good']);
    expect(result.records[0]!.cells).toHaveLength(1);
  });
  it('is repeatable without mutating AST, registry or external products', () => {
    const parsed = parse('#! ia 1.0\n@playbook source\n  relationships\n    cites @playbook target\n', 'a.ia');
    const pool = Object.freeze(run('@playbook target', 'target.ia').records);
    const before = JSON.stringify([parsed.ast, [...registry.registrations], pool]);
    const first = compile(parsed.ast, registry, location, pool);
    expect(compile(parsed.ast, registry, location, pool)).toEqual(first);
    expect(JSON.stringify([parsed.ast, [...registry.registrations], pool])).toBe(before);
  });
});
