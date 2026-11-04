#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import type { Readable } from 'node:stream';
import { Door, isEntry } from '@inventarch/runtime';
import type { DoorResponse } from '@inventarch/runtime';
import { dispatch, HELP_TOKENS } from './consumer.js';
import type { Host } from './consumer.js';
import type { TerminalIO } from './console/terminal.js';
import { EXTENSIONS, packageRoot, version } from './self.js';
import { describeOperation, renderOperationHelp, renderOperationSchema, SCHEMA_TOKEN } from './operation-help.js';

const USAGE =
  'Usage: ia <scope|context|select|get|records|resolve|search|traverse|report> [--root <workspace>] [--params <JSON|->]\nUse --params - for stdin JSON. Scope tokens last for one invocation.\n';
export function runCli(
  args: readonly string[],
  stdin: () => string = () => readFileSync(0, 'utf8'),
): { readonly exitCode: number; readonly stdout: string } {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, stdout: USAGE };
  let door: Door | undefined;
  const usage = (message: string) => ({
    exitCode: 2,
    stdout: JSON.stringify({ ok: false, code: 'IA-CLI-USAGE', message }) + '\n',
  });
  try {
    const operation = args[0];
    if (operation === undefined || operation.startsWith('-')) return usage(USAGE.trim());
    // Help or the schema asked in an option position answers before any option is checked, so it opens no workspace and
    // reads no stdin. Each argument vector this changes was an IA-CLI-USAGE refusal at exit 2 before.
    const described = describeOperation(operation);
    const asked =
      described === undefined
        ? undefined
        : args.find((token, index) => index % 2 === 1 && (HELP_TOKENS.has(token) || token === SCHEMA_TOKEN));
    if (described !== undefined && asked !== undefined)
      return {
        exitCode: 0,
        stdout: asked === SCHEMA_TOKEN ? renderOperationSchema(described) : renderOperationHelp(described),
      };
    let root = process.cwd(),
      raw = '{}';
    const seen = new Set<string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!,
        value = args[i + 1];
      if (!['--root', '--params'].includes(key) || seen.has(key) || value === undefined)
        return usage(`Unknown, duplicate or incomplete option: ${key}`);
      seen.add(key);
      if (key === '--root') root = value;
      else raw = value;
    }
    let params: unknown;
    try {
      params = JSON.parse(raw === '-' ? stdin() : raw) as unknown;
    } catch {
      return usage('--params must contain valid JSON');
    }
    // The machine routes are the version 1 operations, so the door serves version 1 and refuses a later version's
    // operation, such as `read`, as the unknown operation 1.1.0 refused, byte for byte.
    door = new Door(root, { cache: false, allowReport: true, protocol: 1 });
    const response: DoorResponse = door.request({ operation, params });
    const reportFailed =
      operation === 'report' &&
      response.ok &&
      response.result !== null &&
      typeof response.result === 'object' &&
      'outcome' in response.result &&
      response.result.outcome === 'fail';
    return {
      exitCode: response.ok ? (reportFailed ? 1 : 0) : response.code === 'IA-RUNTIME-REQUEST-INVALID' ? 2 : 1,
      stdout: JSON.stringify(response) + '\n',
    };
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'IA-CLI-USAGE';
    return {
      exitCode: code === 'IA-CLI-USAGE' ? 2 : 1,
      stdout:
        JSON.stringify({ ok: false, code, message: error instanceof Error ? error.message : String(error) }) + '\n',
    };
  } finally {
    door?.close();
  }
}

/**
 * §2.0's confirmation reader: one line from stdin, or null at EOF, on a closed stdin or on a stdin that errors. No
 * dependency and no prompt library — the question is a line written to stderr and a line read back, and the
 * decision it feeds is `consents()` in consumer.ts. stdin is paused again afterwards so a read cannot hold the
 * process open past the answer.
 */
export function readLine(signal?: AbortSignal, stdin: Readable = process.stdin): Promise<string | null> {
  return new Promise((settle, reject) => {
    signal?.throwIfAborted();
    if (stdin.destroyed || stdin.readableEnded) {
      settle(null);
      return;
    }
    let buffer = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      stdin.pause();
    };
    const done = (value: string | null): void => {
      cleanup();
      settle(value);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      const end = buffer.search(/\r?\n/);
      if (end !== -1) done(buffer.slice(0, end));
    };
    // EOF with nothing typed is no answer at all, which §2.0 declines; EOF after a line is that line.
    const onEnd = (): void => {
      done(buffer === '' ? null : buffer);
    };
    const onError = (): void => {
      done(null);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    stdin.resume();
  });
}
/** §6 resolves colour, symbols and width from an explicit environment; this is the only place the process is read. */
function host(controller: AbortController): Host {
  const describe = (stream: NodeJS.WriteStream) => ({
    env: process.env,
    isTTY: stream.isTTY === true,
    columns: stream.columns,
  });
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: describe(process.stdout),
    stderr: describe(process.stderr),
    // §2.0 and §5: a question needs a terminal at both ends, and it is written to stderr, never to stdout.
    // isatty(0) rather than process.stdin.isTTY: reading that getter constructs the stdin stream, and on POSIX
    // constructing it puts fd 0 into non-blocking mode. Every later readSync(0) on a pipe then throws EAGAIN once
    // the payload outgrows the pipe buffer — which is how this host, built before dispatch chooses a route, broke
    // the legacy --params - read above and the private namespace one. isatty asks the fd and leaves it alone.
    interaction: {
      interactive: isatty(0) && isatty(1),
      write: (text: string) => {
        process.stderr.write(text);
      },
      read: () => readLine(controller.signal),
    },
    version: version(),
    packageRoot,
    signal: controller.signal,
    onConsumerRoute: () => installSignals(controller),
  };
}
/** §5: on a signal, stop starting work, print one line to stderr and exit 130; §3 keeps this off the legacy path. */
export function installSignals(
  controller: AbortController,
  forceExit: (code: number) => void = process.exit,
): () => void {
  const stop = (): void => {
    if (controller.signal.aborted) {
      forceExit(130);
      return;
    }
    controller.abort(new Error('Interrupted.'));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
  return () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, stop);
  };
}
/** The public CLI's extension table lives in self.ts, which the `ia` bin reads before this module loads. */
export { EXTENSIONS };

