import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, JournalStore, MemoryBackend } from '@inventarch/session-system';
import { SqliteBackend } from '@inventarch/session-system/sqlite';
import type { Admission, JournalBackend, Mutation, SessionStore } from '@inventarch/session-system';
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
function fixture(model?: ModelAdapter, backend: JournalBackend = new MemoryBackend()) {
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
  const grant: Grant & { clearances: string[] } = {
    clearances: [],
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
const privateRead = (f: ReturnType<typeof fixture>) => {
  f.grant.clearances = ['private'];
  f.host.operations = {
    'read.v1': {
      id: 'read.v1',
      execute: async () => ({
        output: 'private-source',
        effect: 'none',
        label: ['private', 'private'],
      }),
    },
  };
};
function releaseEngine(f: ReturnType<typeof fixture>): Engine {
  f.manifest.profiles['author']!.contract = {
    id: 'release-contract',
    release: { policy: 'public-summary' },
    mandateContracts: [],
    inputContracts: [],
    effects: ['read'],
    limits: {},
    delegation: [],
    checks: [],
    completionEvaluator: 'ia.completion.v1',
    repairAttempts: 1,
    maxAttempts: 2,
  };
  f.manifest.digest = manifestDigest(f.manifest);
  return new Engine(f.manifest, f.host);
}

it.each(['after-receipt', 'after-fault', 'terminal'])(
  'refuses labelled session hand-overs %s without current clearance',
  async (stop) => {
    const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'private' }, outcome]));
    privateRead(f);
    await start(f.engine);
    if (stop === 'after-fault') {
      const command = f.store.command.bind(f.store);
      f.store.command = async (...args) => {
        const result = await command(...args);
        if (args[0].mutation.type === 'attempt.observe' && args[0].mutation.label?.includes('private')) {
          f.grant.clearances = [];
          throw new Error('fault-after-commit');
        }
        return result;
      };
      await expect(f.engine.advance('session', 'alice')).rejects.toThrow('fault-after-commit');
    } else {
      await f.engine.advance('session', 'alice', stop === 'after-receipt' ? { maxActions: 4 } : {});
      f.grant.clearances = [];
    }
    const held = await f.store.read('session');
    expect(held.label).toEqual(['private']);
    expect(held.receipts.some((r) => r.output === 'private-source' && r.label.includes('private'))).toBe(true);
    for (const read of [
      () => f.engine.advance('session', 'alice'),
      () => start(f.engine),
      () => f.engine.view('session', 'alice'),
    ])
      await expect(read()).rejects.toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
    await f.store.close();
  },
);

it('keeps unlabelled operation results on the legacy event version', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'public' }, outcome]));
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice');
  expect(state.receipts.some((r) => r.output === 'Pinned source content')).toBe(true);
  const observed = (await f.store.journal('session')).events.filter((e) => e.mutation.type === 'attempt.observe');
  expect(observed.length).toBeGreaterThan(1);
  expect(observed.map((e) => e.version)).toEqual(observed.map(() => 1));
  await f.store.close();
});

it('reads a grant without clearances as clearing no labels', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'public' }, outcome]));
  const { clearances: _omitted, ...legacy } = f.grant;
  f.host.authorize = async () => legacy as Grant;
  await start(f.engine);
  expect((await f.engine.advance('session', 'alice')).runs['root']!.status).toBe('completed');
  expect((await f.engine.view('session', 'alice')).label).toEqual([]);
  const labelled = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'private' }, outcome]));
  privateRead(labelled);
  labelled.host.authorize = async () => legacy as Grant;
  await start(labelled.engine);
  await expect(labelled.engine.advance('session', 'alice')).rejects.toMatchObject({
    code: 'IA-ENGINE-AUTHORITY-DENIED',
  });
  await f.store.close();
  await labelled.store.close();
});

