import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CAPTURE_CURRENT,
  CAPTURE_DIRECTORY,
  CAPTURE_FORMAT,
  CAPTURE_PREVIOUS,
  open,
  planCapture,
  writeCapture,
} from '../src/index.js';
import type { Snapshot } from '../src/index.js';
import type { Location } from '@inventarch/language';
import { EditorDatabase } from '../src/editor/index.js';
import { OPENED_READ_FLAGS } from '../src/named.js';
import { descriptors, fifo, outcome, replacedAtOpen, socket } from './file-races.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

/**
 * Seams on node:fs: the renames a capture makes, so a test can fail one of them, and the paths every stat or read
 * touches, so a test can show that a handle opens no capture file until it is asked. Every call passes through; the
 * opens, reads and closes are mocks a test can replace or inspect (file-races.ts).
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
    readFileSync: vi.fn(touching(actual.readFileSync)),
    openSync: vi.fn(touching(actual.openSync)),
    closeSync: vi.fn(actual.closeSync),
  };
});
afterEach(() => {
  vi.mocked(openSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(closeSync).mockClear();
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
  `${JSON.stringify({
    format: CAPTURE_FORMAT,
    revision: db.revision,
    authoredRevision: db.authoredRevision,
    membership: db.snapshot().membership,
  })}\n`;
/** A law the tests below place at runtime (band 0) through the locations override, as evidence would be placed. */
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' },
  runtimePath = '.ia/src/systems/governance-system/records/runtime-rule.ia',
  runtimeId = 'governance-system/governance/law/runtime-rule',
  runtimeLaw =
    '#! ia 1.0\n@law runtime-rule\n  meaning\n    says "A law placed at runtime."\n    answers "What does it require?"\n  governance\n    severity advisory\n';
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
  ['a short authored revision', (good: Pair) => JSON.stringify({ ...seeded(good), authoredRevision: '1'.repeat(63) })],
  ['a null authored revision', (good: Pair) => JSON.stringify({ ...seeded(good), authoredRevision: null })],
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

it('keys retention on the authored revision, which a runtime-band source leaves while the revision moves', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    locations = { [runtimePath]: RUNTIME },
    db = open(root, { cache: false, locations });
  try {
    // With no source at runtime placement the authored revision is the revision, on the handle and in each snapshot.
    expect(db.authoredRevision).toBe(db.revision);
    for (const options of [{}, { phase: 'act' as const }, { within: db.resolveScope({ root: 'team' }).token }]) {
      const snapshot = db.snapshot(options);
      expect(snapshot.authoredRevision).toBe(snapshot.revision);
    }
    const first = { revision: db.revision, authored: db.authoredRevision },
      before = db.get(methodId)!.digest;
    writeCapture(root, captureOf(db));
    // An authored edit moves both revisions, and its capture rotates the first one into previous.json.
    edit(root, text);
    db.refresh();
    const edited = { revision: db.revision, authored: db.authoredRevision };
    expect(edited.revision).not.toBe(first.revision);
    expect(edited.authored).not.toBe(first.authored);
    expect(writeCapture(root, captureOf(db))).toMatchObject({ previous: first.revision, rotated: true });
    db.refresh();
    expect([db.capturedAuthoredRevision, db.previousAuthoredRevision]).toEqual([edited.authored, first.authored]);
    // A runtime-band source appears: the revision moves and the authored revision does not, so nothing rotates. The
    // previous snapshot is still the first capture: the edit still reads changed, the runtime-band record new.
    put(root, runtimePath, runtimeLaw);
    const placed = db.refresh();
    expect(db.get(runtimeId)?.band).toBe(0);
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(placed.revision).toBe(db.revision);
    expect(db.revision).not.toBe(edited.revision);
    expect([db.authoredRevision, placed.authoredRevision]).toEqual([edited.authored, edited.authored]);
    expect([db.previousRevision, db.previousAuthoredRevision]).toEqual([first.revision, first.authored]);
    expect(stale(db, placed)).toEqual([
      [methodId, 'changed'],
      [runtimeId, 'new'],
    ]);
    expect(db.readiness(methodId, before)).toBe('previous');
    // The capture is still this workspace's, at the handle's authored revision though not at its revision.
    expect([db.capturedRevision, db.capturedAuthoredRevision]).toEqual([edited.revision, edited.authored]);
    const later = open(root, { cache: false, locations });
    try {
      expect([later.capturedAuthoredRevision, later.previousAuthoredRevision]).toEqual([
        edited.authored,
        first.authored,
      ]);
      expect(later.staleness(methodId)).toBe('changed');
    } finally {
      later.close();
    }
    // Capturing the runtime-band change rotates nothing: previous.json keeps the first capture.
    const unchanged = placed.records.length - 1;
    expect(planCapture(root, captureOf(db))).toMatchObject({
      prior: edited.revision,
      previous: first.revision,
      rotated: false,
      added: 1,
      changed: 0,
      unchanged,
    });
    expect(writeCapture(root, captureOf(db))).toMatchObject({ previous: first.revision, rotated: false, added: 1 });
    db.refresh();
    expect([db.capturedRevision, db.capturedAuthoredRevision]).toEqual([db.revision, edited.authored]);
    expect(db.previousAuthoredRevision).toBe(first.authored);
    // Undoing the edit moves both again: the authored revision is the first one's, its runtime-band source left out,
    // the revision is not, and the edited snapshot is previous.
    put(root, methodPath, text);
    db.refresh();
    expect(db.authoredRevision).toBe(first.authored);
    expect(db.revision).not.toBe(first.revision);
    expect(db.previousAuthoredRevision).toBe(edited.authored);
    expect(db.staleness(methodId)).toBe('changed');
  } finally {
    db.close();
  }
});

