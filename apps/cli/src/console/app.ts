/**
 * The console's event loop: bare `ia` on an interactive terminal (consumer CLI contract §1.2). It loads the state, draws
 * the single-repo view, and feeds stdin through one key decoder, arming a short timer while a lone ESC could still
 * start a sequence. Enter runs the selected offer in the normal screen (run.ts) and reloads; `r` reloads; tab shows the
 * diagnostics; `?` the keys; `q`, Escape at the top level, or Ctrl-C quits with 0.
 *
 * One offer runs at a time. Once a run starts or the console begins to finish, the rest of an already-decoded read is
 * discarded, and no key navigates while an offer runs. stdin has one owner at a time: the console's decoder, a
 * confirmation line or a one-key wait; before a child starts the console pauses stdin and lets go of it, and takes it
 * back only for its own input.
 *
 * One teardown restores the terminal (console/terminal.ts) on quit, on a throw anywhere in the loop (exit 1, the error
 * printed in the normal screen), on an output failure such as a closed pipe (exit 1), on `uncaughtException` and
 * `unhandledRejection` (exit 1), and on `SIGINT`, `SIGTERM`, `SIGHUP` and, on Windows, `SIGBREAK` (exit 128 plus the
 * signal's number: 130, 143, 129, 149). A process `exit` restores it synchronously. These handlers exist only while the
 * console runs. A signal while a step's child runs is the child's to handle; Ctrl-C at the console's own confirmation
 * declines it.
 */
import { dirname } from 'node:path';
import type { Extension } from '../consumer.js';
import { consents } from '../consumer.js';
import type { DoctorRequest, DoctorView } from '../doctor.js';
import { collectDoctor } from '../doctor.js';
import type { LocalCli } from '../local-cli.js';
import { findLocalCli, readCliDependency } from '../local-cli.js';
import type { Env } from '../program.js';
import type { Capabilities } from '../render.js';
import { resolveCapabilities } from '../render.js';
import { sanitize } from './grid.js';
import type { Input } from './keys.js';
import { KeyDecoder } from './keys.js';
import type { Prompt, View } from './layout-repo.js';
import { geometry, layoutRepo, listScroll } from './layout-repo.js';
import type { SpawnDoctor } from './load.js';
import { loadState } from './load.js';
import type { Offer } from './offers.js';
import { offersFor } from './offers.js';
import type { Spawner } from './run.js';
import { runOffer, spawnInherited } from './run.js';
import type { ConsoleState } from './state.js';
import type { TerminalIO } from './terminal.js';
import { Screen } from './terminal.js';
import { graphemes } from './width.js';

export const ESCAPE_TIMEOUT_MS = 50;

export type ConsoleSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';
export type HookEvent = 'exit' | 'uncaughtException' | 'unhandledRejection' | ConsoleSignal;
/** The signals the console tears down on: Ctrl-Break (`SIGBREAK`) exists on Windows only. */
export const consoleSignals = (platform: NodeJS.Platform): readonly ConsoleSignal[] =>
  platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** 128 plus the signal's number, as a shell reports a process a signal ended. */
export const SIGNAL_EXIT: Readonly<Record<ConsoleSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGBREAK: 149,
};

/** The process events the console listens to while it runs; injected by tests. */
export interface ProcessHooks {
  on(event: HookEvent, listener: (value?: unknown) => void): void;
  off(event: HookEvent, listener: (value?: unknown) => void): void;
  exit(code: number): void;
  readonly platform?: NodeJS.Platform;
}
const PROCESS: ProcessHooks = {
  on: (event, listener) => process.on(event as NodeJS.Signals, listener),
  off: (event, listener) => process.off(event as NodeJS.Signals, listener),
  exit: (code) => process.exit(code),
  platform: process.platform,
};
/** The workspace's own copy as the disk has it now. */
export function resolveRepo(root: string): LocalCli | null {
  const dependency = readCliDependency(root);
  return dependency === null ? null : findLocalCli(root, dirname(dependency.manifest));
}

