import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest, memoryStore } from '@ia/session-system';
import { sqliteStore } from '@ia/session-system/sqlite';
import type { Json, SessionStore } from '@ia/session-system';
import { Engine, manifestDigest } from '../src/index.js';
import type {
  EngineHost,
  ExecutionContract,
  Grant,
  Manifest,
  ModelAction,
  ModelRequest,
  Profile,
} from '../src/index.js';

const string = { type: 'string' } as const;
const object = (properties: Record<string, Json>): Json => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const contract = (): ExecutionContract => ({
  id: 'task-v1',
  mandateContracts: ['bounded-v1'],
  inputContracts: [{ id: 'text', schema: string }],
  effects: ['read', 'local-write'],
  limits: {},
  delegation: [{ profile: 'child', limits: { modelCalls: 1, children: 0, depth: 0 } }],
  checks: [],
  completionEvaluator: 'ia.completion.v1',
  repairAttempts: 1,
  maxAttempts: 2,
});
const profile = (id: string): Profile => ({
  id,
  agent: `${id}-agent`,
  role: id,
  voice: '',
  instructions: [],
  operations: ['validate', 'publish'],
  capabilities: [],
  delegates: id === 'author' ? ['child'] : [],
  outcomes: ['answer', 'clarification', 'proposal', 'deliverable'],
  completion: 'artifact',
  checks: [],
  model: 'test',
  contract: contract(),
});
const answer: ModelAction = { type: 'outcome', kind: 'answer', message: 'done', continuation: 'finish' };
const startRequest = {
  sessionId: 'session',
  commandId: 'start',
  principal: 'alice',
  profile: 'author',
  task: 'Draft a record',
  artifact: { operation: 'publish', destination: 'managed/draft' },
};
function fixture(store: SessionStore = memoryStore()) {
  let writes = 0;
  const grant: Grant = {
    id: 'grant',
    principal: 'alice',
    workspace: 'w',
    expiresAt: Date.now() + 600000,
    profiles: ['author', 'child'],
    operations: ['validate', 'publish'],
    effects: ['read', 'local-write'],
    sources: ['source'],
    models: ['test'],
    destinations: ['managed/draft'],
    limits: {
      steps: 30,
      modelCalls: 20,
      operations: 10,
      tokens: 1000000,
      bytes: 5000000,
      children: 3,
      depth: 3,
      deadline: Date.now() + 600000,
    },
  };
  const body: Omit<Manifest, 'digest'> = {
    version: 1,
    id: 'governed',
    workspace: 'w',
    sourceDigest: 'source',
    profiles: { author: profile('author'), child: { ...profile('child'), completion: 'response' } },
    operations: {
      validate: {
        id: 'validate',
        handler: 'validate',
        digest: digest('validate'),
        purpose: 'candidate-validation',
        effects: ['read'],
        recovery: 'repeatable',
        timeoutMs: 1000,
        input: string,
        output: object({ allowed: { type: 'boolean' }, candidateDigest: string, artifactDigest: string }),
      },
      publish: {
        id: 'publish',
        handler: 'publish',
        digest: digest('publish'),
        effects: ['local-write'],
        recovery: 'reconcile',
        timeoutMs: 1000,
        input: object({ candidate: string, destination: string }),
        output: object({ candidateDigest: string, artifactDigest: string, destination: string }),
      },
    },
    reactions: [],
    provenance: {},
  };
  const manifest = { ...body, digest: manifestDigest(body) };
  const host: EngineHost = {
    store,
    model: { id: 'deferred', generate: async () => ({ deferred: true }) },
    operations: {
      validate: {
        id: 'validate',
        execute: async (input) => ({
          effect: 'none',
          output: { allowed: true, candidateDigest: digest(input), artifactDigest: digest('exact bytes') },
        }),
      },
      publish: {
        id: 'publish',
        execute: async (input) => {
          writes++;
          const value = input as { candidate: Json; destination: Json };
          return {
            effect: 'applied',
            output: {
              candidateDigest: digest(value.candidate),
              artifactDigest: digest('exact bytes'),
              destination: value.destination,
            },
          };
        },
      },
    },
    authorize: async () => grant,
    verifyManifest: async () => true,
    context: async () => null,
    evaluate: async () => ({ status: 'pass', evidence: [], message: 'pass' }),
    preflight: async () => true,
  };
  return {
    manifest,
    host,
    grant,
    store,
    writes: () => writes,
    engine: () => {
      manifest.digest = manifestDigest(manifest);
      return new Engine(manifest, host);
    },
  };
}
function scripted(f: ReturnType<typeof fixture>, next: (request: ModelRequest) => ModelAction) {
  f.host.model = {
    id: 'scripted',
    generate: async (request) => ({ action: next(request), model: 'test', provider: 'test', usage: 10 }),
  };
}
async function offered(f: ReturnType<typeof fixture>) {
  let n = 0;
  scripted(f, (request) =>
    n++ === 0
      ? { type: 'invoke', operation: 'validate', input: 'draft' }
      : {
          type: 'outcome',
          kind: 'proposal',
          message: 'Review exact draft',
          continuation: 'await-review',
          proposal: 'draft',
          review: {
            operation: 'publish',
            input: { candidate: 'draft', destination: 'managed/draft' },
            validationReceipt: (
              request.history.find((row) => (row as { target?: string }).target === 'validate') as { receipt: string }
            ).receipt,
          },
        },
  );
  const engine = f.engine();
  await engine.start(startRequest);
  const state = await engine.advance('session', 'alice');
  return { engine, proposal: Object.values(state.proposals)[0]! };
}
async function accepted(f: ReturnType<typeof fixture>) {
  const { engine, proposal } = await offered(f);
  await engine.review('session', 'alice', proposal.id, proposal.revision, proposal.digest, true, 'Reviewed', 'approve');
  const p = (await f.store.read('session')).proposals[proposal.id]!;
  return {
    proposal: p,
    action: {
      type: 'invoke',
      operation: 'publish',
      input: { candidate: 'draft', destination: 'managed/draft' },
      review: { proposalId: p.id, revision: p.revision, digest: p.digest, decisionId: p.decisionId! },
    } satisfies ModelAction,
  };
}
const directories: string[] = [],
  stores: SessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of directories.splice(0)) {
    if (!relative(tmpdir(), dir).startsWith('ia-p2-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

it('persists an exact review across a SQLite restart and completes only with its observed artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-p2-'));
  directories.push(dir);
  const f = fixture(sqliteStore(dir));
  const { action } = await accepted(f);
  await f.store.close();
  const reopened = sqliteStore(dir);
  stores.push(reopened);
  f.host.store = reopened;
  let n = 0;
  scripted(f, (request) =>
    n++ === 0
      ? action
      : {
          type: 'outcome',
          kind: 'deliverable',
          message: 'Published',
          continuation: 'finish',
          artifacts: [
            (request.history.find((row) => (row as { target?: string }).target === 'publish') as { receipt: string })
              .receipt,
          ],
        },
  );
  const state = await f.engine().advance('session', 'alice');
  expect(state.runs['root']!.status).toBe('completed');
  expect(f.writes()).toBe(1);
  const receipt = state.receipts.find((r) => r.target === 'publish')!;
  expect(receipt.invocationId).not.toBe(receipt.attemptId);
  expect(receipt.actionId).not.toBe(receipt.invocationId);
  expect(receipt.cause!.decisions).toEqual([receipt.review!.decisionId]);
  expect(receipt.review!.inputDigest).toBe(digest(action.input));
  expect(state.runs['root']!.contract).toMatchObject({
    completion: 'artifact',
    escalation: 'persist-required-wait',
    artifact: startRequest.artifact,
  });
  // Match the other durable SQLite restart fixture's Windows I/O allowance.
}, 30_000);
it('rejects wrong reviewers, stale digests, changed duplicate decisions, and expired review contracts', async () => {
  const f = fixture(),
    { engine, proposal: p } = await offered(f);
  await expect(engine.review('session', 'mallory', p.id, p.revision, p.digest, true, '', 'wrong')).rejects.toThrow();
  await expect(engine.review('session', 'alice', p.id, p.revision + 1, p.digest, true, '', 'stale')).rejects.toThrow();
  await expect(
    engine.review('session', 'alice', p.id, p.revision, digest('other'), true, '', 'digest'),
  ).rejects.toThrow();
  await engine.review('session', 'alice', p.id, p.revision, p.digest, true, '', 'yes');
  await engine.review('session', 'alice', p.id, p.revision, p.digest, true, '', 'yes');
  await expect(engine.review('session', 'alice', p.id, p.revision, p.digest, false, '', 'yes')).rejects.toMatchObject({
    code: 'IA-SESSION-COMMAND-CONFLICT',
  });
  const expired = fixture(),
    offeredExpired = await offered(expired);
  expired.host.now = () => offeredExpired.proposal.review!.expiresAt + 1;
  await expect(
    offeredExpired.engine.review(
      'session',
      'alice',
      offeredExpired.proposal.id,
      1,
      offeredExpired.proposal.digest,
      true,
      '',
      'late',
    ),
  ).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
it.each(['candidate', 'destination', 'decision', 'grant', 'preflight', 'binding'] as const)(
  'refuses changed %s before a reviewed effect',
  async (change) => {
    const f = fixture(),
      { action } = await accepted(f);
    if (change === 'candidate') action.input.candidate = 'changed';
    if (change === 'destination') {
      action.input.destination = 'managed/other';
      f.grant.destinations!.push('managed/other');
    }
    if (change === 'decision') action.review.decisionId = 'invented';
    if (change === 'grant') f.grant.operations = ['validate'];
    if (change === 'preflight') f.host.preflight = async () => false;
    if (change === 'binding') f.host.verifyManifest = async () => false;
    scripted(f, () => action);
    await expect(f.engine().advance('session', 'alice')).rejects.toThrow();
    expect(f.writes()).toBe(0);
  },
);
it('rechecks revocation after durable prepare and before entering an adapter', async () => {
  const f = fixture(),
    { action } = await accepted(f);
  scripted(f, () => action);
  f.host.authorize = async (_p, _m, state) =>
    state && Object.values(state.attempts).some((a) => a.target === 'publish' && a.status === 'prepared')
      ? { ...f.grant, operations: ['validate'] }
      : f.grant;
  await expect(f.engine().advance('session', 'alice')).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
it('keeps an uncooperative reviewed write unknown, ignores late success and reconciles before completion', async () => {
  const f = fixture();
  f.manifest.operations['publish']!.timeoutMs = 25;
  const { action } = await accepted(f);
  let resolve!: (result: { effect: 'applied'; output: Json }) => void,
    lateContext: import('../src/index.js').OperationContext | undefined,
    lookups = 0;
  const output = {
    candidateDigest: digest('draft'),
    artifactDigest: digest('exact bytes'),
    destination: 'managed/draft',
  };
  f.host.operations = {
    ...f.host.operations,
    publish: {
      id: 'publish',
      execute: async (_input, context) => {
        lateContext = context;
        return new Promise((done) => {
          resolve = done;
        });
      },
      reconcile: async () => {
        lookups++;
        return { status: 'applied', output };
      },
    },
  };
  scripted(f, () => action);
  // review readiness, inference, action acceptance, execution: stop before recovery.
  let timer: ReturnType<typeof setTimeout>;
  const stopped = await Promise.race([
    f.engine().advance('session', 'alice', { maxActions: 4 }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Write timeout did not release scheduler')), 1000);
    }),
  ]).finally(() => clearTimeout(timer!));
  const attempt = Object.values(stopped.attempts).find((a) => a.target === 'publish')!;
  expect(attempt).toMatchObject({
    status: 'observed',
    effect: 'unknown',
    error: 'operation-attempt-failed',
    output: null,
  });
  expect(lateContext!.signal.aborted).toBe(true);
  await expect(lateContext!.assertCurrent!()).rejects.toThrow();
  await expect(f.engine().retry('session', 'alice', attempt.id, 'unsafe-retry')).rejects.toThrow();
  resolve({ effect: 'applied', output });
  await new Promise((done) => setTimeout(done, 0));
  expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
  scripted(f, (request) => ({
    type: 'outcome',
    kind: 'deliverable',
    message: 'Recovered',
    continuation: 'finish',
    artifacts: [
      (
        [...request.history].reverse().find((row) => (row as { target?: string }).target === 'publish') as {
          receipt: string;
        }
      ).receipt,
    ],
  }));
  const done = await f.engine().advance('session', 'alice');
  expect(done.runs['root']!.status).toBe('completed');
  expect(lookups).toBe(1);
  expect(done.receipts.find((r) => r.attemptId === attempt.id && r.reconciles === null)!.effect).toBe('unknown');
  expect(done.receipts.find((r) => r.reconciles === attempt.id)).toMatchObject({ effect: 'applied', error: null });
  expect(done.budget.operations).toBe(3);
});
it('rechecks a narrowed operation quota after durable prepare', async () => {
  const f = fixture(),
    { action } = await accepted(f);
  scripted(f, () => action);
  f.host.authorize = async (_p, _m, state) =>
    state && Object.values(state.attempts).some((a) => a.target === 'publish' && a.status === 'prepared')
      ? { ...f.grant, limits: { ...f.grant.limits, operations: 1 } }
      : f.grant;
  await expect(f.engine().advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-LIMIT-EXCEEDED' });
  expect(f.writes()).toBe(0);
});
it.each(['unknown-effect', 'reconciliation-unavailable', 'reconciliation-exhausted'] as const)(
  'does not manufacture journal progress by repeating an unchanged %s wait',
  async (reason) => {
    const f = fixture();
    f.manifest.profiles['author']!.contract!.maxAttempts = 1;
    const { action } = await accepted(f);
    scripted(f, () => action);
    f.host.operations = {
      ...f.host.operations,
      publish: {
        id: 'publish',
        execute: async () => {
          if (reason === 'reconciliation-unavailable') f.grant.destinations = [];
          throw new Error('Uncertain effect');
        },
        ...(reason === 'unknown-effect'
          ? {}
          : { reconcile: async () => ({ status: 'unknown' as const, output: null }) }),
      },
    };
    let waiting = await f.engine().advance('session', 'alice');
    if (reason === 'reconciliation-exhausted') waiting = await f.engine().advance('session', 'alice');
    expect(waiting.runs['root']!.wait!.reason).toBe(reason);
    const repeated = await f.engine().advance('session', 'alice');
    expect(repeated.sequence).toBe(waiting.sequence);
    expect(repeated.receipts).toEqual(waiting.receipts);
    expect(repeated.budget).toEqual(waiting.budget);
  },
);
it('refuses unrelated artifact output and never completes on proposal acceptance alone', async () => {
  const f = fixture(),
    { action } = await accepted(f);
  scripted(f, () => ({
    type: 'outcome',
    kind: 'proposal',
    message: 'Accepted',
    continuation: 'finish',
    proposal: 'draft',
  }));
  const waiting = await f.engine().advance('session', 'alice');
  expect(waiting.runs['root']).toMatchObject({
    status: 'waiting',
    pendingAction: null,
    wait: { reason: 'invalid-model-action', details: { code: 'IA-ENGINE-COMPLETION-DENIED' } },
  });
  expect(f.writes()).toBe(0);
  await f.engine().retry('session', 'alice', waiting.runs['root']!.wait!.objectIds[0]!, 'repair-completion');
  let next = 0;
  scripted(f, (request) =>
    next++ === 0
      ? action
      : {
          type: 'outcome',
          kind: 'deliverable',
          message: 'Published',
          continuation: 'finish',
          artifacts: [
            (request.history.find((row) => (row as { target?: string }).target === 'publish') as { receipt: string })
              .receipt,
          ],
        },
  );
  expect((await f.engine().advance('session', 'alice')).runs['root']!.status).toBe('completed');
  expect(f.writes()).toBe(1);
  const other = fixture(),
    reviewed = await accepted(other);
  let n = 0;
  other.host.operations = {
    ...other.host.operations,
    publish: {
      id: 'publish',
      execute: async () => ({
        effect: 'applied',
        output: { candidateDigest: digest('draft'), artifactDigest: digest('unrelated'), destination: 'managed/draft' },
      }),
    },
  };
  scripted(other, (request) =>
    n++ === 0
      ? reviewed.action
      : {
          type: 'outcome',
          kind: 'deliverable',
          message: 'Done',
          continuation: 'finish',
          artifacts: [
            (request.history.find((r) => (r as { target?: string }).target === action.operation) as { receipt: string })
              .receipt,
          ],
        },
  );
  expect((await other.engine().advance('session', 'alice')).runs['root']).toMatchObject({
    status: 'waiting',
    pendingAction: null,
    wait: { reason: 'invalid-model-action', details: { code: 'IA-ENGINE-COMPLETION-DENIED' } },
  });
});
it('retries a failed read with one logical invocation, distinct attempts, and conserved budgets', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.completion = 'response';
  let calls = 0;
  f.host.operations = {
    ...f.host.operations,
    validate: {
      id: 'validate',
      execute: async () => {
        calls++;
        throw new Error('read failed');
      },
    },
  };
  scripted(f, () => ({ type: 'invoke', operation: 'validate', input: 'draft' }));
  const engine = f.engine();
  await engine.start(startRequest);
  let state = await engine.advance('session', 'alice'),
    attempt = Object.values(state.attempts).find((a) => a.kind === 'operation')!;
  const firstBudget = state.budget;
  await engine.retry('session', 'alice', attempt.id, 'retry');
  await engine.retry('session', 'alice', attempt.id, 'retry');
  state = await engine.advance('session', 'alice');
  const attempts = Object.values(state.attempts).filter((a) => a.kind === 'operation');
  expect(calls).toBe(2);
  expect(new Set(attempts.map((a) => a.invocationId)).size).toBe(1);
  expect(attempts[0]!.id).not.toBe(attempts[1]!.id);
  expect(state.budget.modelCalls).toBe(firstBudget.modelCalls);
  expect(state.budget.operations).toBe(firstBudget.operations + 1);
  expect(state.budget.usedTokens).toBe(firstBudget.usedTokens);
  attempt = attempts.find((a) => a.id !== attempt.id)!;
  await expect(engine.retry('session', 'alice', attempt.id, 'third')).rejects.toThrow('allowance');
});
it('bounds model repair without resetting usage or allowing a saved response to be accepted twice', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.completion = 'response';
  let calls = 0;
  f.host.model = {
    id: 'bad',
    generate: async () => ({
      action: ++calls === 1 ? { type: 'fake' } : answer,
      model: 'test',
      provider: 'test',
      usage: 9,
    }),
  };
  const engine = f.engine();
  await engine.start(startRequest);
  const state = await engine.advance('session', 'alice'),
    id = state.runs['root']!.wait!.objectIds[0]!;
  await engine.retry('session', 'alice', id, 'repair');
  const repaired = await engine.advance('session', 'alice');
  expect(repaired.runs['root']!.status).toBe('completed');
  expect(repaired.budget.usedTokens).toBe(18);
  expect(repaired.budget.modelCalls).toBe(2);
});
it('enforces conjunctive task inputs and explicit zero ceilings before model invocation', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.contract!.inputContracts.push({
    id: 'short',
    schema: { type: 'string', maxLength: 3 },
  });
  await expect(f.engine().start(startRequest)).rejects.toMatchObject({ code: 'IA-ENGINE-TASK-INVALID' });
  f.manifest.profiles['author']!.contract!.inputContracts.pop();
  f.manifest.profiles['author']!.contract!.limits.modelCalls = 0;
  const engine = f.engine();
  await engine.start(startRequest);
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-LIMIT-EXCEEDED' });
  expect((await f.store.read('session')).budget.modelCalls).toBe(0);
});
it('persists narrowed child authority and enforces its own model ceiling against later host expansion', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.completion = 'response';
  let childGrant: Grant | undefined;
  scripted(f, (request) =>
    request.profile.id === 'author'
      ? { type: 'delegate', profile: 'child', task: 'Review' }
      : { type: 'continue', message: 'More work' },
  );
  f.host.context = async (p, _task, grant) => {
    if (p.id === 'child') childGrant = grant;
    return null;
  };
  const engine = f.engine();
  await engine.start(startRequest);
  await engine.advance('session', 'alice', { maxActions: 4 });
  f.grant.sources.push('secret');
  f.grant.operations.push('admin');
  f.grant.models.push('admin');
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-LIMIT-EXCEEDED' });
  expect(childGrant!.sources).toEqual(['source']);
  expect(childGrant!.operations).not.toContain('admin');
  expect(childGrant!.models).not.toContain('admin');
  const child = Object.values((await f.store.read('session')).runs).find((r) => r.parentId)!;
  expect(child.limits!.modelCalls).toBe(1);
  expect(child.limits!.children).toBe(0);
});
it('preserves a required clarification across restart without treating its answer as approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-p2-'));
  directories.push(dir);
  const f = fixture(sqliteStore(dir));
  scripted(f, () => ({
    type: 'outcome',
    kind: 'clarification',
    message: 'Choose a target',
    continuation: 'await-input',
    questions: [{ prompt: 'Which target?', choices: ['managed/draft'], required: true }],
  }));
  await f.engine().start(startRequest);
  const waiting = await f.engine().advance('session', 'alice'),
    q = Object.values(waiting.questions)[0]!;
  expect(waiting.runs['root']!.outcome).toMatchObject({ references: { questions: [q.id] } });
  await f.store.close();
  const reopened = sqliteStore(dir);
  stores.push(reopened);
  f.host.store = reopened;
  scripted(f, () => ({
    type: 'invoke',
    operation: 'publish',
    input: { candidate: 'draft', destination: 'managed/draft' },
  }));
  const engine = f.engine();
  await expect(engine.reply('session', 'mallory', q.id, 1, q.digest, 'managed/draft', 'wrong')).rejects.toThrow();
  await engine.reply('session', 'alice', q.id, 1, q.digest, 'managed/draft', 'answer');
  await engine.reply('session', 'alice', q.id, 1, q.digest, 'managed/draft', 'answer');
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-REVIEW-INVALID' });
  expect(f.writes()).toBe(0);
  expect((await reopened.read('session')).budget.modelCalls).toBe(waiting.budget.modelCalls + 1);
  // This disk-backed SQLite restart fixture measured 11.3s on Windows CI.
}, 30_000);
it('preserves zero operation and child journal-byte ceilings', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.contract!.limits.operations = 0;
  scripted(f, () => ({ type: 'invoke', operation: 'validate', input: 'draft' }));
  const engine = f.engine();
  await engine.start(startRequest);
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-LIMIT-EXCEEDED' });
  expect((await f.store.read('session')).budget.operations).toBe(0);
  const child = fixture();
  child.manifest.profiles['author']!.contract!.delegation[0]!.limits.bytes = 0;
  scripted(child, () => ({ type: 'delegate', profile: 'child', task: 'Review' }));
  const childEngine = child.engine();
  await childEngine.start(startRequest);
  await expect(childEngine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-SESSION-LIMIT-EXCEEDED' });
  expect((await child.store.read('session')).budget.children).toBe(0);
});
it('refuses an unavailable required evaluator immediately before a reviewed effect', async () => {
  const f = fixture();
  f.manifest.profiles['author']!.checks = ['required'];
  f.manifest.profiles['author']!.contract!.checks = [{ id: 'required', phases: ['before-effect'] }];
  const { action } = await accepted(f);
  scripted(f, () => action);
  f.host.evaluate = async () => ({ status: 'unavailable', evidence: [], message: 'Not installed' });
  await expect(f.engine().advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-GOVERNANCE-DENIED' });
  expect(f.writes()).toBe(0);
});

it.each(['caller', 'deadline'] as const)(
  'bounds a hung pre-dispatch preflight by %s without dispatching or accepting its late success',
  async (bound) => {
    const f = fixture(),
      { action } = await accepted(f);
    scripted(f, () => action);
    f.host.operations = {
      ...f.host.operations,
      publish: { ...f.host.operations['publish']!, reconcile: async () => ({ status: 'absent', output: null }) },
    };
    let enter!: () => void, finish!: (value: boolean) => void, context!: import('../src/index.js').OperationContext;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      pending = new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
      control = new AbortController();
    f.host.preflight = async (_operation, _input, received) => {
      context = received;
      enter();
      return pending;
    };
    if (bound === 'deadline') f.host.now = () => f.grant.expiresAt - 25;
    const work = f.engine().advance('session', 'alice', { signal: control.signal });
    await entered;
    if (bound === 'caller') control.abort(new Error('preflight-stop'));
    let timer!: ReturnType<typeof setTimeout>;
    await expect(
      Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Preflight kept scheduler blocked')), 1000);
        }),
      ]).finally(() => clearTimeout(timer)),
    ).rejects.toMatchObject(bound === 'caller' ? { message: 'preflight-stop' } : { name: 'TimeoutError' });
    const stopped = await f.store.read('session'),
      attempt = Object.values(stopped.attempts).find((a) => a.target === 'publish')!;
    expect(attempt).toMatchObject({ status: 'prepared', effect: 'none', output: null });
    expect(f.writes()).toBe(0);
    expect(context.signal.aborted).toBe(true);
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
    expect(f.writes()).toBe(0);
    f.host.preflight = async () => true;
    f.host.now = Date.now;
    const recovered = await f.engine().advance('session', 'alice');
    expect(recovered.attempts[attempt.id]).toMatchObject({
      status: 'observed',
      effect: 'none',
      error: 'not-dispatched',
    });
    expect(recovered.runs['root']!.wait).toMatchObject({ reason: 'operation-error', objectIds: [attempt.id] });
    await f.engine().retry('session', 'alice', attempt.id, 'safe-retry');
    const retried = await f.engine().advance('session', 'alice', { maxActions: 1 });
    expect(f.writes()).toBe(1);
    expect(
      new Set(
        Object.values(retried.attempts)
          .filter((a) => a.target === 'publish')
          .map((a) => a.invocationId),
      ).size,
    ).toBe(1);
  },
);

