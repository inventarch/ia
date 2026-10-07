import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { validateSystems } from '../../packages/compliance/src/index.js';
import { checkNative } from './check.js';
import { compileNative } from './compile.js';
import type { NativeInput } from './compile.js';
import { observeFoundationAuthoring } from './fixture-authoring.js';

import { inputs as fixtureInputs } from '../../packages/compliance/tests/native.js';
import { publicLanguageInputs } from './public-language.js';

import { fixtureInstances } from './fixture-instances.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const native = {
  inputs: [
    ...fixtureInstances,
    ...fixtureInputs,
    ...publicLanguageInputs(root).inputs.filter((input) =>
      [
        '.ia/src/systems/agent-composition-system/records/composition.ia',
        '.ia/src/systems/workspace-system/records/quality.ia',
        '.ia/src/systems/workspace-system/records/architecture.ia',
        '.ia/src/systems/learning-system/records/evidence.ia',
        '.ia/src/systems/workspace-system/records/language.ia',
        '.ia/src/systems/work-system/records/work.ia',
      ].includes(input.path),
    ),
  ],
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
const baseline = checkNative(native.inputs, native.folders);
const foundation = observeFoundationAuthoring(native.inputs, native.folders);
function change(suffix: string, before: string, after: string): readonly NativeInput[] {
  let changed = false;
  const result = native.inputs.map((input) => {
    if (!input.path.endsWith(suffix)) return input;
    expect(input.text).toContain(before);
    changed = true;
    return { ...input, text: input.text.replace(before, after) };
  });
  expect(changed).toBe(true);
  return result;
}
const findings = (result: ReturnType<typeof checkNative>) => [
  ...result.diagnostics,
  ...result.assessments.flatMap((a) => a.findings),
];
const testFolders = (corpus = baseline) =>
  native.folders.map((name) => {
    const path = `.ia/src/systems/${name}`;
    return {
      name,
      path,
      sources: corpus.sources.filter((s) => s.ast.path.startsWith(`${path}/`)),
      records: corpus.records.filter((r) => r.source.path.startsWith(`${path}/`)),
    };
  });

