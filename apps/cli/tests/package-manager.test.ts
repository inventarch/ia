/**
 * The package-manager commands doctor's `cli-version` row names, as argv: with no directory flag where the manifest is
 * the directory the command runs in, and with the manager's own directory flag where it is not.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { displayFix, externalFix } from '../src/fix.js';
import { isWorkspaceRoot } from '../src/local-cli.js';
import type { PackageManager } from '../src/package-manager.js';
import {
  batchInstallArgv,
  installArgv,
  installCommand,
  pinArgv,
  pinCommand,
  yarnMajor,
} from '../src/package-manager.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const CLI = '@inventarch/cli@3.5.0';
/** A directory holding `package.json` (when given) and the named marker files. */
function project(prefix: string, manifest: Record<string, unknown> | null, ...markers: string[]): string {
  const directory = scratch(prefix);
  if (manifest !== null) writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifest));
  for (const marker of markers) writeFileSync(resolve(directory, marker), '');
  return directory;
}
const display = (argv: readonly string[]): string => displayFix(externalFix(argv, 'repo').fix);

it('at the manifest directory, every install argv has no directory flag and displays as before', () => {
  const at = project('pm-same', {});
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    expect(installArgv(manager, at, at)).toEqual([manager, 'install']);
    expect(display(installArgv(manager, at, at))).toBe(installCommand(manager));
  }
});
it('at the manifest directory, every pin argv has no directory flag and displays as before', () => {
  const at = project('pm-pin-same', {});
  const expected: Readonly<Record<PackageManager, readonly string[]>> = {
    npm: ['npm', 'install', '-D', CLI],
    pnpm: ['pnpm', 'add', '-D', CLI],
    yarn: ['yarn', 'add', '-D', CLI],
    bun: ['bun', 'add', '-d', CLI],
  };
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    expect(pinArgv(manager, '3.5.0', at, at)).toEqual(expected[manager]);
    expect(display(pinArgv(manager, '3.5.0', at, at))).toBe(pinCommand(manager, '3.5.0', at));
  }
});
it('keeps pnpm -w at a pnpm workspace root and Yarn Classic -W at a Yarn Classic workspace root', () => {
  const pnpm = project('pm-pnpm-root', {}, 'pnpm-workspace.yaml');
  expect(pinArgv('pnpm', '3.5.0', pnpm, pnpm)).toEqual(['pnpm', 'add', '-D', '-w', CLI]);
  expect(pinCommand('pnpm', '3.5.0', pnpm)).toBe(`pnpm add -D -w ${CLI}`);
  const yarn = project('pm-yarn-root', { workspaces: ['packages/*'] });
  expect(pinArgv('yarn', '3.5.0', yarn, yarn)).toEqual(['yarn', 'add', '-D', '-W', CLI]);
  expect(pinCommand('yarn', '3.5.0', yarn)).toBe(`yarn add -D -W ${CLI}`);
  const packages = project('pm-yarn-packages', { workspaces: { packages: ['a'] } });
  expect(pinCommand('yarn', '3.5.0', packages)).toBe(`yarn add -D -W ${CLI}`);
});

it('names another directory with each manager’s own flag', () => {
  const at = project('pm-at', {}),
    directory = resolve(scratch('pm-other'), 'with space');
  mkdirSync(directory);
  expect(installArgv('npm', directory, at)).toEqual(['npm', 'install', '--prefix', directory]);
  expect(installArgv('pnpm', directory, at)).toEqual(['pnpm', '--dir', directory, 'install']);
  expect(installArgv('yarn', directory, at)).toEqual(['yarn', '--cwd', directory, 'install']);
  expect(installArgv('bun', directory, at)).toEqual(['bun', 'install', '--cwd', directory]);
  expect(pinArgv('npm', '3.5.0', directory, at)).toEqual(['npm', 'install', '-D', '--prefix', directory, CLI]);
  expect(pinArgv('pnpm', '3.5.0', directory, at)).toEqual(['pnpm', '--dir', directory, 'add', '-D', CLI]);
  expect(pinArgv('yarn', '3.5.0', directory, at)).toEqual(['yarn', '--cwd', directory, 'add', '-D', CLI]);
  expect(pinArgv('bun', '3.5.0', directory, at)).toEqual(['bun', 'add', '-d', '--cwd', directory, CLI]);
  // The directory is quoted in the display exactly as every other printed argument is.
  expect(display(installArgv('npm', directory, at))).toBe(`npm install --prefix ${JSON.stringify(directory)}`);
});
it('names a drive path on Windows', { skip: process.platform !== 'win32' }, () => {
  expect(installArgv('pnpm', 'D:\\repo', 'C:\\work')).toEqual(['pnpm', '--dir', 'D:\\repo', 'install']);
  expect(display(installArgv('npm', 'D:\\repo', 'C:\\work'))).toBe('npm install --prefix D:\\repo');
  // One path spelled in two cases is one directory.
  expect(installArgv('npm', 'C:\\Work', 'c:\\work')).toEqual(['npm', 'install']);
});
it('names another directory with -w and -W only at a workspace root of that manager', () => {
  const at = project('pm-root-at', {});
  const pnpm = project('pm-root-pnpm', {}, 'pnpm-workspace.yaml');
  expect(pinArgv('pnpm', '3.5.0', pnpm, at)).toEqual(['pnpm', '--dir', pnpm, 'add', '-D', '-w', CLI]);
  const classic = project('pm-root-classic', { workspaces: ['a'] });
  expect(pinArgv('yarn', '3.5.0', classic, at)).toEqual(['yarn', '--cwd', classic, 'add', '-D', '-W', CLI]);
  // Yarn 2 and later use the same leading --cwd and never take -W.
  const berry = project('pm-root-berry', { workspaces: ['a'], packageManager: 'yarn@4.1.0' });
  expect(pinArgv('yarn', '3.5.0', berry, at)).toEqual(['yarn', '--cwd', berry, 'add', '-D', CLI]);
  expect(installArgv('yarn', berry, at)).toEqual(['yarn', '--cwd', berry, 'install']);
});

