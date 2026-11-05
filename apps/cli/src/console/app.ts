/**
 * The console's event loop: bare `ia` on an interactive terminal (consumer CLI contract §1.2). It loads the state and
 * draws one of two views: inside a workspace, that workspace's own view; outside any, the all-workspaces view over the
 * tracked list, with Find highlighted when the list is empty. Tab switches between them. It feeds stdin through one key
 * decoder, arming a short timer while a lone ESC could still start a sequence.
 *
 * In a workspace's view, enter runs the selected offer in the normal screen (run.ts) and reloads; `r` reloads; `?`
 * shows the keys; `q`, Escape at the top level, or Ctrl-C quits with 0. In the all-workspaces view space selects a row,
 * `a` selects every row a batchable offer fires on, enter opens a row's own view (Escape returns), `b` moves to the
 * batch list, where enter shows a batch's preview and enter again runs it in the normal screen (batch-screen.ts), and
 * `f` opens a folder line to find workspaces in. `b` and `f` are keys only while no line is open: in the folder line
 * every character is text. The tracked rows load in the background, each repainting as it arrives; quitting aborts
 * the loads still running.
 *
 * One offer or batch runs at a time. Once a run starts or the console begins to finish, the rest of an already-decoded
 * read is discarded, and no key navigates while a run goes on. stdin has one owner at a time: the console's decoder, a
 * confirmation line or a one-key wait; before a child starts the console pauses stdin and lets go of it, and takes it
 * back only for its own input.
 *
 * One teardown restores the terminal (console/terminal.ts) on quit, on a throw anywhere in the loop (exit 1, the error
 * printed in the normal screen), on an output failure such as a closed pipe (exit 1), on `uncaughtException` and
 * `unhandledRejection` (exit 1), and on `SIGINT`, `SIGTERM`, `SIGHUP` and, on Windows, `SIGBREAK` (exit 128 plus the
 * signal's number: 130, 143, 129, 149). A process `exit` restores it synchronously. These handlers exist only while the
 * console runs. A signal while a step's child runs is the child's to handle; Ctrl-C at the console's own confirmation
 * declines it, and during a batch stops it: batch-run.ts passes the signal on to the command in flight, in a process
 * group of its own, and nothing further starts.
 */
import { statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { readIaConfig } from '@inventarch/distribution/updates';
import type { Extension } from '../consumer.js';
import { consents } from '../consumer.js';
import { iaHomeOf } from '../discovery.js';
import type { DoctorRequest, DoctorView } from '../doctor.js';
import { collectDoctor } from '../doctor.js';
import { runnableCopy } from '../handoff.js';
import type { LocalCli } from '../local-cli.js';
import type { Env } from '../program.js';
import type { Capabilities } from '../render.js';
import { resolveCapabilities } from '../render.js';
import type { TrackedWorkspace } from '../tracked.js';
import { findWorkspaces, readTracked, trackedRow, trackWorkspaces } from '../tracked.js';
import { batchChoices, planBatch, selectNeeding } from './batch-plan.js';
import type { Runner } from './batch-run.js';
import { defaultRunner, enclosingTop, gitTop } from './batch-run.js';
import { batchScreen } from './batch-screen.js';
import { sanitize } from './grid.js';
import type { Input } from './keys.js';
import { KeyDecoder } from './keys.js';
import type { BatchPreview, FoundList } from './layout-all.js';
import { itemAt, itemCount, layoutAll } from './layout-all.js';
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
import type { RepoRow } from './workspaces-state.js';
import { doctorPool, loadAll, loadingRow, summarize, WORKSPACE_DOCTOR_TIMEOUT_MS } from './workspaces-state.js';

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
/**
 * The workspace's own copy as the disk has it now, by the rule hand-off applies (handoff.ts `runnableCopy`): found up to
 * the workspaces root that hoists it, and none when the repository commits it or the user set `IA_NO_HANDOFF=1`. Then
 * every `ia` step runs on the running copy (`running`), as when no copy is installed.
 */
export function resolveRepo(root: string, env: Env, running: string): LocalCli | null {
  return runnableCopy(root, { env, running });
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

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
  /** The runner a batch's git, package-manager and `ia` commands go through; the real one by default. */
  readonly runner?: Runner;
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
  const collect = input.collect ?? collectDoctor;
  // Every step and batch run resolves the workspace's copy by the hand-off rule (handoff.ts `runnableCopy`).
  const repoOf = input.resolveRepo ?? ((root: string) => resolveRepo(root, env, input.packageRoot));

  // One controller per load, aborted when the console finishes, so quitting never waits for a reload's doctor run.
  const loads = new Set<AbortController>();
  const load = async (cwd: string): Promise<ConsoleState> => {
    const controller = new AbortController();
    loads.add(controller);
    try {
      return await loadState({
        cwd,
        env,
        packageRoot: input.packageRoot,
        version: input.version,
        collect,
        extensions,
        signal: controller.signal,
        ...(input.spawnDoctor === undefined ? {} : { spawnDoctor: input.spawnDoctor }),
      });
    } finally {
      loads.delete(controller);
    }
  };

  /** The console's own workspace, or the running copy's view outside one. */
  let home: ConsoleState;
  /** The workspace view's state: `home`, or a workspace opened from the table. */
  let state: ConsoleState;
  let offers: readonly Offer[];
  const ui: {
    mode: 'repo' | 'all';
    /** The workspace opened from the table, and its row (null for a worktree opened after a batch). */
    drilled: { readonly root: string; readonly row: number | null } | null;
    selected: number;
    scroll: { list: number; pane: number };
    view: View;
    message: string | null;
    prompt: Prompt | null;
  } = {
    mode: 'repo',
    drilled: null,
    selected: 0,
    scroll: { list: 0, pane: 0 },
    view: 'offers',
    message: null,
    prompt: null,
  };
  const all: {
    rows: RepoRow[];
    loaded: boolean;
    controller: AbortController | null;
    selected: Set<number>;
    cursor: number;
    preview: BatchPreview | null;
    found: FoundList | null;
    message: string | null;
  } = {
    rows: [],
    loaded: false,
    controller: null,
    selected: new Set(),
    cursor: 0,
    preview: null,
    found: null,
    message: null,
  };
  let batchController: AbortController | null = null;
  // Every workspace doctor the console starts, the table's and an opened workspace's refresh, shares these slots.
  const pool = doctorPool();
  /** The opened workspace's refresh in flight, and how many have been asked for: only the newest may land. */
  let refresh: AbortController | null = null;
  let refreshes = 0;
  const homeDir = (): string | null => home?.facts.home ?? iaHomeOf(env) ?? null;

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
      opening = false,
      child = false;
    // A confirmation, one-key wait or batch the console itself owns; Ctrl-C cancels it.
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
    /** The one teardown: stdin let go, handlers removed, background loads aborted, the terminal given back. */
    const finish = (code: number, error?: unknown, sync = false): void => {
      if (finished) return;
      finished = true;
      for (const controller of loads) controller.abort();
      release();
      removeHooks();
      all.controller?.abort();
      batchController?.abort();
      refresh?.abort();
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

    const choices = () => batchChoices(all.rows, all.selected);
    const render = (): void => {
      if (finished) return;
      // Only the console's own screen is drawn on; elsewhere a resize only marks the next frame as a full one.
      if (!screen.active) {
        screen.invalidate();
        return;
      }
      const columns = io.columns(),
        rows = io.rows();
      if (ui.mode === 'all') {
        screen.frame(
          layoutAll({
            repos: all.rows,
            summary: summarize(all.rows, { latest: home.facts.latest }, input.version),
            selected: all.selected,
            cursor: all.cursor,
            choices: choices(),
            preview: all.preview,
            found: all.found,
            message: all.message,
            prompt: ui.prompt,
            repoTab: home.root !== null,
            caps,
            columns,
            rows,
          }),
        );
        return;
      }
      const at = geometry(state.areas.length, columns, rows);
      if (at !== null) ui.scroll.list = listScroll(offers, ui.selected, at.list.height, ui.scroll.list);
      screen.frame(
        layoutRepo({
          state,
          offers,
          selected: ui.selected,
          scroll: ui.scroll,
          view: ui.view,
          message: ui.message,
          prompt: ui.prompt,
          caps,
          columns,
          rows,
          drilled: ui.drilled !== null,
        }),
      );
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

    /** A tracked row rebuilt from a freshly loaded state. */
    const rowFrom = (tracked: TrackedWorkspace, loaded: ConsoleState): RepoRow => ({
      tracked,
      state: loaded.repoFailure === null ? 'ready' : 'failed',
      console: loaded,
      offers: offersFor(loaded, consoles),
      failure: loaded.repoFailure,
    });
    /** Stops the opened workspace's refresh, if one is in flight: its result could only be stale now. */
    const dropRefresh = (): void => {
      refresh?.abort();
      refresh = null;
      refreshes += 1;
    };
    const reload = async (): Promise<void> => {
      const target = ui.drilled;
      if (target === null) {
        // Guarded like the opened workspace's refresh below: a newer refresh, or a workspace opened from the table
        // while this one loads, makes its result stale, and it is dropped rather than drawn over that view.
        dropRefresh();
        const mine = refreshes;
        const loaded = await load(input.cwd);
        if (finished || mine !== refreshes || ui.drilled !== target) return;
        home = loaded;
        state = home;
      } else {
        // A workspace opened from the table is read in the shared slots, bounded and cancellable; a newer refresh
        // cancels this one, and a result is kept only while that same opening is still on screen.
        dropRefresh();
        const controller = new AbortController();
        refresh = controller;
        const mine = refreshes;
        const loaded = await pool.run(controller.signal, () =>
          loadState({
            cwd: target.root,
            env,
            packageRoot: input.packageRoot,
            version: input.version,
            collect,
            extensions,
            signal: controller.signal,
            timeoutMs: WORKSPACE_DOCTOR_TIMEOUT_MS,
            ...(input.spawnDoctor === undefined ? {} : { spawnDoctor: input.spawnDoctor }),
          }),
        );
        if (refresh === controller) refresh = null;
        if (loaded === null || finished || mine !== refreshes || ui.drilled !== target || controller.signal.aborted)
          return;
        state = loaded;
        const row = target.row === null ? undefined : all.rows[target.row];
        if (row !== undefined && target.row !== null && row.tracked.root === target.root)
          all.rows[target.row] = rowFrom(row.tracked, loaded);
      }
      offers = offersFor(state, consoles);
      ui.selected = Math.min(ui.selected, Math.max(0, offers.length - 1));
    };
    /** The tracked list, every row loading, then each loaded through its own copy in the background. */
    const loadRows = (): void => {
      all.controller?.abort();
      const controller = new AbortController();
      all.controller = controller;
      all.loaded = true;
      all.preview = null;
      const dir = homeDir();
      let tracked: readonly TrackedWorkspace[] = [];
      try {
        tracked = dir === null ? [] : readTracked(dir);
        if (dir === null) all.message = 'The IA home cannot be found, so no workspaces are tracked.';
      } catch (error) {
        all.message = error instanceof Error ? error.message : String(error);
      }
      const before = all.rows.map((row) => row.tracked.root);
      all.rows = tracked.map(loadingRow);
      // A selection survives a reload when the rows are the same.
      if (before.join('\n') !== all.rows.map((row) => row.tracked.root).join('\n')) all.selected = new Set();
      all.cursor = Math.min(all.cursor, itemCount(all.rows.length, choices().length) - 1);
      guard(() =>
        loadAll({
          tracked,
          env,
          packageRoot: input.packageRoot,
          version: input.version,
          signal: controller.signal,
          collect,
          extensions,
          pool,
          ...(input.spawnDoctor === undefined ? {} : { spawnDoctor: input.spawnDoctor }),
          onRow: (index, row) => {
            if (controller.signal.aborted || finished) return;
            all.rows[index] = row;
            render();
          },
        }),
      );
    };

    const prompt = (label: string, accept: (value: string) => string | null, initial = ''): Promise<string | null> =>
      new Promise((settle) => {
        decoder.mode = 'text';
        ui.prompt = { label, value: initial, error: null };
        const back = keyHandler;
        const done = (value: string | null): void => {
          decoder.mode = 'keys';
          ui.prompt = null;
          keyHandler = back;
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
    /** One line typed in the normal screen after `question`; null when cancelled. */
    const readLine = async (question: string): Promise<string | null> => {
      if (finished) return null;
      io.write(question);
      const answer = await wait<string | null>((settle) => {
        let buffer = '';
        return (chunk) => {
          buffer += chunk;
          const end = buffer.search(/\r?\n|\r/);
          if (end !== -1) settle(buffer.slice(0, end));
        };
      }, null);
      if (answer === null) io.write('\n');
      return answer;
    };
    const waitKey = async (): Promise<void> => {
      if (finished) return;
      screen.raw(true);
      await wait<void>((settle) => () => settle(), undefined);
    };
    const backToConsole = (): void => {
      if (finished) return;
      screen.enter();
      takeConsole();
      screen.invalidate();
    };

    const run = async (offer: Offer, on: ConsoleState = state): Promise<void> => {
      running = true;
      // Keys already decoded from the read that started this run are dropped.
      epoch += 1;
      try {
        const result = await runOffer(offer, on, {
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
          ask: async (question) => consents(await readLine(`${question} [y/N] `)),
          prompt,
          waitKey,
          print,
          resolveRepo: repoOf,
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

    /** The preview's batch, in the normal screen; then whatever its "next" choice leads to. */
    const runBatchFlow = async (preview: BatchPreview): Promise<void> => {
      running = true;
      epoch += 1;
      let controller = new AbortController();
      batchController = controller;
      let outcome: Awaited<ReturnType<typeof batchScreen>> = { next: 'return' };
      try {
        release();
        screen.leave();
        outcome = await batchScreen(preview, home.running, {
          print: (text) => print(sanitize(text)),
          line: readLine,
          run: (file, args, options) => {
            // Ctrl-C while a batch command runs stops the batch: that command gets the signal too (the runner forwards it to
            // the command's own process group, and on Windows it shares the console), acts on it and usually ends, and
            // nothing further starts.
            waiting = { cancel: () => controller.abort() };
            return (input.runner ?? defaultRunner(env))(file, args, options).finally(() => {
              waiting = null;
            });
          },
          resolveRepo: repoOf,
          env,
          signal: controller.signal,
          // Each choice after the run gets its own controller, so a Ctrl-C during the run leaves them choosable.
          nextSignal: () => {
            controller = new AbortController();
            batchController = controller;
            return controller.signal;
          },
        });
        print('Press any key to return to the console.');
        await waitKey();
      } finally {
        running = false;
        batchController = null;
      }
      backToConsole();
      all.preview = null;
      if (outcome.next === 'open') {
        dropRefresh();
        ui.drilled = { root: outcome.root, row: null };
        ui.view = 'offers';
        ui.selected = 0;
        // Its view holds the console's own state and offers until this returns: the table stays up, and no key but quit
        // acts, so nothing can draw or run those under this workspace's name.
        opening = true;
        all.message = `Reading ${outcome.root}…`;
        render();
        await reload();
        opening = false;
        all.message = null;
        if (finished) return;
        ui.mode = 'repo';
      } else if (outcome.next === 'deferred') {
        const steps = outcome.steps;
        await run(
          {
            id: 'deferred',
            answers: [],
            title: 'Steps left out of the batch',
            explain: '',
            steps,
            changes: [],
            group: 'more',
            area: null,
            writesTo: [...new Set(steps.map((step) => step.writesTo))],
            batchable: false,
          },
          home,
        );
      }
      if (finished) return;
      loadRows();
      render();
    };

    const openFind = (): void =>
      guard(async () => {
        const accept = (value: string): string | null =>
          value.trim() === ''
            ? 'Enter a folder.'
            : isDirectory(resolvePath(input.cwd, value.trim()))
              ? null
              : 'Not a folder.';
        const folder = await prompt('Folder', accept, dirname(input.cwd));
        if (folder === null || finished) return;
        const dir = homeDir();
        const absolute = resolvePath(input.cwd, folder.trim());
        try {
          const roots = findWorkspaces(absolute, { iaHome: dir ?? undefined });
          const tracked = dir === null ? [] : readTracked(dir);
          const known = new Set(
            roots.flatMap((root, index) => (trackedRow(tracked, root) === undefined ? [] : [index])),
          );
          all.found = {
            folder: absolute,
            roots,
            tracked: known,
            selected: new Set(roots.flatMap((_, index) => (known.has(index) ? [] : [index]))),
            cursor: 0,
          };
          all.message = roots.length === 0 ? `No workspaces under ${absolute}.` : null;
        } catch (error) {
          all.message = error instanceof Error ? error.message : String(error);
        }
        render();
      });
    const trackFound = (found: FoundList): void => {
      const dir = homeDir();
      const roots = found.roots.filter((_, index) => found.selected.has(index));
      all.found = null;
      if (dir === null) all.message = 'The IA home cannot be found.';
      else
        try {
          const added = trackWorkspaces(dir, roots);
          all.message = `Tracked ${added.length} ${added.length === 1 ? 'workspace' : 'workspaces'}.`;
        } catch (error) {
          all.message = error instanceof Error ? error.message : String(error);
        }
      loadRows();
    };

    const toAll = (): void => {
      ui.mode = 'all';
      if (ui.drilled !== null) dropRefresh();
      ui.drilled = null;
      state = home;
      offers = offersFor(home, consoles);
      if (!all.loaded) loadRows();
    };
    const navigateAll = (key: Input & { kind: 'key' }): void => {
      const found = all.found;
      const count = itemCount(all.rows.length, choices().length);
      const name = key.key;
      if (name === 'quit' || name === 'interrupt') return finish(0);
      if (name === 'escape') {
        if (found !== null) all.found = null;
        else if (all.preview !== null) all.preview = null;
        else return finish(0);
      } else if (found !== null) {
        if (name === 'up' || name === 'down')
          all.found = {
            ...found,
            cursor: Math.max(0, Math.min(found.roots.length - 1, found.cursor + (name === 'up' ? -1 : 1))),
          };
        else if (name === 'space' && !found.tracked.has(found.cursor) && found.roots.length > 0) {
          const selected = new Set(found.selected);
          if (selected.has(found.cursor)) selected.delete(found.cursor);
          else selected.add(found.cursor);
          all.found = { ...found, selected };
        } else if (name === 'enter') return trackFound(found);
      } else if (name === 'tab') {
        if (home.root !== null) {
          ui.mode = 'repo';
          ui.view = 'offers';
        }
      } else if (name === 'up' || name === 'down') {
        all.cursor = Math.max(0, Math.min(count - 1, all.cursor + (name === 'up' ? -1 : 1)));
        all.preview = null;
      } else if (name === 'space') {
        const item = itemAt(all.cursor, all.rows.length, choices().length);
        if (item.kind === 'repo') {
          if (all.selected.has(item.index)) all.selected.delete(item.index);
          else all.selected.add(item.index);
          all.preview = null;
        }
      } else if (name === 'select-all') {
        all.selected = new Set(selectNeeding(all.rows));
        all.preview = null;
      } else if (name === 'batch') all.cursor = all.rows.length;
      else if (name === 'find') return openFind();
      else if (name === 'refresh') loadRows();
      else if (name === 'enter') {
        const listed = choices();
        const item = itemAt(all.cursor, all.rows.length, listed.length);
        all.message = null;
        if (item.kind === 'find') return openFind();
        if (item.kind === 'repo') {
          const row = all.rows[item.index]!;
          if (row.console === null)
            all.message = row.state === 'missing' ? `${row.tracked.id} is missing.` : 'Still reading this workspace.';
          else {
            ui.mode = 'repo';
            dropRefresh();
            ui.drilled = { root: row.tracked.root, row: item.index };
            ui.view = 'offers';
            ui.selected = 0;
            state = row.console;
            offers = row.offers;
          }
        } else {
          const choice = listed[item.index]!;
          if (all.preview !== null && all.preview.choice.offerId === choice.offerId) {
            const preview = all.preview;
            return guard(() => runBatchFlow(preview));
          }
          const dir = homeDir();
          if (dir === null) all.message = 'The IA home cannot be found.';
          else {
            const root = readIaConfig(dir)?.worktreeRoot;
            const plan = planBatch(
              choice.offerId,
              all.rows,
              all.selected,
              { iaHome: dir, ...(root === undefined ? {} : { worktreeRoot: root }) },
              { top: (path) => gitTop(path, env), enclosing: (path) => enclosingTop(path, env) },
            );
            all.preview = { choice, ...plan };
          }
        }
      }
      render();
    };
    const navigate = (entry: Input): void => {
      if (entry.kind !== 'key' || running || finished) return;
      if (opening) {
        if (entry.key === 'quit' || entry.key === 'interrupt') finish(0);
        return;
      }
      if (ui.mode === 'all') return navigateAll(entry);
      const key = entry.key;
      const top = ui.view === 'offers';
      if (ui.drilled !== null && top && (key === 'quit' || key === 'escape')) {
        dropRefresh();
        ui.mode = 'all';
        ui.drilled = null;
        state = home;
        offers = offersFor(home, consoles);
        render();
        return;
      }
      if (key === 'quit' || key === 'interrupt' || (key === 'escape' && top)) return finish(0);
      if (key === 'escape' || (key === 'tab' && !top)) ui.view = 'offers';
      else if (key === 'tab') {
        toAll();
      } else if (key === 'help') ui.view = 'help';
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
      } else if (key === 'enter' && top) {
        const offer = offers[ui.selected];
        if (offer === undefined) return;
        ui.message = null;
        if (offer.disabled !== undefined) ui.message = `${offer.title}: ${offer.disabled}`;
        else if (offer.view === 'diagnostics') ui.view = 'diagnostics';
        else return guard(() => run(offer));
      }
      // select-all, batch and find belong to the all-workspaces view.
      render();
    };
    keyHandler = navigate;

    guard(async () => {
      await reload();
      if (finished) return;
      // Outside any workspace the console opens on every tracked one; with none tracked, Find is the first item.
      if (home.root === null) toAll();
      screen.enter();
      unsubscribe = io.onResize(() => guard(render));
      if (typeof (input.input as NodeJS.ReadStream).setEncoding === 'function')
        (input.input as NodeJS.ReadStream).setEncoding('utf8');
      takeConsole();
      render();
    });
  });
}
