/**
 * `ia workspaces list | add | find | remove` (consumer CLI contract §2.16), in process. Every run points IA_HOME at a
 * scratch home, so no test reads or writes the real tracked list.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { TRACKED_FILE } from '../src/tracked.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const home = (): { readonly home: string; readonly env: { readonly IA_HOME: string } } => {
  const at = resolve(scratch('workspaces-home'), '.ia');
  return { home: at, env: { IA_HOME: at } };
};
function workspaceAt(root: string, name?: string): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  if (name !== undefined) writeFileSync(resolve(root, '.ia/src/workspace.ia'), `@workspace ${name}\n`);
  return root;
}
const rows = (at: string): readonly { readonly id: string }[] =>
  existsSync(resolve(at, TRACKED_FILE)) ? JSON.parse(readFileSync(resolve(at, TRACKED_FILE), 'utf8')).workspaces : [];

it('list on an empty home prints the empty hint and exits 0', async () => {
  const { env } = home();
  const result = await run(['workspaces', 'list'], { env });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(flat(result.stdout)).toContain(
    'No workspaces tracked. Add one with: ia workspaces add <directory>, or find them with: ia workspaces find <folder>',
  );
  expect(JSON.parse((await run(['workspaces', 'list', '--json'], { env })).stdout)).toEqual({
    version: 1,
    workspaces: [],
  });
});

it('add then list shows the row', async () => {
  const { env } = home(),
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'), 'demo');
  const added = await run(['workspaces', 'add', root], { env });
  expect(added.exitCode, added.stderr).toBe(0);
  expect(flat(added.stdout)).toContain(`Tracked demo at ${realpathSync(root)}`);
  const listed = await run(['workspaces', 'list'], { env });
  expect(listed.exitCode).toBe(0);
  // A root longer than its column is shortened in the middle, keeping the folder name; --json carries it whole.
  const real = realpathSync(root);
  const row = listed.stdout.split('\n').find((text) => text.includes('demo'))!;
  expect(row).toMatch(/^ {2}demo {2}✔ present {2}/);
  expect(row.endsWith(real) || (row.includes('…') && row.endsWith(`${sep}repo`))).toBe(true);
  expect(JSON.parse((await run(['workspaces', 'list', '--json'], { env })).stdout).workspaces).toEqual([
    { id: 'demo', root: real, label: null, added: expect.any(String), state: 'present' },
  ]);
  expect(flat(listed.stdout)).toContain('1 tracked: 1 present, 0 missing.');
  for (const line of (await run(['workspaces', 'list'], { env })).stdout.split('\n'))
    expect(line.length, line).toBeLessThanOrEqual(80);
  // A root that is gone stays, shown as missing.
  rmSync(root, { recursive: true });
  const missing = await run(['workspaces', 'list', '--ascii'], { env });
  expect(missing.stdout).toMatch(/\[warn\] missing/);
  expect(flat(missing.stdout)).toContain('1 tracked: 0 present, 1 missing.');
});

it('add --json prints one JSON value', async () => {
  const { env } = home(),
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'), 'demo');
  const result = await run(['workspaces', 'add', root, '--label', 'Demo', '--json'], { env });
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    version: 1,
    status: 'added',
    workspace: { id: 'demo', root: realpathSync(root), label: 'Demo', added: expect.any(String), state: 'present' },
  });
  const again = JSON.parse((await run(['workspaces', 'add', root, '--json'], { env })).stdout);
  expect(again.status).toBe('already');
});

it('add from inside a workspace without a directory tracks that workspace', async () => {
  const { home: at, env } = home(),
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'), 'demo');
  const result = await run(['workspaces', 'add', '--json'], { env, cwd: resolve(root, '.ia/src') });
  expect(result.exitCode, result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).workspace.root).toBe(realpathSync(root));
  expect(rows(at)).toHaveLength(1);
});

it('find previews without writing; --apply --yes tracks the untracked ones', async () => {
  const { home: at, env } = home(),
    folder = scratch('workspaces-find'),
    first = workspaceAt(resolve(folder, 'a'), 'first'),
    second = workspaceAt(resolve(folder, 'b/c'), 'second');
  expect((await run(['workspaces', 'add', first], { env })).exitCode).toBe(0);
  const preview = await run(['workspaces', 'find', folder, '--json'], { env });
  expect(preview.exitCode, preview.stdout).toBe(0);
  expect(JSON.parse(preview.stdout)).toEqual({
    version: 1,
    folder: realpathSync(folder),
    found: [
      { root: realpathSync(first), tracked: true, id: 'first' },
      { root: realpathSync(second), tracked: false, id: 'second' },
    ],
    applied: false,
    added: [],
  });
  expect(rows(at)).toHaveLength(1);
  const human = await run(['workspaces', 'find', folder], { env });
  expect(flat(human.stdout)).toContain(`ia workspaces find ${realpathSync(folder)} --apply`);
  expect(rows(at)).toHaveLength(1);
  // Depth 1 does not reach b/c.
  expect(
    JSON.parse((await run(['workspaces', 'find', folder, '--depth', '1', '--json'], { env })).stdout).found,
  ).toHaveLength(1);
  const applied = await run(['workspaces', 'find', folder, '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, added: ['second'] });
  expect(rows(at).map((row) => row.id)).toEqual(['first', 'second']);
  // On a terminal --apply asks first, and a declined question writes nothing.
  const other = workspaceAt(resolve(folder, 'd'), 'third'),
    prompts: string[] = [];
  const declined = await run(['workspaces', 'find', folder, '--apply'], {
    env,
    interactive: true,
    answers: ['n'],
    prompts,
  });
  expect(declined.exitCode).toBe(0);
  expect(prompts.join('')).toContain(realpathSync(other));
  expect(rows(at)).toHaveLength(2);
});

it('remove by id', async () => {
  const { home: at, env } = home(),
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'), 'demo');
  await run(['workspaces', 'add', root], { env });
  const removed = await run(['workspaces', 'remove', 'demo', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout)).toEqual({
    version: 1,
    removed: { id: 'demo', root: realpathSync(root), label: null, added: expect.any(String) },
  });
  expect(rows(at)).toEqual([]);
  expect(existsSync(root)).toBe(true);
  const unknown = await run(['workspaces', 'remove', 'demo', '--json'], { env });
  expect(unknown.exitCode).toBe(3);
  expect(JSON.parse(unknown.stdout).code).toBe('IA-CLI-TRACKED-UNKNOWN');
});

it('an unknown action is a usage error with exit 2', async () => {
  const { env } = home();
  const result = await run(['workspaces', 'frobnicate'], { env });
  expect(result.exitCode).toBe(2);
  expect(flat(result.stderr)).toContain('Workspaces action must be list, add, find or remove');
  for (const argv of [
    ['workspaces', 'list', 'extra'],
    ['workspaces', 'find'],
    ['workspaces', 'remove'],
    ['workspaces', 'list', '--id', 'x'],
    ['workspaces', 'add', '--depth', '2'],
  ])
    expect((await run(argv, { env })).exitCode, argv.join(' ')).toBe(2);
});

it('--root is refused', async () => {
  const { env } = home();
  const result = await run(['workspaces', 'list', '--root', scratch('workspaces')], { env });
  expect(result.exitCode).toBe(2);
  expect(flat(result.stderr)).toContain('--root is not accepted');
});

it('ia workspaces --help lists the four forms', async () => {
  const help = await run(['workspaces', '--help']);
  expect(help.exitCode).toBe(0);
  for (const form of [
    'ia workspaces list [--json]',
    'ia workspaces add [directory] [--id <id>] [--label <text>] [--json]',
    'ia workspaces find <folder> [--depth <n>] [--apply] [--yes] [--json]',
    'ia workspaces remove <id|directory> [--json]',
  ])
    expect(help.stdout).toContain(form);
});
