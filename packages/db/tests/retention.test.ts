import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { open } from '../src/index.js';
import type { Snapshot } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

const retainedPath = '.ia/.iadb/snapshots.json';
const otherId = 'governance-system/governance/law/sample-rule';
const edit = (root: string, text: string) =>
  put(root, methodPath, text.replace('Sample fixture statement 3.', 'An edited cell.'));
/** Every identity of the snapshot whose staleness is not `unchanged`, with its staleness. */
const stale = (db: ReturnType<typeof open>, snapshot: Snapshot) =>
  snapshot.records.flatMap((r) =>
    db.staleness(r.identity) === 'unchanged' ? [] : [[r.identity, db.staleness(r.identity)]],
  );

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

it('lets a new handle on the same root see the same answer from the persisted pair', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    earlier = open(root),
    refreshed = open(root),
    revision = earlier.revision,
    before = earlier.get(methodId)!.digest;
  earlier.close();
  edit(root, text);
  // A process that opens after the edit rotates the capture the earlier process published.
  const later = open(root);
  try {
    expect(later.revision).not.toBe(revision);
    expect(later.previousRevision).toBe(revision);
    expect(stale(later, later.snapshot())).toEqual([[methodId, 'changed']]);
    expect(later.readiness(methodId, before)).toBe('previous');
    expect(later.readiness(methodId, later.get(methodId)!.digest)).toBe('current');
    // A handle that lived through the edit agrees after its refresh, and a plain open at that revision keeps it.
    refreshed.refresh();
    expect(refreshed.previousRevision).toBe(revision);
    const again = open(root);
    try {
      expect(again.previousRevision).toBe(revision);
      for (const record of again.records())
        expect(again.staleness(record.identity)).toBe(later.staleness(record.identity));
      expect(again.cache.observations).toEqual([]);
    } finally {
      again.close();
    }
    const pair = JSON.parse(readFileSync(resolve(root, retainedPath), 'utf8')) as {
      format: string;
      current: Snapshot;
      previous: Snapshot;
    };
    expect(pair.format).toBe('ia-snapshots-1');
    expect([pair.current.revision, pair.previous.revision]).toEqual([later.revision, revision]);
    expect(pair.current.membership).toEqual(later.snapshot().membership);
  } finally {
    later.close();
    refreshed.close();
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

type Pair = { readonly current: Pick<Snapshot, 'revision' | 'membership'> };
/**
 * A well-formed previous snapshot at another revision, with `row` merged into the edited record's row: each forgery
 * below carries one, so a file trusted despite its defect would visibly seed `previousRevision`.
 */
const seeded = (good: Pair, row: Record<string, unknown> = {}) => ({
  revision: '1'.repeat(64),
  membership: good.current.membership.map((r) => (r.identity === methodId ? { ...r, ...row } : r)),
});
it.each([
  ['broken JSON', () => '{'],
  ['a foreign format', (good: Pair) => JSON.stringify({ ...good, format: 'ia-snapshots-0', previous: seeded(good) })],
  ['an extra top-level key', (good: Pair) => JSON.stringify({ ...good, previous: seeded(good), extra: true })],
  ['an extra snapshot key', (good: Pair) => JSON.stringify({ ...good, previous: { ...seeded(good), extra: true } })],
  [
    'a short revision',
    (good: Pair) => JSON.stringify({ ...good, previous: { ...seeded(good), revision: '1'.repeat(63) } }),
  ],
  [
    'a row missing keys',
    (good: Pair) => JSON.stringify({ ...good, previous: { ...seeded(good), membership: [{ identity: methodId }] } }),
  ],
  ['an extra row key', (good: Pair) => JSON.stringify({ ...good, previous: seeded(good, { extra: true }) })],
  ['a non-text root', (good: Pair) => JSON.stringify({ ...good, previous: seeded(good, { root: 1 }) })],
  ['an invalid band', (good: Pair) => JSON.stringify({ ...good, previous: seeded(good, { band: 99 }) })],
  ['a non-hex digest', (good: Pair) => JSON.stringify({ ...good, previous: seeded(good, { digest: 'Z'.repeat(64) }) })],
  [
    'a duplicate identity',
    (good: Pair) => {
      const previous = seeded(good),
        row = previous.membership.find((r) => r.identity === methodId)!;
      return JSON.stringify({
        ...good,
        previous: { ...previous, membership: [...previous.membership, { ...row, digest: '0'.repeat(64) }] },
      });
    },
  ],
  ['a previous snapshot at the current revision', (good: Pair) => JSON.stringify({ ...good, previous: good.current })],
  [
    'a forged current snapshot',
    (good: Pair) =>
      JSON.stringify({
        ...good,
        current: { ...good.current, membership: seeded(good, { digest: '0'.repeat(64) }).membership },
        previous: seeded(good),
      }),
  ],
])('never trusts a retained file holding %s: it warns, seeds nothing and replaces the file', (_name, forge) => {
  const root = workspace(),
    path = resolve(root, retainedPath);
  open(root).close();
  const good = readFileSync(path, 'utf8');
  put(root, retainedPath, forge(JSON.parse(good)));
  const db = open(root);
  try {
    expect(db.previousRevision).toBeUndefined();
    expect(db.staleness(methodId)).toBe('new');
    expect(db.cache.state).toBe('hit');
    expect(db.cache.observations).toEqual([
      expect.objectContaining({ code: 'IA-DB-CACHE-UNAVAILABLE', severity: 'warning', path: retainedPath }),
    ]);
    expect(readFileSync(path, 'utf8')).toBe(good);
  } finally {
    db.close();
  }
});

it('keeps reads usable when the retained file cannot be read or published', () => {
  const root = workspace();
  mkdirSync(resolve(root, retainedPath), { recursive: true });
  const db = open(root);
  try {
    expect(db.records().length).toBeGreaterThan(100);
    expect(db.cache.state).toBe('written');
    expect(db.previousRevision).toBeUndefined();
    expect(db.cache.observations.map((o) => [o.code, o.severity, o.path])).toEqual([
      ['IA-DB-CACHE-UNAVAILABLE', 'warning', retainedPath],
      ['IA-DB-CACHE-UNAVAILABLE', 'warning', retainedPath],
    ]);
  } finally {
    db.close();
  }
});

it('neither reads nor publishes the retained file with the cache disabled', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8');
  open(root).close();
  const pair = readFileSync(resolve(root, retainedPath), 'utf8');
  edit(root, text);
  const db = open(root, { cache: false });
  try {
    expect(db.previousRevision).toBeUndefined();
    expect(db.cache).toEqual({ state: 'disabled', observations: [] });
    const first = db.revision;
    put(root, methodPath, text);
    db.refresh();
    expect(db.previousRevision).toBe(first);
    expect(stale(db, db.snapshot())).toEqual([[methodId, 'changed']]);
    expect(readFileSync(resolve(root, retainedPath), 'utf8')).toBe(pair);
  } finally {
    db.close();
  }
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