describe('native system closure', () => {
  it('passes all implemented assessments through real registrations and exact dependency order', () => {
    expect(findings(baseline)).toEqual([]);
    expect(baseline.ok).toBe(true);
    expect(baseline.registry.order).toEqual([
      'floor',
      'taxonomy',
      'agent-system',
      'compliance-system',
      'workspace-system',
      'governance-system',
      'authoring-system',
      'hook-authoring-system',
      'learning-system',
      'session-system',
      'template-system',
      'agent-composition-system',
      'work-system',
    ]);
    expect(
      baseline.records.some((record) => record.name === 'example-harness' && record.discriminator === 'harness'),
    ).toBe(true);
    expect(baseline.assessments.every((assessment) => assessment.outcome === 'pass')).toBe(true);
    expect(foundation.observations.find((o) => o.id === 'input')!.outcome).toBe('pass');
    expect(foundation.observations.find((o) => o.id === 'valid-native-record')!.outcome).toBe('pass');
  });
  it('declares a case input only where the scenario runner reads it', () => {
    const scenarioKey = (record: (typeof baseline.records)[number], key: string) =>
      record.sections
        .filter((s) => s.name === 'scenario')
        .flatMap((s) => s.fields)
        .find((f) => 'key' in f && f.key === key);
    const evaluatorOf = (record: (typeof baseline.records)[number]) => {
      const f = scenarioKey(record, 'evaluator');
      return f !== undefined && 'value' in f && (f.value.kind === 'string' || f.value.kind === 'scalar')
        ? f.value.text
        : undefined;
    };
    const cases = baseline.records.filter((r) => r.discriminator === 'case');
    expect(
      cases
        .filter((r) => scenarioKey(r, 'input') !== undefined && evaluatorOf(r) !== 'tools/systems/scenarios.ts')
        .map((r) => r.identity),
    ).toEqual([]);
  });
  it('has a real instance of every minted word and one distinct expert per system', () => {
    const stewards = native.folders.map((name) => baseline.registry.systems.get(name)!.steward!.name);
    expect(new Set(stewards).size).toBe(native.folders.length);
    for (const system of baseline.registry.systems.values())
      for (const entry of system.entries)
        expect(baseline.records.some((r) => r.discriminator === entry.keyword)).toBe(true);
  });
  it('connects a full procedure grid, variant rule and typed contract/case fragments', () => {
    const method = baseline.records.find((r) => r.name === 'sample-procedure')!;
    expect(method.cells).toHaveLength(24);
    expect(method.cells.filter((c) => c.primary).map((c) => `${c.phase}/${c.primitive}`)).toEqual([
      'orient/Memory',
      'plan/Inference',
      'act/Decision',
      'learn/Learning',
    ]);
    const law = baseline.records.find((r) => r.name === 'sample-rule')!;
    expect(law.variants).toHaveLength(2);
    expect(law.edges[0]!.condition).toBeDefined();
    const contract = baseline.records.find((r) => r.name === 'foundation-authoring-contract')!;
    expect(contract.requirements).toHaveLength(3);
    const cases = baseline.records.filter(
      (r) => r.discriminator === 'case' && r.edges.some((edge) => edge.target === contract.identity),
    );
    expect(cases).toHaveLength(3);
    expect(
      cases.flatMap((r) => r.edges).every((e) => e.target === contract.identity && e.fragment?.startsWith('REQ-')),
    ).toBe(true);
  });
  it('keeps every native identity and the single surface invariant under syntax-like prose', () => {
    const result = checkNative(
      change(
        'agent-system/steward.ia',
        '"Identifies the owner of agent-system contracts in this example."',
        '"""@workspace invented\n      when phase is act # content, not a record\n      @system another-language"""',
      ),
      native.folders,
    );
    expect(result.ok).toBe(true);
    expect(findings(result)).toEqual([]);
    expect(result.records.map((r) => [r.identity, r.discriminator])).toEqual(
      baseline.records.map((r) => [r.identity, r.discriminator]),
    );
    expect(result.sources.map((s) => s.ast.version)).toEqual(baseline.sources.map((s) => s.ast.version));
  });
  it('implements the native missing-field failure scenario', () => {
    expect(foundation.observations.find((o) => o.id === 'missing-required-field')!.outcome).toBe('pass');
  });
  it('implements the native foreign-vocabulary refusal scenario', () => {
    expect(foundation.observations.find((o) => o.id === 'foreign-vocabulary')!.outcome).toBe('pass');
  });
  it('refuses a mandate whose authority moves leave the closed kernel list with a schema finding', () => {
    const result = checkNative(
      change(
        'agent-system/records/minimal-mandate.ia',
        '    moves [Observation, Verification]',
        '    moves [Observation, Invented]',
      ),
      native.folders,
    );
    expect(result.ok).toBe(false);
    expect(findings(result).filter((f) => f.code === 'IA-COMP-FIELD-VALUE')).toEqual([
      expect.objectContaining({ path: '.ia/src/systems/agent-system/records/minimal-mandate.ia' }),
    ]);
  });
  it('refuses incomplete minting and its instances', () => {
    const result = checkNative(change('agent-system/system.ia', '      schema @schema agent\n', ''), native.folders);
    expect(result.ok).toBe(false);
    expect(result.registry.registrations.has('agent')).toBe(false);
    expect(result.records.some((r) => r.discriminator === 'agent')).toBe(false);
    expect(findings(result).some((f) => f.code === 'IA-LANG-REGISTRATION-INCOMPLETE')).toBe(true);
  });
  it.each([
    ['agent-system/system.ia', '  steward @agent agent-steward', '  steward @mandate sample-mandate'],
    ['agent-system/system.ia', '  steward @agent agent-steward', '  steward @agent missing'],
    ['agent-system/steward.ia', '    applies [agent, mandate]', '    applies [agent]'],
    ['agent-system/steward.ia', '    applies [agent, mandate]', '    applies [agent, mandate] when phase is act'],
    [
      'agent-system/steward.ia',
      '    applies [agent, mandate]',
      '    applies [agent, mandate]\n      when phase is act',
    ],
    ['governance-system/system.ia', '  steward @agent governance-steward', '  steward @agent agent-steward'],
  ])('refuses insufficient stewardship in %s', (file, before, after) => {
    const result = checkNative(change(file!, before!, after!), native.folders);
    expect(result.ok).toBe(false);
    expect(findings(result).filter((f) => f.code === 'IA-COMP-STEWARD-MISSING')).toHaveLength(1);
  });
  it('matches steward occurrences by value, not object aliases', () => {
    const result = validateSystems(testFolders(), baseline.registry, JSON.parse(JSON.stringify(baseline.records)));
    expect(result.every((a) => a.outcome === 'pass')).toBe(true);
  });
  it('refuses empty, renamed and duplicate-declaration folders without subordinate reports', () => {
    const folder = testFolders()[0]!;
    for (const broken of [
      { ...folder, sources: [], records: [] },
      { ...folder, name: 'wrong' },
      { ...folder, sources: [...folder.sources, folder.sources.find((s) => s.ast.path.endsWith('/system.ia'))!] },
    ]) {
      const results = validateSystems([broken], baseline.registry, baseline.records);
      expect(
        results
          .filter((a) => a.scope === broken.path)
          .flatMap((a) => a.findings)
          .map((f) => f.code),
      ).toEqual(['IA-COMP-SYSTEM-MALFORMED']);
    }
  });
  it('requires the declaration in direct system.ia', () => {
    const inputs = native.inputs.map((i) =>
      i.path === '.ia/src/systems/agent-system/system.ia'
        ? { ...i, path: '.ia/src/systems/agent-system/records/system.ia' }
        : i,
    );
    expect(findings(checkNative(inputs, native.folders)).some((f) => f.code === 'IA-COMP-SYSTEM-MALFORMED')).toBe(true);
  });
  it('reports inconsistent supplied bootstrap order', () => {
    const assessments = validateSystems(
      testFolders(),
      { ...baseline.registry, order: [...baseline.registry.order].reverse() },
      baseline.records,
    );
    expect(
      assessments
        .find((a) => a.check === 'COMP-BOOTSTRAP')!
        .findings.every((f) => f.code === 'IA-COMP-BOOTSTRAP-ORDER'),
    ).toBe(true);
    expect(assessments.find((a) => a.check === 'COMP-BOOTSTRAP')!.outcome).toBe('fail');
  });
  it('warns for an isolated keyword without turning evaluated structure into not-evaluated', () => {
    const systems = new Map(baseline.registry.systems);
    const agent = systems.get('agent-system')!;
    systems.set(agent.name, { ...agent, consent: [] });
    const assessments = validateSystems(testFolders(), { ...baseline.registry, systems }, baseline.records);
    const result = assessments.find((a) => a.scope.endsWith('/agent-system') && a.check === 'COMP-CONSENT-DECLARED')!;
    expect(result.outcome).toBe('pass');
    expect(result.findings.map((f) => f.code)).toEqual(['IA-COMP-CONSENT-EMPTY', 'IA-COMP-CONSENT-EMPTY']);
  });
  it('checks schema enrollment including the two fixed floor registrations', () => {
    const registrations = new Map(baseline.registry.registrations);
    registrations.delete('mandate');
    registrations.set('extra', { ...registrations.get('agent')!, keyword: 'extra' });
    const result = validateSystems([], { ...baseline.registry, registrations }, baseline.records).find(
      (a) => a.check === 'COMP-SCHEMA-ENROLLED',
    )!;
    expect(result.findings.map((f) => f.code)).toEqual(['IA-COMP-SCHEMA-MULTIPLE', 'IA-COMP-SCHEMA-UNREFERENCED']);
  });
  it('is stable under file order and refuses cross-file identities/requirements before publication', () => {
    expect(checkNative([...native.inputs].reverse(), native.folders)).toEqual(baseline);
    const original = native.inputs.find((i) => i.path.endsWith('/foundation-authoring-contract.ia'))!;
    const duplicate = { ...original, path: original.path.replace('.ia', '-copy.ia') };
    const sameIdentity = compileNative([...native.inputs, duplicate]);
    expect(sameIdentity.diagnostics.filter((d) => d.code === 'IA-LANG-IDENTITY-COLLISION')).toHaveLength(2);
    const sameRequirement = compileNative([
      ...native.inputs,
      {
        ...duplicate,
        text: duplicate.text.replace('@contract foundation-authoring-contract', '@contract another-contract'),
      },
    ]);
    expect(sameRequirement.diagnostics.filter((d) => d.code === 'IA-LANG-REQUIREMENT-DUPLICATE')).toHaveLength(6);
    expect(
      sameRequirement.records.some((r) => r.source.path === original.path || r.source.path === duplicate.path),
    ).toBe(false);
  });
});
