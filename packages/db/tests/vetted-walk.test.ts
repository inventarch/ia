import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readInputs } from '../src/index.js';

// The walk's own filesystem calls, counted and, where a case needs it, interleaved with a change. Nothing else
// changes: every call reaches the real filesystem.
const hooks: {
  beforeOpen?: ((path: string) => void) | undefined;
  beforeRealpath?: ((path: string) => void) | undefined;
} = {};
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args),
    {
      native: (path: fs.PathLike, ...rest: unknown[]) => {
        hooks.beforeRealpath?.(String(path));
        return (actual.realpathSync.native as (...args: unknown[]) => string)(path, ...rest);
      },
    },
  );
  return {
    ...actual,
    realpathSync,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn((path: fs.PathLike, ...rest: unknown[]) => {
      hooks.beforeOpen?.(String(path));
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    }),
  };
});

const temporary: string[] = [];
afterEach(() => {
  hooks.beforeOpen = undefined;
  hooks.beforeRealpath = undefined;
  vi.mocked(fs.lstatSync).mockClear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const workspace = () => {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-db-vetted-'));
  temporary.push(path);
  return path;
};
const put = (root: string, path: string, text: string) => {
  const file = resolve(root, path);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
// Counts a call under .ia/src whether it names the temporary root as created or as resolved (macOS /var is a link).
const inside = (root: string, path: string) =>
  [root, fs.realpathSync(root)].some((base) => {
    const rel = relative(resolve(base, '.ia/src'), path);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
  });

describe('the source walk vets each folder once', () => {
  it('makes one lstat per folder and two per file under .ia/src, however deep the files are', () => {
    const root = workspace();
    const deep = 'a/b/c/d/e/f';
    let files = 0;
    for (let i = 0; i < 6; i++) {
      put(root, `.ia/src/${deep}/n${i}.ia`, '#! ia 1.0\n');
      files++;
    }
    put(root, '.ia/src/top.ia', '#! ia 1.0\n');
    files++;
    const folders = deep.split('/').length + 1; // a … f, and .ia/src itself
    vi.mocked(fs.lstatSync).mockClear();
    const inputs = readInputs(root);
    expect(inputs.sources.filter((source) => !source.path.startsWith('.ia/src/floor/'))).toHaveLength(files);
    const calls = vi.mocked(fs.lstatSync).mock.calls.filter(([path]) => inside(root, String(path))).length;
    // One per folder, vetted once; per file, the name's own check and the post-read identity check; and a fixed few
    // for the source and floor roots. Before, every read lstat-ed every folder on its path again: 90 calls here.
    expect(calls).toBeLessThanOrEqual(folders + 2 * files + 6);
  });

  it('refuses a parent folder swapped for a junction between two reads, and reads nothing outside', () => {
    const root = workspace(),
      outside = workspace();
    put(root, '.ia/src/deep/a.ia', '#! ia 1.0\n');
    put(root, '.ia/src/deep/b.ia', '#! ia 1.0\n');
    put(outside, 'b.ia', '#! ia 1.0\n# outside secret\n');
    let swapped = false;
    hooks.beforeOpen = (path) => {
      if (swapped || !path.endsWith(`deep${sep}b.ia`)) return;
      swapped = true;
      renameSync(resolve(root, '.ia/src/deep'), resolve(root, '.ia/src/deep-moved'));
      symlinkSync(outside, resolve(root, '.ia/src/deep'), process.platform === 'win32' ? 'junction' : 'dir');
    };
    let outcome: unknown;
    try {
      outcome = readInputs(root);
    } catch (error) {
      outcome = error;
    }
    expect(swapped).toBe(true);
    expect(outcome).toMatchObject({ code: 'IA-DB-PATH-UNSAFE', path: '.ia/src/deep' });
    expect(readFileSync(resolve(outside, 'b.ia'), 'utf8')).toContain('outside secret');
  });
  it('refuses a parent folder swapped for a junction for the open and swapped back before the path check', () => {
    const root = workspace(),
      outside = workspace();
    put(root, '.ia/src/deep/a.ia', '#! ia 1.0\n');
    put(root, '.ia/src/deep/b.ia', '#! ia 1.0\n');
    put(outside, 'b.ia', '#! ia 1.0\n# outside secret\n');
    const folder = resolve(root, '.ia/src/deep'),
      moved = resolve(root, '.ia/src/deep-moved');
    let swapped = false,
      restored = false;
    hooks.beforeOpen = (path) => {
      if (swapped || !path.endsWith(`deep${sep}b.ia`)) return;
      swapped = true;
      renameSync(folder, moved);
      symlinkSync(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    };
    hooks.beforeRealpath = (path) => {
      if (!swapped || restored || !path.endsWith(`deep${sep}b.ia`)) return;
      restored = true;
      rmSync(folder, { recursive: false, force: true });
      renameSync(moved, folder);
    };
    let outcome: unknown;
    try {
      outcome = readInputs(root);
    } catch (error) {
      outcome = error;
    }
    expect(swapped && restored).toBe(true);
    expect(outcome).toMatchObject({ code: 'IA-DB-SOURCE-CHANGED' });
  });
});
