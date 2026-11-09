/**
 * The tracked list (consumer CLI contract §2.16): `<IA home>/tracked-workspaces.json`, a personal list of workspace
 * roots kept apart from the MCP door's `workspace-locations.json`, and the bounded folder walk `ia workspaces find`
 * reads. Every home and workspace is a scratch directory.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Refusal } from '../src/consumer.js';
import {
  defaultTrackId,
  findWorkspaces,
  idClashes,
  sameRoot,
  readTracked,
  TRACKED_FILE,
  TRACKED_FORMAT,
  trackedState,
  trackWorkspace,
  trackWorkspaces,
  untrackWorkspace,
} from '../src/tracked.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const NOW = new Date('2026-11-03T12:00:00.000Z');
const home = (): string => resolve(scratch('tracked-home'), '.ia');
const spelled = (path: string): string => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path);
/** A directory holding `.ia/src`, with each `@workspace` name declared in its own file. */
function workspaceAt(root: string, ...names: readonly string[]): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  names.forEach((name, index) => writeFileSync(resolve(root, `.ia/src/w${index}.ia`), `@workspace ${name}\n`));
  return root;
}
const refusalOf = async (action: () => unknown): Promise<Refusal> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('Expected a refusal');
};
const file = (at: string): string => resolve(at, TRACKED_FILE);

it('readTracked is empty when the file is absent', () => {
  expect(readTracked(home())).toEqual([]);
});

it('adds a workspace with its @workspace name as id', async () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'team-kb');
  const { status, row } = await trackWorkspace(at, { root }, NOW);
  expect(status).toBe('added');
  expect(row).toEqual({ id: 'team-kb', root: realpathSync(root), added: NOW.toISOString() });
  expect(readTracked(at)).toEqual([row]);
  expect(JSON.parse(readFileSync(file(at), 'utf8'))).toEqual({
    format: TRACKED_FORMAT,
    formatVersion: 1,
    workspaces: [row],
  });
});

it('falls back to the folder name when no single @workspace is declared', () => {
  const two = workspaceAt(resolve(scratch('tracked'), 'My Repo'), 'one', 'two'),
    none = workspaceAt(resolve(scratch('tracked'), 'My Repo'));
  expect(defaultTrackId(two)).toBe('my-repo');
  expect(defaultTrackId(none)).toBe('my-repo');
  // Only a declaration at column 0 counts.
  writeFileSync(resolve(none, '.ia/src/nested.ia'), '  @workspace indented\n');
  expect(defaultTrackId(none)).toBe('my-repo');
});

it('adding a root again through a link changes nothing', async () => {
  const at = home(),
    parent = scratch('tracked'),
    root = workspaceAt(resolve(parent, 'repo'), 'linked'),
    link = resolve(parent, 'link');
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await trackWorkspace(at, { root }, NOW)).status).toBe('added');
  const again = await trackWorkspace(at, { root: link + (process.platform === 'win32' ? '\\' : '/') }, NOW);
  expect(again.status).toBe('already');
  expect(again.row.root).toBe(realpathSync(root));
  if (process.platform === 'win32')
    expect((await trackWorkspace(at, { root: root.toUpperCase() })).status).toBe('already');
  expect(readTracked(at)).toHaveLength(1);
});

it('refuses an id another root holds', async () => {
  const at = home(),
    first = workspaceAt(resolve(scratch('tracked'), 'ia'), 'ia'),
    second = workspaceAt(resolve(scratch('tracked'), 'ia'), 'ia');
  await trackWorkspace(at, { root: first }, NOW);
  const refusal = await refusalOf(() => trackWorkspace(at, { root: second }, NOW));
  expect(refusal.code).toBe('IA-CLI-TRACKED-ID');
  expect(refusal.exit).toBe(3);
  expect(refusal.message).toContain(realpathSync(first));
  expect(refusal.message).toContain(realpathSync(second));
  expect(refusal.message).toContain('--id');
  expect(refusal.next).toContain('ia workspaces add');
  expect(refusal.next).toContain('--id');
  expect(readTracked(at)).toHaveLength(1);
  // The suggested id is free, so the next command it names succeeds.
  const suggested = /--id (\S+)"/.exec(refusal.next!)![1]!;
  expect((await trackWorkspace(at, { root: second, id: suggested }, NOW)).row.id).toBe(suggested);
});

