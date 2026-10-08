import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  CAPTURE_CURRENT,
  CAPTURE_DIRECTORY,
  CAPTURE_FORMAT,
  CAPTURE_PREVIOUS,
  open,
  writeCapture,
} from '../src/index.js';
import type { Snapshot } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

/**
 * Seams on node:fs: the renames a capture makes, so a test can fail one of them, and the paths every stat or read
 * touches, so a test can show that a handle opens no capture file until it is asked. Every call passes through.
 */
const hooks = vi.hoisted(() => ({
  rename: undefined as ((from: string, to: string) => void) | undefined,
  touched: undefined as string[] | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const touching = <F extends (...args: never[]) => unknown>(call: F): F =>
    ((...args: Parameters<F>) => {
      hooks.touched?.push(String(args[0]).replaceAll('\\', '/'));
      return call(...args);
    }) as F;
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      hooks.rename?.(String(from), String(to));
      actual.renameSync(from, to);
    },
    lstatSync: touching(actual.lstatSync),
    statSync: touching(actual.statSync),
    readFileSync: touching(actual.readFileSync),
    openSync: touching(actual.openSync),
  };
});

const otherId = 'governance-system/governance/law/sample-rule';
const edit = (root: string, text: string) =>
  put(root, methodPath, text.replace('Sample fixture statement 3.', 'An edited cell.'));
/** Every identity of the snapshot whose staleness is not `unchanged`, with its staleness. */
const stale = (db: ReturnType<typeof open>, snapshot: Snapshot) =>
  snapshot.records.flatMap((r) =>
    db.staleness(r.identity) === 'unchanged' ? [] : [[r.identity, db.staleness(r.identity)]],
  );
/** The retained part of an `ia-snapshot-1` capture of the handle's root view, as `ia capture` writes it. */
const captureOf = (db: ReturnType<typeof open>): string =>
  `${JSON.stringify({ format: CAPTURE_FORMAT, revision: db.revision, membership: db.snapshot().membership })}\n`;
/** Every file below `directory` with its text, so a read is shown to write nothing there. */
const tree = (directory: string): Readonly<Record<string, string>> =>
  existsSync(directory)
    ? Object.fromEntries(
        readdirSync(directory, { recursive: true, withFileTypes: true })
          .filter((dirent) => dirent.isFile())
          .map((dirent) => {
            const path = join(dirent.parentPath, dirent.name);
            return [path, readFileSync(path, 'utf8')];
          }),
      )
    : {};

it('reports exactly the edited record as changed after a refresh, and only a revision change rotates', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    db = open(root);
  try {
    const first = db.snapshot(),
      before = db.get(methodId)!.digest;
    expect(db.get(otherId)).toBeDefined();
    // No previous snapshot is retained yet: every current identity is new.
    expect(db.previousRevision).toBeUndefined();
    expect(new Set(first.records.map((r) => db.staleness(r.identity)))).toEqual(new Set(['new']));
    // A refresh that finds the same revision rotates nothing.
    db.refresh();
    expect(db.previousRevision).toBeUndefined();
    edit(root, text);
    const after = db.refresh(),
      digest = db.get(methodId)!.digest;
    expect(after.revision).not.toBe(first.revision);
    expect(db.previousRevision).toBe(first.revision);
    expect(stale(db, after)).toEqual([[methodId, 'changed']]);
    expect(after.records.length).toBe(first.records.length);
    // Readiness by digest: the current digest, the previous one, and one neither snapshot holds.
    expect(db.readiness(methodId, digest)).toBe('current');
    expect(db.readiness(methodId, before)).toBe('previous');
    expect(db.readiness(methodId, '0'.repeat(64))).toBe('unknown');
    // An unchanged record's digest is in both snapshots, and the current one answers first.
    expect(db.readiness(otherId, db.get(otherId)!.digest)).toBe('current');
    expect(db.staleness('governance-system/governance/law/absent')).toBeUndefined();
    expect(db.readiness('governance-system/governance/law/absent', digest)).toBe('unknown');
    // Refreshing again at the same revision keeps the comparison staleness and readiness depend on.
    db.refresh();
    expect(db.previousRevision).toBe(first.revision);
    expect(stale(db, after)).toEqual([[methodId, 'changed']]);
    // A revision-only edit is a revision change: the edited capture becomes previous, and nothing moved since.
    put(root, methodPath, readFileSync(resolve(root, methodPath), 'utf8') + '\n# revision-only edit\n');
    const latest = db.refresh();
    expect(db.previousRevision).toBe(after.revision);
    expect(stale(db, latest)).toEqual([]);
    expect(db.readiness(methodId, before)).toBe('unknown');
  } finally {
    db.close();
  }
});

