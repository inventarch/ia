/**
 * Running offers and the console's loop (console/run.ts, console/app.ts), with a fake terminal, a scripted input stream
 * and a recording spawner: the argv each flow spawns, which copy's entry runs each step (resolved at that step, from
 * the disk), that a decline spawns nothing, and that the terminal is restored on quit, on a throw and on a signal.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { Check, CheckStatus, DoctorRequest, DoctorView } from '../src/doctor.js';
import { collectDoctor } from '../src/doctor.js';
import type { Fix } from '../src/fix.js';
import { iaFix } from '../src/fix.js';
import type { LocalCli } from '../src/local-cli.js';
import type { ProcessHooks } from '../src/console/app.js';
import type { Runner } from '../src/console/batch-run.js';
import { defaultRunner } from '../src/console/batch-run.js';
import { consoleSignals, resolveRepo, runConsole } from '../src/console/app.js';
import type { SpawnDoctor } from '../src/console/load.js';
import type { Offer, Step } from '../src/console/offers.js';
import { offersFor } from '../src/console/offers.js';
import type { RunIO, SpawnOptions } from '../src/console/run.js';
import { cmdArgument, runOffer, runningEntry, shownArgument } from '../src/console/run.js';
import { windowsShellArgs } from '../src/program.js';
import type { ConsoleCheck, ConsoleState } from '../src/console/state.js';
import type { TerminalIO } from '../src/console/terminal.js';
import { readTracked, trackWorkspaces } from '../src/tracked.js';
import { fixture, repo } from './batch-fixture.js';
import { TRACKED_LOCK_FILE } from '../src/tracked-lock.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);

const ROOT = '/srv/ws';
const RUNNING = '/srv/global/cli';
const A: LocalCli = { packageRoot: `${ROOT}/node_modules/@inventarch/cli`, version: '3.5.0', entry: '/srv/a/bin.js' };
const B: LocalCli = { packageRoot: `${ROOT}/node_modules/@inventarch/cli`, version: '3.6.0', entry: '/srv/b/bin.js' };
const state = (extra: Partial<ConsoleState> = {}): ConsoleState => ({
  root: ROOT,
  running: { packageRoot: RUNNING, version: '3.5.1' },
  repo: A,
  checks: [],
  areas: [],
  repoFailure: null,
  tracked: true,
  refreshNow: null,
  refreshNowWhy: 'off',
  facts: {
    home: '/srv/home',
    latest: null,
    manifestDir: ROOT,
    manager: 'npm',
    managerConflict: [],
    generation: false,
    marketplace: false,
  },
  ...extra,
});
const offer = (steps: readonly Step[], extra: Partial<Offer> = {}): Offer => ({
  id: 'test',
  answers: [],
  title: 'Test offer',
  explain: '',
  steps,
  changes: [],
  group: 'attention',
  area: null,
  writesTo: [],
  batchable: false,
  ...extra,
});
interface Spawned {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}
/** A fake RunIO: answers, exit codes and the repo copy the disk "has" are scripted; every call is recorded. */
function harness(
  script: {
    answers?: boolean[];
    codes?: number[];
    repo?: () => LocalCli | null;
    onSpawn?: (call: Spawned) => void;
  } = {},
) {
  const events: string[] = [];
  const spawned: Spawned[] = [];
  const printed: string[] = [];
  const answers = [...(script.answers ?? [])];
  const codes = [...(script.codes ?? [])];
  const io: RunIO = {
    screen: {
      leave: () => events.push('leave'),
      enter: () => events.push('enter'),
      invalidate: () => events.push('invalidate'),
    },
    spawn: async (file, args, options) => {
      events.push('spawn');
      const call = { file, args, options };
      spawned.push(call);
      script.onSpawn?.(call);
      return codes.shift() ?? 0;
    },
    ask: async (question) => {
      events.push(`ask ${question}`);
      return answers.shift() ?? false;
    },
    prompt: async () => null,
    waitKey: async () => {
      events.push('waitKey');
    },
    print: (text) => printed.push(text),
    resolveRepo: () => (script.repo ?? (() => A))(),
    env: { PATH: '' },
    cwd: ROOT,
  };
  return { io, events, spawned, printed };
}
const argvOf = (call: Spawned): readonly string[] => call.args.slice(1);

