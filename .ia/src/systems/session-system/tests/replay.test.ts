import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { copy, digest, reduce, replay } from '../src/index.js';
import type { Event, Mutation } from '../src/index.js';

function journal(count: number, bytes: number): Event[] {
  const manifest = { retained: 'a'.repeat(bytes) },
    events: Event[] = [];
  const creation: Mutation = {
    type: 'session.create',
    sessionId: 'retained',
    principal: 'alice',
    workspace: 'workspace',
    manifest,
    manifestDigest: digest(manifest),
    rootId: 'root',
    profile: 'author',
    agent: 'author',
    task: { text: 'Retained resource session' },
    limits: {
      steps: 1000,
      modelCalls: 1000,
      operations: 1000,
      tokens: 1_000_000,
      children: 4,
      depth: 2,
      bytes: 64 * 1024 * 1024,
      deadline: Date.parse('2027-01-01T00:00:00.000Z'),
    },
  };
  for (let i = 0; i < count; i++) {
    const mutation: Mutation =
      i === 0
        ? creation
        : {
            type: 'run.wait',
            runId: 'root',
            wait: {
              id: 'wait-' + i,
              reason: 'dependency',
              objectIds: [],
              continuation: 'continue',
              details: { retained: true },
            },
          };
    const body = {
      version: 1 as const,
      id: 'event-' + i,
      sequence: i + 1,
      sessionId: 'retained',
      actor: 'alice',
      at: '2026-09-19T00:00:00.000Z',
      cause: null,
      mutation,
      previous: events.at(-1)?.hash ?? '',
    };
    events.push({ ...body, hash: digest(body) });
  }
  return events;
}

it('replays 512 retained-resource transitions inside a bounded local execution window', () => {
  const events = journal(512, 8 * 1024 * 1024),
    started = performance.now();
  const state = replay(events),
    elapsed = performance.now() - started;
  expect(state.sequence).toBe(512);
  expect(state.hash).toBe(events.at(-1)!.hash);
  expect((state.manifest as { retained: string }).retained).toHaveLength(8 * 1024 * 1024);
  expect(elapsed).toBeLessThan(4000);
}, 30_000);

it('keeps caller states and event payloads detached across replay, public reduction and invalid suffixes', () => {
  const events = journal(7, 1024),
    original = copy(events),
    start = replay(events.slice(0, 3)),
    untouched = copy(start);
  const state = replay(events.slice(3), start);
  expect(start).toEqual(untouched);
  expect(events).toEqual(original);
  expect(state).toEqual(replay(events));
  state.runs['root']!.wait!.details = { changed: true };
  (state.manifest as { retained: string }).retained = 'changed';
  expect(start).toEqual(untouched);
  expect(events).toEqual(original);
  const reduced = reduce(start, events[3]!.mutation, 'alice', events[3]!.at, 4);
  reduced.runs['root']!.wait!.objectIds.push('changed');
  expect(start).toEqual(untouched);
  expect(events).toEqual(original);
  const corrupt = copy(events.slice(3));
  corrupt[2]!.hash = digest('wrong');
  expect(() => replay(corrupt, start)).toThrow('digest');
  expect(start).toEqual(untouched);
  expect(() => reduce(start, { type: 'child.return', childId: 'missing' }, 'alice', events[3]!.at, 4)).toThrow();
  expect(start).toEqual(untouched);
});