it('refuses two found roots that would take one id in the same write, naming both as found, not tracked', async () => {
  const at = home(),
    parent = scratch('tracked'),
    first = workspaceAt(resolve(parent, 'one'), 'app'),
    second = workspaceAt(resolve(parent, 'two'), 'app');
  const refusal = await refusalOf(() => trackWorkspaces(at, [first, second], NOW));
  expect(refusal.code).toBe('IA-CLI-TRACKED-ID');
  expect(refusal.exit).toBe(3);
  expect(refusal.message).toBe(
    `Two found workspaces would both take the id app: ${realpathSync(first)} and ${realpathSync(second)}`,
  );
  expect(refusal.message).not.toContain('already tracked');
  // An inert root is printed whole, with forward slashes on Windows so every shell there reads it alike.
  expect(refusal.next).toContain(`ia workspaces add ${spelled(realpathSync(second))} --id`);
  expect(readTracked(at)).toEqual([]);
  // The next command it names succeeds, and the same write then tracks the other root under the id.
  const suggested = /--id (\S+)"/.exec(refusal.next!)![1]!;
  expect((await trackWorkspace(at, { root: second, id: suggested }, NOW)).row.id).toBe(suggested);
  expect((await trackWorkspaces(at, [first, second], NOW)).map((row) => row.id)).toEqual(['app']);
  expect(readTracked(at).map((row) => row.id)).toEqual([suggested, 'app']);
});

it('suggests a different free id for each found root that clashes, so every remedy succeeds', async () => {
  const at = home(),
    parent = scratch('tracked'),
    roots = ['one', 'two', 'three'].map((name) => realpathSync(workspaceAt(resolve(parent, name, 'app')))),
    found = roots.map((root) => ({ root, id: defaultTrackId(root) }));
  expect(found.map((row) => row.id)).toEqual(['app', 'app', 'app']);
  const clashes = idClashes([], found);
  expect(clashes.map((clash) => clash.suggestion)).toEqual(['app-2', 'app-3']);
  // Following both remedies leaves the first root its id, and the same write then tracks it.
  for (const clash of clashes) await trackWorkspace(at, { root: clash.root, id: clash.suggestion }, NOW);
  expect((await trackWorkspaces(at, roots, NOW)).map((row) => row.id)).toEqual(['app']);
  expect(readTracked(at)).toHaveLength(3);
});

it('refuses a new id or label for a root already tracked', async () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  await trackWorkspace(at, { root }, NOW);
  expect((await trackWorkspace(at, { root, id: 'repo' })).status).toBe('already');
  for (const input of [{ id: 'other' }, { label: 'Mine' }]) {
    const refusal = await refusalOf(() => trackWorkspace(at, { root, ...input }));
    expect(refusal.code).toBe('IA-CLI-TRACKED-EXISTS');
    expect(refusal.next).toContain('ia workspaces remove repo');
  }
});

it('refuses an id outside the id rule as usage', async () => {
  const root = workspaceAt(resolve(scratch('tracked'), 'repo'));
  await expect(trackWorkspace(home(), { root, id: '-bad' })).rejects.toThrow(/id/);
});

it('refuses a root inside the IA home', async () => {
  const at = home(),
    inside = workspaceAt(resolve(at, 'nested'));
  const refusal = await refusalOf(() => trackWorkspace(at, { root: inside }, NOW));
  expect(refusal.code).toBe('IA-DIST-PATH-UNSAFE');
  expect(existsSync(file(at))).toBe(false);
});

it('refuses a directory with no .ia/src', async () => {
  const at = home();
  for (const root of [scratch('tracked'), resolve(scratch('tracked'), 'absent')]) {
    const refusal = await refusalOf(() => trackWorkspace(at, { root }, NOW));
    expect(refusal.code).toBe('IA-DB-ROOT-INVALID');
  }
  expect(existsSync(file(at))).toBe(false);
});

