import { describe, expect, it } from 'vitest';
import { parse, buildRegistry } from '../../src/index.js';
import type { Location } from '../../src/index.js';
import { validateCase } from '../../src/semantic/cases.js';
import type { CompiledEdge } from '../../src/semantic/types.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const vocabulary = parse(
  `#! ia 1.0
@system compliance
  provider "test"
  version "1.0.0"
  discriminators
    contract lowers to contract
      category rule
      facets [head, signature]
      schema @schema contract
    case lowers to check
      category evidence
      facets [head]
      schema @schema case
@schema contract
  lowers to contract
  sections
    open
@schema case
  lowers to check
  sections
    open
`,
  'vocabulary.ia',
);
const built = buildRegistry([{ ...vocabulary, location }]);
const registry = built.registry;
const binding: CompiledEdge = {
  predicate: 'implement',
  direction: 'out',
  reference: { kind: 'ref', discriminator: 'contract', name: 'signature', fragment: 'REQ-A-1' },
  target: null,
  fragment: 'REQ-A-1',
  span: { line: 2, endLine: 2 },
};
const rows = ['kind success', 'given "input"', 'request "act"', 'expected "output"', 'evaluator "reviewer"'];
const scenario = (lines: readonly string[] = rows) => `  scenario\n${lines.map((line) => `    ${line}`).join('\n')}`;
function read(
  body = scenario(),
  edges: readonly CompiledEdge[] = [binding],
  refusedBindings: ReadonlySet<'govern' | 'implement'> = new Set(),
  word = 'case',
) {
  const parsed = parse(`#! ia 1.0\n@${word} demo\n${body}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return validateCase(parsed.ast.records[0]!, 'a.ia', registry, edges, refusedBindings);
}
describe('case shape', () => {
  it('uses an admitted vocabulary', () => expect(built.diagnostics).toEqual([]));
  it.each(['success', 'failure', 'refusal', 'resumption', 'escalation'])(
    'accepts %s with a retained dangling binding',
    (kind) => {
      expect(read(scenario([`kind ${kind}`, ...rows.slice(1)]))).toEqual({ valid: true, diagnostics: [] });
    },
  );
  it('accepts prose fields and leaves quoted verdict ordinary content', () => {
    const result = read(
      scenario(['kind success', 'given """input"""', 'request "verdict"', 'expected "output"', 'evaluator "reviewer"']),
    );
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
  it.each(rows.map((r) => r.split(' ')[0]!))('diagnoses missing %s once', (key) => {
    const result = read(scenario(rows.filter((r) => !r.startsWith(`${key} `))));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-MALFORMED']);
    expect(result.diagnostics[0]!.message).toContain(key);
  });
  it.each([
    'kind unknown',
    'kind Success',
    'given bare',
    'given @contract x',
    'given [x]',
    'given "text"\n      extra "no"',
  ])('refuses malformed %s without also reporting it missing', (line) => {
    const key = line.split(' ')[0]!;
    const result = read(scenario(rows.map((r) => (r.startsWith(`${key} `) ? line : r))));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-MALFORMED']);
  });
  it('reports every duplicate required field without judging the refused scenario again', () => {
    const result = read(scenario([...rows, 'given "another"', 'given "third"']));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.line)).toEqual([5, 9, 10]);
  });
  it('requires exactly one scenario block', () => {
    expect(read('').diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-MALFORMED']);
    const result = read(`${scenario()}\n${scenario()}`);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.line)).toEqual([3, 9]);
  });
  it.each(['  verdict "pass"\n', ''])('refuses authored verdict at the appropriate depth', (head) => {
    const result = head ? read(head + scenario()) : read(scenario([...rows, 'verdict "pass"']));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-MALFORMED']);
  });
  it('refuses scenario conditions as a unit without duplicate shape diagnostics', () => {
    const result = read(scenario(rows.map((r) => (r.startsWith('given ') ? `${r} when phase is act` : r))));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CONDITION-MISPLACED']);
  });
  it('refuses a verdict block at record depth without judging its contents', () => {
    const result = read(`${scenario()}\n  verdict\n    outcome "pass" when phase is act`);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CASE-MALFORMED', 9]]);
  });
  it('leaves other schema-governed fields and nested records available', () => {
    const result = read(
      `${scenario([...rows, 'note "extra context"'])}\n    @case child\n      scenario\n        verdict "not the parent"`,
    );
    expect(result).toEqual({ valid: true, diagnostics: [] });
  });
  it('does not dispatch on lowered check kind alone or an unregistered word', () => {
    expect(read('', [], new Set(), 'check')).toEqual({ valid: true, diagnostics: [] });
    const record = parse('#! ia 1.0\n@case demo\n', 'a.ia').ast.records[0]!;
    expect(validateCase(record, 'a.ia', buildRegistry([]).registry, [], new Set())).toEqual({
      valid: true,
      diagnostics: [],
    });
  });
});

describe('case binding', () => {
  it.each([
    { ...binding, predicate: 'cite' as const },
    { ...binding, direction: 'in' as const },
    { ...binding, fragment: 'act/Decision' },
    { ...binding, fragment: 'REQ-' },
    {
      ...binding,
      reference: { kind: 'ref' as const, discriminator: 'schema', name: 'signature', fragment: 'REQ-A-1' },
    },
    {
      ...binding,
      reference: { kind: 'identity' as const, identity: 'other/contract/head/signature', fragment: 'REQ-A-1' },
    },
  ])('refuses an independent wrong binding %o', (edge) => {
    expect(read(scenario(), [edge]).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-UNBOUND']);
  });
  it('requires a binding and a requirement fragment', () => {
    expect(read(scenario(), []).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-UNBOUND']);
    const { fragment: _fragment, ...noFragment } = binding;
    expect(read(scenario(), [noFragment]).diagnostics.map((d) => d.code)).toEqual(['IA-LANG-CASE-UNBOUND']);
  });
  it('accepts canonical qualified contract identity and defers fragment existence', () => {
    const edge: CompiledEdge = {
      ...binding,
      reference: { kind: 'identity', identity: 'compliance/contract/signature/missing', fragment: 'REQ-NOT-DECLARED' },
      fragment: 'REQ-NOT-DECLARED',
    };
    expect(read(scenario(), [edge])).toEqual({ valid: true, diagnostics: [] });
  });
  it('does not repeat a refused intended implement binding', () => {
    expect(read(scenario(), [], new Set(['implement']))).toEqual({ valid: true, diagnostics: [] });
  });
});