it('admits newly granted clearance without trusting host mutations of authorization arguments', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'private' }, outcome]));
  const initial = await start(f.engine);
  expect((initial.runs['root']!.authority as { clearances: string[] }).clearances).toEqual([]);
  privateRead(f);
  f.host.authorize = async (_principal, manifest, state) => {
    manifest.workspace = 'mutated-host-copy';
    if (state) {
      state.label.push('untrusted-mutation');
      state.runs['root']!.profile = 'mutated-host-copy';
    }
    return f.grant;
  };
  const completed = await f.engine.advance('session', 'alice');
  expect(completed.label).toEqual(['private']);
  expect(completed.runs['root']!.profile).toBe('author');
  expect(f.engine.manifest.workspace).toBe('project');
  expect((completed.runs['root']!.authority as { clearances: string[] }).clearances).toEqual([]);
  await f.store.close();
});

it('inherits receipt labels into later model output, outcomes and child returns', async () => {
  const f = fixture(
    scripted([
      { type: 'delegate', profile: 'architect', task: 'inspect' },
      { type: 'invoke', operation: 'read', input: 'private' },
      outcome,
      outcome,
    ]),
  );
  privateRead(f);
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice');
  expect(state.label).toEqual(['private']);
  expect(Object.values(state.runs).every((r) => canonical(r.outcome).includes('"label":["private"]'))).toBe(true);
  expect(state.runs['root']!.label).toEqual(['private']);
  expect(
    Object.values(state.attempts)
      .filter((a) => a.kind === 'model')
      .slice(-2)
      .every((a) => a.label.includes('private')),
  ).toBe(true);
  expect(state.runs['root']!.transcript.find((row) => (row as { kind?: string }).kind === 'child')).toMatchObject({
    label: ['private'],
  });
  await f.store.close();
});

it.each(['missing', 'malformed', 'unrepresentable', 'throwing', 'wrong-root', 'expired'])(
  'redacts %s grants on view and duplicate start',
  async (kind) => {
    const f = fixture();
    await start(f.engine);
    f.host.authorize = async () => {
      if (kind === 'throwing') throw new Error('host-private-details');
      if (kind === 'missing') return undefined as unknown as Grant;
      if (kind === 'malformed') return { ...f.grant, clearances: null } as unknown as Grant;
      if (kind === 'unrepresentable') return { ...f.grant, clearances: ['private\n'] };
      return { ...f.grant, ...(kind === 'wrong-root' ? { profiles: [] } : { expiresAt: 0 }) };
    };
    for (const read of [() => f.engine.view('session', 'alice'), () => start(f.engine)]) {
      const error = await read().catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
      expect(String(error)).not.toContain('host-private-details');
    }
    await f.store.close();
  },
);

it('offers labels on every observation and labelled reply, even when the session already holds them', async () => {
  const offers: Admission[] = [];
  const f = fixture(
    scripted([
      { type: 'invoke', operation: 'read', input: 'first' },
      { type: 'invoke', operation: 'read', input: 'second' },
      {
        type: 'outcome',
        kind: 'clarification',
        message: 'need answer',
        continuation: 'await-input',
        questions: [{ prompt: 'Answer?', choices: [], required: true }],
      },
    ]),
    new MemoryBackend({
      admit: (offer) => {
        offers.push(structuredClone(offer));
        return true;
      },
    }),
  );
  privateRead(f);
  await start(f.engine);
  const state = await f.engine.advance('session', 'alice'),
    question = Object.values(state.questions)[0]!;
  const observations = offers.filter((offer) => offer.observed.some((attempt) => attempt.kind === 'operation'));
  expect(observations).toHaveLength(2);
  for (const offer of observations) {
    expect(offer.labels).toEqual(['private']);
    expect(offer.state.label).toEqual(['private']);
  }
  await f.engine.reply('session', 'alice', question.id, question.revision, question.digest, 'reply-private', 'reply', [
    'private',
  ]);
  const reply = offers.find((offer) => offer.command?.mutation.type === 'question.reply')!;
  expect(reply.labels).toEqual(['private']);
  expect(reply.state.questions[question.id]!.label).toEqual(['private']);
  f.grant.clearances = [];
  await expect(
    f.engine.reply('session', 'alice', question.id, question.revision, question.digest, 'reply-private', 'reply', [
      'private',
    ]),
  ).rejects.toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
  await f.store.close();
});

