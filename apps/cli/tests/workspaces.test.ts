/**
 * `ia workspaces list | add | find | remove` (consumer CLI contract §2.16), in process. Every run points IA_HOME at a
 * scratch home, so no test reads or writes the real tracked list.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { TRACKED_FILE } from '../src/tracked.js';
import { stacked } from '../src/workspaces.js';
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

it('find flags two found workspaces that would take one id, and --apply refuses them before it asks', async () => {
  const { home: at, env } = home(),
    folder = scratch('workspaces-find'),
    first = realpathSync(workspaceAt(resolve(folder, 'one'), 'app')),
    second = realpathSync(workspaceAt(resolve(folder, 'two'), 'app'));
  const preview = await run(['workspaces', 'find', folder, '--ascii'], { env, columns: 200 });
  expect(preview.exitCode, preview.stdout).toBe(0);
  const clashing = preview.stdout.split('\n').filter((text) => / {2}app {2}/.test(text));
  expect(clashing).toHaveLength(2);
  for (const text of clashing) expect(text).toMatch(/\[warn\] clash/);
  expect(flat(preview.stdout)).toContain(`Two found workspaces would both take the id app: ${first} and ${second}.`);
  expect(flat(preview.stdout)).toContain(`ia workspaces add ${second} --id`);
  for (const apply of [
    { argv: ['--apply', '--yes', '--json'], interactive: false },
    { argv: ['--apply'], interactive: true },
  ]) {
    const prompts: string[] = [];
    const refused = await run(['workspaces', 'find', folder, ...apply.argv], {
      env,
      interactive: apply.interactive,
      answers: ['y'],
      prompts,
    });
    expect(refused.exitCode, refused.stdout).toBe(3);
    const text = apply.interactive
      ? flat(refused.stdout + refused.stderr)
      : (({ code, message }) => `${code} ${message}`)(JSON.parse(refused.stdout) as { code: string; message: string });
    expect(text).toContain('IA-CLI-TRACKED-ID');
    expect(text).toContain(`Two found workspaces would both take the id app: ${first} and ${second}`);
    expect(text).not.toContain('already tracked');
    expect(prompts).toEqual([]);
    expect(rows(at)).toEqual([]);
  }
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

it('an invalid --id is a usage error before any state is read or root discovered', async () => {
  const { home: at, env } = home(),
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'));
  mkdirSync(at, { recursive: true });
  writeFileSync(resolve(at, TRACKED_FILE), '{ not json');
  // Malformed tracked file, valid root: the id is still the first thing refused.
  const withRoot = await run(['workspaces', 'add', root, '--id', '.bad'], { env });
  expect(withRoot.exitCode, withRoot.stderr).toBe(2);
  expect(flat(withRoot.stderr)).toContain('--id must start with a letter or digit');
  // No directory given and none holding the cwd: the id still comes before root discovery.
  const noRoot = await run(['workspaces', 'add', '--id', '.bad'], { env, cwd: scratch('workspaces') });
  expect(noRoot.exitCode, noRoot.stderr).toBe(2);
  expect(readFileSync(resolve(at, TRACKED_FILE), 'utf8')).toBe('{ not json');
});

it('find given a link or a dot folder walks nothing and reports the folder as given', async () => {
  const { env } = home(),
    parent = scratch('workspaces'),
    target = workspaceAt(resolve(parent, 'target'), 'target'),
    link = resolve(parent, 'link'),
    dotted = workspaceAt(resolve(parent, '.private'), 'private');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const folder of [link, dotted]) {
    const result = await run(['workspaces', 'find', folder, '--json'], { env });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      folder: folder === link ? link : realpathSync(folder),
      found: [],
      applied: false,
      added: [],
    });
  }
});

it('below the table width, list and find stack each row as its id, then its root, then its state', async () => {
  const { env } = home(),
    parent = scratch('workspaces'),
    id = `w${'x'.repeat(127)}`,
    root = workspaceAt(resolve(parent, 'repo'));
  expect((await run(['workspaces', 'add', root, '--id', id], { env })).exitCode).toBe(0);
  const narrow = { env: { ...env, NO_COLOR: '1' }, isTTY: true, columns: 40 };
  for (const ascii of [[], ['--ascii']]) {
    for (const argv of [
      ['workspaces', 'list', ...ascii],
      ['workspaces', 'find', parent, ...ascii],
    ]) {
      const result = await run(argv, narrow);
      expect(result.exitCode, result.stderr).toBe(0);
      const lines = result.stdout.split('\n');
      for (const text of lines) expect(text.length, `${argv.join(' ')}: ${text}`).toBeLessThanOrEqual(40);
      // No table header: each row is a block of its own.
      expect(result.stdout).not.toMatch(/ {2}id {2,}state {2}root/);
      const at = lines.findIndex((text) => text.startsWith(`  ${id.slice(0, 8)}`));
      expect(at, result.stdout).toBeGreaterThan(-1);
      expect(lines[at + 1]).toMatch(/^ {4}\S/);
      expect(lines[at + 1]!.endsWith(`${sep}repo`)).toBe(true);
      expect(lines[at + 2]).toMatch(argv[1] === 'list' ? /^ {4}\S+ present$/ : /^ {4}\S+ tracked$/);
    }
  }
  // Wide enough for the table, the same rows keep its columns.
  const wide = await run(['workspaces', 'list'], { ...narrow, columns: 80 });
  expect(wide.stdout).toMatch(/ {2}id {2,}state {2,}root/);
});

it('at 16 columns every stacked line of a missing row fits, in ASCII and Unicode', async () => {
  const { env } = home(),
    id = `w${'x'.repeat(127)}`,
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'));
  expect((await run(['workspaces', 'add', root, '--id', id], { env })).exitCode).toBe(0);
  rmSync(root, { recursive: true });
  for (const ascii of [[], ['--ascii']]) {
    const result = await run(['workspaces', 'list', ...ascii], {
      env: { ...env, NO_COLOR: '1' },
      isTTY: true,
      columns: 16,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const lines = result.stdout.split('\n'),
      at = lines.findIndex((text) => /^ *wx/.test(text));
    expect(at, result.stdout).toBeGreaterThan(-1);
    const block = lines.slice(at, at + 3);
    for (const text of block) expect(text.length, `${ascii.join('')}: ${text}`).toBeLessThanOrEqual(16);
    expect(block[2]).toMatch(/miss/);
  }
});

it('stacked rows fit every width capabilities accept, from 1 to 80 columns', () => {
  const rows = [
    { id: `w${'x'.repeat(127)}`, state: 'present', root: `${sep}${'r'.repeat(60)}${sep}repo` },
    { id: 'gone', state: 'missing', root: `${sep}old` },
    { id: 'n', state: 'new', root: `${sep}n` },
  ] as const;
  for (const ascii of [false, true])
    for (let width = 1; width <= 80; width += 1)
      for (const text of stacked(rows, { color: false, ascii, width }))
        expect(text.length, `${ascii ? 'ascii' : 'unicode'} ${width}: ${text}`).toBeLessThanOrEqual(width);
});

it('list keeps to 80 columns with a 128-character id, and --json keeps it whole', async () => {
  const { env } = home(),
    id = `w${'x'.repeat(127)}`,
    root = workspaceAt(resolve(scratch('workspaces'), 'repo'));
  expect((await run(['workspaces', 'add', root, '--id', id], { env })).exitCode).toBe(0);
  const listed = await run(['workspaces', 'list'], { env, columns: 80 });
  expect(listed.exitCode, listed.stderr).toBe(0);
  for (const text of listed.stdout.split('\n')) expect(text.length, text).toBeLessThanOrEqual(80);
  expect(listed.stdout).toContain(id.slice(0, 8));
  expect(JSON.parse((await run(['workspaces', 'list', '--json'], { env })).stdout).workspaces[0].id).toBe(id);
});
