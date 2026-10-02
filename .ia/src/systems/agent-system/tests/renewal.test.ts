import { copy, digest, JournalStore, MemoryBackend, replay } from '@ia/session-system';
import type { Mutation } from '@ia/session-system';
import { expect, it } from 'vitest';
import { Engine, manifestDigest } from '../src/engine.js';
import type { EngineHost, Grant, Manifest, ModelAction, Profile } from '../src/types.js';

const question: ModelAction = {
  type: 'outcome',
  kind: 'clarification',
  message: 'Choose',
  continuation: 'await-input',
  questions: [{ prompt: 'Which?', choices: ['yes'], required: true }],
};
const proposal: ModelAction = {
  type: 'outcome',
  kind: 'proposal',
  message: 'Review',
  continuation: 'await-review',
  proposal: { text: 'Candidate' },
};
const answer: ModelAction = { type: 'outcome', kind: 'answer', message: 'Done', continuation: 'finish' };
function fixture(actions: ModelAction[] = [question, answer]) {
  let now = Date.now(),
    calls = 0,
    allowed = true,
    source = true;
  const startTime = now,
    backend = new MemoryBackend(),
    store = new JournalStore(backend, () => new Date(now).toISOString());
  const profile = (id: string, durationMs: number): Profile => ({
    id,
    agent: id,
    role: id,
    voice: '',
    instructions: [],
    operations: [],
    capabilities: [],
    delegates: id === 'root' ? ['child'] : [],
    outcomes: ['clarification', 'proposal', 'answer'],
    completion: 'response',
    checks: [],
    model: 'test',
    contract: {
      id,
      mandateContracts: [],
      inputContracts: [{ id: 'task', schema: { type: 'string' } }],
      effects: ['read'],
      limits: { durationMs },
      delegation: id === 'root' ? [{ profile: 'child', limits: { durationMs: 120 } }] : [],
      checks: [],
      completionEvaluator: 'ia.completion.v1',
      repairAttempts: 1,
      maxAttempts: 2,
    },
  });
  const body: Omit<Manifest, 'digest'> = {
    version: 1,
    id: 'renewal',
    workspace: 'workspace',
    sourceDigest: digest('source'),
    profiles: { root: profile('root', 500), child: profile('child', 150) },
    operations: {},
    reactions: [],
    provenance: {},
  };
  const manifest: Manifest = { ...body, digest: manifestDigest(body) };
  const grant = (deadline: number): Grant => ({
    id: 'current',
    principal: 'alice',
    workspace: 'workspace',
    expiresAt: deadline,
    profiles: ['root', 'child'],
    operations: [],
    effects: ['read'],
    sources: [manifest.sourceDigest],
    models: ['test'],
    limits: {
      deadline,
      steps: 30,
      modelCalls: 10,
      operations: 0,
      tokens: 100000,
      bytes: 2000000,
      children: 2,
      depth: 2,
    },
  });
  const host: EngineHost = {
    store,
    now: () => now,
    model: {
      id: 'model',
      generate: async () => {
        calls++;
        return { action: actions.shift() ?? answer, model: 'test', provider: 'test', usage: 10 };
      },
    },
    operations: {},
    authorize: async (_actor, _manifest, state) => grant(state?.limits.deadline ?? now + 100),
    authorizeRenewal: async () => {
      if (!allowed) throw new Error('Current membership revoked');
      return grant(now + 1000);
    },
    verifyManifest: async () => source,
    context: async () => null,
    evaluate: async () => ({ status: 'pass', message: 'pass', evidence: [] }),
  };
  const engine = () => new Engine(manifest, host);
  const start = async () => {
    await engine().start({
      sessionId: 'session',
      commandId: 'start',
      principal: 'alice',
      profile: 'root',
      task: 'Inspect',
    });
    return engine().advance('session', 'alice');
  };
  const mutate = async (mutation: Mutation) => {
    const state = await store.read('session'),
      owner = await store.acquire('session');
    try {
      await store.command(
        { id: `change-${state.sequence}`, sessionId: 'session', actor: 'alice', expected: state.sequence, mutation },
        owner,
      );
    } finally {
      await store.release(owner);
    }
  };
  return {
    engine,
    host,
    store,
    backend,
    manifest,
    start,
    mutate,
    grant,
    calls: () => calls,
    now: () => now,
    expire: () => {
      now = startTime + 200;
    },
    tick: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    sourceChanged: () => {
      source = false;
    },
  };
}

