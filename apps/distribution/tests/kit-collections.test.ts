/**
 * The collection record beside the lock and its journal (registry collections reference, "Collection record"): the
 * reader's rules, the pure merge, and whole-row removal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names come back exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import { canonicalDistributionJson, decodeDistributionLock } from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import { sha256 } from '../src/files.js';
import type { CollectionsJournal, KitCollections } from '../src/kit-collections.js';
import {
  currentCollections,
  decodeKitCollections,
  expandedRows,
  intactCollections,
  KIT_COLLECTIONS,
  KIT_COLLECTIONS_JOURNAL,
  mergeKitCollections,
  readKitCollections,
  serializeKitCollections,
  settleOrphanJournal,
} from '../src/kit-collections.js';

const made: string[] = [];
afterEach(() => {
  flip.plain = false;
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ia-kit-collections-'));
  made.push(root);
  return root;
};
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const hex = (c: string): string => c.repeat(64);
const pkg = (id: string, version: string, archive: string) => ({
  id,
  version,
  archive: hex(archive),
  manifest: hex('f'),
  location: `sha256:${hex(archive)}`,
  dependencies: [],
});
/** A decoded lock requesting each package at its exact version. */
const lockOf = (...packages: ReturnType<typeof pkg>[]): DistributionLock =>
  decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: [...packages].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => ({ id: p.id, range: p.version })),
    packages: [...packages].sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
const lockText = (lock: DistributionLock): string => canonicalDistributionJson(lock);
const writeLock = (root: string, lock: DistributionLock): string => {
  const text = lockText(lock);
  put(root, '.ia/distributions.lock.json', text);
  return text;
};
const K1 = { id: 'acme/kit', version: '1.0.0', registry: '/registry', members: ['acme/x', 'acme/y'] };
const X1 = pkg('acme/x', '1.0.0', 'a'),
  Y1 = pkg('acme/y', '1.0.0', 'b'),
  Z1 = pkg('acme/z', '1.0.0', 'c');
const recordFor = (lock: DistributionLock, ...expanded: (typeof K1)[]): KitCollections =>
  mergeKitCollections(null, expanded, lock, lockText(lock));

it('round-trips the record', () => {
  const record = recordFor(lockOf(X1, Y1), K1);
  expect(decodeKitCollections(serializeKitCollections(record))).toEqual(record);
  expect(record).toEqual({
    format: 'ia-kit-collections-1',
    lock: sha256(lockText(lockOf(X1, Y1))),
    collections: [
      {
        id: 'acme/kit',
        version: '1.0.0',
        registry: '/registry',
        members: [
          { id: 'acme/x', version: '1.0.0', archive: hex('a') },
          { id: 'acme/y', version: '1.0.0', archive: hex('b') },
        ],
      },
    ],
    unknown: [],
  });
});
it('writes the released literal by default and the plain format once the switch flips, reads both, and refuses other formats and versions', () => {
  const released = recordFor(lockOf(X1, Y1), K1),
    legacyText = serializeKitCollections(released),
    legacy = JSON.parse(legacyText) as Record<string, unknown>;
  expect(legacy['format']).toBe('ia-kit-collections-1');
  expect(legacy).not.toHaveProperty('formatVersion');
  flip.plain = true;
  const plainText = serializeKitCollections(recordFor(lockOf(X1, Y1), K1)),
    plain = JSON.parse(plainText) as Record<string, unknown>;
  expect(plain).toMatchObject({ format: 'kit-collections', formatVersion: 1 });
  // Either spelling reads under either setting, and means the same collections.
  for (const setting of [false, true]) {
    flip.plain = setting;
    for (const text of [legacyText, plainText])
      expect(decodeKitCollections(text)).toMatchObject({ lock: released.lock, collections: released.collections });
  }
  const { formatVersion: _formatVersion, ...rest } = plain;
  for (const bad of [
    { ...rest },
    { ...plain, formatVersion: 2 },
    { ...rest, format: 'ia-kit-collections-1', formatVersion: 1 },
    { ...rest, format: 'ia-kit-collections-2' },
  ])
    expect(() => decodeKitCollections(JSON.stringify(bad))).toThrow();
});
it('a malformed record is invalid, never thrown', () => {
  const root = workspace();
  put(root, KIT_COLLECTIONS, '{not json');
  expect(readKitCollections(root)).toMatchObject({ state: 'invalid' });
  put(root, KIT_COLLECTIONS, JSON.stringify({ format: 'ia-kit-collections-1', lock: 'x', collections: [] }));
  expect(readKitCollections(root)).toMatchObject({ state: 'invalid' });
  expect(() => currentCollections(root)).not.toThrow();
  expect(currentCollections(root)).toMatchObject({ record: null, problems: [expect.any(String)] });
});
it('an unknown format is ignored with a problem', () => {
  const root = workspace();
  put(root, KIT_COLLECTIONS, JSON.stringify({ format: 'ia-kit-collections-9', lock: hex('0'), collections: [] }));
  const current = currentCollections(root);
  expect(current.record).toBeNull();
  expect(current.problems[0]).toContain('format ia-kit-collections-9');
});

