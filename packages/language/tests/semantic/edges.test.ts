import { describe, expect, it } from 'vitest';
import { parse, buildRegistry, compile } from '../../src/index.js';
import type { CompiledRecord, FrozenRegistry, Location } from '../../src/index.js';
import { PREDICATES, PREDICATE_PAIRS } from '../../src/taxonomy.js';
import { readEdges } from '../../src/semantic/edges.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const allRows = PREDICATES.map((p) => `${p} * using *`);
function vocabulary(sourceRows = allRows, targetRows = allRows) {
  const system = (name: string, word: string, rows: string[]) =>
    `@system ${name}\n  provider "test"\n  version "1.0.0"\n  discriminators\n    ${word} lowers to binding\n      category capability\n      facets [head]\n      schema @schema actor\n  edges\n${rows.map((r) => `    ${r}`).join('\n')}\n`;
  const parsed = parse(
    `#! ia 1.0\n${system('agents', 'agent', sourceRows)}${system('tools', 'tool', targetRows)}@schema actor\n  lowers to binding\n  sections\n    closed\n`,
    'vocabulary.ia',
  );
  const built = buildRegistry([{ ...parsed, location }]);
  expect(built.diagnostics).toEqual([]);
  return { registry: built.registry, ast: parsed.ast };
}
const base = vocabulary();
const candidate = (word: string, name: string, path: string, registry = base.registry) =>
  compile(parse(`#! ia 1.0\n@${word} ${name}\n`, path).ast, registry, location, []).records[0]!;
const target = candidate('tool', 'Target', 'target.ia');
function read(line: string, registry: FrozenRegistry = base.registry, pool: readonly CompiledRecord[] = [target]) {
  const parsed = parse(`#! ia 1.0\n@agent source\n  relationships\n    ${line}\n`, 'source.ia');
  expect(parsed.diagnostics).toEqual([]);
  const source = candidate('agent', 'source', 'source.ia', registry);
  return readEdges(parsed.ast.records[0]!, source, registry, pool);
}

