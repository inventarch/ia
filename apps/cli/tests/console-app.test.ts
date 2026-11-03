/**
 * Running offers and the console's loop (console/run.ts, console/app.ts), with a fake terminal, a scripted input stream
 * and a recording spawner: the argv each flow spawns, which copy's entry runs each step (resolved at that step, from
 * the disk), that a decline spawns nothing, and that the terminal is restored on quit, on a throw and on a signal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { Check, CheckStatus, DoctorView } from '../src/doctor.js';
import type { Fix } from '../src/fix.js';
import { iaFix } from '../src/fix.js';
import type { LocalCli } from '../src/local-cli.js';
import type { ProcessHooks } from '../src/console/app.js';
import { runConsole } from '../src/console/app.js';
import type { Offer, Step } from '../src/console/offers.js';
import { offersFor } from '../src/console/offers.js';
import type { RunIO, SpawnOptions } from '../src/console/run.js';
import { runOffer, runningEntry } from '../src/console/run.js';
import type { ConsoleCheck, ConsoleState } from '../src/console/state.js';
import type { TerminalIO } from '../src/console/terminal.js';
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
  it('an input offer prompts first, and a cancel runs nothing', async () => {
    const run = harness();
    const add = offersFor(state({ checks: [kitsInfo] })).find((entry) => entry.id === 'add-kit')!;
    const result = await runOffer(add, state(), run.io);
    expect(result).toEqual({ completed: 0, exitCode: null });
    expect(run.events).toEqual([]);
  });
});
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
  raw: boolean[] = [];
  listeners: (() => void)[] = [];
  write(data: string): void {
    this.out += data;
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
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}
interface Hooks extends ProcessHooks {
  listeners: Map<string, (error?: unknown) => void>;
  exits: number[];
}
const fakeHooks = (): Hooks => {
  const listeners = new Map<string, (error?: unknown) => void>();
  const exits: number[] = [];
  return {
    listeners,
    exits,
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    exit: (code) => exits.push(code),
  };
};
function launch(extra: { collect?: () => DoctorView; spawn?: RunIO['spawn'] } = {}) {
  const root = scratch('console-app');
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  const terminal = new FakeTerminal();
  const stdin = new PassThrough();
  const timers: (() => void)[] = [];
  const hooks = fakeHooks();
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
  });
  const restored = (): boolean => terminal.out.includes('\x1b[?25h\x1b[?1049l') && terminal.raw.at(-1) === false;
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
    expect(await signalled.exit).toBe(130);
    expect(signalled.hooks.exits).toEqual([130]);
    expect(signalled.restored()).toBe(true);
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
    const run = launch();
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
    await until(() => run.terminal.out.includes('enter run · tab diagnostics'), 'the key bar back');
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