it('rechecks disclosure after a labelled reply commits, and admission can refuse it atomically', async () => {
  for (const gate of [false, true]) {
    const f = fixture(
      scripted([
        {
          type: 'outcome',
          kind: 'clarification',
          message: 'ask',
          continuation: 'await-input',
          questions: [{ prompt: 'Answer?', choices: [], required: true }],
        },
      ]),
      new MemoryBackend(gate ? { admit: (offer) => offer.labels.length === 0 } : {}),
    );
    await start(f.engine);
    const state = await f.engine.advance('session', 'alice'),
      q = Object.values(state.questions)[0]!;
    await expect(
      f.engine.reply('session', 'alice', q.id, q.revision, q.digest, 'private-answer', 'reply', ['private']),
    ).rejects.toMatchObject({ code: gate ? 'IA-SESSION-ADMISSION-DENIED' : 'IA-ENGINE-AUTHORITY-DENIED' });
    expect((await f.store.read('session')).questions[q.id]!.answer).toBe(gate ? null : 'private-answer');
    await f.store.close();
  }
});

it('releases only host-cleared output across sessions and replays labels and release provenance after SQLite reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ia-engine-labels-'));
  const f = fixture(
    scripted([
      { type: 'invoke', operation: 'read', input: 'private' },
      { type: 'release', candidate: 'untrusted-candidate' },
    ]),
    new SqliteBackend(root),
  );
  privateRead(f);
  let request: Parameters<NonNullable<EngineHost['release']>>[2] | undefined;
  f.host.release = async (_principal, _grant, value) => {
    request = value;
    return { output: 'host-cleared-summary', label: ['public'], policyRevision: 'revision-7' };
  };
  f.grant.clearances.push('public');
  const engine = releaseEngine(f);
  try {
    await start(engine);
    const state = await engine.advance('session', 'alice'),
      release = state.releases[0]!;
    expect(release).toMatchObject({ output: 'host-cleared-summary', label: ['public'], policyRevision: 'revision-7' });
    expect(request!.candidate).toBe('untrusted-candidate');
    expect(request!.sources).toEqual(release.sources);
    const journal = await f.store.journal('session');
    expect(journal.events.find((event) => event.mutation.type === 'release.accept')!.version).toBe(3);
    const source = release.sources[0]!;
    expect(source.label).toEqual(['private']);
    expect(journal.events.some((e) => e.hash === source.digest && source.id === `session:${e.sequence}`)).toBe(true);
    expect(canonical(journal)).not.toContain('untrusted-candidate');
    expect(state.label).toEqual(['private', 'public']);
    await f.store.close();
    f.host.store = new JournalStore(new SqliteBackend(root));
    expect(await f.host.store.read('session')).toEqual(state);
    f.host.authorize = async (principal) => ({
      ...f.grant,
      principal,
      clearances: principal === 'bob' ? ['public'] : f.grant.clearances,
    });
    await expect(engine.boundary('session', 'bob')).rejects.toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
    const output = await engine.boundary('session', 'bob', release.id);
    expect(output).toEqual({ output: 'host-cleared-summary', label: ['public'] });
    await expect(engine.view('session', 'bob')).rejects.toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
    const caller = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'released' }, outcome]));
    caller.grant.clearances = ['public'];
    caller.host.operations = { 'read.v1': { id: 'read.v1', execute: async () => ({ ...output, effect: 'none' }) } };
    await start(caller.engine);
    const received = await caller.engine.advance('session', 'alice');
    expect(received.label).toEqual(['public']);
    expect(canonical(received)).not.toContain('private-source');
    await caller.store.close();
  } finally {
    await f.host.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['throw', 'malformed', 'forged'])('journals only a redacted release refusal for %s', async (kind) => {
  const action = {
    type: 'release',
    candidate: 'REFUSED_CANDIDATE',
    ...(kind === 'forged' ? { label: [], sources: [] } : {}),
  };
  const f = fixture({
    id: 'model',
    generate: async () => ({ action, model: 'test/model', provider: 'test', usage: 1 }),
  });
  f.host.release = async () => {
    if (kind === 'throw') throw new Error('HOST_PRIVATE_DETAILS');
    return { output: 'HOST_PRIVATE_DETAILS', label: [] } as unknown as Awaited<
      ReturnType<NonNullable<EngineHost['release']>>
    >;
  };
  const engine = releaseEngine(f);
  await start(engine);
  const state = await engine.advance('session', 'alice');
  expect(state.releases).toEqual([]);
  expect(Object.values(state.attempts)[0]!.error).toBe('release-refused');
  const retained = canonical(await f.store.journal('session'));
  expect(retained).not.toContain('REFUSED_CANDIDATE');
  expect(retained).not.toContain('HOST_PRIVATE_DETAILS');
  expect(retained).toContain('release-refused');
  await f.store.close();
});

