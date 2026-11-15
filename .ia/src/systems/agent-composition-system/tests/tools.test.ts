import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { EditorSnapshot } from '@inventarch/db/editor';
import { field, text as textField } from '@inventarch/runtime/authoring-execution';
import { Engine, manifestDigest } from '@inventarch/agent-system';
import type { EngineHost, Grant, ModelAction, OperationContext } from '@inventarch/agent-system';
import { copy, digest, memoryStore } from '@inventarch/session-system';
import { compileHarness, executionManifest } from '../src/index.js';
import type { CatalogAliases } from '../src/index.js';
import { Corpus } from '@inventarch/workspace-runtime';
import type { Capture } from '@inventarch/workspace-runtime';
import { captureResources, resourceOccurrences } from '@inventarch/workspace-runtime/resources';
import { draftToolAdapters, draftToolAliases, DRAFT_TOOL_IDS } from '../src/tools.js';
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
  '#! ia 1.0\n@template tool-note\n  meaning\n    says "Render the original engine fixture."\n    answers "What is rendered?"\n  template\n    filename "docs/tool-note.md"\n    parameters []\n    lines []\n    profile structured\n    resource "templates/tool.json"\n';
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
function declaredDraftCase(name: string, operation: string): string {
  const reader = new EditorSnapshot({
    root,
    sources: base.sources,
    folders: base.folders,
    floorOrigin: base.floorOrigin,
    fingerprint: base.revision,
    ...(base.activation ? { activation: base.activation } : {}),
  });
  try {
    const cases = reader.records().filter((row) => row.discriminator === 'case' && row.name === name);
    expect(cases).toHaveLength(1);
    const row = cases[0]!;
    expect(row.source.path).toBe('.ia/src/systems/authoring-system/cases/governed-drafts.ia');
    expect(textField(field(row, 'scenario', 'evaluator'))).toBe(
      '.ia/src/systems/agent-composition-system/tests/tools.test.ts',
    );
    expect(field(row, 'scenario', 'operation')).toMatchObject({
      kind: 'ref',
      discriminator: 'operation',
      name: operation,
    });
    expect(textField(field(row, 'scenario', 'kind'))).toBe(name.endsWith('refusal') ? 'refusal' : 'success');
    const contract = reader
      .records()
      .find((item) => item.discriminator === 'contract' && item.name === 'executable-authoring-contract');
    expect(contract).toBeDefined();
    const requirements = name.endsWith('refusal') ? ['REQ-EXEC-REFUSE'] : ['REQ-EXEC-INPUT', 'REQ-EXEC-RESULT'];
    const links = row.edges.filter((edge) => edge.predicate === 'implement');
    expect(links.map((edge) => edge.fragment).sort()).toEqual([...requirements].sort());
    for (const link of links) {
      expect(link).toMatchObject({
        direction: 'out',
        reference: { kind: 'ref', discriminator: 'contract', name: contract!.name },
      });
      expect(link.condition).toBeUndefined();
    }
    const declaration = reader.records().find((item) => item.discriminator === 'operation' && item.name === operation);
    expect(declaration).toBeDefined();
    for (const requirement of requirements)
      expect(declaration!.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            predicate: 'implement',
            direction: 'out',
            reference: { kind: 'ref', discriminator: 'contract', name: contract!.name, fragment: requirement },
            fragment: requirement,
          }),
        ]),
      );
    return textField(field(row, 'scenario', 'code'));
  } finally {
    reader.close();
  }
}

interface Shape {
  /** Records as written before names stopped carrying their version. */
  capture?: Capture;
  aliases?: CatalogAliases;
  /** Compile against a catalog that has only the original entries, then bridge against the full one. */
  originalOnly?: boolean;
}
const plainName =
  /^(draft-validate|draft-format|captured-template-render|draft-text|captured-template-input|draft-result)$/;
