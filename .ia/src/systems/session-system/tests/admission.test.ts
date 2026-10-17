import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, JournalStore, MemoryBackend, memoryStore } from '../src/index.js';
import { SqliteBackend, sqliteStore } from '../src/sqlite.js';
import type { Admission, AdmissionGate, Command, Json, Mutation, Owner, SessionStore } from '../src/index.js';

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
const sentinel = 'JOURNAL_REVOCATION_MUST_NOT_DISCLOSE';
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
    profile: 'reader',
    agent: 'reader-agent',
    task: { text: 'Read one synthetic source' },
    limits: {
      steps: 20,
      modelCalls: 20,
      operations: 20,
      tokens: 1000,
      children: 0,
      depth: 0,
      bytes: 1_000_000,
      deadline: Date.now() + 60_000,
    },
  },
});
const prepare = (id: string, authority: Json = { principal: 'alice', revision: 'r1' }): Mutation => ({
  type: 'attempt.prepare',
  attempt: {
    id,
    invocationId: `${id}-invocation`,
    runId: 'root',
    kind: 'operation',
    target: 'read',
    bindingDigest: 'synthetic-binding',
    input: {},
    inputDigest: digest({}),
    authority,
    recovery: 'manual',
    reservation: 0,
  },
});
const observe = (id: string, text = sentinel): Mutation => ({
  type: 'attempt.observe',
  attemptId: id,
  output: { text },
  effect: 'none',
  error: null,
  usage: null,
});
async function next(store: SessionStore, id: string, mutation: Mutation): Promise<Command> {
  const state = await store.read('s');
  return { id, sessionId: 's', actor: 'alice', expected: state.sequence, mutation };
}
async function send(store: SessionStore, owner: Owner, mutation: Mutation): Promise<void> {
  const { sequence } = await store.read('s');
  await store.command({ id: `c-${sequence}`, sessionId: 's', actor: 'alice', expected: sequence, mutation }, owner);
}
/** A session with one dispatched read attempt, ready for its observation. */
async function dispatched(store: SessionStore, attempt = 'read'): Promise<Owner> {
  await store.command(creation());
  const owner = await store.acquire('s');
  await send(store, owner, { type: 'run.ready', runId: 'root' });
  await send(store, owner, prepare(attempt));
  await send(store, owner, { type: 'attempt.dispatch', attemptId: attempt });
  return owner;
}
const persisted = async (root: string, text = sentinel): Promise<boolean> => {
  const reopened = sqliteStore(root);
  try {
    return JSON.stringify(await reopened.journal('s')).includes(text);
  } finally {
    await reopened.close();
  }
};

describe('host admission at the SQLite write boundary', () => {
  it('refuses a revocation queued after the last host check, before commit, and persists no source bytes', async () => {
    const root = temporary();
    let revoked = false;
    const store = sqliteStore(root, { admit: () => !revoked });
    stores.push(store);
    const owner = await dispatched(store),
      command = await next(store, 'observe', observe('read'));
    expect(JSON.stringify(await store.journal('s')).includes(sentinel)).toBe(false);
    // The host's last synchronous check passes, then a queued revocation lands before the store writes.
    const authorize = (): boolean => {
      queueMicrotask(() => {
        revoked = true;
      });
      return !revoked;
    };
    expect(authorize()).toBe(true);
    const refusal = await store.command(command, owner).catch((error: unknown) => error);
    expect(revoked).toBe(true);
    expect(refusal).toMatchObject({ code: 'IA-SESSION-ADMISSION-DENIED' });
    expect(String((refusal as Error).message)).not.toContain(sentinel);
    expect((await store.read('s')).attempts['read']!.status).toBe('dispatched');
    await store.close();
    expect(await persisted(root)).toBe(false);
  });
});

