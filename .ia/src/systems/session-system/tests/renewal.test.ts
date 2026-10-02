import { expect, it } from 'vitest';
import { copy, digest, JournalStore, MemoryBackend, replay } from '../src/index.js';
import type { Command, Mutation } from '../src/index.js';

async function waiting() {
  const at = 1000,
    backend = new MemoryBackend(),
    store = new JournalStore(backend, () => new Date(at).toISOString());
  const limits = {
    deadline: 900,
    steps: 10,
    modelCalls: 10,
    operations: 10,
    tokens: 10000,
    children: 2,
    depth: 2,
    bytes: 1000000,
  };
  await store.command({
    id: 'start',
    sessionId: 'session',
    actor: 'alice',
    expected: 0,
    mutation: {
      type: 'session.create',
      sessionId: 'session',
      principal: 'alice',
      workspace: 'workspace',
      manifest: {},
      manifestDigest: digest({}),
      rootId: 'root',
      profile: 'profile',
      agent: 'agent',
      task: 'Task',
      limits,
      contract: {},
      authority: { principal: 'alice', expiresAt: 900, limits },
    },
  });
  const owner = await store.acquire('session');
  const question = { prompt: 'Which?', respondent: 'alice', choices: ['yes'], revision: 1 };
  await store.command(
    {
      id: 'wait',
      sessionId: 'session',
      actor: 'alice',
      expected: 1,
      mutation: {
        type: 'outcome.accept',
        runId: 'root',
        outcome: {},
        terminal: null,
        questions: [
          {
            ...question,
            id: 'question',
            digest: digest(question),
            runId: 'root',
            answer: null,
            status: 'open',
            required: true,
          },
        ],
        wait: { id: 'question', reason: 'input', objectIds: ['question'], continuation: 'continue', details: null },
      },
    },
    owner,
  );
  const mutation: Mutation = {
    type: 'session.renew',
    expectedSequence: 2,
    previousDeadline: 900,
    deadline: 2000,
    runs: { root: { previousDeadline: 900, deadline: 2000 } },
  };
  const command: Command = { id: 'renew', sessionId: 'session', actor: 'alice', expected: 2, mutation };
  return { backend, store, owner, command };
}
it('requires fenced ownership and emits only renewal as v2 while preserving v1 history', async () => {
  const f = await waiting(),
    before = await f.store.read('session'),
    journal = await f.store.journal('session');
  await expect(f.store.command(f.command)).rejects.toMatchObject({ code: 'IA-SESSION-OWNER-REQUIRED' });
  await f.store.command(f.command, f.owner);
  await f.store.command(f.command, f.owner);
  const state = await f.store.read('session'),
    renewed = await f.store.journal('session');
  expect(renewed.events.slice(0, 2)).toEqual(journal.events);
  expect(renewed.events.at(-1)?.version).toBe(2);
  expect(state.limits).toEqual({ ...before.limits, deadline: 2000 });
  expect(state.runs['root']?.authority).toEqual({
    principal: 'alice',
    expiresAt: 2000,
    limits: { ...before.limits, deadline: 2000 },
  });
  expect(state.questions).toEqual(before.questions);
  expect(state.receipts).toEqual(before.receipts);
  expect(replay(renewed.events)).toEqual(state);
  expect((await f.store.checkpoint('session', f.owner)).state).toEqual(state);
  // This is the exact closed version guard used by the previously shipped v1 reader.
  expect(renewed.events.every((event) => event.version === 1)).toBe(false);
});
it.each(['missing-run', 'old-sequence', 'shrink', 'extra-run'] as const)(
  'refuses %s renewal atomically',
  async (fault) => {
    const f = await waiting(),
      before = await f.store.read('session'),
      command = copy(f.command);
    if (command.mutation.type !== 'session.renew') throw new Error('Wrong fixture');
    if (fault === 'missing-run') delete command.mutation.runs['root'];
    if (fault === 'old-sequence') command.mutation.expectedSequence--;
    if (fault === 'shrink') command.mutation.runs['root']!.deadline = 800;
    if (fault === 'extra-run') command.mutation.runs['invented'] = { previousDeadline: 900, deadline: 2000 };
    await expect(f.store.command(command, f.owner)).rejects.toThrow();
    expect(await f.store.read('session')).toEqual(before);
  },
);
it('refuses version downgrade/upgrade combinations even after an attacker recomputes the event hash', async () => {
  const f = await waiting();
  await f.store.command(f.command, f.owner);
  const events = (await f.store.journal('session')).events;
  const downgraded = copy(events),
    last = downgraded.at(-1)!;
  last.version = 1;
  const { hash: _hash, ...body } = last;
  last.hash = digest(body);
  expect(() => replay(downgraded)).toThrow();
  const first = copy(events[0]!);
  first.version = 2;
  const { hash: _oldHash, ...firstBody } = first;
  first.hash = digest(firstBody);
  expect(() => replay([first])).toThrow();
});
