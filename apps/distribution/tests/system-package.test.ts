import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';

/**
 * A pass-through `node:fs` with one hook on `target`: `beforeOpen` runs once just before it is opened, `afterOpenError`
 * once just after an open of it fails, and `afterRead` once just after the first read through a descriptor opened on it,
 * so a test changes an input between two of the reader's own calls. `size`, when set, is the size every fstat of a
 * descriptor opened on `target` reports. Every other path behaves exactly as usual.
 */
const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  afterOpenError: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  size: undefined as bigint | undefined,
  opened: new Set<number>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fire = (step: 'beforeOpen' | 'afterOpenError' | 'afterRead') => {
    const act = race[step];
    race[step] = undefined;
    act?.();
  };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const target = String(args[0]) === race.target;
      if (target) fire('beforeOpen');
      let fd: number;
      try {
        fd = actual.openSync(...args);
      } catch (error) {
        if (target) fire('afterOpenError');
        throw error;
      }
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
    fstatSync: (fd: number, ...rest: unknown[]) => {
      const stat = (actual.fstatSync as (fd: number, ...rest: unknown[]) => object)(fd, ...rest);
      if (race.size === undefined || !race.opened.has(fd)) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: race.size });
    },
  };
});

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const POSIX = process.platform !== 'win32';
/** Mode bits do not keep the superuser from reading a file, so an unreadable fixture needs an ordinary user. */
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [],
  held: number[] = [];
afterEach(() => {
  race.target = race.beforeOpen = race.afterOpenError = race.afterRead = undefined;
  race.size = undefined;
  race.opened.clear();
  for (const fd of held.splice(0)) closeSync(fd);
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
/**
 * Keeps `fifo` open for reading and writing until the case ends, so no open of it waits for a writer and no reader can
 * block this worker, whatever the reader's flags.
 */
function hold(fifo: string): void {
  held.push(openSync(fifo, constants.O_RDWR));
}
function temporary(prefix: string): string {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}
/** A legacy (format 1) package with one compiled module, in a fresh scratch directory, with its binding and pin. */
async function legacyPackage() {
  const { SYSTEM_PACKAGE_FORMAT, SYSTEM_NATIVE_PATH, SYSTEM_BINDING_PATH } = await import('../src/system-package.js');
  const { buildArchive, verifyArchive } = await import('../src/archive.js');
  const scratch = temporary('ia-system-package-binding-');
  const put = (path: string, bytes: string | Uint8Array) => {
    mkdirSync(dirname(resolve(scratch, path)), { recursive: true });
    writeFileSync(resolve(scratch, path), bytes);
  };
  const code = 'throw new Error("verification must never execute package code");\n',
    path = '.ia/src/systems/fixture-system/system.ia',
    source = '#! ia 1.0\n@system fixture-system\n  provider "fixture.test"\n  version "3.2.1"\n';
  const native = buildArchive(
    {
      formatVersion: 1,
      id: 'fixture/system',
      version: '2.1.0',
      distribution: 'workspace-system/definition/distribution/fixture',
      roots: ['workspace-system/definition/workspace/fixture'],
      engine: '^0.1.0',
      language: ['1.0'],
      source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
      license: 'UNLICENSED',
      description: 'Original independent version fixture',
      systems: [
        {
          name: 'fixture-system',
          provider: 'fixture.test',
          version: '3.2.1',
          path: '.ia/src/systems/fixture-system',
        },
      ],
      dependencies: [],
      files: [{ path, role: 'source', bytes: Buffer.byteLength(source), sha256: sha(source) }],
    },
    new Map([[path, Buffer.from(source)]]),
  );
  const verified = verifyArchive(native),
    manifest = {
      name: '@inventarch/fixture-system',
      version: '1.4.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: { '@inventarch/language': '1.0.0' },
    };
  const files = [{ path: 'dist/index.js', sha256: sha(code) }];
  const binding = {
    format: SYSTEM_PACKAGE_FORMAT,
    package: { name: manifest.name, version: manifest.version },
    system: verified.manifest.systems[0],
    native: {
      path: SYSTEM_NATIVE_PATH,
      archiveSha256: verified.archiveDigest,
      manifestSha256: verified.manifestDigest,
      id: verified.manifest.id,
      version: verified.manifest.version,
    },
    code: { digest: sha(json(files)), files },
    entrypoints: manifest.exports,
    dependencies: manifest.dependencies,
    protocols: { distribution: 1, language: ['1.0'], binding: 1 },
  };
  put('package.json', json(manifest));
  put('dist/index.js', code);
  put(SYSTEM_NATIVE_PATH, native);
  put(SYSTEM_BINDING_PATH, json(binding));
  return { scratch, put, code, native, manifest, binding, pin: sha(json(binding)) };
}

it('binds compiled system bytes, native archive, npm identity and entrypoints to an external manifest pin', async () => {
  const { verifySystemPackage, SYSTEM_NATIVE_PATH, SYSTEM_BINDING_PATH } = await import('../src/system-package.js');
  const { scratch, put, code, native, manifest, binding, pin } = await legacyPackage();
  expect(verifySystemPackage(scratch, pin)).toEqual(binding);
  // pnpm's installed store hard links preserve exact read-only digest verification.
  linkSync(resolve(scratch, 'dist/index.js'), resolve(scratch, 'store-member.js'));
  expect(verifySystemPackage(scratch, pin)).toEqual(binding);
  put('store-member.js', code + '// changed store bytes\n');
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
  put('store-member.js', code);
  expect(() => verifySystemPackage(scratch, '0'.repeat(64))).toThrow(/binding digest/);
  put('dist/index.js', code + '// changed\n');
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
  put('dist/index.js', code);
  const corrupt = Buffer.from(native);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  put(SYSTEM_NATIVE_PATH, corrupt);
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/digest/);
  put(SYSTEM_NATIVE_PATH, native);
  put('package.json', json({ ...manifest, version: '1.4.1' }));
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/npm identity/);
  put('package.json', json({ ...manifest, exports: { '.': { default: './dist/other.js' } } }));
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/entrypoints/);
  put('package.json', json(manifest));
  const wrongNative = { ...binding, system: { ...binding.system, version: '4.0.0' } };
  put(SYSTEM_BINDING_PATH, json(wrongNative));
  expect(() => verifySystemPackage(scratch, sha(json(wrongNative)))).toThrow(/native identity/);
  put(SYSTEM_BINDING_PATH, json(binding));
  put('dist/unlisted.js', 'export const unreviewed = true;\n');
  expect(() => verifySystemPackage(scratch, pin)).toThrow(/compiled bytes/);
});