describe.each(['memory', 'sqlite'] as const)('%s backend admission position', (kind) => {
  it.each(['commit', 'checkpoint'] as const)(
    'rechecks authority revoked while %s awaits ownership validation',
    async (write) => {
      const root = kind === 'sqlite' ? temporary() : '';
      let revoked = false,
        validations = 0,
        revokeAt = Infinity;
      class RevokingSqlite extends SqliteBackend {
        override async validate(owner: Owner): Promise<void> {
          await super.validate(owner);
          if (++validations === revokeAt) revoked = true;
        }
      }
      class RevokingMemory extends MemoryBackend {
        override async validate(owner: Owner): Promise<void> {
          await super.validate(owner);
          if (++validations === revokeAt) revoked = true;
        }
      }
      const admit = (): boolean => !revoked;
      const store = new JournalStore(
        kind === 'sqlite' ? new RevokingSqlite(root, { admit }) : new RevokingMemory({ admit }),
      );
      stores.push(store);
      const owner = await dispatched(store);
      if (write === 'checkpoint') await store.command(await next(store, 'observe', observe('read', 'admitted')), owner);
      const before = await store.journal('s');
      // Revoke inside the backend's own awaited validation: JournalStore validates once before a commit reaches it.
      validations = 0;
      revokeAt = write === 'commit' ? 2 : 1;
      await expect(
        write === 'commit'
          ? store.command(await next(store, 'observe', observe('read')), owner)
          : store.checkpoint('s', owner),
      ).rejects.toMatchObject({ code: 'IA-SESSION-ADMISSION-DENIED' });
      expect(revoked).toBe(true);
      let after = await store.journal('s');
      if (kind === 'sqlite') {
        await store.close();
        const reopened = sqliteStore(root);
        stores.push(reopened);
        after = await reopened.journal('s');
      }
      expect(after).toEqual(before);
      expect(after.checkpoint).toBeNull();
      expect(JSON.stringify(after).includes(sentinel)).toBe(false);
    },
  );
  it('offers only the write that wins: a concurrent duplicate and a stale racer never reach the gate', async () => {
    let calls = 0;
    const root = kind === 'sqlite' ? temporary() : '',
      admit = (): boolean => {
        calls++;
        return true;
      };
    const store = kind === 'memory' ? memoryStore({ admit }) : sqliteStore(root, { admit });
    stores.push(store);
    // All three pass JournalStore's checks against the same empty journal; only the backend can tell them apart.
    const command = creation();
    const results = await Promise.allSettled([
      store.command(command),
      store.command(command),
      store.command({ ...command, id: 'other' }),
    ]);
    expect(
      results.map((result) => (result.status === 'fulfilled' ? 'ok' : (result.reason as { code: string }).code)),
    ).toEqual(['ok', 'ok', 'IA-SESSION-REVISION-CONFLICT']);
    expect(calls).toBe(1);
  });
});

