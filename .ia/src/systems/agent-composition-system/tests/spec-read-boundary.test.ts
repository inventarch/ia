import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Script } from 'node:vm';
import { Engine } from '@inventarch/agent-system';
import { copy, digest, memoryStore } from '@inventarch/session-system';
import * as SDK from '../src/index.js';
import { readFixture, readPath } from './installed-read-fixture.mjs';
import { qualifySpecReadBoundary } from './spec-read-boundary-fixture.mjs';

it('joins a real Engine native spec read with separately captured and disclosed body bytes', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ia-spec-read-boundary-'));
  const target = resolve(temporary),
    parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('ia-spec-read-boundary-'))
    throw new Error('Unsafe fixture cleanup');
  try {
    const result = await qualifySpecReadBoundary(
      SDK,
      resolve(import.meta.dirname, '../../../../..'),
      join(temporary, 'workspace'),
    );
    expect(result).toMatchObject({
      passed: true,
      nativeAnchorRead: true,
      nativeBodyPathRefused: true,
      undisclosedRequiredBodyRefused: true,
      disclosedBodyExact: true,
      modelCalls: 3,
      dispatches: 2,
      paidProviderCalls: 0,
      modelSawBodyProse: false,
      semanticCoherence: 'not-evaluated',
      nativeBodyPathError: 'operation-attempt-failed',
      nativeBodyPathAdapterError: { code: 'IA-CORPUS-INVALID' },
    });
    expect(result.body.key.path).toBe('documents/specification.md');
    for (const pin of [result.capture, result.compiled, result.installedCode, result.resources, result.body.sha256])
      expect(pin).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      qualifySpecReadBoundary(SDK, resolve(import.meta.dirname, '../../../../..'), join(temporary, 'workspace')),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}, 120000);

it('executes the documented installed-read binding and retains it until Engine completion', async () => {
  const root = resolve(import.meta.dirname, '../../../../..');
  const text = readFileSync(new URL('../references/installed-read.md', import.meta.url), 'utf8');
  const block = /```ts\r?\n([\s\S]+?)\r?\n```/.exec(text)?.[1];
  expect(block, 'The maintained binding example must be present.').toBeTruthy();
  const f = readFixture(SDK, root);
  // Execute only this trusted repository example in a context with its explicit
  // host-owned inputs; this is test code, not a framework module-loading port.
  const bound = new Script(block + '\n({ read, operations })', {
    filename: 'references/installed-read.md',
  }).runInNewContext(
    {
      installedReadAdapters: SDK.installedReadAdapters,
      capture: f.capture,
      manifest: f.manifest,
      compiled: f.compiled,
      catalog: f.catalog,
      principal: f.principal,
      hostOwnedCurrentCapture: () => copy(f.capture),
      otherFirstPartyAdapters: {},
    },
    { timeout: 5000 },
  ) as {
    read: ReturnType<typeof SDK.installedReadAdapters>;
    operations: ReturnType<typeof SDK.installedReadAdapters>['operations'];
  };
  const store = memoryStore();
  let calls = 0;
  try {
    const engine = new Engine(f.manifest, {
      store,
      operations: bound.operations,
      model: {
        id: 'documented-binding-fixture',
        generate: async () => {
          calls++;
          return {
            provider: 'deterministic-fake',
            model: 'example/scripted-read',
            usage: 1,
            action:
              calls === 1
                ? { type: 'invoke', operation: SDK.INSTALLED_READ.operation, input: { path: readPath } }
                : {
                    type: 'outcome',
                    kind: 'answer',
                    message: 'The documented binding completed.',
                    continuation: 'finish',
                  },
          };
        },
      },
      authorize: async () => copy(f.grant),
      verifyManifest: async (value) =>
        digest(value) === digest(f.manifest) &&
        SDK.installedImplementationDigest() ===
          f.catalog.operations[SDK.INSTALLED_READ.implementation]!.value.implementationDigest,
      context: async () => ({}),
      evaluate: async () => ({ status: 'pass', evidence: [], message: 'Only the existing captured read is selected.' }),
      preflight: async (definition) => definition.id === SDK.INSTALLED_READ.operation,
    });
    await engine.start({
      sessionId: 'documented-binding',
      commandId: 'start',
      principal: f.principal,
      profile: f.profile,
      task: 'Read the retained neutral label.',
    });
    const state = await engine.advance('documented-binding', f.principal);
    expect(state.runs['root']!.status, 'The documentation must retain its reader through Engine commands.').toBe(
      'completed',
    );
    const receipt = state.receipts.find((row) => row.target === SDK.INSTALLED_READ.operation && row.error === null);
    expect(receipt).toMatchObject({
      effect: 'none',
      error: null,
      output: {
        revision: f.capture.revision,
        text: expect.stringContaining('installed-read-label'),
      },
    });
    expect(calls).toBe(2);
  } finally {
    bound.read.close();
    await store.close();
  }
}, 30000);
