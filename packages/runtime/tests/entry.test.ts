import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { isEntry } from '../src/entry.js';

/** Links a file. Windows grants file links only with a privilege (Developer Mode or elevation): without it, EPERM, and false. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

function scratch(run: (base: string) => void): void {
  const base = mkdtempSync(resolve(tmpdir(), 'ia entry '));
  try {
    run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

it('matches the invoked path before resolving anything, and nothing without one', () => {
  // A plain `node dist/main.js` must not depend on realpath: this path does not exist, so resolving it would fail.
  const missing = resolve(tmpdir(), 'ia entry never created', 'main.js');
  expect(isEntry(missing, pathToFileURL(missing).href)).toBe(true);
  expect(isEntry(undefined, pathToFileURL(missing).href)).toBe(false);
});

it('compares real paths when a link reaches the module, as npm .bin entries and global installs do', () => {
  scratch((base) => {
    const dist = resolve(base, 'dist'),
      main = resolve(dist, 'main.js'),
      url = pathToFileURL(main).href,
      linked = resolve(base, 'linked dist');
    mkdirSync(dist);
    writeFileSync(main, '');
    writeFileSync(resolve(dist, 'other.js'), '');
    // A directory junction needs no privilege on Windows; a file link does, so that case runs wherever it is granted.
    symlinkSync(dist, linked, 'junction');
    expect(isEntry(resolve(linked, 'main.js'), url)).toBe(true);
    expect(isEntry(resolve(linked, 'other.js'), url)).toBe(false);
    expect(isEntry(resolve(dist, 'other.js'), url)).toBe(false);
    expect(isEntry(resolve(base, 'missing.js'), url)).toBe(false);
    // A path through a file, or with a name too long for the file system, names no file either: it cannot be the entry.
    expect(isEntry(resolve(main, 'main.js'), url)).toBe(false);
    expect(isEntry(resolve(base, 'x'.repeat(300)), url)).toBe(false);
    if (fileLink(main, resolve(base, 'ia'))) expect(isEntry(resolve(base, 'ia'), url)).toBe(true);
  });
});

it('throws rather than answering "not the entry" when a path fails to resolve for a reason other than absence', () => {
  // Answering false would let a binary exit 0 having done nothing. File links need privilege on Windows, and root
  // reads a directory whatever its mode, so the link loop and the unreadable directory are POSIX-only, non-root cases.
  if (process.platform === 'win32') return;
  scratch((base) => {
    const main = resolve(base, 'main.js'),
      url = pathToFileURL(main).href,
      locked = resolve(base, 'locked');
    writeFileSync(main, '');
    symlinkSync(resolve(base, 'b'), resolve(base, 'a'));
    symlinkSync(resolve(base, 'a'), resolve(base, 'b'));
    const code = (argv1: string) => {
      try {
        isEntry(argv1, url);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
      return 'no error';
    };
    expect(code(resolve(base, 'a'))).toBe('ELOOP');
    if (process.getuid?.() === 0) return;
    mkdirSync(resolve(locked, 'sub'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(code(resolve(locked, 'sub/main.js'))).toBe('EACCES');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
