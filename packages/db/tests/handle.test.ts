import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DbError, open, readInputs } from '../src/index.js';
import { stableState } from '../src/handle.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

it('opens the native corpus through immutable public read products', () => {
  const db = open(workspace(), { cache: false }),
    snapshot = db.snapshot();
  expect(snapshot.records.some((record) => record.name === 'sample-procedure')).toBe(true);
  expect(db.cache.state).toBe('disabled');
  expect(db.get(methodId)?.discriminator).toBe('playbook');
  expect(db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }).ok).toBe(true);
  expect(db.search('fixture').some((hit) => hit.identity === methodId)).toBe(true);
  expect(db.traverse({ start: [methodId], depth: 0 }).nodes).toEqual([{ identity: methodId, depth: 0 }]);
  expect(db.report.revision).toBe(db.revision);
  expect(db.refused).toEqual([]);
  expect(() => (snapshot.records as unknown[]).pop()).toThrow();
  expect(() => {
    (db.get(methodId)! as { name: string }).name = 'changed';
  }).toThrow();
});
it('verifies an identical cache without rewriting and preserves authored bytes', () => {
  const root = workspace(),
    before = readInputs(root),
    first = open(root),
    path = resolve(root, '.ia/.iadb/graph.json');
  expect(first.cache.state).toBe('written');
  expect(first.cache.observations).toEqual([]);
  const bytes = readFileSync(path, 'utf8');
  utimesSync(path, new Date(100000), new Date(100000));
  const modified = statSync(path).mtimeMs;
  const second = open(root);
  expect(second.cache.state).toBe('hit');
  expect(statSync(path).mtimeMs).toBe(modified);
  expect(second.snapshot()).toEqual(first.snapshot());
  expect(second.refresh()).toEqual(first.snapshot());
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readInputs(root)).toEqual(before);
  // D08a: the retained pair is the capture's, which no handle writes; the cache holds the graph alone.
  expect(second.previousRevision).toBeUndefined();
  expect(readdirSync(resolve(root, '.ia/.iadb'))).toEqual(['graph.json']);
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
});
it.each(['broken JSON', 'forged'])('replaces %s cache bytes even with a matching revision', (corruption) => {
  const root = workspace(),
    first = open(root),
    path = '.ia/.iadb/graph.json',
    good = readFileSync(resolve(root, path), 'utf8');
  put(
    root,
    path,
    corruption === 'forged' ? JSON.stringify({ ...JSON.parse(good), graph: { nodes: ['fabricated'] } }) : '{',
  );
  const second = open(root);
  expect(second.cache.state).toBe('written');
  expect(second.revision).toBe(first.revision);
  expect(second.records()).toEqual(first.records());
  expect(readFileSync(resolve(root, path), 'utf8')).toBe(good);
});
it('keeps fresh reads usable when cache access is obstructed or points outside', () => {
  const root = workspace(false);
  put(root, '.ia/.iadb', 'obstruction');
  const db = open(root);
  expect(db.records()).toHaveLength(118);
  expect(db.cache.state).toBe('unavailable');
  expect(db.cache.observations[0]?.code).toBe('IA-DB-CACHE-UNAVAILABLE');
  const other = workspace(),
    outside = workspace(false);
  put(outside, 'graph.json', 'do not touch');
  symlinkSync(outside, resolve(other, '.ia/.iadb'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(open(other).cache.state).toBe('unavailable');
  expect(readFileSync(resolve(outside, 'graph.json'), 'utf8')).toBe('do not touch');
});
it('publishes a new immutable generation after a byte edit without changing record identity', () => {
  const root = workspace(),
    db = open(root),
    before = db.snapshot(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, source + '\n# revision-only edit\n');
  expect(db.snapshot()).toEqual(before);
  const after = db.refresh();
  expect(after.revision).not.toBe(before.revision);
  expect(after.records.map((r) => r.identity)).toEqual(before.records.map((r) => r.identity));
  expect(() => db.records({ revision: before.revision })).toThrow(expect.objectContaining({ code: 'IA-DB-STALE' }));
  expect(open(root).snapshot()).toEqual(after);
  expect(before.revision).not.toBe(db.revision);
});
it('preserves the last published state when refresh fails', () => {
  const root = workspace(),
    db = open(root),
    first = db.revision;
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8') + '\n# revision-only edit\n');
  const before = db.refresh();
  put(root, '.ia/src/invalid.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => db.refresh()).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  expect(db.snapshot()).toEqual(before);
  // D08: a failed refresh rotates nothing.
  expect(db.previousRevision).toBe(first);
  expect(db.staleness(methodId)).toBe('unchanged');
});
it('retries unstable scans at most three times and publishes only a stable candidate', () => {
  const root = workspace(false),
    first = readInputs(root);
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  const second = readInputs(root);
  let calls = 0;
  const stable = stableState(() => (++calls === 1 ? first : second), false);
  expect(calls).toBe(4);
  expect(stable.inputs).toBe(second);
  calls = 0;
  expect(() => stableState(() => (++calls % 2 ? first : second), false)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SOURCE-CHANGED' }),
  );
  expect(calls).toBe(6);
  calls = 0;
  expect(() =>
    stableState(() => {
      calls++;
      throw new DbError('IA-DB-SOURCE-CHANGED', 'concurrent change');
    }, false),
  ).toThrow('three consecutive');
  expect(calls).toBe(3);
});
it('closes idempotently and refuses all subsequent reads and refreshes', () => {
  const db = open(workspace(false), { cache: false });
  db.close();
  db.close();
  for (const read of [
    () => db.snapshot(),
    () => db.records(),
    () => db.get(methodId),
    () => db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }),
    () => db.search('x'),
    () => db.traverse({ start: [] }),
    () => db.refresh(),
    () => db.revision,
    () => db.report,
    () => db.refused,
    () => db.cache,
    () => db.previousRevision,
    () => db.staleness(methodId),
    () => db.readiness(methodId, '0'.repeat(64)),
  ]) {
    expect(read).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
  }
});
