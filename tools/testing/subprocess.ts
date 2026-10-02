import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ResourceScope } from './resources.js';

/**
 * Bounded child processes for tests. A child is always owned: it runs in its own process group on
 * POSIX and is torn down with its descendants on Windows, so a hung grandchild cannot outlive the
 * test that started it.
 */

export interface BoundedOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
  /** Runs the command through the platform shell; only manifest-declared commands use this. */
  readonly shell?: boolean;
  /** Terminating the tree when this aborts; a race against a promise is not cancellation. */
  readonly signal?: AbortSignal;
  /** Optional live output, while retaining the bounded capture for diagnostics. */
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}
export interface BoundedResult {
  readonly command: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const OWN_GROUP = process.platform !== 'win32';

function childEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  // Nx can supply FORCE_COLOR alongside the runner's NO_COLOR. Node warns on every
  // descendant in that state, contaminating stderr contracts unrelated to colors.
  if (env['NO_COLOR'] !== undefined) delete env['FORCE_COLOR'];
  // An inherited NX_WORKSPACE_ROOT_PATH pins every nested Nx run to the caller's checkout, whatever `cwd` says.
  // A probe that builds a workspace in a temp directory then reads another tree's task cache and reports it as a
  // restore, so a cold-cache assertion fails against a workspace it never ran in. A child determines its own root.
  delete env['NX_WORKSPACE_ROOT_PATH'];
  return env;
}

/** Best-effort termination of a child and its descendants. A process that already exited is not an error. */
export function terminateTree(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
    // Enumeration can stall or fail on restricted hosts. Still terminate the direct child;
    // descendant termination remains best-effort when taskkill cannot walk the tree.
    if (killed.status !== 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
      return;
    } catch {
      /* already gone, or not a group leader */
    }
  }
}

type OwnedOptions = BoundedOptions;
/**
 * Starts a child the scope owns, under an explicit deadline. The deadline ends the process tree on its own
 * clock: a test body blocked on the child's output never lets the scope unwind, so disposal alone cannot be
 * the only thing that reaps it. Ending the child also closes its pipes, which settles a pending read.
 */
export function spawnOwned(
  scope: ResourceScope,
  label: string,
  command: string,
  args: readonly string[],
  options: OwnedOptions & { readonly stdio?: 'pipe' },
): ChildProcessWithoutNullStreams;
export function spawnOwned(
  scope: ResourceScope,
  label: string,
  command: string,
  args: readonly string[],
  options: OwnedOptions & { readonly stdio: 'ignore' },
): ChildProcess;
export function spawnOwned(
  scope: ResourceScope,
  label: string,
  command: string,
  args: readonly string[],
  options: OwnedOptions & { readonly stdio?: 'pipe' | 'ignore' },
): ChildProcess {
  if (!Number.isSafeInteger(options?.timeoutMs) || options.timeoutMs < 1)
    throw new Error('A bounded process requires a positive timeout');
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: childEnvironment(options.env),
    stdio: options.stdio ?? 'pipe',
    windowsHide: true,
    detached: OWN_GROUP,
  });
  const deadline = setTimeout(() => {
    terminateTree(child.pid);
  }, options.timeoutMs);
  deadline.unref?.();
  child.once('close', () => {
    clearTimeout(deadline);
  });
  scope.defer(label, () => {
    clearTimeout(deadline);
    terminateTree(child.pid);
  });
  return child;
}

/** Runs a command to completion under an explicit ceiling, then reports what actually happened. */
export async function runBounded(
  command: string,
  args: readonly string[],
  options: BoundedOptions,
): Promise<BoundedResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error('A bounded process requires a positive timeout');
  // Cancellation before dispatch must not start a process or its arbitrary side effects.
  // Preserve the owner's AbortSignal reason; in-flight aborts retain BoundedResult semantics.
  options.signal?.throwIfAborted();
  const limit = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
    started = performance.now();
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: childEnvironment(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: OWN_GROUP,
    shell: options.shell === true,
  });
  let stdout = '',
    stderr = '',
    truncated = false,
    timedOut = false;
  const collect = (stream: NodeJS.ReadableStream | null, append: (chunk: string) => void): void => {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      append(chunk);
    });
  };
  collect(child.stdout, (chunk) => {
    options.onStdout?.(chunk);
    if (stdout.length + chunk.length > limit) {
      truncated = true;
      stdout = (stdout + chunk).slice(0, limit);
    } else stdout += chunk;
  });
  collect(child.stderr, (chunk) => {
    options.onStderr?.(chunk);
    if (stderr.length + chunk.length > limit) {
      truncated = true;
      stderr = (stderr + chunk).slice(0, limit);
    } else stderr += chunk;
  });
  // A child may exit without reading its input. spawnSync tolerated that; an unhandled stdin error would abort the run.
  child.stdin?.on('error', () => {
    /* EPIPE: the child is gone, and its exit status is what the caller asserts */
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, options.timeoutMs);
  timer.unref?.();
  const onAbort = (): void => {
    terminateTree(child.pid);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });
    return {
      command: [command, ...args].join(' '),
      status: exit.code,
      signal: exit.signal,
      stdout,
      stderr,
      timedOut,
      truncated,
      durationMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    // Windows cannot walk a tree after its root has exited. Avoid a taskkill process
    // (and possible PID reuse) for every successful command. POSIX groups can outlive roots.
    if (process.platform !== 'win32' || (child.exitCode === null && child.signalCode === null))
      terminateTree(child.pid);
  }
}
