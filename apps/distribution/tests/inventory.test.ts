import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { runBounded } from '@tools/testing/subprocess.js';
import { installedDistributionDigest } from '../src/inventory.js';
import { RACE_PRELOAD, type Race } from './race-fixture.js';

/**
 * A pass-through `node:fs` with one hook on `target`: `beforeOpen`, `beforeLstat` and `beforeList` run once just before it
 * is opened, lstat'd or listed as a directory, and `afterRead` once just after the first read through a descriptor opened
 * on it, so a test changes an entry between two of the reader's own calls. `linked` lists the named entries of a directory
 * as links whatever they are, as Windows lists every reparse point. Every other path behaves exactly as usual.
 */
const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  beforeLstat: undefined as (() => void) | undefined,
  beforeList: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  linked: undefined as { readonly directory: string; readonly names: readonly string[] } | undefined,
  opened: new Set<number>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fire = (step: 'beforeOpen' | 'beforeLstat' | 'beforeList' | 'afterRead') => {
    const act = race[step];
    race[step] = undefined;
    act?.();
  };
  const link = (entry: { name: string }) => ({
    ...entry,
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  });
  return {
    ...actual,
    lstatSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path) === race.target) fire('beforeLstat');
      return (actual.lstatSync as (path: unknown, ...rest: unknown[]) => unknown)(path, ...rest);
    },
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      const directory = String(path);
      if (directory === race.target) fire('beforeList');
      const entries = (actual.readdirSync as (path: unknown, ...rest: unknown[]) => unknown[])(path, ...rest),
        linked = race.linked;
      if (linked?.directory !== directory) return entries;
      return entries.map((entry) =>
        typeof entry === 'object' && linked.names.includes((entry as { name: string }).name)
          ? link(entry as { name: string })
          : entry,
      );
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const target = String(args[0]) === race.target;
      if (target) fire('beforeOpen');
      const fd = actual.openSync(...args);
      if (target) race.opened.add(fd);
      return fd;
    },
    readSync: (fd: number, ...rest: unknown[]) => {
      const read = (actual.readSync as (fd: number, ...rest: unknown[]) => number)(fd, ...rest);
      if (race.opened.has(fd)) fire('afterRead');
      return read;
    },
    closeSync: (fd: number) => {
      race.opened.delete(fd);
      actual.closeSync(fd);
    },
  };
});