it('seeds a new handle from the capture pair, whatever its cache setting, and never writes it', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    earlier = open(root, { cache: false }),
    revision = earlier.revision,
    before = earlier.get(methodId)!.digest;
  // No capture yet: nothing seeds, and a read never creates the pair.
  expect([earlier.previousRevision, earlier.capturedRevision]).toEqual([undefined, undefined]);
  expect(writeCapture(root, captureOf(earlier))).toMatchObject({ prior: null, previous: null, rotated: false });
  earlier.close();
  edit(root, text);
  const pair = tree(resolve(root, CAPTURE_DIRECTORY));
  for (const cache of [false, true]) {
    // A process that opens after the edit finds the capture at another revision: it is the previous snapshot.
    const later = open(root, { cache });
    try {
      expect(later.revision).not.toBe(revision);
      expect([later.previousRevision, later.capturedRevision]).toEqual([revision, revision]);
      expect(stale(later, later.snapshot())).toEqual([[methodId, 'changed']]);
      expect(later.readiness(methodId, before)).toBe('previous');
      expect(later.readiness(methodId, later.get(methodId)!.digest)).toBe('current');
      expect(later.cache.observations).toEqual([]);
    } finally {
      later.close();
    }
  }
  expect(tree(resolve(root, CAPTURE_DIRECTORY))).toEqual(pair);
  // Once the edit is captured, a handle at that revision reads the earlier capture from previous.json.
  const edited = open(root, { cache: false });
  expect(writeCapture(root, captureOf(edited))).toMatchObject({ prior: revision, previous: revision, rotated: true });
  edited.close();
  const again = open(root, { cache: false });
  try {
    expect([again.previousRevision, again.capturedRevision]).toEqual([revision, again.revision]);
    expect(stale(again, again.snapshot())).toEqual([[methodId, 'changed']]);
  } finally {
    again.close();
  }
});

it('reads an added record as new and a deleted one as removed, outside every scope', () => {
  const root = workspace(),
    path = '.ia/src/systems/governance-system/records/another-procedure.ia',
    db = open(root, { cache: false });
  try {
    put(root, path, readFileSync(resolve(root, methodPath), 'utf8').replace('sample-procedure', 'another-procedure'));
    db.refresh();
    const added = db.records().find((r) => r.source.path === path)!;
    expect(stale(db, db.snapshot())).toEqual([[added.identity, 'new']]);
    rmSync(resolve(root, path));
    db.refresh();
    expect(db.get(added.identity)).toBeUndefined();
    expect(db.staleness(added.identity)).toBe('removed');
    expect(db.readiness(added.identity, added.digest)).toBe('previous');
    // A scope admits only identities its view holds, so a read through a scope token never names a removed one.
    expect(() => db.staleness(added.identity, { within: db.resolveScope().token })).toThrow(
      expect.objectContaining({ code: 'IA-DB-OUT-OF-SCOPE' }),
    );
    // A cache-disabled handle retains in memory only.
    expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
  } finally {
    db.close();
  }
});

