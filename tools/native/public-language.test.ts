import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAdoption } from '../../packages/compliance/src/index.js';
import type { ClauseEvaluator } from '../../packages/compliance/src/adoption.js';
import { compileHarness } from '../../.ia/src/systems/agent-composition-system/src/compile.js';
import { distributionSnapshot, packSnapshot } from '../../apps/distribution/src/snapshot.js';
import {
  checkPublicLanguage,
  compilePublicLanguage,
  exampleCatalog,
  languagePackageInputs,
  publicCapture,
} from './public-language.js';
import { vocabularyOutputs } from './public-vocabulary.js';
import { compileNative } from './compile.js';
import { readNative } from './check.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = checkPublicLanguage(root);
function changed(file: string, before: string, after: string) {
  let count = 0;
  const inputs = baseline.inputs.map((input) => {
    if (!input.path.endsWith(file)) return input;
    expect(input.text).toContain(before);
    count++;
    return { ...input, text: input.text.replace(before, after) };
  });
  expect(count).toBe(1);
  return compilePublicLanguage(inputs, baseline.folders);
}
function evaluate(name: string, requirement: string, evaluator?: ClauseEvaluator, graph = baseline.graph) {
  const contract = [...graph.nodes.values()].find((n) => n.name === name)!;
  const evaluators = evaluator ? new Map([[contract.identity, new Map([[requirement, evaluator]])]]) : undefined;
  return validateAdoption(graph, evaluators).find((a) => a.scope.endsWith(`->${contract.identity}`))!;
}
describe('public language conformance', () => {
  it('admits a closed public corpus and compiles an original method without private authored inputs', () => {
    expect(baseline.ok).toBe(true);
    expect(baseline.graph.dangling).toEqual([]);
    expect(baseline.native.registry.registrations.size).toBe(43);
    expect(baseline.folders).toHaveLength(11);
    expect(
      baseline.inputs.some((i) =>
        /\/(inventarch|code-quality|architecture|agent-authoring|delivery)-system\//.test(i.path),
      ),
    ).toBe(false);
    expect(JSON.stringify(baseline.harness)).toContain('Read the supplied label and return it unchanged.');
  });
  it('refuses missing required fields', () => {
    const result = changed('composition.ia', '    agent @agent example-reader\n', '');
    expect(result.ok).toBe(false);
    expect(result.native.ok).toBe(false);
  });
  it('preserves canonical public word ownership, lowering, facets and schema enrollment', () => {
    const original = compileNative(readNative(root).inputs);
    for (const [word, registration] of baseline.native.registry.registrations) {
      const source = original.registry.registrations.get(word)!;
      expect(source).toBeDefined();
      for (const key of ['system', 'kind', 'category', 'facets', 'schema'] as const)
        expect(registration[key]).toEqual(source[key]);
    }
  });
  it('refuses dangling boundary relationships', () => {
    const result = changed('architecture.ia', 'uses @workspace example-storage', 'uses @workspace missing-storage');
    expect(result.ok).toBe(false);
    expect(result.graph.dangling.length).toBeGreaterThan(0);
  });
  it('refuses a missing profile and recursive capability', () => {
    expect(
      changed(
        'composition.ia',
        'profiles [@agent-profile example-profile]',
        'profiles [@agent-profile missing-profile]',
      ).ok,
    ).toBe(false);
    expect(
      changed('composition.ia', '    operations []', '    operations []\n    includes [@capability example-label]')
        .harness.ok,
    ).toBe(false);
  });
  it('refuses unavailable host implementations', () => {
    const catalog = { ...exampleCatalog(), models: {} };
    expect(
      compileHarness(publicCapture(baseline.inputs, baseline.folders), {
        harness: 'example-harness',
        entry: 'example-entry',
        catalog,
      }).ok,
    ).toBe(false);
  });
  it('does not turn declared cases or unavailable evaluators into a pass', () => {
    expect(evaluate('example-quality', 'REQ-EXAMPLE-NEWLINE').outcome).toBe('not-evaluated');
    expect(
      evaluate('example-quality', 'REQ-EXAMPLE-NEWLINE', () => {
        throw new Error('unavailable');
      }).outcome,
    ).toBe('not-evaluated');
  });
  it.each([
    ['module\n', 'pass'],
    ['module', 'fail'],
  ] as const)('evaluates actual source bytes %j as %s', (source, outcome) => {
    const bytes = Buffer.from(source);
    expect(
      evaluate('example-quality', 'REQ-EXAMPLE-NEWLINE', () => ({
        outcome: bytes.at(-1) === 10 ? 'pass' : 'fail',
        message: 'Observed the final source byte',
      })).outcome,
    ).toBe(outcome);
  });
  it('evaluates the actual architectural dependency and refuses a missing edge', () => {
    const evaluator: ClauseEvaluator = ({ graph, adopter }) => ({
      outcome: (graph.out.get(adopter.identity)?.get('use') ?? []).some(
        (edge) => edge.to !== null && graph.nodes.get(edge.to)?.name === 'example-storage',
      )
        ? 'pass'
        : 'fail',
      message: 'Observed interface dependency edges',
    });
    expect(evaluate('example-boundary', 'REQ-EXAMPLE-BOUNDARY', evaluator).outcome).toBe('pass');
    const result = changed('architecture.ia', '    uses @workspace example-storage\n', '');
    expect(result.ok).toBe(true);
    expect(evaluate('example-boundary', 'REQ-EXAMPLE-BOUNDARY', evaluator, result.graph).outcome).toBe('fail');
  });
  it('keeps every generated word reference synchronized with its schema', () => {
    for (const [name, text] of Object.entries(vocabularyOutputs(root)))
      expect(readFileSync(resolve(root, 'docs/reference/language', name), 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });
  it('packs the language base from the vocabulary and its root record alone, without examples', () => {
    const { inputs, folders } = languagePackageInputs(root);
    const descriptor = {
      formatVersion: 1,
      id: 'inventarch/language',
      version: '1.0.0',
      distribution: 'workspace-system/definition/distribution/language-distribution',
      engine: '^0.1.0',
      language: ['1.0'],
      dependencies: [],
      assets: [],
      source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
      license: 'UNLICENSED',
      description: 'Public IA language vocabulary',
    };
    const packed = packSnapshot(
      distributionSnapshot({ sources: inputs, folders, floorOrigin: 'local' }),
      descriptor,
      new Map(),
    );
    expect(packed.manifest.roots).toEqual(['workspace-system/definition/workspace/language-workspace']);
    expect(packed.manifest.systems.map((s) => s.name)).toEqual([...folders].sort());
    expect(packed.manifest.systems).toHaveLength(11);
    expect(
      packed.manifest.files.map((f) => f.path).filter((p) => !p.endsWith('/system.ia') && !p.includes('/schemas/')),
    ).toEqual(['.ia/src/systems/workspace-system/records/language.ia']);
  });
});