describe.each(['memory', 'sqlite'] as const)('%s admission decisions', (kind) => {
  const make = (admit: AdmissionGate): { store: SessionStore; root: string } => {
    const root = kind === 'sqlite' ? temporary() : '';
    const store = kind === 'memory' ? memoryStore({ admit }) : sqliteStore(root, { admit });
    stores.push(store);
    return { store, root };
  };
  it.each<[string, () => unknown]>([
    ['false', () => false],
    ['undefined', () => undefined],
    ['null', () => null],
    ['a truthy number', () => 1],
    ['the string true', () => 'true'],
    ['an object', () => ({ admit: true })],
    ['a promise of true', () => Promise.resolve(true)],
    ['a rejected promise', () => Promise.reject(new Error(sentinel))],
    ['a rejected promise from another realm', () => runInNewContext(`Promise.reject(new Error('${sentinel}'))`)],
    [
      'a rejected promise whose own catch throws',
      () =>
        Object.assign(Promise.reject(new Error(sentinel)), {
          catch: () => {
            throw new Error(sentinel);
          },
        }),
    ],
    [
      'a proxy that throws when inspected',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error(sentinel);
            },
          },
        ),
    ],
    ['a thenable', () => ({ then: (resolve: (value: boolean) => void) => resolve(true) })],
    [
      'a throw that carries the payload',
      () => {
        throw new Error(sentinel);
      },
    ],
  ])('fails closed when the gate returns %s, with a redacted refusal', async (_name, decide) => {
    let gated = false;
    const { store, root } = make((admission) => {
      if (!admission.events.some((event) => event.mutation.type === 'attempt.observe')) return true;
      gated = true;
      return decide() as boolean;
    });
    const owner = await dispatched(store),
      before = await store.journal('s');
    const refusal = await store
      .command(await next(store, 'observe', observe('read')), owner)
      .catch((error: unknown) => error);
    expect(gated).toBe(true);
    expect(refusal).toMatchObject({ code: 'IA-SESSION-ADMISSION-DENIED', message: 'Host admission refused the write' });
    expect(JSON.stringify(refusal)).not.toContain(sentinel);
    expect((refusal as { cause?: unknown }).cause).toBeUndefined();
    expect(await store.journal('s')).toEqual(before);
    if (kind === 'sqlite') {
      await store.close();
      expect(await persisted(root)).toBe(false);
    }
  });
  it('offers frozen, exact events with the post-write state and observed attempts, then persists exactly them', async () => {
    const offers: Admission[] = [];
    const { store, root } = make((admission) => {
      offers.push(admission);
      return true;
    });
    const owner = await dispatched(store);
    await store.command(await next(store, 'observe', observe('read')), owner);
    const offer = offers.at(-1)!,
      state = await store.read('s'),
      journal = await store.journal('s');
    expect(offer).toMatchObject({
      kind: 'commit',
      sessionId: 's',
      principal: 'alice',
      fence: owner.fence,
      command: { id: 'observe', actor: 'alice' },
    });
    expect(offer.events).toEqual(journal.events.slice(-1));
    expect(offer.state).toEqual(state);
    expect(offer.observed).toEqual([state.attempts['read']]);
    expect(offer.observed[0]).toMatchObject({
      target: 'read',
      bindingDigest: 'synthetic-binding',
      invocationId: 'read-invocation',
      authority: { principal: 'alice', revision: 'r1' },
    });
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(offer.events[0]!.mutation)).toBe(true);
    expect(Object.isFrozen(offer.state.attempts['read']!.output)).toBe(true);
    expect(offers.find((row) => row.command?.id === 'create')).toMatchObject({ fence: null, observed: [] });
    expect(offers.every((row) => row.kind === 'commit')).toBe(true);
    await store.checkpoint('s', owner);
    expect(offers.at(-1)).toMatchObject({ kind: 'checkpoint', command: null, events: [], fence: owner.fence });
    expect(offers.at(-1)!.state).toEqual(state);
    // A checkpoint restates history its commits already admitted, so it offers no observed attempts.
    expect(offers.at(-1)!.observed).toEqual([]);
    if (kind === 'sqlite') {
      await store.close();
      const reopened = sqliteStore(root);
      stores.push(reopened);
      expect((await reopened.journal('s')).events).toEqual(journal.events);
      expect(await reopened.read('s')).toEqual(state);
      expect((await reopened.journal('s')).checkpoint!.state).toEqual(state);
    }
  });
  it('refuses a gate that tries to rewrite what it is admitting', async () => {
    const { store } = make((admission) => {
      if (admission.events[0]?.mutation.type === 'attempt.observe')
        (admission.events[0].mutation as { output: Json }).output = { text: 'rewritten' };
      return true;
    });
    const owner = await dispatched(store);
    await expect(store.command(await next(store, 'observe', observe('read')), owner)).rejects.toMatchObject({
      code: 'IA-SESSION-ADMISSION-DENIED',
    });
    expect(JSON.stringify(await store.journal('s'))).not.toContain('rewritten');
  });
  it('keeps history admitted before a revocation, refuses only the later admission and still checkpoints', async () => {
    let revoked = false;
    // A per-attempt gate: once revoked, no new operation output is admitted.
    const { store, root } = make(
      (admission) => !revoked || admission.observed.every((attempt) => attempt.kind !== 'operation'),
    );
    const owner = await dispatched(store, 'first');
    await store.command(await next(store, 'first-observe', observe('first', 'AUTHORIZED_BEFORE_REVOCATION')), owner);
    await send(store, owner, prepare('second'));
    await send(store, owner, { type: 'attempt.dispatch', attemptId: 'second' });
    revoked = true;
    await expect(store.command(await next(store, 'second-observe', observe('second')), owner)).rejects.toMatchObject({
      code: 'IA-SESSION-ADMISSION-DENIED',
    });
    await store.checkpoint('s', owner);
    const journal = JSON.stringify(await store.journal('s'));
    expect(journal).toContain('AUTHORIZED_BEFORE_REVOCATION');
    expect(journal).not.toContain(sentinel);
    expect((await store.journal('s')).checkpoint!.state.attempts['first']!.output).toEqual({
      text: 'AUTHORIZED_BEFORE_REVOCATION',
    });
    if (kind === 'sqlite') {
      await store.close();
      expect(await persisted(root, 'AUTHORIZED_BEFORE_REVOCATION')).toBe(true);
      expect(await persisted(root)).toBe(false);
    }
  });
  it('lets the host refuse an observation whose recorded authorization revision is stale', async () => {
    let current = 'r1';
    const { store } = make((admission) =>
      admission.observed.every((attempt) => (attempt.authority as { revision?: string }).revision === current),
    );
    const owner = await dispatched(store);
    current = 'r2';
    await expect(store.command(await next(store, 'observe', observe('read')), owner)).rejects.toMatchObject({
      code: 'IA-SESSION-ADMISSION-DENIED',
    });
    expect(JSON.stringify(await store.journal('s'))).not.toContain(sentinel);
  });
  it('checks ownership, revision and idempotency before the gate and leaves the store usable', async () => {
    let calls = 0;
    const { store } = make(() => {
      calls++;
      return true;
    });
    const owner = await dispatched(store),
      command = await next(store, 'observe', observe('read'));
    const stale = { ...command, id: 'stale', expected: command.expected - 1 };
    calls = 0;
    await expect(store.command(stale, owner)).rejects.toMatchObject({ code: 'IA-SESSION-REVISION-CONFLICT' });
    await expect(store.command(command, { ...owner, token: 'forged' })).rejects.toMatchObject({
      code: 'IA-SESSION-OWNER-LOST',
    });
    expect(calls).toBe(0);
    const result = await store.command(command, owner);
    expect(calls).toBe(1);
    expect(await store.command(command, owner)).toEqual(result);
    expect(calls).toBe(1);
  });
});