it('honours the read bindings and scope rules of get', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    db = open(root, { cache: false });
  try {
    const scope = db.resolveScope({ identities: [methodId] }),
      revision = db.revision,
      digest = db.get(methodId)!.digest;
    expect(db.staleness(methodId, { within: scope.token })).toBe('new');
    expect(db.readiness(methodId, digest, { within: scope.token })).toBe('current');
    for (const read of [
      () => db.staleness(otherId, { within: scope.token }),
      () => db.readiness(otherId, digest, { within: scope.token }),
    ])
      expect(read).toThrow(expect.objectContaining({ code: 'IA-DB-OUT-OF-SCOPE' }));
    expect(() => db.staleness(methodId, { within: 'forged' })).toThrow(
      expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
    );
    expect(() => db.staleness(methodId, { within: scope.token, root: 'other' })).toThrow(
      expect.objectContaining({ code: 'IA-DB-SCOPE-MISMATCH' }),
    );
    edit(root, text);
    db.refresh();
    expect(() => db.staleness(methodId, { within: scope.token })).toThrow(
      expect.objectContaining({ code: 'IA-DB-STALE' }),
    );
    expect(() => db.readiness(methodId, digest, { revision })).toThrow(
      expect.objectContaining({ code: 'IA-DB-STALE' }),
    );
    // A phase scope that reads the root occurrence compares it with the retained root snapshots.
    const phase = db.resolveScope({ phase: 'act', identities: [methodId] });
    expect(db.get(methodId, { within: phase.token })!.digest).toBe(db.get(methodId)!.digest);
    expect(db.staleness(methodId, { within: phase.token })).toBe('changed');
    expect(db.readiness(methodId, digest, { within: phase.token })).toBe('previous');
  } finally {
    db.close();
  }
});

