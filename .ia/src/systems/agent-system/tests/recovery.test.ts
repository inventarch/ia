import { expect, it } from 'vitest';
import { digest, memoryStore } from '@ia/session-system';
import type { Session } from '@ia/session-system';
import { Engine, manifestDigest } from '../src/index.js';
import type {
  EngineHost,
  Grant,
  Manifest,
  ModelAction,
  ModelResponse,
  OperationContext,
  OperationResult,
  Profile,
} from '../src/index.js';

const answer: ModelAction = { type: 'outcome', kind: 'answer', message: 'Done', continuation: 'finish' };
const response = (action: ModelAction): ModelResponse => ({ action, model: 'test', provider: 'test', usage: 7 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(actions: ModelAction[] = [answer]) {
  const profile = (id: string): Profile => ({
    id,
    agent: id,
    role: id,
    voice: '',
    instructions: [],
    operations: ['read'],
    capabilities: [],
    delegates: id === 'root' ? ['child'] : [],
    outcomes: ['answer', 'clarification'],
    completion: 'response',
    checks: [],
    model: 'test',
    contract: {
      id: 'test',
      mandateContracts: [],
      inputContracts: [{ id: 'text', schema: { type: 'string' } }],
      effects: ['read'],
      limits: {},
      delegation: id === 'root' ? [{ profile: 'child', limits: {} }] : [],
      checks: [],
      completionEvaluator: 'ia.completion.v1',
      repairAttempts: 1,
      maxAttempts: 2,
    },
  });
  const body: Omit<Manifest, 'digest'> = {
    version: 1,
    id: 'test',
    workspace: 'w',
    sourceDigest: 'source',
    profiles: { root: profile('root'), child: profile('child') },
    operations: {
      read: {
        id: 'read',
        handler: 'read',
        digest: digest('read'),
        input: { type: 'string' },
        output: { type: 'string' },
        timeoutMs: 25,
        recovery: 'repeatable',
        effects: ['read'],
      },
    },
    reactions: [],
    provenance: {},
  };
  const manifest = { ...body, digest: manifestDigest(body) },
    store = memoryStore();
  const grant: Grant = {
    id: 'grant',
    principal: 'alice',
    workspace: 'w',
    profiles: ['root', 'child'],
    operations: ['read'],
    effects: ['read'],
    sources: ['source'],
    models: ['test'],
    expiresAt: Date.now() + 60000,
    limits: {
      steps: 30,
      modelCalls: 10,
      operations: 10,
      children: 2,
      depth: 2,
      tokens: 500000,
      bytes: 4000000,
      deadline: Date.now() + 60000,
    },
  };
  let calls = 0,
    reads = 0;
  const host: EngineHost = {
    store,
    model: {
      id: 'test',
      generate: async () => {
        calls++;
        return response(actions.shift()!);
      },
    },
    operations: {
      read: {
        id: 'read',
        execute: async () => {
          reads++;
          return { output: 'source', effect: 'none' };
        },
      },
    },
    authorize: async () => grant,
    verifyManifest: async () => true,
    context: async () => null,
    evaluate: async () => ({ status: 'pass', evidence: [], message: 'pass' }),
  };
  const engine = () => new Engine(manifest, host);
  const start = () =>
    engine().start({ sessionId: 'session', commandId: 'start', principal: 'alice', profile: 'root', task: 'Inspect' });
  return { engine, start, host, grant, manifest, store, calls: () => calls, reads: () => reads };
}
const invalid: { name: string; action: ModelAction; code: string }[] = [
  {
    name: 'operation input',
    action: { type: 'invoke', operation: 'read', input: 123 },
    code: 'IA-ENGINE-INPUT-INVALID',
  },
  {
    name: 'unknown operation',
    action: { type: 'invoke', operation: 'invented', input: 'x' },
    code: 'IA-ENGINE-ACTION-INVALID',
  },
  { name: 'evidence', action: { ...answer, evidence: ['fabricated'] }, code: 'IA-ENGINE-EVIDENCE-INVALID' },
  {
    name: 'delegation target',
    action: { type: 'delegate', profile: 'invented', task: 'Inspect' },
    code: 'IA-ENGINE-DELEGATION-DENIED',
  },
  {
    name: 'delegation input',
    action: { type: 'delegate', profile: 'child', task: 123 },
    code: 'IA-ENGINE-TASK-INVALID',
  },
  { name: 'outcome', action: { ...answer, kind: 'deliverable' }, code: 'IA-ENGINE-OUTCOME-DENIED' },
];
it.each(invalid)(
  'repairs $name durably and continues with a valid response after restart',
  async ({ action, code }) => {
    const f = fixture([action, answer]);
    await f.start();
    // Reproduce the audited restart boundary: shape-valid action already accepted.
    const accepted = await f.engine().advance('session', 'alice', { maxActions: 3 });
    expect(accepted.runs['root']!.pendingAction).toEqual(action);
    const waiting = await f.engine().advance('session', 'alice'),
      run = waiting.runs['root']!;
    expect(run).toMatchObject({
      status: 'waiting',
      pendingAction: null,
      wait: { reason: 'invalid-model-action', continuation: 'repair', details: { code } },
    });
    expect(waiting.budget).toMatchObject({ usedTokens: 7, modelCalls: 1, steps: 1, operations: 0, children: 0 });
    expect((await f.engine().advance('session', 'alice')).sequence).toBe(waiting.sequence);
    const attempt = run.wait!.objectIds[0]!;
    await f.engine().retry('session', 'alice', attempt, 'repair');
    await f.engine().retry('session', 'alice', attempt, 'repair');
    const done = await f.engine().advance('session', 'alice');
    expect(done.runs['root']).toMatchObject({ status: 'completed', pendingAction: null, repairs: 1 });
    expect(done.runs['root']!.transcript.find((row) => (row as { kind?: string }).kind === 'repair')).toMatchObject({
      details: { code },
    });
    expect(done.budget).toMatchObject({ usedTokens: 14, reservedTokens: 0, modelCalls: 2, steps: 2 });
    expect(done.receipts).toHaveLength(2);
    expect(f.calls()).toBe(2);
    expect(f.reads()).toBe(0);
  },
);
it('exhausts a run repair allowance without resurrecting a rejected action or erasing usage', async () => {
  const f = fixture([invalid[0]!.action, invalid[0]!.action]);
  await f.start();
  const first = await f.engine().advance('session', 'alice');
  await f.engine().retry('session', 'alice', first.runs['root']!.wait!.objectIds[0]!, 'repair');
  const second = await f.engine().advance('session', 'alice');
  await expect(f.engine().retry('session', 'alice', second.runs['root']!.wait!.objectIds[0]!, 'again')).rejects.toThrow(
    'allowance',
  );
  expect((await f.store.read('session')).budget.usedTokens).toBe(14);
  expect(second.runs['root']!.pendingAction).toBeNull();
  expect(f.reads()).toBe(0);
});
it.each(['operation', 'delegate', 'source'] as const)(
  'keeps changed %s authority outside model repair',
  async (change) => {
    const f = fixture([
      change === 'delegate'
        ? { type: 'delegate', profile: 'child', task: 'Inspect' }
        : { type: 'invoke', operation: 'read', input: 'x' },
    ]);
    await f.start();
    await f.engine().advance('session', 'alice', { maxActions: 3 });
    if (change === 'operation') f.grant.operations = [];
    if (change === 'delegate') f.grant.profiles = ['root'];
    if (change === 'source') f.host.verifyManifest = async () => false;
    await expect(f.engine().advance('session', 'alice')).rejects.toMatchObject({
      code:
        change === 'source'
          ? 'IA-ENGINE-SOURCE-CHANGED'
          : change === 'delegate'
            ? 'IA-ENGINE-AUTHORITY-DENIED'
            : 'IA-ENGINE-OPERATION-DENIED',
    });
    const state = await f.store.read('session');
    expect(state.runs['root']!.wait).toBeNull();
    expect(state.runs['root']!.pendingAction).not.toBeNull();
    expect(state.budget.operations).toBe(0);
  },
);
// The watchdog makes a missing race fail promptly rather than hanging Vitest.
async function promptly(work: Promise<Session>): Promise<Session> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Adapter kept the scheduler blocked')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
it('bounds an uncooperative read, ignores its late success, and retries the same logical invocation', async () => {
  const f = fixture([{ type: 'invoke', operation: 'read', input: 'x' }, answer]),
    pending = deferred<OperationResult>();
  let context!: OperationContext;
  f.host.operations = {
    read: {
      id: 'read',
      execute: async (_input, ctx) => {
        context = ctx;
        return pending.promise;
      },
    },
  };
  await f.start();
  const stopped = await promptly(f.engine().advance('session', 'alice'));
  const attempt = Object.values(stopped.attempts).find((a) => a.kind === 'operation')!;
  expect(context.signal.aborted).toBe(true);
  expect(attempt).toMatchObject({
    status: 'observed',
    effect: 'none',
    output: null,
    error: 'operation-attempt-failed',
  });
  expect(stopped.runs['root']!.wait).toMatchObject({
    reason: 'operation-error',
    continuation: 'retry',
    objectIds: [attempt.id],
  });
  pending.resolve({ output: 'late', effect: 'none' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
  f.host.operations = { read: { id: 'read', execute: async () => ({ output: 'correct', effect: 'none' }) } };
  await f.engine().retry('session', 'alice', attempt.id, 'retry');
  const done = await f.engine().advance('session', 'alice');
  expect(done.runs['root']!.status).toBe('completed');
  expect(
    new Set(
      Object.values(done.attempts)
        .filter((a) => a.kind === 'operation')
        .map((a) => a.invocationId),
    ).size,
  ).toBe(1);
  expect(done.budget.operations).toBe(2);
});
it.each(['caller', 'deadline'] as const)(
  'bounds an uncooperative model by %s while conserving unknown usage and ignoring late output',
  async (bound) => {
    const f = fixture(),
      pending = deferred<ModelResponse>(),
      entered = deferred<void>(),
      control = new AbortController();
    let signal!: AbortSignal;
    f.host.model = {
      id: 'hung',
      generate: async (_request, received) => {
        signal = received;
        entered.resolve();
        return pending.promise;
      },
    };
    await f.start();
    // Host time leaves 25ms of authority, while persisted wall time stays valid.
    if (bound === 'deadline') f.host.now = () => f.grant.expiresAt - 25;
    const work = f.engine().advance('session', 'alice', { signal: control.signal });
    await entered.promise;
    if (bound === 'caller') control.abort(new Error('stop'));
    const stopped = await promptly(work),
      attempt = Object.values(stopped.attempts)[0]!;
    expect(signal.aborted).toBe(true);
    expect(stopped.runs['root']!.wait!.reason).toBe('model-error');
    expect(stopped.budget.usedTokens).toBe(attempt.reservation);
    expect(stopped.budget.reservedTokens).toBe(0);
    pending.resolve(response(answer));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
  },
);
it('does not admit adapter success after losing scheduler ownership', async () => {
  const f = fixture([{ type: 'invoke', operation: 'read', input: 'x' }]);
  f.host.operations = {
    read: {
      id: 'read',
      execute: async (_input, context) => {
        await f.store.release(context.owner!);
        return { output: 'stale', effect: 'none' };
      },
    },
  };
  await f.start();
  await expect(f.engine().advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-LOST' });
  const state = await f.store.read('session'),
    attempt = Object.values(state.attempts).find((a) => a.kind === 'operation')!;
  expect(attempt).toMatchObject({ status: 'dispatched', output: null });
  expect(state.receipts.some((r) => r.output === 'stale')).toBe(false);
  const recovered = await f.engine().advance('session', 'alice');
  expect(recovered.runs['root']!.wait!.reason).toBe('operation-error');
});

it.each(['caller', 'deadline'] as const)(
  'bounds host context by %s before reserving or dispatching a model and ignores late context',
  async (bound) => {
    const f = fixture(),
      pending = deferred<null>(),
      entered = deferred<void>(),
      control = new AbortController();
    f.host.context = async () => {
      entered.resolve();
      return pending.promise;
    };
    await f.start();
    if (bound === 'deadline') f.host.now = () => f.grant.expiresAt - 25;
    const work = f.engine().advance('session', 'alice', { signal: control.signal });
    await entered.promise;
    if (bound === 'caller') control.abort(new Error('context-stop'));
    await expect(promptly(work)).rejects.toMatchObject(
      bound === 'caller' ? { message: 'context-stop' } : { name: 'TimeoutError' },
    );
    const stopped = await f.store.read('session');
    expect(Object.values(stopped.attempts)).toHaveLength(0);
    expect(stopped.budget.modelCalls).toBe(0);
    expect(stopped.budget.reservedTokens).toBe(0);
    expect(f.calls()).toBe(0);
    pending.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
    expect(f.calls()).toBe(0);
    f.host.context = async () => null;
    f.host.now = Date.now;
    expect((await f.engine().advance('session', 'alice')).runs['root']!.status).toBe('completed');
    expect(f.calls()).toBe(1);
  },
);

it.each(['verifyManifest', 'authorize'] as const)(
  'bounds a hung host %s callback by caller cancellation without late continuation',
  async (callback) => {
    const f = fixture(),
      pending = deferred<void>(),
      entered = deferred<void>(),
      control = new AbortController();
    await f.start();
    const verify = f.host.verifyManifest,
      authorize = f.host.authorize;
    let authorizations = 0;
    f.host.authorize = async () => {
      authorizations++;
      if (callback === 'authorize') {
        entered.resolve();
        await pending.promise;
      }
      return f.grant;
    };
    if (callback === 'verifyManifest')
      f.host.verifyManifest = async () => {
        entered.resolve();
        await pending.promise;
        return true;
      };
    const work = f.engine().advance('session', 'alice', { signal: control.signal });
    await entered.promise;
    control.abort(new Error('authority-stop'));
    await expect(promptly(work)).rejects.toThrow('authority-stop');
    const stopped = await f.store.read('session');
    expect(Object.values(stopped.attempts)).toHaveLength(0);
    expect(f.calls()).toBe(0);
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
    expect(f.calls()).toBe(0);
    expect(authorizations).toBe(callback === 'authorize' ? 1 : 0);
    f.host.verifyManifest = verify;
    f.host.authorize = authorize;
    expect((await f.engine().advance('session', 'alice')).runs['root']!.status).toBe('completed');
  },
);

it.each(['before-effect', 'completion'] as const)(
  'bounds a hung %s evaluator by the persisted deadline and ignores late permission',
  async (phase) => {
    const f = fixture(phase === 'before-effect' ? [{ type: 'invoke', operation: 'read', input: 'x' }] : [answer]),
      pending = deferred<void>(),
      entered = deferred<void>();
    f.manifest.profiles['root']!.contract!.checks = [{ id: 'check', phases: [phase] }];
    f.manifest.digest = manifestDigest(f.manifest);
    f.host.evaluate = async () => {
      entered.resolve();
      await pending.promise;
      return { status: 'pass', evidence: [], message: 'late' };
    };
    await f.start();
    f.host.now = () => f.grant.expiresAt - 25;
    const work = f.engine().advance('session', 'alice');
    await entered.promise;
    await expect(promptly(work)).rejects.toMatchObject({ name: 'TimeoutError' });
    const stopped = await f.store.read('session');
    expect(stopped.runs['root']!.status).not.toBe('completed');
    expect(f.reads()).toBe(0);
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
    expect(f.reads()).toBe(0);
  },
);

it.each(['preflight', 'adapter', 'owner-validation'] as const)(
  'propagates a freshly narrowed grant expiry through %s and rejects late success',
  async (stage) => {
    const f = fixture([{ type: 'invoke', operation: 'read', input: 'x' }, answer]);
    f.manifest.operations['read']!.timeoutMs = 500;
    f.manifest.digest = manifestDigest(f.manifest);
    f.host.authorize = async (_principal, _manifest, state) =>
      state &&
      Object.values(state.attempts).some((attempt) => attempt.kind === 'operation' && attempt.status === 'dispatched')
        ? { ...f.grant, expiresAt: Date.now() + 20 }
        : f.grant;
    let slowValidation = false;
    const validate = f.store.validate.bind(f.store),
      delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    f.store.validate = async (owner) => {
      if (slowValidation) {
        slowValidation = false;
        await delay(60);
      }
      await validate(owner);
    };
    f.host.preflight = async () => {
      if (stage === 'preflight') await delay(60);
      if (stage === 'owner-validation') slowValidation = true;
      return true;
    };
    let context!: OperationContext;
    f.host.operations = {
      read: {
        id: 'read',
        execute: async (_input, received) => {
          context = received;
          await context.assertCurrent!();
          if (stage === 'adapter') await delay(60);
          return { effect: 'none', output: 'must-not-be-admitted' };
        },
      },
    };
    await f.start();
    const stopped = await promptly(f.engine().advance('session', 'alice'));
    const attempt = Object.values(stopped.attempts).find((entry) => entry.kind === 'operation')!;
    expect(attempt).toMatchObject({
      status: 'observed',
      effect: 'none',
      error: 'operation-attempt-failed',
      output: null,
    });
    expect(context.signal.aborted).toBe(true);
    expect(stopped.runs['root']!.wait!.reason).toBe('operation-error');
    expect(f.calls()).toBe(1);
    await delay(70);
    expect((await f.store.read('session')).sequence).toBe(stopped.sequence);
  },
);
