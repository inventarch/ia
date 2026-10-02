#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isatty } from 'node:tty';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Door, isEntry } from '@ia/runtime';
import type { DoorResponse } from '@ia/runtime';
import { dispatch, HELP_TOKENS } from './consumer.js';
import type { Extension, Host } from './consumer.js';
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
    // spec-0012 CLI-01 and CLI-05: help or the schema asked in an option position answers before any option is checked, so
    // it opens no workspace and reads no stdin. Each argument vector this changes was an IA-CLI-USAGE refusal at exit 2 before.
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
    door = new Door(root, { cache: false, allowReport: true });
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

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const version = (): string => {
  try {
    return (
      (JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version?: string }).version ??
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
};
/**
 * §2.8 rule 3's reader: one line from stdin, or null at EOF, on a closed stdin or on a stdin that errors. No
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
    // EOF with nothing typed is no answer at all, which §2.8 rule 3 declines; EOF after a line is that line.
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
    // §2.8 rule 3 and §5: a question needs a terminal at both ends, and it is written to stderr, never to stdout.
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
/**
 * §1.2 step 3. Private namespaces the public tree does not carry. tools/release/export.mjs rewrites this table
 * to an empty one and drops the import above, so no private token survives into the public main.ts; that rewrite
 * now throws on a miss instead of no-opping, and tools/release/export.test.ts asserts the emitted file as well.
 * The help text is composed from this table, so emptying it also empties the line that advertised it.
 */
export const EXTENSIONS: readonly Extension[] = [];

if (isEntry(process.argv[1], import.meta.url)) {
  // §5: a closed stdout is a normal end of output. The three moves are apps/mcp-door/src/main.ts:27-30 and :35.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    process.stdin.destroy();
    if (error.code !== 'EPIPE') throw error;
  });
  try {
    const result = await dispatch(process.argv.slice(2), host(new AbortController()), runCli, EXTENSIONS);
    if (result.stderr !== '') process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
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