it('compares the occurrence get reads, and makes no root comparison for one the root snapshots do not describe', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    phased = (phase: string) =>
      text.replace(
        / {2}activation\n(?: {4}activate when .*\n)+/,
        `  activation\n    activate when phase is ${phase}\n`,
      );
  put(root, '.ia/src/overlay.ia', phased('act'));
  // As in scope.test.ts: the root and act views read the authored act overlay, the orient view the adopted record.
  const db = open(root, {
      cache: false,
      locations: { [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
    }),
    scoped = (phase: 'orient' | 'act') => ({ within: db.resolveScope({ phase, identities: [methodId] }).token });
  try {
    let orient = scoped('orient'),
      act = scoped('act');
    const rooted = db.get(methodId)!.digest,
      shadowed = db.get(methodId, orient)!.digest;
    expect(db.get(methodId, act)!.digest).toBe(rooted);
    expect(shadowed).not.toBe(rooted);
    // Readiness agrees with get under the same options; staleness makes no root comparison for another occurrence.
    expect([db.readiness(methodId, shadowed, orient), db.readiness(methodId, rooted, orient)]).toEqual([
      'current',
      'unknown',
    ]);
    expect([db.staleness(methodId, orient), db.staleness(methodId, { phase: 'orient' })]).toEqual([
      undefined,
      undefined,
    ]);
    expect(db.staleness(methodId, act)).toBe('new');
    // Editing only the record the orient view reads changes no root occurrence, and orient still has no previous side.
    edit(root, text);
    db.refresh();
    orient = scoped('orient');
    act = scoped('act');
    const edited = db.get(methodId, orient)!.digest;
    expect(edited).not.toBe(shadowed);
    expect([db.staleness(methodId), db.staleness(methodId, act), db.staleness(methodId, orient)]).toEqual([
      'unchanged',
      'unchanged',
      undefined,
    ]);
    expect([db.readiness(methodId, edited, orient), db.readiness(methodId, shadowed, orient)]).toEqual([
      'current',
      'unknown',
    ]);
    // A same-band orient overlay ties the root view: the root read finds the record removed, while the act scope reads
    // an occurrence the root view no longer holds, so it reports no staleness and never `removed`.
    put(root, '.ia/src/overlay-orient.ia', phased('orient'));
    db.refresh();
    act = scoped('act');
    expect(db.get(methodId)).toBeUndefined();
    expect([db.staleness(methodId), db.readiness(methodId, rooted)]).toEqual(['removed', 'previous']);
    expect(db.get(methodId, act)!.digest).toBe(rooted);
    expect([db.staleness(methodId, act), db.readiness(methodId, rooted, act)]).toEqual([undefined, 'current']);
  } finally {
    db.close();
  }
});

type Pair = Pick<Snapshot, 'revision' | 'membership'>;
/**
 * A well-formed capture at another revision, with `row` merged into the edited record's row: each forgery below carries
 * one, so a file trusted despite its defect would visibly seed `previousRevision`.
 */
const seeded = (good: Pair, row: Record<string, unknown> = {}) => ({
  format: CAPTURE_FORMAT,
  revision: '1'.repeat(64),
  membership: good.membership.map((r) => (r.identity === methodId ? { ...r, ...row } : r)),
});
it.each([
  ['broken JSON', () => '{'],
  ['a foreign format', (good: Pair) => JSON.stringify({ ...seeded(good), format: 'ia.compiled.v1' })],
  ['a short revision', (good: Pair) => JSON.stringify({ ...seeded(good), revision: '1'.repeat(63) })],
  ['a row missing keys', (good: Pair) => JSON.stringify({ ...seeded(good), membership: [{ identity: methodId }] })],
  ['an extra row key', (good: Pair) => JSON.stringify(seeded(good, { extra: true }))],
  ['a non-text root', (good: Pair) => JSON.stringify(seeded(good, { root: 1 }))],
  ['an invalid band', (good: Pair) => JSON.stringify(seeded(good, { band: 99 }))],
  ['a non-hex digest', (good: Pair) => JSON.stringify(seeded(good, { digest: 'Z'.repeat(64) }))],
  [
    'a duplicate identity',
    (good: Pair) => {
      const capture = seeded(good),
        row = capture.membership.find((r) => r.identity === methodId)!;
      return JSON.stringify({ ...capture, membership: [...capture.membership, { ...row, digest: '0'.repeat(64) }] });
    },
  ],
])('never seeds from a capture file holding %s, and still reads', (_name, forge) => {
  const root = workspace(),
    probe = open(root, { cache: false }),
    good = probe.snapshot();
  probe.close();
  for (const path of [CAPTURE_CURRENT, CAPTURE_PREVIOUS]) {
    rmSync(resolve(root, CAPTURE_DIRECTORY), { recursive: true, force: true });
    put(root, path, forge(good));
    const db = open(root, { cache: false });
    try {
      expect([db.previousRevision, db.capturedRevision], path).toEqual([undefined, undefined]);
      expect(db.staleness(methodId), path).toBe('new');
      expect(db.records().length, path).toBeGreaterThan(100);
    } finally {
      db.close();
    }
  }
});

it('trusts a capture at another revision as written, never one at the fresh revision with other rows', () => {
  const root = workspace(),
    probe = open(root, { cache: false }),
    good = probe.snapshot();
  probe.close();
  // A capture at the fresh revision holding other rows is not this workspace's capture there: the pair seeds nothing.
  put(root, CAPTURE_CURRENT, JSON.stringify({ ...seeded(good, { digest: '0'.repeat(64) }), revision: good.revision }));
  put(root, CAPTURE_PREVIOUS, JSON.stringify(seeded(good)));
  let db = open(root, { cache: false });
  expect([db.previousRevision, db.capturedRevision]).toEqual([undefined, undefined]);
  db.close();
  // previous.json at the revision current.json names is no previous capture; with current.json at another revision,
  // that capture is the previous snapshot.
  put(root, CAPTURE_CURRENT, JSON.stringify(seeded(good)));
  db = open(root, { cache: false });
  expect([db.previousRevision, db.capturedRevision]).toEqual(['1'.repeat(64), '1'.repeat(64)]);
  expect(db.readiness(methodId, good.membership.find((r) => r.identity === methodId)!.digest)).toBe('current');
  db.close();
  // With no readable current.json, a capture at previous.json is still the most recent capture there is.
  put(root, CAPTURE_CURRENT, 'not a capture');
  db = open(root, { cache: false });
  expect([db.previousRevision, db.capturedRevision]).toEqual(['1'.repeat(64), undefined]);
  db.close();
});

it('keeps reads usable when the capture pair cannot be read, and never follows a link to it', () => {
  const root = workspace(),
    outside = workspace(false),
    probe = open(root, { cache: false }),
    good = probe.snapshot();
  probe.close();
  mkdirSync(resolve(root, CAPTURE_CURRENT), { recursive: true });
  let db = open(root, { cache: false });
  expect([db.previousRevision, db.capturedRevision]).toEqual([undefined, undefined]);
  expect(db.cache.observations).toEqual([]);
  db.close();
  // A well-formed capture behind a junction would otherwise be trusted as written; it seeds nothing.
  rmSync(resolve(root, '.ia/work'), { recursive: true, force: true });
  put(outside, 'current.json', JSON.stringify(seeded(good)));
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(outside, resolve(root, CAPTURE_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir');
  db = open(root, { cache: false });
  try {
    expect([db.previousRevision, db.capturedRevision]).toEqual([undefined, undefined]);
    expect(db.records().length).toBeGreaterThan(100);
    expect(() => writeCapture(root, captureOf(db))).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
    expect(readdirSync(outside)).toEqual(['current.json']);
  } finally {
    db.close();
  }
});

it('writes the pair as D08 rotates it, counts by digest, and replaces nothing it does not have to', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    at = (path: string) => readFileSync(resolve(root, path));
  const first = open(root, { cache: false }),
    r1 = captureOf(first);
  expect(() => writeCapture(root, '{"format":"ia.compiled.v1"}')).toThrow(TypeError);
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  const records = first.records().length;
  first.close();
  expect(writeCapture(root, r1)).toEqual({
    prior: null,
    ignored: null,
    previous: null,
    rotated: false,
    changed: 0,
    unchanged: 0,
    added: records,
    removed: 0,
  });
  const written = statSync(resolve(root, CAPTURE_CURRENT)).mtimeMs;
  expect(writeCapture(root, r1)).toMatchObject({ prior: JSON.parse(r1).revision, unchanged: records, added: 0 });
  expect(statSync(resolve(root, CAPTURE_CURRENT)).mtimeMs).toBe(written);
  expect(readdirSync(resolve(root, CAPTURE_DIRECTORY))).toEqual(['current.json']);
  edit(root, text);
  const second = open(root, { cache: false }),
    r2 = captureOf(second);
  second.close();
  expect(writeCapture(root, r2)).toMatchObject({
    prior: JSON.parse(r1).revision,
    previous: JSON.parse(r1).revision,
    rotated: true,
    changed: 1,
    unchanged: records - 1,
  });
  // The prior current.json became previous.json byte for byte, and no temporary file is left.
  expect(at(CAPTURE_PREVIOUS).toString('utf8')).toBe(r1);
  expect(at(CAPTURE_CURRENT).toString('utf8')).toBe(r2);
  expect(readdirSync(resolve(root, CAPTURE_DIRECTORY)).sort()).toEqual(['current.json', 'previous.json']);
  // A current.json that is no capture is replaced, and the previous.json at another revision is kept.
  put(root, CAPTURE_CURRENT, 'not a capture');
  expect(writeCapture(root, r2)).toMatchObject({
    prior: null,
    ignored: 'is not JSON',
    previous: JSON.parse(r1).revision,
    rotated: false,
  });
  expect(at(CAPTURE_PREVIOUS).toString('utf8')).toBe(r1);
  // A previous.json at the revision being written is no previous capture, and is removed once current.json is written.
  put(root, CAPTURE_PREVIOUS, r2);
  expect(writeCapture(root, r2)).toMatchObject({ previous: null, rotated: false });
  expect(existsSync(resolve(root, CAPTURE_PREVIOUS))).toBe(false);
  // An entry at either path that is not a regular file refuses before anything is written.
  mkdirSync(resolve(root, CAPTURE_PREVIOUS));
  expect(() => writeCapture(root, r1)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  expect(at(CAPTURE_CURRENT).toString('utf8')).toBe(r2);
  expect(readdirSync(resolve(root, CAPTURE_DIRECTORY)).sort()).toEqual(['current.json', 'previous.json']);
});

it('leaves the pair it found when a write fails, at whichever step it fails', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    at = (path: string) => readFileSync(resolve(root, path), 'utf8');
  const snapshot = () => {
    const db = open(root, { cache: false });
    try {
      return captureOf(db);
    } finally {
      db.close();
    }
  };
  const r1 = snapshot();
  writeCapture(root, r1);
  edit(root, text);
  const r2 = snapshot();
  writeCapture(root, r2);
  put(root, methodPath, text.replace('Sample fixture statement 3.', 'Edited twice.'));
  const r3 = snapshot();
  const failure = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  // Each rename a rotation makes, failed in turn: previous.json aside, current.json to previous.json, the new current.
  for (const step of [1, 2, 3]) {
    let renames = 0;
    hooks.rename = () => {
      renames += 1;
      if (renames === step) throw failure;
    };
    try {
      expect(() => writeCapture(root, r3), `step ${step}`).toThrow(failure);
    } finally {
      hooks.rename = undefined;
    }
    expect([at(CAPTURE_CURRENT), at(CAPTURE_PREVIOUS)], `step ${step}`).toEqual([r2, r1]);
    expect(readdirSync(resolve(root, CAPTURE_DIRECTORY)).sort(), `step ${step}`).toEqual([
      'current.json',
      'previous.json',
    ]);
  }
  // The failed attempts lost nothing: the next capture rotates exactly as it would have.
  expect(writeCapture(root, r3)).toMatchObject({ previous: JSON.parse(r2).revision, rotated: true });
  expect([at(CAPTURE_CURRENT), at(CAPTURE_PREVIOUS)]).toEqual([r3, r2]);
});

it('leaves the pair it found when a write that drops previous.json fails, at whichever step it fails', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    text = captureOf(db),
    junk = 'not a capture\n';
  db.close();
  put(root, CAPTURE_PREVIOUS, junk);
  const failure = Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
  // With nothing to rotate, the renames are previous.json aside and the new current.json; fail each in turn.
  for (const step of [1, 2]) {
    let renames = 0;
    hooks.rename = () => {
      renames += 1;
      if (renames === step) throw failure;
    };
    try {
      expect(() => writeCapture(root, text), `step ${step}`).toThrow(failure);
    } finally {
      hooks.rename = undefined;
    }
    expect(readdirSync(resolve(root, CAPTURE_DIRECTORY)), `step ${step}`).toEqual(['previous.json']);
    expect(readFileSync(resolve(root, CAPTURE_PREVIOUS), 'utf8'), `step ${step}`).toBe(junk);
  }
  // Written at last, the capture drops the previous.json that is no capture and publishes current.json.
  expect(writeCapture(root, text)).toMatchObject({ prior: null, previous: null, rotated: false });
  expect(readdirSync(resolve(root, CAPTURE_DIRECTORY))).toEqual(['current.json']);
  expect(readFileSync(resolve(root, CAPTURE_CURRENT), 'utf8')).toBe(text);
});

it('reads the capture pair only when asked: never on open, on a plain read or on a refresh', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8');
  const first = open(root, { cache: false }),
    revision = first.revision;
  writeCapture(root, captureOf(first));
  first.close();
  edit(root, text);
  const snapshotFiles = (): readonly string[] =>
    (hooks.touched ?? []).filter((path) => path.includes(`/${CAPTURE_DIRECTORY}`));
  for (const cache of [false, true]) {
    hooks.touched = [];
    const db = open(root, { cache });
    try {
      // Every frozen Door route reads through these; none of them asks for the retained pair.
      db.records();
      db.get(methodId);
      db.snapshot();
      db.directedView(methodId);
      db.resolveSeat(methodPath);
      db.inertDeclarations();
      db.search('procedure');
      db.refresh();
      db.records();
      expect(snapshotFiles(), `cache ${cache}`).toEqual([]);
      // Asked, the handle reads the pair, and the capture at another revision is its previous snapshot.
      expect(db.previousRevision).toBe(revision);
      expect(snapshotFiles().length).toBeGreaterThan(0);
    } finally {
      hooks.touched = undefined;
      db.close();
    }
  }
});

