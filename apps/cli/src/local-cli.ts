/**
 * The workspace's own installed `@inventarch/cli` and the dependency that pins it: the facts an `ia` needs to hand a
 * command to the copy the workspace chose. Only the filesystem is consulted, so the `ia` bin decides with this module
 * before any command module loads (bin.ts); every read that fails answers `null`. The package manager that installs
 * the copy, which only doctor reports, is package-manager.ts.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

export const CLI = '@inventarch/cli';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly packageManager?: unknown;
  readonly workspaces?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}
/** The `package.json` at `path` when it parses to an object, or `null`. */
export const readManifest = (path: string): Manifest | null => {
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
      const json = readManifest(manifest);
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
      const json = readManifest(resolve(dir, 'package.json'));
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
