import { expect, it, afterEach, vi } from 'vitest';
import { EditorSnapshot } from '@inventarch/db/editor';
import { field, text as textField } from '@inventarch/runtime/authoring-execution';
import { resolve } from 'node:path';
import { Engine, manifestDigest } from '@inventarch/agent-system';
import type { OperationContext } from '@inventarch/agent-system';
import { copy, digest, memoryStore } from '@inventarch/session-system';
import * as SDK from '../src/index.js';
import * as code from '../src/installed-catalog.js';
import { readFixture, readPath, qualifyInstalledRead } from './installed-read-fixture.mjs';

vi.setConfig({ testTimeout: 30000 });
const root = resolve(import.meta.dirname, '../../../../..'),
  close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup();
  vi.restoreAllMocks();
});
function declaredReadCase(name: string, capture: SDK.Capture): string {
  const reader = new EditorSnapshot({
    root,
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  try {
    const cases = reader.records().filter((row) => row.discriminator === 'case' && row.name === name);
    expect(cases).toHaveLength(1);
    const row = cases[0]!;
    expect(row.source.path).toBe('.ia/src/systems/agent-composition-system/cases/read-captured-source.ia');
    expect(textField(field(row, 'scenario', 'evaluator'))).toBe(
      '.ia/src/systems/agent-composition-system/tests/installed-read.test.ts',
    );
    expect(field(row, 'scenario', 'operation')).toMatchObject({
      kind: 'ref',
      discriminator: 'operation',
      name: 'read-captured-source',
    });
    expect(textField(field(row, 'scenario', 'kind'))).toBe(name.endsWith('refusal') ? 'refusal' : 'success');
    const contract = reader
      .records()
      .find((item) => item.discriminator === 'contract' && item.name === 'agent-composition-runtime-contract');
    expect(contract).toBeDefined();
    const requirements = name.endsWith('refusal')
      ? ['REQ-RT-CAPTURED-REFUSE']
      : ['REQ-RT-CAPTURED-INPUT', 'REQ-RT-CAPTURED-READ'];
    const links = row.edges.filter((edge) => edge.predicate === 'implement');
    expect(links.map((edge) => edge.fragment).sort()).toEqual([...requirements].sort());
    for (const link of links) {
      expect(link).toMatchObject({
        direction: 'out',
        reference: { kind: 'ref', discriminator: 'contract', name: contract!.name },
      });
      expect(link.condition).toBeUndefined();
    }
    const declaration = reader
      .records()
      .find((item) => item.discriminator === 'operation' && item.name === 'read-captured-source');
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

function setup() {
  const fixture = readFixture(SDK, root),
    bound = SDK.installedReadAdapters(fixture.capture, fixture.options);
  close.push(bound.close);
  const context: OperationContext = {
    sessionId: 's',
    runId: 'root',
    attemptId: 'a',
    invocationId: 'i',
    principal: fixture.principal,
    grant: fixture.grant,
    manifest: fixture.manifest,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
  };
  return { ...fixture, bound, context, adapter: bound.operations[SDK.INSTALLED_READ.handler]! };
}

it('describes and binds a fixed first-party read without invoking source or grant callbacks', () => {
  const f = readFixture(SDK, root),
    currentCapture = vi.fn(() => f.capture);
  const bound = SDK.installedReadAdapters(f.capture, { ...f.options, currentCapture });
  close.push(bound.close);
  expect(currentCapture).not.toHaveBeenCalled();
  expect(Object.keys(bound.operations)).toEqual([SDK.INSTALLED_READ.handler]);
  expect(f.manifest.operations[SDK.INSTALLED_READ.operation]).toMatchObject({
    effects: ['read'],
    recovery: 'repeatable',
    handler: SDK.INSTALLED_READ.handler,
    maxOutputBytes: 65536,
  });
});
it('reads bounded retained native bytes with exact revision, citation and no effects', async () => {
  const f = setup(),
    result = await f.adapter.execute({ path: readPath, start: 1, limit: 1 }, f.context);
  expect(result.effect).toBe('none');
  expect(result.effect === 'none' ? 'pass' : result.effect).toBe(
    declaredReadCase('read-captured-source-success', f.capture),
  );
  expect(result.output).toMatchObject({
    revision: f.capture.revision,
    citations: [`${f.capture.id}@${f.capture.revision}:${readPath}`],
  });
  expect(JSON.parse((result.output as { text: string }).text)).toMatchObject({
    path: readPath,
    startLine: 2,
    lines: ['@agent installed-read-label'],
  });
  expect(f.context.assertCurrent).toHaveBeenCalledTimes(2);
});
it('retains the reader across repeated dispatches and refuses reads after its owner closes it', async () => {
  const retained = setup();
  for (let attempt = 0; attempt < 2; attempt++)
    expect((await retained.adapter.execute({ path: readPath, limit: 1 }, retained.context)).effect).toBe('none');
  retained.bound.close();
  await expect(retained.adapter.execute({ path: readPath }, retained.context)).rejects.toMatchObject({
    code: 'IA-INSTALLED-READ-DENIED',
  });
  const premature = setup();
  premature.bound.close();
  await expect(premature.adapter.execute({ path: readPath }, premature.context)).rejects.toMatchObject({
    code: 'IA-INSTALLED-READ-DENIED',
  });
  expect(premature.context.assertCurrent).not.toHaveBeenCalled();
});
it.each(['adopted', 'native-store'])(
  'binds %s native operation occurrences without relaxing StageE paths or loading a source module',
  async (origin) => {
    const f = readFixture(SDK, root),
      { revision: _revision, ...body } = f.capture;
    const source = body.sources.find((row) => row.path.endsWith('/operations/read-captured-source.ia'))!;
    const prefix = origin === 'adopted' ? '.ia/adopted/public-read' : '.ia/distributions/store';
    const next = {
      ...body,
      sources: body.sources
        .map((row) =>
          row === source
            ? {
                ...row,
                path: `${prefix}/${'a'.repeat(64)}/${row.path}`,
                location: {
                  placement: { kind: 'adopted' as const, band: 90 as const, reach: '' },
                  provenance: 'methodology' as const,
                },
              }
            : row,
        )
        .sort((a, b) => a.path.localeCompare(b.path, 'en')),
    };
    const capture = { ...next, revision: digest(next) },
      compilation = SDK.compileHarness(capture, {
        harness: 'installed-read-example-harness',
        entry: 'installed-read-example-entry',
        catalog: f.catalog,
      });
    expect(compilation.ok, JSON.stringify(compilation)).toBe(true);
    if (!compilation.ok) throw new Error(JSON.stringify(compilation));
    expect(compilation.manifest.operations[SDK.INSTALLED_READ.operation]!.physicalOwner).toBe(
      'agent-composition-system',
    );
    const manifest = SDK.executionManifest(compilation.manifest, f.catalog),
      bound = SDK.installedReadAdapters(capture, {
        ...f.options,
        compiled: compilation.manifest,
        manifest,
        currentCapture: () => capture,
      });
    close.push(bound.close);
    const context: OperationContext = {
      sessionId: 's',
      runId: 'root',
      attemptId: 'a',
      invocationId: 'i',
      principal: f.principal,
      grant: { ...f.grant, sources: [capture.revision] },
      manifest,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    };
    expect(
      (await bound.operations[SDK.INSTALLED_READ.handler]!.execute({ path: readPath, limit: 1 }, context)).effect,
    ).toBe('none');
  },
);
it('requires the compiled evaluator to pass before Engine invokes the installed adapter', async () => {
  const f = setup(),
    store = memoryStore(),
    dispatch = vi.spyOn(f.adapter, 'execute');
  const engine = new Engine(f.manifest, {
    store,
    operations: f.bound.operations,
    model: {
      id: 'policy-fixture',
      generate: async () => ({
        action: { type: 'invoke', operation: SDK.INSTALLED_READ.operation, input: { path: readPath } },
        usage: 1,
        provider: 'deterministic-fake',
        model: 'example/scripted-read',
      }),
    },
    authorize: async () => f.grant,
    verifyManifest: async (manifest) => digest(manifest) === digest(f.manifest),
    context: async () => ({}),
    evaluate: async () => ({ status: 'fail', evidence: [], message: 'The fixture policy refuses.' }),
    preflight: async () => true,
  });
  try {
    await engine.start({
      sessionId: 'policy',
      commandId: 'start',
      principal: f.principal,
      profile: f.profile,
      task: 'Read only if the policy passes.',
    });
    await expect(engine.advance('policy', f.principal)).rejects.toMatchObject({ code: 'IA-ENGINE-GOVERNANCE-DENIED' });
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await store.close();
  }
});
it('refuses paths outside the capture and caller-supplied authority, module or unbounded arguments', async () => {
  const f = setup();
  for (const args of [
    { path: '.ia/src/outside.ia' },
    { path: '../../private.ia' },
    { path: readPath, module: 'private-loader' },
    { path: readPath, principal: f.principal },
    { path: readPath, limit: 401 },
    { path: readPath, start: -1 },
    { path: readPath, limit: 0 },
  ])
    await expect(f.adapter.execute(args, f.context)).rejects.toThrow();
});
it('refuses missing authority and wrong, expired or revoked grants before source disclosure', async () => {
  const f = setup(),
    missing = { ...f.context };
  delete missing.assertCurrent;
  const refusalCode = declaredReadCase('read-captured-source-authority-refusal', f.capture);
  const mutated = copy(f.manifest);
  mutated.workspace = 'forged';
  mutated.digest = manifestDigest(mutated);
  for (const context of [
    missing,
    { ...f.context, principal: 'other' },
    { ...f.context, manifest: mutated },
    ...[
      { principal: 'other' },
      { workspace: 'other' },
      { expiresAt: 1 },
      { operations: [] },
      { effects: [] },
      { sources: [] },
      { profiles: [] },
      { limits: { ...f.grant.limits, deadline: 1 } },
    ].map((changes) => ({ ...f.context, grant: { ...f.grant, ...changes } })),
  ])
    await expect(f.adapter.execute({ path: readPath }, context)).rejects.toMatchObject({ code: refusalCode });
  expect(f.context.assertCurrent).not.toHaveBeenCalled();
});
it('rechecks revocation across current-authority callbacks and after reading', async () => {
  for (const at of [1, 2]) {
    const f = setup();
    let calls = 0;
    f.context.assertCurrent = async () => {
      if (++calls === at) f.context.grant = { ...f.grant, operations: [] };
    };
    await expect(f.adapter.execute({ path: readPath }, f.context)).rejects.toThrow('authority');
  }
});
it('refuses changed capture bytes before reading and before returning the result', async () => {
  for (const at of [1, 2]) {
    const f = readFixture(SDK, root),
      changed = copy(f.capture),
      { revision: _revision, ...body } = changed;
    const next = {
      ...body,
      sources: body.sources.map((source) =>
        source.path === readPath ? { ...source, text: source.text + '# drift\n' } : source,
      ),
    };
    const stale = { ...next, revision: digest(next) };
    let calls = 0;
    const bound = SDK.installedReadAdapters(f.capture, {
      ...f.options,
      currentCapture: () => (++calls === at ? stale : f.capture),
    });
    close.push(bound.close);
    const context: OperationContext = {
      sessionId: 's',
      runId: 'root',
      attemptId: 'a',
      invocationId: 'i',
      principal: f.principal,
      grant: f.grant,
      manifest: f.manifest,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    };
    await expect(bound.operations[SDK.INSTALLED_READ.handler]!.execute({ path: readPath }, context)).rejects.toThrow(
      'source selection changed',
    );
  }
});
it('refuses forged full manifests, compiled pins and changed installed catalogue contracts at binding', () => {
  const f = readFixture(SDK, root),
    manifest = copy(f.manifest);
  manifest.profiles[f.profile]!.instructions.push('Forged executable instruction');
  manifest.digest = manifestDigest(manifest);
  expect(() => SDK.installedReadAdapters(f.capture, { ...f.options, manifest })).toThrow('compiled closure');
  const compiled = copy(f.compiled);
  compiled.digest = '0'.repeat(64);
  expect(() => SDK.installedReadAdapters(f.capture, { ...f.options, compiled })).toThrow('digest mismatch');
  for (const field of ['handler', 'implementationDigest', 'recovery', 'timeoutMs', 'maxOutputBytes']) {
    const catalog = copy(f.catalog),
      entry = catalog.operations[SDK.INSTALLED_READ.implementation]!;
    const previous = (entry.value as unknown as Record<string, unknown>)[field];
    catalog.operations[SDK.INSTALLED_READ.implementation] = SDK.installed({
      ...entry.value,
      [field]: typeof previous === 'number' ? 1 : 'changed',
    });
    expect(() => SDK.installedReadAdapters(f.capture, { ...f.options, catalog })).toThrow('Installed contract changed');
  }
});
it('refuses an internally coherent recompiled catalogue with a forged implementation byte pin', () => {
  const f = readFixture(SDK, root),
    catalog = copy(f.catalog);
  catalog.operations[SDK.INSTALLED_READ.implementation] = SDK.installed({
    ...catalog.operations[SDK.INSTALLED_READ.implementation]!.value,
    implementationDigest: '0'.repeat(64),
  });
  const compilation = SDK.compileHarness(f.capture, {
    harness: 'installed-read-example-harness',
    entry: 'installed-read-example-entry',
    catalog,
  });
  expect(compilation.ok).toBe(true);
  if (!compilation.ok) throw new Error('Fixture should compile the supplied descriptor');
  expect(() =>
    SDK.installedReadAdapters(f.capture, {
      ...f.options,
      catalog,
      compiled: compilation.manifest,
      manifest: SDK.executionManifest(compilation.manifest, catalog),
    }),
  ).toThrow('implementation bytes changed');
});
it('refuses a rehashed compiled executable that does not follow from captured native source', () => {
  const f = readFixture(SDK, root),
    compiled = copy(f.compiled);
  compiled.operations[SDK.INSTALLED_READ.operation]!.recovery = 'manual';
  const { digest: _digest, ...body } = compiled;
  compiled.digest = digest(body);
  const manifest = SDK.executionManifest(compiled, f.catalog);
  expect(() => SDK.installedReadAdapters(f.capture, { ...f.options, compiled, manifest })).toThrow(
    'retained native capture',
  );
});
it('checks fresh implementation byte identity before and after every read', async () => {
  for (const at of [1, 2]) {
    const f = setup(),
      original = code.installedImplementationDigest();
    let calls = 0;
    vi.spyOn(code, 'installedImplementationDigest').mockImplementation(() =>
      ++calls === at ? '0'.repeat(64) : original,
    );
    await expect(f.adapter.execute({ path: readPath }, f.context)).rejects.toThrow('implementation bytes changed');
    vi.restoreAllMocks();
  }
});
it('snapshots selected input and bound catalogue rather than following later caller mutations', async () => {
  const f = setup(),
    args = { path: readPath, limit: 1 };
  f.context.assertCurrent = async () => {
    args.path = '.ia/src/outside.ia';
    f.options.catalog.operations[SDK.INSTALLED_READ.implementation]!.value.handler = 'other';
  };
  expect((await f.adapter.execute(args, f.context)).effect).toBe('none');
});
it('refuses cancellation, closed consumers and overlarge retained output', async () => {
  const f = setup();
  await expect(f.adapter.execute({ path: readPath }, { ...f.context, signal: AbortSignal.abort() })).rejects.toThrow();
  f.bound.close();
  await expect(f.adapter.execute({ path: readPath }, f.context)).rejects.toThrow('authority');
  const base = readFixture(SDK, root),
    { revision: _revision, ...body } = copy(base.capture);
  const next = {
    ...body,
    sources: body.sources.map((source) =>
      source.path === readPath ? { ...source, text: source.text + '# ' + 'x'.repeat(60000) + '\n' } : source,
    ),
  };
  const oversized = { ...next, revision: digest(next) },
    catalog = base.catalog,
    compilation = SDK.compileHarness(oversized, {
      harness: 'installed-read-example-harness',
      entry: 'installed-read-example-entry',
      catalog,
    });
  if (!compilation.ok) throw new Error(JSON.stringify(compilation));
  const manifest = SDK.executionManifest(compilation.manifest, catalog),
    bound = SDK.installedReadAdapters(oversized, {
      ...base.options,
      compiled: compilation.manifest,
      manifest,
      currentCapture: () => oversized,
    });
  close.push(bound.close);
  const context = {
    ...f.context,
    grant: { ...base.grant, workspace: manifest.workspace, sources: [oversized.revision] },
    manifest,
    assertCurrent: async () => {},
  };
  await expect(bound.operations[SDK.INSTALLED_READ.handler]!.execute({ path: readPath }, context)).rejects.toThrow(
    'Result exceeds limit',
  );
});
it('runs real Engine read receipts and repeatable recovery with revoked retry and retained accounting', async () => {
  const store = memoryStore();
  try {
    const result = await qualifyInstalledRead(SDK, root, store);
    expect(result).toMatchObject({
      calls: 2,
      reads: 2,
      attempts: 2,
      paidProviderCalls: 0,
      revokedRetryRefused: true,
      restart: true,
    });
  } finally {
    await store.close();
  }
});
it('refuses changed installed code on retry before a second operation attempt is dispatched', async () => {
  const store = memoryStore();
  try {
    const result = await qualifyInstalledRead(SDK, root, store, () => {
      const spy = vi.spyOn(code, 'installedImplementationDigest').mockReturnValue('0'.repeat(64));
      return () => spy.mockRestore();
    });
    expect(result).toMatchObject({
      changedCodeRetryRefused: true,
      staleSourceRetryRefused: true,
      reads: 2,
      attempts: 2,
      paidProviderCalls: 0,
    });
  } finally {
    await store.close();
  }
});
