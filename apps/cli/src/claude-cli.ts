/**
 * Host plugin distribution spec §6.3 (amended, item 5) and §2.3: Claude's own CLI does the registering and reports its
 * own state through its `--json` lists; Claude's files are never read or written here. `IA_CLAUDE` names a Node
 * script to run instead of `claude`; it exists for tests and is not a user-facing setting. `claude` itself is found on
 * qualified PATH entries and run by absolute path from the home directory (src/program.ts).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN } from '@inventarch/compliance';
import { Refusal } from './consumer.js';
import type { LookupFs } from './program.js';
import { findProgram, programEnv, programHome, SYSTEM, windowsShell, windowsShellArgs } from './program.js';

type Env = Readonly<Record<string, string | undefined>>;
export const PLUGIN_ID = `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`;
/** null: not known, because claude is unavailable or its list did not parse. */
export interface ClaudeState {
  readonly marketplaceKnown: boolean | null;
  readonly installed: boolean | null;
}
export interface ClaudeRunner {
  readonly available: boolean;
  /** `stdout` alone is what a `--json` list is parsed from; `output` is both streams, for a refusal to quote. */
  readonly run: (args: readonly string[]) => {
    readonly status: number | null;
    readonly stdout: string;
    readonly output: string;
  };
}
type Row = Readonly<Record<string, unknown>>;
/** Whether one of Claude's `--json` lists has a matching row; null when the command failed or printed no array. */
function listed(runner: ClaudeRunner, args: readonly string[], match: (row: Row) => boolean): boolean | null {
  const result = runner.run(args);
  if (result.status !== 0) return null;
  try {
    const rows = JSON.parse(result.stdout) as unknown;
    return Array.isArray(rows)
      ? rows.some((row) => row !== null && typeof row === 'object' && match(row as Row))
      : null;
  } catch {
    return null;
  }
}
/**
 * §2.3's observed shapes: `plugin marketplace list --json` is an array of `{name, …}` and `plugin list --json` an
 * array of `{id, scope, …}`. Only a user-scope install is ours to remove; a row without a scope is taken as one.
 */
export function observeClaude(runner: ClaudeRunner): ClaudeState {
  if (!runner.available) return { marketplaceKnown: null, installed: null };
  return {
    marketplaceKnown: listed(
      runner,
      ['plugin', 'marketplace', 'list', '--json'],
      (row) => row['name'] === CLAUDE_MARKETPLACE,
    ),
    installed: listed(
      runner,
      ['plugin', 'list', '--json'],
      (row) => row['id'] === PLUGIN_ID && (row['scope'] === undefined || row['scope'] === 'user'),
    ),
  };
}
/** §2.3: `marketplace add` and `install` are both idempotent, so registration is always the same two commands. */
export const registrationCommands = (marketplace: string): string[][] => [
  ['plugin', 'marketplace', 'add', marketplace],
  ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
];
/** §2.3: `uninstall` and `remove` exit 1 when there is nothing to remove, so only what is listed (or unknown) is removed. */
export function removalCommands(state: ClaudeState): string[][] {
  return [
    ...(state.installed === false ? [] : [['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user']]),
    ...(state.marketplaceKnown === false ? [] : [['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE]]),
  ];
}

/** Registration and removal commands get two minutes; the availability probe far less, so a hung `claude` cannot stall a plan. */
const COMMAND_TIMEOUT = 120_000,
  PROBE_TIMEOUT = 10_000;
/** The variables that steer tests/fake-claude.mjs. Only the ones this invocation was given reach it; inherited ones are dropped. */
const FAKE_VARIABLE = /^(IA_CLAUDE_|FAKE_CLAUDE_)/;
export type Spawn = (
  command: string,
  args: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => SpawnSyncReturns<string>;
/** Injected only by tests, which exercise the Windows resolution without running a real `claude`. */
export interface RunnerDependencies {
  readonly platform: NodeJS.Platform;
  readonly spawn: Spawn;
  /** The file system the lookup of `claude` reads; the real one unless a test runs the Windows rules elsewhere. */
  readonly fs?: LookupFs;
}
const DEFAULTS: RunnerDependencies = {
  platform: process.platform,
  spawn: (command, args, options) => spawnSync(command, [...args], { ...options, encoding: 'utf8' }),
};
/** What a spawn of a missing program returns, for a `claude` the lookup did not find: nothing is started. */
const missing = (): SpawnSyncReturns<string> => ({
  pid: 0,
  output: [],
  stdout: '',
  stderr: '',
  status: null,
  signal: null,
  error: Object.assign(new Error('claude was not found on a qualified PATH entry'), { code: 'ENOENT' }),
});
/**
 * One argument on the cmd.exe line that runs a `claude.cmd`. cmd.exe expands `%NAME%` even inside quotes and a `"`
 * ends the quoting, so neither can be passed safely; such an argument refuses rather than being quoted.
 */
function cmdArgument(value: string): string {
  if (/[%"]/.test(value))
    throw new Refusal(
      'IA-CLI-HOST-COMMAND-FAILED',
      `claude is reachable only through cmd.exe here (no claude executable on PATH, so an npm claude.cmd shim), and cmd.exe cannot pass ${value} unchanged because it contains % or "`,
      3,
      null,
      'Set IA_HOME to a directory whose path has no % or double quote, or install Claude Code so that claude.exe is on PATH, then run "ia host claude --user" to plan again.',
    );
  return /^[\w\-.:\\/@=+,]+$/.test(value) ? value : `"${value}"`;
}
export function claudeRunner(env: Env, dependencies: RunnerDependencies = DEFAULTS): ClaudeRunner {
  const { platform, spawn } = dependencies;
  const system = { platform, fs: dependencies.fs ?? SYSTEM.fs };
  const fake = env['IA_CLAUDE'];
  // Found once, on qualified PATH entries only. A claude.exe anywhere there runs with no shell, so no argument is
  // reinterpreted; only without one does the claude.cmd an npm install leaves run, through cmd.exe named by its path.
  const program = fake === undefined ? findProgram('claude', env, 'program', system) : null;
  const script = fake === undefined && program === null ? findProgram('claude', env, 'script', system) : null;
  const options = { cwd: programHome(), env: programEnv(env, platform) };
  const real = (args: readonly string[], timeout: number): SpawnSyncReturns<string> => {
    if (program !== null) return spawn(program, args, { ...options, timeout, windowsHide: true });
    if (script === null) return missing();
    return spawn(windowsShell(env), windowsShellArgs(script, args.map(cmdArgument)), {
      ...options,
      timeout,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  };
  const fakeEnv = (): Record<string, string | undefined> => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !FAKE_VARIABLE.test(name))),
    ...Object.fromEntries(Object.entries(env).filter(([name]) => FAKE_VARIABLE.test(name))),
  });
  const invoke = (args: readonly string[], timeout: number): SpawnSyncReturns<string> =>
    fake !== undefined
      ? spawn(process.execPath, [fake, ...args], { env: fakeEnv(), timeout, windowsHide: true })
      : real(args, timeout);
  // The fake is probed exactly as `claude` is, so tests observe when the probe runs.
  const available = (fake === undefined || existsSync(fake)) && invoke(['--version'], PROBE_TIMEOUT).status === 0;
  return {
    available,
    run: (args) => {
      const result = invoke(args, COMMAND_TIMEOUT);
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
      };
    },
  };
}
