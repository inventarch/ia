/**
 * The package manager that installs the workspace's `@inventarch/cli`, and whether the installed copy satisfies the
 * range its manifest lists: what doctor's `cli-version` row reports (host-plugin-distribution §7.3). Hand-off never
 * needs these, so they sit apart from local-cli.ts. Only the filesystem and local git are consulted.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { satisfies as satisfiesRange } from '@inventarch/db/distribution';
import type { Git } from './channel.js';
import { runGit } from './channel.js';
import { CLI, isWorkspaceRoot, readManifest } from './local-cli.js';

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

/** The managers whose lockfiles git tracks in `directory` (outside git, the ones present). */
function lockedManagers(directory: string, git: Git): ReadonlySet<PackageManager> {
  const names = LOCKFILES.map(([file]) => file);
  const listed = git(directory, ['ls-files', '--', ...names]);
  const locks =
    listed === null
      ? names.filter((file) => existsSync(resolve(directory, file)))
      : listed.split(/\r?\n/).filter((file) => names.includes(file));
  return new Set(LOCKFILES.flatMap(([file, manager]) => (locks.includes(file) ? [manager] : [])));
}
/** `manager`'s own lockfile is tracked in `directory` (outside git, present), so an install can be frozen to it. */
export const lockTracked = (directory: string, manager: PackageManager, git: Git = runGit): boolean =>
  lockedManagers(directory, git).has(manager);

/** The `packageManager` field, then the lockfiles git tracks (outside git, the ones present); never a guess. */
export function detectPackageManager(
  directory: string,
  git: Git = runGit,
): {
  readonly manager: PackageManager | null;
  readonly conflict: readonly string[];
} {
  const found = new Set<PackageManager>();
  const declared = readManifest(resolve(directory, 'package.json'))?.packageManager;
  const name = typeof declared === 'string' ? (declared.split('@')[0] ?? '') : '';
  if (MANAGERS.has(name)) found.add(name as PackageManager);
  for (const manager of lockedManagers(directory, git)) found.add(manager);
  const managers = [...found].sort();
  if (managers.length > 1) return { manager: null, conflict: managers };
  return { manager: managers[0] ?? null, conflict: [] };
}

/** `directory` and `at` name one directory: resolved, and compared without case on Windows, whose volumes fold it. */
const sameDirectory = (a: string, b: string): boolean => {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const packageManagerField = (directory: string): string => {
  const value = readManifest(resolve(directory, 'package.json'))?.packageManager;
  return typeof value === 'string' ? value : '';
};
/** Yarn 2 and later (Berry) where a `.yarnrc.yml` or a `yarn@2+` packageManager marks it; otherwise Yarn Classic. */
export function yarnMajor(directory: string): 'classic' | 'berry' {
  if (existsSync(resolve(directory, '.yarnrc.yml'))) return 'berry';
  return /^yarn@([2-9]|\d{2,})/.test(packageManagerField(directory)) ? 'berry' : 'classic';
}

/*
 * Each manager's own flag for acting on another directory, checked against its documentation:
 * - npm: the `prefix` config, which on the command line "forces non-global commands to run in the specified folder"
 *   (docs.npmjs.com, config `prefix`): `npm install --prefix <dir>`;
 * - pnpm: `-C, --dir <dir>`, "run as if pnpm was started in <dir>" (pnpm.io, CLI options; `pnpm --help`);
 * - Yarn Classic: the global `--cwd <dir>` (classic.yarnpkg.com, CLI docs); Yarn 2 and later read a leading
 *   `--cwd <dir>` before the command (yarnpkg/berry, packages/yarnpkg-cli/sources/lib.ts);
 * - Bun: `--cwd <dir>` on `bun install` and `bun add` (bun.sh, docs for both commands).
 * Where `directory` is `at`, no flag is added, so the command reads exactly as it always has.
 */
const DIRECTED_INSTALL: Readonly<Record<PackageManager, (dir: string) => readonly string[]>> = {
  npm: (dir) => ['npm', 'install', '--prefix', dir],
  pnpm: (dir) => ['pnpm', '--dir', dir, 'install'],
  yarn: (dir) => ['yarn', '--cwd', dir, 'install'],
  bun: (dir) => ['bun', 'install', '--cwd', dir],
};
const DIRECTED_ADD: Readonly<Record<PackageManager, (dir: string, flags: readonly string[]) => readonly string[]>> = {
  npm: (dir, flags) => ['npm', 'install', '-D', ...flags, '--prefix', dir],
  pnpm: (dir, flags) => ['pnpm', '--dir', dir, 'add', '-D', ...flags],
  yarn: (dir, flags) => ['yarn', '--cwd', dir, 'add', '-D', ...flags],
  bun: (dir, flags) => ['bun', 'add', '-d', ...flags, '--cwd', dir],
};
const ADD: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ['npm', 'install', '-D'],
  pnpm: ['pnpm', 'add', '-D'],
  yarn: ['yarn', 'add', '-D'],
  bun: ['bun', 'add', '-d'],
};