it.each([question, proposal])(
  'renews expired $kind waits once and completes through the exact retained human control',
  async (action) => {
    const f = fixture([action, answer]),
      before = await f.start();
    f.expire();
    const offer = await f.engine().renewal('session', 'alice');
    expect(offer.deadline).toBe(f.now() + 500);
    const request = { commandId: 'renew', expectedSequence: before.sequence, deadline: offer.deadline };
    const renewed = await f.engine().renew('session', 'alice', request);
    expect((await f.engine().renew('session', 'alice', request)).sequence).toBe(renewed.sequence);
    const { retainedBytes: _beforeBytes, ...usage } = before.budget;
    expect(renewed.budget).toMatchObject(usage);
    expect(renewed.budget.retainedBytes).toBeGreaterThan(before.budget.retainedBytes);
    expect(renewed.attempts).toEqual(before.attempts);
    expect(renewed.receipts).toEqual(before.receipts);
    expect(renewed.questions).toEqual(before.questions);
    expect(renewed.proposals).toEqual(before.proposals);
    expect(renewed.runs['root']!.limits?.deadline).toBe(offer.deadline);
    expect(f.calls()).toBe(1);
    const events = (await f.store.journal('session')).events;
    expect(events.at(-1)).toMatchObject({ version: 2, mutation: { type: 'session.renew' } });
    expect(events.slice(0, -1).every((event) => event.version === 1)).toBe(true);
    expect(replay(events)).toEqual(renewed);
    if (action === question) {
      const q = Object.values(renewed.questions)[0]!;
      await f.engine().reply('session', 'alice', q.id, q.revision, q.digest, 'yes', 'reply');
    } else {
      const p = Object.values(renewed.proposals)[0]!;
      await f
        .engine()
        .review('session', 'alice', p.id, p.revision, p.digest, true, 'Accepted exact candidate', 'review');
    }
    const completed = await f.engine().advance('session', 'alice');
    expect(completed.runs['root']!.status).toBe('completed');
    expect(f.calls()).toBe(2);
  },
);

it.each([question, proposal])(
  'preserves answered $kind wait and renewal eligibility when advance runs after expiry',
  async (action) => {
    const f = fixture([action, answer]),
      waiting = await f.start();
    if (action === question) {
      const q = Object.values(waiting.questions)[0]!;
      await f.engine().reply('session', 'alice', q.id, q.revision, q.digest, 'yes', 'reply-before-expiry');
    } else {
      const p = Object.values(waiting.proposals)[0]!;
      await f
        .engine()
        .review('session', 'alice', p.id, p.revision, p.digest, true, 'Reviewed while current', 'review-before-expiry');
    }
    const answered = await f.store.read('session');
    f.expire();
    await expect(f.engine().advance('session', 'alice')).rejects.toThrow();
    expect((await f.store.read('session')).sequence).toBe(answered.sequence);
    expect((await f.store.read('session')).runs['root']?.status).toBe('waiting');
    const offer = await f.engine().renewal('session', 'alice');
    await f.engine().renew('session', 'alice', {
      commandId: 'renew-after-failed-poll',
      expectedSequence: answered.sequence,
      deadline: offer.deadline,
    });
    expect((await f.engine().advance('session', 'alice')).runs['root']?.status).toBe('completed');
    expect(f.calls()).toBe(2);
  },
);

it('renews child human waits and their ancestors within all delegation time ceilings', async () => {
  const f = fixture([{ type: 'delegate', profile: 'child', task: 'Inspect child' }, question, answer, answer]);
  const before = await f.start();
  f.expire();
  const offer = await f.engine().renewal('session', 'alice');
  const renewed = await f
    .engine()
    .renew('session', 'alice', { commandId: 'renew', expectedSequence: before.sequence, deadline: offer.deadline });
  const child = Object.values(renewed.runs).find((run) => run.parentId)!;
  expect(renewed.limits.deadline).toBe(f.now() + 500);
  expect(child.limits?.deadline).toBe(f.now() + 120);
  const q = Object.values(renewed.questions)[0]!;
  await f.engine().reply('session', 'alice', q.id, q.revision, q.digest, 'yes', 'reply');
  expect((await f.engine().advance('session', 'alice')).runs['root']!.status).toBe('completed');
});

