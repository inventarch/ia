import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@ia/language';
import type { CompiledRecord, FrozenRegistry, SchemaEdge } from '@ia/language';
import { load } from '@ia/graph';
import type { Node } from '@ia/graph';
import {
  graphLookup,
  validateCheck,
  validateConsent,
  validateCoverage,
  validateFragments,
  validateGraphSchema,
  validateIdentity,
  validateParse,
  validateSelectors,
} from '../src/index.js';
import { inputs, records, registry } from './native.js';

const options = { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const native = load(records, registry, options);
const contractId = 'compliance-system/contract/signature/foundation-authoring-contract';
const methodId = 'governance-system/definition/procedure/sample-procedure';
function view(changed: readonly CompiledRecord[], vocabulary: FrozenRegistry = registry) {
  return load(changed, vocabulary, options);
}
describe('full native graph checks', () => {
  it('passes every native instance schema and selector plus fragments, coverage, consent and identity', () => {
    for (const node of native.nodes.values()) {
      expect(validateGraphSchema(node, native).outcome, node.identity).toBe('pass');
      expect(validateSelectors(node).outcome).toBe('pass');
      if (node.discriminator === 'check') expect(validateCheck(node).outcome).toBe('pass');
    }
    expect(validateFragments(native).outcome).toBe('pass');
    expect(validateCoverage(native.nodes.get(contractId)!, native).outcome).toBe('pass');
    expect(validateConsent(native).outcome).toBe('pass');
    expect(validateIdentity(native).outcome).toBe('pass');
  });
  it('requires parse observations, keeps source codes and freezes findings', () => {
    expect(validateParse(undefined).outcome).toBe('not-evaluated');
    expect(validateParse([]).outcome).toBe('pass');
    const diagnostics = parse('@agent bad\n', 'bad.ia').diagnostics;
    const result = validateParse(diagnostics);
    expect(result.outcome).toBe('fail');
    expect(result.findings).toEqual(diagnostics);
    expect(() => (result.findings as unknown[]).pop()).toThrow();
  });
  it('refuses an unknown or duplicate check runner with one named diagnostic', () => {
    const check = [...native.nodes.values()].find((n) => n.discriminator === 'check')!;
    const bad = {
      ...check,
      sections: check.sections.map((s) =>
        s.name === 'check'
          ? {
              ...s,
              fields: s.fields.map((f) =>
                'key' in f && f.key === 'runs' ? { ...f, value: { kind: 'scalar' as const, text: 'COMP-MAGIC' } } : f,
              ),
            }
          : s,
      ),
    };
    expect(validateCheck(bad).findings.map((f) => f.code)).toEqual(['IA-COMP-CHECK-UNKNOWN']);
    expect(
      validateCheck({ ...check, sections: [...check.sections, ...check.sections.filter((s) => s.name === 'check')] })
        .findings,
    ).toHaveLength(1);
  });
  it('refuses malformed caller selector products using the closed domains', () => {
    const base = native.nodes.get(methodId)!;
    for (const selectors of [
      [[]],
      [[{ axis: 'phase' as const, value: 'nope' }]],
      [
        [
          { axis: 'phase' as const, value: 'act' },
          { axis: 'phase' as const, value: 'act' },
        ],
      ],
    ])
      expect(validateSelectors({ ...base, selectors }).findings.map((f) => f.code)).toEqual([
        'IA-COMP-SELECTOR-INVALID',
      ]);
  });
});
describe('fragments and structural coverage', () => {
  it('names exactly the requirements lost when a covering case is removed', () => {
    const graph = view(records.filter((r) => r.name !== 'valid-native-record'));
    const result = validateCoverage(graph.nodes.get(contractId)!, graph);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.code === 'IA-COMP-COVERAGE-MISSING')).toBe(true);
    expect(result.findings.map((f) => f.message).join('\n')).toContain('REQ-FOUNDATION-VALID');
  });
  it('requires success and failure/refusal classes when all requirements are covered', () => {
    const graph = view(
      records.map((r) =>
        r.discriminator !== 'case'
          ? r
          : {
              ...r,
              sections: r.sections.map((s) =>
                s.name !== 'scenario'
                  ? s
                  : {
                      ...s,
                      fields: s.fields.map((f) =>
                        'key' in f && f.key === 'kind'
                          ? { ...f, value: { kind: 'scalar' as const, text: 'success' } }
                          : f,
                      ),
                    },
              ),
            },
      ),
    );
    expect(validateCoverage(graph.nodes.get(contractId)!, graph).findings.map((f) => f.code)).toEqual([
      'IA-COMP-COVERAGE-KIND',
    ]);
  });
  it('does not count conditional cases as static coverage', () => {
    const graph = view(
      records.map((r) =>
        r.name !== 'valid-native-record'
          ? r
          : { ...r, edges: r.edges.map((e) => ({ ...e, condition: [{ axis: 'phase' as const, value: 'act' }] })) },
      ),
    );
    expect(validateCoverage(graph.nodes.get(contractId)!, graph).outcome).toBe('fail');
  });
  it('refuses a missing requirement fragment but does not duplicate a missing-target fault', () => {
    const bad = view(
      records.map((r) =>
        r.name !== 'valid-native-record'
          ? r
          : {
              ...r,
              edges: r.edges.map((e, i) =>
                i !== 0 ? e : { ...e, fragment: 'REQ-MISSING', reference: { ...e.reference, fragment: 'REQ-MISSING' } },
              ),
            },
      ),
    );
    expect(validateFragments(bad).findings.map((f) => f.code)).toEqual(['IA-COMP-FRAGMENT-MISSING']);
    const missing = view(records.filter((r) => r.identity !== contractId));
    expect(validateFragments(missing).findings).toEqual([]);
    expect(validateConsent(missing).outcome).toBe('not-evaluated');
    expect(validateConsent(missing).findings.every((f) => f.code === 'IA-GRAPH-TARGET-MISSING')).toBe(true);
  });
  it('checks inverse fragments on the referenced endpoint and uses exact cell spelling', () => {
    const method = records.find((r) => r.identity === methodId)!;
    const edge = {
      predicate: 'cite' as const,
      direction: 'in' as const,
      reference: { kind: 'ref' as const, discriminator: 'playbook', name: method.name, fragment: 'orient/Memory' },
      target: null,
      fragment: 'orient/Memory',
      span: method.source,
    };
    const check = records.find((r) => r.discriminator === 'check')!;
    const graph = view(records.map((r) => (r !== check ? r : { ...r, edges: [...r.edges, edge] })));
    expect(validateFragments(graph).outcome).toBe('pass');
    const bad = view(
      records.map((r) =>
        r !== check
          ? r
          : {
              ...r,
              edges: [
                ...r.edges,
                { ...edge, fragment: 'orient/memory', reference: { ...edge.reference, fragment: 'orient/memory' } },
              ],
            },
      ),
    );
    expect(validateFragments(bad).findings.map((f) => f.code)).toEqual(['IA-COMP-FRAGMENT-MISSING']);
  });
});
describe('graph schema obligations', () => {
  const location = {
    placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
    provenance: 'workspace' as const,
  };
  const source = {
    path: 'edge.ia',
    text: '#! ia 1.0\n@playbook source\n  relationships\n    cites @playbook target\n@playbook target\n  relationships\n    cited-by @playbook source\n',
    location,
  };
  const compiled = compile(parse(source.text, source.path).ast, registry, location, []).records;
  const rule: SchemaEdge = {
    predicate: 'cite',
    target: 'playbook',
    must: true,
    cardinality: 'one',
    span: { line: 1, endLine: 1 },
  };
  function graphOf(changed = compiled, changedRule = rule, vocabulary = registry) {
    const schemas = new Map(vocabulary.schemas),
      original = schemas.get('playbook')!;
    schemas.set('playbook', { ...original, sections: [], fields: [], closed: false, edges: [changedRule] });
    return load(changed, { ...vocabulary, schemas }, { ...options, sources: [source] });
  }
  const subject = (graph: ReturnType<typeof graphOf>) =>
    graph.nodes.get('governance-system/definition/procedure/source')!;
  it('counts late-resolved reciprocal assertions once and retains graph ownership', () => {
    const graph = graphOf();
    expect(validateGraphSchema(subject(graph), graph).outcome).toBe('pass');
    expect(graph.edges).toHaveLength(1);
  });
  it('treats unresolved/conditioned edges as uncertain and absence as failure', () => {
    const dangling = graphOf(compiled.slice(0, 1));
    expect(validateGraphSchema(subject(dangling), dangling).outcome).toBe('not-evaluated');
    const conditional = graphOf(
      compiled.map((r) => ({
        ...r,
        edges: r.edges.map((e) => ({ ...e, condition: [{ axis: 'phase' as const, value: 'act' }] })),
      })),
    );
    expect(validateGraphSchema(subject(conditional), conditional).outcome).toBe('not-evaluated');
    const absent = graphOf(compiled.map((r) => ({ ...r, edges: [] })));
    expect(validateGraphSchema(subject(absent), absent).findings.map((f) => f.code)).toEqual([
      'IA-COMP-EDGE-CARDINALITY',
    ]);
  });
  it('does not count a consent-refused relationship', () => {
    const consent = new Map(registry.consent);
    consent.set('governance-system', []);
    const graph = graphOf(compiled, rule, { ...registry, consent });
    expect(graph.edges).toEqual([]);
    expect(validateConsent(graph).outcome).toBe('fail');
    expect(validateGraphSchema(subject(graph), graph).outcome).toBe('not-evaluated');
    expect(validateGraphSchema(subject(graph), graph).findings).toEqual([]);
  });
  it('resolves a `ref to` field against the admitted graph and only warns when the target is absent', () => {
    const typed = {
      path: 'typed.ia',
      text: '#! ia 1.0\n@playbook source\n  work\n    parent @playbook target\n@playbook target\n',
      location,
    };
    const nodes = compile(parse(typed.text, typed.path).ast, registry, location, []).records;
    const field = {
      section: 'work',
      key: 'parent',
      type: 'ref' as const,
      target: 'playbook',
      must: true,
      span: { line: 1, endLine: 1 },
    };
    const schemas = new Map(registry.schemas),
      original = schemas.get('playbook')!;
    schemas.set('playbook', { ...original, sections: [], fields: [field], closed: false, edges: [] });
    const graphWith = (changed: readonly CompiledRecord[]) =>
      load(changed, { ...registry, schemas }, { ...options, sources: [typed] });
    const whole = graphWith(nodes),
      dangling = graphWith(nodes.slice(0, 1));
    const node = (graph: ReturnType<typeof graphWith>) =>
      graph.nodes.get('governance-system/definition/procedure/source')!;
    expect(validateGraphSchema(node(whole), whole)).toMatchObject({ outcome: 'pass', findings: [] });
    const result = validateGraphSchema(node(dangling), dangling);
    expect(result.outcome).toBe('pass');
    expect(result.findings.map((f) => [f.code, f.severity])).toEqual([['IA-COMP-FIELD-REF-MISSING', 'warning']]);
  });
  it('refuses a duplicated non-list field key on the graph path and keeps checking each occurrence (D3)', () => {
    const doubled = {
      path: 'doubled.ia',
      text: '#! ia 1.0\n@playbook source\n  work\n    parent @playbook target\n    parent @playbook nobody\n    tags [a]\n    tags [b]\n@playbook target\n',
      location,
    };
    const nodes = compile(parse(doubled.text, doubled.path).ast, registry, location, []).records;
    const parent = {
      section: 'work',
      key: 'parent',
      type: 'ref' as const,
      target: 'playbook',
      must: true,
      span: { line: 1, endLine: 1 },
    };
    const tags = {
      section: 'work',
      key: 'tags',
      type: 'list of id' as const,
      must: false,
      span: { line: 1, endLine: 1 },
    };
    const schemas = new Map(registry.schemas),
      original = schemas.get('playbook')!;
    schemas.set('playbook', { ...original, sections: [], fields: [parent, tags], closed: false, edges: [] });
    const graph = load(nodes, { ...registry, schemas }, { ...options, sources: [doubled] });
    const result = validateGraphSchema(graph.nodes.get('governance-system/definition/procedure/source')!, graph);
    expect(result.outcome).toBe('fail');
    expect(result.findings.map((f) => [f.code, f.severity, f.line])).toEqual([
      ['IA-COMP-FIELD-DUPLICATE', 'error', 5],
      ['IA-COMP-FIELD-REF-MISSING', 'warning', 5],
    ]);
    expect(result.findings[0]!.message).toContain(
      `'work.parent' is declared once by @schema playbook; found 2 occurrences`,
    );
  });
  it('refuses an undeclared key in a closed declared section on the graph path and leaves the same key alone under open (D1)', () => {
    const extra = {
      path: 'extra.ia',
      text: '#! ia 1.0\n@playbook source\n  work\n    parent @playbook target\n    ready true\n  governance\n    requires "kept as a variant"\n    severity blocking\n@playbook target\n  work\n    parent @playbook source\n',
      location,
    };
    const nodes = compile(parse(extra.text, extra.path).ast, registry, location, []).records;
    const parent = {
      section: 'work',
      key: 'parent',
      type: 'ref' as const,
      target: 'playbook',
      must: true,
      span: { line: 1, endLine: 1 },
    };
    const sections = [
      { name: 'work', must: true, span: { line: 1, endLine: 1 } },
      { name: 'governance', must: false, span: { line: 1, endLine: 1 } },
    ];
    const graphWith = (closed: boolean) => {
      const schemas = new Map(registry.schemas),
        original = schemas.get('playbook')!;
      schemas.set('playbook', { ...original, sections, fields: [parent], closed, edges: [] });
      return load(nodes, { ...registry, schemas }, { ...options, sources: [extra] });
    };
    const node = (graph: ReturnType<typeof graphWith>) =>
      graph.nodes.get('governance-system/definition/procedure/source')!;
    expect(node(graphWith(true)).variants.map((v) => v.key)).toEqual(['requires']);
    const result = validateGraphSchema(node(graphWith(true)), graphWith(true));
    expect(result.outcome).toBe('fail');
    expect(result.findings.map((f) => [f.code, f.severity, f.line])).toEqual([['IA-COMP-FIELD-UNKNOWN', 'error', 5]]);
    expect(result.findings[0]!.message).toContain(`closed @schema playbook does not declare 'work.ready'`);
    expect(validateGraphSchema(node(graphWith(false)), graphWith(false))).toMatchObject({
      outcome: 'pass',
      findings: [],
    });
  });
  it('builds the `ref to` lookup once per graph and keeps it for that graph only', () => {
    const one = view(records),
      other = view(records);
    expect(graphLookup(one)).toBe(graphLookup(one));
    expect(graphLookup(one)).not.toBe(graphLookup(other));
    expect(graphLookup(one)({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' })).toBe(true);
    expect(graphLookup(one)({ kind: 'ref', discriminator: 'playbook', name: 'nobody' })).toBe(false);
  });
  it('retains graph tie findings exactly once per source participant', () => {
    const sourceNode = subject(graphOf());
    const clone: Node = { ...sourceNode, source: { ...sourceNode.source, line: 100 } };
    const graph = graphOf([sourceNode, clone]);
    expect(validateIdentity(graph).findings).toEqual(graph.diagnostics);
    expect(validateIdentity(graph).outcome).toBe('fail');
  });
});