describe('relationship lowering', () => {
  it.each(PREDICATE_PAIRS)('lowers active %s and inverse %s with consent', (predicate, inverse) => {
    for (const [phrase, direction] of [
      [predicate, 'out'],
      [inverse, 'in'],
    ]) {
      const result = read(`${phrase} @tool Target`);
      expect(result.diagnostics).toEqual([]);
      expect(result.edges).toEqual([
        {
          predicate,
          direction,
          reference: { kind: 'ref', discriminator: 'tool', name: 'Target' },
          target: target.identity,
          span: { line: 4, endLine: 4 },
        },
      ]);
    }
  });
  it.each([
    ['governs', 'govern'],
    ['enforces', 'enforce'],
    ['grounds', 'ground'],
    ['constrains', 'constrain'],
    ['implements', 'implement'],
    ['produces', 'produce'],
    ['consumes', 'consume'],
    ['records lineage from', 'record-lineage-from'],
    ['grants access to', 'grant-access-to'],
    ['runs before', 'run-before'],
    ['triggers', 'trigger'],
    ['cites', 'cite'],
    ['supersedes', 'supersede'],
    ['requires', 'require'],
    ['uses', 'use'],
    ['forbids', 'forbid'],
    ['routes to', 'route'],
    ['lands at', 'land'],
  ])('lowers present phrase %s with a qualified target', (phrase, predicate) => {
    expect(read(`${phrase} ${target.identity}`).edges[0]).toMatchObject({
      predicate,
      direction: 'out',
      target: target.identity,
      reference: { kind: 'identity', identity: target.identity },
    });
  });
  it.each(['@tool Target#act/Decision', 'tools/binding/head/target#REQ-X-1'])('keeps fragment for %s', (reference) => {
    const result = read(`uses ${reference}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.edges[0]!.fragment).toBe(reference.split('#')[1]);
    expect(result.edges[0]!.reference.fragment).toBe(result.edges[0]!.fragment);
  });
  it.each([' when phase is ACT', '\n      when phase is ACT'])('retains condition: %s', (condition) => {
    const result = read(`uses @tool Target${condition}`);
    expect(result.edges[0]).toMatchObject({
      condition: [{ axis: 'phase', value: 'act' }],
      span: { line: 4, endLine: condition.startsWith('\n') ? 5 : 4 },
    });
    expect(result.diagnostics).toEqual([]);
  });
  it('keeps a missing target and warning with authored reference/fragment', () => {
    const result = read('uses @tool Missing#act/Decision');
    expect(result.edges[0]).toMatchObject({
      target: null,
      fragment: 'act/Decision',
      reference: { kind: 'ref', discriminator: 'tool', name: 'Missing', fragment: 'act/Decision' },
    });
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.line])).toEqual([
      ['IA-LANG-EDGE-TARGET-MISSING', 'warning', 4],
    ]);
  });
  it('refuses ambiguity without consent or missing-target cascades', () => {
    const result = read('uses @tool Target', base.registry, [
      target,
      { ...target, source: { ...target.source, path: 'another.ia' } },
    ]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-TARGET-AMBIGUOUS']);
  });
  it.each([
    'cites',
    'cites plain-name',
    'cites "@tool Target"',
    'cites [target]',
    'cites a/b/c',
    'cites tools/unknown/head/target',
    'cites tools/binding/head/target#',
    'cites tools/binding/head/target#act//Decision',
    'cites tools/binding/head/target extra',
    'cites extra @tool Target',
    '- target',
    'cites @tool Target\n      extra "bad"',
  ])('refuses malformed edge %s once', (line) => {
    const result = read(line);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-MALFORMED']);
  });
  it('unknown verb owns the fault without trying to judge its target', () => {
    const result = read('not-a-verb "wrong target" when phase is missing');
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-VERB-UNKNOWN']);
    expect(result.diagnostics[0]!.message).toContain('records lineage from');
  });
  it.each([' when phase is missing', ' when phase is act\n      when phase is plan'])(
    'condition failure refuses the complete edge: %s',
    (condition) => {
      const result = read(`governs @tool Target${condition}`);
      expect(result.edges).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect([...result.refusedBindings]).toEqual(['govern']);
    },
  );
  it('owns standalone and unsupported descendant condition placement', () => {
    for (const line of ['when phase is act', 'uses @tool Target\n      extra\n        when phase is act']) {
      expect(read(line).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
      expect(read(line).edges).toEqual([]);
    }
  });
  it('keeps the offending child condition line on its diagnostic', () => {
    const result = read('uses @tool Target\n      when phase is missing');
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CONDITION-VALUE-UNKNOWN', 5]]);
  });
  it('never extracts from head fields, prose or a nested record', () => {
    const parsed = parse(
      '#! ia 1.0\n@agent source\n  cites @tool Target\n  meaning\n    says "cites @tool Target"\n  relationships\n    @agent nested\n      relationships\n        cites @tool Target\n',
      'source.ia',
    );
    const result = readEdges(parsed.ast.records[0]!, candidate('agent', 'source', 'source.ia'), base.registry, [
      target,
    ]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('logical consent', () => {
  it.each([
    [[], ['cite tool using agent'], 'source', 'agents'],
    [['cite tool using agent'], [], 'target', 'tools'],
    [[], [], 'source', 'agents'],
    [['cite agent using agent', 'cite tool using tool'], allRows, 'source', 'agents'],
  ] as const)('reports just the first refusing side: %o', (sourceRows, targetRows, side, system) => {
    const { registry } = vocabulary([...sourceRows], [...targetRows]);
    const result = read('cites @tool Target', registry);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'IA-LANG-EDGE-UNCONSENTED',
      message: expect.stringContaining(`${side} system ${system}`),
    });
  });
  it('swaps endpoints for inverse verbs before checking either ledger', () => {
    const { registry } = vocabulary(['use agent using tool'], ['use agent using tool']);
    expect(read('used-by @tool Target', registry).diagnostics).toEqual([]);
    const failed = read('uses @tool Target', registry);
    expect(failed.edges).toEqual([]);
    expect(failed.diagnostics[0]!.code).toBe('IA-LANG-EDGE-UNCONSENTED');
  });
  it('names the logical source on inbound refusal', () => {
    const { registry } = vocabulary(allRows, []);
    expect(read('used-by @tool Target', registry).diagnostics[0]!.message).toContain('source system tools');
  });
  it('checks same-system edges against the ledger', () => {
    const peer = candidate('agent', 'peer', 'peer.ia');
    expect(read('cites @agent peer', base.registry, [peer]).diagnostics).toEqual([]);
    expect(read('cites @agent peer', vocabulary([], allRows).registry, [peer]).diagnostics).toHaveLength(1);
  });
  it('rejects unregistered caller candidates before mistaking undefined consent for permission', () => {
    expect(() => read('cites @tool Target', base.registry, [{ ...target, discriminator: 'unknown' }])).toThrow(
      TypeError,
    );
  });
});

describe('registration ground equivalence', () => {
  function ground(line: string) {
    const system = base.ast.records[0]!;
    const authored = parse(`#! ia 1.0\n@system agents\n  relationships\n    ${line}\n`, 'vocabulary.ia').ast
      .records[0]!;
    const compiled = compile(base.ast, base.registry, location, []).records.find((r) => r.name === system.name)!;
    const pool = compile(base.ast, base.registry, location, []).records.filter((r) => r.discriminator === 'schema');
    return { generated: compiled.edges, result: readEdges(authored, compiled, base.registry, pool, compiled.edges) };
  }
  it.each(['grounds @schema actor', 'ground floor/contract/head/actor'])(
    'consumes equivalent explicit %s, preserving the generated span',
    (line) => {
      const { generated, result } = ground(line);
      expect(result.edges).toEqual(generated);
      expect(result.diagnostics).toEqual([]);
    },
  );
  it('does not give conditioned or fragment ground an exemption', () => {
    for (const line of ['grounds @schema actor when phase is act', 'grounds @schema actor#REQ-X-1']) {
      const { generated, result } = ground(line);
      expect(result.edges).toEqual(generated);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-EDGE-UNCONSENTED']);
    }
  });
  it('keeps unrelated missing ground as an ordinary warning', () => {
    const { generated, result } = ground('grounds @schema elsewhere');
    expect(result.edges).toHaveLength(generated.length + 1);
    expect(result.diagnostics[0]!.code).toBe('IA-LANG-EDGE-TARGET-MISSING');
  });
});
