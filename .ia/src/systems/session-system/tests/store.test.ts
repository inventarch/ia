import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, JournalStore, MemoryBackend } from '../src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { assertDurable, durabilityPragmas, SqliteBackend, sqliteStore } from '../src/sqlite.js';
import type { Command, Mutation, Owner, SessionError, SessionStore } from '../src/index.js';

const roots: string[] = [],
  stores: SessionStore[] = [];
const temporary = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-session-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-session-') || path.includes('..')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
const creation = (): Command => ({
  id: 'create',
  sessionId: 's',
  actor: 'alice',
  expected: 0,
  mutation: {
    type: 'session.create',
    sessionId: 's',
    principal: 'alice',
    workspace: 'w',
    manifest: {},
    manifestDigest: digest({}),
    rootId: 'root',
    profile: 'author',
    agent: 'author-agent',
    task: { text: 'Draft' },
    limits: {
      steps: 20,
      modelCalls: 20,
      operations: 20,
      tokens: 1000,
      children: 4,
      depth: 2,
      bytes: 1_000_000,
      deadline: Date.now() + 60_000,
    },
  },
});
async function send(store: SessionStore, owner: Owner, mutation: Mutation, following?: Mutation[]): Promise<void> {
  const state = await store.read('s');
  await store.command(
    {
      id: `c-${state.sequence}`,
      sessionId: 's',
      actor: 'alice',
      expected: state.sequence,
      mutation,
      ...(following ? { following } : {}),
    },
    owner,
  );
}
const prepare = (id = 'a', kind: 'model' | 'operation' = 'operation', runId = 'root'): Mutation => ({
  type: 'attempt.prepare',
  attempt: {
    id,
    invocationId: id,
    runId,
    kind,
    target: 'read',
    bindingDigest: 'binding',
    input: {},
    inputDigest: digest({}),
    authority: { principal: 'alice' },
    recovery: 'manual',
    reservation: kind === 'model' ? 100 : 0,
  },
});

