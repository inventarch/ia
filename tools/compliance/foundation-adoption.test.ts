import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '../../packages/language/src/index.js';
import { load } from '../../packages/graph/src/index.js';
import { validateAdoption } from '../../packages/compliance/src/index.js';
import { inputs as fixtureInputs } from '../../packages/compliance/tests/native.js';
import { compileNative } from '../native/compile.js';
import type { NativeInput } from '../native/compile.js';
import { observeFoundationAuthoring } from '../native/fixture-authoring.js';
import type { FoundationEvidence } from '../native/fixture-authoring.js';
import { foundationAdoptionEvaluators } from './foundation-adoption.js';

const native = {
  inputs: fixtureInputs,
  folders: [
    'agent-system',
    'compliance-system',
    'workspace-system',
    'governance-system',
    'session-system',
    'authoring-system',
    'agent-composition-system',
    'template-system',
    'hook-authoring-system',
    'learning-system',
    'work-system',
  ],
};
const evidence = observeFoundationAuthoring(native.inputs, native.folders);
function graphFor(inputs: readonly NativeInput[], location = '') {
  const corpus = compileNative(inputs);
  return load(corpus.records, corpus.registry, {
    sources: inputs,
    kernelDigest: KERNEL_DIGEST,
    languageVersion: LANGUAGE_VERSION,
    location,
  });
}
const graph = graphFor(native.inputs);
const adoption = (supplied?: FoundationEvidence, target = graph) =>
  validateAdoption(target, foundationAdoptionEvaluators(supplied));
function change(path: string, before: string, after: string): readonly NativeInput[] {
  expect(native.inputs.some((i) => i.path.endsWith(path) && i.text.includes(before))).toBe(true);
  return native.inputs.map((i) => (i.path.endsWith(path) ? { ...i, text: i.text.replace(before, after) } : i));
}

