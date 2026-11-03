/**
 * The workspace's own installed `@inventarch/cli` and the dependency that pins it: the facts an `ia` needs to hand a
 * command to the copy the workspace chose. Only the filesystem is consulted, so the `ia` bin decides with this module
 * before any command module loads (bin.ts); every read that fails answers `null`. The package manager that installs
 * the copy, which only doctor reports, is package-manager.ts.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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

const segment = (glob: string, name: string): boolean =>
  glob === name || new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`).test(name);
const matches = (glob: readonly string[], member: readonly string[]): boolean => {
  const [head, ...rest] = glob;
  if (head === undefined) return member.length === 0;
  if (head === '**') return matches(rest, member) || (member.length > 0 && matches(glob, member.slice(1)));
  const [first, ...others] = member;
  return first !== undefined && segment(head, first) && matches(rest, others);
};

/**
 * Whether workspace `globs` list `member`, a `/`-separated path relative to the workspace root. `*` is one segment,
 * `**` any number, a leading `!` excludes, and the last matching glob decides, as in npm.
 */
export function ownsMember(globs: readonly string[], member: string): boolean {
  const path = member.split('/').filter((part) => part !== '' && part !== '.');
  let owned = false;
  for (const raw of globs) {
    const negated = raw.startsWith('!');
    const parts = (negated ? raw.slice(1) : raw).split('/').filter((part) => part !== '' && part !== '.');
    if (matches(parts, path)) owned = !negated;
  }
  return owned;
}

/** The `packages:` block list of a `pnpm-workspace.yaml`, scanned by line (no YAML parser: bin.ts stays cheap). */
const pnpmPackages = (text: string): string[] => {
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line) && !line.startsWith('#')) inside = /^packages\s*:\s*(#.*)?$/.test(line);
    else if (inside) {
      const item = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|([^\s#]+))/.exec(line);
      const glob = item?.[1] ?? item?.[2] ?? item?.[3];
      if (glob !== undefined) globs.push(glob);
    }
  }
  return globs;
};

/** The workspace globs `directory` declares, or `null` when it is not a package-manager workspace root. */
const workspaceGlobs = (directory: string): string[] | null => {
  const pnpm = resolve(directory, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      return pnpmPackages(readFileSync(pnpm, 'utf8'));
    } catch {
      return null;
    }
  }
  const declared = readManifest(resolve(directory, 'package.json'))?.workspaces;
  const list = Array.isArray(declared) ? declared : isRecord(declared) ? declared['packages'] : undefined;
  return Array.isArray(list) ? list.filter((glob): glob is string => typeof glob === 'string') : null;
};

/**
 * The directory that owns the install for the package at `manifestDirectory`: the nearest ancestor that is a
 * package-manager workspace root (`pnpm-workspace.yaml` or `package.json` `workspaces`) when its globs list the
 * package, since npm, Yarn and Bun hoist the copy there; otherwise `manifestDirectory`. Only that nearest root is
 * consulted, and nothing above it is the repository's.
 */
export function installRoot(manifestDirectory: string): string {
  const member = resolve(manifestDirectory);
  for (let current = dirname(member); current !== dirname(current); current = dirname(current)) {
    const globs = workspaceGlobs(current);
    if (globs === null) continue;
    return ownsMember(globs, relative(current, member).replaceAll('\\', '/')) ? current : member;
  }
  return member;
}