describe('runOffer', () => {
  it('preview-apply previews without --apply or --yes, then applies with both', async () => {
    const run = harness({ answers: [true] });
    const result = await runOffer(offer([iaFix(['install', 'acme/kit', '--apply'], 'repo').fix!]), state(), run.io);
    expect(result).toEqual({ completed: 1, exitCode: null });
    expect(run.spawned.map(argvOf)).toEqual([
      ['install', 'acme/kit'],
      ['install', 'acme/kit', '--apply', '--yes'],
    ]);
  });
  it('a required apply gets --yes: restore --apply runs as restore --apply --yes', async () => {
    const run = harness({ answers: [true] });
    await runOffer(offer([iaFix(['restore', '--apply'], 'repo').fix!]), state(), run.io);
    expect(run.spawned.map(argvOf)).toEqual([['restore', '--apply', '--yes']]);
  });
  it('a confirm step with no apply is run as given (recover, workspaces add)', async () => {
    const run = harness({ answers: [true, true] });
    await runOffer(
      offer([iaFix(['recover'], 'repo', ROOT).fix!, iaFix(['workspaces', 'add', ROOT], 'user').fix!]),
      state(),
      run.io,
    );
    expect(run.spawned.map(argvOf)).toEqual([
      ['recover', '--root', ROOT],
      ['workspaces', 'add', ROOT],
    ]);
  });
  it('a decline stops the recipe', async () => {
    const run = harness({ answers: [false] });
    const result = await runOffer(
      offer([iaFix(['install', 'acme/kit'], 'repo').fix!, iaFix(['validate'], 'none').fix!]),
      state(),
      run.io,
    );
    expect(run.spawned.map(argvOf)).toEqual([['install', 'acme/kit']]);
    expect(result).toEqual({ completed: 0, exitCode: null });
    expect(run.printed.join('\n')).toContain('Declined');
  });
  it('declining Track writes nothing', async () => {
    const home = scratch('console-track');
    const file = join(home, 'tracked-workspaces.json');
    writeFileSync(file, `${JSON.stringify({ format: 'ia-tracked-workspaces-1', workspaces: [] }, null, 2)}\n`);
    const before = readFileSync(file);
    const track = offersFor(state({ tracked: false })).find((entry) => entry.id === 'track')!;
    const declined = harness({ answers: [false] });
    await runOffer(track, state({ tracked: false }), declined.io);
    expect(declined.spawned).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(home, 'tracked-workspaces.json.lock'))).toBe(false);
    const accepted = harness({ answers: [true] });
    await runOffer(track, state({ tracked: false }), accepted.io);
    expect(accepted.spawned).toHaveLength(1);
    expect(argvOf(accepted.spawned[0]!)).toEqual(['workspaces', 'add', ROOT]);
    // Track writes the user's home, so the running copy runs it.
    expect(accepted.spawned[0]!.args[0]).toBe(runningEntry(RUNNING));
  });
  it('a non-zero exit stops the recipe and is shown', async () => {
    const run = harness({ codes: [1] });
    const result = await runOffer(
      offer([iaFix(['validate'], 'none').fix!, iaFix(['validate'], 'none').fix!]),
      state(),
      run.io,
    );
    expect(run.spawned).toHaveLength(1);
    expect(result).toEqual({ completed: 0, exitCode: 1 });
    expect(run.printed.join('\n')).toContain('ia validate exited 1');
  });
  it('an exit 2 from the repo copy says that copy refused the command as usage', async () => {
    const run = harness({ codes: [2] });
    await runOffer(offer([iaFix(['validate'], 'none').fix!]), state(), run.io);
    expect(run.printed.join('\n')).toContain("this workspace's ia 3.5.0 refused the command as usage (exit 2)");
  });
  const pin: Fix = {
    program: 'external',
    argv: [process.execPath, '-e', ''],
    flow: 'confirm',
    writesTo: 'repo',
  };
  const recipe = (): Step[] => [
    pin,
    { ...iaFix(['validate'], 'none').fix!, requires: 'repo-copy' },
    iaFix(['host', 'claude', '--user', '--apply'], 'user').fix!,
  ];
  it('the entry is resolved before each step', async () => {
    let disk: LocalCli | null = A;
    const run = harness({
      answers: [true, true],
      repo: () => disk,
      onSpawn: (call) => {
        if (call.file === process.execPath && call.args[0] === '-e') disk = B;
      },
    });
    await runOffer(offer(recipe()), state(), run.io);
    expect(run.spawned.map((call) => call.args[0])).toEqual([
      '-e',
      B.entry,
      runningEntry(RUNNING),
      runningEntry(RUNNING),
    ]);
  });
  it('a repo copy that appears during the recipe is used; one that vanishes stops a requires-repo-copy step', async () => {
    let disk: LocalCli | null = null;
    const appears = harness({ answers: [true, true], repo: () => disk, onSpawn: () => (disk = B) });
    await runOffer(offer(recipe()), state({ repo: null }), appears.io);
    expect(appears.spawned[1]!.args[0]).toBe(B.entry);
    let present: LocalCli | null = A;
    const vanishes = harness({ answers: [true], repo: () => present, onSpawn: () => (present = null) });
    const result = await runOffer(offer(recipe()), state(), vanishes.io);
    expect(vanishes.spawned).toHaveLength(1);
    expect(result.completed).toBe(1);
    expect(vanishes.printed.join('\n')).toContain('the repo copy is not installed');
  });
  it('the running copy still runs user-writing steps after the pin', async () => {
    const run = harness({ answers: [true, true], repo: () => B });
    await runOffer(offer(recipe()), state(), run.io);
    expect(run.spawned.slice(2).map((call) => [call.args[0], ...argvOf(call)])).toEqual([
      [runningEntry(RUNNING), 'host', 'claude', '--user'],
      [runningEntry(RUNNING), 'host', 'claude', '--user', '--apply', '--yes'],
    ]);
  });
  it('the screen is left before a spawn and repainted after', async () => {
    const run = harness({ answers: [true] });
    await runOffer(offer([iaFix(['validate'], 'none').fix!]), state(), run.io);
    expect(run.events).toEqual(['leave', 'spawn', 'waitKey', 'enter', 'invalidate']);
  });
  it('ia steps spawn the resolved entry with IA_NO_HANDOFF=1', async () => {
    const run = harness();
    await runOffer(offer([iaFix(['validate'], 'none').fix!]), state(), run.io);
    expect(run.spawned[0]).toMatchObject({
      file: process.execPath,
      args: [A.entry, 'validate'],
      options: { cwd: ROOT, env: { IA_NO_HANDOFF: '1' } },
    });
  });
  it('an absolute external program is run as given, in the workspace', async () => {
    const run = harness({ answers: [true] });
    await runOffer(offer([pin]), state(), run.io);
    expect(run.spawned[0]).toMatchObject({ file: process.execPath, args: ['-e', ''], options: { cwd: ROOT } });
  });
  it('control characters in a title or argv never reach the normal screen; the original argv still runs', async () => {
    const root = '/srv/ws\x1b[?1000h\x9b2J';
    const track = offersFor(state({ root, tracked: false })).find((entry) => entry.id === 'track')!;
    const run = harness({ answers: [true] });
    const questions: string[] = [];
    const io: RunIO = {
      ...run.io,
      ask: async (question) => {
        questions.push(question);
        return true;
      },
    };
    await runOffer({ ...track, title: 'Track\x1b]0;forged\x07 this' }, state({ root, tracked: false }), io);
    for (const text of [...run.printed, ...questions]) {
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(text).not.toContain('\x1b');
    }
    expect(questions[0]).toContain('"/srv/ws\\u001b[?1000h\\u009b2J"');
    expect(run.printed.join('\n')).toContain('"Track\\u001b]0;forged\\u0007 this"');
    expect(argvOf(run.spawned[0]!)).toEqual(['workspaces', 'add', root]);
  });
  it('a confirmation shows ordinary arguments verbatim and any other as a JSON string, so it reads back exactly', async () => {
    for (const [root, shown] of [
      ['C:\\ws', 'C:\\ws'],
      ['C:\\Program Files\\app', 'C:\\Program Files\\app'],
      ['/srv/a\tb', '"/srv/a\\tb"'],
      ['/srv/a\nb', '"/srv/a\\nb"'],
      ['/srv/a\rb', '"/srv/a\\rb"'],
      ['"x"', '"\\"x\\""'],
    ] as const) {
      const track = offersFor(state({ root, tracked: false })).find((entry) => entry.id === 'track')!;
      const questions: string[] = [];
      const run = harness();
      await runOffer(track, state({ root, tracked: false }), {
        ...run.io,
        ask: async (question) => {
          questions.push(question);
          return false;
        },
      });
      expect(questions[0]).toBe(`Run: ia workspaces add ${shown}?`);
    }
    // Two different control characters never render the same, and none reaches the terminal raw.
    const controls = [...Array(0x20).keys(), ...Array.from({ length: 0x21 }, (_, at) => 0x7f + at)].map((code) =>
      String.fromCharCode(code),
    );
    const rendered = controls.map((character) => shownArgument(`x${character}y`));
    expect(new Set(rendered).size).toBe(controls.length);
    for (const text of rendered) expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(shownArgument('\x1b')).toBe('"\\u001b"');
    expect(shownArgument('\x9b')).toBe('"\\u009b"');
    expect(shownArgument('a\\"b')).toBe('a\\"b');
  });
  it('every shown argument decodes back to the argument: JSON when it starts with a quote, else as written', () => {
    const decode = (shown: string): string => (shown.startsWith('"') ? (JSON.parse(shown) as string) : shown);
    const pieces = [
      '',
      'a',
      ' ',
      '"',
      '\\',
      'C:',
      '用户',
      '🚀',
      '\t',
      '\n',
      '\x1b',
      '\x7f',
      '\x85',
      '\x9b',
      '\u2028',
      '\uD800',
      '\uDC00',
      "'",
    ];
    const samples = new Set<string>(['', '""', '"x"', 'x"', '\\"', 'C:\\w^s\\', '\\\\server\\share\\']);
    for (const a of pieces) for (const b of pieces) for (const c of pieces) samples.add(a + b + c);
    for (const sample of samples) {
      const shown = shownArgument(sample);
      expect([sample, decode(shown)]).toEqual([sample, sample]);
      expect(shown).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      // A lone surrogate would print as U+FFFD in UTF-8 output, so it is never shown raw.
      expect(shown).not.toMatch(/\p{Cs}/u);
    }
    expect(shownArgument('a\uD800 b')).toBe('"a\\ud800 b"');
    expect(shownArgument('a\uD800b')).toBe('"a\\ud800b"');
    expect(shownArgument('🚀')).toBe('🚀');
  });
  it('cmd.exe arguments: plain ones pass as typed, everything cmd would read is quoted or refused', () => {
    expect(cmdArgument('install')).toBe('install');
    expect(cmdArgument('@inventarch/cli@3.6.0')).toBe('@inventarch/cli@3.6.0');
    expect(cmdArgument('C:\\ws\\app')).toBe('C:\\ws\\app');
    expect(cmdArgument('C:\\w^s')).toBe('"C:\\w^s"');
    for (const value of ['a&b', 'a|b', 'a<b', 'a>b', 'a!b', 'a b', 'a(b)'])
      expect(cmdArgument(value)).toBe(`"${value}"`);
    expect(cmdArgument('a%PATH%b')).toBeNull();
    // cmd.exe has no escape for a quote: any quote toggles its quoting for the rest of the line, so every one is refused.
    for (const value of ['a"b&c', 'a"b', '"', 'a\\"b', 'x"']) expect(cmdArgument(value)).toBeNull();
    // cmd.exe ends the command at a line break, so a control character could never pass unchanged.
    for (const value of ['a\nb', 'a\rb', 'a\tb', '\x1b']) expect(cmdArgument(value)).toBeNull();
    const args = ['--cwd', 'C:\\w^s', 'add', '-D', '@inventarch/cli@3.6.0'].map((value) => cmdArgument(value)!);
    expect(windowsShellArgs('C:\\Program Files\\nodejs\\yarn.cmd', args)).toEqual([
      '/d',
      '/v:off',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\yarn.cmd" --cwd "C:\\w^s" add -D @inventarch/cli@3.6.0"',
    ]);
  });
  it('a quoted cmd.exe argument reads back exactly through the Windows argv rules', () => {
    for (const value of ['C:\\w=s\\', 'C:\\w^s', 'a b\\', '\\server\\share\\', '', 'x\\\\', 'a&b\\', '!x!']) {
      const encoded = cmdArgument(value);
      expect([value, encoded]).not.toEqual([value, null]);
      const line = windowsShellArgs('C:\\tools\\npm.cmd', [encoded!, 'next'])[4]!.slice(1, -1);
      expect([value, commandLineToArgv(line).slice(1)]).toEqual([value, [value, 'next']]);
    }
  });
  it('a long run of backslashes is quoted in linear time and still reads back exactly', () => {
    // A run of backslashes that does not end the argument: a trailing-backslash regex retries it from every start.
    const run = '\\'.repeat(100_000);
    const started = performance.now();
    const encoded = cmdArgument(`${run} x`);
    expect(performance.now() - started).toBeLessThan(250);
    expect(encoded).toBe(`"${run} x"`);
    expect(cmdArgument(`a ${run}`)).toBe(`"a ${run}${run}"`);
  });
  it('no accepted argument list leaves a character cmd.exe acts on outside its quotes', () => {
    // The re-review's probe: a quote in one argument used to leave a later argument's & live.
    expect(['a"b', 'a&echo REVIEW_SENTINEL'].map(cmdArgument)).toContain(null);
    const pieces = ['a', ' ', '&', '|', '<', '>', '^', '(', ')', '!', '\\', '"', '%', '=', ';', ',', '\n'];
    const values = new Set<string>();
    for (const a of pieces) for (const b of pieces) values.add(a + b);
    const accepted = [...values].map(cmdArgument).filter((value): value is string => value !== null);
    expect(accepted.length).toBeGreaterThan(100);
    for (const first of accepted)
      for (const second of accepted) {
        // /s strips the outer quotes; what is left is the line cmd.exe parses.
        const line = windowsShellArgs('C:\\tools\\npm.cmd', [first, second])[4]!.slice(1, -1);
        if (liveCharacters(line).length > 0) expect([first, second, liveCharacters(line)]).toEqual([first, second, []]);
      }
  });
  it('an input offer prompts first, and a cancel runs nothing', async () => {
    const run = harness();
    const add = offersFor(state({ checks: [kitsInfo] })).find((entry) => entry.id === 'add-kit')!;
    const result = await runOffer(add, state(), run.io);
    expect(result).toEqual({ completed: 0, exitCode: null });
    expect(run.events).toEqual([]);
  });
  it('a step whose program cannot start stops the recipe as a failed step, and the console goes on', async () => {
    const run = harness({
      onSpawn: () => {
        throw Object.assign(new Error('spawn /srv/bin/npm ENOENT'), { code: 'ENOENT' });
      },
    });
    const result = await runOffer(
      offer([iaFix(['validate'], 'none').fix!, iaFix(['validate'], 'none').fix!]),
      state(),
      run.io,
    );
    expect(result).toEqual({ completed: 0, exitCode: null });
    expect(run.spawned).toHaveLength(1);
    expect(run.printed).toContain('Stopped at step 1: could not start: spawn /srv/bin/npm ENOENT.');
    expect(run.events.slice(-3)).toEqual(['waitKey', 'enter', 'invalidate']);
  });
});

