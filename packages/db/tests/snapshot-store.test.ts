import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  CAPTURE_DIR,
  CAPTURE_IGNORE,
  captureOf,
  digestIndex,
  open,
  readCaptured,
  readCapturedSnapshot,
  writeCaptured,
} from '../src/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

const edit = (root: string, from: string, to: string) =>
  put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8').replace(from, to));
const store = (root: string, name = '') => resolve(root, CAPTURE_DIR, name);

it('retains current and previous, rotating only when the captured revision changes', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    first = captureOf(db);
  expect(first).toEqual({ format: 'ia-snapshot-1', revision: db.revision, membership: db.membership() });
  expect(readCapturedSnapshot(root)).toEqual({ observations: [] });
  expect(writeCaptured(root, CAPTURE_DIR, first)).toEqual({ rotated: false, written: true });
  expect(readCapturedSnapshot(root)).toEqual({ current: first, observations: [] });
  expect(readdirSync(store(root)).sort()).toEqual(['.gitignore', 'current.json']);
  expect(readFileSync(store(root, '.gitignore'), 'utf8')).toBe(CAPTURE_IGNORE);
  // Independent of the D06 cache: a cache:false handle never creates .ia/.iadb.
  expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);

  // A capture with no change writes nothing and keeps the store as it was.
  utimesSync(store(root, 'current.json'), new Date(100000), new Date(100000));
  const stamp = statSync(store(root, 'current.json')).mtimeMs;
  expect(writeCaptured(root, CAPTURE_DIR, captureOf(db))).toEqual({ rotated: false, written: false });
  expect(statSync(store(root, 'current.json')).mtimeMs).toBe(stamp);

  edit(root, 'Sample fixture statement 1.', 'An edited statement.');
  db.refresh();
  const second = captureOf(db);
  expect(writeCaptured(root, CAPTURE_DIR, second)).toEqual({ rotated: true, written: true });
  expect(readCaptured(root, CAPTURE_DIR)).toEqual({ current: second, previous: first, observations: [] });

  // Re-capturing an unchanged workspace does not drop previous.
  db.refresh();
  expect(writeCaptured(root, CAPTURE_DIR, captureOf(db))).toEqual({ rotated: false, written: false });
  expect(readCapturedSnapshot(root).previous).toEqual(first);
  // Same revision, other bytes (a newer membership rule, say): current is rewritten and nothing rotates.
  const reseated = {
    ...second,
    membership: second.membership.map((row, i) => (i === 0 ? { ...row, root: 'moved' } : row)),
  };
  expect(writeCaptured(root, CAPTURE_DIR, reseated)).toEqual({ rotated: false, written: true });
  expect(readCapturedSnapshot(root)).toEqual({ current: reseated, previous: first, observations: [] });
  expect(writeCaptured(root, CAPTURE_DIR, second)).toEqual({ rotated: false, written: true });

  // Only two snapshots are retained, and no temporary file survives.
  edit(root, 'An edited statement.', 'A second edit.');
  db.refresh();
  const third = captureOf(db);
  expect(writeCaptured(root, CAPTURE_DIR, third)).toEqual({ rotated: true, written: true });
  expect(readCapturedSnapshot(root)).toEqual({ current: third, previous: second, observations: [] });
  expect(readdirSync(store(root)).sort()).toEqual(['.gitignore', 'current.json', 'previous.json']);
});

it('lets a later cache-free process read staleness against the stored snapshot', () => {
  const root = workspace();
  writeCaptured(root, CAPTURE_DIR, captureOf(open(root, { cache: false })));
  edit(root, 'Sample fixture statement 1.', 'An edited statement.');
  const stored = readCapturedSnapshot(root).current!,
    index = digestIndex(stored),
    later = open(root, { cache: false, previous: index });
  expect(index.revision).toBe(stored.revision);
  expect(index.digests.get(methodId)).toBe(stored.membership.find((row) => row.identity === methodId)!.digest);
  expect(
    later
      .records()
      .filter((node) => later.staleness(node.identity) === 'changed')
      .map((n) => n.identity),
  ).toEqual([methodId]);
  expect(later.records().every((node) => later.staleness(node.identity) !== 'new')).toBe(true);
});