it('no journal: the record counts when its lock hash matches, and is source unknown when it does not', () => {
  const root = workspace(),
    lock = lockOf(X1, Y1);
  writeLock(root, lock);
  put(root, KIT_COLLECTIONS, serializeKitCollections(recordFor(lock, K1)));
  expect(intactCollections(root).collections.map((row) => row.id)).toEqual(['acme/kit']);
  // Another lock, as an older CLI leaves after changing it.
  writeLock(root, lockOf(X1, Y1, Z1));
  const other = intactCollections(root);
  expect(other.collections).toEqual([]);
  expect(other.problems).toEqual([expect.stringContaining('describes another lock')]);
});

/** A workspace whose lock holds X1 and Y1, with a journal for the change from `before` to `after`. */
function journaled(before: KitCollections | null, after: KitCollections | null): { root: string } {
  const root = workspace();
  writeLock(root, lockOf(X1, Y1));
  const journal: CollectionsJournal = {
    formatVersion: 1,
    beforeActive: 'before-pointer',
    afterActive: 'after-pointer',
    before: before === null ? null : serializeKitCollections(before),
    after: after === null ? null : serializeKitCollections(after),
  };
  put(root, KIT_COLLECTIONS_JOURNAL, JSON.stringify(journal));
  return { root };
}
const K2 = { ...K1, version: '2.0.0' };
it('a journal with pending.json reports interrupted and no identity', () => {
  const lock = lockOf(X1, Y1),
    { root } = journaled(recordFor(lock, K1), recordFor(lock, K2));
  put(root, '.ia/distributions/pending.json', '{}');
  put(root, '.ia/distributions/active.json', 'after-pointer');
  expect(currentCollections(root)).toEqual({
    record: null,
    source: 'interrupted',
    problems: ['installation interrupted; run ia recover'],
  });
  expect(intactCollections(root).collections).toEqual([]);
});
it('a journal without pending.json picks after on an exact afterActive match, before on an exact beforeActive match, and unknown for any other pointer', () => {
  const lock = lockOf(X1, Y1),
    { root } = journaled(recordFor(lock, K1), recordFor(lock, K2));
  put(root, '.ia/distributions/active.json', 'after-pointer');
  expect(intactCollections(root).collections.map((row) => row.version)).toEqual(['2.0.0']);
  put(root, '.ia/distributions/active.json', 'before-pointer');
  expect(intactCollections(root).collections.map((row) => row.version)).toEqual(['1.0.0']);
  // Not even a pointer that differs only by a trailing byte counts as either side.
  put(root, '.ia/distributions/active.json', 'after-pointer\n');
  expect(intactCollections(root)).toEqual({
    collections: [],
    unknown: [{ id: 'acme/kit', members: ['acme/x', 'acme/y'] }],
    named: [],
    problems: [],
  });
});
it('collections both sides agree on stay known when the rest is unknown', () => {
  const lock = lockOf(X1, Y1, Z1),
    other = { id: 'acme/other', version: '1.0.0', registry: '/registry', members: ['acme/z'] };
  const { root } = journaled(recordFor(lock, K1, other), recordFor(lock, K2, other));
  writeLock(root, lock);
  put(root, '.ia/distributions/active.json', 'moved-on');
  const intact = intactCollections(root);
  expect(intact.collections.map((row) => row.id)).toEqual(['acme/other']);
  expect(intact.unknown).toEqual([{ id: 'acme/kit', members: ['acme/x', 'acme/y'] }]);
  // Settling the journal persists exactly that, never a choice of side.
  expect(settleOrphanJournal(root)).toBe(true);
  const settled = readKitCollections(root);
  expect(settled).toMatchObject({ state: 'present' });
  if (settled.state === 'present') {
    expect(settled.record.collections.map((row) => row.id)).toEqual(['acme/other']);
    expect(settled.record.unknown).toEqual([{ id: 'acme/kit', members: ['acme/x', 'acme/y'] }]);
  }
});
it('an unknown entry is cleared by reinstalling its collection and by removing all its members', () => {
  const lock = lockOf(X1, Y1);
  const withUnknown: KitCollections = {
    ...recordFor(lock),
    unknown: [{ id: 'acme/kit', members: ['acme/x', 'acme/y'] }],
  };
  // Reinstalled: rewritten from the expansion.
  expect(mergeKitCollections(withUnknown, [K2], lock, lockText(lock))).toMatchObject({
    collections: [{ id: 'acme/kit', version: '2.0.0' }],
    unknown: [],
  });
  // Kept while a member is left in the lock.
  expect(mergeKitCollections(withUnknown, [], lockOf(X1), lockText(lockOf(X1))).unknown).toEqual([
    { id: 'acme/kit', members: ['acme/x', 'acme/y'] },
  ]);
  // Gone once none is.
  expect(mergeKitCollections(withUnknown, [], lockOf(Z1), lockText(lockOf(Z1))).unknown).toEqual([]);
});

