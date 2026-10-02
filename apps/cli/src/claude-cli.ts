/**
 * Host plugin distribution spec §6.3 (amended, item 5) and §2.3: Claude's own CLI does the registering and reports its
 * own state through its `--json` lists; Claude's files are never read or written here. `IA_CLAUDE` names a Node
 * script to run instead of `claude`; it exists for tests and is not a user-facing setting.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN } from '@ia/compliance';
import { Refusal } from './consumer.js';

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
}
const DEFAULTS: RunnerDependencies = {
  platform: process.platform,
  spawn: (command, args, options) => spawnSync(command, [...args], { ...options, encoding: 'utf8' }),
};
/**
 * One argument on the cmd.exe line of the Windows fallback. cmd.exe expands `%NAME%` even inside quotes and a `"`
 * ends the quoting, so neither can be passed safely; such an argument refuses rather than being quoted.
 */
function cmdArgument(value: string): string {
  if (/[%"]/.test(value))
    throw new Refusal(
      'IA-CLI-HOST-COMMAND-FAILED',
      `claude is reachable only through cmd.exe here (no claude executable on PATH, so an npm claude.cmd shim), and cmd.exe cannot pass ${value} unchanged because it contains % or "`,
      3,
      null,
      'Set IA_HOME to a directory whose path has no % or ", or install Claude Code so that claude.exe is on PATH, then rerun.',
    );
  return /^[\w\-.:\\/@=+,]+$/.test(value) ? value : `"${value}"`;
}
export function claudeRunner(env: Env, dependencies: RunnerDependencies = DEFAULTS): ClaudeRunner {
  const { platform, spawn } = dependencies;
  const fake = env['IA_CLAUDE'];
  const real = (args: readonly string[], timeout: number): SpawnSyncReturns<string> => {
    if (platform !== 'win32') return spawn('claude', args, { timeout, windowsHide: true });
    // Windows: a claude.exe on PATH runs with no shell, so no argument is reinterpreted. Node resolves no .cmd file
    // without a shell, so only a missing executable falls back to the cmd.exe line an npm shim needs.
    const direct = spawn('claude', args, { shell: false, timeout, windowsHide: true });
    if ((direct.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return direct;
    return spawn(['claude', ...args].map(cmdArgument).join(' '), [], { shell: true, timeout, windowsHide: true });
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