it('releases deferred model candidates before persistence and does not rerun the policy for a duplicate submission', async () => {
  const f = fixture();
  let calls = 0;
  f.host.release = async () => {
    calls++;
    return { output: 'approved', label: [], policyRevision: 'one' };
  };
  const engine = releaseEngine(f);
  await start(engine);
  const state = await engine.advance('session', 'alice'),
    attempt = Object.values(state.attempts)[0]!;
  const response = {
    action: { type: 'release', candidate: 'deferred-candidate' },
    model: 'test/model',
    provider: 'test',
    usage: 1,
  };
  const released = await engine.submitModel('session', 'alice', attempt.id, response, 'response');
  expect(released.releases[0]!.output).toBe('approved');
  await engine.submitModel('session', 'alice', attempt.id, response, 'response');
  expect(calls).toBe(1);
  await expect(
    engine.submitModel(
      'session',
      'alice',
      attempt.id,
      { ...response, action: { type: 'release', candidate: 'different' } },
      'response',
    ),
  ).rejects.toMatchObject({ code: 'IA-SESSION-COMMAND-CONFLICT' });
  expect(canonical(await f.store.journal('session'))).not.toContain('deferred-candidate');
  await engine.start({
    sessionId: 'forged-session',
    commandId: 'forged-start',
    principal: 'alice',
    profile: 'author',
    task: 'release',
  });
  const forged = await engine.advance('forged-session', 'alice'),
    pending = Object.values(forged.attempts)[0]!;
  const refused = await engine.submitModel(
    'forged-session',
    'alice',
    pending.id,
    {
      ...response,
      action: { type: 'release', candidate: 'forged-private-candidate', label: [], sources: [] },
    },
    'forged-response',
  );
  expect(refused.attempts[pending.id]!.error).toBe('release-refused');
  expect(calls).toBe(1);
  expect(canonical(await f.store.journal('forged-session'))).not.toContain('forged-private-candidate');
  await f.store.close();
});