it.each(['creator', 'sequence', 'deadline', 'source', 'grant', 'capability'] as const)(
  'refuses invalid %s renewal without mutation or inference',
  async (changed) => {
    const f = fixture(),
      before = await f.start();
    f.expire();
    const request = { commandId: 'renew', expectedSequence: before.sequence, deadline: f.now() + 400 };
    if (changed === 'sequence') request.expectedSequence--;
    if (changed === 'deadline') request.deadline = f.now() + 1001;
    if (changed === 'source') f.sourceChanged();
    if (changed === 'grant') f.revoke();
    if (changed === 'capability') delete f.host.authorizeRenewal;
    await expect(f.engine().renew('session', changed === 'creator' ? 'bob' : 'alice', request)).rejects.toThrow();
    expect(await f.store.read('session')).toEqual(before);
    expect(f.calls()).toBe(1);
  },
);

it.each([
  'control',
  'pending-action',
  'runnable',
  'effect-review',
  'unknown',
  'numeric-budget',
  'token-budget',
  'byte-budget',
] as const)('refuses unsupported %s renewal', async (changed) => {
  const f = fixture(),
    before = await f.start();
  if (changed === 'control')
    await f.mutate({
      type: 'control.submit',
      control: { id: 'pause', actor: 'alice', runId: 'root', kind: 'pause', applied: false },
    });
  else if (changed === 'runnable')
    await f.mutate({
      type: 'run.wait',
      runId: 'root',
      wait: { id: 'other', reason: 'model-error', objectIds: [], continuation: 'retry', details: null },
    });
  else {
    const read = f.host.store.read.bind(f.host.store);
    f.host.store.read = async (id) => {
      const state = copy(await read(id));
      if (changed === 'pending-action') state.runs['root']!.pendingAction = question as never;
      if (changed === 'unknown') Object.values(state.attempts)[0]!.effect = 'unknown';
      if (changed === 'numeric-budget') state.budget.modelCalls = state.limits.modelCalls;
      if (changed === 'token-budget') state.budget.usedTokens = state.limits.tokens - 1000;
      if (changed === 'byte-budget') state.budget.retainedBytes = state.limits.bytes;
      if (changed === 'effect-review') {
        state.runs['root']!.wait = {
          id: 'review',
          reason: 'review',
          objectIds: ['proposal'],
          continuation: 'continue',
          details: null,
        };
        state.proposals['proposal'] = {
          id: 'proposal',
          runId: 'root',
          revision: 1,
          digest: digest('candidate'),
          candidate: 'candidate',
          status: 'offered',
          decisionId: null,
          review: {
            reviewer: 'alice',
            rule: 'operator-exact-candidate-v1',
            expiresAt: f.now() - 1,
            operation: 'write',
            bindingDigest: digest('write'),
            inputDigest: digest('input'),
            candidateDigest: digest('candidate'),
            artifactDigest: digest('artifact'),
            destination: 'destination',
            effect: 'local-write',
            validationReceipt: 'validation',
          },
        };
      }
      return state;
    };
  }
  f.expire();
  await expect(f.engine().renewal('session', 'alice')).rejects.toThrow();
  expect((await f.store.journal('session')).events.at(-1)?.mutation.type).not.toBe('session.renew');
  expect(f.calls()).toBe(1);
  expect(before.receipts).toHaveLength(1);
});

it('bounds uncooperative renewal authority and refuses a late grant after cancellation', async () => {
  const f = fixture(),
    before = await f.start();
  f.expire();
  let finish!: (grant: Grant) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.host.authorizeRenewal = async () => {
    entered();
    return new Promise<Grant>((resolve) => {
      finish = resolve;
    });
  };
  const abort = new AbortController();
  const work = f.engine().renew('session', 'alice', {
    commandId: 'renew',
    expectedSequence: before.sequence,
    deadline: f.now() + 400,
    signal: abort.signal,
  });
  await started;
  abort.abort(new Error('Stopped'));
  await expect(work).rejects.toThrow('Stopped');
  finish(f.grant(f.now() + 1000));
  await Promise.resolve();
  expect(await f.store.read('session')).toEqual(before);
  const owner = await f.store.acquire('session');
  await f.store.release(owner);
});

it('refuses binding changes during renewal grant lookup before appending any event', async () => {
  const f = fixture(),
    before = await f.start();
  f.expire();
  f.host.authorizeRenewal = async () => {
    f.sourceChanged();
    return f.grant(f.now() + 1000);
  };
  await expect(
    f
      .engine()
      .renew('session', 'alice', { commandId: 'renew', expectedSequence: before.sequence, deadline: f.now() + 400 }),
  ).rejects.toMatchObject({ code: 'IA-ENGINE-SOURCE-CHANGED' });
  expect(await f.store.read('session')).toEqual(before);
});
