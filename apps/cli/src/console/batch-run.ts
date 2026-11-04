/**
 * Running a batch (consumer CLI contract §1.2): each planned repository in turn, in a new git worktree on a new branch,
 * one at a time, a failure stopping only that repository. Nothing here reads or writes the user's own checkout but the
 * git metadata operations `METADATA_OPS` names, each run as `git -C <original top level> …`: they read refs or add a
 * worktree and a branch, never the working tree. Everything else (the install, every step) runs with its `cwd` in the
 * worktree, on arguments planning rebuilt for it (batch-plan.ts).
 *
 * Per repository: refuse when planning did; `git fetch origin` and the base (`origin/HEAD`, then `origin/main`, then
 * `origin/master`); refuse a workspace whose `.ia/src` the base does not hold; refuse an existing worktree path or branch; `git worktree add --no-track -b <branch> <path> <base>`
 * (no upstream, ever); the package manager's install when the worktree holds a `package.json`, built for the worktree,
 * with no lifecycle script and frozen to a tracked lockfile (`batchInstallArgv`);
 * then each step. Before the install and before every step the real filesystem is checked (`containedStep`): the
 * step's `cwd` and each path it names must lead, through any link, into the worktree. An `ia` step runs on the copy
 * the worktree has at that step, found again before each one, or on the running copy when there is none; the batch
 * preview was the confirmation, so it runs in its confirmed form.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmedArgv, displayFix } from '../fix.js';
import { NO_HANDOFF } from '../handoff.js';
import type { LocalCli } from '../local-cli.js';
import { batchInstallArgv, detectPackageManager, lockTracked } from '../package-manager.js';
import type { Git } from '../channel.js';
import type { Env } from '../program.js';
import { findProgram, programEnv, windowsShell, windowsShellArgs } from '../program.js';
import type { RepoPlan } from './batch-plan.js';
import { installsFirst, pathArguments } from './batch-plan.js';
import type { Step } from './offers.js';
import { cmdArgument, runningEntry } from './run.js';
import type { ConsoleState } from './state.js';

export interface RunResult {
  /** The exit code, or null when the program ended on a signal or could not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the guarded spawn did not start the program at all (`spawnGuarded`), or absent when it ran. */
  readonly refused?: string;
}
/** Starts a program with piped output and settles with its result; never throws. */
export interface Runner {
  (file: string, args: readonly string[], options: { readonly cwd: string; readonly env: Env }): Promise<RunResult>;
}

/**
 * Git's repository-local variables (`git rev-parse --local-env-vars`): set in the console's own environment, by a git
 * hook or a shell that started it, they would route a batch's git, even `git -C <worktree>`, to another repository,
 * index or configuration. No batch child inherits them, nor `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`.
 */
export const GIT_LOCAL_ENV: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];
/**
 * What every batch child gets set, whatever the console inherited: git never asks on the terminal for a credential
 * (stdin is ignored, but git opens the terminal itself) and Git Credential Manager never opens a dialog, either of which
 * would hold the sequential batch with no one answering. A remote that needs a credential then fails for its repository.
 */
export const NO_PROMPT: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
/**
 * `env` without git's repository-local variables and with `NO_PROMPT` set; Windows compares names without case, as its
 * environment does.
 */
export function batchEnv(env: Env, platform: NodeJS.Platform = process.platform): Env {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (GIT_LOCAL_ENV.includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) || key in NO_PROMPT) continue;
    out[name] = value;
  }
  return { ...out, ...NO_PROMPT };
}
/**
 * How long one batch command may run before it is stopped and counted as failed: long enough for a cold install, short
 * enough that a command waiting on something no one will give (a credential, a lock) never holds the batch for good.
 */