it('pins every installed distribution runtime module and refuses a partial or mixed installation', () => {
  expect(installedDistributionDigest()).toMatch(/^[a-f0-9]{64}$/);
  const root = mkdtempSync(join(tmpdir(), 'ia-distribution-code-'));
  try {
    for (const name of [
      'archive',
      'pack',
      'resolve',
      'snapshot',
      'install',
      'installation-core',
      'inventory',
      'transfer',
    ])
      writeFileSync(join(root, `${name}.js`), '// Executable fixture.\n');
    const before = installedDistributionDigest(root);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'helper.js'), '// Altered implementation.\n');
    expect(installedDistributionDigest(root)).not.toBe(before);
    const changed = installedDistributionDigest(root);
    writeFileSync(join(root, 'archive.d.ts'), '// Declaration only.\n');
    expect(installedDistributionDigest(root)).toBe(changed);
    expect(() => installedDistributionDigest(`${root}/nested/..`)).toThrow();
    writeFileSync(join(root, 'archive.ts'), '// Mixed loaded modes.\n');
    expect(() => installedDistributionDigest(root)).toThrow();
  } finally {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe inventory cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const POSIX = process.platform !== 'win32';
const REFUSED = { code: undefined, message: 'Installed distribution runtime is missing, mixed or aliased' };
const roots: string[] = [];
afterEach(() => {
  race.target = race.beforeOpen = race.beforeLstat = race.beforeList = race.afterRead = race.linked = undefined;
  race.opened.clear();
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe inventory cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia-distribution-code-'));
  roots.push(root);
  return root;
}
/** A complete emitted runtime: one file for each module the inventory requires. */
function runtime(): string {
  const root = temporary();
  for (const name of [
    'archive',
    'pack',
    'resolve',
    'snapshot',
    'install',
    'installation-core',
    'inventory',
    'transfer',
  ])
    writeFileSync(join(root, `${name}.js`), `// Emitted ${name}.\n`);
  return root;
}
/** The digest of `root`, or the code and message of the refusal. */
const inventory = (root: string): unknown => {
  try {
    return { digest: installedDistributionDigest(root) };
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
};
/**
 * What the inventory admits and refuses. Each arrangement changes a fresh runtime and returns the root to inventory and
 * what it expects, given the digest of the runtime before the change. Links are refused at every level, hard links are
 * admitted, and every other refusal is the one message.
 */
it.each<[string, (root: string, before: unknown) => [string, unknown]]>([
  [
    'a missing root',
    (root) => {
      const missing = join(root, 'missing');
      return [missing, { code: 'ENOENT', message: `ENOENT: no such file or directory, lstat '${missing}'` }];
    },
  ],
  [
    'a required module missing',
    (root) => {
      unlinkSync(join(root, 'archive.js'));
      return [root, REFUSED];
    },
  ],
  [
    'a runtime module with a second link',
    (root, before) => {
      linkSync(join(root, 'archive.js'), join(temporary(), 'archive.js'));
      return [root, before];
    },
  ],
  [
    'an empty directory named like a runtime module',
    (root, before) => {
      mkdirSync(join(root, 'nested.js'));
      return [root, before];
    },
  ],
  [
    'a directory link or junction inside the root',
    (root) => {
      const real = join(temporary(), 'real');
      mkdirSync(real);
      writeFileSync(join(real, 'module.js'), '// Linked module.\n');
      symlinkSync(real, join(root, 'alias'), 'junction');
      return [root, REFUSED];
    },
  ],
  [
    'a root reached through a directory link or junction',
    (root) => {
      const alias = join(temporary(), 'alias');
      symlinkSync(root, alias, 'junction');
      return [alias, REFUSED];
    },
  ],
])('the inventory answers for %s', (_, arrange) => {
  const root = runtime(),
    [target, expected] = arrange(root, inventory(root));
  expect(inventory(target)).toEqual(expected);
});
it.each<[string, (root: string) => Promise<void> | void]>([
  [
    'a runtime module that is a symbolic link',
    (root) => {
      const moved = join(temporary(), 'archive.js');
      renameSync(join(root, 'archive.js'), moved);
      symlinkSync(moved, join(root, 'archive.js'));
    },
  ],
  ['a dangling symbolic link', (root) => symlinkSync(join(temporary(), 'nowhere'), join(root, 'dangling.js'))],
  [
    'a symbolic link to a file that is no runtime module',
    (root) => {
      const notes = join(temporary(), 'notes.md');
      writeFileSync(notes, 'Notes.\n');
      symlinkSync(notes, join(root, 'notes.md'));
    },
  ],
  [
    'a FIFO named like a runtime module',
    async (root) => {
      expect((await runBounded('mkfifo', [join(root, 'fifo.js')], { timeoutMs: SUBPROCESS })).status).toBe(0);
    },
  ],
  [
    'a FIFO with another name',
    async (root) => {
      expect((await runBounded('mkfifo', [join(root, 'fifo')], { timeoutMs: SUBPROCESS })).status).toBe(0);
    },
  ],
])('the inventory refuses %s (POSIX)', async (_, arrange) => {
  if (!POSIX) return;
  const root = runtime();
  await arrange(root);
  expect(inventory(root)).toEqual(REFUSED);
});
it('the inventory refuses a UNIX socket (POSIX)', async () => {
  if (!POSIX) return;
  const root = runtime(),
    server = createServer();
  server.listen(join(root, 's.js'));
  await once(server, 'listening');
  try {
    expect(inventory(root)).toEqual(REFUSED);
  } finally {
    server.close();
  }
});
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
/**
 * The inventory judges the file it opened, not the entry it listed: whatever replaces a runtime module after its directory
 * was read, or while it is read, refuses. A FIFO is held open for reading and writing meanwhile, so no open of it can wait.
 */
it.each<[string, (module: string) => void]>([
  ['removed before the open', (module) => (race.beforeOpen = () => unlinkSync(module))],
  ['grown by a byte after its first read', (module) => (race.afterRead = () => appendFileSync(module, ' '))],
])('the inventory refuses a runtime module %s', (_, arrange) => {
  const root = runtime();
  race.target = join(root, 'archive.js');
  arrange(race.target);
  expect(inventory(root)).toEqual(REFUSED);
});
it.each<[string, (module: string) => void]>([
  [
    'replaced by a link before the open',
    (module) => {
      const moved = join(temporary(), 'archive.js');
      race.beforeOpen = () => {
        renameSync(module, moved);
        symlinkSync(moved, module);
      };
    },
  ],
  [
    'replaced by a link after its first read',
    (module) => {
      const moved = join(temporary(), 'archive.js');
      race.afterRead = () => {
        renameSync(module, moved);
        symlinkSync(moved, module);
      };
    },
  ],
  [
    'replaced by another file of the same bytes after its first read',
    (module) => {
      const other = join(temporary(), 'archive.js');
      writeFileSync(other, '// Emitted archive.\n');
      race.afterRead = () => renameSync(other, module);
    },
  ],
])('the inventory refuses a runtime module %s (POSIX)', (_, arrange) => {
  if (!POSIX) return;
  const root = runtime();
  race.target = join(root, 'archive.js');
  arrange(race.target);
  expect(inventory(root)).toEqual(REFUSED);
});
it('the inventory refuses a runtime module replaced by a FIFO before the open (POSIX)', async () => {
  if (!POSIX) return;
  const root = runtime(),
    fifo = join(temporary(), 'fifo');
  expect((await runBounded('mkfifo', [fifo], { timeoutMs: SUBPROCESS })).status).toBe(0);
  const held = openSync(fifo, constants.O_RDWR);
  try {
    race.target = join(root, 'archive.js');
    race.beforeOpen = () => renameSync(fifo, join(root, 'archive.js'));
    expect(inventory(root)).toEqual(REFUSED);
  } finally {
    closeSync(held);
  }
});
it('the inventory refuses a runtime module replaced by a UNIX socket before the open (POSIX)', async () => {
  if (!POSIX) return;
  const root = runtime(),
    bound = join(temporary(), 's'),
    server = createServer();
  server.listen(bound);
  await once(server, 'listening');
  try {
    race.target = join(root, 'archive.js');
    race.beforeOpen = () => renameSync(bound, join(root, 'archive.js'));
    expect(inventory(root)).toEqual(REFUSED);
  } finally {
    server.close();
  }
});
/** Every open that fails refuses, a file the process may not read included, not only an entry swapped meanwhile. */
it('the inventory refuses an unreadable runtime module (POSIX, unprivileged)', () => {
  if (!UNPRIVILEGED) return;
  const root = runtime();
  chmodSync(join(root, 'archive.js'), 0);
  expect(inventory(root)).toEqual(REFUSED);
});
/**
 * The same race in a bounded subprocess, where nothing holds the FIFO open: the open must not wait for a writer. Opened
 * without O_NONBLOCK, the inventory would block until the subprocess bound stopped it, and this worker would never wait.
 */
it('the inventory refuses a runtime module replaced by a FIFO before the open at once, with no writer (POSIX)', async () => {
  if (!POSIX) return;
  const root = runtime(),
    other = temporary(),
    fifo = join(other, 'fifo'),
    preload = join(other, 'race.mjs'),
    module = join(root, 'archive.js');
  expect((await runBounded('mkfifo', [fifo], { timeoutMs: SUBPROCESS })).status).toBe(0);
  writeFileSync(preload, RACE_PRELOAD);
  const race: Race = { at: 'open', steps: [['renameSync', fifo, module]] },
    script =
      'const { installedDistributionDigest } = await import(process.argv[1]);' +
      'try { process.stdout.write(installedDistributionDigest(process.argv[2])); }' +
      'catch (error) { process.stdout.write(error.message); }';
  const result = await runBounded(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      'tsx',
      '--import',
      pathToFileURL(preload).href,
      '--input-type=module',
      '--eval',
      script,
      pathToFileURL(resolve(import.meta.dirname, '../src/inventory.ts')).href,
      root,
    ],
    {
      cwd: resolve(import.meta.dirname, '..'),
      timeoutMs: SUBPROCESS,
      maxBufferBytes: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', IA_TEST_RACE: JSON.stringify({ ...race, target: module }) },
    },
  );
  expect({ timedOut: result.timedOut, stdout: result.stdout }, result.stderr).toEqual({
    timedOut: false,
    stdout: REFUSED.message,
  });
});
/**
 * An entry its listed name no longer reaches, removed once it was listed or (on Linux) listed under a name that is not
 * UTF-8, refuses, though no file that is not a runtime module is ever read.
 */
it('the inventory refuses a file that is no runtime module removed before its lstat', () => {
  const root = runtime(),
    notes = join(root, 'notes.md');
  writeFileSync(notes, 'Notes.\n');
  race.target = notes;
  race.beforeLstat = () => unlinkSync(notes);
  expect(inventory(root)).toEqual(REFUSED);
});
it('the inventory refuses a directory removed before it is listed', () => {
  const root = runtime(),
    nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'helper.js'), '// Helper.\n');
  race.target = nested;
  race.beforeList = () => renameSync(nested, join(temporary(), 'nested'));
  expect(inventory(root)).toEqual(REFUSED);
});
it('the inventory refuses a file that is no runtime module, named in bytes that are not UTF-8 (Linux)', () => {
  if (process.platform !== 'linux') return;
  const root = runtime(),
    raw = Buffer.concat([Buffer.from(root + sep), Buffer.from([0xff]), Buffer.from('.md')]);
  writeFileSync(raw, 'Notes.\n');
  try {
    // Node lists the name lossily, so the name it gives reaches nothing.
    expect(inventory(root)).toEqual(REFUSED);
  } finally {
    unlinkSync(raw);
  }
});
/**
 * Windows lists every reparse point as a link, a cloud placeholder or deduplicated file included, while its lstat calls
 * only a real link one. A listed link is confirmed by its lstat, so a runtime module, another file or a directory its
 * listing calls a link is inventoried as before, and a real link is still refused.
 */
