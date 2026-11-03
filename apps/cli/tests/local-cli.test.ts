import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findLocalCli, readCliDependency } from '../src/local-cli.js';
import { detectPackageManager, installCommand, pinCommand, satisfies } from '../src/package-manager.js';
import type { PackageManager } from '../src/package-manager.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const putJson = (path: string, value: unknown): void => put(path, JSON.stringify(value));
const cliCopy = (base: string, manifest: Record<string, unknown> = {}): string => {
  const dir = resolve(base, 'node_modules/@inventarch/cli');
  putJson(resolve(dir, 'package.json'), {
    name: '@inventarch/cli',
    version: '3.5.0',
    bin: { ia: 'dist/main.js' },
    ...manifest,
  });
  put(resolve(dir, 'dist/main.js'), '');
  return dir;
};
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
};

describe('findLocalCli', () => {
  it('finds the copy two directories up', () => {
    const base = scratch('local-up');
    const dir = cliCopy(base);
    const found = findLocalCli(resolve(base, 'a/b'), base);
    expect(found).toMatchObject({ version: '3.5.0' });
    expect(found?.entry).toBe(resolve(found?.packageRoot ?? '', 'dist/main.js'));
    expect(found?.packageRoot.toLowerCase()).toBe(dir.toLowerCase());
  });
  it('accepts a string bin', () => {
    const base = scratch('local-string-bin');
    const dir = cliCopy(base);
    putJson(resolve(dir, 'package.json'), { name: '@inventarch/cli', version: '3.5.0', bin: 'dist/main.js' });
    expect(findLocalCli(base, base)).toMatchObject({ version: '3.5.0' });
  });
  it('null when absent', () => {
    expect(findLocalCli(scratch('local-absent'), scratch('local-absent-stop'))).toBeNull();
  });
  it('null when entry missing', () => {
    const base = scratch('local-no-entry');
    const dir = cliCopy(base);
    putJson(resolve(dir, 'package.json'), { name: '@inventarch/cli', version: '3.5.0', bin: { ia: 'dist/gone.js' } });
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('null when name differs', () => {
    const base = scratch('local-name');
    cliCopy(base, { name: 'not-the-cli' });
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('null for malformed JSON', () => {
    const base = scratch('local-malformed');
    put(resolve(base, 'node_modules/@inventarch/cli/package.json'), '{');
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('stops at the first node_modules/@inventarch/cli', () => {
    const base = scratch('local-first');
    cliCopy(base);
    cliCopy(resolve(base, 'pkg'), { name: 'wrong' });
    expect(findLocalCli(resolve(base, 'pkg'), base)).toBeNull();
  });
  it('stops the walk at the pinning manifest', () => {
    const base = scratch('local-stop');
    cliCopy(base);
    expect(findLocalCli(resolve(base, 'pkg'), resolve(base, 'pkg'))).toBeNull();
  });
});

describe('readCliDependency', () => {
  it('reads a devDependencies CLI dependency', () => {
    const base = scratch('dep-dev');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    expect(readCliDependency(base)).toEqual({
      field: 'devDependencies',
      range: '3.5.0',
      manifest: resolve(base, 'package.json'),
    });
  });
  it('reads a dependencies CLI dependency', () => {
    const base = scratch('dep-prod');
    putJson(resolve(base, 'package.json'), { dependencies: { '@inventarch/cli': '^3.5.0' } });
    expect(readCliDependency(base)).toMatchObject({ field: 'dependencies', range: '^3.5.0' });
  });
  it('null when the nearest package.json has none', () => {
    const base = scratch('dep-none');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    putJson(resolve(base, 'sub/package.json'), { name: 'sub' });
    expect(readCliDependency(resolve(base, 'sub/deeper'))).toBeNull();
  });
  it('null for a malformed nearest package.json', () => {
    const base = scratch('dep-bad');
    put(resolve(base, 'package.json'), '{');
    expect(readCliDependency(base)).toBeNull();
  });
  it('ignores a nested CLI dependency below the root', () => {
    const base = scratch('dep-nested');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    putJson(resolve(base, 'app/kits/_tools/package.json'), { devDependencies: { '@inventarch/cli': '3.4.1' } });
    expect(readCliDependency(base)).toMatchObject({ range: '3.5.0', manifest: resolve(base, 'package.json') });
  });
});

describe('detectPackageManager', () => {
  const cases: [string, { packageManager?: string; tracked?: string[] }, PackageManager | null][] = [
    ['packageManager field', { packageManager: 'pnpm@11.25.0' }, 'pnpm'],
    ['tracked pnpm-lock.yaml', { tracked: ['pnpm-lock.yaml'] }, 'pnpm'],
    ['tracked yarn.lock', { tracked: ['yarn.lock'] }, 'yarn'],
    ['tracked bun.lockb', { tracked: ['bun.lockb'] }, 'bun'],
    ['tracked package-lock.json', { tracked: ['package-lock.json'] }, 'npm'],
    ['nothing', {}, null],
  ];
  it.each(cases)('detects the package manager: %s', (_name, { packageManager, tracked = [] }, expected) => {
    const base = scratch('pm-table');
    git(base, 'init', '-q');
    putJson(resolve(base, 'package.json'), packageManager ? { packageManager } : {});
    for (const file of tracked) put(resolve(base, file), '');
    if (tracked.length > 0) git(base, 'add', ...tracked);
    expect(detectPackageManager(base)).toEqual({ manager: expected, conflict: [] });
  });
  it('ignores an untracked pnpm-lock.yaml beside a tracked package-lock.json', () => {
    const base = scratch('pm-untracked');
    git(base, 'init', '-q');
    put(resolve(base, 'package-lock.json'), '');
    put(resolve(base, 'pnpm-lock.yaml'), '');
    git(base, 'add', 'package-lock.json');
    expect(detectPackageManager(base)).toEqual({ manager: 'npm', conflict: [] });
  });
  it('reports packageManager pnpm with a tracked package-lock.json as a conflict', () => {
    const base = scratch('pm-conflict');
    git(base, 'init', '-q');
    putJson(resolve(base, 'package.json'), { packageManager: 'pnpm@11.25.0' });
    put(resolve(base, 'package-lock.json'), '');
    git(base, 'add', 'package-lock.json');
    expect(detectPackageManager(base)).toEqual({ manager: null, conflict: ['npm', 'pnpm'] });
  });
  it('counts the lockfiles on disk outside git', () => {
    const base = scratch('pm-no-git');
    put(resolve(base, 'yarn.lock'), '');
    expect(detectPackageManager(base)).toEqual({ manager: 'yarn', conflict: [] });
  });
  it('ignores an unknown packageManager name', () => {
    const base = scratch('pm-unknown');
    putJson(resolve(base, 'package.json'), { packageManager: 'deno@2.0.0' });
    expect(detectPackageManager(base)).toEqual({ manager: null, conflict: [] });
  });
});

it('satisfies: exact true and false, caret, and null for an unevaluated range', () => {
  expect(satisfies('3.5.0', '3.5.0')).toBe(true);
  expect(satisfies('3.5.1', '3.5.0')).toBe(false);
  expect(satisfies('3.5.1', '^3.5.0')).toBe(true);
  expect(satisfies('4.0.0', '^3.5.0')).toBe(false);
  expect(satisfies('3.5.0', 'workspace:*')).toBeNull();
  expect(satisfies('3.5.0', 'latest')).toBeNull();
  expect(satisfies('not a version', '3.5.0')).toBeNull();
});
it('spells install and pin commands', () => {
  // Plain installs: the row asks for one when the lockfile is missing or behind the manifest, which a frozen one refuses.
  expect(installCommand('npm')).toBe('npm install');
  expect(installCommand('pnpm')).toBe('pnpm install');
  expect(installCommand('yarn')).toBe('yarn install');
  expect(installCommand('bun')).toBe('bun install');
  const plain = scratch('pin-plain');
  expect(pinCommand('npm', '3.5.1', plain)).toBe('npm install -D @inventarch/cli@3.5.1');
  expect(pinCommand('pnpm', '3.5.1', plain)).toBe('pnpm add -D @inventarch/cli@3.5.1');
  expect(pinCommand('yarn', '3.5.1', plain)).toBe('yarn add -D @inventarch/cli@3.5.1');
  expect(pinCommand('bun', '3.5.1', plain)).toBe('bun add -d @inventarch/cli@3.5.1');
});
it('adds the workspace-root flag only where the manager refuses without it', () => {
  const pnpmRoot = scratch('pin-pnpm-root');
  writeFileSync(resolve(pnpmRoot, 'pnpm-workspace.yaml'), 'packages: []');
  expect(pinCommand('pnpm', '3.5.1', pnpmRoot)).toBe('pnpm add -D -w @inventarch/cli@3.5.1');
  const classic = scratch('pin-yarn-classic');
  writeFileSync(resolve(classic, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  expect(pinCommand('yarn', '3.5.1', classic)).toBe('yarn add -D -W @inventarch/cli@3.5.1');
  const berry = scratch('pin-yarn-berry');
  writeFileSync(
    resolve(berry, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@4.5.0' }),
  );
  expect(pinCommand('yarn', '3.5.1', berry)).toBe('yarn add -D @inventarch/cli@3.5.1');
  const rc = scratch('pin-yarn-rc');
  writeFileSync(resolve(rc, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(resolve(rc, '.yarnrc.yml'), '');
  expect(pinCommand('yarn', '3.5.1', rc)).toBe('yarn add -D @inventarch/cli@3.5.1');
});