type Package = Awaited<ReturnType<typeof legacyPackage>>;
/** The binding a verification returns, or the code and message of its refusal. */
async function verification(root: string, pin: string): Promise<unknown> {
  const { verifySystemPackage } = await import('../src/system-package.js');
  try {
    return { binding: verifySystemPackage(root, pin) };
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
}
const notRegular = (path: string) => ({
  code: undefined,
  message: `System package input is not a regular file: ${path}`,
});
async function mkfifo(path: string): Promise<void> {
  expect((await runBounded('mkfifo', [path], { timeoutMs: SUBPROCESS })).status).toBe(0);
}
/**
 * What reading one package input admits and refuses. Each arrangement changes a fresh package and returns the root to
 * verify and what it expects: a link on the way to an input refuses, hard links are admitted, an input that is no
 * regular file refuses, and a missing or unreadable one fails with the system's own error.
 */
it.each<[string, (selected: Package) => [string, unknown]]>([
  [
    'a missing binding',
    ({ scratch }) => {
      const path = resolve(scratch, 'dist', 'system-package.json');
      unlinkSync(path);
      return [scratch, { code: 'ENOENT', message: `ENOENT: no such file or directory, lstat '${path}'` }];
    },
  ],
  [
    'a missing package.json',
    ({ scratch }) => {
      const path = resolve(scratch, 'package.json');
      unlinkSync(path);
      return [scratch, { code: 'ENOENT', message: `ENOENT: no such file or directory, lstat '${path}'` }];
    },
  ],
  [
    'a binding and a package.json with second links',
    ({ scratch, binding }) => {
      const other = temporary('ia-system-package-other-');
      linkSync(resolve(scratch, 'dist', 'system-package.json'), resolve(other, 'system-package.json'));
      linkSync(resolve(scratch, 'package.json'), resolve(other, 'package.json'));
      return [scratch, { binding }];
    },
  ],
  [
    'a directory where package.json belongs',
    ({ scratch }) => {
      unlinkSync(resolve(scratch, 'package.json'));
      mkdirSync(resolve(scratch, 'package.json'));
      return [scratch, notRegular('package.json')];
    },
  ],
  [
    'a directory link or junction on the way to an input',
    ({ scratch }) => {
      const moved = resolve(temporary('ia-system-package-other-'), 'dist');
      renameSync(resolve(scratch, 'dist'), moved);
      symlinkSync(moved, resolve(scratch, 'dist'), 'junction');
      return [
        scratch,
        { code: 'IA-DIST-PATH-UNSAFE', message: `Link/junction is not allowed: ${resolve(scratch, 'dist')}` },
      ];
    },
  ],
  [
    'a package root reached through a directory link or junction',
    ({ scratch }) => {
      const alias = resolve(temporary('ia-system-package-other-'), 'alias');
      symlinkSync(scratch, alias, 'junction');
      return [alias, { code: 'IA-DIST-PATH-UNSAFE', message: `Link/junction is not allowed: ${alias}` }];
    },
  ],
])('verification answers for %s', async (_, arrange) => {
  const selected = await legacyPackage(),
    [root, expected] = arrange(selected);
  expect(await verification(root, selected.pin)).toEqual(expected);
});
it.each<[string, (selected: Package) => Promise<[string, unknown]>]>([
  [
    'a package.json that is a symbolic link',
    async ({ scratch }) => {
      const moved = resolve(temporary('ia-system-package-other-'), 'package.json');
      renameSync(resolve(scratch, 'package.json'), moved);
      symlinkSync(moved, resolve(scratch, 'package.json'));
      return [
        scratch,
        { code: 'IA-DIST-PATH-UNSAFE', message: `Link/junction is not allowed: ${resolve(scratch, 'package.json')}` },
      ];
    },
  ],
  [
    'a package root that is a dangling symbolic link',
    async () => {
      const other = temporary('ia-system-package-other-'),
        alias = resolve(other, 'alias');
      symlinkSync(resolve(other, 'nowhere'), alias);
      return [alias, { code: undefined, message: 'System package root is aliased' }];
    },
  ],
  [
    'a FIFO where the binding belongs',
    async ({ scratch }) => {
      unlinkSync(resolve(scratch, 'dist', 'system-package.json'));
      await mkfifo(resolve(scratch, 'dist', 'system-package.json'));
      hold(resolve(scratch, 'dist', 'system-package.json'));
      return [scratch, notRegular('dist/system-package.json')];
    },
  ],
  [
    'a FIFO where package.json belongs',
    async ({ scratch }) => {
      unlinkSync(resolve(scratch, 'package.json'));
      await mkfifo(resolve(scratch, 'package.json'));
      hold(resolve(scratch, 'package.json'));
      return [scratch, notRegular('package.json')];
    },
  ],
])('verification answers for %s (POSIX)', async (_, arrange) => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    [root, expected] = await arrange(selected);
  expect(await verification(root, selected.pin)).toEqual(expected);
});
it('verification refuses a UNIX socket where package.json belongs (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    // A socket's path is short (104 bytes on macOS), so it is bound beside the package and moved in.
    bound = resolve(temporary('ia-sp-'), 's'),
    server = createServer();
  server.listen(bound);
  await once(server, 'listening');
  try {
    unlinkSync(resolve(selected.scratch, 'package.json'));
    renameSync(bound, resolve(selected.scratch, 'package.json'));
    expect(await verification(selected.scratch, selected.pin)).toEqual(notRegular('package.json'));
  } finally {
    server.close();
  }
});
it('verification fails on an unreadable package.json with the read error (POSIX, unprivileged)', async () => {
  if (!UNPRIVILEGED) return;
  const selected = await legacyPackage(),
    path = resolve(selected.scratch, 'package.json');
  chmodSync(path, 0);
  expect(await verification(selected.scratch, selected.pin)).toEqual({
    code: 'EACCES',
    message: `EACCES: permission denied, open '${path}'`,
  });
});
/**
 * Reading an input judges the file it opened, not the entry it found: whatever replaces package.json after its name was
 * checked, or while it is read, refuses with the input's own message, never through a link, a FIFO or a socket. One removed
 * before the open keeps the error of its open. A FIFO is held open for reading and writing meanwhile, so no open of it can
 * wait.
 */
