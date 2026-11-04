/**
 * Running an offer (consumer CLI contract §1.2): in the normal screen, with inherited stdio, so the user sees the real output. Each
 * step follows its flow: a preview-apply form previews, asks, then applies with `--apply --yes`; a preview-flag form
 * runs with `--preview`, asks, then as given; a confirm step is shown, asked and run in its confirmed form (a required
 * `--apply` gains `--yes`, so the child never asks again); an immediate step runs straight away. A decline, a non-zero
 * exit, or a step that needs the repo copy when none resolves stops the recipe.
 *
 * Which copy runs a step is decided at that step, from the disk (`resolveRepo`), never from the state's snapshot: a
 * step that installs or replaces the workspace's copy changes which entry the next step runs. An `ia` step is spawned
 * as `process.execPath <entry> …argv` with `IA_NO_HANDOFF=1`; an external one by the absolute path `findProgram` finds
 * on qualified PATH entries (a Windows `.cmd` through cmd.exe named by its path), or as given when it is absolute.
 */
import { spawn as spawnChild } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { Fix } from '../fix.js';
import { confirmedArgv, previewArgv } from '../fix.js';
import { NO_HANDOFF } from '../handoff.js';
import type { LocalCli } from '../local-cli.js';
import type { Env } from '../program.js';
import { findProgram, programEnv, windowsShell, windowsShellArgs } from '../program.js';
import type { Offer, Step } from './offers.js';
import { runsOn } from './offers.js';
import type { ConsoleState } from './state.js';
import { sanitize } from './grid.js';
import type { Screen } from './terminal.js';

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Env;
  readonly windowsVerbatimArguments?: boolean;
}
/** Starts a program with inherited stdio and settles with its exit code, or null when it ended on a signal. */
export interface Spawner {
  (file: string, args: readonly string[], options: SpawnOptions): Promise<number | null>;
}
export interface RunIO {
  readonly screen: Pick<Screen, 'enter' | 'leave' | 'invalidate'>;
  readonly spawn: Spawner;
  /** A yes/no question in the normal screen; only an explicit yes consents. */
  readonly ask: (question: string) => Promise<boolean>;
  /** One line of input in the console; null when cancelled. */
  readonly prompt: (label: string, accept: (value: string) => string | null) => Promise<string | null>;
  readonly waitKey: () => Promise<void>;
  readonly print: (text: string) => void;
  /** The workspace's own copy as the disk has it now: readCliDependency, then findLocalCli. */
  readonly resolveRepo: (root: string) => LocalCli | null;
  readonly env: Env;
  /** The working directory outside a workspace. */
  readonly cwd: string;
}

/** The running copy's entry, which never hands off. */
export const runningEntry = (packageRoot: string): string => join(packageRoot, 'dist', 'main.js');

/**
 * One argument on the line cmd.exe runs a `.cmd` program with, which forwards it (`%*`) to a program that splits its
 * line by the Windows argv rules (CommandLineToArgvW and the C runtime). Plain text passes as typed. Anything else is
 * quoted by those rules: inside the quotes a run of backslashes before a quote, or before the closing quote, is
 * doubled and an embedded quote is escaped, so the program reads back exactly this argument; and cmd.exe, which sees
 * it inside quotes, leaves a caret, an ampersand, a pipe, a redirection or a bang alone. Null, refused, for `%`, which
 * cmd.exe expands even inside quotes, and for an embedded quote beside a character cmd.exe would act on, since the
 * quote toggles cmd.exe's own quoting.
 */