function setup(kind = 'draft', additions: Partial<DraftToolOptions> = {}, shape: Shape = {}) {
  const catalog = draftToolCatalog('test', code, additions.resources),
    chosen = shape.originalOnly
      ? {
          ...catalog,
          operations: Object.fromEntries(Object.entries(catalog.operations).filter(([name]) => !plainName.test(name))),
          validators: Object.fromEntries(Object.entries(catalog.validators).filter(([name]) => !plainName.test(name))),
        }
      : catalog,
    used = shape.capture ?? capture,
    compiled = compileHarness(used, {
      harness: `native-${kind}-tools`,
      entry: `${kind}-tools-entry`,
      catalog: chosen,
      ...(shape.aliases ? { aliases: shape.aliases } : {}),
    });
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const manifest = executionManifest(compiled.manifest, catalog),
    tools = draftToolAdapters(used, {
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
    sources: [used.revision],
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
  for (const operation of ['validate-draft', 'format-draft']) {
    const receipt = receipts.find((row) => row.target.endsWith('/' + operation))!;
    expect(receipt.error === null && receipt.effect === 'none' ? 'pass' : 'failed').toBe(
      declaredDraftCase(operation + '-success', operation),
    );
  }
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
    adapter = f.tools.operations['draft-format']!;
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
    adapter = f.tools.operations['draft-format']!;
  await expect(adapter.execute({ path, text }, f.context)).rejects.toThrow('selection changed');
  const next = setup();
  next.context.assertCurrent = async () => {
    next.context.grant = { ...next.grant, sources: [] };
  };
  await expect(next.tools.operations['draft-format']!.execute({ path, text }, next.context)).rejects.toThrow(
    'authority',
  );
});
it('refuses narrow contextual previews and independently excluded template resources', async () => {
  const f = setup('draft', { identities: [owner.identity] });
  for (const [operation, handler] of [
    ['validate-draft', 'draft-validate'],
    ['format-draft', 'draft-format'],
  ] as const) {
    const result = await f.tools.operations[handler]!.execute({ path, text }, f.context);
    expect(result.output).toMatchObject({
      status: 'refused',
      code: declaredDraftCase(operation + '-scope-refusal', operation),
      artifacts: [],
      diagnostics: [],
    });
    expect(result.effect).toBe('none');
  }
  for (const options of [
    {},
    { resources: { ...resourceSelection(), allowed: [] } },
    { resources: { ...resourceSelection(), templates: [] } },
    { resources: resourceSelection(), identities: [] },
  ]) {
    const scoped = setup('template', options);
    const result = await scoped.tools.operations['captured-template-render']!.execute(
      { template: owner.identity, values: '{"title":"Private"}' },
      scoped.context,
    );
    expect(result.output).toMatchObject({ status: 'refused', artifacts: [] });
    expect(JSON.stringify(result.output)).not.toContain('Private');
  }
});
it('refuses unavailable catalogs, changed implementation/resource pins and forged operation contracts', () => {
  const catalog = draftToolCatalog('test', code);
  delete catalog.operations['draft-format'];
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

// A contract's version is its entry's `version`, so the draft tools have plain names. The original entries stay, byte
// for byte, for harnesses pinned before that; records that still name them compile to the plain entries by the aliases.
const originalPaths = [
  '.ia/src/systems/agent-composition-system/records/validate-draft-binding.ia',
  '.ia/src/systems/agent-composition-system/records/format-draft-binding.ia',
  '.ia/src/systems/agent-composition-system/records/render-captured-template-binding.ia',
  '.ia/src/systems/authoring-system/operations/validate-draft.ia',
  '.ia/src/systems/authoring-system/operations/format-draft.ia',
  '.ia/src/systems/template-system/operations/render-captured-template.ia',
];
const withVersions = (text: string) =>
  text.replace(
    /^(\s+(?:handler|input|output|implementation) (?:draft-validate|draft-format|captured-template-render|draft-text|captured-template-input|draft-result))$/gm,
    '$1-v1',
  );
const { revision: _plainRevision, ...plainBody } = capture;
const originalBody = {
    ...plainBody,
    sources: capture.sources.map((row) =>
      originalPaths.includes(row.path) ? { ...row, text: withVersions(row.text) } : row,
    ),
  },
  originalCapture: Capture = { ...originalBody, revision: digest(originalBody) };
// Resource envelopes are bound to the capture revision and its physical sources, so the original-name capture has its
// own directory and envelope.
const tempOriginal = mkdtempSync(resolve(tmpdir(), 'ia-engine-tools-'));
mkdirSync(resolve(tempOriginal, 'templates'));
writeFileSync(resolve(tempOriginal, 'templates/tool.json'), tree);
for (const item of originalCapture.sources.filter(
  (row) =>
    row.path.startsWith('.ia/src/') &&
    (originalCapture.floorOrigin === 'local' || !row.path.startsWith('.ia/src/floor/')),
)) {
  const target = resolve(tempOriginal, item.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, item.text);
}
afterAll(() => rmSync(tempOriginal, { recursive: true, force: true }));
// Resource envelopes are bound to the capture revision, so the original-name capture needs its own.
const originalOwner = resourceOccurrences(originalCapture).occurrences.find((o) => o.identity.endsWith('/tool-note'))!;
const originalKey = { source: originalOwner.source, revision: originalOwner.revision, path: 'templates/tool.json' };
const originalResources = captureResources(originalCapture, {
  roots: [{ source: originalOwner.source, revision: originalOwner.revision, root: tempOriginal }],
  files: [
    {
      key: originalKey,
      bytes: Buffer.byteLength(tree),
      sha256: createHash('sha256').update(tree).digest('hex'),
      mediaType: 'application/json',
      encoding: 'utf8',
    },
  ],
  associations: [
    {
      owner: originalOwner,
      resources: [{ key: originalKey, role: 'template', required: true, order: 0, delivery: 'installed-reference' }],
    },
  ],
});
const pinned = (kind: string, shape: Shape = {}) =>
  setup(
    kind,
    kind === 'template'
      ? {
          resources: shape.capture
            ? {
                envelope: originalResources,
                digest: originalResources.digest,
                allowed: [originalKey],
                templates: [originalOwner.identity],
              }
            : resourceSelection(),
        }
      : {},
    shape,
  );
const toolPins = (f: ReturnType<typeof setup>) =>
  (
    f.manifest.provenance as { compiled: { provenance: { installed: { group: string; id: string }[] } } }
  ).compiled.provenance.installed
    .filter((pin) => pin.group === 'operations' && /draft|captured-template/.test(pin.id))
    .map((pin) => pin.id)
    .sort();
const toolOperations = (f: ReturnType<typeof setup>) =>
  Object.values(f.manifest.operations).filter((op) => Object.values(DRAFT_TOOL_IDS).includes(op.id));
const toolIds = [
  ['validate', 'draft-validate', 'ia.draft.validate.v1', 'draft-text'],
  ['format', 'draft-format', 'ia.draft.format.v1', 'draft-text'],
  ['render', 'captured-template-render', 'ia.template.render.v1', 'captured-template-input'],
] as const;

it('keeps the original draft tool entries byte for byte beside the plain ones', () => {
  const selection = { digest: digest('r'), allowed: [], templates: [] };
  const catalog = draftToolCatalog('test', code, selection);
  const render = digest({ implementationDigest: code, resources: selection });
  for (const [which, plain, handler, input] of toolIds) {
    const identity = DRAFT_TOOL_IDS[which],
      owner = which === 'render' ? 'template-system' : 'authoring-system',
      implementationDigest = which === 'render' ? render : code;
    const value = {
      identity,
      owner,
      handler,
      implementationDigest,
      input: input + '-v1',
      output: 'draft-result-v1',
      effects: ['read'],
      recovery: 'repeatable',
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      preflight: 'captured-workspace',
    };
    const original = catalog.operations[plain + '-v1']!;
    expect(original.version).toBe(1);
    expect(original.value).toEqual(value);
    expect(original.digest).toBe(digest({ version: 1, value }));
    expect(catalog.operations[plain]!.value).toEqual({ ...value, handler: plain, input, output: 'draft-result' });
  }
  for (const name of ['draft-text', 'captured-template-input', 'draft-result'])
    expect(catalog.validators[name + '-v1']).toEqual(catalog.validators[name]);
  expect(draftToolAliases()).toEqual({
    operations: {
      'draft-validate-v1': 'draft-validate',
      'draft-format-v1': 'draft-format',
      'captured-template-render-v1': 'captured-template-render',
    },
    validators: {
      'draft-text-v1': 'draft-text',
      'captured-template-input-v1': 'captured-template-input',
      'draft-result-v1': 'draft-result',
    },
  });
});
it('compiles records with the plain names, pinning the plain entries and handlers', () => {
  for (const [kind, plain] of [
    ['draft', ['draft-format', 'draft-validate']],
    ['template', ['captured-template-render']],
  ] as const) {
    const f = pinned(kind);
    expect(toolPins(f)).toEqual(plain);
    for (const op of toolOperations(f)) expect(plain).toContain(op.handler);
    for (const [, name, handler] of toolIds)
      if (plain.some((p) => p === name))
        expect([f.tools.operations[name]?.id, f.tools.operations[handler]?.id]).toEqual([name, handler]);
  }
});
it('compiles records that still name the original ids through the aliases to the plain entries', () => {
  for (const kind of ['draft', 'template']) {
    const f = pinned(kind, { capture: originalCapture, aliases: draftToolAliases() }),
      plain = pinned(kind);
    expect(toolPins(f)).toEqual(toolPins(plain));
    const compiled = (f.manifest.provenance as { compiled: { provenance: { aliases?: { group: string }[] } } })
      .compiled;
    expect(compiled.provenance.aliases?.some((row) => row.group === 'operations')).toBe(true);
    expect(compiled.provenance.aliases?.some((row) => row.group === 'validators')).toBe(true);
    for (const op of toolOperations(f)) expect(op.handler).not.toContain('.');
  }
});
it('keeps a harness pinned to the original entries valid and dispatching by the original handlers', async () => {
  for (const kind of ['draft', 'template']) {
    const f = pinned(kind, { capture: originalCapture, originalOnly: true });
    expect(toolPins(f).every((id) => id.endsWith('-v1'))).toBe(true);
    for (const op of toolOperations(f)) expect(op.handler).toMatch(/^ia\./);
  }
  const f = pinned('draft', { capture: originalCapture, originalOnly: true });
  const result = await f.tools.operations['ia.draft.format.v1']!.execute({ path, text }, f.context);
  expect(result.effect).toBe('none');
  expect(result.output).toMatchObject({ status: 'draft' });
  expect(f.tools.operations['ia.draft.format.v1']!.id).toBe('ia.draft.format.v1');
  const renderer = pinned('template', { capture: originalCapture, originalOnly: true });
  expect(renderer.tools.operations['ia.template.render.v1']).toBeDefined();
});
