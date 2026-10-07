import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionError } from '@inventarch/session-system';
import { afterEach, expect, it, vi } from 'vitest';
import { installedImplementationDigest } from '../src/installed-catalog.js';

/**
 * A pass-through `node:fs` whose hooks act only on this file's temporary roots, so a test can change a file between
 * the walk's check and its read, list an entry that is not a regular file, or fail an open the way POSIX does for a
 * socket. Every other path, including the real installed packages the walk also pins, behaves exactly as usual.
 */
const hooks = vi.hoisted(() => ({
  opened: new Map<number, string>(),
  openedPaths: [] as string[],
  afterSizeCheck: undefined as ((path: string) => void) | undefined,
  extraEntries: undefined as ((directory: string) => readonly Dirent[]) | undefined,
  openError: undefined as ((path: string) => string | undefined) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const path = String(args[0]);
      const code = hooks.openError?.(path);
      if (code !== undefined) throw Object.assign(new Error(`${code}: open '${path}'`), { code });
      const fd = actual.openSync(...args);
      hooks.opened.set(fd, path);
      hooks.openedPaths.push(path);
      return fd;
    },
    closeSync: (fd: number) => {
      hooks.opened.delete(fd);
      actual.closeSync(fd);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const stat = actual.fstatSync(...args);
      const path = hooks.opened.get(args[0]);
      if (path !== undefined) hooks.afterSizeCheck?.(path);
      return stat;
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      const entries = actual.readdirSync(...args) as unknown as Dirent[];
      return [...entries, ...(hooks.extraEntries?.(String(args[0])) ?? [])];
    },
  };
});
/** A directory entry that is neither a file, a directory nor a link: what readdir reports for a FIFO or socket. */
const nonregular = (directory: string, name: string): Dirent =>
  ({
    name,
    parentPath: directory,
    path: directory,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => true,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  }) as unknown as Dirent;

const roots: string[] = [];
afterEach(() => {
  hooks.afterSizeCheck = undefined;
  hooks.extraEntries = undefined;
  hooks.openError = undefined;
  hooks.openedPaths.length = 0;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(resolve(tmpdir(), 'ia-installed-bound-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
/** A caller-supplied installed package directory with one entrypoint file. */
function installed(): { readonly root: string; readonly entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'ia-installed-bound-'));
  roots.push(root);
  writeFileSync(join(root, 'index.js'), 'export {};');
  return { root, entry: join(root, 'index.js') };
}
/** A file of the given size without writing its bytes. */
function sized(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
function refusal(entry: string): unknown {
  try {
    installedImplementationDigest([['probe', entry]]);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the installed walk to refuse');
}

it('pins a bounded additional directory deterministically', () => {
  const { entry } = installed(),
    pinned = installedImplementationDigest([['probe', entry]]);
  expect(pinned).toMatch(/^[a-f0-9]{64}$/);
  expect(installedImplementationDigest([['probe', entry]])).toBe(pinned);
  expect(pinned).not.toBe(installedImplementationDigest());
});

it('refuses an installed directory deeper than the walk bound', () => {
  const { root, entry } = installed();
  mkdirSync(join(root, ...Array.from({ length: 17 }, (_, index) => `d${index}`)), { recursive: true });
  const error = refusal(entry);
  expect(error).toBeInstanceOf(SessionError);
  expect(error).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation inventory exceeds its bound',
  });
}, 30_000);

it('refuses an installed directory with more entries than the walk bound', () => {
  const { root, entry } = installed();
  for (let index = 0; index < 2000; index++) writeFileSync(join(root, `n${index}.txt`), '');
  expect(refusal(entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation inventory exceeds its bound',
  });
}, 30_000);

it('refuses a code file that grows after its size was checked instead of hashing bytes past the bound', () => {
  const { root, entry } = installed();
  const target = join(root, 'index.js');
  hooks.afterSizeCheck = (path) => {
    if (resolve(path) !== resolve(target)) return;
    hooks.afterSizeCheck = undefined;
    writeFileSync(target, 'export {}; // grown after the size check');
  };
  expect(refusal(entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation changed while it was read',
  });
});

it('refuses a nonregular entry listed by its directory without ever opening it', () => {
  const { root, entry } = installed();
  hooks.extraEntries = (directory) => (resolve(directory) === resolve(root) ? [nonregular(root, 'listener.js')] : []);
  const error = refusal(entry);
  expect(error).toBeInstanceOf(SessionError);
  expect(error).toMatchObject({ code: 'IA-CORPUS-DENIED', message: 'Installed implementation has a nonregular file' });
  expect(hooks.openedPaths.some((path) => path.endsWith('listener.js'))).toBe(false);
});

it.each(['ELOOP', 'EMLINK', 'ENXIO', 'EOPNOTSUPP'])(
  'refuses an entry swapped for a link, socket or device after the directory was read (%s)',
  (code) => {
    const { root, entry } = installed();
    hooks.openError = (path) => (resolve(path) === resolve(join(root, 'index.js')) ? code : undefined);
    expect(refusal(entry)).toMatchObject({
      code: 'IA-CORPUS-DENIED',
      message: 'Installed implementation has a nonregular file',
    });
  },
);

it('refuses installed code over the file and package byte bounds before hashing it', () => {
  const large = installed();
  sized(join(large.root, 'large.js'), 8 * 1024 * 1024 + 1);
  expect(refusal(large.entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation bytes exceed their bound',
  });
  const many = installed();
  for (let index = 0; index < 5; index++) sized(join(many.root, `part${index}.js`), 7 * 1024 * 1024);
  expect(refusal(many.entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation bytes exceed their bound',
  });
}, 30_000);