const changed = { code: undefined, message: 'System package input changed while it was read: package.json' };
const PAST = new Date('2001-01-01T00:00:00Z');
it.each<[string, (manifest: string) => unknown]>([
  [
    'removed before the open',
    (manifest) => {
      race.beforeOpen = () => unlinkSync(manifest);
      return { code: 'ENOENT', message: `ENOENT: no such file or directory, open '${manifest}'` };
    },
  ],
  [
    'grown by a byte after its first read',
    (manifest) => {
      race.afterRead = () => appendFileSync(manifest, ' ');
      return changed;
    },
  ],
  [
    // The bytes read are the manifest's; only its modification time, set in the past first because file times come
    // from a coarse clock, tells that it changed under the read.
    'rewritten in place with as many bytes after its first read',
    (manifest) => {
      utimesSync(manifest, PAST, PAST);
      const rewritten = readFileSync(manifest, 'utf8').toUpperCase();
      race.afterRead = () => writeFileSync(manifest, rewritten);
      return changed;
    },
  ],
  [
    // Its name reaches nothing once it is read, which no longer holds the file read.
    'removed after its first read',
    (manifest) => {
      race.afterRead = () => unlinkSync(manifest);
      return changed;
    },
  ],
])('verification refuses a package.json %s', async (_, arrange) => {
  const selected = await legacyPackage();
  race.target = resolve(selected.scratch, 'package.json');
  const expected = arrange(race.target);
  expect(await verification(selected.scratch, selected.pin)).toEqual(expected);
});
it.each<[string, (manifest: string) => unknown]>([
  [
    'replaced by a link before the open',
    (manifest) => {
      const moved = resolve(temporary('ia-system-package-other-'), 'package.json');
      race.beforeOpen = () => {
        renameSync(manifest, moved);
        symlinkSync(moved, manifest);
      };
      return { code: undefined, message: 'System package input is aliased: package.json' };
    },
  ],
  [
    'replaced by a link after its first read',
    (manifest) => {
      const moved = resolve(temporary('ia-system-package-other-'), 'package.json');
      race.afterRead = () => {
        renameSync(manifest, moved);
        symlinkSync(moved, manifest);
      };
      return { code: undefined, message: 'System package input is aliased: package.json' };
    },
  ],
  [
    'replaced by another file of the same bytes after its first read',
    (manifest) => {
      const other = resolve(temporary('ia-system-package-other-'), 'package.json');
      writeFileSync(other, readFileSync(manifest));
      race.afterRead = () => renameSync(other, manifest);
      return changed;
    },
  ],
  [
    // The open meets the link and refuses it; the file is back before the name is judged, so only the open's ELOOP tells.
    'replaced by a link for its open and restored before it is judged',
    (manifest) => {
      const moved = resolve(temporary('ia-system-package-other-'), 'package.json');
      race.beforeOpen = () => {
        renameSync(manifest, moved);
        symlinkSync(moved, manifest);
      };
      race.afterOpenError = () => {
        unlinkSync(manifest);
        renameSync(moved, manifest);
      };
      return { code: undefined, message: 'System package input is aliased: package.json' };
    },
  ],
])('verification refuses a package.json %s (POSIX)', async (_, arrange) => {
  if (!POSIX) return;
  const selected = await legacyPackage();
  race.target = resolve(selected.scratch, 'package.json');
  const expected = arrange(race.target);
  expect(await verification(selected.scratch, selected.pin)).toEqual(expected);
});
it('verification refuses a package.json replaced by a FIFO before the open (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    fifo = resolve(temporary('ia-sp-'), 'fifo');
  await mkfifo(fifo);
  hold(fifo);
  race.target = resolve(selected.scratch, 'package.json');
  race.beforeOpen = () => renameSync(fifo, resolve(selected.scratch, 'package.json'));
  expect(await verification(selected.scratch, selected.pin)).toEqual(notRegular('package.json'));
});
it('verification refuses a package.json replaced by a link to a FIFO before the open, at the link (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    manifest = resolve(selected.scratch, 'package.json'),
    fifo = resolve(temporary('ia-sp-'), 'fifo');
  await mkfifo(fifo);
  // Held open, the FIFO would open at once and be judged as a FIFO: only an open that refuses the link refuses it as one.
  hold(fifo);
  race.target = manifest;
  race.beforeOpen = () => {
    unlinkSync(manifest);
    symlinkSync(fifo, manifest);
  };
  expect(await verification(selected.scratch, selected.pin)).toEqual({
    code: undefined,
    message: 'System package input is aliased: package.json',
  });
});
it('verification refuses a package.json replaced by a UNIX socket before the open (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    bound = resolve(temporary('ia-sp-'), 's'),
    server = createServer();
  server.listen(bound);
  await once(server, 'listening');
  try {
    race.target = resolve(selected.scratch, 'package.json');
    race.beforeOpen = () => renameSync(bound, resolve(selected.scratch, 'package.json'));
    expect(await verification(selected.scratch, selected.pin)).toEqual(notRegular('package.json'));
  } finally {
    server.close();
  }
});
/**
 * A FIFO in place of package.json, read in a bounded subprocess where nothing holds it open: the reader opens it to judge
 * it, so the open must not wait for a writer. Opened without O_NONBLOCK, it would block until the subprocess bound stopped
 * it, and this worker would never wait.
 */
