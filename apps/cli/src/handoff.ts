/**
 * consumer-cli-contract §1.2's first step: a command typed into another `ia` runs on the `@inventarch/cli` the
 * workspace pins and has installed. Deciding reads only directories and `package.json` files; nothing is parsed yet, so
 * an argument the workspace's copy accepts and this copy does not still reaches it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sameFile } from '@inventarch/db';
import { discoverRoot } from './consumer.js';
import { findLocalCli, readCliDependency } from './local-cli.js';
import type { LocalCli } from './local-cli.js';

/** Set only by the copy that hands off, to its package root's real path; any non-empty value stops a second hand-off. */
export const HANDOFF_FROM = 'IA_HANDOFF_FROM';
/** `1` turns hand-off off: this copy answers. */
export const NO_HANDOFF = 'IA_NO_HANDOFF';

/** The tokens before `--`, where an option is still an option. */
const options = (argv: readonly string[]): readonly string[] => {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
};

const ROOT = '--root=';
/** The first `--root` before `--`, when it names a workspace; without one, the workspace discovered from `cwd`. */
export function rootFromArgv(argv: readonly string[], cwd: string, iaHome: string | undefined): string | undefined {
  const tokens = options(argv);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const value = token === '--root' ? tokens[index + 1] : token.startsWith(ROOT) ? token.slice(ROOT.length) : null;
    if (value === null) continue;
    if (value === undefined || value === '') return undefined;
    const root = resolve(cwd, value);
    // As discovery does (consumer.ts), a directory whose `.ia` is the IA home is never a workspace.
    const home = iaHome !== undefined && sameFile(resolve(root, '.ia'), iaHome);
    return existsSync(resolve(root, '.ia/src')) && !home ? root : undefined;
  }
  return discoverRoot(cwd, iaHome);
}

/**
 * The workspace's installed copy when it is not this one, or `null`. Bare `ia`, `--user`, an extension's commands and
 * `doctor --host` always answer here, as does a malformed IA home (`iaHome` undefined), which this copy refuses.
 */
export function handoffTarget(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packageRoot: string;
  readonly iaHome: string | undefined;
  readonly extensions: readonly string[];
}): LocalCli | null {
  const { argv, env } = input;
  const command = argv[0];
  if (command === undefined || input.extensions.includes(command)) return null;
  if ((env[HANDOFF_FROM] ?? '') !== '' || env[NO_HANDOFF] === '1' || input.iaHome === undefined) return null;
  const tokens = options(argv);
  if (tokens.includes('--user')) return null;
  if (command === 'doctor' && tokens.some((token) => token === '--host' || token.startsWith('--host='))) return null;
  const root = rootFromArgv(argv, input.cwd, input.iaHome);
  const dependency = root === undefined ? null : readCliDependency(root);
  if (root === undefined || dependency === null) return null;
  const local = findLocalCli(root, dirname(dependency.manifest));
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
