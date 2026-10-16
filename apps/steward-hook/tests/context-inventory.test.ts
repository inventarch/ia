import { afterEach, expect, it, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

vi.mock('@inventarch/workspace-runtime', async (original) => ({
  ...(await original<typeof import('@inventarch/workspace-runtime')>()),
  installedImplementationDigest: () => 'a'.repeat(64),
}));
/**
 * A pass-through `node:fs`: a case can change an entry once its directory is listed, once it is opened or before it is
 * read, or have the stats of one file report other inode numbers.
 */
const seam = vi.hoisted(() => ({
  afterList: undefined as ((directory: string) => void) | undefined,
  afterOpen: undefined as ((path: string, fd: number) => void) | undefined,
  beforeRead: undefined as ((fd: number, length: number) => void) | undefined,
  /** Entries the listing reports as links whatever they hold, as Windows lists every reparse point. */
  listedAsLink: undefined as ReadonlySet<string> | undefined,
  /** The inode numbers the stats of the file at `path` report: by its open descriptor, and by its name. */
  ino: undefined as { path: string; opened: bigint; named: bigint; fd?: number } | undefined,
  /** Each FIFO opened to read without O_NONBLOCK, an open that would have waited for a writer. */
  waited: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // An open that reads a FIFO without O_NONBLOCK waits for a writer, which would hold this whole run: here it is
  // recorded and fails instead.
  const waits = (path: unknown, flags: unknown): boolean => {
    const { O_NONBLOCK = 0, O_RDWR, O_WRONLY } = actual.constants;
    if (
      typeof flags === 'number' ? (flags & (O_RDWR | O_WRONLY | O_NONBLOCK)) !== 0 : !/^rs?$/.test(String(flags ?? 'r'))
    )
      return false;
    try {
      return actual.statSync(path as string, { throwIfNoEntry: false })?.isFIFO() === true;
    } catch {
      return false;
    }
  };
  /** `stat` reporting `ino`, in the width the caller asked for. */
  const numbered = <T extends { ino: unknown }>(stat: T, ino: bigint | undefined): T =>
    ino === undefined ? stat : Object.assign(stat, { ino: typeof stat.ino === 'bigint' ? ino : Number(ino) });
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (waits(args[0], args[1])) {
        seam.waited.push(String(args[0]));
        throw new Error('A FIFO opened to read without O_NONBLOCK would wait for a writer');
      }
      const fd = actual.openSync(...args),
        path = resolve(String(args[0]));
      if (seam.ino?.path === path) seam.ino.fd = fd;
      seam.afterOpen?.(path, fd);
      return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      seam.beforeRead?.(fd, length);
      return actual.readSync(fd, buffer, offset, length, position);
    },
    fstatSync: (fd: number, options?: Parameters<typeof actual.fstatSync>[1]) => {
      const stat = actual.fstatSync(fd, options);
      return seam.ino !== undefined && fd === seam.ino.fd ? numbered(stat, seam.ino.opened) : stat;
    },
    lstatSync: (path: string, options?: Parameters<typeof actual.lstatSync>[1]) => {
      const stat = actual.lstatSync(path, options);
      return stat !== undefined && resolve(path) === seam.ino?.path ? numbered(stat, seam.ino.named) : stat;
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      const listed = actual.readdirSync(...args),
        links = seam.listedAsLink;
      seam.afterList?.(String(args[0]));
      if (links === undefined) return listed;
      return (listed as unknown as (string | Dirent)[]).map((entry) =>
        typeof entry === 'string' || !links.has(resolve(String(args[0]), entry.name))
          ? entry
          : Object.assign(Object.create(Object.getPrototypeOf(entry)) as Dirent, entry, {
              isFile: () => false,
              isDirectory: () => false,
              isSymbolicLink: () => true,
            }),
      );
    },
  };
});
import { contextHookImplementationDigest } from '../src/context.js';
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia-hook-runtime-'));
  roots.push(root);
  for (const name of ['main.js', 'context.js']) writeFileSync(join(root, name), `// exact ${name}\n`);
  return root;
}
afterEach(() => {
  seam.afterList = undefined;
  seam.afterOpen = undefined;
  seam.beforeRead = undefined;
  seam.ino = undefined;
  seam.listedAsLink = undefined;
  seam.waited.length = 0;
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-hook-runtime-')))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('pins added/removed/changed emitted runtime assets but excludes nonexecuted declarations', () => {
  const root = fixture(),
    original = contextHookImplementationDigest(root);
  writeFileSync(join(root, 'context.d.ts'), 'export declare const ignored: true;');
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, 'policy.json'), '{"policy":1}');
  const withPolicy = contextHookImplementationDigest(root);
  expect(withPolicy).not.toBe(original);
  writeFileSync(join(root, 'policy.json'), '{"policy":2}');
  expect(contextHookImplementationDigest(root)).not.toBe(withPolicy);
  unlinkSync(join(root, 'policy.json'));
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, 'context.js'), '// changed runtime');
  expect(contextHookImplementationDigest(root)).not.toBe(original);
  unlinkSync(join(root, 'main.js'));
  expect(() => contextHookImplementationDigest(root)).toThrow(/partial|mixed/);
});
it('leaves out the AppleDouble files the packaged launcher skips, and still counts any other dotfile (crowncodes/ia#323)', async () => {
  const root = fixture(),
    original = contextHookImplementationDigest(root);
  for (const name of ['._context.js', '._main.js', '._package.json'])
    writeFileSync(join(root, name), 'written by the platform');
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, '.context.js'), '// not written by the platform');
  expect(contextHookImplementationDigest(root)).not.toBe(original);
  if (process.platform === 'win32') return;
  unlinkSync(join(root, '.context.js'));
  expect((await runBounded('mkfifo', [join(root, '._fifo.js')], { timeoutMs: SUBPROCESS })).status).toBe(0);
  expect(() => contextHookImplementationDigest(root)).toThrow(/nonregular/);
});
it('refuses aliased or mixed modules and permits normal package-store hardlinks', () => {
  const root = fixture();
  linkSync(join(root, 'main.js'), join(root, 'shared.js'));
  expect(contextHookImplementationDigest(root)).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(root, 'main.ts'), '// source');
  writeFileSync(join(root, 'context.ts'), '// source');
  expect(() => contextHookImplementationDigest(root)).toThrow(/mixed/);
  unlinkSync(join(root, 'main.ts'));
  unlinkSync(join(root, 'context.ts'));
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'module.js'), '// module');
  symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
  expect(() => contextHookImplementationDigest(root)).toThrow(/alias/i);
});

