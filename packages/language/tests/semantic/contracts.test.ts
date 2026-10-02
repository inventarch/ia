import { describe, expect, it } from 'vitest';
import { parse, buildRegistry } from '../../src/index.js';
import type { Location } from '../../src/index.js';
import { readContract } from '../../src/semantic/contracts.js';
import { REQUIREMENT_KINDS } from '../../src/semantic/types.js';
import type { CompiledEdge } from '../../src/semantic/types.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const vocabulary = parse(
  '#! ia 1.0\n@system compliance\n  provider "test"\n  version "1.0.0"\n  discriminators\n    contract lowers to contract\n      category rule\n      facets [head]\n      schema @schema contract\n@schema contract\n  lowers to contract\n  sections\n    open\n',
  'vocabulary.ia',
);
const { registry } = buildRegistry([{ ...vocabulary, location }]);
const binding: CompiledEdge = {
  predicate: 'govern',
  direction: 'out',
  reference: { kind: 'ref', discriminator: 'playbook', name: 'method' },
  target: null,
  span: { line: 2, endLine: 2 },
};
function read(
  body: string,
  edges: readonly CompiledEdge[] = [binding],
  refusedBindings: ReadonlySet<'govern' | 'implement'> = new Set(),
  word = 'contract',
) {
  const parsed = parse(`#! ia 1.0\n@${word} demo\n${body}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return readContract(parsed.ast.records[0]!, 'a.ia', registry, edges, refusedBindings);
}
describe('contract clauses', () => {
  it.each(REQUIREMENT_KINDS)('reads %s', (kind) => {
    expect(read(`  ${kind}\n    REQ-A-1 "text"`)).toEqual({
      requirements: [{ id: 'REQ-A-1', kind, text: 'text', span: { line: 4, endLine: 4 } }],
      diagnostics: [],
    });
  });
  it('folds prose and retains child conditions and spans', () => {
    const result = read(
      '  inputs\n    REQ-A-1 """\n      First line\n      second line.\n    """\n      when phase is ACT',
    );
    expect(result.requirements[0]).toEqual({
      id: 'REQ-A-1',
      kind: 'inputs',
      text: 'First line second line.',
      condition: [{ axis: 'phase', value: 'act' }],
      span: { line: 4, endLine: 8 },
    });
    expect(result.diagnostics).toEqual([]);
  });
  it.each([
    'req-A "text"',
    'REQ- "text"',
    'REQ-a "text"',
    'REQ-A- "text"',
    'REQ-A bare',
    'REQ-A @contract other',
    'REQ-A [text]',
    'REQ-A extra "text"',
    'REQ-A "text"\n      extra "no"',
    '- text',
  ])('refuses malformed clause %s without losing valid siblings', (line) => {
    const result = read(`  inputs\n    ${line}\n    REQ-GOOD "yes"`);
    expect(result.requirements.map((r) => r.id)).toEqual(['REQ-GOOD']);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-REQUIREMENT-MALFORMED']);
  });
  it.each([
    ' when phase is missing',
    ' when phase is act\n      when phase is plan',
    '\n      extra\n        when phase is act',
  ])('never drops a refused condition into fallback: %s', (condition) => {
    const result = read(`  inputs\n    REQ-A "text"${condition}`);
    expect(result.requirements).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });
  it('retains inline conditions', () => {
    expect(read('  inputs\n    REQ-A "text" when phase is ACT').requirements[0]!.condition).toEqual([
      { axis: 'phase', value: 'act' },
    ]);
  });
  it('leaves duplicate occurrence checking to the compile/tree aggregation stage', () => {
    expect(read('  inputs\n    REQ-A "one"\n  outputs\n    REQ-A "two"').requirements).toHaveLength(2);
  });
  it('keeps nested contracts independent', () => {
    expect(
      read('  inputs\n    REQ-A "parent"\n    @contract child\n      inputs\n        REQ-B "child"').requirements.map(
        (r) => r.id,
      ),
    ).toEqual(['REQ-A']);
  });
  it('does not treat a schema as a signature contract', () => {
    expect(read('  schema\n    field "old encoding"', [], new Set(), 'schema')).toEqual({
      requirements: [],
      diagnostics: [],
    });
  });
  it('does not dispatch an unregistered contract word', () => {
    const record = parse('#! ia 1.0\n@contract demo\n', 'a.ia').ast.records[0]!;
    expect(readContract(record, 'a.ia', buildRegistry([]).registry, [], new Set())).toEqual({
      requirements: [],
      diagnostics: [],
    });
  });
});

describe('contract binding and retired syntax', () => {
  it('accepts a retained outbound dangling governing edge', () => expect(read('', [binding]).diagnostics).toEqual([]));
  it.each(
    [
      [],
      [{ ...binding, direction: 'in' as const }],
      [{ ...binding, predicate: 'cite' as const }],
      [{ ...binding, predicate: 'require' as const }],
    ].map((edges) => ({ edges })),
  )('reports a missing binding only for independent omission', ({ edges }) => {
    expect(read('', edges).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONTRACT-UNBOUND']);
  });
  it('does not repeat a refused intended governing binding', () => {
    expect(read('', [], new Set(['govern'])).diagnostics).toEqual([]);
  });
  it('refuses quoted binds once, names governs and suppresses derived unbound', () => {
    const result = read('  binds "legacy" when phase is act', []);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONTRACT-BINDS-RETIRED']);
    expect(result.diagnostics[0]!.message).toContain('governs');
  });
  it('refuses a legacy schema block without interpreting its children', () => {
    const result = read('  schema\n    field "REQ | kind | text"\n      when phase is missing');
    expect(result.requirements).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONTRACT-SCHEMA-SECTION']);
    expect(result.diagnostics[0]!.message).toContain('inputs');
  });
});