it('keeps unknown fields', async () => {
  const at = home(),
    first = workspaceAt(resolve(scratch('tracked'), 'first'), 'first'),
    second = workspaceAt(resolve(scratch('tracked'), 'second'), 'second');
  mkdirSync(at, { recursive: true });
  writeFileSync(
    file(at),
    JSON.stringify({
      format: TRACKED_FORMAT,
      formatVersion: 1,
      workspaces: [{ id: 'first', root: realpathSync(first), added: NOW.toISOString(), entry: 'x' }],
      note: 'y',
    }),
  );
  await trackWorkspace(at, { root: second }, NOW);
  const written = JSON.parse(readFileSync(file(at), 'utf8'));
  expect(written.note).toBe('y');
  expect(written.workspaces[0].entry).toBe('x');
  expect(written.workspaces.map((row: { id: string }) => row.id)).toEqual(['first', 'second']);
});

it('refuses a malformed file and leaves it as it was', async () => {
  const root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  const added = NOW.toISOString();
  const withRows = (...rows: unknown[]) =>
    JSON.stringify({ format: TRACKED_FORMAT, formatVersion: 1, workspaces: rows });
  const cases: readonly (readonly [string, string])[] = [
    ['{ not json', ''],
    ['[]', 'it is not a JSON object'],
    [JSON.stringify({ format: 'ia-tracked-workspaces-2', workspaces: [] }), 'not ' + TRACKED_FORMAT],
    [JSON.stringify({ format: TRACKED_FORMAT, workspaces: [] }), 'its formatVersion is undefined, not 1'],
    [JSON.stringify({ format: TRACKED_FORMAT, formatVersion: 2, workspaces: [] }), 'its formatVersion is 2, not 1'],
    [
      JSON.stringify({ format: 'ia-tracked-workspaces-1', formatVersion: 1, workspaces: [] }),
      'its format is "ia-tracked-workspaces-1", not ' + TRACKED_FORMAT,
    ],
    [JSON.stringify({ format: TRACKED_FORMAT, formatVersion: 1, workspaces: {} }), 'workspaces is not a list'],
    [withRows(1), 'workspaces[0] is not an object'],
    [withRows({ id: 'bad id', root, added }), 'workspaces[0] has no valid id'],
    [withRows({ id: 'x', root: 'relative', added }), 'x names no absolute root'],
    [withRows({ id: 'x', root }), 'x has no added time'],
    [withRows({ id: 'x', root, added: 5 }), 'x has no added time'],
    [withRows({ id: 'x', root, added, label: 5 }), 'x has a label that is not text'],
    [withRows({ id: 'x', root, added }, { id: 'x', root, added }), 'x is listed twice'],
  ];
  for (const [text, why] of cases) {
    const at = home();
    mkdirSync(at, { recursive: true });
    writeFileSync(file(at), text);
    for (const action of [() => readTracked(at), () => trackWorkspace(at, { root }, NOW)]) {
      const refusal = await refusalOf(action);
      expect(refusal.code).toBe('IA-CLI-TRACKED-INVALID');
      expect(refusal.where?.path).toBe(file(at));
      expect(refusal.message).toContain(why);
    }
    expect(readFileSync(file(at), 'utf8')).toBe(text);
  }
});

it('a row whose root is gone is missing, never dropped', async () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  const { row } = await trackWorkspace(at, { root }, NOW);
  expect(trackedState(row)).toBe('present');
  rmSync(resolve(root, '.ia'), { recursive: true });
  expect(trackedState(row)).toBe('missing');
  rmSync(root, { recursive: true });
  expect(trackedState(row)).toBe('missing');
  expect(readTracked(at)).toEqual([row]);
  // Adding another workspace keeps the missing row.
  await trackWorkspace(at, { root: workspaceAt(resolve(scratch('tracked'), 'other'), 'other') }, NOW);
  expect(readTracked(at).map((entry) => entry.id)).toEqual(['repo', 'other']);
});

