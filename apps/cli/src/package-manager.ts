/**
 * The package manager that installs the workspace's `@inventarch/cli`, and whether the installed copy satisfies the
 * range its manifest lists: what doctor's `cli-version` row reports (host-plugin-distribution §7.3). Hand-off never
 * needs these, so they sit apart from local-cli.ts. Only the filesystem and local git are consulted.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { satisfies as satisfiesRange } from '@inventarch/db/distribution';
import { runGit } from './channel.js';
import { CLI, readManifest } from './local-cli.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** `null` when the version or the range is not one this check evaluates (`workspace:*`, `file:..`, `latest`). */
export function satisfies(version: string, range: string): boolean | null {
  try {
    return satisfiesRange(version, range);
  } catch {
    return null;
  }
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];
const MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The `packageManager` field, then the lockfiles git tracks (outside git, the ones present); never a guess. */
export function detectPackageManager(directory: string): {
  readonly manager: PackageManager | null;
  readonly conflict: readonly string[];
} {
  const found = new Set<PackageManager>();
  const declared = readManifest(resolve(directory, 'package.json'))?.packageManager;
  const name = typeof declared === 'string' ? (declared.split('@')[0] ?? '') : '';
  if (MANAGERS.has(name)) found.add(name as PackageManager);
  const names = LOCKFILES.map(([file]) => file);
  const listed = runGit(directory, ['ls-files', '--', ...names]);
  const locks =
    listed === null
      ? names.filter((file) => existsSync(resolve(directory, file)))
      : listed.split(/\r?\n/).filter((file) => names.includes(file));
  for (const [file, manager] of LOCKFILES) if (locks.includes(file)) found.add(manager);
  const managers = [...found].sort();
  if (managers.length > 1) return { manager: null, conflict: managers };
  return { manager: managers[0] ?? null, conflict: [] };
}

const INSTALL: Readonly<Record<PackageManager, string>> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
};
export const installCommand = (manager: PackageManager): string => INSTALL[manager];

const PIN: Readonly<Record<PackageManager, string>> = {
  npm: 'npm install -D',
  pnpm: 'pnpm add -D',
  yarn: 'yarn add -D',
  bun: 'bun add -d',
};
export const pinCommand = (manager: PackageManager, version: string): string => `${PIN[manager]} ${CLI}@${version}`;
