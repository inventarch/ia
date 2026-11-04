/**
 * Running a batch (consumer CLI contract §1.2): each planned repository in turn, in a new git worktree on a new branch,
 * one at a time, a failure stopping only that repository. Nothing here reads or writes the user's own checkout but the
 * git metadata operations `METADATA_OPS` names, each run as `git -C <original top level> …`: they read refs or add a
 * worktree and a branch, never the working tree. Everything else (the install, every step) runs with its `cwd` in the
 * worktree, on arguments planning rebuilt for it (batch-plan.ts).
 *
 * Per repository: refuse when planning did; `git fetch origin` and the base (`origin/HEAD`, then `origin/main`, then
 * `origin/master`); refuse an existing worktree path or branch; `git worktree add --no-track -b <branch> <path> <base>`
 * (no upstream, ever); the package manager's install when the worktree holds a `package.json`, built for the worktree;
 * then each step. Before the install and before every step the real filesystem is checked (`containedStep`): the
 * step's `cwd` and each path it names must lead, through any link, into the worktree. An `ia` step runs on the copy
 * the worktree has at that step, found again before each one, or on the running copy when there is none; the batch
 * preview was the confirmation, so it runs in its confirmed form.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmedArgv, displayFix } from '../fix.js';
import { NO_HANDOFF } from '../handoff.js';
import type { LocalCli } from '../local-cli.js';
import { detectPackageManager, installArgv } from '../package-manager.js';
import type { Git } from '../channel.js';
import type { Env } from '../program.js';
import { findProgram, programEnv, windowsShell, windowsShellArgs } from '../program.js';
import type { RepoPlan } from './batch-plan.js';
import { pathArguments } from './batch-plan.js';
import type { Step } from './offers.js';
import { cmdArgument, runningEntry } from './run.js';
import type { ConsoleState } from './state.js';

export interface RunResult {
  /** The exit code, or null when the program ended on a signal or could not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
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
/** `env` without git's repository-local variables; Windows compares names without case, as its environment does. */
export function batchEnv(env: Env, platform: NodeJS.Platform = process.platform): Env {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (GIT_LOCAL_ENV.includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) continue;
    out[name] = value;
  }
  return out;
}
/** A synchronous `git -C <cwd> …` under `env` without git's routing variables, for the package manager's lockfile probe. */
const gitWith =
  (env: Env): Git =>
  (cwd, args) => {
    const git = findProgram('git', env);
    if (git === null) return null;
    const result = spawnSync(git, ['--no-optional-locks', '-C', cwd, ...args], {
      env: programEnv(batchEnv(env)) as NodeJS.ProcessEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };

/**
 * The real runner: an absolute file as given; any other name by the absolute path `findProgram` finds on a qualified
 * PATH entry, with `programEnv`, and a Windows `.cmd` through cmd.exe named by its path, each argument quoted for it
 * (`cmdArgument`; one it cannot pass refuses the call).
 */
export function defaultRunner(env: Env): Runner {
  return (file, args, options) =>
    new Promise((settle) => {
      const fail = (why: string): void => settle({ status: null, stdout: '', stderr: why });
      const childEnv = batchEnv(options.env);
      let target: { file: string; args: readonly string[]; env: Env; verbatim: boolean };
      if (isAbsolute(file)) target = { file, args, env: childEnv, verbatim: false };
      else {
        const program = findProgram(file, env, 'program');
        if (program !== null) target = { file: program, args, env: programEnv(childEnv), verbatim: false };
        else {
          const script = findProgram(file, env, 'script');
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
    });
}

/**
 * The git commands that may run against the user's own repository, each as `git -C <its top level> <command> …`. They
 * read refs or add metadata (a remote-tracking update, a worktree and a branch); none reads or writes the working tree.
 */
export const METADATA_OPS: readonly string[] = [
  'rev-parse --show-toplevel',
  'fetch origin',
  'symbolic-ref --quiet refs/remotes/origin/HEAD',
  'rev-parse --verify --quiet',
  'worktree add --no-track -b',
];

/** The top level of the git repository holding `root`, by its real path, or null when it is in none. */
export function gitTop(root: string, env: Env): string | null {
  const git = findProgram('git', env);
  if (git === null) return null;
  const result = spawnSync(git, ['-C', root, 'rev-parse', '--show-toplevel'], {
    env: programEnv(batchEnv(env)) as NodeJS.ProcessEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  if (top === '') return null;
  try {
    return realpathSync.native(resolve(top));
  } catch {
    return null;
  }
}

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? '';

/** The base after `git fetch origin`: `origin/HEAD`'s branch, then `origin/main`, then `origin/master`; or why none. */
async function findBase(top: string, run: Runner, env: Env): Promise<{ base: string } | { why: string }> {
  const git = (args: readonly string[]) => run('git', ['-C', top, ...args], { cwd: top, env });
  const fetched = await git(['fetch', 'origin']);
  if (fetched.status !== 0) return { why: `git fetch origin failed: ${lastLine(fetched.stderr)}` };
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const candidates = [
    ...(head.status === 0 && head.stdout.trim().startsWith('refs/remotes/')
      ? [head.stdout.trim().slice('refs/remotes/'.length)]
      : []),
    'origin/main',
    'origin/master',
  ];
  for (const candidate of candidates) {
    const found = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}^{commit}`]);
    if (found.status === 0) return { base: candidate };
  }
  return { why: 'origin has no HEAD, main or master' };
}
/** `git fetch origin`, then the first of `origin/HEAD`, `origin/main` and `origin/master` that resolves; null otherwise. */
export async function chooseBase(top: string, run: Runner, env: Env = process.env): Promise<string | null> {
  const found = await findBase(top, run, env);
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
 * The run-time check, on the real filesystem, immediately before a step runs: the step's `cwd`, each path-bearing value
 * (resolved against `cwd`) and each mixed-domain value kept as a name that names an existing entry under `cwd` must
 * lead, through any link, into the worktree's real path. Null when they do; otherwise why the repository is refused.
 */
export function containedStep(step: Step, cwd: string, worktree: string): string | null {
  let tree: string;
  try {
    tree = realpathSync.native(worktree);
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
}

/** The `package.json` nearest the workspace, at or above it and inside the worktree, or null. */
function manifestDirectory(workspace: string, worktree: string): string | null {
  for (let current = workspace; ; current = dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    if (resolve(current) === resolve(worktree) || dirname(current) === current) return null;
  }
}

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
  for (const [index, repo] of plan.repos.entries()) {
    if (io.signal.aborted) break;
    results.push(await runRepo(repo, state, scoped, (line) => io.progress(index, line)));
  }
  return results;
}

async function runRepo(
  repo: RepoPlan,
  state: Pick<ConsoleState, 'running'>,
  io: Parameters<typeof runBatch>[2],
  say: (line: string) => void,
): Promise<RepoResult> {
  const { top, worktree, workspace, branch } = repo;
  let created = false;
  const done = (ok: boolean, last: string, refused: string | null = null): RepoResult => {
    say(refused === null ? last : `refused: ${refused}`);
    return { root: repo.root, top, worktree, workspace, branch, ok, last: refused ?? last, refused, created };
  };
  const refuse = (why: string): RepoResult => done(false, why, why);
  if (repo.refused !== null) return refuse(repo.refused);
  const git = (args: readonly string[]) => io.run('git', ['-C', top, ...args], { cwd: top, env: io.env });

  say('fetching origin');
  const base = await findBase(top, io.run, io.env);
  if ('why' in base) return refuse(base.why);
  if (existsSync(worktree)) return refuse(`the worktree path already exists: ${worktree}`);
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).status === 0)
    return refuse(`the branch already exists: ${branch}`);
  say(`creating ${worktree} on ${branch} from ${base.base}`);
  const added = await git(['worktree', 'add', '--no-track', '-b', branch, worktree, base.base]);
  if (added.status !== 0) return done(false, `git worktree add failed: ${lastLine(added.stderr)}`);
  created = true;

  const run = async (step: Step, label: string): Promise<string | null> => {
    const outside = containedStep(step, workspace, worktree);
    if (outside !== null) return `refused:${label}: ${outside}`;
    let file: string, args: readonly string[], env: Env;
    if (step.program === 'ia') {
      // The copy is found again before every step, in the worktree only: an earlier step may have installed it.
      const found = io.resolveRepo(workspace);
      let tree = worktree;
      try {
        tree = realpathSync.native(worktree);
      } catch {
        // containedStep has just read it.
      }
      const copy = found !== null && within(tree, found.packageRoot) ? found : null;
      if (copy === null && step.requires === 'repo-copy') return `refused:${label}: the repo copy is not installed`;
      file = process.execPath;
      args = [copy?.entry ?? runningEntry(state.running.packageRoot), ...confirmedArgv(step)];
      env = { ...io.env, [NO_HANDOFF]: '1' };
    } else {
      const [name, ...rest] = step.argv;
      if (name === undefined) return `refused:${label}: the step names no program`;
      file = name;
      args = rest;
      env = io.env;
    }
    const shown = step.program === 'ia' ? displayFix({ ...step, argv: confirmedArgv(step) }) : displayFix(step);
    say(`$ ${shown}`);
    const result = await io.run(file, args, { cwd: workspace, env });
    if (result.status === 0) return null;
    const how = result.status === null ? 'did not finish' : `exited ${result.status}`;
    const output = lastLine(result.stderr) || lastLine(result.stdout);
    return `${shown} ${how}${output === '' ? '' : `: ${output}`}`;
  };
  const failed = (why: string): RepoResult =>
    why.startsWith('refused:') ? refuse(why.slice('refused:'.length).replace(/^install: /, '')) : done(false, why);

  const manifest = manifestDirectory(workspace, worktree);
  if (manifest !== null) {
    const { manager, conflict } = detectPackageManager(manifest, gitWith(io.env));
    if (conflict.length > 0) return refuse(`package managers disagree: ${conflict.join(', ')}`);
    if (manager === null) return refuse(`no package manager is declared or locked in ${manifest}`);
    const install: Step = {
      program: 'external',
      argv: [...installArgv(manager, manifest, workspace)],
      flow: 'confirm',
      writesTo: 'repo',
    };
    const why = await run(install, 'install');
    if (why !== null) return failed(why);
  } else {
    const outside = containedStep(
      { program: 'external', argv: ['none'], flow: 'confirm', writesTo: 'none' },
      workspace,
      worktree,
    );
    if (outside !== null) return refuse(outside);
  }
  for (const [index, step] of repo.steps.entries()) {
    if (io.signal.aborted) return refuse('the batch was stopped');
    const why = await run(step, `step ${index + 1}`);
    if (why !== null) return failed(why);
  }
  const count = repo.steps.length;
  return done(true, count === 1 ? '1 step passed' : `${count} steps passed`);
}
