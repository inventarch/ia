import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Engine, manifestDigest } from '@ia/agent-system';
import type { EngineHost, Grant, ModelAction, OperationContext } from '@ia/agent-system';
import { copy, digest, memoryStore } from '@ia/session-system';
import { compileHarness, Corpus, executionManifest } from '../src/index.js';
import { captureResources, resourceOccurrences } from '../src/resources.js';
import { draftToolAdapters, DRAFT_TOOL_IDS } from '../src/tools.js';
import type { DraftToolOptions } from '../src/tools.js';

// Cases rebuild captured native views for several tool setups; under full-suite load one case nears the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

import { compilerCapture, compilerToolCatalog as draftToolCatalog } from './compiler-fixture.js';

const root = resolve(import.meta.dirname, '../../../../..'),
  base = compilerCapture(root),
  code = digest('verified test implementation'),
  cleanups: (() => void)[] = [];
const temp = mkdtempSync(resolve(tmpdir(), 'ia-engine-tools-'));
const tree = JSON.stringify({
  format: 'ia.structured-template.v1',
  inputs: { title: { type: 'text', required: true } },
  nodes: [
    { kind: 'value', input: 'title' },
    { kind: 'value', input: 'title' },
  ],
});
mkdirSync(resolve(temp, 'templates'));
writeFileSync(resolve(temp, 'templates/tool.json'), tree);
const { revision: _revision, ...body } = base;
const native =
  '#! ia 1.0\n@template tool-note\n  meaning\n    says "Render the original engine fixture."\n    answers "What is rendered?"\n  template\n    filename "docs/tool-note.md"\n    parameters []\n    lines []\n    profile structured-v1\n    resource "templates/tool.json"\n';
const source = {
  ...base.sources.find((s) => s.path === '.ia/src/systems/template-system/system.ia')!,
  path: '.ia/src/systems/template-system/records/tool-note.ia',
  text: native,
};
const changed = { ...body, sources: [...body.sources, source] },
  capture = { ...changed, revision: digest(changed) };
for (const item of capture.sources.filter(
  (s) => s.path.startsWith('.ia/src/') && (capture.floorOrigin === 'local' || !s.path.startsWith('.ia/src/floor/')),
)) {
  const target = resolve(temp, item.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, item.text);
}
const owner = resourceOccurrences(capture).occurrences.find((o) => o.identity.endsWith('/tool-note'))!;
const key = { source: owner.source, revision: owner.revision, path: 'templates/tool.json' };
const resources = captureResources(capture, {
  roots: [{ source: owner.source, revision: owner.revision, root: temp }],
  files: [
    {
      key,
      bytes: Buffer.byteLength(tree),
      sha256: createHash('sha256').update(tree).digest('hex'),
      mediaType: 'application/json',
      encoding: 'utf8',
    },
  ],
  associations: [
    { owner, resources: [{ key, role: 'template', required: true, order: 0, delivery: 'installed-reference' }] },
  ],
});
const path = '.ia/src/systems/agent-system/records/engine-tool-draft.ia',
  text =
    '#! ia 1.0\n@agent engine-tool-draft\n  meaning\n    says    "A bounded draft."\n    answers "Who reviews?"\n  governance\n    applies []\n';
