import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { adoptWorkspace } from '@inventarch/workspace-runtime';
import { INSTALLED_READ } from '@inventarch/agent-composition-system';
import { open } from '@inventarch/db';
import type { ModelAction, ModelRequest } from '@inventarch/agent-system';
import { replay } from '@inventarch/session-system';
import { openRunner, runnerCatalog } from '../src/index.js';

const repository = resolve(import.meta.dirname, '../../..');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-runner-'));
  cpSync(resolve(repository, 'examples/conformance/composition/.ia'), resolve(root, '.ia'), { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    profile: 'runner-reader-profile',
    inputs: { adopted: [adoptWorkspace(repository, 'public-language')] },
  };
}
function scripted(actions: ModelAction[], seen: ModelRequest[]) {
  return {
    id: 'scripted',
    async generate(request: ModelRequest) {
      seen.push(request);
      const action = actions.shift();
      if (!action) throw new Error('Script exhausted');
      return { action, usage: 1, model: request.profile.model, provider: 'local-test' };
    },
  };
}
const done: ModelAction = { type: 'outcome', kind: 'answer', message: 'Captured source read.', continuation: 'finish' };
function read(root: ReturnType<typeof openRunner>): ModelAction {
  return {
    type: 'invoke',
    operation: INSTALLED_READ.operation,
    input: { path: root.capture.sources.find((row) => row.path.endsWith('/records/runner.ia'))!.path, limit: 3 },
  };
}

it('opens, steps, executes the installed read, journals position per model step and replays after restart', async () => {
  const options = fixture(),
    seen: ModelRequest[] = [],
    actions: ModelAction[] = [];
  const runner = openRunner({ ...options, model: scripted(actions, seen) });
  cleanups.push(() => runner.close());
  actions.push(read(runner), done);
  const started = await runner.start('Read the conformance source', 'conformance-read');
  expect(started.runs['root']?.agent).toContain('/agent/runner-reader');
  const opened = open(options.root, { ...options.inputs, evidence: true, cache: false });
  const authoredRevision = opened.authoredRevision;
  expect(
    opened
      .records()
      .filter((row) => row.band === 0)
      .map((row) => row.discriminator),
  ).toEqual(['run']);
  opened.close();
  const finished = await runner.run();
  expect(finished.runs['root']?.status).toBe('completed');
  expect(finished.budget.operations).toBe(1);
  expect(finished.receipts.some((receipt) => receipt.effect === 'none')).toBe(true);
  expect(seen).toHaveLength(2);
  expect(seen.map((request) => (request.context as { key: { phase: string } }).key.phase)).toEqual(['orient', 'learn']);
  for (const request of seen) {
    expect(request.profile.instructions).toEqual([]);
    expect(request.context).toMatchObject({ key: { seat: runner.manifest.workspace }, packet: expect.any(Object) });
  }
  const journal = await runner.store.journal(finished.id);
  expect(replay(journal.events)).toEqual(finished);
  expect(JSON.stringify(journal)).toContain('"key"');
  const evidence = open(options.root, { ...options.inputs, evidence: true, cache: false });
  expect(evidence.report.findings.filter((item) => item.severity === 'error')).toEqual([]);
  expect(evidence.authoredRevision).toBe(authoredRevision);
  const runtime = evidence.records().filter((row) => row.band === 0);
  expect(runtime.filter((row) => row.discriminator === 'run')).toHaveLength(1);
  expect(runtime.filter((row) => row.discriminator === 'observation')).toHaveLength(2);
  evidence.close();
  await runner.close();
  const resumed = openRunner(options);
  cleanups.push(() => resumed.close());
  expect(await resumed.resume(finished.id)).toEqual(finished);
});

it('refuses an operation beyond the mandate count before a second dispatch', async () => {
  const options = fixture(),
    actions: ModelAction[] = [],
    seen: ModelRequest[] = [];
  const runner = openRunner({ ...options, model: scripted(actions, seen) });
  cleanups.push(() => runner.close());
  actions.push(read(runner), read(runner), done);
  await runner.start('Try two reads', 'limited-read');
  const state = await runner.run();
  expect(state.budget.operations).toBe(1);
  expect(state.runs['root']?.status).toBe('waiting');
  expect(JSON.stringify(state.runs['root']?.wait)).toMatch(/limit/i);
  const evidence = open(options.root, { ...options.inputs, evidence: true, cache: false });
  expect(
    evidence
      .records()
      .some((row) => row.discriminator === 'observation' && JSON.stringify(row.sections).includes('refusal')),
  ).toBe(true);
  evidence.close();
});

it('journals a stable mandate refusal and next command without dispatching', async () => {
  const options = fixture();
  const file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace('moves [Observation]', 'moves [Verification]'));
  const actions: ModelAction[] = [],
    seen: ModelRequest[] = [];
  const runner = openRunner({ ...options, model: scripted(actions, seen) });
  cleanups.push(() => runner.close());
  actions.push(read(runner));
  await runner.start('Attempt a disallowed move', 'refused-read');
  const state = await runner.run();
  expect(state.runs['root']?.status).toBe('completed');
  expect(state.budget.operations).toBe(0);
  expect(JSON.stringify(state.runs['root']?.outcome)).toContain('IA-RUNTIME-MANDATE-MOVE');
  expect(JSON.stringify(state.runs['root']?.outcome)).toContain('next: ia position');
});

it('defers one persisted model request and resumes it without creating a second request', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  await runner.start('Return an answer', 'deferred-read');
  const waiting = await runner.run();
  expect(waiting.runs['root']?.wait?.reason).toBe('external-model');
  const attempt = Object.values(waiting.attempts).find((row) => row.kind === 'model')!;
  await runner.close();
  const resumed = openRunner(options);
  cleanups.push(() => resumed.close());
  await resumed.resume(waiting.id);
  await resumed.submit(attempt.id, { action: done, usage: 1, model: 'runner/external', provider: 'local-test' });
  const finished = await resumed.run();
  expect(finished.runs['root']?.status).toBe('completed');
  expect(finished.budget.modelCalls).toBe(1);
});

