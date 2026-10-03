import { expect, it } from 'vitest';
import { canonical, digest, JournalStore, MemoryBackend } from '@inventarch/session-system';
import type { Mutation, SessionStore } from '@inventarch/session-system';
import { Engine, manifestDigest } from '../src/index.js';
import type { EngineHost, Grant, Manifest, ModelAction, ModelAdapter, Profile } from '../src/index.js';

const profile = (id: string): Profile => ({
  id,
  agent: `${id}-agent`,
  role: id,
  voice: 'plain',
  instructions: ['Read scoped evidence and produce a proposal.'],
  operations: ['read'],
  capabilities: ['inspect'],
  delegates: id === 'author' ? ['architect'] : [],
  outcomes: ['answer', 'proposal', 'clarification', 'failure'],
  completion: 'response',
  checks: [],
  model: 'test/model',
});
function fixture(model?: ModelAdapter, backend = new MemoryBackend()) {
  const body: Omit<Manifest, 'digest'> = {
    version: 1,
    id: 'test',
    workspace: 'project',
    sourceDigest: 'capture',
    profiles: { author: profile('author'), architect: profile('architect') },
    operations: {
      read: {
        id: 'read',
        handler: 'read.v1',
        digest: digest('read.v1'),
        effects: ['read'],
        recovery: 'repeatable',
        timeoutMs: 1000,
        input: { type: 'string' },
        output: { type: 'string' },
      },
    },
    reactions: [],
    provenance: {},
  };
  const manifest: Manifest = { ...body, digest: manifestDigest(body) },
    store = new JournalStore(backend);
  const grant: Grant = {
    id: 'grant',
    principal: 'alice',
    workspace: 'project',
    profiles: ['author', 'architect'],
    operations: ['read'],
    effects: ['read'],
    sources: ['capture'],
    models: ['test/model'],
    expiresAt: Date.now() + 60_000,
    limits: {
      steps: 100,
      modelCalls: 20,
      operations: 20,
      tokens: 500_000,
      children: 4,
      depth: 2,
      bytes: 4_000_000,
      deadline: Date.now() + 60_000,
    },
  };
  let reads = 0;
  const host: EngineHost = {
    store,
    model: model ?? { id: 'external.v1', generate: async () => ({ deferred: true }) },
    operations: {
      'read.v1': {
        id: 'read.v1',
        execute: async () => {
          reads++;
          return { output: 'Pinned source content', effect: 'none' };
        },
      },
    },
    authorize: async () => grant,
    context: async () => ({ sources: ['capture'] }),
    verifyManifest: async () => true,
    evaluate: async () => ({ status: 'pass', evidence: [], message: 'pass' }),
  };
  return { engine: new Engine(manifest, host), host, manifest, store, grant, reads: () => reads };
}
const start = async (engine: Engine) =>
  engine.start({
    sessionId: 'session',
    commandId: 'start',
    principal: 'alice',
    profile: 'author',
    task: 'Inspect personal guidance',
  });
const outcome: ModelAction = {
  type: 'outcome',
  kind: 'answer',
  message: 'Inspected the source.',
  continuation: 'finish',
};
const scripted = (actions: ModelAction[]): ModelAdapter => ({
  id: 'scripted.v1',
  generate: async () => ({ action: actions.shift()!, model: 'test/model', provider: 'scripted', usage: 20 }),
});
async function mutation(store: SessionStore, value: Mutation): Promise<void> {
  const state = await store.read('session');
  await store.command({
    id: `control-${state.sequence}`,
    sessionId: 'session',
    actor: 'alice',
    expected: state.sequence,
    mutation: value,
  });
}
it('executes one admitted read and completes with exact receipts and usage', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'personal:conventions' }, outcome]));
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.status).toBe('completed');
  expect(f.reads()).toBe(1);
  expect(state.receipts).toHaveLength(3);
  expect(state.budget.usedTokens).toBe(40);
  expect(state.budget.reservedTokens).toBe(0);
  await f.engine.advance('session', 'alice');
  expect(f.reads()).toBe(1);
});