function setup(kind = 'draft', additions: Partial<DraftToolOptions> = {}) {
  const catalog = draftToolCatalog('test', code, additions.resources),
    compiled = compileHarness(capture, { harness: `native-${kind}-tools`, entry: `${kind}-tools-entry`, catalog });
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const manifest = executionManifest(compiled.manifest, catalog),
    tools = draftToolAdapters(capture, {
      manifest,
      principal: 'alice',
      implementationDigest: code,
      current: () => true,
      ...additions,
    });
  cleanups.push(tools.close);
  const grant: Grant = {
    id: 'tools',
    principal: 'alice',
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    operations: Object.keys(manifest.operations),
    sources: [capture.revision],
    models: ['test'],
    effects: ['read'],
    expiresAt: Date.now() + 600000,
    limits: {
      steps: 32,
      modelCalls: 16,
      operations: 16,
      tokens: 500000,
      children: 4,
      depth: 2,
      bytes: 32 * 1024 * 1024,
      deadline: Date.now() + 600000,
    },
  };
  const context: OperationContext = {
    sessionId: 's',
    runId: 'root',
    invocationId: 'i',
    attemptId: 'a',
    principal: 'alice',
    grant,
    manifest,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
  };
  return { catalog, manifest, tools, context, grant, entry: compiled.manifest.entry.profile };
}
const resourceSelection = () => ({
  envelope: resources,
  digest: resources.digest,
  allowed: [key],
  templates: [owner.identity],
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
afterAll(() => {
  if (dirname(temp) !== resolve(tmpdir()) || !temp.startsWith(resolve(tmpdir(), 'ia-engine-tools-')))
    throw Error('Unsafe cleanup');
  rmSync(temp, { recursive: true, force: true });
});

async function engineRun(kind: string, actions: ModelAction[], additions: Partial<DraftToolOptions> = {}) {
  const f = setup(kind, additions),
    store = memoryStore(),
    corpus = new Corpus(capture);
  cleanups.push(() => corpus.close());
  const host: EngineHost = {
    store,
    operations: { ...f.tools.operations, [corpus.adapter.id]: corpus.adapter },
    model: {
      id: 'test',
      generate: async () => ({
        action: actions.shift() ?? {
          type: 'outcome',
          kind: 'answer',
          message: 'Draft prepared for review.',
          continuation: 'finish',
        },
        model: 'test',
        provider: 'fixture',
        usage: 1,
      }),
    },
    authorize: async () => f.grant,
    verifyManifest: async (candidate) => candidate.digest === f.manifest.digest,
    context: async (_profile, _task, grant) => corpus.context(grant),
    evaluate: async () => ({ status: 'unavailable', evidence: [], message: 'No extra checks installed' }),
    preflight: async () => true,
  };
  const engine = new Engine(f.manifest, host);
  await engine.start({
    sessionId: 's',
    commandId: 'start',
    principal: 'alice',
    profile: f.entry,
    task: 'Prepare an original draft.',
  });
  return { ...f, state: await engine.advance('s', 'alice'), store };
}
it('executes native validate/format through the actual engine with read receipts and exact drafts', async () => {
  const f = await engineRun('draft', [
    { type: 'invoke', operation: DRAFT_TOOL_IDS.validate, input: { path, text } },
    { type: 'invoke', operation: DRAFT_TOOL_IDS.format, input: { path, text } },
  ]);
  expect(f.state.runs['root']!.status).toBe('completed');
  const receipts = Object.values(f.state.receipts).filter(
    (r) => r.target === DRAFT_TOOL_IDS.validate || r.target === DRAFT_TOOL_IDS.format,
  );
  expect(receipts).toHaveLength(2);
  expect(receipts.every((r) => r.effect === 'none' && r.error === null)).toBe(true);
  expect(receipts[0]!.output).toMatchObject({ status: 'validated', artifacts: [] });
  expect(receipts[1]!.output).toMatchObject({
    status: 'draft',
    artifacts: [{ path, text: text.replace('says    ', 'says ') }],
  });
  expect(capture.sources.some((s) => s.path === path)).toBe(false);
});
it('executes captured rendering through the engine and refuses oversized results without artifacts', async () => {
  const f = await engineRun(
    'template',
    [
      {
        type: 'invoke',
        operation: DRAFT_TOOL_IDS.render,
        input: { template: owner.identity, values: '{"title":"Original"}' },
      },
      {
        type: 'invoke',
        operation: DRAFT_TOOL_IDS.render,
        input: { template: owner.identity, values: JSON.stringify({ title: 'x'.repeat(40000) }) },
      },
    ],
    { resources: resourceSelection() },
  );
  const receipts = Object.values(f.state.receipts).filter((r) => r.target === DRAFT_TOOL_IDS.render);
  expect(receipts[0]!.output).toMatchObject({
    status: 'draft',
    artifacts: [{ path: 'docs/tool-note.md', text: 'OriginalOriginal' }],
  });
  expect(receipts[1]!.output).toMatchObject({ status: 'refused', code: 'IA-TOOLS-RESULT-LIMIT', artifacts: [] });
});
it('refuses forged model root/actor/binding fields at the engine schema before dispatch', async () => {
  for (const field of ['root', 'actor', 'scope', 'digest', 'module']) {
    const { state } = await engineRun('draft', [
      { type: 'invoke', operation: DRAFT_TOOL_IDS.format, input: { path, text, [field]: 'forged' } },
    ]);
    expect(state.runs['root']).toMatchObject({
      status: 'waiting',
      pendingAction: null,
      wait: { reason: 'invalid-model-action', continuation: 'repair', details: { code: 'IA-ENGINE-INPUT-INVALID' } },
    });
    expect(state.budget.operations).toBe(0);
    expect(Object.values(state.attempts).some((attempt) => attempt.kind === 'operation')).toBe(false);
  }
});
it('refuses wrong principal, manifest, grant, cancellation and missing engine authority', async () => {
  const f = setup(),
    adapter = f.tools.operations['ia.draft.format.v1']!;
  const changed = copy(f.manifest);
  changed.workspace = 'forged';
  changed.digest = manifestDigest(changed);
  const missing = { ...f.context };
  delete missing.assertCurrent;
  await expect(adapter.execute({ path, text }, missing)).rejects.toThrow();
  const cases: Partial<OperationContext>[] = [
    { principal: 'mallory' },
    { manifest: changed },
    { grant: { ...f.grant, sources: [] } },
    { grant: { ...f.grant, operations: [] } },
    { grant: { ...f.grant, effects: [] } },
    { grant: { ...f.grant, workspace: 'other' } },
    { grant: { ...f.grant, expiresAt: 1 } },
    { signal: AbortSignal.abort() },
  ];
  for (const override of cases)
    await expect(adapter.execute({ path, text }, { ...f.context, ...override })).rejects.toThrow();
  expect(f.context.assertCurrent).not.toHaveBeenCalled();
});
it('rechecks source and refreshed grants before returning any artifact', async () => {
  let checks = 0;
  const f = setup('draft', { current: () => ++checks === 1 }),
    adapter = f.tools.operations['ia.draft.format.v1']!;
  await expect(adapter.execute({ path, text }, f.context)).rejects.toThrow('selection changed');
  const next = setup();
  next.context.assertCurrent = async () => {
    next.context.grant = { ...next.grant, sources: [] };
  };
  await expect(next.tools.operations['ia.draft.format.v1']!.execute({ path, text }, next.context)).rejects.toThrow(
    'authority',
  );
});
it('refuses narrow contextual previews and independently excluded template resources', async () => {
  const f = setup('draft', { identities: [owner.identity] });
  expect((await f.tools.operations['ia.draft.validate.v1']!.execute({ path, text }, f.context)).output).toMatchObject({
    status: 'refused',
    code: 'IA-EXEC-SCOPE-UNAVAILABLE',
    artifacts: [],
    diagnostics: [],
  });
  for (const options of [
    {},
    { resources: { ...resourceSelection(), allowed: [] } },
    { resources: { ...resourceSelection(), templates: [] } },
    { resources: resourceSelection(), identities: [] },
  ]) {
    const scoped = setup('template', options);
    const result = await scoped.tools.operations['ia.template.render.v1']!.execute(
      { template: owner.identity, values: '{"title":"Private"}' },
      scoped.context,
    );
    expect(result.output).toMatchObject({ status: 'refused', artifacts: [] });
    expect(JSON.stringify(result.output)).not.toContain('Private');
  }
});
it('refuses unavailable catalogs, changed implementation/resource pins and forged operation contracts', () => {
  const catalog = draftToolCatalog('test', code);
  delete catalog.operations['draft-format-v1'];
  expect(compileHarness(capture, { harness: 'native-draft-tools', entry: 'draft-tools-entry', catalog })).toMatchObject(
    { ok: false },
  );
  const f = setup(),
    altered = copy(f.manifest);
  altered.operations[DRAFT_TOOL_IDS.format]!.effects = ['local-write'];
  altered.digest = manifestDigest(altered);
  for (const override of [
    { implementationDigest: digest('different') },
    { manifest: altered },
    { resources: { ...resourceSelection(), digest: digest('forged') } },
  ])
    expect(() =>
      draftToolAdapters(capture, {
        manifest: f.manifest,
        principal: 'alice',
        implementationDigest: code,
        current: () => true,
        ...override,
      }),
    ).toThrow();
  const selected = setup('template', { resources: resourceSelection() });
  expect(() =>
    draftToolAdapters(capture, {
      manifest: selected.manifest,
      principal: 'alice',
      implementationDigest: code,
      current: () => true,
      resources: { ...resourceSelection(), allowed: [] },
    }),
  ).toThrow('installed descriptor');
});