it('detects the Yarn major apart from workspace roots', () => {
  expect(yarnMajor(project('pm-yarnrc', {}, '.yarnrc.yml'))).toBe('berry');
  expect(yarnMajor(project('pm-yarn4', { packageManager: 'yarn@4.1.0' }))).toBe('berry');
  expect(yarnMajor(project('pm-yarn1', { packageManager: 'yarn@1.22.22' }))).toBe('classic');
  expect(yarnMajor(project('pm-yarn-none', {}))).toBe('classic');
  expect(yarnMajor(project('pm-yarn-nofile', null))).toBe('classic');
  // Yarn Classic without workspaces is no workspace root, so it takes no -W.
  const plain = project('pm-classic-plain', { packageManager: 'yarn@1.22.22' });
  expect(isWorkspaceRoot(plain)).toBe(false);
  expect(pinArgv('yarn', '3.5.0', plain, plain)).toEqual(['yarn', 'add', '-D', CLI]);
  // A Yarn 2+ workspace root is a workspace root, but takes no -W.
  const berry = project('pm-berry-root', { workspaces: ['a'] }, '.yarnrc.yml');
  expect(isWorkspaceRoot(berry)).toBe(true);
  expect(pinArgv('yarn', '3.5.0', berry, berry)).toEqual(['yarn', 'add', '-D', CLI]);
  // A Yarn Classic workspace root takes -W.
  const classic = project('pm-classic-root', { workspaces: ['a'], packageManager: 'yarn@1.22.22' });
  expect(pinArgv('yarn', '3.5.0', classic, classic)).toEqual(['yarn', 'add', '-D', '-W', CLI]);
  // pnpm's -w reads only its pnpm-workspace.yaml.
  const yaml = project('pm-pnpm-yaml', {}, 'pnpm-workspace.yaml');
  expect(pinArgv('pnpm', '3.5.0', yaml, yaml)).toEqual(['pnpm', 'add', '-D', '-w', CLI]);
  const listed = project('pm-pnpm-plain', { workspaces: ['a'] });
  expect(pinArgv('pnpm', '3.5.0', listed, listed)).toEqual(['pnpm', 'add', '-D', CLI]);
});

it('the displayed pin and the structured argv take one -W rule, the root installRoot sees', () => {
  // Yarn Classic with `workspaces: {nohoist}` and no packages is no workspace root, so neither takes -W.
  const nohoist = project('pm-nohoist', { workspaces: { nohoist: ['**/foo'] }, packageManager: 'yarn@1.22.22' });
  expect(pinCommand('yarn', '3.5.0', nohoist)).toBe(`yarn add -D ${CLI}`);
  expect(pinArgv('yarn', '3.5.0', nohoist, nohoist)).toEqual(['yarn', 'add', '-D', CLI]);
});

it('a batch install under pnpm also ignores the repository pnpmfile, and no other manager gets that flag', () => {
  const dir = project('pm-batch-pnpmfile', {});
  expect(batchInstallArgv('pnpm', dir, dir, true)).toEqual([
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--ignore-pnpmfile',
  ]);
  expect(batchInstallArgv('pnpm', dir, dir, false)).toEqual([
    'pnpm',
    'install',
    '--ignore-scripts',
    '--ignore-pnpmfile',
  ]);
  expect(batchInstallArgv('npm', dir, dir, true)).toEqual(['npm', 'ci', '--ignore-scripts']);
  expect(batchInstallArgv('yarn', dir, dir, true)).toEqual([
    'yarn',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  expect(batchInstallArgv('bun', dir, dir, true)).toEqual(['bun', 'install', '--frozen-lockfile', '--ignore-scripts']);
});
