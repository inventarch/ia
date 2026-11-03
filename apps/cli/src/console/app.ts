/**
 * The console's event loop: bare `ia` on an interactive terminal (consumer CLI contract §1.2). It loads the state, draws
 * the single-repo view, and feeds stdin through one key decoder, arming a short timer while a lone ESC could still
 * start a sequence. Enter runs the selected offer in the normal screen (run.ts) and reloads; `r` reloads; tab shows the
 * diagnostics; `?` the keys; `q`, Escape at the top level, or Ctrl-C quits with 0.
 *
 * The terminal is always restored: on quit, on a throw anywhere in the loop (exit 1, the error printed in the normal
 * screen), and through `uncaughtException`, `unhandledRejection`, `SIGTERM` and `SIGINT` handlers that are installed
 * for the console's lifetime only (exit 1 for a crash, 130 for a signal). While a step's child runs, a signal is the
 * child's to handle.
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

/** The process events the console listens to while it runs; injected by tests. */
export interface ProcessHooks {
  on(
    event: 'uncaughtException' | 'unhandledRejection' | 'SIGTERM' | 'SIGINT',
    listener: (error?: unknown) => void,
  ): void;
  off(
    event: 'uncaughtException' | 'unhandledRejection' | 'SIGTERM' | 'SIGINT',
    listener: (error?: unknown) => void,
  ): void;
  exit(code: number): void;
}
const PROCESS: ProcessHooks = {
  on: (event, listener) => process.on(event, listener),
  off: (event, listener) => process.off(event, listener),
  exit: (code) => process.exit(code),
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

  // stdin goes to one consumer at a time: the key decoder while the console shows, a line or a key in the normal screen.
  const decoder = new KeyDecoder();
  let consumer: ((chunk: string) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onData = (chunk: string | Buffer): void => {
    consumer?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  const readLine = (): Promise<string | null> =>
    new Promise((settle) => {
      let buffer = '';
      consumer = (chunk) => {
        buffer += chunk;
        const end = buffer.search(/\r?\n|\r/);
        if (end === -1) return;
        consumer = null;
        settle(buffer.slice(0, end));
      };
    });
  const readKey = (): Promise<void> =>
    new Promise((settle) => {
      consumer = () => {
        consumer = null;
        settle();
      };
    });

  return new Promise<number>((resolve) => {
    let finished = false,
      busy = false;
    let keyHandler: (key: Input) => void = () => {};
    const finish = (code: number, error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      consumer = null;
      input.input.off('data', onData);
      input.input.pause?.();
      for (const [event, listener] of handlers) hooks.off(event, listener);
      unsubscribe?.();
      screen.leave();
      if (error !== undefined)
        print(`ia: the console stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      resolve(code);
    };
    const crash = (error: unknown): void => {
      finish(1, error);
      hooks.exit(1);
    };
    const signal = (): void => {
      if (busy) return;
      finish(130);
      hooks.exit(130);
    };
    const handlers: [Parameters<ProcessHooks['on']>[0], (error?: unknown) => void][] = [
      ['uncaughtException', crash],
      ['unhandledRejection', crash],
      ['SIGTERM', signal],
      ['SIGINT', signal],
    ];
    for (const [event, listener] of handlers) hooks.on(event, listener);
    let unsubscribe: (() => void) | null = null;

    const render = (): void => {
      if (finished) return;
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
    const consoleInput = (chunk: string): void => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      for (const key of decoder.push(chunk)) keyHandler(key);
      if (decoder.pending())
        timer = setTimer(() => {
          timer = null;
          for (const key of decoder.flush()) keyHandler(key);
        }, ESCAPE_TIMEOUT_MS);
    };

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
    const run = async (offer: Offer): Promise<void> => {
      busy = true;
      try {
        const result = await runOffer(offer, state, {
          screen: {
            leave: () => {
              screen.leave();
              consumer = null;
            },
            enter: () => {
              screen.enter();
              consumer = consoleInput;
            },
            invalidate: () => screen.invalidate(),
          },
          spawn: input.spawn ?? spawnInherited,
          ask: async (question) => {
            io.write(`${question} [y/N] `);
            return consents(await readLine());
          },
          prompt,
          waitKey: async () => {
            io.setRawMode(true);
            await readKey();
          },
          print,
          resolveRepo: input.resolveRepo ?? resolveRepo,
          env,
          cwd: input.cwd,
        });
        ui.message = result.exitCode !== null ? `${offer.title}: stopped with exit ${result.exitCode}` : null;
      } finally {
        busy = false;
      }
      consumer = consoleInput;
      await reload();
      render();
    };
    const navigate = (entry: Input): void => {
      if (entry.kind !== 'key') return;
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
      screen.enter();
      unsubscribe = io.onResize(() => guard(render));
      if (typeof (input.input as NodeJS.ReadStream).setEncoding === 'function')
        (input.input as NodeJS.ReadStream).setEncoding('utf8');
      consumer = consoleInput;
      input.input.on('data', onData);
      input.input.resume?.();
      render();
    });
  });
}