it('keeps the requests the user named only while a recorded collection lists them and the lock requests them', () => {
  const lock = lockOf(X1, Y1, Z1);
  // z is named but no collection lists it, so nothing needs the mark.
  const record = mergeKitCollections(null, [K1], lock, lockText(lock), ['acme/x', 'acme/z']);
  expect(record.named).toEqual(['acme/x']);
  const text = serializeKitCollections(record);
  expect(JSON.parse(text)).toMatchObject({ named: ['acme/x'] });
  expect(decodeKitCollections(text)).toEqual(record);
  // Carried by a later merge that names nothing, and dropped once the lock no longer requests it.
  expect(mergeKitCollections(record, [], lock, lockText(lock)).named).toEqual(['acme/x']);
  const withoutX = lockOf(Y1, Z1);
  expect(mergeKitCollections(record, [], withoutX, lockText(withoutX)).named).toBeUndefined();
  // A record without the key keeps its bytes, and a mark that is not a distribution id is unreadable.
  expect(serializeKitCollections(recordFor(lock, K1))).not.toContain('named');
  expect(() => decodeKitCollections(text.replace('"acme/x"\n  ]\n}', '"--root=/x"\n  ]\n}'))).toThrow(
    /not a distribution id/,
  );
});

it('members are joined to the plan lock’s exact pins', () => {
  // A kit's distributions are ranges; the row takes the lock's exact version and archive.
  const ranged = { ...K1, members: ['acme/x', 'acme/y'] };
  expect(expandedRows([ranged], lockOf(pkg('acme/x', '1.2.0', 'd'), Y1))[0]!.members).toEqual([
    { id: 'acme/x', version: '1.2.0', archive: hex('d') },
    { id: 'acme/y', version: '1.0.0', archive: hex('b') },
  ]);
  // A member the resolved lock does not hold refuses before anything commits.
  expect(() => expandedRows([ranged], lockOf(X1))).toThrow(
    expect.objectContaining({ code: 'IA-DIST-INSTALL-COLLECTION-MISMATCH' }),
  );
});
it('a removed member removes the whole collection row', () => {
  const root = workspace(),
    before = recordFor(lockOf(X1, Y1), K1);
  const after = mergeKitCollections(before, [], lockOf(X1), lockText(lockOf(X1)));
  expect(after.collections).toEqual([]);
  // The remaining member is not reported as an intact collection, even if a record names it.
  writeLock(root, lockOf(X1));
  put(root, KIT_COLLECTIONS, serializeKitCollections({ ...before, lock: sha256(lockText(lockOf(X1))) }));
  expect(intactCollections(root).collections).toEqual([]);
});
it('a re-pinned or re-archived member removes the whole row', () => {
  const before = recordFor(lockOf(X1, Y1), K1);
  for (const moved of [pkg('acme/x', '1.1.0', 'a'), pkg('acme/x', '1.0.0', 'e')]) {
    const lock = lockOf(moved, Y1);
    expect(mergeKitCollections(before, [], lock, lockText(lock)).collections).toEqual([]);
  }
});
it('an unrelated collection is preserved across another collection’s install and a plain release install', () => {
  const other = { id: 'acme/other', version: '1.0.0', registry: '/registry', members: ['acme/z'] };
  const lock = lockOf(X1, Y1, Z1),
    before = recordFor(lock, other);
  const installed = mergeKitCollections(before, [K1], lock, lockText(lock));
  expect(installed.collections.map((row) => row.id)).toEqual(['acme/kit', 'acme/other']);
  const plain = lockOf(X1, Y1, Z1, pkg('acme/w', '1.0.0', 'd'));
  expect(mergeKitCollections(installed, [], plain, lockText(plain)).collections.map((row) => row.id)).toEqual([
    'acme/kit',
    'acme/other',
  ]);
});

it('an id that is not a distribution id refuses, so a committed record cannot pass an option for an id', () => {
  const lock = '0'.repeat(64),
    member = { id: 'acme/x', version: '1.0.0', archive: lock };
  const decode = (record: object) => () =>
    decodeKitCollections(JSON.stringify({ format: 'ia-kit-collections-1', lock, ...record }));
  for (const id of ['--root=/other', '-x', 'acme/../x', 'Acme/X'])
    for (const record of [
      { collections: [], unknown: [{ id, members: ['acme/x'] }] },
      { collections: [], unknown: [{ id: 'acme/kit', members: [id] }] },
      { collections: [{ id, version: '1.0.0', registry: 'r', members: [member] }], unknown: [] },
      { collections: [{ id: 'acme/kit', version: '1.0.0', registry: 'r', members: [{ ...member, id }] }], unknown: [] },
    ])
      expect(decode(record), `${id} ${JSON.stringify(record)}`).toThrow(
        expect.objectContaining({ code: 'IA-DIST-INPUT-INVALID' }),
      );
});