describe('admission configuration', () => {
  it('loads without writing to stderr when NO_COLOR and FORCE_COLOR are both set', () => {
    // Installed CLIs load this package on every command, and installed-CLI qualification requires an empty stderr.
    // Importing node:util would load Node's colour probe, which warns whenever both variables are set.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '1' };
    delete env['NODE_OPTIONS'];
    const entry = new URL('../dist/index.js', import.meta.url).href,
      result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`], {
        env,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
  it('reports whether a store enforces admission', () => {
    const root = temporary(),
      gated = [memoryStore({ admit: () => true }), sqliteStore(root, { admit: () => true })],
      legacy = [memoryStore(), sqliteStore(temporary()), new JournalStore(new MemoryBackend())];
    stores.push(...gated, ...legacy);
    expect(gated.map((store) => store.admission)).toEqual([true, true]);
    expect(legacy.map((store) => store.admission)).toEqual([false, false, false]);
  });
  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['not a function', true],
  ])('refuses a configured admission gate that is %s', (_name, admit) => {
    const options = { admit } as unknown as { admit: AdmissionGate };
    expect(() => new MemoryBackend(options)).toThrow(
      expect.objectContaining({ code: 'IA-SESSION-ADMISSION-UNAVAILABLE' }),
    );
    expect(() => sqliteStore(temporary(), options)).toThrow(
      expect.objectContaining({ code: 'IA-SESSION-ADMISSION-UNAVAILABLE' }),
    );
  });
  it('refuses a gated commit offered without the post-write state', async () => {
    const backend = new MemoryBackend({ admit: () => true });
    await expect(backend.commit(creation(), 'digest', [])).rejects.toMatchObject({
      code: 'IA-SESSION-ADMISSION-DENIED',
    });
  });
});
