/**
 * The workspace's own installed `@inventarch/cli`, the dependency that pins it, and the package manager that installs
 * it: the facts a global `ia` needs to hand a command to the copy the workspace chose. Only the filesystem and local
 * git are consulted; every read that fails answers `null`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { satisfies as satisfiesRange } from '@inventarch/db/distribution';
import { runGit } from './channel.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export interface LocalCli {
  readonly packageRoot: string;
  readonly version: string;
  readonly entry: string;
}
export interface CliDependency {
  readonly manifest: string;
  readonly field: 'dependencies' | 'devDependencies';
  readonly range: string;
}

const CLI = '@inventarch/cli';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly packageManager?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}
const readJson = (path: string): Manifest | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** The CLI dependency of the nearest `package.json` at or above `root`; a nearer manifest without one is the answer. */
export function readCliDependency(root: string): CliDependency | null {
  for (let current = resolve(root); ; current = dirname(current)) {
    const manifest = resolve(current, 'package.json');
    if (existsSync(manifest)) {
      const json = readJson(manifest);
      if (json === null) return null;
      for (const field of ['dependencies', 'devDependencies'] as const) {
        const table = json[field];
        const range = isRecord(table) ? table[CLI] : undefined;
        if (typeof range === 'string') return { manifest, field, range };
      }
      return null;
    }
    if (dirname(current) === current) return null;
  }
}

const binEntry = (bin: unknown): string | null => {
  if (typeof bin === 'string') return bin;
  const ia = isRecord(bin) ? bin['ia'] : undefined;
  return typeof ia === 'string' ? ia : null;
};

/** The first installed copy from `root` up to `stopAt` decides: a valid one, or `null` when that copy is invalid. */
export function findLocalCli(root: string, stopAt: string): LocalCli | null {
  const stop = resolve(stopAt);
  for (let current = resolve(root); ; current = dirname(current)) {
    const dir = resolve(current, 'node_modules/@inventarch/cli');
    if (existsSync(resolve(dir, 'package.json'))) {
      const json = readJson(resolve(dir, 'package.json'));
      const bin = json === null ? null : binEntry(json.bin);
      if (json === null || json.name !== CLI || typeof json.version !== 'string' || bin === null) return null;
      try {
        const packageRoot = realpathSync(dir);
        const entry = resolve(packageRoot, bin);
        return existsSync(entry) ? { packageRoot, version: json.version, entry } : null;
      } catch {
        return null;
      }
    }
    if (current === stop || dirname(current) === current) return null;
  }
}

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
  const declared = readJson(resolve(directory, 'package.json'))?.packageManager;
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
