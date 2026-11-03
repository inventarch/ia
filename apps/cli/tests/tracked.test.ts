/**
 * The tracked list (consumer CLI contract §2.16): `<IA home>/tracked-workspaces.json`, a personal list of workspace
 * roots kept apart from the MCP door's `workspace-locations.json`, and the bounded folder walk `ia workspaces find`
 * reads. Every home and workspace is a scratch directory.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Refusal } from '../src/consumer.js';
import {
  defaultTrackId,
  findWorkspaces,
  readTracked,
  TRACKED_FILE,
  TRACKED_FORMAT,
  trackedState,
  trackWorkspace,
  untrackWorkspace,
} from '../src/tracked.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const NOW = new Date('2026-11-03T12:00:00.000Z');
const home = (): string => resolve(scratch('tracked-home'), '.ia');
/** A directory holding `.ia/src`, with each `@workspace` name declared in its own file. */
function workspaceAt(root: string, ...names: readonly string[]): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  names.forEach((name, index) => writeFileSync(resolve(root, `.ia/src/w${index}.ia`), `@workspace ${name}\n`));
  return root;
}
const refusalOf = (action: () => unknown): Refusal => {
  try {
    action();
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

it('adds a workspace with its @workspace name as id', () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'team-kb');
  const { status, row } = trackWorkspace(at, { root }, NOW);
  expect(status).toBe('added');
  expect(row).toEqual({ id: 'team-kb', root: realpathSync(root), added: NOW.toISOString() });
  expect(readTracked(at)).toEqual([row]);
  expect(JSON.parse(readFileSync(file(at), 'utf8'))).toEqual({ format: TRACKED_FORMAT, workspaces: [row] });
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

it('adding a root again through a link changes nothing', () => {
  const at = home(),
    parent = scratch('tracked'),
    root = workspaceAt(resolve(parent, 'repo'), 'linked'),
    link = resolve(parent, 'link');
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(trackWorkspace(at, { root }, NOW).status).toBe('added');
  const again = trackWorkspace(at, { root: link + (process.platform === 'win32' ? '\\' : '/') }, NOW);
  expect(again.status).toBe('already');
  expect(again.row.root).toBe(realpathSync(root));
  if (process.platform === 'win32') expect(trackWorkspace(at, { root: root.toUpperCase() }).status).toBe('already');
  expect(readTracked(at)).toHaveLength(1);
});

it('refuses an id another root holds', () => {
  const at = home(),
    first = workspaceAt(resolve(scratch('tracked'), 'ia'), 'ia'),
    second = workspaceAt(resolve(scratch('tracked'), 'ia'), 'ia');
  trackWorkspace(at, { root: first }, NOW);
  const refusal = refusalOf(() => trackWorkspace(at, { root: second }, NOW));
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
  expect(trackWorkspace(at, { root: second, id: suggested }, NOW).row.id).toBe(suggested);
});

it('refuses a new id or label for a root already tracked', () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  trackWorkspace(at, { root }, NOW);
  expect(trackWorkspace(at, { root, id: 'repo' }).status).toBe('already');
  for (const input of [{ id: 'other' }, { label: 'Mine' }]) {
    const refusal = refusalOf(() => trackWorkspace(at, { root, ...input }));
    expect(refusal.code).toBe('IA-CLI-TRACKED-EXISTS');
    expect(refusal.next).toContain('ia workspaces remove repo');
  }
});

it('refuses an id outside the id rule as usage', () => {
  const root = workspaceAt(resolve(scratch('tracked'), 'repo'));
  expect(() => trackWorkspace(home(), { root, id: '-bad' })).toThrow(/id/);
});

it('refuses a root inside the IA home', () => {
  const at = home(),
    inside = workspaceAt(resolve(at, 'nested'));
  const refusal = refusalOf(() => trackWorkspace(at, { root: inside }, NOW));
  expect(refusal.code).toBe('IA-DIST-PATH-UNSAFE');
  expect(existsSync(file(at))).toBe(false);
});

it('refuses a directory with no .ia/src', () => {
  const at = home();
  for (const root of [scratch('tracked'), resolve(scratch('tracked'), 'absent')]) {
    const refusal = refusalOf(() => trackWorkspace(at, { root }, NOW));
    expect(refusal.code).toBe('IA-DB-ROOT-INVALID');
  }
  expect(existsSync(file(at))).toBe(false);
});

it('keeps unknown fields', () => {
  const at = home(),
    first = workspaceAt(resolve(scratch('tracked'), 'first'), 'first'),
    second = workspaceAt(resolve(scratch('tracked'), 'second'), 'second');
  mkdirSync(at, { recursive: true });
  writeFileSync(
    file(at),
    JSON.stringify({
      format: TRACKED_FORMAT,
      workspaces: [{ id: 'first', root: realpathSync(first), added: NOW.toISOString(), entry: 'x' }],
      note: 'y',
    }),
  );
  trackWorkspace(at, { root: second }, NOW);
  const written = JSON.parse(readFileSync(file(at), 'utf8'));
  expect(written.note).toBe('y');
  expect(written.workspaces[0].entry).toBe('x');
  expect(written.workspaces.map((row: { id: string }) => row.id)).toEqual(['first', 'second']);
});

it('refuses a malformed file and leaves it as it was', () => {
  const root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  for (const text of [
    '{ not json',
    JSON.stringify({ format: 'ia-tracked-workspaces-2', workspaces: [] }),
    JSON.stringify({ format: TRACKED_FORMAT, workspaces: [{ id: 'x', root: 'relative', added: NOW.toISOString() }] }),
  ]) {
    const at = home();
    mkdirSync(at, { recursive: true });
    writeFileSync(file(at), text);
    for (const action of [() => readTracked(at), () => trackWorkspace(at, { root }, NOW)]) {
      const refusal = refusalOf(action);
      expect(refusal.code).toBe('IA-CLI-TRACKED-INVALID');
      expect(refusal.where?.path).toBe(file(at));
    }
    expect(readFileSync(file(at), 'utf8')).toBe(text);
  }
});

it('a row whose root is gone is missing, never dropped', () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  const { row } = trackWorkspace(at, { root }, NOW);
  expect(trackedState(row)).toBe('present');
  rmSync(resolve(root, '.ia'), { recursive: true });
  expect(trackedState(row)).toBe('missing');
  rmSync(root, { recursive: true });
  expect(trackedState(row)).toBe('missing');
  expect(readTracked(at)).toEqual([row]);
  // Adding another workspace keeps the missing row.
  trackWorkspace(at, { root: workspaceAt(resolve(scratch('tracked'), 'other'), 'other') }, NOW);
  expect(readTracked(at).map((entry) => entry.id)).toEqual(['repo', 'other']);
});