it('refuses stale capture resume and leaves authored source bytes unchanged during execution', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  const file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia'),
    before = readFileSync(file, 'utf8');
  await runner.start('Wait for host input', 'stale-read');
  await runner.run();
  expect(readFileSync(file, 'utf8')).toBe(before);
  await runner.close();
  writeFileSync(file, before.replace('one-operation limit', 'one-operation ceiling'));
  const stale = openRunner(options);
  cleanups.push(() => stale.close());
  await expect(stale.resume('stale-read')).rejects.toMatchObject({ code: 'IA-RUNNER-RESUME-DENIED' });
});

it('rechecks mandate refusal for externally submitted actions', async () => {
  const options = fixture(),
    file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace('moves [Observation]', 'moves [Verification]'));
  const runner = openRunner(options);
  cleanups.push(() => runner.close());
  await runner.start('Try an external invocation', 'external-refusal');
  const waiting = await runner.run(),
    attempt = Object.values(waiting.attempts).find((row) => row.kind === 'model')!;
  await runner.submit(attempt.id, { action: read(runner), usage: 1, model: 'runner/external', provider: 'local-test' });
  const state = await runner.run();
  expect(state.budget.operations).toBe(0);
  expect(JSON.stringify(state.runs['root']?.outcome)).toContain('IA-RUNTIME-MANDATE-MOVE');
});

it('fails closed when a captured mandate changes before dispatch', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  await runner.start('Wait for source mutation', 'changed-before-dispatch');
  const file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace('limit-operations 1', 'limit-operations 9'));
  await runner.step(); // Created -> ready is bookkeeping, not dispatch.
  await expect(runner.step()).rejects.toMatchObject({ code: 'IA-ENGINE-SOURCE-CHANGED' });
  expect((await runner.store.read('changed-before-dispatch')).budget.operations).toBe(0);
});

it('does not disclose record sections through navigation and refuses stale body reads', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  await expect(runner.request('records', {})).rejects.toMatchObject({ code: 'IA-RUNNER-NOT-OPEN' });
  await runner.start('Navigate captured records', 'navigation');
  const rows = await runner.request('records', {});
  expect(JSON.stringify(rows)).not.toContain('"sections"');
  const body = await runner.request('read', { locator: runner.compiled.entry.profile });
  expect(JSON.stringify(body)).toContain('runner-reader-profile');
  const file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace('one-operation limit', 'changed instruction'));
  await expect(runner.request('read', { locator: runner.compiled.entry.profile })).rejects.toMatchObject({
    code: 'IA-RUNNER-SOURCE-CHANGED',
  });
});

it('rejects a forged installed implementation description without loading code', () => {
  const options = fixture(),
    catalog = runnerCatalog();
  catalog.operations[INSTALLED_READ.implementation]!.value.implementationDigest = '0'.repeat(64);
  expect(() => openRunner({ ...options, catalog })).toThrow();
});

it('preserves excluded-word refusal even when the move itself is allowed', async () => {
  const options = fixture(),
    file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('moves [Observation]', 'moves [Observation]\n    excluded-words [operation]'),
  );
  const actions: ModelAction[] = [],
    runner = openRunner({ ...options, model: scripted(actions, []) });
  cleanups.push(() => runner.close());
  actions.push(read(runner));
  await runner.start('Attempt excluded operation', 'excluded-word');
  const state = await runner.run();
  expect(state.budget.operations).toBe(0);
  expect(JSON.stringify(state.runs['root']?.outcome)).toContain('IA-RUNTIME-MANDATE-WORD');
});

it('requires current host permission for navigation as well as operation dispatch', async () => {
  const options = fixture();
  let allowed = true;
  const runner = openRunner({
    ...options,
    authorize: async (principal, manifest, state) => ({
      id: 'local-policy',
      principal,
      workspace: manifest.workspace,
      profiles: Object.keys(manifest.profiles),
      operations: Object.keys(manifest.operations),
      effects: allowed ? ['read'] : [],
      sources: [manifest.sourceDigest],
      models: ['runner/external'],
      expiresAt: state?.limits.deadline ?? Date.now() + 600000,
      limits: {
        steps: 64,
        modelCalls: 16,
        operations: 99,
        tokens: 200000,
        children: 0,
        depth: 0,
        bytes: 8000000,
        deadline: state?.limits.deadline ?? Date.now() + 600000,
      },
    }),
  });
  cleanups.push(() => runner.close());
  const state = await runner.start('Open under a narrowing host policy', 'host-policy');
  expect(state.limits.operations).toBe(1);
  allowed = false;
  await expect(runner.request('records', {})).rejects.toMatchObject({ code: 'IA-RUNNER-AUTHORITY' });
});

it('preserves the durable run when evidence publication fails and retries projection on resume', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  const obstacle = resolve(options.root, '.ia/work/runner-evidence');
  writeFileSync(obstacle, 'A regular file prevents the evidence directory.');
  await expect(runner.start('Retain durable state across evidence failure', 'evidence-recovery')).rejects.toThrow();
  expect((await runner.store.read('evidence-recovery')).runs['root']?.status).toBe('created');
  rmSync(obstacle);
  await runner.resume('evidence-recovery');
  const evidence = open(options.root, { ...options.inputs, evidence: true, cache: false });
  expect(evidence.records().filter((row) => row.band === 0 && row.discriminator === 'run')).toHaveLength(1);
  evidence.close();
});