it('gives context generation the remaining complete request allowance while preserving operation history', async () => {
  const actions: ModelAction[] = [
      { type: 'invoke', operation: 'read', input: 'first' },
      { type: 'invoke', operation: 'read', input: 'second' },
      outcome,
    ],
    budgets: number[] = [],
    sizes: number[] = [];
  const f = fixture({
    id: 'budgeted',
    generate: async (request) => {
      sizes.push(Buffer.byteLength(canonical(request)));
      if (sizes.length > 1) expect(canonical(request.history)).toContain('retained-evidence');
      return { action: actions.shift()!, model: 'test/model', provider: 'scripted', usage: 20 };
    },
  });
  f.host.operations = {
    'read.v1': {
      id: 'read.v1',
      execute: async () => ({ output: 'retained-evidence' + 'x'.repeat(30_000), effect: 'none' }),
    },
  };
  f.host.context = async (_profile, _task, _grant, budget?: { bytes: number }) => {
    expect(budget).toBeDefined();
    budgets.push(budget!.bytes);
    return 'c'.repeat(Math.min(90_000, budget!.bytes - 2));
  };
  try {
    await start(f.engine);
    const state = await f.engine.advance('session', 'alice');
    expect(state.runs['root']!.status).toBe('completed');
    expect(sizes).toHaveLength(3);
    expect(sizes.every((bytes) => bytes <= 131_072)).toBe(true);
    expect(budgets[2]).toBeLessThan(budgets[1]!);
    expect(budgets[1]).toBeLessThan(budgets[0]!);
    expect(state.receipts.filter((receipt) => receipt.target === 'read')).toHaveLength(2);
  } finally {
    await f.store.close();
  }
});

it.each(
  [undefined, 131_072, 262_144].flatMap((requestBytes) =>
    [false, true].map((overflow) => ({ requestBytes, overflow })),
  ),
)(
  'measures escaped context at the exact request boundary ($requestBytes, overflow $overflow)',
  async ({ requestBytes, overflow }) => {
    let calls = 0;
    const f = fixture({
      id: 'boundary',
      generate: async (request) => {
        calls++;
        expect(Buffer.byteLength(canonical(request))).toBe(requestBytes ?? 131_072);
        return { action: outcome, model: 'test/model', provider: 'scripted', usage: 20 };
      },
    });
    if (requestBytes !== undefined) {
      f.manifest.profiles['author']!.contract = requestContract(requestBytes);
      f.manifest.digest = manifestDigest(f.manifest);
      f.engine = new Engine(f.manifest, f.host);
    }
    f.host.context = async (_profile, _task, _grant, budget) => {
      expect(Object.isFrozen(budget)).toBe(true);
      const available = budget!.bytes - 2;
      return '\\'.repeat(Math.floor(available / 2)) + (available % 2 ? 'x' : '') + (overflow ? 'x' : '');
    };
    try {
      await f.engine.start({
        sessionId: 'session',
        commandId: 'start',
        principal: 'alice',
        profile: 'author',
        task: '\n"\\界😀'.repeat(100),
      });
      if (overflow) {
        await expect(f.engine.advance('session', 'alice')).rejects.toMatchObject({
          code: 'IA-ENGINE-CONTEXT-TOO-LARGE',
        });
        expect(calls).toBe(0);
      } else {
        expect((await f.engine.advance('session', 'alice')).runs['root']!.status).toBe('completed');
        expect(calls).toBe(1);
      }
    } finally {
      await f.store.close();
    }
  },
);