/**
 * The install of the manifest in `directory`, run in `at`. A plain install, never a frozen one: the row asks for it
 * exactly when the lockfile is missing or no longer matches the manifest, which a frozen install refuses.
 */
export const installArgv = (manager: PackageManager, directory: string, at: string): readonly string[] =>
  sameDirectory(directory, at) ? [manager, 'install'] : DIRECTED_INSTALL[manager](directory);
export const installCommand = (manager: PackageManager): string => installArgv(manager, '.', '.').join(' ');
/**
 * `argv` installs every dependency of its manifest and may rewrite the lockfile: a plain install as `installArgv` builds
 * it, or a pin as `pinArgv` does (`-w`/`-W` included), in its own directory or directed at another, the manager named
 * first. These are the steps doctor's `cli-version` row, the console's fallback for it and the upgrade recipe begin
 * with. Matched by argv rather than a mark on the step, since a workspace's own, older copy reports its fixes as JSON.
 */
export function installsDependencies(argv: readonly string[]): argv is readonly [PackageManager, ...string[]] {
  const [manager] = argv;
  if (manager === undefined || !MANAGERS.has(manager)) return false;
  const named = manager as PackageManager;
  const same = (form: readonly string[]): boolean =>
    form.length === argv.length && form.every((token, index) => token === argv[index]);
  const spec = argv.at(-1) ?? '';
  const pin = spec !== '' && !spec.startsWith('-');
  // Any token may be the directory a directed form names; every form is rebuilt and compared whole.
  return [undefined, ...argv].some((directory) =>
    directory === undefined
      ? same([named, 'install']) || (pin && [[], ['-w'], ['-W']].some((flags) => same([...ADD[named], ...flags, spec])))
      : same(DIRECTED_INSTALL[named](directory)) ||
        (pin && [[], ['-w'], ['-W']].some((flags) => same([...DIRECTED_ADD[named](directory, flags), spec]))),
  );
}

/**
 * The install a batch runs in a new worktree (consumer CLI contract §1.2): `installArgv`'s form, with no lifecycle
 * script run (a `preinstall` or `postinstall` could follow the worktree's `.git` file back to the user's checkout) and,
 * where `locked` says the manager's lockfile is tracked, frozen to it, so the install never rewrites it. npm: `ci
 * --ignore-scripts` (`install --ignore-scripts` unlocked); pnpm, Yarn Classic and Bun: `install --frozen-lockfile
 * --ignore-scripts`; Yarn 2 and later, which has no `--ignore-scripts`: `install --immutable --mode=skip-build`.
 */
export function batchInstallArgv(
  manager: PackageManager,
  directory: string,
  at: string,
  locked: boolean,
): readonly string[] {
  const argv = [...installArgv(manager, directory, at)];
  const berry = manager === 'yarn' && yarnMajor(directory) === 'berry';
  const flags =
    manager === 'npm'
      ? ['--ignore-scripts']
      : berry
        ? [...(locked ? ['--immutable'] : []), '--mode=skip-build']
        : [...(locked ? ['--frozen-lockfile'] : []), '--ignore-scripts'];
  argv.splice(argv.indexOf('install'), 1, manager === 'npm' && locked ? 'ci' : 'install', ...flags);
  return argv;
}

/**
 * The addition of the dependency to the `package.json` in `directory`, run in `at`. At a workspace root pnpm and Yarn 1
 * refuse an addition without `-w` and `-W`; Yarn 2 and later, which a `.yarnrc.yml` or a `yarn@2+` packageManager marks,
 * take none. pnpm reads only a `pnpm-workspace.yaml`; for Yarn 1 the root is the one installRoot sees (isWorkspaceRoot).
 */
export function pinArgv(manager: PackageManager, version: string, directory: string, at: string): readonly string[] {
  const flags =
    manager === 'pnpm' && existsSync(resolve(directory, 'pnpm-workspace.yaml'))
      ? ['-w']
      : manager === 'yarn' && yarnClassicRoot(directory)
        ? ['-W']
        : [];
  const dependency = `${CLI}@${version}`;
  return sameDirectory(directory, at)
    ? [...ADD[manager], ...flags, dependency]
    : [...DIRECTED_ADD[manager](directory, flags), dependency];
}
/** The pin as the cli-version remedy prints it: pinArgv run in `directory` itself, so the two never differ in flags. */
export const pinCommand = (manager: PackageManager, version: string, directory: string): string =>
  pinArgv(manager, version, directory, directory).join(' ');
/** A Yarn Classic workspace root, by the test installRoot applies (isWorkspaceRoot): `{"workspaces":{}}` is none. */
const yarnClassicRoot = (directory: string): boolean =>
  isWorkspaceRoot(directory) &&
  readManifest(resolve(directory, 'package.json')) !== null &&
  yarnMajor(directory) === 'classic';