export const BATCH_COMMAND_TIMEOUT_MS = 10 * 60_000;
/**
 * Ends `child` and, on Windows, every process it started (a `.cmd` runs its program as cmd.exe's child). On POSIX only
 * the child itself is killed, so a grandchild (an install's own scripts) can outlive it and keep writing into the
 * worktree while later steps run there, or as the worktree is removed: killing the whole group would
 * need the child spawned `detached`, in a process group of its own, and the terminal's Ctrl-C would then no longer
 * reach the command in flight, which is how a stopped batch ends it (app.ts).
 */
function stopTree(child: ReturnType<typeof spawn>, env: Env): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const root = Object.entries(env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1] ?? 'C:\\Windows';
    const taskkill = join(root, 'System32', 'taskkill.exe');
    if (existsSync(taskkill))
      spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  child.kill('SIGKILL');
}
/** A synchronous `git -C <cwd> …` by the checked `git`, through the guarded spawn, for the lockfile probe. */
const gitWith =
  (env: Env, git: string, guard: SpawnGuard): Git =>
  (cwd, args) => {
    const result = spawnGuardedSync(git, ['--no-optional-locks', '-C', cwd, ...args], { cwd, env }, guard);
    return result.status === 0 ? result.stdout.trim() : null;
  };

/**
 * The real runner: an absolute file as given; any other name by the absolute path `findProgram` finds on a qualified
 * PATH entry, with `programEnv`, and a Windows `.cmd` through cmd.exe named by its path, each argument quoted for it
 * (`cmdArgument`; one it cannot pass refuses the call).
 */
export function defaultRunner(env: Env, limits: { readonly timeoutMs?: number } = {}): Runner {
  const timeoutMs = limits.timeoutMs ?? BATCH_COMMAND_TIMEOUT_MS;
  return (file, args, options) =>
    new Promise((resolved) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolved(result);
      };
      const fail = (why: string): void => settle({ status: null, stdout: '', stderr: why });
      const childEnv = batchEnv(options.env);
      let target: { file: string; args: readonly string[]; env: Env; verbatim: boolean };
      const script = (path: string) => process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(path);
      if (isAbsolute(file) && !script(file)) target = { file, args, env: programEnv(childEnv), verbatim: false };
      else {
        const program = isAbsolute(file) ? null : findProgram(file, env, 'program');
        if (program !== null) target = { file: program, args, env: programEnv(childEnv), verbatim: false };
        else {
          const script = isAbsolute(file) ? file : findProgram(file, env, 'script');
          if (script === null) return fail(`${file} was not found on a qualified PATH entry`);
          const quoted = args.map(cmdArgument);
          if (quoted.some((value) => value === null))
            return fail(`cmd.exe cannot pass an argument of ${file} unchanged`);
          target = {
            file: windowsShell(env),
            args: windowsShellArgs(script, quoted as string[]),
            env: programEnv(childEnv),
            verbatim: true,
          };
        }
      }
      let stdout = '',
        stderr = '';
      const child = spawn(target.file, [...target.args], {
        cwd: options.cwd,
        env: target.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: target.verbatim,
      });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => settle({ status: null, stdout, stderr: `${stderr}${error.message}` }));
      child.once('close', (code) => settle({ status: code, stdout, stderr }));
      // A command with no end is stopped and settles at once as a failure: a grandchild still holding the pipes would
      // otherwise keep `close` from ever coming.
      timer = setTimeout(() => {
        stopTree(child, target.env);
        child.stdout.destroy();
        child.stderr.destroy();
        const end = stderr === '' || stderr.endsWith('\n') ? '' : '\n';
        settle({
          status: null,
          stdout,
          stderr: `${stderr}${end}timed out after ${Math.round(timeoutMs / 1000)} s and was stopped`,
        });
      }, timeoutMs);
    });
}

/**
 * The git commands that may run against the user's own repository, each as `git -C <its top level> <command> …`. They
 * read refs or change metadata (a remote-tracking update, a worktree and a branch added, and afterwards, when chosen,
 * the batch's own worktree removed, batch-next.ts); none reads or writes the user's working tree.
 */