export function cmdArgument(value: string): string | null {
  if (value.includes('%')) return null;
  if (/^[\w\-.:\\/@+~]+$/.test(value)) return value;
  if (value.includes('"') && /[&|<>^()!]/.test(value)) return null;
  let out = '"',
    slashes = 0;
  for (const character of value) {
    if (character === '\\') {
      slashes += 1;
      continue;
    }
    out += character === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

const CONTROL_NAMES: Readonly<Record<string, string>> = { '\t': 't', '\n': 'n', '\r': 'r', '\x1b': 'e' };
/**
 * Text as the normal screen shows it: every control character as its own visible escape (`\t`, `\n`, `\r`, `\e`,
 * else `\xNN`) and a backslash as `\\`, so no escape sequence reaches the terminal and what is shown reads back
 * exactly; two different texts never show the same.
 */
export function visible(text: string): string {
  return text.replace(/[\\\x00-\x1f\x7f-\x9f]/g, (character) => {
    if (character === '\\') return '\\\\';
    const name = CONTROL_NAMES[character];
    return name === undefined ? `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}` : `\\${name}`;
  });
}
/** A command as a confirmation shows it: each argument made visible, one holding a space or a quote quoted. */
function shownArgv(program: Fix['program'], argv: readonly string[]): string {
  const parts = argv.map((part) => {
    const shown = visible(part);
    return /[ "]/.test(part) || part === '' ? `"${shown.replace(/"/g, '\\"')}"` : shown;
  });
  return (program === 'ia' ? ['ia', ...parts] : parts).join(' ');
}

/** The default spawner: inherited stdio, and this process deaf to the terminal's signals while the child decides. */
export const spawnInherited: Spawner = (file, args, options) =>
  new Promise((settle, reject) => {
    const ignore = (): void => {};
    const signals: NodeJS.Signals[] = [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : []),
    ];
    for (const signal of signals) process.on(signal, ignore);
    const done = (): void => {
      for (const signal of signals) process.off(signal, ignore);
    };
    const child = spawnChild(file, [...args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: 'inherit',
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
    });
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code) => {
      done();
      settle(code);
    });
  });

interface Target {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly copy: 'running' | 'repo' | 'external';
}
/** How one form of a step is started, or why it cannot be. */
function target(
  step: Fix,
  argv: readonly string[],
  state: ConsoleState,
  repo: LocalCli | null,
  io: RunIO,
): Target | string {
  const cwd = state.root ?? io.cwd;
  if (step.program === 'ia') {
    const on = runsOn({ ...step, argv }, { running: state.running, repo });
    const entry = on === 'repo' && repo !== null ? repo.entry : runningEntry(state.running.packageRoot);
    return {
      file: process.execPath,
      args: [entry, ...argv],
      options: { cwd, env: { ...io.env, [NO_HANDOFF]: '1' } },
      copy: on === 'repo' ? 'repo' : 'running',
    };
  }
  const [name, ...rest] = argv;
  if (name === undefined) return 'the step names no program';
  const env = programEnv(io.env);
  if (isAbsolute(name)) return { file: name, args: rest, options: { cwd, env }, copy: 'external' };
  const program = findProgram(name, io.env, 'program');
  if (program !== null) return { file: program, args: rest, options: { cwd, env }, copy: 'external' };
  const script = findProgram(name, io.env, 'script');
  if (script === null) return `${name} was not found on a qualified PATH entry`;
  const quoted = rest.map(cmdArgument);
  if (quoted.some((value) => value === null)) return `cmd.exe cannot pass an argument of ${name} unchanged`;
  return {
    file: windowsShell(io.env),
    args: windowsShellArgs(script, quoted as string[]),
    options: { cwd, env, windowsVerbatimArguments: true },
    copy: 'external',
  };
}
const shown = (step: Fix, argv: readonly string[]): string => shownArgv(step.program, argv);

export async function runOffer(
  offer: Offer,
  state: ConsoleState,
  io: RunIO,
): Promise<{ readonly completed: number; readonly exitCode: number | null }> {
  if (offer.disabled !== undefined) return { completed: 0, exitCode: null };
  // What the normal screen shows is made visible (`visible`, `shownArgv`); the argv that runs is untouched. The grid's
  // replacement stays as a last net for anything that was not.
  const say = (text: string): void => io.print(sanitize(text));
  const confirm = (question: string): Promise<boolean> => io.ask(sanitize(question));
  let steps: readonly Step[] = offer.steps;
  if (offer.input !== undefined) {
    const value = await io.prompt(offer.input.label, offer.input.accept);
    if (value === null) return { completed: 0, exitCode: null };
    steps = offer.input.build(value);
  }
  let left = false;
  const leave = (): void => {
    if (left) return;
    io.screen.leave();
    left = true;
  };
  let completed = 0,
    exitCode: number | null = null,
    outcome = '';
  for (const [index, step] of steps.entries()) {
    const label = steps.length > 1 ? `Step ${index + 1} of ${steps.length}: ` : '';
    // The target is resolved now, from the disk: an earlier step may have installed or replaced the repo copy.
    const repo = state.root === null ? null : io.resolveRepo(state.root);
    leave();
    if (step.requires === 'repo-copy' && repo === null) {
      outcome = `Stopped at step ${index + 1}: the repo copy is not installed.`;
      break;
    }
    const run = async (argv: readonly string[]): Promise<{ code: number | null; copy: Target['copy'] } | string> => {
      const started = target(step, argv, state, repo, io);
      if (typeof started === 'string') return started;
      say(`$ ${shown(step, argv)}`);
      return { code: await io.spawn(started.file, started.args, started.options), copy: started.copy };
    };
    let result: Awaited<ReturnType<typeof run>> | null = null;
    const preview = previewArgv(step);
    if (step.flow === 'immediate') result = await run(step.argv);
    else {
      say(`${label}${visible(offer.title)}`);
      if (preview !== null) {
        const previewed = await run(preview);
        if (typeof previewed === 'string' || previewed.code !== 0) result = previewed;
      }
      if (result === null) {
        const final = step.flow === 'preview-flag' ? step.argv : confirmedArgv(step);
        if (!(await confirm(`${preview === null ? 'Run' : 'Apply'}: ${shown(step, final)}?`))) {
          outcome = `Declined; ${index === 0 ? 'nothing ran' : `stopped before step ${index + 1}`}.`;
          break;
        }
        result = await run(final);
      }
    }
    if (typeof result === 'string') {
      outcome = `Stopped at step ${index + 1}: ${visible(result)}.`;
      break;
    }
    if (result.code !== 0) {
      exitCode = result.code;
      const how = result.code === null ? 'ended by a signal' : `exited ${result.code}`;
      outcome =
        result.code === 2 && result.copy === 'repo'
          ? `Stopped at step ${index + 1}: this workspace's ia ${visible(repo?.version ?? '')} refused the command as usage (exit 2); it may be older than the command this console runs.`
          : `Stopped at step ${index + 1}: ${shown(step, step.argv)} ${how}.`;
      break;
    }
    completed += 1;
  }
  if (!left) return { completed, exitCode };
  say(outcome === '' ? (steps.length > 1 ? `Done: ${completed} steps.` : 'Done.') : outcome);
  say('Press any key to return to the console.');
  await io.waitKey();
  io.screen.enter();
  io.screen.invalidate();
  return { completed, exitCode };
}