it('trusts a capture by its authored revision and the rows of its records not at runtime placement', () => {
  const root = workspace(),
    locations = { [runtimePath]: RUNTIME },
    other = '1'.repeat(64);
  put(root, runtimePath, runtimeLaw);
  const probe = open(root, { cache: false, locations }),
    good = probe.snapshot();
  probe.close();
  expect(good.authoredRevision).not.toBe(good.revision);
  const captured = (capture: Record<string, unknown>) => {
    put(root, CAPTURE_CURRENT, JSON.stringify({ format: CAPTURE_FORMAT, ...capture }));
    const db = open(root, { cache: false, locations });
    try {
      return [db.capturedRevision, db.capturedAuthoredRevision, db.previousAuthoredRevision];
    } finally {
      db.close();
    }
  };
  // Rows that differ from the fresh snapshot's only at runtime placement, at another revision: this workspace's
  // capture at its authored revision, so it is current and no previous snapshot is seeded.
  const authored = good.membership.filter((row) => row.identity !== runtimeId);
  expect(captured({ revision: other, authoredRevision: good.authoredRevision, membership: authored })).toEqual([
    other,
    good.authoredRevision,
    undefined,
  ]);
  // Another authored row at that authored revision: not this workspace's capture there, so the pair seeds nothing,
  // whether its revision is the fresh one or another (the runtime band changed since).
  const forged = good.membership.map((row) => (row.identity === methodId ? { ...row, digest: '0'.repeat(64) } : row));
  for (const revision of [good.revision, other])
    expect(captured({ revision, authoredRevision: good.authoredRevision, membership: forged }), revision).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  // Another root alone, as a runtime-band @workspace declares one, decides nothing: no retained read takes a root.
  const rerooted = authored.map((row) => (row.identity === methodId ? { ...row, root: '.ia/src/elsewhere' } : row));
  expect(captured({ revision: other, authoredRevision: good.authoredRevision, membership: rerooted })).toEqual([
    other,
    good.authoredRevision,
    undefined,
  ]);
  // A capture written before the authored revision names its revision as its authored one: at another authored
  // revision than the fresh one, it is trusted as written, stale and previous.
  expect(captured({ revision: good.revision, membership: good.membership })).toEqual([
    good.revision,
    good.revision,
    good.revision,
  ]);
});