describe('resolveRepo', () => {
  /** A workspace at `member` pinning the CLI, with a copy installed in `root`'s `node_modules`; its real path. */
  const pinnedAt = (root: string, member = root): string => {
    mkdirSync(join(member, '.ia/src'), { recursive: true });
    writeFileSync(join(member, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.6.0' } }));
    const copy = join(root, 'node_modules/@inventarch/cli');
    mkdirSync(join(copy, 'dist'), { recursive: true });
    writeFileSync(
      join(copy, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.6.0', bin: { ia: './dist/main.js' } }),
    );
    writeFileSync(join(copy, 'dist/main.js'), '');
    return realpathSync(copy);
  };
  it('an ordinary installed copy is the one steps run on', () => {
    const root = scratch('console-resolve-installed');
    const copy = pinnedAt(root);
    expect(resolveRepo(root, {}, RUNNING)?.packageRoot).toBe(copy);
  });
  it('a committed copy, or any other copy under IA_NO_HANDOFF=1, is not: steps run on the running copy', () => {
    const committedRoot = scratch('console-resolve-committed');
    pinnedAt(committedRoot);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: committedRoot, encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    expect(git('add', '-f', 'node_modules/@inventarch/cli/package.json').status).toBe(0);
    expect(resolveRepo(committedRoot, {}, RUNNING)).toBeNull();
    const off = scratch('console-resolve-no-handoff');
    pinnedAt(off);
    expect(resolveRepo(off, { IA_NO_HANDOFF: '1' }, RUNNING)).toBeNull();
  });
  it('a copy hoisted to the workspaces root is found, as hand-off finds it', () => {
    const repo = scratch('console-resolve-hoisted');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const member = join(repo, 'packages/app');
    const copy = pinnedAt(repo, member);
    expect(resolveRepo(member, {}, RUNNING)?.packageRoot).toBe(copy);
  });
});
/** The characters cmd.exe acts on (&, |, <, >, ^, parentheses) that its own quote state leaves outside quotes. */
function liveCharacters(line: string): string[] {
  const live: string[] = [];
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && /[&|<>^()]/.test(character)) live.push(character);
  }
  return live;
}
/** The Windows argv split (CommandLineToArgvW and the C runtime): what a program receives from the line cmd.exe hands it. */
function commandLineToArgv(line: string): string[] {
  const args: string[] = [];
  let at = 0;
  while (at < line.length) {
    while (line[at] === ' ' || line[at] === '\t') at += 1;
    if (at >= line.length) break;
    let arg = '',
      quoted = false;
    while (at < line.length) {
      const character = line[at]!;
      if (character === '\\') {
        let slashes = 0;
        while (line[at] === '\\') {
          slashes += 1;
          at += 1;
        }
        if (line[at] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) {
            arg += '"';
            at += 1;
          }
        } else arg += '\\'.repeat(slashes);
        continue;
      }
      if (character === '"') {
        if (quoted && line[at + 1] === '"') {
          arg += '"';
          at += 2;
          continue;
        }
        quoted = !quoted;
        at += 1;
        continue;
      }
      if (!quoted && (character === ' ' || character === '\t')) break;
      arg += character;
      at += 1;
    }
    args.push(arg);
  }
  return args;
}
const kitsInfo: ConsoleCheck = {
  id: 'kits',
  section: 'Environment',
  title: 'Kits',
  status: 'info',
  detail: 'no kits installed',
  remedy: null,
  fix: null,
  from: 'in-process',
  reported: true,
};