describe('repository foundation adoption evidence', () => {
  it('executes all named observations against the graph source revision', () => {
    expect(evidence.revision).toBe(graph.revision);
    expect(evidence.observations.map((o) => [o.id, o.outcome])).toEqual([
      ['input', 'pass'],
      ['valid-native-record', 'pass'],
      ['missing-required-field', 'pass'],
      ['foreign-vocabulary', 'pass'],
    ]);
    expect(adoption(evidence).map((a) => a.outcome)).toEqual(['pass']);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.observations)).toBe(true);
    expect(evidence.observations.every(Object.isFrozen)).toBe(true);
  });
  it('leaves absent, incomplete and ambiguous observations unavailable', () => {
    expect(adoption()[0]!.findings).toHaveLength(3);
    for (const observations of [
      evidence.observations.filter((o) => o.id !== 'foreign-vocabulary'),
      [...evidence.observations, evidence.observations[3]!],
    ]) {
      const [assessment] = adoption({ ...evidence, observations });
      expect(assessment!.outcome).toBe('not-evaluated');
      expect(assessment!.findings).toHaveLength(1);
      expect(assessment!.findings[0]!.message).toContain('REQ-FOUNDATION-REFUSE');
    }
  });
  it('does not reuse old observations after source changes; re-execution qualifies the new revision', () => {
    const inputs = change('agent-system/steward.ia', 'Identifies the owner', 'Identifies the fixture owner');
    const target = graphFor(inputs);
    expect(target.revision).not.toBe(evidence.revision);
    expect(adoption(evidence, target)[0]!.outcome).toBe('not-evaluated');
    expect(adoption(observeFoundationAuthoring(inputs, native.folders), target)[0]!.outcome).toBe('pass');
  });
  it('does not qualify another adopter or a contextual view', () => {
    const workspace = native.inputs.find((i) => i.path.endsWith('/foundation-workspace.ia'))!;
    const inputs = [
      ...native.inputs,
      {
        ...workspace,
        path: workspace.path.replace('foundation-workspace', 'another-workspace'),
        text: workspace.text.replaceAll('foundation-workspace', 'another-workspace'),
      },
    ];
    const assessments = adoption(observeFoundationAuthoring(inputs, native.folders), graphFor(inputs));
    expect(assessments.find((a) => a.scope.includes('/another-workspace->'))!.outcome).toBe('not-evaluated');
    expect(assessments.find((a) => a.scope.includes('/foundation-workspace->'))!.outcome).toBe('pass');
    expect(adoption(evidence, graphFor(native.inputs, 'project'))[0]!.outcome).toBe('not-evaluated');
    expect(adoption({ ...evidence, adopter: 'another-workspace' })[0]!.outcome).toBe('not-evaluated');
  });
  it('leaves a newly authored requirement without an evaluator', () => {
    const inputs = change(
      'foundation-authoring-contract.ia',
      '  failures',
      '  invariants\n    REQ-FOUNDATION-NEW "Requires additional evidence."\n  failures',
    );
    const [assessment] = adoption(observeFoundationAuthoring(inputs, native.folders), graphFor(inputs));
    expect(assessment!.outcome).toBe('not-evaluated');
    expect(assessment!.findings).toHaveLength(1);
    expect(assessment!.findings[0]!.message).toContain('REQ-FOUNDATION-NEW');
  });
  it('reports an actually invalid authored record and keeps an unpreparable mutation unavailable', () => {
    const inputs = change('agent-system/steward.ia', '    applies [agent, mandate]', '');
    const observed = observeFoundationAuthoring(inputs, native.folders);
    expect(observed.observations.find((o) => o.id === 'input')!.outcome).toBe('pass');
    expect(observed.observations.find((o) => o.id === 'valid-native-record')!.outcome).toBe('fail');
    expect(observed.observations.find((o) => o.id === 'missing-required-field')!.outcome).toBe('not-evaluated');
    const [assessment] = adoption(observed, graphFor(inputs));
    expect(assessment!.outcome).toBe('fail');
    expect(assessment!.findings.map((f) => f.code)).toContain('IA-COMP-ADOPTION-FAILED');
    expect(assessment!.findings.map((f) => f.code)).toContain('IA-COMP-NOT-EVALUATED');
  });
  it('fails refusal evidence when the schema accepts the missing required field despite another refusal', () => {
    const inputs = change(
      'agent-system/schemas/agent.schema.ia',
      'must have governance.applies',
      'may have governance.applies',
    );
    const observed = observeFoundationAuthoring(inputs, native.folders);
    expect(observed.observations.find((o) => o.id === 'valid-native-record')!.outcome).toBe('pass');
    // The steward check still fails after removal; it cannot stand in for FIELD-MISSING.
    expect(observed.observations.find((o) => o.id === 'missing-required-field')!.outcome).toBe('fail');
    const [assessment] = adoption(observed, graphFor(inputs));
    expect(assessment!.outcome).toBe('fail');
    expect(assessment!.findings[0]!.message).toContain('REQ-FOUNDATION-REFUSE');
  });
  it('fails input evidence for an absent authored source, dependency or discovered owner', () => {
    for (const [inputs, folders] of [
      [native.inputs.filter((i) => !i.path.endsWith('agent-system/steward.ia')), native.folders],
      [native.inputs.filter((i) => !i.path.endsWith('agent-system/system.ia')), native.folders],
      [native.inputs.filter((i) => !i.path.startsWith('.ia/src/systems/template-system/')), native.folders],
      [native.inputs, native.folders.filter((name) => name !== 'agent-system')],
    ] as const) {
      const observed = observeFoundationAuthoring(inputs, folders);
      expect(observed.observations.find((o) => o.id === 'input')!.outcome).toBe('fail');
    }
  });
  it('retains source compilation errors even when the offending record is excluded', () => {
    const inputs = [
      ...native.inputs,
      { ...native.inputs[0]!, path: '.ia/src/invalid.ia', text: '#! ia 1.0\n@unknown invalid\n' },
    ];
    const observed = observeFoundationAuthoring(inputs, native.folders);
    expect(graphFor(inputs).nodes.size).toBe(graph.nodes.size);
    expect(observed.observations.find((o) => o.id === 'input')!.outcome).toBe('fail');
    expect(adoption(observed, graphFor(inputs))[0]!.outcome).toBe('fail');
  });
  it('retains an observed refusal failure when the other refusal observation is missing', () => {
    const observations = evidence.observations
      .filter((o) => o.id !== 'foreign-vocabulary')
      .map((o) =>
        o.id === 'missing-required-field'
          ? { ...o, outcome: 'fail' as const, message: 'Observed unexpected conformance' }
          : o,
      );
    const [assessment] = adoption({ ...evidence, observations });
    expect(assessment!.outcome).toBe('fail');
    expect(assessment!.findings[0]!.code).toBe('IA-COMP-ADOPTION-FAILED');
  });
});