describe.each(['memory', 'sqlite'] as const)('%s atomic store conformance', (kind) => {
  const make = (): SessionStore => {
    const store = kind === 'memory' ? new JournalStore(new MemoryBackend()) : sqliteStore(temporary());
    stores.push(store);
    return store;
  };
  it('idempotent acknowledgement, stale compare-and-swap and changed duplicate', async () => {
    const store = make(),
      command = creation(),
      result = await store.command(command);
    expect(await store.command(command)).toEqual(result);
    await expect(store.command({ ...command, actor: 'mallory' })).rejects.toMatchObject({
      code: 'IA-SESSION-COMMAND-CONFLICT',
    });
    const owner = await store.acquire('s');
    await expect(
      store.command(
        { id: 'stale', sessionId: 's', actor: 'alice', expected: 0, mutation: { type: 'run.ready', runId: 'root' } },
        owner,
      ),
    ).rejects.toMatchObject({ code: 'IA-SESSION-REVISION-CONFLICT' });
    expect((await store.journal('s')).events).toHaveLength(1);
  });
  it('refuses missing/wrong ownership but admits authenticated controls during ownership', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await expect(store.acquire('s')).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-BUSY' });
    await expect(
      store.command({
        id: 'ready',
        sessionId: 's',
        actor: 'alice',
        expected: 1,
        mutation: { type: 'run.ready', runId: 'root' },
      }),
    ).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-REQUIRED' });
    await store.command({
      id: 'pause',
      sessionId: 's',
      actor: 'alice',
      expected: 1,
      mutation: {
        type: 'control.submit',
        control: { id: 'pause', actor: 'alice', kind: 'pause', runId: 'root', applied: false },
      },
    });
    await store.release(owner);
    await expect(store.validate(owner)).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-LOST' });
  });
  it('rolls back a compound command if its final consequence is invalid', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await expect(
      send(store, owner, { type: 'run.ready', runId: 'root' }, [{ type: 'child.return', childId: 'missing' }]),
    ).rejects.toThrow();
    expect((await store.read('s')).runs['root']!.status).toBe('created');
    expect((await store.read('s')).sequence).toBe(1);
  });
  it('reserves and settles usage with the receipt, then replays exactly', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await send(store, owner, { type: 'run.ready', runId: 'root' });
    await send(store, owner, prepare('a', 'model'));
    expect((await store.read('s')).budget.reservedTokens).toBe(100);
    await send(store, owner, { type: 'attempt.dispatch', attemptId: 'a' });
    await send(store, owner, {
      type: 'attempt.observe',
      attemptId: 'a',
      output: { answer: 'hello' },
      effect: 'none',
      error: null,
      usage: null,
    });
    const state = await store.read('s');
    expect(state.budget.reservedTokens).toBe(0);
    expect(state.budget.usedTokens).toBe(100);
    expect(state.receipts).toHaveLength(1);
    expect((await store.checkpoint('s', owner)).state).toEqual(state);
    expect(await store.read('s')).toEqual(state);
    await expect(
      send(store, owner, {
        type: 'attempt.observe',
        attemptId: 'a',
        output: null,
        effect: 'none',
        error: null,
        usage: 0,
      }),
    ).rejects.toThrow();
  });
  it('keeps exact questions, rejects stale/wrong responses and resumes after one reply', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    const contract = { prompt: 'Which owner?', respondent: 'alice', choices: ['team', 'personal'], revision: 1 };
    await send(store, owner, {
      type: 'outcome.accept',
      runId: 'root',
      outcome: { kind: 'clarification' },
      terminal: null,
      questions: [
        { ...contract, id: 'q', runId: 'root', required: true, answer: null, status: 'open', digest: digest(contract) },
      ],
      wait: { id: 'q', reason: 'input', objectIds: ['q'], continuation: 'continue', details: null },
    });
    await expect(send(store, owner, { type: 'run.ready', runId: 'root' })).rejects.toThrow('unresolved');
    const reply: Command = {
      id: 'reply',
      sessionId: 's',
      actor: 'mallory',
      expected: (await store.read('s')).sequence,
      mutation: { type: 'question.reply', questionId: 'q', revision: 1, digest: digest(contract), answer: 'personal' },
    };
    await expect(store.command(reply)).rejects.toMatchObject({ code: 'IA-SESSION-AUTHORITY-DENIED' });
    await store.command({ ...reply, actor: 'alice' });
    await store.command({ ...reply, actor: 'alice' });
    await send(store, owner, { type: 'run.ready', runId: 'root' });
    expect((await store.read('s')).runs['root']!.status).toBe('running');
    expect(
      (await store.read('s')).runs['root']!.transcript.filter((v) => (v as { kind: string }).kind === 'answer'),
    ).toHaveLength(1);
  });
  it('requires atomic action rejection before repair and retains its exact diagnostic', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await send(store, owner, { type: 'run.ready', runId: 'root' });
    await send(store, owner, prepare('model', 'model'));
    await send(store, owner, { type: 'attempt.dispatch', attemptId: 'model' });
    const action = { type: 'invoke', operation: 'read', input: 123 };
    await send(store, owner, {
      type: 'attempt.observe',
      attemptId: 'model',
      output: { action },
      effect: 'none',
      error: null,
      usage: 7,
    });
    await send(store, owner, { type: 'action.accept', runId: 'root', attemptId: 'model', action });
    const details = { code: 'IA-ENGINE-INPUT-INVALID' };
    await send(store, owner, {
      type: 'run.wait',
      runId: 'root',
      wait: { id: 'model', reason: 'invalid-model-action', objectIds: ['model'], continuation: 'repair', details },
    });
    await expect(send(store, owner, { type: 'model.repair', attemptId: 'model', allowance: 1 })).rejects.toThrow(
      'pending',
    );
    await send(store, owner, { type: 'action.clear', runId: 'root' });
    await send(store, owner, { type: 'model.repair', attemptId: 'model', allowance: 1, details });
    const state = await store.read('s');
    expect(state.runs['root']!.transcript.at(-1)).toMatchObject({ kind: 'repair', details });
    expect(state.budget).toMatchObject({ usedTokens: 7, reservedTokens: 0, steps: 1 });
    expect(state.receipts).toHaveLength(1);
    expect((await store.checkpoint('s', owner)).state).toEqual(state);
  });
  it('does not cancel a parent while a descendant has an unknown effect', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await send(store, owner, { type: 'run.ready', runId: 'root' });
    await send(store, owner, {
      type: 'child.create',
      parentId: 'root',
      childId: 'child',
      profile: 'architect',
      agent: 'architect-agent',
      task: {},
    });
    await send(store, owner, { type: 'run.ready', runId: 'child' });
    await send(store, owner, prepare('effect', 'operation', 'child'));
    await send(store, owner, { type: 'attempt.dispatch', attemptId: 'effect' });
    await send(
      store,
      owner,
      {
        type: 'control.submit',
        control: { id: 'cancel', actor: 'alice', kind: 'cancel', runId: 'root', applied: false },
      },
      [{ type: 'control.apply', controlId: 'cancel' }],
    );
    const state = await store.read('s');
    expect(state.runs['root']!.status).toBe('waiting');
    expect(state.runs['child']!.wait!.reason).toBe('unknown-effect');
    await expect(
      send(store, owner, { type: 'outcome.accept', runId: 'child', outcome: {}, terminal: 'completed' }),
    ).rejects.toThrow('unresolved');
  });
  it('charges bounded reconciliation before lookup and appends evidence without rewriting a failed receipt', async () => {
    const store = make();
    await store.command(creation());
    const owner = await store.acquire('s');
    await send(store, owner, { type: 'run.ready', runId: 'root' });
    await send(store, owner, prepare());
    await send(store, owner, { type: 'attempt.dispatch', attemptId: 'a' });
    await send(store, owner, {
      type: 'attempt.observe',
      attemptId: 'a',
      output: null,
      effect: 'unknown',
      error: 'lost-acknowledgement',
      usage: 0,
    });
    const original = (await store.read('s')).receipts[0]!;
    await send(store, owner, { type: 'attempt.reconcile.start', attemptId: 'a', maxAttempts: 1 });
    const charged = await store.read('s');
    expect(charged.budget.operations).toBe(2);
    expect(charged.attempts['a']!.reconciliations).toBe(1);
    await expect(
      send(store, owner, { type: 'attempt.reconcile.start', attemptId: 'a', maxAttempts: 1 }),
    ).rejects.toThrow();
    expect(await store.read('s')).toEqual(charged);
    await send(store, owner, {
      type: 'attempt.reconcile',
      attemptId: 'a',
      effect: 'applied',
      output: { artifact: 'exact' },
      error: null,
      evidence: 'Exact manifest and bytes',
    });
    const state = await store.read('s');
    expect(state.receipts[0]).toEqual(original);
    expect(state.receipts[1]).toMatchObject({ error: null, effect: 'applied', reconciles: 'a' });
    expect(state.attempts['a']!.error).toBeNull();
    expect(state.budget.operations).toBe(2);
    expect(state.budget.reservedTokens).toBe(0);
    expect((await store.checkpoint('s', owner)).state).toEqual(state);
  });
});
it('falls back from a corrupt checkpoint and refuses a corrupt authoritative journal', async () => {
  const backend = new MemoryBackend(),
    store = new JournalStore(backend);
  stores.push(store);
  await store.command(creation());
  const owner = await store.acquire('s');
  await store.checkpoint('s', owner);
  backend.journals.get('s')!.checkpoint!.state.principal = 'mallory';
  expect((await store.read('s')).principal).toBe('alice');
  backend.journals.get('s')!.events[0]!.actor = 'mallory';
  await expect(store.read('s')).rejects.toMatchObject({ code: 'IA-SESSION-STORE-CORRUPT' });
});
it('persists across restart and releases real process ownership on death', async () => {
  const root = temporary(),
    store = sqliteStore(root);
  stores.push(store);
  await store.command(creation());
  const module = new URL('../dist/sqlite.js', import.meta.url).href;
  const source = `import { sqliteStore } from ${JSON.stringify(module)}; const s=sqliteStore(process.argv[1]); await s.acquire('s'); process.send('owned'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  try {
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before ownership');
      }),
    ]);
    await expect(store.acquire('s')).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-BUSY' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  const owner = await store.acquire('s');
  await send(store, owner, { type: 'run.ready', runId: 'root' });
  await store.close();
  const reopened = sqliteStore(root);
  stores.push(reopened);
  expect((await reopened.read('s')).runs['root']!.status).toBe('running');
}, 15_000);
const refusal = (check: () => void): string | undefined => {
  try {
    check();
  } catch (error) {
    return (error as SessionError).code;
  }
  return undefined;
};
it.each(
  ['journal.sqlite', 'owner.sqlite'].flatMap((file) => ['', '-journal', '-wal', '-shm'].map((suffix) => file + suffix)),
)('refuses hard-linked %s before SQLite can mutate an outside file', async (file) => {
  const root = temporary(),
    external = resolve(temporary(), 'operator-owned'),
    session = resolve(root, createHash('sha256').update('s').digest('hex')),
    store = sqliteStore(root);
  stores.push(store);
  mkdirSync(session);
  writeFileSync(external, '');
  linkSync(external, resolve(session, file));
  await expect(file.startsWith('owner') ? store.acquire('s') : store.command(creation())).rejects.toMatchObject({
    code: 'IA-SESSION-PATH-UNSAFE',
  });
  expect(readFileSync(external)).toEqual(Buffer.alloc(0));
});
it('rechecks a replaced storage ancestor before creating a session database', async () => {
  const parent = temporary(),
    root = resolve(parent, 'sessions'),
    external = temporary(),
    store = sqliteStore(root);
  stores.push(store);
  renameSync(root, resolve(parent, 'original'));
  symlinkSync(external, root, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(store.command(creation())).rejects.toMatchObject({ code: 'IA-SESSION-PATH-UNSAFE' });
  expect(existsSync(resolve(external, createHash('sha256').update('s').digest('hex')))).toBe(false);
});
it('sets and requires fullfsync only for the darwin durability profile', () => {
  const wal = { journal_mode: 'wal', synchronous: 2 };
  expect(durabilityPragmas('darwin')).toContain('PRAGMA fullfsync=ON;');
  expect(refusal(() => assertDurable({ ...wal, fullfsync: 0 }, 'darwin'))).toBe('IA-SESSION-STORE-UNAVAILABLE');
  expect(refusal(() => assertDurable({ ...wal, fullfsync: 1 }, 'darwin'))).toBeUndefined();
  for (const platform of ['linux', 'win32'] as const) {
    expect(durabilityPragmas(platform)).not.toContain('fullfsync');
    expect(refusal(() => assertDurable({ ...wal, fullfsync: 0 }, platform))).toBeUndefined();
  }
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    expect(durabilityPragmas(platform)).toContain('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    expect(refusal(() => assertDurable({ journal_mode: 'delete', synchronous: 2, fullfsync: 1 }, platform))).toBe(
      'IA-SESSION-STORE-UNAVAILABLE',
    );
    expect(refusal(() => assertDurable({ journal_mode: 'wal', synchronous: 1, fullfsync: 1 }, platform))).toBe(
      'IA-SESSION-STORE-UNAVAILABLE',
    );
  }
});
it('defaults the durability profile to the host platform', () => {
  const backend = new SqliteBackend(temporary());
  expect(backend.platform).toBe(process.platform);
});
it.each(['darwin', 'linux', 'win32'] as const)(
  'opens a %s-profile journal and owner lock on this host with the profile fullfsync',
  async (platform) => {
    const backend = new SqliteBackend(temporary(), { platform }),
      store = new JournalStore(backend);
    stores.push(store);
    await store.command(creation());
    await store.acquire('s');
    expect((await store.read('s')).principal).toBe('alice');
    const probe = new DatabaseSync(':memory:'),
      fallback = (probe.prepare('PRAGMA fullfsync').get() as { fullfsync: number }).fullfsync;
    probe.close();
    const inner = backend as unknown as {
      databases: Map<string, DatabaseSync>;
      leases: Map<string, { connection: DatabaseSync }>;
    };
    for (const db of [inner.databases.get('s')!, inner.leases.get('s')!.connection])
      expect((db.prepare('PRAGMA fullfsync').get() as { fullfsync: number }).fullfsync).toBe(
        platform === 'darwin' ? 1 : fallback,
      );
  },
);
