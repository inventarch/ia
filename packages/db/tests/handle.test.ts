import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';
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
  expect(readdirSync(resolve(root, '.ia/.iadb'))).toEqual(['graph.json']);
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
    before = db.snapshot();
  put(root, '.ia/src/invalid.ia', new Uint8Array([0xc3, 0x28]));
  expect(() => db.refresh()).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  expect(db.snapshot()).toEqual(before);
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
    () => db.membership(),
    () => db.refresh(),
    () => db.revision,
    () => db.report,
    () => db.refused,
    () => db.cache,
  ]) {
    expect(read).toThrow(expect.objectContaining({ code: 'IA-DB-CLOSED' }));
  }
});

const byIdentity = (a: { identity: string }, b: { identity: string }): number =>
  a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
const workspaceRecord = (name: string, sources: string) =>
  `#! ia 1.0\n\n@workspace ${name}\n  meaning\n    says "A ${name} test boundary."\n    answers "Which records does ${name} seat?"\n  composition\n    systems [@system governance-system]\n${sources}`;
it('reports one membership row per admitted record with its seat, root, placement, band and source digest', () => {
  const db = open(workspace(), { cache: false }),
    records = [...db.records()].sort(byIdentity),
    rows = db.membership(),
    seat = records.find((r) => r.discriminator === 'workspace' && r.name === 'foundation-workspace')!.identity;
  expect(rows.map((row) => row.identity)).toEqual(records.map((record) => record.identity));
  for (const row of rows) {
    const node = db.get(row.identity)!,
      floor = node.placement.kind === 'floor';
    // One admitted @workspace and no declared sources: authored records sit in it at the placement root (rule 3).
    expect(row).toEqual({
      identity: node.identity,
      seat: floor ? null : seat,
      root: floor ? '.ia/src/floor' : '.ia/src',
      placement: node.placement.kind,
      band: node.band,
      digest: node.digest,
    });
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(rows.some((row) => row.placement === 'floor')).toBe(true);
  expect(() => (rows as unknown[]).pop()).toThrow();
  const scope = db.resolveScope({ identities: [methodId] });
  expect(db.membership({ within: scope.token }).map((row) => row.identity)).toEqual([methodId]);
});
it('moves a membership digest only when that record text changes', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    digestOf = () => db.membership().find((row) => row.identity === methodId)!.digest,
    line = () => db.get(methodId)!.source.line,
    before = digestOf(),
    beforeLine = line(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, methodPath, source.replace('#! ia 1.0\n', '#! ia 1.0\n# lines above the record\n\n'));
  db.refresh();
  expect(line()).toBe(beforeLine + 2);
  expect(digestOf()).toBe(before);
  put(root, methodPath, source.replace('Sample fixture statement 1.', 'An edited statement.'));
  db.refresh();
  expect(digestOf()).not.toBe(before);
});
it('seats records under the longest declared source root, then identity', () => {
  const root = workspace();
  put(root, '.ia/src/team.ia', workspaceRecord('team-workspace', '    sources [".ia/src/systems/governance-system @authored"]\n'));
  put(root, '.ia/src/whole.ia', workspaceRecord('whole-workspace', '    sources [".ia/src @authored", ".ia/src/floor @floor"]\n'));
  put(root, '.ia/src/twin.ia', workspaceRecord('a-twin-workspace', '    sources [".ia/src @authored"]\n'));
  const db = open(root, { cache: false }),
    identity = (name: string) => db.records().find((r) => r.name === name)!.identity,
    row = (id: string) => db.membership().find((r) => r.identity === id)!;
  expect(db.refused).toEqual([]);
  expect(row(methodId)).toMatchObject({ seat: identity('team-workspace'), root: '.ia/src/systems/governance-system' });
  // Equal declared roots tie-break by workspace identity ascending.
  const tie = [identity('whole-workspace'), identity('a-twin-workspace')].sort()[0];
  expect(row(identity('team-workspace'))).toMatchObject({ seat: tie, root: '.ia/src' });
  // A declared root seats only records captured at its placement.
  const floor = db.membership().find((r) => r.placement === 'floor')!;
  expect(floor).toMatchObject({ seat: identity('whole-workspace'), root: '.ia/src/floor' });
});
it('seats adopted records in their admitted @system at the mount root, and nothing when no workspace is unique', () => {
  const native = workspace(),
    sources = readInputs(native, { adopted: [] })
      .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text })),
    revision = createHash('sha256').update(stableSerialize(sources)).digest('hex'),
    db = open(workspace(false), { cache: false, adopted: [{ id: 'foundation', revision, sources }] }),
    rows = db.membership(),
    method = rows.find((r) => r.identity === methodId)!,
    system = db.records().find((r) => r.discriminator === 'system' && r.name === 'governance-system')!;
  expect(method).toMatchObject({
    seat: system.identity,
    root: `.ia/adopted/foundation/${revision}/.ia/src/systems/governance-system`,
    placement: 'adopted',
    band: 90,
  });
  expect(rows.filter((r) => r.placement === 'floor').every((r) => r.seat === null)).toBe(true);
});