it('verification refuses a FIFO where package.json belongs at once, with no writer (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage(),
    path = resolve(selected.scratch, 'package.json');
  unlinkSync(path);
  await mkfifo(path);
  const script =
    'const { verifySystemPackage } = await import(process.argv[1]);' +
    'try { verifySystemPackage(process.argv[2], process.argv[3]); process.stdout.write("verified"); }' +
    'catch (error) { process.stdout.write(error.message); }';
  const result = await runBounded(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      pathToFileURL(resolve(import.meta.dirname, '../src/system-package.ts')).href,
      selected.scratch,
      selected.pin,
    ],
    {
      cwd: resolve(import.meta.dirname, '..'),
      timeoutMs: SUBPROCESS,
      maxBufferBytes: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  expect({ timedOut: result.timedOut, stdout: result.stdout }, result.stderr).toEqual({
    timedOut: false,
    stdout: notRegular('package.json').message,
  });
});
/**
 * No input of more than 2147483647 bytes is read, as readFileSync read none: one of 2147483648 bytes, sparse, is refused
 * from its size before anything is allocated for it.
 */
it('verification refuses an input of 2147483648 bytes before reading it', async () => {
  const selected = await legacyPackage(),
    path = resolve(selected.scratch, 'package.json'),
    fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, 2 ** 31);
  } finally {
    closeSync(fd);
  }
  try {
    expect(await verification(selected.scratch, selected.pin)).toEqual({
      code: undefined,
      message: 'System package input exceeds 2147483647 bytes: package.json',
    });
  } finally {
    unlinkSync(path);
  }
});
/**
 * A package.json whose descriptor reports 2147483647 bytes, the most the reader reads, though it holds fewer: no read
 * asks readSync for more than 2147483647 bytes, so the read stops at the file's real end and the shortfall refuses as a
 * change, where a read asked for the size plus one would make readSync throw a raw ERR_OUT_OF_RANGE, and a guard at
 * 2147483647 bytes would refuse it as too large. POSIX only: the untouched Buffer.alloc(2 ** 31) the read allocates is
 * lazily zeroed on Linux and macOS but commits 2 GiB on Windows.
 */
it('verification refuses a package.json reported at 2147483647 bytes that holds fewer (POSIX)', async () => {
  if (!POSIX) return;
  const selected = await legacyPackage();
  race.target = resolve(selected.scratch, 'package.json');
  race.size = 0x7fffffffn;
  expect(await verification(selected.scratch, selected.pin)).toEqual(changed);
});