export const METADATA_OPS: readonly string[] = [
  'rev-parse --show-toplevel',
  'fetch origin',
  'symbolic-ref --quiet refs/remotes/origin/HEAD',
  'rev-parse --verify --quiet',
  'worktree add --no-track -b',
  'worktree remove',
];

/**
 * The top level of the git repository holding `root`, by its real path; null when it is in none; a refusal when the
 * `git` on PATH lies inside the repository (judged against `root` and the nearest folder above it that holds a `.git`,
 * before it runs, and against the top level it reports).
 */
export function gitTop(root: string, env: Env): string | null | { readonly refused: string } {
  let holder = resolve(root);
  while (!existsSync(join(holder, '.git')) && dirname(holder) !== holder) holder = dirname(holder);
  const checked = programIn('git', env, [root, holder]);
  if ('refused' in checked) return checked.path === null ? null : { refused: checked.refused };
  const result = spawnGuardedSync(
    checked.path,
    ['-C', root, 'rev-parse', '--show-toplevel'],
    { cwd: root, env },
    { checkouts: [root, holder] },
  );
  if (result.refused !== undefined) return { refused: result.refused };
  const top = result.status === 0 ? result.stdout.trim() : '';
  if (top === '') return null;
  let real: string;
  try {
    real = realpathSync.native(resolve(top));
  } catch {
    return null;
  }
  const again = programIn('git', env, [real]);
  return 'refused' in again ? { refused: again.refused } : real;
}

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? '';