it('reads corrupt or foreign store bytes as absent with a warning and never rotates them', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    first = captureOf(db);
  writeCaptured(root, CAPTURE_DIR, first);
  edit(root, 'Sample fixture statement 1.', 'An edited statement.');
  db.refresh();
  writeCaptured(root, CAPTURE_DIR, captureOf(db));
  for (const bytes of [
    '{',
    JSON.stringify({ ...first, format: 'ia-graph-1' }),
    JSON.stringify({ ...first, extra: 1 }),
  ]) {
    put(root, `${CAPTURE_DIR}/current.json`, bytes);
    const read = readCapturedSnapshot(root);
    expect(read.current).toBeUndefined();
    expect(read.previous).toEqual(first);
    expect(read.observations).toEqual([
      expect.objectContaining({
        code: 'IA-DB-SNAPSHOT-UNAVAILABLE',
        severity: 'warning',
        path: `${CAPTURE_DIR}/current.json`,
      }),
    ]);
    // Unreadable current is replaced, not rotated: previous survives.
    const next = captureOf(db);
    expect(writeCaptured(root, CAPTURE_DIR, next)).toEqual({ rotated: false, written: true });
    expect(readCapturedSnapshot(root)).toEqual({ current: next, previous: first, observations: [] });
  }
  expect(() => writeCaptured(root, CAPTURE_DIR, { ...first, revision: 'not a revision' })).toThrow(
    expect.objectContaining({ code: 'IA-DB-SNAPSHOT-UNAVAILABLE' }),
  );
});

it('keeps an existing store .gitignore and refuses store paths that escape or traverse a link', () => {
  const root = workspace(false),
    snapshot = captureOf(open(root, { cache: false }));
  put(root, `${CAPTURE_DIR}/.gitignore`, '# committed on purpose\n');
  writeCaptured(root, CAPTURE_DIR, snapshot);
  expect(readFileSync(store(root, '.gitignore'), 'utf8')).toBe('# committed on purpose\n');
  for (const dir of ['', '../outside', resolve(root, 'absolute')])
    expect(() => writeCaptured(root, dir, snapshot)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  const other = workspace(false),
    outside = workspace(false);
  put(outside, 'current.json', 'do not touch');
  put(other, '.ia/src/.keep', '');
  symlinkSync(outside, resolve(other, '.ia/work'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => writeCaptured(other, CAPTURE_DIR, snapshot)).toThrow(
    expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }),
  );
  expect(() => readCapturedSnapshot(other)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  expect(readdirSync(outside)).toEqual(['current.json']);
  expect(readFileSync(resolve(outside, 'current.json'), 'utf8')).toBe('do not touch');
  expect(() => readCapturedSnapshot(resolve(root, 'missing'))).toThrow(
    expect.objectContaining({ code: 'IA-DB-ROOT-INVALID' }),
  );
});

it('confines the store to a directory under .ia/work and ignores only a directory it created', () => {
  const root = workspace(),
    snapshot = captureOf(open(root, { cache: false })),
    before = readdirSync(resolve(root, '.ia/src'), { recursive: true }).sort();
  // A store elsewhere would drop its self-ignoring .gitignore beside authored sources.
  for (const dir of ['.ia', '.ia/src', '.ia/work', 'docs/snapshot', '.ia/workspace/snapshot']) {
    expect(() => writeCaptured(root, dir, snapshot)).toThrow(
      expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE', message: expect.stringContaining('.ia/work/') }),
    );
    expect(() => readCaptured(root, dir)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  }
  expect(readdirSync(resolve(root, '.ia')).sort()).toEqual(['src']);
  expect(readdirSync(resolve(root, '.ia/src'), { recursive: true }).sort()).toEqual(before);
  expect(existsSync(resolve(root, 'docs'))).toBe(false);

  // An existing directory without a .gitignore is the consumer's: nothing is added to it.
  put(root, '.ia/work/kept/notes.txt', 'mine');
  expect(writeCaptured(root, '.ia/work/kept', snapshot)).toEqual({ rotated: false, written: true });
  expect(readdirSync(resolve(root, '.ia/work/kept')).sort()).toEqual(['current.json', 'notes.txt']);
  // A directory this call creates is ignored.
  writeCaptured(root, '.ia/work/fresh/nested', snapshot);
  expect(readdirSync(resolve(root, '.ia/work/fresh/nested')).sort()).toEqual(['.gitignore', 'current.json']);
  expect(existsSync(resolve(root, '.ia/work/fresh/.gitignore'))).toBe(false);
  expect(readFileSync(resolve(root, '.ia/work/fresh/nested/.gitignore'), 'utf8')).toBe(CAPTURE_IGNORE);
});

it('refuses a store path holding a NUL byte as unsafe, before anything is written', () => {
  const root = workspace(false),
    snapshot = captureOf(open(root, { cache: false }));
  for (const dir of ['.ia/work/x\0y', '.ia/work/\0', '.ia/work/snapshot\0']) {
    expect(() => writeCaptured(root, dir, snapshot), JSON.stringify(dir)).toThrow(
      expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }),
    );
    expect(() => readCaptured(root, dir), JSON.stringify(dir)).toThrow(
      expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }),
    );
  }
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
});
