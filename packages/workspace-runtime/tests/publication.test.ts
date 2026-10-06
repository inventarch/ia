import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '@inventarch/session-system';
import { captureWorkspace, managedPublication } from '../src/index.js';
import { destination, fixture } from './publication-fixture.js';
import type { Boundary, Configuration } from './publication-fixture.js';

// Every case uses the real native publication/SQLite fixture. Cover the recovery
// and final-authority cases that otherwise inherit Vitest's five-second default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = fileURLToPath(new URL('../../..', import.meta.url)),
  capture = captureWorkspace(repository);
it('binds compiled native provenance only when the complete publication contract is compatible', () => {
  const code = 'a'.repeat(64),
    original = managedPublication(repository, destination, code).definition,
    binding = {
      ...original,
      id: 'authoring-system/binding/operation/publish-draft',
      digest: 'b'.repeat(64),
      maxOutputBytes: 65536,
    };
  expect(managedPublication(repository, destination, code, binding).definition).toMatchObject({
    id: binding.id,
    digest: binding.digest,
  });
  for (const changed of [
    { ...binding, handler: 'other' },
    { ...binding, input: { type: 'string' } },
    { ...binding, recovery: 'repeatable' as const },
    { ...binding, effects: ['external-write' as const] },
    { ...binding, timeoutMs: 1 },
    { ...binding, maxOutputBytes: 100000 },
    { ...binding, digest: 'invented' },
  ])
    expect(() => managedPublication(repository, destination, code, changed)).toThrow('incompatible');
});
const roots: string[] = [],
  stores: SessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !/^ia-p3-[\w-]+$/.test(path)) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
