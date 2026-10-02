import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { isEntry } from './is-entry.mjs';

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

const root = resolve(import.meta.dirname, '../..');
function scratch(run: (base: string) => void): void {
  const base = mkdtempSync(resolve(tmpdir(), 'tools entry '));
  try {
    run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

it('matches the invoked path before resolving anything, and nothing without one', () => {
  // A plain `node tools/x.mjs` must not depend on realpath: this path does not exist, so resolving it would fail.
  const missing = resolve(tmpdir(), 'tools entry never created', 'main.mjs');
  expect(isEntry(missing, pathToFileURL(missing).href)).toBe(true);
  expect(isEntry(undefined, pathToFileURL(missing).href)).toBe(false);
});

it('compares real paths when a link reaches the tool, such as a linked checkout', () => {
  scratch((base) => {
    const tools = resolve(base, 'tools'),
      main = resolve(tools, 'main.mjs'),
      url = pathToFileURL(main).href,
      linked = resolve(base, 'linked checkout');
    mkdirSync(tools);
    writeFileSync(main, '');
    writeFileSync(resolve(tools, 'other.mjs'), '');
    // A directory junction needs no privilege on Windows; a file link does, so that case runs wherever it is granted.
    symlinkSync(tools, linked, 'junction');
    expect(isEntry(resolve(linked, 'main.mjs'), url)).toBe(true);
    expect(isEntry(resolve(linked, 'other.mjs'), url)).toBe(false);
    expect(isEntry(resolve(base, 'missing.mjs'), url)).toBe(false);
    // A path through a file, or with a name too long for the file system, names no file either: it cannot be the entry.
    expect(isEntry(resolve(main, 'main.mjs'), url)).toBe(false);
    expect(isEntry(resolve(base, 'x'.repeat(300)), url)).toBe(false);
    if (fileLink(main, resolve(base, 'tool'))) expect(isEntry(resolve(base, 'tool'), url)).toBe(true);
  });
});

it('throws rather than answering "not the entry" when a path fails to resolve for a reason other than absence', () => {
  // Answering false would let a tool exit 0 having done nothing. File links need privilege on Windows, and root reads a
  // directory whatever its mode, so the link loop and the unreadable directory are POSIX-only, non-root cases.
  if (process.platform === 'win32') return;
  scratch((base) => {
    const main = resolve(base, 'main.mjs'),
      url = pathToFileURL(main).href,
      locked = resolve(base, 'locked');
    writeFileSync(main, '');
    symlinkSync(resolve(base, 'b'), resolve(base, 'a'));
    symlinkSync(resolve(base, 'a'), resolve(base, 'b'));
    expect(() => isEntry(resolve(base, 'a'), url)).toThrow(/ELOOP/);
    if (process.getuid?.() === 0) return;
    mkdirSync(resolve(locked, 'sub'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(() => isEntry(resolve(locked, 'sub/main.mjs'), url)).toThrow(/EACCES/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

it('leaves no source with the old spelling of the check, resolving process.argv[1] and comparing it with ===', () => {
  // Comparing the resolved invoked path with the module's own path never matches through a link, so the tool exits 0
  // having done nothing. Only that spelling is caught: reversed operands, a URL comparison or a variable would pass,
  // and none is in the tree. The pattern and its sample are assembled so this file does not match itself.
  const invokedOnly = new RegExp(['resolve\\(process', '\\.argv\\[1\\]\\)\\s*==='].join(''));
  expect(
    invokedOnly.test(
      ['if (process.argv[1] !== undefined && resolve(process', '.argv[1]) === fileURLToPath(import.meta.url)) {'].join(
        '',
      ),
    ),
  ).toBe(true);
  const skip = new Set(['node_modules', 'dist', '.git', '.nx', 'artifacts', 'coverage']),
    found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name) && invokedOnly.test(readFileSync(path, 'utf8')))
        found.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  for (const area of ['apps', 'packages', 'tools', '.ia/src']) walk(resolve(root, area));
  expect(found).toEqual([]);
});

it('keeps every copy of the check the same function as @ia/runtime/entry, whose cases then cover each', () => {
  // This directory repeats it without dependencies, and folio (in the private tree only) repeats it because it may import
  // only @ia/language. Their bodies must be the runtime's; the JavaScript copy spells its one type assertion as a JSDoc cast.
  // tools/distribution/assemble-host.test.ts holds that file's copy to this directory's. This task hashes the whole tree.
  const body = (path: string): string | undefined =>
    /^export function isEntry\([^)]*\)[^{\n]*\{\n([\s\S]*?)\n\}/m.exec(
      readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n'),
    )?.[1];
  const runtime = body('packages/runtime/src/entry.ts');
  expect(runtime).toContain('realpathSync(argv1) === realpathSync(self)');
  // Export formatting may wrap the JS/JSDoc and TS forms differently. Compare
  // their complete parsed bodies, preserving tokens and string literal bytes.
  const canonical = (value: string | undefined): string => {
    expect(value).toBeDefined();
    return ts
      .createPrinter({ removeComments: true })
      .printFile(ts.createSourceFile('entry.ts', `function check() {${value}}`, ts.ScriptTarget.Latest, true));
  };
  expect(
    canonical(
      body('tools/entry/is-entry.mjs')?.replace(
        '/** @type {NodeJS.ErrnoException} */ (error)',
        '(error as NodeJS.ErrnoException)',
      ),
    ),
  ).toBe(canonical(runtime));
  if (existsSync(resolve(root, 'apps/folio/src/main.ts')))
    expect(canonical(body('apps/folio/src/main.ts'))).toBe(canonical(runtime));
});