it('keeps a capture current across a runtime-band @workspace that roots records not at runtime placement', () => {
  // D02a roots a record by what every admitted @workspace declares, a runtime-band one included, so one declaring an
  // authored root moves the roots of authored rows while the authored revision stays: the capture is still trusted.
  const root = workspace(),
    path = '.ia/src/systems/workspace-system/records/runtime-workspace.ia',
    db = open(root, { cache: false, locations: { [path]: RUNTIME } }),
    rootOf = () => db.snapshot().membership.find((row) => row.identity === methodId)!.root;
  try {
    writeCapture(root, captureOf(db));
    const first = { revision: db.revision, authored: db.authoredRevision, root: rootOf() };
    put(
      root,
      path,
      '#! ia 1.0\n@workspace runtime-workspace\n  meaning\n    says "A workspace placed at runtime."\n    answers "Which records does it root?"\n  composition\n    systems [@system governance-system]\n    sources [".ia/src/systems/governance-system/records @authored"]\n',
    );
    db.refresh();
    expect(db.get('workspace-system/definition/workspace/runtime-workspace')?.band).toBe(0);
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect([db.revision === first.revision, db.authoredRevision]).toEqual([false, first.authored]);
    expect([first.root, rootOf()]).toEqual([
      '.ia/src/systems/governance-system',
      '.ia/src/systems/governance-system/records',
    ]);
    expect([db.capturedRevision, db.capturedAuthoredRevision]).toEqual([first.revision, first.authored]);
  } finally {
    db.close();
  }
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

it('plans what writeCapture writes, with the identities it counts, and creates and writes nothing', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    otherPath = '.ia/src/systems/governance-system/records/another-procedure.ia',
    otherId = methodId.replace('sample-procedure', 'another-procedure');
  const snapshot = () => {
    const db = open(root, { cache: false });
    try {
      return captureOf(db);
    } finally {
      db.close();
    }
  };
  /** The pair's bytes, mtimes and directory listing, so a plan is shown to leave them exactly as they were. */
  const pair = () => {
    const directory = resolve(root, CAPTURE_DIRECTORY);
    return existsSync(directory)
      ? readdirSync(directory)
          .sort()
          .map((name) => [name, readFileSync(join(directory, name)), statSync(join(directory, name)).mtimeMs])
      : null;
  };
  /** planCapture with every rename failing, so a plan that renamed anything would throw. */
  const plan = (capture: string) => {
    const before = pair();
    hooks.rename = () => {
      throw new Error('a plan renames nothing');
    };
    try {
      return planCapture(root, capture);
    } finally {
      hooks.rename = undefined;
      expect(pair()).toEqual(before);
    }
  };
  /** The plan is the write's result with the identities its counts count, as writeCapture then writes it. */
  const agree = (capture: string) => {
    const { identities, ...result } = plan(capture);
    expect(writeCapture(root, capture)).toEqual(result);
    return identities;
  };
  const r1 = snapshot(),
    all = (JSON.parse(r1) as { membership: { identity: string }[] }).membership.map((row) => row.identity);
  expect(() => plan('{"format":"ia.compiled.v1"}')).toThrow(TypeError);
  // Never captured: no prior, every identity new and sorted, and no .ia/work directory is created.
  expect(plan(r1)).toEqual({
    prior: null,
    ignored: null,
    previous: null,
    rotated: false,
    changed: 0,
    unchanged: 0,
    added: all.length,
    removed: 0,
    identities: { changed: [], added: [...all].sort(), removed: [] },
  });
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
  expect(agree(r1).added).toHaveLength(all.length);
  // One edit: exactly that identity is changed, and the plan rotates as the write then does.
  edit(root, text);
  const r2 = snapshot();
  expect(plan(r2)).toMatchObject({ prior: JSON.parse(r1).revision, previous: JSON.parse(r1).revision, rotated: true });
  expect(agree(r2)).toEqual({ changed: [methodId], added: [], removed: [] });
  // With both files present a plan leaves both as they were, bytes and mtimes.
  put(root, methodPath, text.replace('Sample fixture statement 3.', 'Edited twice.'));
  expect(plan(snapshot()).identities).toEqual({ changed: [methodId], added: [], removed: [] });
  expect(readFileSync(resolve(root, CAPTURE_PREVIOUS), 'utf8')).toBe(r1);
  // An added record is new, and once captured, deleting it is removed.
  put(root, otherPath, text.replace('sample-procedure', 'another-procedure'));
  expect(agree(snapshot())).toEqual({ changed: [methodId], added: [otherId], removed: [] });
  rmSync(resolve(root, otherPath));
  expect(agree(snapshot())).toEqual({ changed: [], added: [], removed: [otherId] });
  // At an unchanged revision nothing rotates and nothing is named.
  expect(agree(snapshot())).toEqual({ changed: [], added: [], removed: [] });
  // The checks are the write's: an entry that is not a directory refuses before anything is read.
  rmSync(resolve(root, '.ia/work'), { recursive: true, force: true });
  put(root, '.ia/work', 'a file where .ia/work belongs');
  expect(() => plan(r1)).toThrow(
    expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE', message: 'IA-DB-PATH-UNSAFE: .ia/work is not a directory' }),
  );
});

it('sorts each identity list of a plan by code unit, whatever order either document holds its rows in', () => {
  const root = workspace();
  /** An `ia-snapshot-1` document whose membership rows are in the order given, each with its digest. */
  const document = (revision: string, rows: readonly (readonly [string, string])[]) =>
    `${JSON.stringify({
      format: CAPTURE_FORMAT,
      revision: revision.repeat(64),
      membership: rows.map(([identity, digest]) => ({ identity, root: '', band: 100, digest: digest.repeat(64) })),
    })}\n`;
  writeCapture(
    root,
    document('a', [
      ['z/changed', 'a'],
      ['a/changed', 'a'],
      ['y/gone', 'a'],
      ['B/gone', 'a'],
      ['m/kept', 'a'],
    ]),
  );
  // Code-unit order puts an upper-case letter before every lower-case one, which a locale comparison would not.
  expect(
    planCapture(
      root,
      document('b', [
        ['z/changed', 'b'],
        ['c/new', 'a'],
        ['m/kept', 'a'],
        ['Z/new', 'a'],
        ['a/changed', 'b'],
      ]),
    ),
  ).toMatchObject({
    changed: 2,
    unchanged: 1,
    added: 2,
    removed: 2,
    identities: { changed: ['a/changed', 'z/changed'], added: ['Z/new', 'c/new'], removed: ['B/gone', 'y/gone'] },
  });
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
      // Nor does words (D09a), which a runtime scope key's word is checked against.
      db.words();
      // Nor does roots (D02c), from which runtime reads a workspace's capture members.
      db.roots();
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

/** A capture of no records at revision `letter` x 64, as `ia capture` writes one. */
const captureText = (letter: string): string =>
  `${JSON.stringify({ format: CAPTURE_FORMAT, revision: letter.repeat(64), membership: [] })}\n`;
/** A workspace of no sources whose current.json holds the capture at revision a x 64. */
const pairRoot = (): string => {
  const root = workspace(false);
  put(root, CAPTURE_CURRENT, captureText('a'));
  return root;
};
const planned = (root: string): unknown => outcome(() => planCapture(root, captureText('b')));
/** The revision a handle opened at `root` seeds as captured, read through the capture pair. */
const seededCapture = (root: string): string | undefined => {
  const db = open(root, { cache: false });
  try {
    return db.capturedRevision;
  } finally {
    db.close();
  }
};
const irregularCapture = {
  code: 'IA-DB-PATH-UNSAFE',
  message: `IA-DB-PATH-UNSAFE: ${CAPTURE_CURRENT} is not a regular file`,
  path: CAPTURE_CURRENT,
};
it('reads a capture through the descriptor it opens, and closes it when it reads it and when its read fails', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const root = pairRoot(),
    file = resolve(root, CAPTURE_CURRENT),
    opened = await descriptors(file);
  expect(planned(root)).toMatchObject({ prior: 'a'.repeat(64), ignored: null });
  expect(opened).toHaveLength(1);
  expect(readFileSync).toHaveBeenCalledWith(opened[0]);
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path) === file)).toEqual([]);
  expect(closeSync).toHaveBeenCalledWith(opened[0]);
  // A read of that descriptor fails: a plan throws the error as it is, and a handle seeds nothing from the file.
  const failure = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
  vi.mocked(readFileSync).mockImplementation((...args: Parameters<typeof readFileSync>) => {
    if (args[0] === opened.at(-1)) throw failure;
    return actual.readFileSync(...args);
  });
  vi.mocked(closeSync).mockClear();
  expect(planned(root)).toBe(failure);
  expect(opened).toHaveLength(2);
  expect(closeSync).toHaveBeenCalledWith(opened[1]);
  expect(seededCapture(root)).toBeUndefined();
  expect(opened).toHaveLength(3);
  expect(closeSync).toHaveBeenCalledWith(opened[2]);
});
/**
 * Plans, writes and seeds from a capture whose current.json `replace` replaces as it is opened, after entryAt judged it
 * a regular file, and checks each is refused, writes nothing and seeds nothing, and closes each descriptor it opened.
 */