function requestContract(requestBytes: number): NonNullable<Profile['contract']> {
  return {
    id: digest('request-contract'),
    mandateContracts: [],
    inputContracts: [],
    effects: ['read'],
    limits: {},
    delegation: [],
    checks: [],
    completionEvaluator: 'ia.completion.v1',
    repairAttempts: 1,
    maxAttempts: 2,
    requestBytes,
  };
}
it.each([0, -1, 1.5, 262_145, Number.MAX_SAFE_INTEGER, null, NaN, Infinity])(
  'refuses invalid installed request ceiling %s before host/model work',
  (requestBytes) => {
    const f = fixture();
    expect(() => {
      f.manifest.profiles['author']!.contract = requestContract(requestBytes as number);
      f.manifest.digest = manifestDigest(f.manifest);
      return new Engine(f.manifest, f.host);
    }).toThrow();
  },
);
it('retains full large history and exact unknown-usage accounting across reopen under the explicit request contract', async () => {
  const requests: number[] = [],
    histories: string[] = [],
    actions: ModelAction[] = [
      { type: 'invoke', operation: 'read', input: 'a'.repeat(20_000) },
      { type: 'invoke', operation: 'read', input: 'b'.repeat(20_000) },
      outcome,
    ];
  const f = fixture({
    id: 'large-assessment',
    generate: async (request) => {
      requests.push(Buffer.byteLength(canonical(request)) + request.maxOutputTokens);
      histories.push(canonical(request.history));
      return { action: actions.shift()!, model: 'test/model', provider: 'scripted', usage: null };
    },
  });
  f.manifest.profiles['author']!.contract = requestContract(262_144);
  f.manifest.digest = manifestDigest(f.manifest);
  f.engine = new Engine(f.manifest, f.host);
  f.host.operations = {
    'read.v1': {
      id: 'read.v1',
      execute: async () => ({ output: 'retained-evidence' + 'x'.repeat(40_000), effect: 'none' }),
    },
  };
  try {
    await start(f.engine);
    await f.engine.advance('session', 'alice', { maxActions: 3 });
    const prior = await f.store.read('session'),
      transcript = canonical(prior.runs['root']!.transcript),
      used = prior.budget.usedTokens,
      manifest = prior.manifestDigest;
    const changed = structuredClone(f.manifest);
    changed.profiles['author']!.contract!.requestBytes = 131_072;
    changed.digest = manifestDigest(changed);
    await expect(new Engine(changed, f.host).advance('session', 'alice')).rejects.toMatchObject({
      code: 'IA-ENGINE-AUTHORITY-DENIED',
    });
    expect((await f.store.read('session')).budget.usedTokens).toBe(used);
    const result = await new Engine(f.manifest, f.host).advance('session', 'alice');
    expect(result.runs['root']!.status).toBe('completed');
    expect(result.manifestDigest).toBe(manifest);
    expect(canonical(result.runs['root']!.transcript).startsWith(transcript.slice(0, -1))).toBe(true);
    expect(requests.at(-1)!).toBeGreaterThan(131_072);
    expect(requests.at(-1)! - 2048).toBeLessThanOrEqual(262_144);
    expect(histories.at(-1)).toContain('a'.repeat(20_000));
    expect(histories.at(-1)).toContain('b'.repeat(20_000));
    expect(histories.at(-1)).toContain('retained-evidence' + 'x'.repeat(40_000));
    expect(result.budget.usedTokens).toBe(requests.reduce((sum, bytes) => sum + bytes, 0));
    expect(result.budget.reservedTokens).toBe(0);
    expect(result.limits.tokens).toBe(prior.limits.tokens);
  } finally {
    await f.store.close();
  }
});
it('refuses an oversized retained request wrapper before calling context or the model', async () => {
  let contexts = 0,
    models = 0;
  const f = fixture({
    id: 'unreached',
    generate: async () => {
      models++;
      throw new Error('Model must not be called');
    },
  });
  f.host.context = async () => {
    contexts++;
    return null;
  };
  try {
    await f.engine.start({
      sessionId: 'session',
      commandId: 'start',
      principal: 'alice',
      profile: 'author',
      task: 'x'.repeat(131_073),
    });
    await expect(f.engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-CONTEXT-TOO-LARGE' });
    expect(contexts).toBe(0);
    expect(models).toBe(0);
  } finally {
    await f.store.close();
  }
});
it('resumes a committed model response without a second model call', async () => {
  let calls = 0;
  const f = fixture({
    id: 'once',
    generate: async () => {
      calls++;
      return { action: outcome, usage: 20, model: 'test/model', provider: 'scripted' };
    },
  });
  await start(f.engine);
  await f.engine.advance('session', 'alice', { maxActions: 2 });
  expect(calls).toBe(1);
  const state = await new Engine(f.manifest, f.host).advance('session', 'alice');
  expect(calls).toBe(1);
  expect(state.runs['root']!.status).toBe('completed');
});
it('persists an IDE model handoff, authenticates reply, and deduplicates it across engine instances', async () => {
  const f = fixture();
  await start(f.engine);
  let state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.wait!.reason).toBe('external-model');
  const id = state.runs['root']!.wait!.objectIds[0]!;
  expect((await new Engine(f.manifest, f.host).advance('session', 'alice')).sequence).toBe(state.sequence);
  const response = { action: outcome, model: 'test/model', provider: 'ide', usage: null };
  await expect(f.engine.submitModel('session', 'mallory', id, response, 'reply')).rejects.toThrow();
  await f.engine.submitModel('session', 'alice', id, response, 'reply');
  await f.engine.submitModel('session', 'alice', id, response, 'reply');
  state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.status).toBe('completed');
  expect(state.receipts).toHaveLength(1);
  expect(state.budget.usedTokens).toBeGreaterThan(0);
});
it('keeps clarification independent from completion and resumes a bounded architect child', async () => {
  const f = fixture(
    scripted([
      {
        type: 'outcome',
        kind: 'clarification',
        message: 'Choose scope',
        continuation: 'await-input',
        questions: [{ prompt: 'Project or personal?', choices: ['project', 'personal'], required: true }],
      },
      { type: 'delegate', profile: 'architect', task: 'Review guidance' },
      outcome,
      {
        type: 'outcome',
        kind: 'proposal',
        message: 'Proposed record',
        continuation: 'finish',
        proposal: { text: 'draft' },
      },
    ]),
  );
  await start(f.engine);
  let state = await f.engine.advance('session', 'alice');
  const q = Object.values(state.questions)[0]!;
  expect(state.runs['root']!.status).toBe('waiting');
  await mutation(f.store, {
    type: 'question.reply',
    questionId: q.id,
    revision: q.revision,
    digest: q.digest,
    answer: 'personal',
  });
  state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.status).toBe('completed');
  expect(Object.values(state.runs).filter((r) => r.returned)).toHaveLength(1);
  expect(state.budget.children).toBe(1);
  expect(Object.values(state.proposals)).toHaveLength(1);
});
it('refuses a revoked operation before the adapter runs', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'source' }]));
  await start(f.engine);
  await f.engine.advance('session', 'alice', { maxActions: 3 });
  f.grant.operations = [];
  await expect(f.engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-OPERATION-DENIED' });
  expect(f.reads()).toBe(0);
});
it('does not dispatch after a required journal commit fails', async () => {
  const backend = new MemoryBackend(),
    commit = backend.commit.bind(backend);
  backend.commit = async (command, hash, events, owner) => {
    if (command.mutation.type === 'attempt.dispatch') throw new Error('disk full');
    return commit(command, hash, events, owner);
  };
  let calls = 0;
  const f = fixture(
    {
      id: 'never',
      generate: async () => {
        calls++;
        throw new Error('must not run');
      },
    },
    backend,
  );
  await start(f.engine);
  await expect(f.engine.advance('session', 'alice')).rejects.toThrow('disk full');
  expect(calls).toBe(0);
  expect(Object.values((await f.store.read('session')).attempts)[0]!.status).toBe('prepared');
});
it('refuses arbitrary model fields and never treats a claimed approval as authority', async () => {
  const f = fixture(
    scripted([{ type: 'invoke', operation: 'write', input: {}, approved: true } as unknown as ModelAction]),
  );
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.wait!.reason).toBe('invalid-model-action');
  expect(f.reads()).toBe(0);
});
it('cannot complete an artifact task with fabricated receipt IDs', async () => {
  const f = fixture(scripted([{ ...outcome, type: 'outcome', artifacts: ['invented'] } as ModelAction]));
  f.manifest.profiles['author']!.completion = 'artifact';
  f.manifest.digest = manifestDigest(f.manifest);
  const engine = new Engine(f.manifest, f.host);
  await engine.start({
    sessionId: 'session',
    commandId: 'start',
    principal: 'alice',
    profile: 'author',
    task: 'Artifact',
    artifact: { operation: 'read', destination: 'draft' },
  });
  expect((await engine.advance('session', 'alice')).runs['root']).toMatchObject({
    status: 'waiting',
    pendingAction: null,
    wait: { reason: 'invalid-model-action', details: { code: 'IA-ENGINE-COMPLETION-DENIED' } },
  });
});
it('refuses invented source citations even in a response-only profile', async () => {
  const f = fixture(scripted([{ ...outcome, evidence: ['invented-source@revision:path'] } as ModelAction]));
  await start(f.engine);
  expect((await f.engine.advance('session', 'alice')).runs['root']).toMatchObject({
    status: 'waiting',
    pendingAction: null,
    wait: { reason: 'invalid-model-action', details: { code: 'IA-ENGINE-EVIDENCE-INVALID' } },
  });
});
it('records a model error and conservatively charges the unresolved provider usage', async () => {
  const f = fixture({
    id: 'failed-provider',
    generate: async () => {
      throw new Error('provider unavailable');
    },
  });
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice');
  expect(state.runs['root']!.wait!.reason).toBe('model-error');
  expect(state.budget.usedTokens).toBeGreaterThan(0);
  expect(state.budget.reservedTokens).toBe(0);
  expect(state.receipts[0]!.error).toBe('model-attempt-failed');
});
it('pauses an external-model wait and resumes with a fresh durable request', async () => {
  const f = fixture();
  await start(f.engine);
  const first = await f.engine.advance('session', 'alice');
  const attempt = first.runs['root']!.wait!.objectIds[0]!;
  await mutation(f.store, {
    type: 'control.submit',
    control: { id: 'pause', actor: 'alice', kind: 'pause', runId: 'root', applied: false },
  });
  expect((await f.engine.advance('session', 'alice')).runs['root']!.status).toBe('paused');
  await mutation(f.store, {
    type: 'control.submit',
    control: { id: 'resume', actor: 'alice', kind: 'resume', runId: 'root', applied: false },
  });
  const resumed = await f.engine.advance('session', 'alice');
  expect(resumed.runs['root']!.wait!.reason).toBe('external-model');
  expect(resumed.runs['root']!.wait!.objectIds[0]).not.toBe(attempt);
});