it('untrack by id and by root', async () => {
  const at = home(),
    parent = scratch('tracked'),
    first = workspaceAt(resolve(parent, 'first'), 'first'),
    second = workspaceAt(resolve(parent, 'second'), 'second');
  await trackWorkspace(at, { root: first }, NOW);
  await trackWorkspace(at, { root: second }, NOW);
  expect((await untrackWorkspace(at, 'first', parent)).id).toBe('first');
  // A relative root is read against the cwd, and a gone root still matches by its spelling.
  const gone = realpathSync(second);
  rmSync(second, { recursive: true });
  expect((await untrackWorkspace(at, gone, resolve(parent, 'elsewhere'))).id).toBe('second');
  await trackWorkspace(at, { root: workspaceAt(first, 'first') }, NOW);
  expect((await untrackWorkspace(at, './first', parent)).root).toBe(realpathSync(first));
  expect(readTracked(at)).toEqual([]);
});

it('untrack refuses an unknown id', async () => {
  const at = home();
  const refusal = await refusalOf(() => untrackWorkspace(at, 'nothing', scratch('tracked')));
  expect(refusal.code).toBe('IA-CLI-TRACKED-UNKNOWN');
  expect(refusal.next).toContain('ia workspaces list');
});

it('never writes workspace-locations.json', async () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  await trackWorkspace(at, { root }, NOW);
  await untrackWorkspace(at, 'repo', root);
  expect(existsSync(resolve(at, 'workspace-locations.json'))).toBe(false);
});

it('finds workspaces to the depth limit', () => {
  const folder = scratch('tracked-walk');
  const one = workspaceAt(resolve(folder, 'a')),
    four = workspaceAt(resolve(folder, 'b/c/d/e')),
    five = workspaceAt(resolve(folder, 'f/g/h/i/j'));
  expect(findWorkspaces(folder, {})).toEqual([realpathSync(one), realpathSync(four)].sort());
  expect(findWorkspaces(folder, { depth: 5 })).toEqual(
    [realpathSync(one), realpathSync(four), realpathSync(five)].sort(),
  );
  expect(findWorkspaces(folder, { depth: 1 })).toEqual([realpathSync(one)]);
});

it('skips node_modules, dot folders, the IA home and linked worktrees', () => {
  const folder = scratch('tracked-walk');
  const kept = workspaceAt(resolve(folder, 'kept'));
  for (const skipped of ['node_modules/pkg', '.hidden/repo', '.ia-worktrees/wt', 'repo/.git/modules/x'])
    workspaceAt(resolve(folder, skipped));
  const linked = workspaceAt(resolve(folder, 'worktree'));
  writeFileSync(resolve(linked, '.git'), 'gitdir: elsewhere\n');
  const iaHome = resolve(folder, 'home');
  workspaceAt(resolve(iaHome, 'inside'));
  expect(findWorkspaces(folder, { iaHome })).toEqual([realpathSync(kept)]);
});

it('does not descend into a workspace it found', () => {
  const folder = scratch('tracked-walk');
  const outer = workspaceAt(resolve(folder, 'outer'));
  workspaceAt(resolve(outer, 'fixtures/inner'));
  expect(findWorkspaces(folder, {})).toEqual([realpathSync(outer)]);
  // The folder itself is a workspace: it is the one result.
  expect(findWorkspaces(outer, {})).toEqual([realpathSync(outer)]);
});

it('sameRoot judges two existing roots by device and inode alone, whatever their spelling', () => {
  const stats: Record<string, { dev: bigint; ino: bigint }> = {
    '/w/repo': { dev: 1n, ino: 10n },
    '/w/REPO': { dev: 1n, ino: 11n },
    '/w/alias': { dev: 1n, ino: 10n },
  };
  const stat = (path: string) => stats[path];
  // Two distinct directories whose names differ only by case are two roots, even where paths fold case.
  expect(sameRoot('/w/repo', '/w/REPO', stat)).toBe(false);
  expect(sameRoot('/w/repo', '/w/alias', stat)).toBe(true);
  // The spelling counts only for a path that no longer exists.
  expect(sameRoot('/w/gone', '/w/GONE', stat)).toBe(process.platform === 'win32' || process.platform === 'darwin');
  expect(sameRoot('/w/gone', '/w/gone', stat)).toBe(true);
  expect(sameRoot('/w/repo', '/w/REPO-gone', stat)).toBe(false);
});