it('reads the captured revision again after a refresh and rotates the seeded pair it holds', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8');
  const first = open(root, { cache: false }),
    r1 = first.revision;
  writeCapture(root, captureOf(first));
  first.close();
  const db = open(root, { cache: false });
  try {
    // Seeded at the captured revision: the capture is current, and no capture at another revision is retained.
    expect([db.previousRevision, db.capturedRevision]).toEqual([undefined, r1]);
    edit(root, text);
    db.refresh();
    const r2 = db.revision;
    // The seeded current snapshot rotated into previous; nothing has captured the edit yet.
    expect([db.previousRevision, db.capturedRevision]).toEqual([r1, r1]);
    expect(db.staleness(methodId)).toBe('changed');
    // `ia capture` runs between two refreshes at one revision: previous stays, the captured revision is read again.
    expect(writeCapture(root, captureOf(db))).toMatchObject({ prior: r1, previous: r1, rotated: true });
    db.refresh();
    expect([db.previousRevision, db.capturedRevision]).toEqual([r1, r2]);
    // The next edit rotates the snapshot the handle held, which is the one just captured.
    put(root, methodPath, text.replace('Sample fixture statement 3.', 'Edited twice.'));
    db.refresh();
    expect([db.previousRevision, db.capturedRevision]).toEqual([r2, r2]);
  } finally {
    db.close();
  }
  // A handle that never asked before refreshing answers the same, its seed read only when first asked.
  const unasked = workspace(),
    base = readFileSync(resolve(unasked, methodPath), 'utf8');
  const seed = open(unasked, { cache: false }),
    s1 = seed.revision;
  writeCapture(unasked, captureOf(seed));
  seed.close();
  const later = open(unasked, { cache: false });
  try {
    edit(unasked, base);
    later.refresh();
    writeCapture(unasked, captureOf(later));
    later.refresh();
    expect([later.previousRevision, later.capturedRevision]).toEqual([s1, later.revision]);
  } finally {
    later.close();
  }
});

