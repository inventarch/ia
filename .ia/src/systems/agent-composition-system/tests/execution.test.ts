import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Engine, manifestDigest, validateShape } from '@inventarch/agent-system';
import type { EngineHost, Grant } from '@inventarch/agent-system';
import { digest, memoryStore } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import type { CandidateEnvelope, CandidateScope } from '@inventarch/runtime';
import { candidateValidation, compileHarness, Corpus, executionManifest, installed } from '../src/index.js';

import { executionFixture, executionCatalog as inspectionCatalog } from './execution-fixture.js';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const capture = executionFixture(root),
  implementation = digest(readFileSync(`${root}/packages/workspace-runtime/src/candidate.ts`, 'utf8'));
const catalog = inspectionCatalog('test', implementation);
function compiled() {
  const result = compileHarness(capture, { harness: 'example-harness', entry: 'example-entry', catalog });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.manifest;
}
const path = '.ia/src/systems/agent-system/records/p2-reviewer.ia';
const text =
  '#! ia 1.0\n@agent p2-reviewer\n  meaning\n    says "Review proposed records."\n    answers "Who reviews?"\n  governance\n    applies []\n';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
function candidate() {
  const scope: CandidateScope = {
    sourceSet: capture.id,
    revision: capture.revision,
    composition: [{ sourceSet: capture.id, revision: capture.revision }],
    systems: ['agent-system'],
    paths: [path],
  };
  const value: CandidateEnvelope = {
    version: 1,
    sourceSet: capture.id,
    base: { revision: capture.revision, composition: scope.composition },
    target: { system: 'agent-system', discriminator: 'agent' },
    files: [{ path, text, digest: sha(text) }],
    evidence: [],
  };
  return { scope, value };
}
it('executes a compiled native profile through the shared engine and rejects an invalid task at start', async () => {
  const native = compiled(),
    manifest = executionManifest(native, catalog),
    store = memoryStore(),
    corpus = new Corpus(capture);
  const grant: Grant = {
    id: 'native',
    principal: 'alice',
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    operations: Object.keys(manifest.operations),
    effects: ['read'],
    sources: [capture.revision],
    models: ['test'],
    expiresAt: Date.now() + 600000,
    limits: {
      steps: 100,
      modelCalls: 100,
      operations: 100,
      tokens: 500000,
      children: 10,
      depth: 10,
      bytes: 10000000,
      deadline: Date.now() + 600000,
    },
  };
  const host: EngineHost = {
    store,
    model: {
      id: 'test',
      generate: async () => ({
        action: { type: 'outcome', kind: 'answer', message: 'Native task admitted', continuation: 'finish' },
        usage: 1,
        model: 'test',
        provider: 'test',
      }),
    },
    operations: { [corpus.adapter.id]: corpus.adapter },
    authorize: async () => grant,
    context: async (_p, _t, g) => corpus.context(g),
    verifyManifest: async (m) => m.digest === manifest.digest,
    evaluate: async () => ({ status: 'unavailable', evidence: [], message: 'No extra evaluator installed' }),
  };
  try {
    const engine = new Engine(manifest, host),
      request = {
        sessionId: 's',
        commandId: 'start',
        principal: 'alice',
        profile: native.entry.profile,
        task: 'Inspect',
      };
    await expect(engine.start({ ...request, task: { text: 'not the installed text schema' } })).rejects.toMatchObject({
      code: 'IA-ENGINE-TASK-INVALID',
    });
    const started = await engine.start(request);
    expect(started.limits.modelCalls).toBe(1);
    expect(started.limits.tokens).toBe(400000);
    expect((await engine.advance('s', 'alice')).runs['root']!.status).toBe('completed');
    const changed = inspectionCatalog('different', implementation);
    expect(() => executionManifest(native, changed)).toThrow('Installed contract changed');
    const tagged = inspectionCatalog('test', implementation);
    tagged.operations['corpus-inspect-v1'] = installed({
      ...tagged.operations['corpus-inspect-v1']!.value,
      purpose: 'candidate-validation',
    });
    const taggedResult = compileHarness(capture, {
      harness: 'example-harness',
      entry: 'example-entry',
      catalog: tagged,
    });
    if (!taggedResult.ok) throw new Error(JSON.stringify(taggedResult));
    expect(Object.values(executionManifest(taggedResult.manifest, tagged).operations)[0]!.purpose).toBe(
      'candidate-validation',
    );
  } finally {
    corpus.close();
  }
});
it('validates actual native candidate bytes through public runtime admission with journal-compatible digests', async () => {
  const { scope, value } = candidate(),
    binding = candidateValidation(capture, scope, implementation);
  const native = executionManifest(compiled(), catalog);
  native.operations[binding.definition.id] = binding.definition;
  native.digest = manifestDigest(native);
  const grant = { sources: [capture.revision] } as Grant;
  const context = {
    sessionId: 's',
    runId: 'root',
    invocationId: 'inv',
    attemptId: 'attempt',
    principal: 'alice',
    grant,
    manifest: native,
    signal: new AbortController().signal,
  };
  const result = await binding.adapter.execute(value as unknown as Json, context);
  expect(result).toMatchObject({
    effect: 'none',
    output: { allowed: true, candidateDigest: digest(value), artifactDigest: digest(value.files), diagnostics: [] },
  });
  expect(validateShape(binding.definition.output, result.output)).toBe(true);
  await expect(
    binding.adapter.execute(value as unknown as Json, { ...context, grant: { ...grant, sources: [] } }),
  ).rejects.toThrow('current grant');
});
it.each(['bytes', 'base', 'path', 'evidence', 'discriminator', 'reference'] as const)(
  'refuses candidate %s drift without disclosing unobserved source text',
  async (change) => {
    const { scope, value } = candidate(),
      binding = candidateValidation(capture, scope, implementation);
    if (change === 'bytes') value.files[0]!.text += '# altered';
    if (change === 'base') value.base.revision = digest('other');
    if (change === 'path') value.files[0]!.path = '../secret';
    if (change === 'evidence')
      value.evidence = [{ path: '.ia/src/hidden-secret.ia', digest: digest('invented'), line: 1, endLine: 2 }];
    if (change === 'discriminator') value.target.discriminator = 'system';
    if (change === 'reference') {
      value.files[0]!.text = text.replace('applies []', 'applies [@system unobserved-secret]');
      value.files[0]!.digest = sha(value.files[0]!.text);
    }
    const output = await binding.adapter.execute(value as unknown as Json, {
      sessionId: 's',
      runId: 'root',
      invocationId: 'i',
      attemptId: 'a',
      principal: 'alice',
      grant: { sources: [capture.revision] } as Grant,
      manifest: {} as never,
      signal: new AbortController().signal,
    });
    expect(output.output).toMatchObject({ allowed: false });
    expect(JSON.stringify(output.output)).not.toContain('secret');
    expect(validateShape(binding.definition.output, output.output)).toBe(true);
  },
);