const replacedCapture = async (replace: (root: string, file: string) => Promise<() => void>, opens: boolean) => {
  const [planning, writing, seeding] = [pairRoot(), pairRoot(), pairRoot()],
    files = [planning, writing, seeding].map((root) => resolve(root, CAPTURE_CURRENT)),
    replacements = new Map<string, () => void>();
  for (const [index, root] of [planning, writing, seeding].entries())
    replacements.set(files[index]!, await replace(root, files[index]!));
  const { blocking, opened } = await replacedAtOpen(replacements);
  const reads: [string, () => void][] = [
    [files[0]!, () => expect(planned(planning)).toMatchObject(irregularCapture)],
    [
      files[1]!,
      () => {
        expect(outcome(() => writeCapture(writing, captureText('b')))).toMatchObject(irregularCapture);
        expect(readdirSync(resolve(writing, CAPTURE_DIRECTORY))).toEqual(['current.json']);
      },
    ],
    [files[2]!, () => expect(seededCapture(seeding)).toBeUndefined()],
  ];
  for (const [file, read] of reads) {
    // Each read closes what it opened before it returns; what does not open (a socket) leaves no descriptor.
    vi.mocked(closeSync).mockClear();
    read();
    expect(opened.has(file)).toBe(opens);
    expect(vi.mocked(closeSync).mock.calls.some(([fd]) => opened.has(file) && fd === opened.get(file))).toBe(opens);
  }
  expect(replacements.size).toBe(0);
  expect(blocking).toEqual([]);
};
it('refuses a capture a directory replaces after it is checked, writing nothing, closing what it opened, and seeds nothing from it', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  await replacedCapture(
    async (_root, file) => () => {
      actual.rmSync(file);
      actual.mkdirSync(file);
    },
    true,
  );
});
it.skipIf(process.platform === 'win32')(
  'refuses a capture a FIFO or a socket replaces after it is checked, without waiting for a writer, writing nothing, and seeds nothing from it',
  async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const standIn = (root: string, file: string) => () => actual.renameSync(resolve(root, 'stand-in'), file);
    await replacedCapture(async (root, file) => {
      await fifo(resolve(root, 'stand-in'));
      return standIn(root, file);
    }, true);
    await replacedCapture(async (root, file) => {
      await socket(root, resolve(root, 'stand-in'));
      return standIn(root, file);
    }, false);
  },
);
it.skipIf(process.platform === 'win32')(
  'refuses a capture a link replaces after it is checked, and seeds nothing from the file it names',
  async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const planning = pairRoot(),
      seeding = pairRoot(),
      roots = [planning, seeding];
    // The link names a capture at another revision, which a handle would trust as written.
    for (const root of roots) put(root, 'outside.json', captureText('c'));
    vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
      const root = roots.find((candidate) => String(args[0]) === resolve(candidate, CAPTURE_CURRENT));
      if (root !== undefined && !actual.lstatSync(String(args[0])).isSymbolicLink()) {
        actual.rmSync(String(args[0]));
        actual.symlinkSync(resolve(root, 'outside.json'), String(args[0]));
      }
      return actual.openSync(...args);
    });
    expect(planned(planning)).toMatchObject({
      code: 'IA-DB-PATH-UNSAFE',
      message: `IA-DB-PATH-UNSAFE: Symlink/junction traversal is not admitted: ${resolve(planning, CAPTURE_CURRENT)}`,
      path: CAPTURE_CURRENT,
    });
    expect(seededCapture(seeding)).toBeUndefined();
    for (const root of roots) expect(actual.lstatSync(resolve(root, CAPTURE_CURRENT)).isSymbolicLink()).toBe(true);
  },
);
it.runIf(constants.O_NOFOLLOW)(
  'keeps the capture read from a file whose name passes to another file once it is opened, where the open refuses links',
  async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = pairRoot(),
      file = resolve(root, CAPTURE_CURRENT),
      other = resolve(root, 'other.json');
    put(root, 'other.json', captureText('d'));
    // The open refuses a link put at the name, so the reader never checks the name again: as before, it keeps what it read.
    vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]) === file && actual.existsSync(other)) actual.renameSync(other, file);
      return fd;
    });
    expect(planned(root)).toMatchObject({ prior: 'a'.repeat(64), ignored: null });
    expect(actual.readFileSync(file, 'utf8')).toBe(captureText('d'));
  },
);
it.skipIf(!constants.O_NOCTTY)(
  'opens a capture with the no-controlling-terminal flag where the platform has it',
  () => {
    const root = pairRoot(),
      file = resolve(root, CAPTURE_CURRENT);
    vi.mocked(openSync).mockClear();
    expect(planned(root)).toMatchObject({ prior: 'a'.repeat(64), ignored: null });
    const flags = vi
      .mocked(openSync)
      .mock.calls.filter(([path]) => String(path) === file)
      .map(([, flags]) => Number(flags));
    expect(flags).toEqual([OPENED_READ_FLAGS]);
    expect(flags[0]! & constants.O_NOCTTY).toBe(constants.O_NOCTTY);
  },
);

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