it('refuses a snapshot directory, or .ia/work, that is not a directory, before anything is written', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    text = captureOf(db);
  db.close();
  put(root, CAPTURE_DIRECTORY, 'a file where the snapshot directory belongs');
  expect(() => writeCapture(root, text)).toThrow(
    expect.objectContaining({
      code: 'IA-DB-PATH-UNSAFE',
      message: `IA-DB-PATH-UNSAFE: ${CAPTURE_DIRECTORY} is not a directory`,
    }),
  );
  expect(readFileSync(resolve(root, CAPTURE_DIRECTORY), 'utf8')).toBe('a file where the snapshot directory belongs');
  rmSync(resolve(root, '.ia/work'), { recursive: true, force: true });
  put(root, '.ia/work', 'a file where .ia/work belongs');
  expect(() => writeCapture(root, text)).toThrow(
    expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE', message: 'IA-DB-PATH-UNSAFE: .ia/work is not a directory' }),
  );
  expect(readFileSync(resolve(root, '.ia/work'), 'utf8')).toBe('a file where .ia/work belongs');
  rmSync(resolve(root, '.ia/work'));
  expect(writeCapture(root, text)).toMatchObject({ prior: null, rotated: false });
});

it('retains nothing in the cache-free editor reader', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    editor = new EditorDatabase(root);
  try {
    const before = editor.current.get(methodId)!.digest;
    expect(editor.current.previousRevision).toBeUndefined();
    expect(new Set(editor.current.records().map((r) => editor.current.staleness(r.identity)))).toEqual(
      new Set(['new']),
    );
    expect(editor.current.readiness(methodId, before)).toBe('current');
    const next = editor.update([
      { path: methodPath, text: text.replace('Sample fixture statement 3.', 'An edited cell.'), version: 1 },
    ]);
    expect(next.previousRevision).toBeUndefined();
    expect(next.staleness(methodId)).toBe('new');
    expect(next.readiness(methodId, before)).toBe('unknown');
    expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
  } finally {
    editor.close();
  }
});