async function setup(timeoutMs = 15000) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-p3-'));
  roots.push(root);
  const path = '.ia/src/systems/agent-system/records/p3-reviewer.ia',
    text =
      '#! ia 1.0\n@agent p3-reviewer\n  meaning\n    says "Review proposed records."\n    answers "Who reviews?"\n  governance\n    applies []\n',
    composition = [{ sourceSet: capture.id, revision: capture.revision }];
  const config: Configuration = {
    capture,
    timeoutMs,
    scope: { sourceSet: capture.id, revision: capture.revision, composition, systems: ['agent-system'], paths: [path] },
    candidate: {
      version: 1,
      sourceSet: capture.id,
      base: { revision: capture.revision, composition },
      target: { system: 'agent-system', discriminator: 'agent' },
      files: [{ path, text, digest: createHash('sha256').update(text).digest('hex') }],
      evidence: [],
    },
    grant: {
      id: 'grant',
      principal: 'alice',
      workspace: 'test',
      expiresAt: Date.now() + 600000,
      profiles: ['author'],
      operations: ['candidate.validate', 'draft.publish'],
      effects: ['read', 'local-write'],
      sources: [capture.revision],
      models: ['test'],
      destinations: [destination],
      limits: {
        steps: 30,
        modelCalls: 20,
        operations: 10,
        tokens: 1000000,
        bytes: 10000000,
        children: 0,
        depth: 0,
        deadline: Date.now() + 600000,
      },
    },
  };
  writeFileSync(resolve(root, 'config.json'), JSON.stringify(config));
  const f = fixture(root, config);
  stores.push(f.store);
  const engine = f.engine();
  await engine.start({
    sessionId: 's',
    commandId: 'start',
    principal: 'alice',
    profile: 'author',
    task: 'Draft a reviewer',
    artifact: { operation: 'draft.publish', destination },
  });
  const state = await engine.advance('s', 'alice'),
    p = Object.values(state.proposals)[0]!;
  expect(state.receipts.find((r) => r.target === 'candidate.validate')!.output).toMatchObject({ allowed: true });
  await engine.review('s', 'alice', p.id, p.revision, p.digest, true, 'Exact draft reviewed', 'approve');
  await f.store.close();
  return {
    root,
    config,
    reopen: () => {
      const next = fixture(root, config);
      stores.push(next.store);
      return next;
    },
  };
}
async function killAt(root: string, boundary: Boundary) {
  const child = spawn(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      'tsx',
      fileURLToPath(new URL('./publication-fixture.ts', import.meta.url)),
      root,
      boundary,
    ],
    { cwd: repository, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  );
  let stderr = '';
  child.stderr!.on('data', (data) => {
    stderr += String(data);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child, 'message').then(([at]) => expect(at).toBe(boundary)),
      once(child, 'exit').then(() => {
        throw new Error(`Child exited before ${boundary}: ${stderr}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Crash boundary timed out: ${boundary}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}
describe.skipIf(process.platform !== 'win32')('managed publication engine recovery on local NTFS', () => {
  it.each(['before-prepare', 'prepared', 'dispatched', 'staged', 'published', 'observed'] as const)(
    'recovers actual process death at %s without another unapproved write',
    async (boundary) => {
      // The cold Windows recovery took 27s in CI 35558571194 and exhausted the
      // fixture's 15s publication allowance before any effect. These cases test
      // crash boundaries, not latency; keep production and explicit timeout cases unchanged.
      const f = await setup(60_000);
      await killAt(f.root, boundary);
      const live = f.reopen(),
        engine = live.engine();
      const before = await live.store.read('s'),
        original = Object.values(before.attempts).find((a) => a.target === 'draft.publish');
      const published = ['published', 'observed'].includes(boundary);
      expect(existsSync(resolve(f.root, destination, 'result.json'))).toBe(published);
      let state = await engine.advance('s', 'alice');
      if (boundary === 'prepared' || boundary === 'dispatched' || boundary === 'staged') {
        expect(state.runs['root']!.wait?.continuation).toBe('retry');
        expect(state.attempts[original!.id]!.error).toBe(
          boundary === 'prepared' ? 'not-dispatched' : 'reconciled-absent',
        );
        expect(existsSync(resolve(f.root, destination))).toBe(false);
        await engine.retry('s', 'alice', original!.id, 'retry');
        await engine.retry('s', 'alice', original!.id, 'retry');
        state = await engine.advance('s', 'alice');
      }
      expect(
        state.runs['root']!.status,
        JSON.stringify({
          boundary,
          wait: state.runs['root']!.wait,
          attempts: Object.values(state.attempts).map(({ target, status, effect, error }) => ({
            target,
            status,
            effect,
            error,
          })),
        }),
      ).toBe('completed');
      const writes = Object.values(state.attempts).filter((a) => a.target === 'draft.publish');
      expect(writes).toHaveLength(['prepared', 'dispatched', 'staged'].includes(boundary) ? 2 : 1);
      expect(new Set(writes.map((a) => a.invocationId)).size).toBe(1);
      expect(writes.every((a) => a.review?.decisionId === writes[0]!.review?.decisionId)).toBe(true);
      expect(state.budget.operations).toBe(
        1 + writes.length + (['dispatched', 'staged', 'published'].includes(boundary) ? 1 : 0),
      );
      expect(state.budget.reservedTokens).toBe(0);
      expect(state.budget.usedTokens).toBe(40);
      const receipt = [...state.receipts].reverse().find((r) => r.target === 'draft.publish')!;
      expect(receipt.effect).toBe('applied');
      expect(receipt.error).toBeNull();
      expect(receipt.reconciles).toBe(boundary === 'published' ? original!.id : null);
      expect(readdirSync(resolve(f.root, '.ia/work/generated')).filter((name) => !name.startsWith('.stage-'))).toEqual([
        'reviewed-draft',
      ]);
      const marker = JSON.parse(readFileSync(resolve(f.root, destination, 'result.json'), 'utf8'));
      expect(marker).toMatchObject({
        sessionId: 's',
        attemptId: receipt.attemptId,
        invocationId: receipt.invocationId,
        bindingDigest: receipt.bindingDigest,
        review: receipt.review,
      });
      const file = f.config.candidate.files[0]!;
      expect(readFileSync(resolve(f.root, destination, file.path), 'utf8')).toBe(file.text);
      expect(existsSync(resolve(f.root, '.ia/src'))).toBe(false);
      const budget = state.budget;
      expect((await engine.advance('s', 'alice')).budget).toEqual(budget);
    },
    90_000,
  );
  it.each(['partial', 'unknown'] as const)(
    'keeps %s effects waiting and bounds charged inspections',
    async (status) => {
      const f = await setup();
      await killAt(f.root, 'dispatched');
      mkdirSync(resolve(f.root, destination), { recursive: true });
      if (status === 'unknown') writeFileSync(resolve(f.root, destination, 'result.json'), '{"unrelated":true}');
      const live = f.reopen(),
        engine = live.engine();
      let state = await engine.advance('s', 'alice');
      const attempt = Object.values(state.attempts).find((a) => a.target === 'draft.publish')!;
      expect(attempt.effect).toBe(status);
      expect(attempt.reconciliations).toBe(1);
      expect(state.budget.operations).toBe(3);
      await expect(engine.retry('s', 'alice', attempt.id, 'unsafe-retry')).rejects.toThrow();
      state = await engine.advance('s', 'alice');
      expect(state.budget.operations).toBe(4);
      state = await engine.advance('s', 'alice');
      expect(state.runs['root']!.wait?.reason).toBe('reconciliation-exhausted');
      expect(state.budget.operations).toBe(4);
      expect(Object.values(state.attempts).filter((a) => a.target === 'draft.publish')).toHaveLength(1);
    },
    25000,
  );
  it('retains a charged interrupted lookup across another process death', async () => {
    const f = await setup();
    await killAt(f.root, 'published');
    await killAt(f.root, 'reconciling');
    const live = f.reopen();
    const before = await live.store.read('s'),
      attempt = Object.values(before.attempts).find((a) => a.target === 'draft.publish')!;
    expect(attempt.reconciliations).toBe(1);
    expect(before.budget.operations).toBe(3);
    const state = await live.engine().advance('s', 'alice');
    expect(state.runs['root']!.status).toBe('completed');
    expect(state.budget.operations).toBe(4);
    expect(state.attempts[attempt.id]!.reconciliations).toBe(2);
    expect(state.receipts.filter((r) => r.target === 'draft.publish')).toHaveLength(1);
  }, 25000);
  it.each(['timeout', 'invalid-output'] as const)(
    'retains bounded evidence after reconciliation %s',
    async (mode) => {
      const f = await setup(5000);
      await killAt(f.root, 'published');
      const live = f.reopen(),
        adapter = live.publication.adapter;
      live.host.operations = {
        ...live.host.operations,
        [adapter.id]: {
          ...adapter,
          reconcile:
            mode === 'timeout'
              ? async () => new Promise(() => {})
              : async () => ({ status: 'applied', output: { unrelated: true } }),
        },
      };
      const state = await live.engine().advance('s', 'alice'),
        attempt = Object.values(state.attempts).find((a) => a.target === 'draft.publish')!;
      expect(state.runs['root']!.status).toBe('waiting');
      expect(state.budget.operations).toBe(3);
      expect(attempt.effect).toBe(mode === 'timeout' ? 'unknown' : 'applied');
      expect(attempt.error).not.toBeNull();
      await expect(live.engine().retry('s', 'alice', attempt.id, 'retry')).rejects.toThrow();
    },
    25000,
  );
  it.each(['grant', 'source', 'preflight', 'expiry', 'quota'] as const)(
    'refuses recovery after current %s changes',
    async (change) => {
      const f = await setup();
      await killAt(f.root, 'published');
      const live = f.reopen();
      if (change === 'grant') f.config.grant.operations = ['candidate.validate'];
      if (change === 'source') live.host.verifyManifest = async () => false;
      if (change === 'preflight') live.host.preflight = async () => false;
      if (change === 'expiry') f.config.grant.expiresAt = 0;
      if (change === 'quota') f.config.grant.limits.operations = 2;
      const before = await live.store.read('s'),
        state = await live.engine().advance('s', 'alice');
      expect(state.runs['root']!.wait?.reason).toBe('reconciliation-unavailable');
      expect(state.budget).toEqual({ ...before.budget, retainedBytes: state.budget.retainedBytes });
      expect(state.budget.retainedBytes).toBeGreaterThan(before.budget.retainedBytes);
      expect(state.receipts.filter((r) => r.target === 'draft.publish')).toHaveLength(0);
      expect(existsSync(resolve(f.root, destination, 'result.json'))).toBe(true);
    },
    25000,
  );
  it.each(['pause', 'cancel'] as const)(
    'settles uncertain publication before applying %s',
    async (kind) => {
      const f = await setup();
      await killAt(f.root, 'published');
      const live = f.reopen(),
        before = await live.store.read('s');
      await live.store.command({
        id: kind,
        sessionId: 's',
        actor: 'alice',
        expected: before.sequence,
        mutation: {
          type: 'control.submit',
          control: { id: kind, actor: 'alice', runId: 'root', kind, applied: false },
        },
      });
      const state = await live.engine().advance('s', 'alice');
      expect(state.runs['root']!.status).toBe(kind === 'pause' ? 'paused' : 'cancelled');
      expect([...state.receipts].reverse().find((r) => r.target === 'draft.publish')).toMatchObject({
        effect: 'applied',
        error: null,
      });
      expect(state.budget.operations).toBe(3);
    },
    25000,
  );
  it('clears a failed acknowledgement only with a new exact reconciliation receipt', async () => {
    const f = await setup(),
      live = f.reopen(),
      adapter = live.publication.adapter;
    live.host.operations = {
      ...live.host.operations,
      [adapter.id]: {
        ...adapter,
        execute: async (input, context) => {
          await adapter.execute(input, context);
          throw new Error('Lost result');
        },
      },
    };
    const state = await live.engine().advance('s', 'alice'),
      receipts = state.receipts.filter((r) => r.target === 'draft.publish');
    expect(state.runs['root']!.status).toBe('completed');
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ effect: 'unknown', error: 'operation-attempt-failed', reconciles: null });
    expect(receipts[1]).toMatchObject({ effect: 'applied', error: null, reconciles: receipts[0]!.attemptId });
    expect(state.budget.operations).toBe(3);
  });
  it.each(['owner', 'grant', 'control', 'binding'] as const)(
    'refuses a staged publication after %s changes at the last authority boundary',
    async (change) => {
      const f = await setup(),
        live = f.reopen(),
        adapter = live.publication.adapter;
      let triggered = false;
      live.host.operations = {
        ...live.host.operations,
        [adapter.id]: {
          ...adapter,
          execute: async (input, context) => {
            const check = context.assertCurrent!;
            let calls = 0;
            context.assertCurrent = async () => {
              if (++calls === 2) {
                triggered = true;
                expect(
                  readdirSync(resolve(f.root, '.ia/work/generated')).some((name) => name.startsWith('.stage-')),
                ).toBe(true);
                if (change === 'owner') await live.store.release(context.owner!);
                if (change === 'grant') f.config.grant.destinations = [];
                if (change === 'binding') live.host.verifyManifest = async () => false;
                if (change === 'control') {
                  const state = await live.store.read('s');
                  await live.store.command({
                    id: 'stop',
                    sessionId: 's',
                    actor: 'alice',
                    expected: state.sequence,
                    mutation: {
                      type: 'control.submit',
                      control: { id: 'stop', actor: 'alice', runId: 'root', kind: 'cancel', applied: false },
                    },
                  });
                }
              }
              await check();
            };
            return adapter.execute(input, context);
          },
        },
      };
      if (change === 'owner') await expect(live.engine().advance('s', 'alice')).rejects.toThrow();
      else await live.engine().advance('s', 'alice');
      expect(triggered).toBe(true);
      expect(existsSync(resolve(f.root, destination))).toBe(false);
      expect(readdirSync(resolve(f.root, '.ia/work/generated'))).toEqual([]);
    },
  );
});