export async function runConsole(input: {
  readonly io: TerminalIO;
  readonly input: NodeJS.ReadableStream;
  readonly env: Env;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly version: string;
  readonly spawn?: Spawner;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  readonly extensions?: readonly Extension[];
  readonly collect?: (request: DoctorRequest) => DoctorView;
  readonly spawnDoctor?: SpawnDoctor;
  readonly resolveRepo?: (root: string) => LocalCli | null;
  readonly hooks?: ProcessHooks;
}): Promise<number> {
  const { io, env } = input;
  const hooks = input.hooks ?? PROCESS;
  const setTimer = input.setTimer ?? setTimeout,
    clearTimer = input.clearTimer ?? clearTimeout;
  const spawner = input.spawn ?? spawnInherited;
  const extensions = input.extensions ?? [];
  const consoles = extensions.flatMap((extension) => (extension.console === undefined ? [] : [extension.console]));
  // Bare `ia` has no flags: colour and ASCII come from the environment and the terminal.
  const caps: Capabilities = resolveCapabilities({ env, isTTY: true, columns: io.columns() }, {});
  const screen = new Screen(io, caps.color);
  const print = (text: string): void => io.write(`${text}\n`);

  const load = (): Promise<ConsoleState> =>
    loadState({
      cwd: input.cwd,
      env,
      packageRoot: input.packageRoot,
      version: input.version,
      collect: input.collect ?? collectDoctor,
      extensions,
      ...(input.spawnDoctor === undefined ? {} : { spawnDoctor: input.spawnDoctor }),
    });

  let state: ConsoleState;
  let offers: readonly Offer[];
  const ui: {
    selected: number;
    scroll: { list: number; pane: number };
    view: View;
    message: string | null;
    prompt: Prompt | null;
  } = { selected: 0, scroll: { list: 0, pane: 0 }, view: 'offers', message: null, prompt: null };

  const decoder = new KeyDecoder();
  // stdin's one owner, or null. `epoch` changes whenever ownership changes or a run starts, which ends the dispatch of
  // keys already decoded from one read.
  let consumer: ((chunk: string) => void) | null = null;
  let attached = false,
    epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onData = (chunk: string | Buffer): void => {
    consumer?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  const own = (next: (chunk: string) => void): void => {
    consumer = next;
    epoch += 1;
    if (!attached) {
      input.input.on('data', onData);
      attached = true;
    }
    input.input.resume?.();
  };
  const release = (): void => {
    consumer = null;
    epoch += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (attached) {
      input.input.off('data', onData);
      attached = false;
    }
    input.input.pause?.();
  };

  return new Promise<number>((resolve) => {
    let finished = false,
      running = false,
      child = false;
    // A confirmation or one-key wait the console itself owns; Ctrl-C cancels it.
    let waiting: { readonly cancel: () => void } | null = null;
    let keyHandler: (key: Input) => void = () => {};
    let unsubscribe: (() => void) | null = null,
      unsubscribeError: (() => void) | null = null;
    const signals = consoleSignals(hooks.platform ?? process.platform);
    const removeHooks = (): void => {
      for (const [event, listener] of handlers) hooks.off(event, listener);
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeError?.();
      unsubscribeError = null;
    };
    /** The one teardown: stdin let go, handlers removed, the terminal given back. */
    const finish = (code: number, error?: unknown, sync = false): void => {
      if (finished) return;
      finished = true;
      release();
      removeHooks();
      screen.leave(sync);
      waiting?.cancel();
      if (error !== undefined) {
        const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
        try {
          const say = sync && io.writeSync !== undefined ? io.writeSync.bind(io) : io.write.bind(io);
          for (const line of `ia: the console stopped: ${text}`.split(/\r?\n/)) say(`${sanitize(line)}\n`);
        } catch {
          // The terminal itself failed; there is nowhere left to say so.
        }
      }
      resolve(code);
    };
    const crash = (error: unknown): void => {
      // The process ends right after: restore synchronously, since an ordinary write may still be queued then.
      finish(1, error, true);
      hooks.exit(1);
    };
    const onSignal = (name: ConsoleSignal) => (): void => {
      // A running child receives the terminal's signals itself and decides; the console waits for it.
      if (child) return;
      if (name === 'SIGINT' && waiting !== null) {
        waiting.cancel();
        return;
      }
      finish(SIGNAL_EXIT[name], undefined, true);
      hooks.exit(SIGNAL_EXIT[name]);
    };
    const handlers: [HookEvent, (value?: unknown) => void][] = [
      ['exit', () => finish(0, undefined, true)],
      ['uncaughtException', crash],
      ['unhandledRejection', crash],
      ...signals.map((name): [HookEvent, () => void] => [name, onSignal(name)]),
    ];
    for (const [event, listener] of handlers) hooks.on(event, listener);
    // The failed stream is not trusted with the restoration: it is written synchronously, through what survives.
    unsubscribeError = io.onError?.((error) => finish(1, error, true)) ?? null;

    const render = (): void => {
      if (finished) return;
      // Only the console's own screen is drawn on; elsewhere a resize only marks the next frame as a full one.
      if (!screen.active) {
        screen.invalidate();
        return;
      }
      const columns = io.columns(),
        rows = io.rows();
      const at = geometry(state.areas.length, columns, rows);
      if (at !== null) ui.scroll.list = listScroll(offers, ui.selected, at.list.height, ui.scroll.list);
      screen.frame(layoutRepo({ state, offers, ...ui, caps, columns, rows }));
    };
    const guard = (work: () => void | Promise<void>): void => {
      try {
        const result = work();
        if (result instanceof Promise) result.catch((error: unknown) => finish(1, error));
      } catch (error) {
        finish(1, error);
      }
    };
    /** Keys from one read, dispatched until the console finishes, a run starts or stdin changes owner. */
    const dispatch = (keys: readonly Input[]): void => {
      const at = epoch;
      for (const key of keys) {
        if (finished || epoch !== at) return;
        keyHandler(key);
      }
    };
    const consoleInput = (chunk: string): void => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      dispatch(decoder.push(chunk));
      if (!finished && consumer === consoleInput && decoder.pending())
        timer = setTimer(() => {
          timer = null;
          dispatch(decoder.flush());
        }, ESCAPE_TIMEOUT_MS);
    };
    const takeConsole = (): void => own(consoleInput);

    const reload = async (): Promise<void> => {
      state = await load();
      offers = offersFor(state, consoles);
      ui.selected = Math.min(ui.selected, Math.max(0, offers.length - 1));
    };
    const prompt = (label: string, accept: (value: string) => string | null): Promise<string | null> =>
      new Promise((settle) => {
        decoder.mode = 'text';
        ui.prompt = { label, value: '', error: null };
        const done = (value: string | null): void => {
          decoder.mode = 'keys';
          ui.prompt = null;
          keyHandler = navigate;
          // The rest of the read that ended the prompt is not navigation.
          epoch += 1;
          render();
          settle(value);
        };
        keyHandler = (entry) => {
          const current = ui.prompt!;
          if (entry.kind === 'text') ui.prompt = { ...current, value: current.value + entry.text, error: null };
          else if (entry.key === 'backspace')
            ui.prompt = { ...current, value: graphemes(current.value).slice(0, -1).join(''), error: null };
          else if (entry.key === 'escape' || entry.key === 'interrupt') return done(null);
          else if (entry.key === 'enter') {
            const refusal = accept(current.value);
            if (refusal === null) return done(current.value);
            ui.prompt = { ...current, error: refusal };
          }
          render();
        };
        render();
      });
    /** A wait on the console's own input in the normal screen, cancelled by Ctrl-C or the console finishing. */
    const wait = <T>(reader: (settle: (value: T) => void) => (chunk: string) => void, cancelled: T): Promise<T> =>
      new Promise((settle) => {
        if (finished) return settle(cancelled);
        const end = (value: T): void => {
          waiting = null;
          release();
          settle(value);
        };
        waiting = { cancel: () => end(cancelled) };
        own(reader(end));
      });
    const run = async (offer: Offer): Promise<void> => {
      running = true;
      // Keys already decoded from the read that started this run are dropped.
      epoch += 1;
      try {
        const result = await runOffer(offer, state, {
          screen: {
            leave: () => {
              release();
              screen.leave();
            },
            enter: () => {
              if (finished) return;
              screen.enter();
              takeConsole();
            },
            invalidate: () => screen.invalidate(),
          },
          spawn: async (file, args, options) => {
            if (finished) return null;
            release();
            child = true;
            try {
              return await spawner(file, args, options);
            } finally {
              child = false;
            }
          },
          ask: async (question) => {
            if (finished) return false;
            io.write(`${question} [y/N] `);
            const answer = await wait<string | null>((settle) => {
              let buffer = '';
              return (chunk) => {
                buffer += chunk;
                const end = buffer.search(/\r?\n|\r/);
                if (end !== -1) settle(buffer.slice(0, end));
              };
            }, null);
            if (answer === null) io.write('\n');
            return consents(answer);
          },
          prompt,
          waitKey: async () => {
            if (finished) return;
            screen.raw(true);
            await wait<void>((settle) => () => settle(), undefined);
          },
          print,
          resolveRepo: input.resolveRepo ?? resolveRepo,
          env,
          cwd: input.cwd,
        });
        ui.message = result.exitCode !== null ? `${offer.title}: stopped with exit ${result.exitCode}` : null;
      } finally {
        running = false;
      }
      if (finished) return;
      if (consumer !== consoleInput) takeConsole();
      await reload();
      render();
    };
    const navigate = (entry: Input): void => {
      if (entry.kind !== 'key' || running || finished) return;
      const key = entry.key;
      if (key === 'quit' || key === 'interrupt' || (key === 'escape' && ui.view === 'offers')) return finish(0);
      if (key === 'escape' || (key === 'tab' && ui.view !== 'offers')) ui.view = 'offers';
      else if (key === 'tab') ui.view = 'diagnostics';
      else if (key === 'help') ui.view = 'help';
      else if (key === 'up' || key === 'down') {
        const step = key === 'up' ? -1 : 1;
        if (ui.view === 'offers') {
          ui.selected = Math.max(0, Math.min(offers.length - 1, ui.selected + step));
          ui.scroll.pane = 0;
        } else ui.scroll.pane = Math.max(0, ui.scroll.pane + step);
      } else if (key === 'page-up' || key === 'page-down')
        ui.scroll.pane = Math.max(0, ui.scroll.pane + (key === 'page-up' ? -10 : 10));
      else if (key === 'refresh') {
        ui.message = null;
        return guard(async () => {
          await reload();
          render();
        });
      } else if (key === 'enter' && ui.view === 'offers') {
        const offer = offers[ui.selected];
        if (offer === undefined) return;
        ui.message = null;
        if (offer.disabled !== undefined) ui.message = `${offer.title}: ${offer.disabled}`;
        else if (offer.view === 'diagnostics') ui.view = 'diagnostics';
        else return guard(() => run(offer));
      }
      // select-all, batch and find belong to the all-workspaces view, which this view does not have.
      render();
    };
    keyHandler = navigate;

    guard(async () => {
      await reload();
      if (finished) return;
      screen.enter();
      unsubscribe = io.onResize(() => guard(render));
      if (typeof (input.input as NodeJS.ReadStream).setEncoding === 'function')
        (input.input as NodeJS.ReadStream).setEncoding('utf8');
      takeConsole();
      render();
    });
  });
}