const BINDING = 'IA-LIFECYCLE-BINDING',
  ALIASES = { code: BINDING, message: 'Hook implementation aliases are unsupported' },
  NONREGULAR = { code: BINDING, message: 'Hook implementation has a nonregular file' },
  BYTES = { code: BINDING, message: 'Hook implementation bytes exceed their bound' };
const posix = process.platform !== 'win32';
/** The code and message of what `run` throws. */
function refusal(run: () => unknown): { readonly code: unknown; readonly message: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  throw new Error('Expected the implementation inventory to refuse');
}
/** A file of `bytes` bytes, without writing them. */
function sized(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
/** A FIFO with no writer, or a socket, at `path`; a socket is bound at the short `bound` first and moved into place. */
async function special(kind: 'a FIFO' | 'a socket', path: string, bound: string): Promise<void> {
  if (kind === 'a FIFO') {
    expect((await runBounded('mkfifo', [path], { timeoutMs: SUBPROCESS })).status).toBe(0);
    return;
  }
  const server = createServer();
  await new Promise<void>((done, failed) => {
    server.once('error', failed);
    server.listen(bound, () => done());
  });
  renameSync(bound, path);
  await new Promise<void>((done) => server.close(() => done()));
}
it('hashes a code file of exactly 8 MiB and 32 MiB of code in all, and refuses one byte more of either', () => {
  const root = fixture();
  sized(join(root, 'large.js'), 8 * 1024 * 1024);
  expect(contextHookImplementationDigest(root)).toMatch(/^[a-f0-9]{64}$/);
  sized(join(root, 'large.js'), 8 * 1024 * 1024 + 1);
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual(BYTES);
  // The fixture's main.js and context.js count toward the total; a file that is not code never does.
  const used = ['main.js', 'context.js'].reduce((sum, name) => sum + readFileSync(join(root, name)).length, 0);
  for (const name of ['large.js', 'more.js', 'most.js']) sized(join(root, name), 8 * 1024 * 1024);
  sized(join(root, 'rest.json'), 8 * 1024 * 1024 - used);
  sized(join(root, 'notes.txt'), 9 * 1024 * 1024);
  expect(contextHookImplementationDigest(root)).toMatch(/^[a-f0-9]{64}$/);
  sized(join(root, 'rest.json'), 8 * 1024 * 1024 - used + 1);
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual(BYTES);
}, 30_000);
it.each(['a file link', 'a dangling link', 'a junction'] as const)(
  'refuses %s in place of a code file or a module directory',
  (kind) => {
    if (!posix && kind !== 'a junction') return;
    const root = fixture();
    if (kind === 'a file link') symlinkSync(join(root, 'main.js'), join(root, 'linked.js'), 'file');
    else if (kind === 'a dangling link') symlinkSync(join(root, 'absent.js'), join(root, 'linked.js'), 'file');
    else {
      mkdirSync(join(root, 'real'));
      writeFileSync(join(root, 'real', 'module.js'), '// module');
      symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
    }
    expect(refusal(() => contextHookImplementationDigest(root))).toEqual(ALIASES);
  },
);
it('refuses an implementation directory reached through a junction', () => {
  const root = fixture();
  symlinkSync(root, join(root, 'self'), 'junction');
  expect(refusal(() => contextHookImplementationDigest(join(root, 'self')))).toEqual({
    code: BINDING,
    message: 'Context root is not an unaliased physical directory',
  });
});
it.each(['a FIFO', 'a socket'] as const)('refuses %s, named as code or not', async (kind) => {
  if (!posix) return;
  for (const name of ['entry.js', 'entry']) {
    const root = fixture();
    await special(kind, join(root, name), join(root, 's'));
    expect(
      refusal(() => contextHookImplementationDigest(root)),
      name,
    ).toEqual(NONREGULAR);
  }
  expect(seam.waited).toEqual([]);
});
it('hashes a hard-linked code file as its bytes', () => {
  const linked = fixture(),
    copied = fixture();
  linkSync(join(linked, 'main.js'), join(linked, 'shared.js'));
  writeFileSync(join(copied, 'shared.js'), readFileSync(join(copied, 'main.js')));
  expect(contextHookImplementationDigest(linked)).toBe(contextHookImplementationDigest(copied));
});
it('walks a directory named like a code file instead of reading it', () => {
  const root = fixture(),
    original = contextHookImplementationDigest(root);
  mkdirSync(join(root, 'lib.js'));
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, 'lib.js', 'part.js'), '// part');
  expect(contextHookImplementationDigest(root)).not.toBe(original);
});
it('passes on the error of a code file it may not open', () => {
  if (!posix || process.getuid?.() === 0) return;
  const root = fixture(),
    path = join(root, 'locked.js');
  writeFileSync(path, '// locked');
  chmodSync(path, 0o000);
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual({
    code: 'EACCES',
    message: `EACCES: permission denied, open '${path}'`,
  });
});
it.each(['removed', 'a FIFO', 'a socket', 'a link'] as const)(
  'refuses a code file that is %s once its directory is listed',
  async (kind) => {
    if (!posix && kind !== 'removed') return;
    const root = fixture(),
      aside = fixture(),
      path = join(root, 'swapped.js'),
      replacement = join(aside, 'replacement');
    writeFileSync(path, '// listed');
    if (kind === 'a FIFO' || kind === 'a socket') await special(kind, replacement, join(aside, 's'));
    else if (kind === 'a link') symlinkSync(join(root, 'main.js'), replacement, 'file');
    seam.afterList = (directory) => {
      if (resolve(directory) !== resolve(root)) return;
      seam.afterList = undefined;
      if (kind === 'removed') unlinkSync(path);
      else renameSync(replacement, path);
    };
    expect(refusal(() => contextHookImplementationDigest(root))).toEqual(
      kind === 'removed'
        ? { code: 'ENOENT', message: `ENOENT: no such file or directory, lstat '${path}'` }
        : kind === 'a link'
          ? ALIASES
          : NONREGULAR,
    );
    expect(seam.waited).toEqual([]);
  },
);
it('refuses a code file replaced after it was opened', () => {
  const root = fixture(),
    path = join(root, 'policy.json');
  writeFileSync(path, '{"policy":1}');
  seam.afterOpen = (opened) => {
    if (opened !== resolve(path)) return;
    seam.afterOpen = undefined;
    renameSync(path, join(root, 'policy.retained'));
    writeFileSync(path, '{"policy":1}');
  };
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual(ALIASES);
});
it('refuses a code file that grows while it is read, reading no more than its opened size and one byte', () => {
  const root = fixture(),
    path = join(root, 'policy.json');
  writeFileSync(path, '{"policy":1}');
  let opened: number | undefined,
    requested = 0;
  seam.afterOpen = (name, fd) => {
    if (name === resolve(path)) opened = fd;
  };
  seam.beforeRead = (fd, length) => {
    if (fd !== opened) return;
    if (requested === 0) writeFileSync(path, '{"policy":1}'.padEnd(64 * 1024, ' '));
    requested += length;
  };
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual({
    code: BINDING,
    message: 'Hook implementation changed while it was read',
  });
  expect(requested).toBe('{"policy":1}'.length + 1);
});
it('refuses a code file whose opened and named inode numbers collide as JavaScript numbers', () => {
  const root = fixture();
  seam.ino = { path: resolve(join(root, 'main.js')), opened: 2n ** 54n, named: 2n ** 54n + 1n };
  expect(Number(seam.ino.opened)).toBe(Number(seam.ino.named));
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual(ALIASES);
});
it('refuses a code file rewritten at the same size while it is read', () => {
  const root = fixture(),
    path = join(root, 'policy.json');
  writeFileSync(path, '{"policy":1}');
  // An old modification time, so the rewrite's own differs even where the clock that stamps files is coarse.
  utimesSync(path, 1_000_000, 1_000_000);
  let opened: number | undefined;
  seam.afterOpen = (name, fd) => {
    if (name === resolve(path)) opened = fd;
  };
  seam.beforeRead = (fd) => {
    if (fd !== opened) return;
    seam.beforeRead = undefined;
    writeFileSync(path, '{"policy":2}');
  };
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual({
    code: BINDING,
    message: 'Hook implementation changed while it was read',
  });
});
it('walks, reads or skips an entry the listing calls a link but lstat does not, as Windows lists a reparse point', () => {
  const root = fixture();
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'folder', 'inner.js'), '// inner');
  writeFileSync(join(root, 'cloud.js'), '// cloud');
  writeFileSync(join(root, 'notes.txt'), 'not code');
  const original = contextHookImplementationDigest(root);
  // A cloud placeholder or a deduplicated file is listed as a link, and lstat reports what it holds.
  seam.listedAsLink = new Set(['folder', 'cloud.js', 'notes.txt'].map((name) => resolve(root, name)));
  expect(contextHookImplementationDigest(root)).toBe(original);
});
it('refuses a code file reached through a directory swapped for a link once its parent is listed', () => {
  const root = fixture(),
    aside = fixture(),
    lib = join(root, 'lib');
  mkdirSync(lib);
  writeFileSync(join(lib, 'part.js'), '// part');
  mkdirSync(join(aside, 'lib'));
  writeFileSync(join(aside, 'lib', 'part.js'), '// elsewhere');
  seam.afterList = (directory) => {
    if (resolve(directory) !== resolve(root)) return;
    seam.afterList = undefined;
    renameSync(lib, join(aside, 'retained'));
    symlinkSync(join(aside, 'lib'), lib, 'junction');
  };
  expect(refusal(() => contextHookImplementationDigest(root))).toEqual(ALIASES);
});
it.each(['removed', 'a FIFO', 'a socket', 'a link'] as const)(
  'refuses a file it never reads that is %s once its directory is listed, as it refused a listed one',
  async (kind) => {
    if (!posix && kind !== 'removed') return;
    const root = fixture(),
      aside = fixture(),
      path = join(root, 'notes.txt'),
      replacement = join(aside, 'replacement');
    writeFileSync(path, 'not code');
    if (kind === 'a FIFO' || kind === 'a socket') await special(kind, replacement, join(aside, 's'));
    else if (kind === 'a link') symlinkSync(join(root, 'main.js'), replacement, 'file');
    seam.afterList = (directory) => {
      if (resolve(directory) !== resolve(root)) return;
      seam.afterList = undefined;
      if (kind === 'removed') unlinkSync(path);
      else renameSync(replacement, path);
    };
    expect(refusal(() => contextHookImplementationDigest(root))).toEqual(
      kind === 'removed'
        ? { code: 'ENOENT', message: `ENOENT: no such file or directory, lstat '${path}'` }
        : kind === 'a link'
          ? ALIASES
          : NONREGULAR,
    );
    expect(seam.waited).toEqual([]);
  },
);