it('keeps model repair labels and checks current clearance on retry and deferred submissions', async () => {
  const f = fixture(scripted([{ type: 'invoke', operation: 'read', input: 'private' }]));
  privateRead(f);
  await start(f.engine);
  const failed = await f.engine.advance('session', 'alice'),
    attempt = Object.values(failed.attempts).at(-1)!;
  expect(attempt.error).toBe('model-attempt-failed');
  expect(attempt.label).toEqual(['private']);
  f.grant.clearances = [];
  await expect(f.engine.retry('session', 'alice', attempt.id, 'repair')).rejects.toMatchObject({
    code: 'IA-ENGINE-AUTHORITY-DENIED',
  });
  f.grant.clearances = ['private'];
  expect((await f.engine.retry('session', 'alice', attempt.id, 'repair')).label).toEqual(['private']);
  f.host.model = { id: 'external', generate: async () => ({ deferred: true }) };
  const pending = await f.engine.advance('session', 'alice'),
    external = Object.values(pending.attempts).at(-1)!;
  f.grant.clearances = [];
  await expect(
    f.engine.submitModel(
      'session',
      'alice',
      external.id,
      { action: outcome, model: 'test/model', provider: 'test', usage: 1 },
      'external',
    ),
  ).rejects.toMatchObject({ code: 'IA-ENGINE-AUTHORITY-DENIED' });
  f.grant.clearances = ['private'];
  const submitted = await f.engine.submitModel(
    'session',
    'alice',
    external.id,
    { action: outcome, model: 'test/model', provider: 'test', usage: 1 },
    'external',
  );
  expect(submitted.attempts[external.id]!.label).toEqual(['private']);
  const completed = await f.engine.advance('session', 'alice');
  expect(completed.runs['root']!.outcome).toMatchObject({ label: ['private'] });
  await f.store.close();
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

it.each(
  ['terminal', 'paused', 'input', 'external-model', 'aborted', 'aborted-ready-wait', 'child-input'].flatMap((stop) =>
    ['current', 'revoked', 'expired', 'wrong-principal', 'wrong-workspace'].map((authority) => ({ stop, authority })),
  ),
)('checks current root authority before returning $stop with a $authority grant', async ({ stop, authority }) => {
  const clarification: ModelAction = {
    type: 'outcome',
    kind: 'clarification',
    message: 'Choose scope',
    continuation: 'await-input',
    questions: [{ prompt: 'Which scope?', choices: ['project', 'personal'], required: true }],
  };
  const f = fixture(
    stop === 'terminal'
      ? scripted([outcome])
      : stop === 'input' || stop === 'aborted-ready-wait'
        ? scripted([clarification])
        : stop === 'child-input'
          ? scripted([{ type: 'delegate', profile: 'architect', task: 'Review' }, clarification])
          : undefined,
  );
  try {
    await start(f.engine);
    if (stop === 'aborted') await f.engine.advance('session', 'alice', { maxActions: 1 });
    else await f.engine.advance('session', 'alice');
    if (stop === 'paused') {
      await mutation(f.store, {
        type: 'control.submit',
        control: { id: 'pause', actor: 'alice', kind: 'pause', runId: 'root', applied: false },
      });
      await f.engine.advance('session', 'alice');
    }
    if (stop === 'aborted-ready-wait') {
      const question = Object.values((await f.store.read('session')).questions)[0]!;
      await mutation(f.store, {
        type: 'question.reply',
        questionId: question.id,
        revision: question.revision,
        digest: question.digest,
        answer: 'project',
      });
    }
    const before = await f.store.read('session');
    expect(before.runs['root']!.status).toBe(
      stop === 'terminal' ? 'completed' : stop === 'paused' ? 'paused' : stop === 'aborted' ? 'running' : 'waiting',
    );
    // Disclosure needs the root profile, even when a child is the waiting run.
    f.grant.profiles = authority === 'revoked' ? ['architect'] : ['author'];
    if (authority === 'expired') f.grant.expiresAt = Date.now();
    if (authority === 'wrong-principal') f.grant.principal = 'mallory';
    if (authority === 'wrong-workspace') f.grant.workspace = 'other';
    let checks = 0;
    f.host.authorize = async () => {
      checks++;
      return f.grant;
    };
    const options = stop.startsWith('aborted') ? { signal: AbortSignal.abort() } : {};
    if (authority === 'current') {
      // Neither a task deadline nor unavailable executable inputs prevent an authorized read.
      f.host.now = () => before.limits.deadline + 1;
      f.grant.expiresAt = before.limits.deadline + 60_000;
      f.host.verifyManifest = async () => false;
      expect(await f.engine.advance('session', 'alice', options)).toEqual(before);
    } else {
      await expect(f.engine.advance('session', 'alice', options)).rejects.toMatchObject({
        code: 'IA-ENGINE-AUTHORITY-DENIED',
      });
    }
    expect(checks).toBe(1);
    expect(await f.store.read('session')).toEqual(before);
    // Both the success and refusal paths release the scheduler lease.
    const owner = await f.store.acquire('session');
    await f.store.release(owner);
  } finally {
    await f.store.close();
  }
});

it.each(['revoked', 'expired'])('rechecks a grant that becomes %s at the final checkpoint', async (authority) => {
  const f = fixture();
  try {
    await start(f.engine);
    const checkpoint = f.store.checkpoint.bind(f.store);
    f.store.checkpoint = async (...args) => {
      const result = await checkpoint(...args);
      if (authority === 'revoked') f.grant.profiles = [];
      else f.grant.expiresAt = Date.now();
      return result;
    };
    await expect(f.engine.advance('session', 'alice', { maxActions: 1 })).rejects.toMatchObject({
      code: 'IA-ENGINE-AUTHORITY-DENIED',
    });
    expect((await f.store.read('session')).runs['root']!.status).toBe('running');
    const owner = await f.store.acquire('session');
    await f.store.release(owner);
  } finally {
    await f.store.close();
  }
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
it('refuses a host that requires write admission over a store that does not enforce it', async () => {
  const f = fixture();
  const unenforced: SessionStore[] = [
    f.store,
    {
      read: f.store.read.bind(f.store),
      journal: f.store.journal.bind(f.store),
      command: f.store.command.bind(f.store),
      checkpoint: f.store.checkpoint.bind(f.store),
      acquire: f.store.acquire.bind(f.store),
      release: f.store.release.bind(f.store),
      validate: f.store.validate.bind(f.store),
      close: f.store.close.bind(f.store),
      admission: 'yes' as unknown as boolean,
    },
  ];
  for (const store of unenforced)
    for (const requireAdmission of [true, 'yes' as unknown as boolean])
      expect(() => new Engine(f.manifest, { ...f.host, store, requireAdmission })).toThrow(
        expect.objectContaining({ code: 'IA-ENGINE-ADMISSION-UNAVAILABLE' }),
      );
  expect(() => new Engine(f.manifest, { ...f.host, requireAdmission: false })).not.toThrow();
  const gated = fixture(
    scripted([{ type: 'invoke', operation: 'read', input: 'source' }, outcome]),
    new MemoryBackend({ admit: () => true }),
  );
  const host: EngineHost = { ...gated.host, requireAdmission: true },
    engine = new Engine(gated.manifest, host);
  await start(engine);
  expect((await engine.advance('session', 'alice')).runs['root']!.status).toBe('completed');
  // A store the host swaps in later is checked at every use, not only at construction.
  const ungated = new JournalStore(new MemoryBackend());
  host.store = ungated;
  await expect(
    engine.start({ sessionId: 'swapped', commandId: 'start', principal: 'alice', profile: 'author', task: 'Read' }),
  ).rejects.toMatchObject({ code: 'IA-ENGINE-ADMISSION-UNAVAILABLE' });
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-ENGINE-ADMISSION-UNAVAILABLE' });
  await expect(ungated.read('swapped')).rejects.toMatchObject({ code: 'IA-SESSION-NOT-FOUND' });
});
it('refuses an operation result whose authority is revoked before the store admits it', async () => {
  let revoked = false;
  const f = fixture(
    scripted([{ type: 'invoke', operation: 'read', input: 'source' }, outcome]),
    new MemoryBackend({
      admit: ({ observed }) => !revoked || observed.every((attempt) => attempt.kind !== 'operation'),
    }),
  );
  let reads = 0;
  const engine = new Engine(f.manifest, {
    ...f.host,
    requireAdmission: true,
    operations: {
      'read.v1': {
        id: 'read.v1',
        execute: async () => {
          reads++;
          // The adapter's last check passed; the revocation lands before Engine journals the result.
          queueMicrotask(() => {
            revoked = true;
          });
          return { output: 'REVOKED_SOURCE_BYTES', effect: 'none' };
        },
      },
    },
  });
  await start(engine);
  await expect(engine.advance('session', 'alice')).rejects.toMatchObject({ code: 'IA-SESSION-ADMISSION-DENIED' });
  expect(reads).toBe(1);
  const state = await f.store.read('session');
  expect(JSON.stringify(await f.store.journal('session'))).not.toContain('REVOKED_SOURCE_BYTES');
  expect(Object.values(state.attempts).find((attempt) => attempt.kind === 'operation')!.status).toBe('dispatched');
  expect(state.receipts.every((receipt) => receipt.target !== 'read')).toBe(true);
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