it('untrack by id and by root', () => {
  const at = home(),
    parent = scratch('tracked'),
    first = workspaceAt(resolve(parent, 'first'), 'first'),
    second = workspaceAt(resolve(parent, 'second'), 'second');
  trackWorkspace(at, { root: first }, NOW);
  trackWorkspace(at, { root: second }, NOW);
  expect(untrackWorkspace(at, 'first', parent).id).toBe('first');
  // A relative root is read against the cwd, and a gone root still matches by its spelling.
  const gone = realpathSync(second);
  rmSync(second, { recursive: true });
  expect(untrackWorkspace(at, gone, resolve(parent, 'elsewhere')).id).toBe('second');
  trackWorkspace(at, { root: workspaceAt(first, 'first') }, NOW);
  expect(untrackWorkspace(at, './first', parent).root).toBe(realpathSync(first));
  expect(readTracked(at)).toEqual([]);
});

it('untrack refuses an unknown id', () => {
  const at = home();
  const refusal = refusalOf(() => untrackWorkspace(at, 'nothing', scratch('tracked')));
  expect(refusal.code).toBe('IA-CLI-TRACKED-UNKNOWN');
  expect(refusal.next).toContain('ia workspaces list');
});

it('never writes workspace-locations.json', () => {
  const at = home(),
    root = workspaceAt(resolve(scratch('tracked'), 'repo'), 'repo');
  trackWorkspace(at, { root }, NOW);
  untrackWorkspace(at, 'repo', root);
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