/** A recording terminal of a fixed size. */
class FakeTerminal implements TerminalIO {
  out = '';
  /** What a synchronous write (the `exit` path) put out. */
  synced = '';
  raw: boolean[] = [];
  listeners: (() => void)[] = [];
  errors: ((error: Error) => void)[] = [];
  write(data: string): void {
    this.out += data;
  }
  writeSync(data: string): void {
    this.synced += data;
  }
  onError(listener: (error: Error) => void): () => void {
    this.errors.push(listener);
    return () => {
      this.errors = this.errors.filter((entry) => entry !== listener);
    };
  }
  columns(): number {
    return 100;
  }
  rows(): number {
    return 30;
  }
  setRawMode(on: boolean): void {
    this.raw.push(on);
  }
  onResize(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
}
const check = (id: string, status: CheckStatus, extra: Partial<Check> = {}): Check => ({
  id,
  section: 'Environment',
  title: id,
  status,
  detail: `${id} detail`,
  remedy: null,
  fix: null,
  ...extra,
});
const view = (checks: readonly Check[]): DoctorView => ({
  checks,
  counts: { ok: 0, warn: 0, fail: 0, unknown: 0, info: 0 },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(condition: () => boolean, what: string, attempts = 400): Promise<void> {
  for (let tries = 0; tries < attempts; tries += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}
interface Hooks extends ProcessHooks {
  listeners: Map<string, (error?: unknown) => void>;
  exits: number[];
  /** What the terminal had received synchronously when each exit was called. */
  syncedAtExit: string[];
}
const fakeHooks = (terminal: FakeTerminal): Hooks => {
  const listeners = new Map<string, (error?: unknown) => void>();
  const exits: number[] = [];
  const syncedAtExit: string[] = [];
  return {
    listeners,
    exits,
    syncedAtExit,
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    exit: (code) => {
      exits.push(code);
      syncedAtExit.push(terminal.synced);
    },
  };
};
function launch(
  extra: {
    collect?: (request: DoctorRequest) => DoctorView;
    spawn?: RunIO['spawn'];
    spawnDoctor?: SpawnDoctor;
    prepare?: (root: string) => void;
  } = {},
) {
  const root = scratch('console-app');
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  extra.prepare?.(root);
  const terminal = new FakeTerminal();
  const stdin = new PassThrough();
  const timers: (() => void)[] = [];
  const hooks = fakeHooks(terminal);
  const spawned: string[][] = [];
  const exit = runConsole({
    io: terminal,
    input: stdin,
    env: { IA_HOME: join(root, 'home'), NO_COLOR: '1' },
    cwd: root,
    packageRoot: RUNNING,
    version: '3.5.1',
    collect: extra.collect ?? (() => view([check('node', 'ok'), check('kits', 'info'), check('root', 'ok')])),
    spawn:
      extra.spawn ??
      (async (_file, args) => {
        spawned.push([...args]);
        return 0;
      }),
    setTimer: ((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    hooks,
    ...(extra.spawnDoctor === undefined ? {} : { spawnDoctor: extra.spawnDoctor }),
  });
  // Restored by an ordinary write, or synchronously on the paths that exit right after.
  const restored = (): boolean =>
    (terminal.out + terminal.synced).includes('\x1b[?25h\x1b[?1049l') && terminal.raw.at(-1) === false;
  return {
    root,
    terminal,
    stdin,
    timers,
    hooks,
    spawned,
    exit,
    restored,
    entered: () => terminal.out.includes('\x1b[?1049h'),
  };
}

describe('runConsole', () => {
  it('q restores the terminal and exits 0', async () => {
    const run = launch();
    await until(run.entered, 'the console');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    expect(run.restored()).toBe(true);
    expect(run.hooks.listeners.size).toBe(0);
  });
  it('q during a reload aborts the reload’s doctor run, so the process does not wait it out', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const run = launch({
      // The workspace's own copy, so each load runs its doctor.
      prepare: (root) => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.6.0' } }));
        const copy = join(root, 'node_modules/@inventarch/cli');
        mkdirSync(join(copy, 'dist'), { recursive: true });
        writeFileSync(
          join(copy, 'package.json'),
          JSON.stringify({ name: '@inventarch/cli', version: '3.6.0', bin: { ia: './dist/main.js' } }),
        );
        writeFileSync(join(copy, 'dist/main.js'), '');
      },
      spawnDoctor: (_entry, _root, signal) => {
        signals.push(signal);
        const answer = { status: 0, stdout: JSON.stringify({ version: 1, checks: [], counts: {} }) };
        // The first load answers at once; the reload's doctor ends only when it is aborted.
        if (signals.length === 1) return Promise.resolve(answer);
        return new Promise((settle) => signal?.addEventListener('abort', () => settle({ status: null, stdout: '' })));
      },
    });
    await until(run.entered, 'the console');
    run.stdin.write('r');
    await until(() => signals.length === 2, 'the reload');
    expect(signals[1]?.aborted).toBe(false);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    expect(signals[1]?.aborted).toBe(true);
    expect(run.restored()).toBe(true);
  });
  /** A workspace pinning the CLI with its own copy installed, so each load asks whether that copy is committed. */
  const withCopy = (root: string): void => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.6.0' } }));
    const copy = join(root, 'node_modules/@inventarch/cli');
    mkdirSync(join(copy, 'dist'), { recursive: true });
    writeFileSync(
      join(copy, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.6.0', bin: { ia: './dist/main.js' } }),
    );
    writeFileSync(join(copy, 'dist/main.js'), '');
  };
  it.skipIf(process.platform === 'win32')(
    'asks git whether the workspace copy is committed once for the console’s life, not at each load or doctor row',
    async () => {
      // A git that logs each call's arguments and tracks nothing, first on the PATH of the process the console asks from.
      const bin = scratch('console-git-shim');
      const log = join(bin, 'calls.log');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const path = process.env['PATH'];
      process.env['PATH'] = `${bin}${delimiter}${path ?? ''}`;
      try {
        let loads = 0;
        // The copy's rows hold one fix, so a step runs on the copy (`repoOf`).
        const report = {
          status: 0,
          stdout: JSON.stringify({
            version: 1,
            checks: [check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'ia validate' })],
            counts: {},
          }),
        };
        const run = launch({
          // Tracked too, so the all-workspaces table (`loadAll`) reads the same copy.
          prepare: (root) => {
            withCopy(root);
            mkdirSync(join(root, 'home'), { recursive: true });
            trackWorkspaces(join(root, 'home'), [root]);
          },
          // The real collector: its `cli-version` row asks about the same copy, so it must use the same memo.
          collect: collectDoctor,
          spawnDoctor: () => {
            loads += 1;
            return Promise.resolve(report);
          },
        });
        await until(run.entered, 'the console');
        for (const wanted of [2, 3]) {
          run.stdin.write('r');
          await until(() => loads === wanted, `load ${wanted}`);
        }
        await until(() => run.terminal.out.includes('Fix record errors'), 'the offer');
        run.stdin.write('\r');
        await until(() => run.terminal.out.includes('Press any key to return to the console.'), 'the step to finish');
        expect(run.spawned).toHaveLength(1);
        run.stdin.write('x');
        await until(() => loads >= 4, 'the reload after the step');
        const before = loads;
        run.stdin.write('\t');
        await until(() => loads > before, 'the table row');
        await until(() => run.terminal.out.includes('Attention 1'), 'the table row to land');
        run.stdin.write('q');
        expect(await run.exit).toBe(0);
        // Only the question about the copy; the lockfile question (`ls-files -- <lockfiles>`) is another one.
        const asked = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line.endsWith('/node_modules/@inventarch/cli ls-files -- .'));
        expect(asked).toHaveLength(1);
      } finally {
        if (path === undefined) delete process.env['PATH'];
        else process.env['PATH'] = path;
      }
    },
  );
  it('a quit during the first load aborts it, never enters the screen, and exits 0', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const run = launch({
      prepare: withCopy,
      // The first load's doctor ends only when it is aborted.
      spawnDoctor: (_entry, _root, signal) => {
        signals.push(signal);
        return new Promise((settle) => signal?.addEventListener('abort', () => settle({ status: null, stdout: '' })));
      },
    });
    await until(() => signals.length === 1, 'the first load');
    expect(run.entered()).toBe(false);
    expect(signals[0]?.aborted).toBe(false);
    // The process ending, as `q` ends it (the console has no keys to read before its first screen).
    run.hooks.listeners.get('exit')!();
    expect(await run.exit).toBe(0);
    expect(signals[0]?.aborted).toBe(true);
    await settle();
    expect(run.entered()).toBe(false);
    expect(run.terminal.raw).not.toContain(true);
    expect(run.hooks.listeners.size).toBe(0);
  });
  it('a throw inside the loop restores the terminal and exits 1', async () => {
    let loads = 0;
    const run = launch({
      collect: () => {
        loads += 1;
        if (loads > 1) throw new Error('doctor broke');
        return view([check('node', 'ok')]);
      },
    });
    await until(run.entered, 'the console');
    run.stdin.write('r');
    expect(await run.exit).toBe(1);
    expect(run.restored()).toBe(true);
    expect(run.terminal.out).toContain('doctor broke');
  });
  it('an uncaught exception or a signal restores the terminal', async () => {
    const crashed = launch();
    await until(crashed.entered, 'the console');
    crashed.hooks.listeners.get('uncaughtException')!(new Error('boom'));
    expect(await crashed.exit).toBe(1);
    expect(crashed.hooks.exits).toEqual([1]);
    expect(crashed.restored()).toBe(true);
    const signalled = launch();
    await until(signalled.entered, 'the console');
    signalled.hooks.listeners.get('SIGTERM')!();
    expect(await signalled.exit).toBe(143);
    expect(signalled.hooks.exits).toEqual([143]);
    expect(signalled.restored()).toBe(true);
  });
  it('exit and every console signal are handled while the console runs, and removed when it ends', async () => {
    const run = launch();
    await until(run.entered, 'the console');
    expect([...run.hooks.listeners.keys()].sort()).toEqual(
      ['exit', 'uncaughtException', 'unhandledRejection', ...consoleSignals(process.platform)].sort(),
    );
    expect(consoleSignals('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
    expect(consoleSignals('linux')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    expect(run.hooks.listeners.size).toBe(0);
  });
  it('SIGHUP restores the terminal and exits 129; a process exit restores it synchronously', async () => {
    const hung = launch();
    await until(hung.entered, 'the console');
    hung.hooks.listeners.get('SIGHUP')!();
    expect(await hung.exit).toBe(129);
    expect(hung.hooks.exits).toEqual([129]);
    expect(hung.restored()).toBe(true);
    // Written synchronously, before the exit: an ordinary write could still be queued when the process ends.
    expect(hung.hooks.syncedAtExit[0]).toContain('\x1b[?25h\x1b[?1049l');
    expect(hung.hooks.syncedAtExit[0]).toContain('\x1b[?2004l');
    const broken = launch();
    await until(broken.entered, 'the console');
    broken.hooks.listeners.get('uncaughtException')!(new Error('boom'));
    expect(await broken.exit).toBe(1);
    expect(broken.hooks.syncedAtExit[0]).toContain('\x1b[?1049l');
    const exiting = launch();
    await until(exiting.entered, 'the console');
    exiting.hooks.listeners.get('exit')!(0);
    expect(exiting.terminal.synced).toContain('\x1b[?2004l');
    expect(exiting.terminal.synced).toContain('\x1b[?25h\x1b[?1049l');
    expect(exiting.terminal.raw.at(-1)).toBe(false);
    expect(await exiting.exit).toBe(0);
    expect(exiting.hooks.listeners.size).toBe(0);
  });
  it('a failing stdout ends the console through its teardown', async () => {
    const run = launch();
    await until(run.entered, 'the console');
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    for (const listener of run.terminal.errors) listener(error);
    expect(await run.exit).toBe(1);
    // The failed stream is not trusted with the restoration: it goes out synchronously, through what survives.
    expect(run.terminal.synced).toContain('\x1b[?25h\x1b[?1049l');
    expect(run.terminal.raw.at(-1)).toBe(false);
    expect(run.stdin.listenerCount('data')).toBe(0);
    expect(run.stdin.destroyed).toBe(false);
    expect(run.hooks.listeners.size).toBe(0);
    expect(run.terminal.errors).toHaveLength(0);
  });
  it('Ctrl-C at a confirmation declines it and returns to the console; while a child runs it is the child’s', async () => {
    let release: (code: number) => void = () => {};
    let children = 0;
    const run = launch({
      collect: () =>
        view([
          check('root', 'ok'),
          check('install-lock', 'warn', { fix: iaFix(['recover'], 'repo', '/srv/ws').fix, remedy: 'ia recover' }),
          check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'ia validate' }),
        ]),
      spawn: () => {
        children += 1;
        return new Promise((settle) => {
          release = settle;
        });
      },
    });
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    // The second offer confirms before it runs.
    run.stdin.write('j');
    await until(() => run.terminal.out.includes('› ▲ Resume interrupted install'), 'the selection');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('[y/N]'), 'the confirmation');
    run.hooks.listeners.get('SIGINT')!();
    await until(() => run.terminal.out.includes('Press any key'), 'the declined run');
    expect(children).toBe(0);
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('x');
    await until(() => run.terminal.raw.at(-1) === true && run.terminal.out.endsWith('quit\x1b[?2026l'), 'the console');
    // An immediate step: SIGINT while its child runs does not end the console.
    run.stdin.write('k');
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the selection back');
    run.stdin.write('\r');
    await until(() => children === 1, 'the child');
    run.hooks.listeners.get('SIGINT')!();
    run.hooks.listeners.get('SIGTERM')!();
    expect(run.hooks.exits).toEqual([]);
    release(0);
    await until(() => run.terminal.out.includes('Press any key'), 'the step to finish');
    run.stdin.write('x');
    await until(() => run.terminal.raw.at(-1) === true, 'the console again');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('the parent lets go of stdin before a child starts', async () => {
    const seen: { listeners: number; paused: boolean; raw: boolean | undefined }[] = [];
    const run = launch({
      collect: () =>
        view([check('root', 'ok'), check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'x' })]),
      spawn: async () => {
        seen.push({ listeners: stdin().listenerCount('data'), paused: stdin().isPaused(), raw: terminal().raw.at(-1) });
        return 0;
      },
    });
    const stdin = () => run.stdin;
    const terminal = () => run.terminal;
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('Press any key'), 'the step');
    expect(seen).toEqual([{ listeners: 0, paused: true, raw: false }]);
    const mark = run.terminal.out.length;
    run.stdin.write('x');
    await until(() => run.terminal.out.slice(mark).includes('\x1b[?1049h'), 'the console');
    expect(run.stdin.listenerCount('data')).toBe(1);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('a resize while the normal screen shows draws nothing; the return repaints', async () => {
    let release: (code: number) => void = () => {};
    const run = launch({
      collect: () =>
        view([check('root', 'ok'), check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'x' })]),
      spawn: () =>
        new Promise((settle) => {
          release = settle;
        }),
    });
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('$ ia validate'), 'the child');
    const mark = run.terminal.out.length;
    for (const listener of run.terminal.listeners) listener();
    await settle();
    expect(run.terminal.out.slice(mark)).not.toContain('\x1b[?2026h');
    release(0);
    await until(() => run.terminal.out.includes('Press any key'), 'the step to finish');
    run.stdin.write('x');
    await until(() => run.terminal.out.slice(mark).includes('\x1b[2J'), 'the repaint');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('keys decoded in one read never start two runs, and a quit in the same read ends it', async () => {
    const twice = launch({
      collect: () =>
        view([check('root', 'ok'), check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'x' })]),
    });
    await until(() => twice.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    twice.stdin.write('\r\r');
    await until(() => twice.terminal.out.includes('Press any key'), 'the step');
    await settle();
    expect(twice.spawned).toHaveLength(1);
    twice.stdin.write('x');
    await until(() => twice.terminal.raw.at(-1) === true, 'the console');
    await settle();
    expect(twice.spawned).toHaveLength(1);
    twice.stdin.write('q');
    expect(await twice.exit).toBe(0);
    const quit = launch({
      collect: () =>
        view([check('root', 'ok'), check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'x' })]),
    });
    await until(() => quit.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    quit.stdin.write('q\r');
    expect(await quit.exit).toBe(0);
    await settle();
    expect(quit.spawned).toEqual([]);
    expect(quit.restored()).toBe(true);
  });
  it('a bracketed paste of q and enter is ignored outside text entry', async () => {
    const run = launch({
      collect: () =>
        view([check('root', 'ok'), check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'x' })]),
    });
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    expect(run.terminal.out).toContain('\x1b[?2004h');
    run.stdin.write('\x1b[200~q\r\x1b[201~');
    await settle();
    await settle();
    expect(run.spawned).toEqual([]);
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    expect(run.terminal.out).toContain('\x1b[?2004l');
  });
  it('an escape key split across chunks does not quit, and a lone Escape does after the timer', async () => {
    const run = launch();
    await until(run.entered, 'the console');
    await until(() => run.terminal.out.includes('› ○ Add a kit'), 'the first frame');
    run.stdin.write('\x1b');
    await until(() => run.timers.length === 1, 'the escape timer');
    run.stdin.write('[B');
    await until(() => run.terminal.out.includes('› ○ Track this workspace'), 'the selection to move');
    run.stdin.write('\x1b');
    await until(() => run.timers.length === 2, 'the second escape timer');
    run.timers[1]!();
    expect(await run.exit).toBe(0);
    expect(run.restored()).toBe(true);
  });
  it('add a kit: the prompt runs in text mode, j and q are typed, an invalid value is refused on the line, Esc cancels with nothing spawned', async () => {
    let loads = 0;
    const run = launch({
      collect: () => {
        loads += 1;
        return view([check('node', 'ok'), check('kits', 'info'), check('root', 'ok')]);
      },
    });
    await until(() => run.terminal.out.includes('› ○ Add a kit'), 'the first frame');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('Kit id: ▌'), 'the prompt');
    run.stdin.write('jq');
    await until(() => run.terminal.out.includes('Kit id: jq▌'), 'the typed text');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('Enter a kit id as scope/name'), 'the refusal');
    run.stdin.write('\x7f\x7f-x\r');
    await until(() => run.terminal.out.includes('A kit id cannot start with a dash.'), 'the dash refusal');
    run.stdin.write('\x1b');
    await until(() => run.timers.length > 0, 'the escape timer');
    run.timers.at(-1)!();
    // The cancelled run ends with a reload; keys typed before it ends are not navigation.
    await until(() => loads === 2, 'the reload after the cancelled run');
    await settle();
    expect(run.spawned).toEqual([]);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('after a step the console re-enters raw mode and repaints fully, whatever the child did to the terminal', async () => {
    const run = launch({
      collect: () =>
        view([
          check('root', 'ok'),
          check('records', 'fail', { fix: iaFix(['validate'], 'none').fix, remedy: 'ia validate' }),
        ]),
    });
    await until(() => run.terminal.out.includes('› ✖ Fix record errors'), 'the first frame');
    run.stdin.write('\r');
    await until(() => run.terminal.out.includes('Press any key to return to the console.'), 'the step to finish');
    // The step ran in the normal screen: raw mode off and the alternate screen left before it.
    const before = run.terminal.out.lastIndexOf('$ ia validate');
    expect(run.terminal.out.lastIndexOf('\x1b[?1049l', before)).toBeGreaterThan(-1);
    expect(run.terminal.raw.at(-1)).toBe(true);
    const mark = run.terminal.out.length;
    run.stdin.write('x');
    await until(() => run.terminal.out.slice(mark).includes('Fix record errors'), 'the repaint');
    const after = run.terminal.out.slice(mark);
    expect(after.startsWith('\x1b[?1049h\x1b[?25l')).toBe(true);
    expect(after).toContain('\x1b[2J');
    expect(run.terminal.raw.at(-1)).toBe(true);
    expect(run.spawned).toEqual([[runningEntry(RUNNING), 'validate']]);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
});