it('sameRoot compares exact real paths when either side reports no identity (inode 0 or all ones)', () => {
  const ALL_ONES = 2n ** 64n - 1n;
  const stats: Record<string, { dev: bigint; ino: bigint }> = {
    '/w/a': { dev: 1n, ino: 0n },
    '/w/b': { dev: 1n, ino: 0n },
    '/w/c': { dev: 1n, ino: ALL_ONES },
    '/w/d': { dev: 1n, ino: ALL_ONES },
    '/w/e': { dev: 0n, ino: 0n },
    '/w/f': { dev: 0n, ino: 0n },
    '/w/real': { dev: 1n, ino: 7n },
    '/w/A': { dev: 1n, ino: 0n },
  };
  const stat = (path: string) => stats[path];
  // Each path is its own real path here, except /w/alias, a link to /w/a.
  const real = (path: string): string => (path === '/w/alias' ? '/w/a' : path);
  stats['/w/alias'] = { dev: 1n, ino: 0n };
  expect(sameRoot('/w/a', '/w/b', stat, real)).toBe(false);
  expect(sameRoot('/w/c', '/w/d', stat, real)).toBe(false);
  expect(sameRoot('/w/e', '/w/f', stat, real)).toBe(false);
  // One side unavailable is enough: a valid inode never matches an unavailable one by number.
  expect(sameRoot('/w/real', '/w/a', stat, real)).toBe(false);
  // The real paths are compared exactly, never folded.
  expect(sameRoot('/w/a', '/w/A', stat, real)).toBe(false);
  expect(sameRoot('/w/a', '/w/a', stat, real)).toBe(true);
  expect(sameRoot('/w/alias', '/w/a', stat, real)).toBe(true);
});

it.skipIf(process.platform !== 'linux')(
  'tracks, finds and removes two directories that differ only by case',
  async () => {
    const at = home(),
      parent = scratch('tracked'),
      lower = workspaceAt(resolve(parent, 'repo'), 'lower'),
      upper = workspaceAt(resolve(parent, 'REPO'), 'upper');
    await trackWorkspace(at, { root: lower }, NOW);
    expect((await trackWorkspace(at, { root: upper }, NOW)).status).toBe('added');
    expect((await untrackWorkspace(at, upper, parent)).id).toBe('upper');
    expect(readTracked(at).map((row) => row.id)).toEqual(['lower']);
  },
);

it('find applies the exclusions to the starting folder itself', () => {
  const at = home(),
    parent = scratch('tracked'),
    inHome = workspaceAt(resolve(at, 'nested')),
    worktree = workspaceAt(resolve(parent, 'worktree')),
    modules = workspaceAt(resolve(parent, 'node_modules')),
    ordinary = workspaceAt(resolve(parent, 'ordinary'));
  writeFileSync(resolve(worktree, '.git'), 'gitdir: ../elsewhere\n');
  // A dot folder and a link or junction are skipped as the walk skips them, even when they are the folder given.
  const dotted = workspaceAt(resolve(parent, '.private')),
    above = workspaceAt(resolve(parent, '.above')),
    link = resolve(parent, 'link');
  workspaceAt(resolve(above, 'inner'));
  symlinkSync(ordinary, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const start of [at, inHome, worktree, modules, dotted, above, link])
    expect(findWorkspaces(start, { iaHome: at }), start).toEqual([]);
  expect(findWorkspaces(ordinary, { iaHome: at })).toEqual([realpathSync(ordinary)]);
  // Only the folder given is judged: one below a dot folder is walked as usual.
  expect(findWorkspaces(resolve(above, 'inner'), { iaHome: at })).toEqual([realpathSync(resolve(above, 'inner'))]);
});

/** Runs `check` with `directory` denied to this user, so a stat below it fails with EACCES; a real chmod, not a stub. */
async function denied<T>(directory: string, check: () => T | Promise<T>): Promise<T> {
  chmodSync(directory, 0o000);
  try {
    return await check();
  } finally {
    chmodSync(directory, 0o755);
  }
}
const listRows = (at: string, rows: readonly { readonly id: string; readonly root: string }[]): void => {
  mkdirSync(at, { recursive: true });
  writeFileSync(
    file(at),
    JSON.stringify({
      format: TRACKED_FORMAT,
      formatVersion: 1,
      workspaces: rows.map((row) => ({ ...row, added: NOW.toISOString() })),
    }),
  );
};
const unprivileged = process.platform === 'win32' || process.getuid?.() === 0;

