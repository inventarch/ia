import { once } from 'node:events';
import { lstatSync, mkdirSync, openSync, readSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';

// Helpers for reader tests that put special files in place or change a file while it is read. A helper that replaces a
// `node:fs` function works on the mock of it that the calling test file declares in its own `vi.mock('node:fs')`.

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
/** The thrown value, or the result when nothing is thrown. */
export const outcome = (read: () => unknown): unknown => {
  try {
    return read();
  } catch (error) {
    return error;
  }
};
/** A FIFO at the absolute `path` (POSIX). */
export const fifo = async (path: string): Promise<void> => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  expect((await runBounded('mkfifo', [path], { timeoutMs: SUBPROCESS })).status).toBe(0);
};
/** A Unix socket file at the absolute `path` (POSIX), bound at a short name in `root` first: a socket path holds ~100 bytes. */
export const socket = async (root: string, path: string): Promise<void> => {
  const server = createServer(),
    bound = resolve(root, 's');
  server.listen(bound);
  await once(server, 'listening');
  mkdirSync(resolve(path, '..'), { recursive: true });
  renameSync(bound, path);
  server.close();
  await once(server, 'close');
};
/**
 * Lets `openSync` run as it does, after `before`, except an open that would wait for a FIFO's writer: that one is recorded
 * and refused instead, so a reader that opens a FIFO without O_NONBLOCK fails its test rather than blocking the runner.
 */
export const blockingOpens = async (before: (path: string) => void = () => {}): Promise<readonly string[]> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs'),
    blocking: string[] = [];
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    const [path, flags] = args;
    before(String(path));
    if (
      (typeof flags !== 'number' || (flags & actual.constants.O_NONBLOCK) === 0) &&
      actual.lstatSync(path, { throwIfNoEntry: false })?.isFIFO()
    ) {
      blocking.push(String(path));
      throw Object.assign(new Error(`EAGAIN: an open that waits for a FIFO writer, open '${String(path)}'`), {
        code: 'EAGAIN',
      });
    }
    return actual.openSync(...args);
  });
  return blocking;
};
/**
 * After the reader's first `readSync` returns, moves `directory` away and puts a regular file at its name, so the lstat
 * of a name under it fails with ENOTDIR. POSIX only: Windows does not rename a directory that holds an open file, and
 * there a path through a file is missing (ENOENT).
 */
export const directoryBecomesFile = async (directory: string): Promise<void> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let calls = 0;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = actual.readSync(...args);
    if (++calls === 1) {
      actual.renameSync(directory, `${directory}.moved`);
      actual.writeFileSync(directory, 'not a directory');
    }
    return count;
  });
};
/** Whether an lstat call asks for full-width stats, as the readers' own lstat of a name after its read does. */
const fullWidth = (args: Parameters<typeof lstatSync>): boolean =>
  (args[1] as { bigint?: boolean } | undefined)?.bigint === true;
/** Removes `file` just before the reader's own full-width lstat of it: the recheck after its read. */
export const vanishAtRecheck = async (file: string): Promise<void> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
    if (String(args[0]) === file && fullWidth(args) && actual.existsSync(file)) actual.rmSync(file);
    return actual.lstatSync(...args);
  });
};
/** Reports another device, the inode unchanged, at every full-width lstat of `file`. */
export const otherDevice = async (file: string): Promise<void> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
    const stat = actual.lstatSync(...args);
    return String(args[0]) === file && typeof stat?.dev === 'bigint'
      ? Object.assign(stat, { dev: stat.dev + 1n })
      : stat;
  });
};
/** The descriptors opened for `file`, in order, as it is opened. */
export const descriptors = async (file: string): Promise<readonly number[]> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs'),
    opened: number[] = [];
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    const fd = actual.openSync(...args);
    if (String(args[0]) === file) opened.push(fd);
    return fd;
  });
  return opened;
};