it('the inventory admits a file or directory its listing calls a link', () => {
  const root = runtime();
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'helper.js'), '// Helper.\n');
  writeFileSync(join(root, 'notes.md'), 'Notes.\n');
  const before = inventory(root);
  expect(before).toEqual({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  race.linked = { directory: root, names: ['archive.js', 'notes.md', 'nested'] };
  expect(inventory(root)).toEqual(before);
});
/**
 * A directory the inventory can list but not enter (mode 0444): every entry in it but a runtime module fails its lstat
 * with the system's error, as when the inventory judged every entry by its lstat. A runtime module there is opened to be
 * judged, and an open that fails refuses with the one message. The directory's mode is restored before it is removed.
 */
it.each<[string, (locked: string) => Promise<string> | string]>([
  [
    'a directory',
    (locked) => {
      mkdirSync(join(locked, 'sub'));
      return join(locked, 'sub');
    },
  ],
  [
    'a FIFO',
    async (locked) => {
      expect((await runBounded('mkfifo', [join(locked, 'fifo')], { timeoutMs: SUBPROCESS })).status).toBe(0);
      return join(locked, 'fifo');
    },
  ],
  [
    'a file that is no runtime module',
    (locked) => {
      writeFileSync(join(locked, 'notes.md'), 'Notes.\n');
      return join(locked, 'notes.md');
    },
  ],
])(
  'the inventory fails on %s in a directory it can list but not enter, with the lstat error (POSIX, unprivileged)',
  async (_, arrange) => {
    if (!UNPRIVILEGED) return;
    const root = runtime(),
      locked = join(root, 'locked');
    mkdirSync(locked);
    const entry = await arrange(locked);
    chmodSync(locked, 0o444);
    try {
      expect(inventory(root)).toEqual({ code: 'EACCES', message: `EACCES: permission denied, lstat '${entry}'` });
    } finally {
      chmodSync(locked, 0o755);
    }
  },
);
it('the inventory refuses a runtime module in a directory it can list but not enter (POSIX, unprivileged)', () => {
  if (!UNPRIVILEGED) return;
  const root = runtime(),
    locked = join(root, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'helper.js'), '// Helper.\n');
  chmodSync(locked, 0o444);
  try {
    expect(inventory(root)).toEqual(REFUSED);
  } finally {
    chmodSync(locked, 0o755);
  }
});