it.skipIf(unprivileged)('remove under EACCES takes the row spelled exactly, never its case variant', async () => {
  const at = home(),
    parent = realpathSync(scratch('tracked')),
    guarded = resolve(parent, 'guarded');
  mkdirSync(resolve(guarded, 'repo/.ia/src'), { recursive: true });
  const lower = resolve(guarded, 'repo'),
    upper = resolve(guarded, 'REPO');
  listRows(at, [
    { id: 'lower', root: lower },
    { id: 'upper', root: upper },
  ]);
  const removed = await denied(guarded, () => untrackWorkspace(at, upper, parent));
  expect(removed.id).toBe('upper');
  expect(readTracked(at).map((row) => row.id)).toEqual(['lower']);
});

it.skipIf(unprivileged)('a root that exists but cannot be read is unreadable, not missing', async () => {
  const parent = realpathSync(scratch('tracked')),
    guarded = resolve(parent, 'guarded'),
    root = resolve(guarded, 'repo');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  const row = { id: 'repo', root, added: NOW.toISOString() };
  expect(await denied(guarded, () => trackedState(row))).toBe('unreadable');
  expect(trackedState(row)).toBe('present');
  expect(trackedState({ ...row, root: resolve(guarded, 'gone') })).toBe('missing');
  writeFileSync(resolve(guarded, 'plain'), '');
  expect(trackedState({ ...row, root: resolve(guarded, 'plain') })).toBe('missing');
});

it('sameRoot compares exact real paths when either side cannot be read, never folded', () => {
  const stat = (path: string) =>
    path === '/w/held' ? 'unreadable' : path === '/w/REPO' ? { dev: 1n, ino: 2n } : undefined;
  const real = (path: string): string => {
    if (path === '/w/REPO') return path;
    throw new Error('EACCES');
  };
  expect(sameRoot('/w/held', '/w/HELD', stat, real)).toBe(false);
  expect(sameRoot('/w/held', '/w/REPO', stat, real)).toBe(false);
  expect(sameRoot('/w/REPO', '/w/held', stat, real)).toBe(false);
  expect(sameRoot('/w/held', '/w/held', stat, real)).toBe(true);
});

it('trackedState reads a stat that failed from its code: ENOENT and ENOTDIR are missing, anything else unreadable', () => {
  const row = { root: '/w/repo' };
  const failing = (code: string) => (): never => {
    throw Object.assign(new Error(), { code });
  };
  expect(trackedState(row, failing('ENOTDIR'))).toBe('missing');
  expect(trackedState(row, failing('ENOENT'))).toBe('missing');
  for (const code of ['EACCES', 'EPERM', 'ELOOP', ''] as const)
    expect(trackedState(row, failing(code))).toBe('unreadable');
  expect(trackedState(row, () => undefined)).toBe('missing');
  expect(trackedState(row, () => ({ isDirectory: () => false }))).toBe('missing');
  expect(trackedState(row, () => ({ isDirectory: () => true }))).toBe('present');
});

it('reads a list written under the legacy ia-tracked-workspaces-1 literal and rewrites it in the plain shape', async () => {
  const at = home(),
    first = workspaceAt(resolve(scratch('tracked'), 'legacy-first'), 'first'),
    second = workspaceAt(resolve(scratch('tracked'), 'legacy-second'), 'second');
  mkdirSync(at, { recursive: true });
  const row = { id: 'first', root: realpathSync(first), added: NOW.toISOString() };
  writeFileSync(file(at), JSON.stringify({ format: 'ia-tracked-workspaces-1', workspaces: [row] }));
  expect(readTracked(at).map((entry) => entry.id)).toEqual(['first']);
  await trackWorkspace(at, { root: second }, NOW);
  const written = JSON.parse(readFileSync(file(at), 'utf8'));
  expect(written).toMatchObject({ format: 'tracked-workspaces', formatVersion: 1 });
  expect(written.workspaces.map((entry: { id: string }) => entry.id)).toEqual(['first', 'second']);
});
