/**
 * Real git repositories, each with a bare `origin`, and fake package managers for the console's batch tests
 * (console/batch-run.ts, console/batch-next.ts). The managers are shims on a PATH of their own that run fake-pm.mjs:
 * a `.cmd` on Windows, an executable shell script elsewhere. The running copy is a directory whose `dist/main.js` logs
 * like the copies fake-pm.mjs installs, with the version `running`. Git runs with an empty global configuration and a
 * fixed identity, so the user's own settings never reach a fixture.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { RepoRow } from '../src/console/workspaces-state.js';
import type { Offer, Step } from '../src/console/offers.js';
import { batchable } from '../src/console/offers.js';
import type { Runner } from '../src/console/batch-run.js';
import type { Env } from '../src/program.js';
import { findProgram } from '../src/program.js';
import { scratch } from './scratch-fixture.js';

export const FAKE_PM = resolve(import.meta.dirname, 'fake-pm.mjs');
export const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

/** A scratch directory by its real path, so 8.3 and linked spellings never differ from what git reports. */
export const base = (prefix: string): string => realpathSync.native(scratch(prefix));

export interface Fixture {
  readonly dir: string;
  readonly env: Env;
  readonly shims: string;
  readonly pmLog: string;
  readonly iaLog: string;
  readonly running: string;
}
/** A PATH of only the shims and git's own directory, the logs, and git with no user configuration. */
export function fixture(prefix: string): Fixture {
  const dir = base(prefix);
  const shims = join(dir, 'shims');
  mkdirSync(shims, { recursive: true });
  for (const manager of MANAGERS) shim(shims, manager, FAKE_PM, [manager]);
  const git = gitDirectory();
  const config = join(dir, 'gitconfig');
  writeFileSync(config, '');
  const running = join(dir, 'running cli');
  mkdirSync(join(running, 'dist'), { recursive: true });
  writeFileSync(join(running, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '3.5.1' }));
  writeFileSync(join(running, 'dist', 'main.js'), loggingCopy('running'));
  const env: Env = {
    ...process.env,
    PATH: [shims, git].join(delimiter),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_TERMINAL_PROMPT: '0',
    FAKE_PM_LOG: join(dir, 'pm.log'),
    FAKE_IA_LOG: join(dir, 'ia.log'),
  };
  for (const name of Object.keys(env))
    if (/^path$/i.test(name) && name !== 'PATH') delete (env as Record<string, string>)[name];
  return { dir, env, shims, pmLog: join(dir, 'pm.log'), iaLog: join(dir, 'ia.log'), running };
}

/**
 * The directory git runs from with nothing else on PATH. Git for Windows' `cmd` directory holds a git.exe that sets up
 * its own environment; the `bin` one beside its DLLs cannot push alone, so `cmd` is preferred where PATH has it.
 */
function gitDirectory(): string {
  const found = findProgram('git', process.env);
  if (found === null) throw new Error('git is not on PATH');
  if (process.platform !== 'win32') return dirname(found);
  const entries = (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter);
  const wrapper = entries.find((entry) => /[\\/]cmd[\\/]?$/i.test(entry) && existsSync(join(entry, 'git.exe')));
  return wrapper ?? dirname(found);
}

/** A script that logs {argv, cwd, version} to $FAKE_IA_LOG and exits 0, as the copies fake-pm.mjs installs do. */
export const loggingCopy = (version: string): string =>
  [
    "import { appendFileSync } from 'node:fs';",
    `const version = ${JSON.stringify(version)};`,
    'if (process.env.FAKE_IA_LOG)',
    '  appendFileSync(process.env.FAKE_IA_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), version })}\\n`);',
    '',
  ].join('\n');

/** `name` in `dir` running `node <script> ...lead ...args`: a `.cmd` on Windows, a shell script elsewhere. */
export function shim(dir: string, name: string, script: string, lead: readonly string[] = []): void {
  if (process.platform === 'win32')
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@"${process.execPath}" "${script}" ${lead.join(' ')} %*\r\n`.replace('  ', ' '),
    );
  else {
    const file = join(dir, name);
    const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    writeFileSync(file, `#!/bin/sh\nexec ${[process.execPath, script, ...lead].map(quoted).join(' ')} "$@"\n`);
    chmodSync(file, 0o755);
  }
}

export const git = (cwd: string, args: readonly string[], env: Env): string =>
  execFileSync('git', [...args], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export interface Repo {
  readonly top: string;
  readonly origin: string;
}
/** A repository `name` under `dir` with `files` committed on `branch` and pushed to a bare origin. */
export function repo(fx: Fixture, name: string, files: Readonly<Record<string, string>> = {}, branch = 'main'): Repo {
  const origin = join(fx.dir, `${name}-origin.git`);
  git(fx.dir, ['init', '--quiet', '--bare', '-b', branch, origin], fx.env);
  const top = join(fx.dir, name);
  mkdirSync(top, { recursive: true });
  git(top, ['init', '--quiet', '-b', branch], fx.env);
  for (const [path, text] of Object.entries({ '.ia/src/workspace.ia': '', ...files })) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git(top, ['add', '-A'], fx.env);
  git(top, ['commit', '--quiet', '-m', 'init'], fx.env);
  git(top, ['remote', 'add', 'origin', origin], fx.env);
  git(top, ['push', '--quiet', 'origin', branch], fx.env);
  return { top: realpathSync.native(top), origin };
}

export interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Env;
}
/** A runner that records every call and passes it to `inner`. */
export function recorder(inner: Runner): { readonly run: Runner; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options.cwd, env: options.env });
      return inner(file, args, options);
    },
  };
}

export const readLog = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as T)
    : [];
export const appendLine = (path: string, text: string): void => appendFileSync(path, `${text}\n`);

export const tracked = (root: string): RepoRow['tracked'] => ({
  id: root.split(/[\\/]/).at(-1)!,
  root,
  added: '2026-01-01T00:00:00.000Z',
});
/** A ready row that offers `offers`. */
export const rowOf = (root: string, offers: readonly Offer[]): RepoRow => ({
  tracked: tracked(root),
  state: 'ready',
  console: null,
  offers,
  failure: null,
});
export const offerOf = (id: string, title: string, steps: readonly Step[]): Offer => ({
  id,
  answers: [id],
  title,
  explain: '',
  steps,
  changes: [],
  group: 'attention',
  area: null,
  writesTo: [...new Set(steps.map((step) => step.writesTo))],
  batchable: batchable(steps),
});
