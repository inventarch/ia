/**
 * consumer-cli-contract §1.2's first step: a command typed into another `ia` runs on the `@inventarch/cli` the
 * workspace pins and has installed. Deciding reads only directories, `package.json` files and a `pnpm-workspace.yaml`, and asks git once whether
 * the copy is committed; nothing is parsed yet, so an argument the workspace's copy accepts and this copy does not still
 * reaches it. The tokens are not parsed either: a value spelled like `--user` or `--root` (`--search --user`) routes as
 * the flag, and this copy answers, as it does for any typed command it cannot place.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sameFile } from '@inventarch/db/internal/paths';
import { discoverRoot } from './discovery.js';
import { resolveWorkspaceCli } from './local-cli.js';
import type { LocalCli } from './local-cli.js';
import { findProgram, programEnv, programHome, withoutGitRouting } from './program.js';

/** Set only by the copy that hands off, to its package root's real path; any non-empty value stops a second hand-off. */
export const HANDOFF_FROM = 'IA_HANDOFF_FROM';
/** `1` turns hand-off off: this copy answers. */
export const NO_HANDOFF = 'IA_NO_HANDOFF';

/** The tokens before `--`, where an option is still an option. */
const options = (argv: readonly string[]): readonly string[] => {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Whether a `.git` directory or file exists at `dir` or any parent: a work tree git was, or would have been, asked about. */
function insideWorkTree(dir: string): boolean {
  let current = real(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether the installed copy at `packageRoot` is the repository's: git tracks a file of it, or git could not say and a
 * `.git` exists at or above it. A copy committed to the repository is the repository's code, not an install the user
 * ran, so a typed command never runs it. Asked only when a hand-off is about to happen; git is found as program.ts
 * finds it and runs without the caller's `GIT_*` routing variables. When git exits non-zero, is stopped by its
 * timeout or cannot be started, the answer is the work tree's: inside one the copy is refused, so a git that cannot
 * answer never lets a repository's copy run. Only without git and without any `.git` above, or outside every
 * repository (git answers non-zero and no `.git` is above), is nothing tracked.
 */
export function committed(packageRoot: string): boolean {
  const git = findProgram('git', process.env);
  if (git === null) return insideWorkTree(packageRoot);
  const result = spawnSync(git, ['--no-optional-locks', '-C', packageRoot, 'ls-files', '--', '.'], {
    cwd: programHome(),
    env: programEnv(withoutGitRouting(process.env)),
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return insideWorkTree(packageRoot);
  return result.stdout.trim() !== '';
}

const ROOT = '--root=';
/** The first `--root` before `--`, when it names a workspace; without one, the workspace discovered from `cwd`. */
export function rootFromArgv(argv: readonly string[], cwd: string, iaHome: string | undefined): string | undefined {
  const tokens = options(argv);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const value = token === '--root' ? tokens[index + 1] : token.startsWith(ROOT) ? token.slice(ROOT.length) : null;
    if (value === null) continue;
    if (value === undefined || value === '') return undefined;
    // At its real path, as the command opens it (consumer.ts): a root reached through a link takes the CLI its real
    // parents pin, which is the workspace the command then acts on.
    const root = real(resolve(cwd, value));
    // As discovery does (discovery.ts), a directory whose `.ia` is the IA home is never a workspace.
    const home = iaHome !== undefined && sameFile(resolve(root, '.ia'), iaHome);
    return existsSync(resolve(root, '.ia/src')) && !home ? root : undefined;
  }
  return discoverRoot(cwd, iaHome);
}

/**
 * The workspace's installed copy an `ia` may run for the workspace at `root`, or `null` (consumer-cli-contract §1.2):
 * the copy resolveWorkspaceCli finds, up to the workspaces root that hoists it. A copy other than `running` is refused
 * when the user set `IA_NO_HANDOFF=1` or the repository commits it, so neither a typed command (handoffTarget) nor the
 * console (console/load.ts, console/app.ts) ever runs the repository's own code. The running copy is returned as found,
 * since running it runs nothing new; git is asked only about another copy, and a git that cannot answer inside a work
 * tree refuses the copy (committed).
 */
export function runnableCopy(
  root: string,
  input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The running copy's package root. */
    readonly running: string;
    readonly committed?: (packageRoot: string) => boolean;
  },
): LocalCli | null {
  const local = resolveWorkspaceCli(root).local;
  if (local === null || sameFile(local.packageRoot, input.running)) return local;
  if (input.env[NO_HANDOFF] === '1') return null;
  return (input.committed ?? committed)(local.packageRoot) ? null : local;
}

/**
 * The workspace's installed copy when it is not this one, or `null`. Bare `ia`, `--user`, an extension's commands and
 * `doctor --host` always answer here, as does a malformed IA home (`iaHome` undefined), which this copy refuses. As in
 * dispatch (consumer.ts), an extension never takes a core token: such a token is the core command's, and hands off.
 */
export function handoffTarget(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packageRoot: string;
  readonly iaHome: string | undefined;
  readonly extensions: readonly string[];
  readonly coreTokens: ReadonlySet<string>;
  readonly committed?: (packageRoot: string) => boolean;
}): LocalCli | null {
  const { argv, env } = input;
  const command = argv[0];
  if (command === undefined) return null;
  if (!input.coreTokens.has(command) && input.extensions.includes(command)) return null;
  if ((env[HANDOFF_FROM] ?? '') !== '' || input.iaHome === undefined) return null;
  const tokens = options(argv);
  if (tokens.includes('--user')) return null;
  if (command === 'doctor' && tokens.some((token) => token === '--host' || token.startsWith('--host='))) return null;
  const root = rootFromArgv(argv, input.cwd, input.iaHome);
  const local =
    root === undefined
      ? null
      : runnableCopy(root, {
          env,
          running: input.packageRoot,
          ...(input.committed === undefined ? {} : { committed: input.committed }),
        });
  return local === null || sameFile(local.packageRoot, input.packageRoot) ? null : local;
}

/**
 * The signals a terminal sends the whole foreground group. While the child runs, this copy ignores them: the child
 * receives each itself and decides, so the prompt does not return while it is still finishing, and Windows does not
 * end this copy with its own status in place of the child's.
 */
const FORWARDED: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : []),
];
const ignore = (): void => {};

/** Runs the target with inherited stdio and returns its exit code; throws when it cannot be started. */
export function handOff(target: LocalCli, argv: readonly string[], env: NodeJS.ProcessEnv, from: string): number {
  for (const signal of FORWARDED) process.on(signal, ignore);
  try {
    const result = spawnSync(process.execPath, [target.entry, ...argv], {
      stdio: 'inherit',
      env: { ...env, [HANDOFF_FROM]: from },
    });
    if (result.error !== undefined) throw result.error;
    // §3: a child that ended on a signal ends this invocation as an interruption, 130.
    return result.status ?? 130;
  } finally {
    for (const signal of FORWARDED) process.off(signal, ignore);
  }
}