const unprivileged = process.platform === 'win32' || process.getuid?.() === 0;
/** The end of a long value, which the folder line always shows. */
const tail = (text: string): string => text.slice(-12);
/** The console started outside any workspace, with `tracked` workspaces in its IA home's tracked list. */
async function launchAll(
  tracked = 0,
  extra: {
    copies?: boolean;
    spawnDoctor?: SpawnDoctor;
    inside?: boolean;
    collect?: () => DoctorView;
    runner?: Runner;
    before?: (roots: string[]) => void;
  } = {},
) {
  const base = scratch('console-all');
  const cwd = join(base, 'outside'),
    home = join(base, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const roots = Array.from({ length: tracked }, (_, index) => join(base, `ws${index}`));
  for (const root of roots) {
    mkdirSync(join(root, '.ia/src'), { recursive: true });
    // Its own installed copy, so its rows come from that copy's doctor (the injected `spawnDoctor`).
    if (extra.copies !== true) continue;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
    const installed = join(root, 'node_modules/@inventarch/cli');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.5.0', bin: { ia: './dist/bin.js' } }),
    );
    writeFileSync(join(installed, 'dist/bin.js'), '');
  }
  if (roots.length > 0) await trackWorkspaces(home, roots);
  extra.before?.(roots);
  // `inside`: the console starts in the first tracked workspace, whose own view is then the home one.
  const start = extra.inside === true && roots[0] !== undefined ? roots[0] : cwd;
  const terminal = new FakeTerminal();
  const stdin = new PassThrough();
  const timers: (() => void)[] = [];
  const hooks = fakeHooks(terminal);
  const exit = runConsole({
    io: terminal,
    input: stdin,
    env: { IA_HOME: home, NO_COLOR: '1' },
    cwd: start,
    packageRoot: RUNNING,
    version: '3.5.1',
    collect: extra.collect ?? (() => view([check('node', 'ok'), check('records', 'ok'), check('root', 'ok')])),
    spawn: async () => 0,
    setTimer: ((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    hooks,
    ...(extra.spawnDoctor === undefined ? {} : { spawnDoctor: extra.spawnDoctor }),
    ...(extra.runner === undefined ? {} : { runner: extra.runner }),
  });
  const shows = (text: string) => () => terminal.out.includes(text);
  return { base, cwd, home, roots, terminal, stdin, timers, hooks, exit, shows };
}

describe('opening a failed repository after a batch', () => {
  /** A batch whose repository is refused once its worktree exists, stopped at "Press any key", the reload held. */
  async function failedBatch() {
    let release: (run: { status: number; stdout: string }) => void = () => {};
    const reading = new Promise<{ status: number; stdout: string }>((settle) => {
      release = settle;
    });
    // git and the worktree are faked; the copy in it is what makes opening it run a doctor.
    const runner: Runner = async (_file, args) => {
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args.includes('add')) {
        const tree = args[args.indexOf('-b') + 2]!;
        const installed = join(tree, 'node_modules/@inventarch/cli');
        mkdirSync(join(tree, '.ia/src'), { recursive: true });
        mkdirSync(join(installed, 'dist'), { recursive: true });
        writeFileSync(join(tree, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
        writeFileSync(
          join(installed, 'package.json'),
          JSON.stringify({ name: '@inventarch/cli', version: '3.5.0', bin: { ia: './dist/bin.js' } }),
        );
        writeFileSync(join(installed, 'dist/bin.js'), '');
        return ok();
      }
      if (args.some((arg) => arg.startsWith('refs/heads/'))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('symbolic-ref')) return ok('refs/remotes/origin/main\n');
      return ok('abc123\n');
    };
    const fix = iaFix(['restore', '--apply'], 'repo').fix!;
    const run = await launchAll(1, {
      runner,
      collect: () => view([check('records', 'fail', { fix }), check('root', 'ok')]),
      spawnDoctor: () => reading,
      before: (roots) => {
        spawnSync('git', ['init', '--quiet'], { cwd: roots[0]! });
      },
    });
    await until(run.shows('ws0'), 'the row to load');
    run.stdin.write(' ');
    run.stdin.write('b');
    await until(run.shows('BATCH'), 'the batch list');
    run.stdin.write('\r');
    await until(run.shows('WOULD'), 'the preview');
    run.stdin.write('\r');
    await until(run.shows('Run this batch?'), 'the confirmation');
    run.stdin.write('y\n');
    await until(run.shows('Open a failed repo'), 'the next list');
    run.stdin.write('1\n');
    await until(run.shows('Press any key'), 'the wait');
    const mark = run.terminal.out.length;
    run.stdin.write('x');
    await until(() => run.terminal.out.slice(mark).includes('Reading'), 'the note that it is being read');
    return { run, mark, release };
  }
  it.skipIf(process.platform === 'win32')(
    'no key reaches another workspace’s offers while it reads; its own view follows',
    async () => {
      const { run, mark, release } = await failedBatch();
      // Help, then enter: on the console's own state these would draw its view and run its first offer.
      run.stdin.write('?');
      run.stdin.write('\r');
      await settle();
      expect(run.terminal.out.slice(mark)).not.toContain('KEYS');
      release({ status: 0, stdout: JSON.stringify({ version: 1, checks: [], counts: {} }) });
      await until(() => run.terminal.out.slice(mark).includes('esc back'), 'the opened workspace');
      run.stdin.write('\x03');
      expect(await run.exit).toBe(0);
    },
  );
  it.skipIf(process.platform === 'win32')('q still quits while it reads', async () => {
    const { run } = await failedBatch();
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
});

describe('the all-workspaces view', () => {
  it('outside a workspace lands on all workspaces', async () => {
    const run = await launchAll();
    await until(run.shows('Tracked 0'), 'the all-workspaces view');
    expect(run.terminal.out).toContain('› Find workspaces in a folder…');
    expect(run.terminal.out).toContain('No workspaces are tracked yet.');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('enter on a row opens its repo view and esc returns', async () => {
    const run = await launchAll(1);
    await until(run.shows('Healthy 1'), 'the row to load');
    run.stdin.write('\r');
    await until(run.shows('esc back'), 'the repo view');
    expect(run.terminal.out).toContain('Diagnostics');
    const mark = run.terminal.out.length;
    run.stdin.write('\x1b');
    await until(() => run.timers.length > 0, 'the escape timer');
    run.timers.at(-1)!();
    await until(() => run.terminal.out.slice(mark).includes('space select'), 'the table again');
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  // A real chmod: discovery walks up from a root it cannot read, so such a row must never open as another place.
  it.skipIf(unprivileged)('an unreadable row reads unreadable and does not open', async () => {
    const denied: string[] = [];
    try {
      const run = await launchAll(1, {
        before: (roots) => {
          chmodSync(roots[0]!, 0o000);
          denied.push(roots[0]!);
        },
      });
      await until(run.shows('Unreadable 1'), 'the row to be set aside');
      expect(run.terminal.out).toContain('Healthy 0');
      run.stdin.write('\r');
      await until(run.shows('ws0 is unreadable.'), 'the refusal to open it');
      expect(run.terminal.out).not.toContain('esc back');
      run.stdin.write('q');
      expect(await run.exit).toBe(0);
    } finally {
      for (const path of denied) chmodSync(path, 0o755);
    }
  });
  it.skipIf(unprivileged)(
    'an opened workspace whose root turns unreadable goes back to the table on refresh',
    async () => {
      const denied: string[] = [];
      try {
        const run = await launchAll(1);
        await until(run.shows('Healthy 1'), 'the row to load');
        run.stdin.write('\r');
        await until(run.shows('esc back'), 'the repo view');
        chmodSync(run.roots[0]!, 0o000);
        denied.push(run.roots[0]!);
        const mark = run.terminal.out.length;
        run.stdin.write('r');
        await until(() => run.terminal.out.slice(mark).includes('ws0 is unreadable.'), 'the table');
        expect(run.terminal.out.slice(mark)).toContain('space select');
        expect(run.terminal.out.slice(mark)).toContain('Unreadable 1');
        run.stdin.write('q');
        expect(await run.exit).toBe(0);
      } finally {
        for (const path of denied) chmodSync(path, 0o755);
      }
    },
  );
  it('f opens the folder line in text mode: b, q and j are typed, not commands', async () => {
    const run = await launchAll(1);
    await until(run.shows('Healthy 1'), 'the row to load');
    run.stdin.write('f');
    await until(run.shows(`${tail(run.base)}▌`), 'the folder line');
    run.stdin.write('bqj');
    await until(run.shows(`${tail(run.base)}bqj▌`), 'the typed text');
    expect(run.hooks.exits).toEqual([]);
    // Nothing was selected, and the cursor did not move to the batch list.
    expect(run.terminal.out).not.toContain('[x]');
    run.stdin.write('\x03');
    await until(run.shows('space select'), 'the key bar');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('an arrow key split across chunks inside the folder line is not Escape', async () => {
    const run = await launchAll();
    await until(run.shows('Tracked 0'), 'the view');
    run.stdin.write('f');
    await until(run.shows('Folder: '), 'the folder line');
    run.stdin.write('\x1b');
    await until(() => run.timers.length > 0, 'the escape timer');
    run.stdin.write('[A');
    await settle();
    run.stdin.write('x');
    await until(run.shows(`${tail(run.base)}x▌`), 'the line still open');
    run.stdin.write('\x03');
    await until(run.shows('space select'), 'the key bar');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('a lone Esc cancels the folder line after the timer', async () => {
    const run = await launchAll();
    await until(run.shows('Tracked 0'), 'the view');
    run.stdin.write('f');
    await until(run.shows('Folder: '), 'the folder line');
    run.stdin.write('x');
    await until(run.shows(`${tail(run.base)}x▌`), 'the typed text');
    const mark = run.terminal.out.length;
    run.stdin.write('\x1b');
    await until(() => run.timers.length > 0, 'the escape timer');
    run.timers.at(-1)!();
    await until(() => run.terminal.out.slice(mark).includes('space select'), 'the key bar');
    expect(readTracked(run.home)).toEqual([]);
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('paste and backspace edit the line; enter submits', async () => {
    const run = await launchAll(1);
    mkdirSync(join(run.base, 'fresh', '.ia/src'), { recursive: true });
    await until(run.shows('Healthy 1'), 'the row to load');
    run.stdin.write('f');
    await until(run.shows('Folder: '), 'the folder line');
    run.stdin.write('\x1b[200~zz\x1b[201~');
    await until(run.shows(`${tail(run.base)}zz▌`), 'the pasted text');
    run.stdin.write('\x7f\x7f');
    await until(
      () => run.terminal.out.lastIndexOf(`${tail(run.base)}▌`) > run.terminal.out.lastIndexOf('zz▌'),
      'the backspaces',
    );
    run.stdin.write('\r');
    await until(run.shows('FOUND IN'), 'the found list');
    expect(run.terminal.out).toContain('[=]');
    expect(run.terminal.out).toContain('[x]');
    run.stdin.write('\r');
    await until(run.shows('Tracked 1 workspace.'), 'the tracking');
    expect(
      readTracked(run.home)
        .map((row) => row.root)
        .sort(),
    ).toEqual([join(run.base, 'fresh'), run.roots[0]!].map((root) => realpathSync(root)).sort());
    await until(run.shows('Tracked 2'), 'the reloaded list');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it("a tracking that waits on a live owner's lock drops other keys, and q ends the wait, leaving that lock as it was", async () => {
    const run = await launchAll(1);
    mkdirSync(join(run.base, 'fresh', '.ia/src'), { recursive: true });
    await until(run.shows('Healthy 1'), 'the row to load');
    // Another owner on this host, still running (this process), holds the store lock for as long as the test needs.
    const lock = join(run.home, TRACKED_LOCK_FILE);
    writeFileSync(
      lock,
      JSON.stringify({
        token: 'planted',
        start: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        host: hostname(),
        pid: process.pid,
      }),
    );
    const before = readFileSync(lock),
      tracked = readTracked(run.home);
    run.stdin.write('f');
    await until(run.shows('Folder: '), 'the folder line');
    run.stdin.write('\r');
    await until(run.shows('FOUND IN'), 'the found list');
    const mark = run.terminal.out.length;
    // Enter starts the tracking, which waits on the lock; the `f` after it would open the folder line again.
    run.stdin.write('\r');
    run.stdin.write('f');
    await new Promise((settled) => setTimeout(settled, 150));
    expect(run.terminal.out.slice(mark)).not.toContain('Folder: ');
    expect(run.hooks.exits).toEqual([]);
    const quit = Date.now();
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    expect(Date.now() - quit).toBeLessThan(2_000);
    expect(readFileSync(lock)).toEqual(before);
    // The wait was stopped, not left running: once the lock goes, nothing takes it and the list is unchanged.
    rmSync(lock);
    await new Promise((settled) => setTimeout(settled, 200));
    expect(existsSync(lock)).toBe(false);
    expect(readTracked(run.home)).toEqual(tracked);
  });
  it('b focuses the batch list only in keys mode', async () => {
    const run = await launchAll(1);
    await until(run.shows('Healthy 1'), 'the row to load');
    expect(run.terminal.out).toContain('› [ ]');
    run.stdin.write('b');
    await until(run.shows('FIND WORKSPACES'), 'the batch list');
    expect(run.terminal.out).toContain('› Find workspaces in a folder…');
    run.stdin.write('f');
    await until(run.shows('Folder: '), 'the folder line');
    run.stdin.write('b');
    await until(run.shows(`${tail(run.base)}b▌`), 'b typed');
    run.stdin.write('\x03');
    await until(run.shows('space select'), 'the key bar');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
});

/** A copy's doctor report whose `records` row says `marker`, which the repo view shows in its Records area. */
const markedReport = (marker: string) => ({
  status: 0,
  stdout: JSON.stringify({
    version: 1,
    checks: [
      { id: 'cli-version', title: 'cli', status: 'ok', detail: 'copy', remedy: null, fix: null },
      { id: 'records', title: 'records', status: 'warn', detail: marker, remedy: null, fix: null },
    ],
    counts: {},
  }),
});
const escapeKey = async (run: Awaited<ReturnType<typeof launchAll>>): Promise<void> => {
  const timers = run.timers.length;
  run.stdin.write('\x1b');
  await until(() => run.timers.length > timers, 'the escape timer');
  run.timers.at(-1)!();
};

describe('refreshing a workspace opened from the table', () => {
  /** Doctor runs answer at once until `hold` is set; then each waits for its `settle`. */
  function held() {
    const pending: { root: string; settle: (run: ReturnType<typeof markedReport>) => void }[] = [];
    const state = { hold: false };
    const spawnDoctor: SpawnDoctor = (_entry, root) =>
      state.hold
        ? new Promise((settle) => pending.push({ root, settle }))
        : Promise.resolve(markedReport(`fresh ${root.slice(-3)}`));
    return { pending, state, spawnDoctor };
  }
  it("a refresh of an opened root that went missing runs no copy, not even the surrounding workspace's", async () => {
    const spawned: string[] = [];
    const spawnDoctor: SpawnDoctor = (_entry, root) => {
      spawned.push(root);
      return Promise.resolve(markedReport(`fresh ${root.slice(-3)}`));
    };
    const run = await launchAll(1, { copies: true, spawnDoctor });
    await until(run.shows('Attention 1'), 'the row');
    run.stdin.write('\r');
    await until(run.shows('esc back'), 'the repo view');
    // The folder around the root becomes a workspace with its own copy, which discovery would reach by walking up.
    mkdirSync(join(run.base, '.ia/src'), { recursive: true });
    writeFileSync(join(run.base, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
    const around = join(run.base, 'node_modules/@inventarch/cli');
    mkdirSync(join(around, 'dist'), { recursive: true });
    writeFileSync(
      join(around, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.5.0', bin: { ia: './dist/bin.js' } }),
    );
    writeFileSync(join(around, 'dist/bin.js'), '');
    rmSync(join(run.roots[0]!, '.ia'), { recursive: true });
    spawned.length = 0;
    const mark = run.terminal.out.length;
    run.stdin.write('r');
    await until(() => run.terminal.out.slice(mark).includes('ws0 is missing.'), 'the table');
    await settle();
    expect(spawned).toEqual([]);
    expect(run.terminal.out.slice(mark)).toContain('Missing 1');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('a refresh that finishes after Escape or q is discarded, and the console keeps running', async () => {
    const doctor = held();
    const run = await launchAll(2, { copies: true, spawnDoctor: doctor.spawnDoctor });
    await until(run.shows('Attention 2'), 'both rows');
    for (const leave of ['escape', 'q'] as const) {
      run.stdin.write('\r');
      await until(run.shows('esc back'), 'the repo view');
      doctor.state.hold = true;
      run.stdin.write('r');
      await until(() => doctor.pending.length === 1, 'the refresh');
      const mark = run.terminal.out.length;
      if (leave === 'escape') await escapeKey(run);
      else run.stdin.write('q');
      await until(() => run.terminal.out.slice(mark).includes('space select'), 'the table');
      doctor.pending.shift()!.settle(markedReport('STALE'));
      await settle();
      await settle();
      expect(run.hooks.exits).toEqual([]);
      expect(run.terminal.out.slice(mark)).not.toContain('STALE');
      doctor.state.hold = false;
    }
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('a refresh of one repo that finishes after another is opened never shows in it', async () => {
    const doctor = held();
    const run = await launchAll(2, { copies: true, spawnDoctor: doctor.spawnDoctor });
    await until(run.shows('Attention 2'), 'both rows');
    run.stdin.write('\r');
    await until(run.shows('esc back'), 'the first repo');
    doctor.state.hold = true;
    run.stdin.write('r');
    await until(() => doctor.pending.length === 1, 'the refresh');
    await escapeKey(run);
    await until(run.shows('space select'), 'the table');
    run.stdin.write('j');
    await settle();
    const mark = run.terminal.out.length;
    run.stdin.write('\r');
    await until(() => run.terminal.out.slice(mark).includes('esc back'), 'the second repo');
    expect(run.terminal.out.slice(mark)).toContain('fresh ws1');
    doctor.pending.shift()!.settle(markedReport('STALE ws0'));
    await settle();
    await settle();
    run.stdin.write('k');
    await settle();
    expect(run.terminal.out.slice(mark)).not.toContain('STALE ws0');
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('q');
    await until(() => run.terminal.out.slice(mark).includes('space select'), 'the table again');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('a home refresh that finishes after a workspace is opened from the table never shows in it', async () => {
    const doctor = held();
    const run = await launchAll(2, { copies: true, spawnDoctor: doctor.spawnDoctor, inside: true });
    await until(run.shows('fresh ws0'), 'the home view');
    run.stdin.write('\t');
    await until(run.shows('Attention 2'), 'both rows');
    run.stdin.write('\t');
    await settle();
    doctor.state.hold = true;
    run.stdin.write('r');
    await until(() => doctor.pending.length === 1, 'the home refresh');
    run.stdin.write('\t');
    await settle();
    run.stdin.write('j');
    await settle();
    const mark = run.terminal.out.length;
    run.stdin.write('\r');
    await until(() => run.terminal.out.slice(mark).includes('esc back'), 'the second repo');
    expect(run.terminal.out.slice(mark)).toContain('fresh ws1');
    doctor.pending.shift()!.settle(markedReport('STALE home'));
    await settle();
    await settle();
    run.stdin.write('j');
    await settle();
    expect(run.terminal.out.slice(mark)).not.toContain('STALE home');
    expect(run.hooks.exits).toEqual([]);
    run.stdin.write('q');
    await until(() => run.terminal.out.slice(mark).includes('space select'), 'the table again');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
  });
  it('refreshes share the four doctor slots with the background loads, and quit aborts every run', async () => {
    let active = 0,
      most = 0;
    const calls: { root: string; signal: AbortSignal | undefined }[] = [];
    const spawnDoctor: SpawnDoctor = (_entry, root, signal) => {
      calls.push({ root, signal });
      active += 1;
      most = Math.max(most, active);
      const done = (): void => {
        active -= 1;
      };
      // The first row answers soon; every other run holds its slot until it is aborted.
      if (root.endsWith('ws0'))
        return new Promise((answer) =>
          setTimeout(() => {
            done();
            answer(markedReport('first'));
          }, 20),
        );
      return new Promise((answer) => {
        signal?.addEventListener('abort', () => {
          done();
          answer({ status: null, stdout: '' });
        });
      });
    };
    const run = await launchAll(5, { copies: true, spawnDoctor });
    await until(() => calls.length === 5 && run.terminal.out.includes('first'), 'four held runs and the first row');
    run.stdin.write('\r');
    await until(run.shows('esc back'), 'the first repo');
    for (let times = 0; times < 3; times += 1) {
      run.stdin.write('r');
      await settle();
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(most).toBeLessThanOrEqual(4);
    const mark = run.terminal.out.length;
    run.stdin.write('q');
    await until(() => run.terminal.out.slice(mark).includes('space select'), 'the table');
    run.stdin.write('q');
    expect(await run.exit).toBe(0);
    await settle();
    // Every run still holding a slot was aborted by the quit, and no queued refresh started after it.
    expect(calls.filter((call) => !call.root.endsWith('ws0')).every((call) => call.signal?.aborted === true)).toBe(
      true,
    );
    expect(active).toBe(0);
    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.length).toBe(after);
    expect(most).toBeLessThanOrEqual(4);
  });
});

/** A doctor report whose one failing check carries a repo-writing fix, so its row offers a batchable fix. */
const batchableReport = {
  status: 0,
  stdout: JSON.stringify({
    version: 1,
    checks: [
      { id: 'cli-version', title: 'cli', status: 'ok', detail: 'copy', remedy: null, fix: null },
      {
        id: 'records',
        title: 'records',
        status: 'warn',
        detail: 'stale',
        remedy: null,
        fix: { program: 'ia', argv: ['restore', '--apply'], flow: 'preview-apply', writesTo: 'repo' },
      },
    ],
    counts: {},
  }),
};
/**
 * The console outside any workspace, with one tracked workspace in a real git repository (a bare origin, git on its PATH)
 * whose doctor offers a batchable fix, and a runner that holds its first call until `release()` and then runs every call
 * for real. `settleHook` runs, synchronously, the moment the runner's `finally` has cleared the console's wait on the
 * first call: no wait is open then, so only the batch's own controller can stop it.
 */
function launchBatch(extra: { settleHook?: () => void } = {}) {
  const fx = fixture('console-app-batch');
  const top = repo(fx, 'ws').top;
  const home = join(fx.dir, 'home');
  const cwd = join(fx.dir, 'outside');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(top, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
  const installed = join(top, 'node_modules/@inventarch/cli');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({ name: '@inventarch/cli', version: '3.5.0', bin: { ia: './dist/bin.js' } }),
  );
  writeFileSync(join(installed, 'dist/bin.js'), '');
  trackWorkspaces(home, [top]);
  const env = { ...fx.env, IA_HOME: home, NO_COLOR: '1' };
  const real = defaultRunner(env);
  const calls: { file: string; args: readonly string[] }[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((open) => {
    release = open;
  });
  const runner: Runner = (file, args, options) => {
    calls.push({ file, args: [...args] });
    const result = calls.length === 1 ? gate.then(() => real(file, args, options)) : real(file, args, options);
    const hook = extra.settleHook;
    if (calls.length !== 1 || hook === undefined) return result;
    const finallyOf = result.finally.bind(result);
    // The console clears its wait in `.finally`; the hook runs right after that callback.
    return Object.assign(result, {
      finally: (callback?: (() => void) | null) =>
        finallyOf(() => {
          callback?.();
          hook();
        }),
    });
  };
  const terminal = new FakeTerminal();
  const stdin = new PassThrough();
  const hooks = fakeHooks(terminal);
  const exit = runConsole({
    io: terminal,
    input: stdin,
    env,
    cwd,
    packageRoot: RUNNING,
    version: '3.5.1',
    collect: () => view([check('node', 'ok'), check('records', 'ok'), check('root', 'ok')]),
    spawn: async () => 0,
    runner,
    setTimer: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    hooks,
    spawnDoctor: () => Promise.resolve(batchableReport),
  });
  const shows = (text: string) => () => terminal.out.includes(text);
  const worktreeAdds = () => calls.filter((call) => call.args.includes('worktree') && call.args.includes('add'));
  return { terminal, stdin, hooks, exit, calls, release: () => release(), shows, worktreeAdds };
}
/** Selects the one row, picks the batch offer, confirms its preview and answers the confirmation until the runner is in. */
async function startBatch(run: ReturnType<typeof launchBatch>): Promise<void> {
  await until(run.shows('Attention 1'), 'the row to load', LONG);
  run.stdin.write(' ');
  await until(run.shows('[x]'), 'the row selected');
  run.stdin.write('b');
  await settle();
  run.stdin.write('\r');
  await until(run.shows(' WOULD'), 'the batch preview');
  run.stdin.write('\r');
  await until(run.shows('Run this batch? [y/N]'), 'the confirmation');
  run.stdin.write('y\r');
  await until(() => run.calls.length >= 1, 'the runner to be in the first command', LONG);
}

/** Real git repositories are made and queried here, which a loaded Windows machine does slowly. */
const BATCH_TIMEOUT = 120_000;
const LONG = 8000;
describe('the batch the console runs', () => {
  it(
    'Ctrl-C reaches the running batch: nothing further starts, and the console comes back',
    async () => {
      const run = launchBatch();
      await startBatch(run);
      // The terminal's signal, while a batch command runs: it stops the batch, not the console.
      run.hooks.listeners.get('SIGINT')!();
      run.release();
      await until(run.shows('Press any key to return to the console.'), 'the batch to end', LONG);
      expect(run.terminal.out).toContain('stopped: the batch was stopped');
      expect(run.worktreeAdds()).toEqual([]);
      expect(run.hooks.exits).toEqual([]);
      const mark = run.terminal.out.length;
      run.stdin.write(' ');
      await until(() => run.terminal.out.slice(mark).includes('space select'), 'the console to repaint', LONG);
      run.stdin.write('q');
      expect(await run.exit).toBe(0);
    },
    BATCH_TIMEOUT,
  );
  it(
    'quit aborts a batch that is running between two commands',
    async () => {
      const holder: { run?: ReturnType<typeof launchBatch> } = {};
      holder.run = launchBatch({ settleHook: () => holder.run!.hooks.listeners.get('SIGTERM')!() });
      const run = holder.run;
      await startBatch(run);
      run.release();
      expect(await run.exit).toBe(143);
      await until(run.shows('stopped: the batch was stopped'), 'the batch to see its signal', LONG);
      expect(run.worktreeAdds()).toEqual([]);
    },
    BATCH_TIMEOUT,
  );
});

describe('quit with a workspace refresh pending', () => {
  it('Ctrl-C in an opened workspace aborts its refresh in flight', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const spawnDoctor: SpawnDoctor = (_entry, _root, signal) => {
      signals.push(signal);
      // The table's read answers; the refresh holds its slot until it is aborted.
      if (signals.length === 1) return Promise.resolve(markedReport('first'));
      return new Promise((answer) => {
        signal?.addEventListener('abort', () => answer({ status: null, stdout: '' }));
      });
    };
    const run = await launchAll(1, { copies: true, spawnDoctor });
    await until(run.shows('first'), 'the row to load');
    run.stdin.write('\r');
    await until(run.shows('esc back'), 'the opened workspace');
    run.stdin.write('r');
    await until(() => signals.length === 2, 'the refresh to start');
    expect(signals[1]?.aborted).toBe(false);
    run.stdin.write('\x03');
    expect(await run.exit).toBe(0);
    expect(signals[1]?.aborted).toBe(true);
  });
});