/** The base after `git fetch origin`: `origin/HEAD`'s branch, then `origin/main`, then `origin/master`; or why none. */
async function findBase(
  top: string,
  run: Runner,
  env: Env,
  gitPath: string,
  guard: SpawnGuard = { checkouts: [top] },
): Promise<{ base: string } | { why: string }> {
  const git = (args: readonly string[]) => spawnGuarded(run, gitPath, ['-C', top, ...args], { cwd: top, env }, guard);
  const fetched = await git(['fetch', 'origin']);
  if (fetched.refused !== undefined) return { why: fetched.refused };
  if (fetched.status !== 0) return { why: `git fetch origin failed: ${lastLine(fetched.stderr)}` };
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head.refused !== undefined) return { why: head.refused };
  const candidates = [
    ...(head.status === 0 && head.stdout.trim().startsWith('refs/remotes/')
      ? [head.stdout.trim().slice('refs/remotes/'.length)]
      : []),
    'origin/main',
    'origin/master',
  ];
  for (const candidate of candidates) {
    const found = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}^{commit}`]);
    if (found.refused !== undefined) return { why: found.refused };
    if (found.status === 0) return { base: candidate };
  }
  return { why: 'origin has no HEAD, main or master' };
}
/** `git fetch origin`, then the first of `origin/HEAD`, `origin/main` and `origin/master` that resolves; null otherwise. */
export async function chooseBase(top: string, run: Runner, env: Env = process.env): Promise<string | null> {
  const git = programIn('git', batchEnv(env), [top]);
  if ('refused' in git) return null;
  const found = await findBase(top, run, batchEnv(env), git.path);
  return 'base' in found ? found.base : null;
}

const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
/** `child` is `parent` or inside it; both are real paths. */
function within(parent: string, child: string): boolean {
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** Where `path` really leads: the real path of its nearest existing ancestor, joined with the rest; null for a dead link. */
function leadsTo(path: string): string | null {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    let entry: ReturnType<typeof lstatSync> | undefined;
    try {
      entry = lstatSync(existing, { throwIfNoEntry: false });
    } catch {
      entry = undefined;
    }
    if (entry !== undefined)
      try {
        return join(realpathSync.native(existing), ...rest.reverse());
      } catch {
        // An entry that exists but whose real path cannot be read is a link that leads nowhere.
        return null;
      }
    const up = dirname(existing);
    if (up === existing) return join(existing, ...rest.reverse());
    rest.push(basename(existing));
    existing = up;
  }
}

/**
 * The one rule for every program a batch starts (git, gh, the package manager, a step's program): found as `findProgram`
 * finds it (or as given when absolute), its real path must not lie inside any of `checkouts`, so a program the user's
 * repository holds is never run. `path` is what to spawn; null with a refusal when nothing was found.
 */
export function programIn(
  name: string,
  env: Env,
  checkouts: readonly string[],
): { readonly path: string } | { readonly path: string | null; readonly refused: string } {
  const found = isAbsolute(name) ? name : (findProgram(name, env, 'program') ?? findProgram(name, env, 'script'));
  if (found === null) return { path: null, refused: `${name} was not found on a qualified PATH entry` };
  // The canonical real path, never a link's spelling: it is what runs, and what every spawn checks again.
  const real = leadsTo(found);
  if (real === null) return { path: null, refused: `${name} at ${found} is a link that leads nowhere` };
  for (const checkout of checkouts)
    if (within(leadsTo(checkout) ?? checkout, real))
      return { path: real, refused: `${name} resolves to ${real}, inside the repository` };
  return { path: real };
}

/**
 * What every spawn of a batch must still hold, checked by the one guarded spawn immediately before it starts: the
 * program's real path is still the canonical path it was found at and lies outside every checkout, and, when the
 * command's working directory or any argument lies in the worktree, that worktree is still the folder pinned at its
 * creation.
 */
export interface SpawnGuard {
  readonly checkouts: readonly string[];
  readonly worktree?: { readonly path: string; readonly pinned: Pinned | null | undefined };
}
const nameOf = (program: string): string => basename(program).replace(/\.(?:exe|cmd|bat|com)$/i, '');
/** Why `program` may not start now with these arguments, or null. The running node is not judged. */
function admit(program: string, args: readonly string[], cwd: string, guard: SpawnGuard): string | null {
  if (program !== process.execPath) {
    let real: string;
    try {
      real = realpathSync.native(program);
    } catch {
      return `${nameOf(program)} at ${program} cannot be read`;
    }
    if (fold(real) !== fold(program)) return `${nameOf(program)} now leads to ${real}, not to ${program}`;
    // cmd.exe expands %NAME% even inside quotes, so a script at such a path would run from another path than the one
    // checked. Refused on every platform, so the rule reads the same wherever a script path is judged.
    if (/\.(?:cmd|bat)$/i.test(real) && real.includes('%'))
      return `${nameOf(program)} at ${real} holds %, which cmd.exe would expand into another path`;
    for (const checkout of guard.checkouts)
      if (within(leadsTo(checkout) ?? checkout, real))
        return `${nameOf(program)} resolves to ${real}, inside the repository`;
  }
  const tree = guard.worktree;
  if (tree !== undefined) {
    const values = [
      cwd,
      ...args.flatMap((arg) => (arg.includes('=') ? [arg, arg.slice(arg.indexOf('=') + 1)] : [arg])),
    ];
    const inTree = values.some((value) => isAbsolute(value) && within(resolve(tree.path), resolve(value)));
    if (inTree) return checkPinned(tree.path, tree.pinned);
  }
  return null;
}
/**
 * The one way a batch starts a child: `admit` checks it immediately before, and the child gets `env` without git's
 * routing variables and with only qualified PATH entries (`programEnv`). A refused spawn starts nothing and settles
 * with `refused` set.
 */
export async function spawnGuarded(
  run: Runner,
  program: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Env },
  guard: SpawnGuard,
): Promise<RunResult> {
  const why = admit(program, args, options.cwd, guard);
  if (why !== null) return { status: null, stdout: '', stderr: why, refused: why };
  return run(program, args, { cwd: options.cwd, env: programEnv(batchEnv(options.env)) });
}
/**
 * `spawnGuarded` for the synchronous probes: the same check and environment; a Windows `.cmd` or `.bat` runs through
 * cmd.exe named by its path, each argument quoted by `cmdArgument`, and one it cannot pass refuses the probe.
 */
export function spawnGuardedSync(
  program: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Env },
  guard: SpawnGuard,
): RunResult {
  const why = admit(program, args, options.cwd, guard);
  if (why !== null) return { status: null, stdout: '', stderr: why, refused: why };
  const env = programEnv(batchEnv(options.env)) as NodeJS.ProcessEnv;
  const common = {
    cwd: options.cwd,
    env,
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: BATCH_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL' as const,
  };
  let result: ReturnType<typeof spawnSync>;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)) {
    const quoted = args.map(cmdArgument);
    if (quoted.some((value) => value === null)) {
      const refused = `cmd.exe cannot pass an argument of ${nameOf(program)} unchanged`;
      return { status: null, stdout: '', stderr: refused, refused };
    }
    result = spawnSync(windowsShell(options.env), windowsShellArgs(program, quoted as string[]), {
      ...common,
      windowsVerbatimArguments: true,
    });
  } else result = spawnSync(program, [...args], common);
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/** What a created worktree is: its real path, and its device and inode where the volume reports them. */
export interface Pinned {
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
const ALL_ONES = 2n ** 64n - 1n;
/** The worktree's identity now, or null when it cannot be read. */
export function pinWorktree(path: string): Pinned | null {
  try {
    const real = realpathSync.native(path);
    const stat = statSync(real, { bigint: true });
    return { real, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}
/**
 * Null when the worktree is still the folder that was created: the same real path and, where the volume reports an
 * identity (an inode that is neither 0 nor all ones), the same device and inode. A new real path is never adopted.
 */
export function checkPinned(path: string, pinned: Pinned | undefined | null): string | null {
  const now = pinWorktree(path);
  const unidentified = (id: bigint): boolean => id === 0n || id === ALL_ONES;
  const same =
    pinned !== undefined &&
    pinned !== null &&
    now !== null &&
    fold(now.real) === fold(pinned.real) &&
    (unidentified(pinned.ino) || unidentified(now.ino) || (now.dev === pinned.dev && now.ino === pinned.ino));
  return same ? null : `the worktree ${path} was replaced or moved since the batch created it`;
}

/**
 * The run-time check, on the real filesystem, immediately before a step runs: the step's `cwd`, each path-bearing value
 * (resolved against `cwd`) and each mixed-domain value kept as a name that names an existing entry under `cwd` must
 * lead, through any link, into the worktree's real path. Null when they do; otherwise why the repository is refused.
 */
export function containedStep(step: Step, cwd: string, worktree: string, pinned?: string): string | null {
  let tree: string;
  try {
    tree = pinned ?? realpathSync.native(worktree);
  } catch {
    return `the worktree ${worktree} cannot be read`;
  }
  const check = (value: string, path: string): string | null => {
    const real = leadsTo(path);
    if (real === null) return `${value} is a link that leads nowhere`;
    return within(tree, real) ? null : `${value} leads outside the worktree, to ${real}`;
  };
  const here = check(cwd, cwd);
  if (here !== null) return here;
  for (const entry of pathArguments(step)) {
    let path: string;
    try {
      path = resolve(cwd, entry.kind === 'file-url' ? fileURLToPath(entry.value) : entry.value);
    } catch {
      return `${entry.value} is not a file URL this platform reads`;
    }
    if (entry.kind === 'name') {
      let present = false;
      try {
        present = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
      } catch {
        present = false;
      }
      if (!present) continue;
    }
    const why = check(entry.value, path);
    if (why !== null) return why;
  }
  return null;
}

export interface RepoResult {
  readonly root: string;
  readonly top: string;
  readonly worktree: string;
  readonly workspace: string;
  readonly branch: string;
  /** Every step passed. */
  readonly ok: boolean;
  /** The last thing that happened: the step that failed and its last line of output, or what passed. */
  readonly last: string;
  /** Why the repository was refused, or null; a refused repository is not ok. */
  readonly refused: string | null;
  /** The worktree and branch were made, so they can be opened, committed or removed. */
  readonly created: boolean;
  /** What the created worktree was, checked before every later command in it. */
  readonly pinned?: Pinned | null;
  /** Ctrl-C stopped the batch before this repository finished, or before it started (`not run: batch stopped`). */
  readonly stopped?: boolean;
  /** The remote-tracking branch the worktree was made from (`origin/main`), which its PR is opened against. */
  readonly base?: string;
}

const repoResult = (repo: RepoPlan) => ({
  root: repo.root,
  top: repo.top,
  worktree: repo.worktree,
  workspace: repo.workspace,
  branch: repo.branch,
});
/** The `package.json` nearest the workspace, at or above it and inside the worktree, or null. */
function manifestDirectory(workspace: string, worktree: string): string | null {
  for (let current = workspace; ; current = dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    if (resolve(current) === resolve(worktree) || dirname(current) === current) return null;
  }
}

/** The last line of a repository a stopped batch never started. */
export const NOT_RUN = 'not run: batch stopped';
/** The last line of a repository the batch was stopped in. */
export const STOPPED = 'stopped: the batch was stopped';

export async function runBatch(
  plan: { readonly repos: readonly RepoPlan[] },
  state: Pick<ConsoleState, 'running'>,
  io: {
    readonly run: Runner;
    readonly resolveRepo: (root: string) => LocalCli | null;
    readonly progress: (index: number, line: string) => void;
    readonly signal: AbortSignal;
    readonly env: Env;
  },
): Promise<readonly RepoResult[]> {
  const results: RepoResult[] = [];
  // Every child of the batch, on the original or in a worktree, runs without git's routing variables.
  const scoped = { ...io, env: batchEnv(io.env) };
  // git is found once and judged against every repository of the batch, then always run by that absolute path.
  const git = programIn(
    'git',
    scoped.env,
    plan.repos.map((repo) => repo.top),
  );
  // Where each worktree really leads, fixed now, before anything is awaited.
  const destinations = plan.repos.map((repo) => leadsTo(repo.worktree));
  for (const [index, repo] of plan.repos.entries()) {
    const say = (line: string) => io.progress(index, line);
    // A stopped batch still lists every repository it did not run, so none drops out of the results.
    if (io.signal.aborted) {
      say(NOT_RUN);
      results.push({ ...repoResult(repo), ok: false, last: NOT_RUN, refused: null, created: false, stopped: true });
      continue;
    }
    if ('refused' in git) {
      say(`refused: ${git.refused}`);
      results.push({ ...repoResult(repo), ok: false, last: git.refused, refused: git.refused, created: false });
      continue;
    }
    results.push(await runRepo(repo, state, scoped, say, git.path, destinations[index] ?? null));
  }
  return results;
}

async function runRepo(
  repo: RepoPlan,
  state: Pick<ConsoleState, 'running'>,
  io: Parameters<typeof runBatch>[2],
  say: (line: string) => void,
  gitPath: string,
  destination: string | null,
): Promise<RepoResult> {
  const { top, worktree, workspace, branch } = repo;
  let created = false;
  let pinned: Pinned | null = null;
  let from: string | undefined;
  const done = (ok: boolean, last: string, refused: string | null = null): RepoResult => {
    say(refused === null ? last : `refused: ${refused}`);
    return {
      ...repoResult(repo),
      ok,
      last: refused ?? last,
      refused,
      created,
      pinned,
      ...(from === undefined ? {} : { base: from }),
    };
  };
  const refuse = (why: string): RepoResult => done(false, why, why);
  const stop = (): RepoResult => ({ ...done(false, STOPPED), stopped: true });
  if (repo.refused !== null) return refuse(repo.refused);
  let guard: SpawnGuard = { checkouts: [top] };
  const git = (args: readonly string[]) =>
    spawnGuarded(io.run, gitPath, ['-C', top, ...args], { cwd: top, env: io.env }, guard);
  // Planning judged the path by its spelling; a link on the way (a configured root, or `.ia-worktrees` itself) could
  // still lead it into the checkout or the IA home, where git would then write. Judged by where it really leads.
  const checkout = leadsTo(top) ?? top;
  const home = repo.iaHome === undefined ? null : leadsTo(repo.iaHome);
  const judge = (real: string | null): string | null => {
    if (real === null) return `the worktree path ${worktree} passes through a link that leads nowhere`;
    if (within(checkout, real)) return `the worktree path ${worktree} leads inside the repository, to ${real}`;
    if (home !== null && within(home, real))
      return `the worktree path ${worktree} leads inside the IA home, to ${real}`;
    return null;
  };
  const first = judge(destination);
  if (first !== null) return refuse(first);

  say('fetching origin');
  const base = await findBase(top, io.run, io.env, gitPath, guard);
  if ('why' in base) return refuse(base.why);
  // The offers were read from the local checkout, but the worktree starts from the base: a workspace the base does not
  // hold (added on a local branch, or not pushed) would leave the steps nothing to act on, so it is refused here.
  const inRepo = relative(top, repo.root).split(sep).join('/');
  const held = await git([
    'rev-parse',
    '--verify',
    '--quiet',
    `${base.base}:${inRepo === '' ? '' : `${inRepo}/`}.ia/src`,
  ]);
  if (held.refused !== undefined) return refuse(held.refused);
  if (held.status !== 0)
    return refuse(
      `the workspace ${inRepo === '' ? '.' : inRepo} has no .ia/src in ${base.base}, which the worktree would start from`,
    );
  if (existsSync(worktree)) return refuse(`the worktree path already exists: ${worktree}`);
  const branchProbe = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (branchProbe.refused !== undefined) return refuse(branchProbe.refused);
  if (branchProbe.status === 0) return refuse(`the branch already exists: ${branch}`);
  // The awaits above leave time for a link on the way to be retargeted: judged again, it must lead where it did.
  const now = leadsTo(worktree);
  if (now === null || fold(now) !== fold(destination!))
    return refuse(`the worktree path ${worktree} changed while the batch ran: it now leads to ${now ?? 'nowhere'}`);
  const again = judge(now);
  if (again !== null) return refuse(again);
  if (io.signal.aborted) return stop();
  say(`creating ${worktree} on ${branch} from ${base.base}`);
  const added = await git(['worktree', 'add', '--no-track', '-b', branch, worktree, base.base]);
  if (added.refused !== undefined) return refuse(added.refused);
  if (added.status !== 0) return done(false, `git worktree add failed: ${lastLine(added.stderr)}`);
  created = true;
  from = base.base;
  // What was created is pinned: its real path must be the destination, and it is checked before every later command.
  pinned = pinWorktree(worktree);
  if (pinned === null || fold(pinned.real) !== fold(now))
    return refuse(`the worktree ${worktree} was replaced or moved since the batch created it`);
  const tree = pinned.real;
  guard = { checkouts: [top], worktree: { path: worktree, pinned } };

  const run = async (step: Step, label: string): Promise<string | null> => {
    const replaced = checkPinned(worktree, pinned);
    if (replaced !== null) return `refused:${label}: ${replaced}`;
    const outside = containedStep(step, workspace, worktree, tree);
    if (outside !== null) return `refused:${label}: ${outside}`;
    let file: string, args: readonly string[], env: Env;
    if (step.program === 'ia') {
      // The copy is found again before every step, in the worktree only: an earlier step may have installed it.
      const found = io.resolveRepo(workspace);
      const copy = found !== null && within(tree, found.packageRoot) ? found : null;
      if (copy === null && step.requires === 'repo-copy') return `refused:${label}: the repo copy is not installed`;
      // The file Node will run, by its real path, now: a package folder inside the worktree can still name an entry,
      // or hold a link, that leads elsewhere. Only the running copy's own entry may lie outside the worktree.
      if (copy !== null) {
        const real = leadsTo(copy.entry);
        if (real === null || !within(tree, real))
          return `refused:${label}: the repo copy's entry ${copy.entry} leads outside the worktree, to ${real ?? 'nowhere'}`;
      }
      file = process.execPath;
      args = [copy?.entry ?? runningEntry(state.running.packageRoot), ...confirmedArgv(step)];
      env = { ...io.env, [NO_HANDOFF]: '1' };
    } else {
      const [name, ...rest] = step.argv;
      if (name === undefined) return `refused:${label}: the step names no program`;
      // The program the runner will start, judged by its real path and then run by it: never one the checkout holds.
      const program = programIn(name, io.env, [top]);
      if ('refused' in program) return `refused:${label}: ${program.refused}`;
      file = program.path;
      args = rest;
      env = io.env;
    }
    const shown = step.program === 'ia' ? displayFix({ ...step, argv: confirmedArgv(step) }) : displayFix(step);
    say(`$ ${shown}`);
    const result = await spawnGuarded(io.run, file, args, { cwd: workspace, env }, guard);
    if (result.refused !== undefined) return `refused:${label}: ${result.refused}`;
    if (result.status === 0) return null;
    const how = result.status === null ? 'did not finish' : `exited ${result.status}`;
    const output = lastLine(result.stderr) || lastLine(result.stdout);
    return `${shown} ${how}${output === '' ? '' : `: ${output}`}`;
  };
  const failed = (why: string): RepoResult =>
    why.startsWith('refused:') ? refuse(why.slice('refused:'.length).replace(/^install: /, '')) : done(false, why);

  if (io.signal.aborted) return stop();
  const manifest = manifestDirectory(workspace, worktree);
  if (manifest !== null) {
    const probe = checkPinned(worktree, pinned);
    if (probe !== null) return refuse(probe);
    const listing = gitWith(io.env, gitPath, guard);
    const { manager, conflict } = detectPackageManager(manifest, listing);
    if (conflict.length > 0) return refuse(`package managers disagree: ${conflict.join(', ')}`);
    if (manager === null) return refuse(`no package manager is declared or locked in ${manifest}`);
    // An offer that begins with an install or a pin installs by that step (checked and run like every step, below), as
    // the preview says, only with the manager the base declares or locks; any other offer gets the batch's install.
    const first = installsFirst(repo.steps);
    if (first !== null && first !== manager)
      return refuse(
        `the first step installs with ${first}, but the base is locked by ${manager}; run this offer from that workspace's own view instead`,
      );
    if (first === null) {
      // No lifecycle script runs, and a tracked lockfile is never rewritten: the install is frozen to it.
      const install: Step = {
        program: 'external',
        argv: [...batchInstallArgv(manager, manifest, workspace, lockTracked(manifest, manager, listing))],
        flow: 'confirm',
        writesTo: 'repo',
      };
      const why = await run(install, 'install');
      if (why !== null) return failed(why);
    }
  } else {
    const outside =
      checkPinned(worktree, pinned) ??
      containedStep(
        { program: 'external', argv: ['none'], flow: 'confirm', writesTo: 'none' },
        workspace,
        worktree,
        tree,
      );
    if (outside !== null) return refuse(outside);
  }
  for (const [index, step] of repo.steps.entries()) {
    if (io.signal.aborted) return stop();
    const why = await run(step, `step ${index + 1}`);
    if (why !== null) return failed(why);
  }
  const count = repo.steps.length;
  return done(true, count === 1 ? '1 step passed' : `${count} steps passed`);
}