it.each(['caller', 'deadline'] as const)(
  'bounds a hung reconciliation preflight by %s and keeps the effect unknown',
  async (bound) => {
    const f = fixture(),
      { action } = await accepted(f);
    scripted(f, () => action);
    let lookups = 0;
    f.host.operations = {
      ...f.host.operations,
      publish: {
        id: 'publish',
        execute: async () => {
          throw new Error('Uncertain write');
        },
        reconcile: async () => {
          lookups++;
          return { status: 'absent', output: null };
        },
      },
    };
    const dispatched = await f.engine().advance('session', 'alice', { maxActions: 4 }),
      attempt = Object.values(dispatched.attempts).find((a) => a.target === 'publish')!;
    expect(attempt.effect).toBe('unknown');
    let enter!: () => void, finish!: (value: boolean) => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      pending = new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
      control = new AbortController();
    f.host.preflight = async () => {
      enter();
      return pending;
    };
    if (bound === 'deadline') f.host.now = () => f.grant.expiresAt - 25;
    const work = f.engine().advance('session', 'alice', { signal: control.signal });
    await entered;
    if (bound === 'caller') control.abort(new Error('reconcile-stop'));
    let timer!: ReturnType<typeof setTimeout>;
    const stopped = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reconciliation preflight kept scheduler blocked')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(stopped.runs['root']!.wait!.reason).toBe('reconciliation-unavailable');
    expect(stopped.attempts[attempt.id]!.effect).toBe('unknown');
    expect(lookups).toBe(0);
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
    expect(lookups).toBe(0);
    f.host.preflight = async () => true;
    f.host.now = Date.now;
    const reconciled = await f.engine().advance('session', 'alice');
    expect(reconciled.attempts[attempt.id]).toMatchObject({ effect: 'none', error: 'reconciled-absent' });
    expect(lookups).toBe(1);
  },
);
