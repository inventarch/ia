import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, PHASES, PRIMITIVES, compile, parse } from '@ia/language';
import type { ConditionAxis, Variant } from '@ia/language';
import { load, variants } from '@ia/graph';
import type { Coordinate, Node } from '@ia/graph';
import { validateAdoption, validateVariants } from '../src/index.js';
import type { ClauseEvaluator } from '../src/index.js';
import { inputs, records, registry } from './native.js';

const options = { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const native = load(records, registry, options);
const location = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
function law(body: string): Node {
  const source = { path: 'variants.ia', text: `#! ia 1.0\n@law test\n${body}\n`, location };
  const parsed = parse(source.text, source.path),
    compiled = compile(parsed.ast, registry, location, []);
  expect([...parsed.diagnostics, ...compiled.diagnostics]).toEqual([]);
  return load(compiled.records, registry, { ...options, sources: [source] })
    .nodes.values()
    .next().value!;
}
function witness(node: Node): Coordinate {
  const findings = validateVariants(node).findings;
  expect(findings).toHaveLength(1);
  expect(findings[0]!.code).toBe('IA-COMP-VARIANT-AMBIGUOUS');
  const coordinate = JSON.parse(findings[0]!.message.split('; coordinate ')[1]!) as Coordinate;
  expect(variants(node, coordinate).diagnostics).toHaveLength(1);
  return coordinate;
}
describe('exact finite variant ambiguity', () => {
  it('accepts the actual native corpus', () => {
    for (const node of native.nodes.values()) expect(validateVariants(node).outcome, node.identity).toBe('pass');
  });
  it('names a real witness at equal maximum specificity', () => {
    const node = law(
      '  governance\n    requires "phase" when phase is act\n    requires "primitive" when primitive is Memory',
    );
    expect(witness(node)).toEqual({ phase: 'act', primitive: 'Memory' });
  });
  it('ignores disjoint pairs and pairs dominated by a stronger clause', () => {
    expect(
      validateVariants(
        law('  governance\n    requires "act" when phase is act\n    requires "learn" when phase is learn'),
      ).outcome,
    ).toBe('pass');
    expect(
      validateVariants(
        law(
          '  governance\n    requires "phase" when phase is act\n    requires "primitive" when primitive is Memory\n    requires "both" when phase is act and primitive is Memory',
        ),
      ).outcome,
    ).toBe('pass');
  });
  it('searches outside partial stronger coverage and recognizes a fixed-dimension dominator', () => {
    const partial = law(
      '  governance\n    requires "phase" when phase is act\n    requires "primitive" when primitive is Memory\n    requires "verified" when phase is act and primitive is Memory and move is Verification',
    );
    expect(witness(partial)).toEqual({ phase: 'act', primitive: 'Memory' });
    const fixed = law(
      '  governance\n    requires "phase" when phase is act\n    requires "primitive" when primitive is Memory\n    requires "dominated" when phase is act and provenance is workspace',
    );
    expect(validateVariants(fixed).outcome).toBe('pass');
  });
  it('finds an absent-axis witness when every supplied value would hide the tie', () => {
    const node = law(
      '  governance\n    requires "a" when phase is act\n    requires "b" when primitive is Memory\n' +
        PHASES.map((phase) => `    other "${phase}" when phase is ${phase}`).join('\n'),
    );
    // Same-condition clauses are compiler-owned; exercise the query boundary to
    // prove that absent axes are not erased by finite-domain enumeration.
    const base = {
      ...node,
      variants: [
        { key: 'requires', value: { kind: 'string' as const, text: 'one' }, span: { line: 3, endLine: 3 } },
        { key: 'requires', value: { kind: 'string' as const, text: 'two' }, span: { line: 4, endLine: 4 } },
        ...PHASES.map((phase, i) => ({
          key: 'requires',
          value: { kind: 'string' as const, text: phase },
          condition: [{ axis: 'phase' as const, value: phase }],
          span: { line: i + 5, endLine: i + 5 },
        })),
      ],
    };
    expect(witness(base)).toEqual({});
  });
  it('constrains dimensions to the subject and raises severity only', () => {
    expect(
      validateVariants(
        law(
          '  governance\n    severity blocking\n    requires "severity" when severity is advisory\n    requires "phase" when phase is act',
        ),
      ).outcome,
    ).toBe('pass');
    const raised = law(
      '  governance\n    severity advisory\n    requires "severity" when severity is blocking\n    requires "phase" when phase is act',
    );
    expect(witness(raised)).toEqual({ phase: 'act', severity: 'blocking' });
    expect(
      validateVariants(
        law(
          '  artifact-set evidence\n  governance\n    requires "runtime" when provenance is runtime\n    requires "decision" when artifact-set is decision',
        ),
      ).outcome,
    ).toBe('pass');
  });
  it('handles all variable axes without constructing their Cartesian product', () => {
    const terms: readonly [ConditionAxis, string][] = [
      ['shape', 'governance'],
      ['category', 'rule'],
      ['phase', 'act'],
      ['primitive', 'Memory'],
      ['move', 'Verification'],
      ['kind', 'governance'],
      ['lane', 'authority'],
      ['predicate', 'cite'],
      ['severity', 'blocking'],
    ];
    const node = law(
      '  governance\n' +
        terms.map(([axis, value], i) => `    requires "clause ${i}" when ${axis} is ${value}`).join('\n'),
    );
    witness(node);
  });
  it('agrees with exhaustive evaluation over a bounded two-axis family space', () => {
    const node = law('  governance\n    requires "one" when phase is act');
    const clauses: Variant[] = [
      ...PHASES.map((phase, i) => ({
        key: 'requires',
        value: { kind: 'string' as const, text: phase },
        condition: [{ axis: 'phase' as const, value: phase }],
        span: { line: 3 + i, endLine: 3 + i },
      })),
      ...PRIMITIVES.slice(0, 2).map((primitive, i) => ({
        key: 'requires',
        value: { kind: 'string' as const, text: primitive },
        condition: [{ axis: 'primitive' as const, value: primitive }],
        span: { line: 8 + i, endLine: 8 + i },
      })),
      {
        key: 'requires',
        value: { kind: 'string', text: 'both' },
        condition: [
          { axis: 'phase', value: 'act' },
          { axis: 'primitive', value: 'Memory' },
        ],
        span: { line: 10, endLine: 10 },
      },
    ];
    const coordinates = [undefined, ...PHASES].flatMap((phase) =>
      [undefined, ...PRIMITIVES].map((primitive) => ({
        ...(phase === undefined ? {} : { phase }),
        ...(primitive === undefined ? {} : { primitive }),
      })),
    );
    for (let mask = 0; mask < 1 << clauses.length; mask++) {
      const candidate = { ...node, variants: clauses.filter((_, i) => (mask & (1 << i)) !== 0) };
      const ambiguous = coordinates.some((coordinate) => variants(candidate, coordinate).diagnostics.length > 0);
      expect(validateVariants(candidate).outcome === 'fail', String(mask)).toBe(ambiguous);
    }
  });
});
describe('structural adoption evaluator boundary', () => {
  const contractId = 'compliance-system/contract/signature/foundation-authoring-contract';
  const contract = native.nodes.get(contractId)!;
  const evaluators = (evaluate: ClauseEvaluator) =>
    new Map([[contractId, new Map(contract.requirements.map((r) => [r.id, evaluate]))]]);
  it('does not treat declared coverage as executed adoption', () => {
    const result = validateAdoption(native);
    expect(result).toHaveLength(1);
    expect(result[0]!.outcome).toBe('not-evaluated');
    expect(result[0]!.findings).toHaveLength(3);
    expect(result[0]!.findings.every((f) => f.code === 'IA-COMP-NOT-EVALUATED')).toBe(true);
  });
  it('evaluates every identified clause with its immutable graph/adopter context', () => {
    const observed: string[] = [];
    const result = validateAdoption(
      native,
      evaluators((context) => {
        observed.push(context.requirement.id);
        expect(context.graph.revision).toBe(native.revision);
        expect(context.adopter.discriminator).toBe('workspace');
        expect(() => (context.graph.nodes as Map<string, unknown>).clear()).toThrow();
        return { outcome: 'pass', message: 'fixture structural predicate holds' };
      }),
    );
    expect(observed).toEqual(contract.requirements.map((r) => r.id));
    expect(result[0]!.outcome).toBe('pass');
    expect(() => (result as unknown[]).pop()).toThrow();
  });
  it('names violations and leaves missing or throwing evaluators unavailable', () => {
    const supplied = new Map([
      [
        contractId,
        new Map<string, ClauseEvaluator>([
          [contract.requirements[0]!.id, () => ({ outcome: 'fail', message: 'missing input' })],
          [
            contract.requirements[1]!.id,
            () => {
              throw new Error('unavailable evidence');
            },
          ],
        ]),
      ],
    ]);
    const result = validateAdoption(native, supplied)[0]!;
    expect(result.outcome).toBe('fail');
    expect(result.findings.map((f) => f.code)).toEqual([
      'IA-COMP-ADOPTION-FAILED',
      'IA-COMP-NOT-EVALUATED',
      'IA-COMP-NOT-EVALUATED',
    ]);
  });
  it('keeps unresolved adoptions unavailable without repeating graph findings', () => {
    const graph = load(
      records.filter((r) => r.identity !== contractId),
      registry,
      options,
    );
    expect(validateAdoption(graph)).toHaveLength(1);
    expect(validateAdoption(graph)[0]!.outcome).toBe('not-evaluated');
    expect(validateAdoption(graph)[0]!.findings).toEqual([]);
  });
  it('requires a coordinate for conditional adoption and clauses', () => {
    const changed = records.map((r) =>
      r.discriminator !== 'workspace'
        ? r
        : {
            ...r,
            edges: r.edges.map((e) =>
              e.predicate !== 'require' ? e : { ...e, condition: [{ axis: 'phase' as const, value: 'act' }] },
            ),
          },
    );
    const graph = load(changed, registry, options);
    let calls = 0;
    const supplied = evaluators(() => {
      calls++;
      return { outcome: 'pass', message: 'checked' };
    });
    expect(validateAdoption(graph, supplied)[0]!.outcome).toBe('not-evaluated');
    expect(calls).toBe(0);
    expect(validateAdoption(graph, supplied, { phase: 'orient' })).toEqual([]);
    expect(calls).toBe(0);
    expect(validateAdoption(graph, supplied, { phase: 'act' })[0]!.outcome).toBe('pass');
    expect(calls).toBe(3);
    const clauseGraph = load(
      records.map((r) =>
        r.identity !== contractId
          ? r
          : {
              ...r,
              requirements: r.requirements.map((q) => ({
                ...q,
                condition: [{ axis: 'phase' as const, value: 'act' }],
              })),
            },
      ),
      registry,
      options,
    );
    expect(validateAdoption(clauseGraph, supplied)[0]!.outcome).toBe('not-evaluated');
    expect(validateAdoption(clauseGraph, supplied, { phase: 'act' })[0]!.outcome).toBe('pass');
  });
});