/**
 * Consumer CLI contract §1.2: bare `ia` opens the console only when stdin and stdout are both terminals and `CI` is unset
 * or empty. Everywhere else it is today's help at exit 0, and `ia --help` always is.
 */
export function opensConsole(
  argv: readonly string[],
  stdinTTY: boolean,
  stdoutTTY: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return argv.length === 0 && stdinTTY && stdoutTTY && (env['CI'] ?? '') === '';
}
export interface EntryDeps {
  readonly isatty: (fd: number) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runConsole: () => Promise<number>;
  readonly dispatch: () => Promise<void>;
}
/** The console or the ordinary dispatch, decided before anything is dispatched; `main` builds the deps from the process. */
export async function enter(argv: readonly string[], deps: EntryDeps): Promise<'console' | 'dispatch'> {
  if (opensConsole(argv, deps.isatty(0), deps.isatty(1), deps.env)) {
    await deps.runConsole();
    return 'console';
  }
  await deps.dispatch();
  return 'dispatch';
}
/** The streams a console terminal is made of; the process's own in production. */
export interface ConsoleStreams {
  readonly stdout: Pick<NodeJS.WriteStream, 'write' | 'on' | 'off' | 'columns' | 'rows'> & { readonly fd: number };
  readonly stdin: { readonly isTTY?: boolean; setRawMode?(on: boolean): unknown };
  /** A write that completes before it returns: `fs.writeSync` on the stdout descriptor. */
  readonly writeSync: (fd: number, data: string) => void;
}
/**
 * The console's terminal over the process streams. An output failure (a closed pipe) reaches the console's own
 * teardown through `onError`, so the terminal is restored and the console ends, rather than being swallowed with stdin
 * destroyed and raw mode left on.
 */
export function consoleTerminal({ stdout, stdin, writeSync }: ConsoleStreams): TerminalIO {
  return {
    write: (data) => {
      stdout.write(data);
    },
    writeSync: (data) => writeSync(stdout.fd, data),
    columns: () => stdout.columns ?? 80,
    rows: () => stdout.rows ?? 24,
    setRawMode: (on) => {
      if (stdin.isTTY === true) stdin.setRawMode?.(on);
    },
    onResize: (listener) => {
      stdout.on('resize', listener);
      return () => {
        stdout.off('resize', listener);
      };
    },
    onError: (listener) => {
      stdout.on('error', listener);
      return () => {
        stdout.off('error', listener);
      };
    },
  };
}
/** The console on this process's terminal; loaded only when bare `ia` runs on one. */
async function startConsole(): Promise<number> {
  const { runConsole } = await import('./console/app.js');
  const code = await runConsole({
    io: consoleTerminal({ stdout: process.stdout, stdin: process.stdin, writeSync: (fd, data) => writeSync(fd, data) }),
    input: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    packageRoot,
    version: version(),
    extensions: EXTENSIONS,
  });
  process.exitCode = code;
  return code;
}
/**
 * Runs one invocation on this copy and sets the exit code. The `ia` bin (bin.ts) calls it when no hand-off answered;
 * `node dist/main.js`, the plugin hook's entry, runs it directly and so never hands off (consumer-cli-contract §1.2).
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    // isatty rather than process.stdin.isTTY, for the reason `host` gives: reading that getter constructs the stream.
    await enter(argv, {
      isatty,
      env: process.env,
      runConsole: startConsole,
      dispatch: async () => {
        // A closed stdout is a normal end of output. The three moves are apps/mcp-door/src/main.ts's stdout error
        // handlers. The console, which owns the terminal, routes the same failure into its own teardown instead.
        process.stdout.on('error', (error: NodeJS.ErrnoException) => {
          process.stdin.destroy();
          if (error.code !== 'EPIPE') throw error;
        });
        const result = await dispatch(argv, host(new AbortController()), runCli, EXTENSIONS);
        if (result.stderr !== '') process.stderr.write(result.stderr);
        process.stdout.write(result.stdout);
        process.exitCode = result.exitCode;
      },
    });
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'IA-CLI-FAILED';
    if (!process.stdout.destroyed && code !== 'EPIPE') {
      process.stderr.write(`${code}  ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
    }
  }
}

if (isEntry(process.argv[1], import.meta.url)) await main();
