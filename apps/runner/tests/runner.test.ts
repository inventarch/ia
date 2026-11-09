import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { adoptWorkspace } from '@inventarch/workspace-runtime';
import {
  executionManifest,
  INSTALLED_READ,
  INSTALLED_READ_LEGACY,
  installed,
} from '@inventarch/agent-composition-system';
import type { CompiledHarness, CompositionCatalog } from '@inventarch/agent-composition-system';
import { open } from '@inventarch/db';
import type { EngineHost, Grant, ModelAction, ModelRequest } from '@inventarch/agent-system';
import { digest, replay } from '@inventarch/session-system';
import { openRunner, runnerAliases, runnerCatalog } from '../src/index.js';
import { normalizeScopeKey } from '@inventarch/runtime';
import { RunnerContext } from '../src/context.js';

/**
 * The switches of this package and of the composition package it compiles through, flipped together here to prove the
 * plain names come back exactly when the follow-up release flips them (dec-008, A15).
 */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
vi.mock('../../../.ia/src/systems/agent-composition-system/src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));

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
it('delivers explicit Memory and Escalation primitives through the current Door protocol', () => {
  const options = fixture();
  const context = new RunnerContext(options.root, { ...options.inputs });
  cleanups.push(() => context.close());
  for (const primitive of ['Memory', 'Escalation'] as const) {
    const key = normalizeScopeKey({ primitive });
    expect(context.position(key)).toMatchObject({ key: { primitive }, packet: { body: { key: { primitive } } } });
  }
});
const done: ModelAction = { type: 'outcome', kind: 'answer', message: 'Captured source read.', continuation: 'finish' };
function read(root: ReturnType<typeof openRunner>): ModelAction {
  return {
    type: 'invoke',
    operation: INSTALLED_READ.operation,
    input: { path: root.capture.sources.find((row) => row.path.endsWith('/records/runner.ia'))!.path, limit: 3 },
  };
}
function pathMandate(
  options: ReturnType<typeof fixture>,
  execution: string,
  path = '.ia/src/systems/agent-composition-system/records/runner.ia',
) {
  const file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(
    file,
    readFileSync(file, 'utf8') +
      `
@mandate covered-read-limits
  meaning
    says "Bound execution against the covered captured source."
    answers "Which cumulative budget applies to this read?"
  governance
    requires "Retain the original session budget when reading this path."
  authority
    participant @agent runner-reader
    covers ["${path}"]
    moves [Observation]
  execution
    ${execution}
`,
  );
}
function hostPolicy(overrides: () => Partial<Grant>): EngineHost['authorize'] {
  return async (principal, manifest, state) => ({
    id: 'local-policy',
    principal,
    workspace: manifest.workspace,
    profiles: Object.keys(manifest.profiles),
    operations: Object.keys(manifest.operations),
    effects: ['read'],
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
    ...overrides(),
  });
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

it('uses the installed context primitive for real model turns', async () => {
  const options = fixture(),
    seen: ModelRequest[] = [],
    catalog = runnerCatalog();
  const context = catalog.contexts['runner-context-v1']!.value;
  catalog.contexts['runner-context-v1'] = installed({
    ...context,
    coordinate: { ...context.coordinate, primitive: 'Escalation' },
  });
  const runner = openRunner({ ...options, catalog, model: scripted([done], seen) });
  cleanups.push(() => runner.close());
  await runner.start('Use the declared primitive', 'declared-primitive');
  await runner.run();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.context).toMatchObject({ key: { primitive: 'Escalation' } });
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
  expect(state.runs['root']?.status).toBe('waiting');
  expect(state.budget.operations).toBe(0);
  expect(state.budget.modelCalls).toBe(0);
  expect(seen).toHaveLength(0);
  expect(state.runs['root']?.wait).toMatchObject({
    reason: 'runner-authority-refusal',
    details: { code: 'IA-RUNTIME-MANDATE-MOVE', next: expect.stringContaining('ia position') },
  });
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
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('moves [Observation]', 'moves [Observation]\n    excluded-words [operation]'),
  );
  const runner = openRunner(options);
  cleanups.push(() => runner.close());
  await runner.start('Try an external invocation', 'external-refusal');
  const waiting = await runner.run(),
    attempt = Object.values(waiting.attempts).find((row) => row.kind === 'model')!;
  await runner.submit(attempt.id, { action: read(runner), usage: 1, model: 'runner/external', provider: 'local-test' });
  const state = await runner.run();
  expect(state.budget.operations).toBe(0);
  expect(JSON.stringify(state.runs['root']?.outcome)).toContain('IA-RUNTIME-MANDATE-WORD');
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

it('exposes no unbound or unaccounted direct read or navigation API', async () => {
  const options = fixture(),
    runner = openRunner(options);
  cleanups.push(() => runner.close());
  expect('request' in runner).toBe(false);
});

it('rejects a forged installed implementation description without loading code', () => {
  const options = fixture(),
    catalog = runnerCatalog();
  catalog.operations[INSTALLED_READ_LEGACY.implementation]!.value.implementationDigest = '0'.repeat(64);
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

it.each(['sources', 'effects'] as const)('does not disclose context without current %s permission', async (key) => {
  const options = fixture();
  const seen: ModelRequest[] = [];
  const runner = openRunner({
    ...options,
    model: scripted([done], seen),
    authorize: hostPolicy(() => ({ [key]: [] })),
  });
  cleanups.push(() => runner.close());
  const state = await runner.start('Open under a narrowing host policy', 'host-policy');
  expect(state.limits.operations).toBe(1);
  const refused = await runner.run();
  expect(seen).toHaveLength(0);
  expect(refused.budget.modelCalls).toBe(0);
  expect(refused.runs['root']?.wait).toMatchObject({
    reason: 'runner-authority-refusal',
    details: { code: 'IA-RUNNER-AUTHORITY' },
  });
});

it('retains original denied read authority even when the current host permits it', async () => {
  const options = fixture(),
    seen: ModelRequest[] = [];
  let allowed = false;
  const runner = openRunner({
    ...options,
    model: scripted([done], seen),
    authorize: hostPolicy(() => ({ effects: allowed ? ['read'] : [] })),
  });
  cleanups.push(() => runner.close());
  await runner.start('Retain original authority', 'retained-authority');
  allowed = true;
  const refused = await runner.run();
  expect(seen).toHaveLength(0);
  expect(refused.runs['root']?.wait).toMatchObject({ details: { code: 'IA-RUNNER-AUTHORITY' } });
});

it('rechecks disclosure permission after preparing context and before model transport', async () => {
  const options = fixture(),
    seen: ModelRequest[] = [];
  const policy = hostPolicy(() => ({}));
  const runner = openRunner({
    ...options,
    model: scripted([done], seen),
    authorize: async (principal, manifest, state) => {
      const grant = await policy(principal, manifest, state);
      if (state?.budget.modelCalls) grant.effects = [];
      return grant;
    },
  });
  cleanups.push(() => runner.close());
  await runner.start('Withdraw read after request preparation', 'dispatch-authority');
  const refused = await runner.run();
  expect(seen).toHaveLength(0);
  expect(refused.budget.modelCalls).toBe(1);
  expect(JSON.stringify(refused.runs['root']?.outcome)).toContain('IA-RUNNER-AUTHORITY');
});

it('journals source revocation after context preparation and preserves refusal across resume', async () => {
  const options = fixture(),
    seen: ModelRequest[] = [];
  const policy = hostPolicy(() => ({}));
  const runner = openRunner({
    ...options,
    model: scripted([done], seen),
    authorize: async (principal, manifest, state) => {
      const grant = await policy(principal, manifest, state);
      if (state?.budget.modelCalls) grant.sources = [];
      return grant;
    },
  });
  cleanups.push(() => runner.close());
  await runner.start('Withdraw source before transport', 'source-revoked');
  const refused = await runner.run();
  expect(seen).toHaveLength(0);
  expect(refused.budget.modelCalls).toBe(1);
  expect(refused.budget.reservedTokens).toBe(0);
  const attempts = Object.values(refused.attempts);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ kind: 'model', status: 'observed', error: 'not-dispatched', effect: 'none' });
  expect(refused.runs['root']?.wait).toMatchObject({
    reason: 'runner-authority-refusal',
    objectIds: [attempts[0]!.id],
    continuation: 'stop',
    details: { code: 'IA-ENGINE-AUTHORITY-DENIED', next: expect.stringContaining('ia position') },
  });
  const journal = await runner.store.journal(refused.id);
  expect(journal.events.some((event) => event.mutation.type === 'attempt.dispatch')).toBe(false);
  expect(journal.events.some((event) => event.mutation.type === 'attempt.abandon')).toBe(true);
  expect(replay(journal.events)).toEqual(refused);
  const db = open(options.root, { ...options.inputs, evidence: true, cache: false });
  expect(
    db
      .records()
      .some((record) => record.discriminator === 'observation' && JSON.stringify(record.sections).includes('refusal')),
  ).toBe(true);
  db.close();
  await runner.close();
  const resumed = openRunner({ ...options, model: scripted([done], seen) });
  cleanups.push(() => resumed.close());
  expect(await resumed.resume(refused.id)).toEqual(refused);
  expect(await resumed.run()).toEqual(refused);
  expect(seen).toHaveLength(0);
});

it('propagates unexpected host authorization errors without converting them into policy refusals', async () => {
  const options = fixture(),
    policy = hostPolicy(() => ({}));
  const runner = openRunner({
    ...options,
    authorize: async (principal, manifest, state) => {
      if (state) throw new Error('Unexpected local authorization failure');
      return policy(principal, manifest, state);
    },
  });
  cleanups.push(() => runner.close());
  await runner.start('Preserve unexpected errors', 'unexpected-host-error');
  await expect(runner.run()).rejects.toThrow('Unexpected local authorization failure');
  expect((await runner.store.read('unexpected-host-error')).runs['root']?.wait).toBeNull();
});

it.each(['operations', 'model-calls', 'steps', 'tokens', 'bytes'])(
  'applies a path-only zero %s mandate before read dispatch',
  async (limit) => {
    const options = fixture(),
      actions: ModelAction[] = [];
    pathMandate(options, `limit-${limit} 0`);
    const runner = openRunner({ ...options, model: scripted(actions, []) });
    cleanups.push(() => runner.close());
    actions.push(read(runner), done);
    await runner.start('Read a source with a covered limit', `path-${limit}`);
    const refused = await runner.run();
    expect(refused.budget.operations).toBe(0);
    expect(refused.runs['root']?.wait).toMatchObject({
      reason: 'runner-limit-refusal',
      details: { code: 'IA-RUNNER-MANDATE-LIMIT' },
    });
    expect(Object.values(refused.attempts).filter((row) => row.kind === 'operation')).toHaveLength(0);
  },
);

it('retains cumulative path operation counts after reopening a run', async () => {
  const options = fixture(),
    file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, readFileSync(file, 'utf8').replace('limit-operations 1', 'limit-operations 3'));
  pathMandate(options, 'limit-operations 1');
  const actions: ModelAction[] = [],
    runner = openRunner({ ...options, model: scripted(actions, []) });
  cleanups.push(() => runner.close());
  actions.push(read(runner));
  let state = await runner.start('Retain path counters', 'path-resume');
  while (state.budget.operations === 0) state = await runner.step();
  expect(state.receipts.some((receipt) => receipt.error === null && receipt.target === INSTALLED_READ.operation)).toBe(
    true,
  );
  await runner.close();
  const resumedActions: ModelAction[] = [],
    resumed = openRunner({ ...options, model: scripted(resumedActions, []) });
  cleanups.push(() => resumed.close());
  resumedActions.push(read(resumed), done);
  await resumed.resume(state.id);
  const refused = await resumed.run();
  expect(refused.budget.operations).toBe(1);
  expect(refused.runs['root']?.wait).toMatchObject({ details: { code: 'IA-RUNNER-MANDATE-LIMIT' } });
  expect(await resumed.run()).toEqual(refused);
  expect(await resumed.step()).toEqual(refused);
  await resumed.close();
  const stopped = openRunner(options);
  cleanups.push(() => stopped.close());
  expect(await stopped.resume(refused.id)).toEqual(refused);
  expect(await stopped.run()).toEqual(refused);
  expect(await stopped.step()).toEqual(refused);
});

it('reserves the installed body output bound within a nonzero path byte budget', async () => {
  const covered = async (execution: string, id: string) => {
    const options = fixture(),
      actions: ModelAction[] = [];
    pathMandate(options, execution);
    const runner = openRunner({ ...options, model: scripted(actions, []) });
    cleanups.push(() => runner.close());
    actions.push(read(runner));
    await runner.start('Keep the body within the covered byte budget', id);
    return runner.run();
  };
  // What a run retains before its first read is its journal (the compiled manifest, the delivered packet), which the
  // fixture and the adopted public language size. A covered zero-operation mandate refuses at the same check, so it
  // measures that. The budget admits it but not the read's 65536-byte installed output ceiling and 2048-byte envelope
  // (SPEC.md: a read reserves both within the applicable byte limit), so only the reservation can refuse.
  const before = (await covered('limit-operations 0', 'path-output-probe')).budget.retainedBytes,
    budget = before + 4096;
  const refused = await covered(`limit-bytes ${budget}`, 'path-output-bytes');
  expect(refused.budget.retainedBytes).toBeLessThan(budget);
  expect(refused.budget.operations).toBe(0);
  expect(refused.runs['root']?.wait).toMatchObject({ details: { code: 'IA-RUNNER-MANDATE-LIMIT' } });
});

it('does not apply an unrelated path mandate to an allowed captured read', async () => {
  const options = fixture(),
    actions: ModelAction[] = [];
  pathMandate(options, 'limit-operations 0', '.ia/src/systems/agent-composition-system/records/other.ia');
  const runner = openRunner({ ...options, model: scripted(actions, []) });
  cleanups.push(() => runner.close());
  actions.push(read(runner), done);
  await runner.start('Read outside the restricted path', 'unrelated-path');
  const finished = await runner.run();
  expect(finished.budget.operations).toBe(1);
  expect(finished.runs['root']?.status).toBe('completed');
});

it('applies path limits to externally submitted invocations', async () => {
  const options = fixture();
  pathMandate(options, 'limit-operations 0');
  const runner = openRunner(options);
  cleanups.push(() => runner.close());
  await runner.start('Reject an externally submitted over-budget path', 'external-path');
  const waiting = await runner.run();
  const attempt = Object.values(waiting.attempts).find((row) => row.kind === 'model')!;
  await runner.submit(attempt.id, { action: read(runner), usage: 1, model: 'runner/external', provider: 'local-test' });
  const refused = await runner.run();
  expect(refused.budget.operations).toBe(0);
  expect(refused.runs['root']?.wait).toMatchObject({ details: { code: 'IA-RUNNER-MANDATE-LIMIT' } });
});

it('measures path duration from the original session creation time', async () => {
  const options = fixture(),
    actions: ModelAction[] = [];
  pathMandate(options, 'limit-duration-ms 1');
  const runner = openRunner({ ...options, model: scripted(actions, []) });
  cleanups.push(() => runner.close());
  actions.push(read(runner));
  await runner.start('Retain original path deadline', 'path-deadline');
  await new Promise((done) => setTimeout(done, 10));
  const refused = await runner.run();
  expect(refused.budget.operations).toBe(0);
  expect(refused.runs['root']?.wait).toMatchObject({ details: { code: 'IA-RUNNER-MANDATE-LIMIT' } });
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

// A contract's version is its entry's `version`, so the runner contracts have plain names. The released records and the
// original entries are what this release compiles (dec-008, A15): the shipped records name the original contracts, and
// `runnerAliases()` is empty until the switch flips. The plain entries stay installed, and a record that names one
// compiles to it.
const RUNNER_PLAIN = [
  'runner-local',
  'runner-external',
  'runner-task',
  'runner-outcomes',
  'runner-read',
  'runner-context',
  'runner-entry',
  'runner-identity',
];
const READ_PLAIN = ['captured-source-read', 'captured-source-read-input', 'captured-source-read-output'];
const namesWithoutVersions = (text: string) =>
  text.replace(new RegExp(`\\b(${RUNNER_PLAIN.join('|')})-v1\\b`, 'g'), '$1');
const readNamesWithoutVersions = (text: string) =>
  text
    .replace(/^(\s+(?:handler|input|output|implementation) captured-source-read(?:-input|-output)?)-v1$/gm, '$1')
    .replace(/^(\s+profile governed)-v1$/gm, '$1');
/** The fixture as it would be written once names stop carrying their version, runner records and adopted read both. */
function plainFixture() {
  const options = fixture(),
    file = resolve(options.root, '.ia/src/systems/agent-composition-system/records/runner.ia');
  writeFileSync(file, namesWithoutVersions(readFileSync(file, 'utf8')));
  // Adoption verifies the exact bytes, so re-adopt a copy of the public sources whose read records use the plain names.
  const copy = mkdtempSync(resolve(tmpdir(), 'ia-runner-adopt-'));
  cleanups.push(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(resolve(repository, '.ia/src'), resolve(copy, '.ia/src'), {
    recursive: true,
    filter: (source) => !/(^|[\\/])(node_modules|dist)$/.test(source),
  });
  for (const name of ['operations/read-captured-source.ia', 'records/read-captured-source-binding.ia']) {
    const target = resolve(copy, '.ia/src/systems/agent-composition-system', name);
    writeFileSync(target, readNamesWithoutVersions(readFileSync(target, 'utf8')));
  }
  const adopted = [adoptWorkspace(copy, 'public-language')];
  return { ...options, inputs: { adopted } };
}
/** Run `body` with both switches flipped, and put them back. */
async function flipped<T>(body: () => Promise<T> | T): Promise<T> {
  flip.plain = true;
  try {
    return await body();
  } finally {
    flip.plain = false;
  }
}
const installedPins = (runner: ReturnType<typeof openRunner>) =>
  (
    runner.manifest.provenance as {
      compiled: {
        format: string;
        provenance: {
          installed: { group: string; id: string }[];
          aliases?: { group: string; from: string; to: string }[];
        };
      };
    }
  ).compiled;
const onlyOriginals = (catalog: CompositionCatalog): CompositionCatalog => {
  const plain = new Set([...RUNNER_PLAIN, ...READ_PLAIN]);
  const keep = <T>(table: Record<string, T>) =>
    Object.fromEntries(Object.entries(table).filter(([name]) => !plain.has(name)));
  return {
    hosts: keep(catalog.hosts),
    models: keep(catalog.models),
    validators: keep(catalog.validators),
    outcomes: keep(catalog.outcomes),
    mandates: keep(catalog.mandates),
    contexts: keep(catalog.contexts),
    operations: keep(catalog.operations),
    evaluators: catalog.evaluators,
    entries: keep(catalog.entries),
    mappings: keep(catalog.mappings),
  };
};

it('names the runner contracts plainly and keeps the originals byte for byte', async () => {
  const catalog = runnerCatalog();
  for (const name of RUNNER_PLAIN) {
    const group = Object.values(catalog).find((table) => Object.hasOwn(table, name + '-v1')) as Record<
      string,
      ReturnType<typeof installed>
    >;
    expect(group, name).toBeDefined();
    const original = group[name + '-v1']!;
    expect(original.version).toBe(1);
    expect(original.digest).toBe(digest({ version: 1, value: original.value }));
    expect(Object.hasOwn(group, name), name).toBe(true);
  }
  // Values the previous release installed, written out: host, mandate, context and entry name their dependencies.
  expect(catalog.hosts['runner-local-v1']!.value).toMatchObject({
    models: ['runner-external-v1'],
    defaults: {
      model: 'runner-external-v1',
      input: 'runner-task-v1',
      outcomes: 'runner-outcomes-v1',
      context: 'runner-context-v1',
      mapping: 'runner-identity-v1',
    },
  });
  expect(catalog.hosts['runner-local-v1']!.digest).toBe(
    digest({ version: 1, value: catalog.hosts['runner-local-v1']!.value }),
  );
  expect(catalog.mandates['runner-read-v1']!.value).toMatchObject({
    input: 'runner-task-v1',
    outcomes: 'runner-outcomes-v1',
    context: 'runner-context-v1',
  });
  expect(catalog.entries['runner-entry-v1']!.value).toEqual({ target: 'agent-profile', mapping: 'runner-identity-v1' });
  expect(catalog.hosts['runner-local']!.value).toMatchObject({
    models: ['runner-external'],
    defaults: {
      model: 'runner-external',
      input: 'runner-task',
      outcomes: 'runner-outcomes',
      context: 'runner-context',
      mapping: 'runner-identity',
    },
  });
  // Until the switch flips there is no alias table: a record that names an original contract compiles to the original.
  expect(runnerAliases()).toEqual({});
  await flipped(() => {
    const aliases = runnerAliases();
    expect(aliases.hosts).toEqual({ 'runner-local-v1': 'runner-local' });
    expect(aliases.operations).toEqual({ 'captured-source-read-v1': 'captured-source-read' });
    expect(Object.keys(aliases.validators ?? {}).sort()).toEqual([
      'captured-source-read-input-v1',
      'captured-source-read-output-v1',
      'runner-task-v1',
    ]);
  });
});
it('compiles the released records to the original entries and handler by default', () => {
  const runner = openRunner(fixture());
  cleanups.push(() => runner.close());
  const compiled = installedPins(runner),
    ids = compiled.provenance.installed.map((pin) => pin.id);
  // Forward compatibility: exactly what the released programs read, name for name.
  expect(compiled.format).toBe('ia.compiled-harness.v1');
  expect(Object.hasOwn(compiled, 'formatVersion')).toBe(false);
  expect(compiled.provenance.aliases).toBeUndefined();
  expect(ids).toEqual(
    expect.arrayContaining(['runner-local-v1', 'runner-read-v1', 'runner-entry-v1', 'captured-source-read-v1']),
  );
  expect(ids.some((id) => RUNNER_PLAIN.includes(id) || READ_PLAIN.includes(id))).toBe(false);
  expect(runner.manifest.operations[INSTALLED_READ.operation]!.handler).toBe('ia.captured-source.read.v1');
  for (const profile of Object.values(runner.manifest.profiles))
    expect(profile.contract!.completionEvaluator).toBe('ia.completion.v1');
});
it('compiles the plain records and pins the plain entries without aliases', () => {
  const runner = openRunner(plainFixture());
  cleanups.push(() => runner.close());
  const provenance = installedPins(runner).provenance;
  expect(provenance.aliases).toBeUndefined();
  const ids = provenance.installed.map((pin) => pin.id);
  expect(ids).toEqual(expect.arrayContaining(['runner-local', 'runner-read', 'runner-entry', 'captured-source-read']));
  expect(ids.some((id) => id.endsWith('-v1'))).toBe(false);
  expect(runner.manifest.operations[INSTALLED_READ.operation]!.handler).toBe('captured-source-read');
});
it('compiles records that still name the original ids through the aliases once the switch flips, and reads', async () => {
  await flipped(async () => {
    const options = fixture(),
      actions: ModelAction[] = [],
      seen: ModelRequest[] = [];
    const runner = openRunner({ ...options, model: scripted(actions, seen) });
    cleanups.push(() => runner.close());
    const compiled = installedPins(runner);
    expect(compiled.format).toBe('compiled-harness');
    expect(compiled.provenance.installed.some((pin) => pin.id.endsWith('-v1'))).toBe(false);
    expect(compiled.provenance.aliases?.map((row) => row.from)).toEqual(
      expect.arrayContaining(['runner-local-v1', 'runner-read-v1', 'runner-entry-v1', 'captured-source-read-v1']),
    );
    expect(runner.manifest.operations[INSTALLED_READ.operation]!.handler).toBe('captured-source-read');
    actions.push(read(runner), done);
    await runner.start('Read through aliases', 'aliased-read');
    const state = await runner.run();
    expect(state.runs['root']?.status).toBe('completed');
    expect(state.budget.operations).toBe(1);
  });
});
it('keeps a harness pinned to the original catalog valid and dispatching by the original handler', async () => {
  const options = fixture(),
    actions: ModelAction[] = [],
    seen: ModelRequest[] = [];
  // Compile against only the original entries, as the previous release runner did.
  const old = openRunner({ ...options, catalog: onlyOriginals(runnerCatalog()), model: scripted([], []) });
  cleanups.push(() => old.close());
  const pinned = installedPins(old);
  expect(pinned.provenance.aliases).toBeUndefined();
  expect(pinned.provenance.installed.every((pin) => pin.group === 'evaluators' || pin.id.endsWith('-v1'))).toBe(true);
  expect(old.manifest.operations[INSTALLED_READ.operation]!.handler).toBe('ia.captured-source.read.v1');
  // The harness it pinned still passes the bridge against the catalog that now also installs the plain entries.
  const compiled = (old.manifest.provenance as unknown as { compiled: CompiledHarness }).compiled;
  expect(executionManifest(compiled, runnerCatalog()).digest).toBe(old.manifest.digest);
  // The current catalog, given the original records and no aliases, binds the retained entries and dispatches the read.
  const runner = openRunner({ ...options, catalog: runnerCatalog(), model: scripted(actions, seen) });
  cleanups.push(() => runner.close());
  expect(runner.manifest.digest).toBe(old.manifest.digest);
  actions.push(read(runner), done);
  await runner.start('Read through the original handler', 'original-read');
  const state = await runner.run();
  expect(state.runs['root']?.status).toBe('completed');
  expect(state.budget.operations).toBe(1);
});
