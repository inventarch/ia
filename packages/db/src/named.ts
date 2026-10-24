import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';

/**
 * What `path` names now, with full-width identities, or undefined when it names nothing: ENOENT, or ENOTDIR where a
 * directory on the way has become a file. A reader that checks after its read whether a name still names the file it
 * opened refuses both as a name that no longer names it. Any other failure is thrown.
 */
export function lstatNamed(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}
/**
 * The flags a db reader that opens a name before it judges what is there opens it with, read-only: NOFOLLOW refuses a
 * final link, NONBLOCK keeps a FIFO from blocking the open, and NOCTTY keeps a terminal opened there from becoming the
 * process's controlling terminal before it is refused; a flag a platform lacks is zero. `readOpened`, the evidence
 * reader, the corpus source walk and the capture pair reader all open with it, so a flag added for one reaches the
 * others. Internal to the package.
 */
export const OPENED_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
/**
 * Whether an open with `OPENED_READ_FLAGS` follows a final link, as it does where the platform has no no-follow flag
 * (Windows). A reader whose open would refuse a link put at a name after its check then checks, once it has read the
 * file, that the name still names it: the name's identity is its only guard against such a link there. Internal.
 */
export const OPENS_THROUGH_LINKS = (constants.O_NOFOLLOW ?? 0) === 0;
/** What `readOpened` read: the opened file's stats before and after the read, and the bytes read in between. */
export interface OpenedRead {
  /** The opened file's stats, taken before any byte of it is read. */
  readonly opened: BigIntStats;
  /** The bytes read: at most `opened.size` and one byte more, which only a concurrent writer can supply. */
  readonly bytes: Buffer;
  /** The opened file's stats, taken again after the read. */
  readonly after: BigIntStats;
}
/** How a reader judges the file `readOpened` opens at a name. Each judgment refuses by throwing. */
export interface OpenedJudgment<Unopened, Read> {
  /** What the read returns when the name does not open, from the open's error. */
  readonly unopened: (error: NodeJS.ErrnoException) => Unopened;
  /** Judges the opened file before any byte of it is read. */
  readonly opened: (stat: BigIntStats) => void;
  /** Judges a read that failed; without it, the read's error is thrown as it is. */
  readonly unread?: (error: unknown) => never;
  /** Judges a read that brought more bytes than the opened file's size, before it is stated again. */
  readonly grew?: () => never;
  /** What the read returns, from what it read; it runs while the file is still open. */
  readonly read: (read: OpenedRead) => Read;
}
/**
 * Reads the file at `path` through one descriptor, so a reader's judgment and the bytes are of one file (CodeQL
 * js/file-system-race). The name is opened with `OPENED_READ_FLAGS` before the file is judged. The read allocates and
 * reads the size the opened file is judged at and one byte more, and the file is stated again after it. The descriptor
 * stays open until `read` returns or anything throws, so a check of the name in `read` compares identities with the file
 * still held.
 */
export function readOpened<Unopened, Read>(path: string, judgment: OpenedJudgment<Unopened, Read>): Unopened | Read {
  let fd: number;
  try {
    fd = openSync(path, OPENED_READ_FLAGS);
  } catch (error) {
    return judgment.unopened(error as NodeJS.ErrnoException);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    judgment.opened(opened);
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    try {
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
    } catch (error) {
      judgment.unread?.(error);
      throw error;
    }
    if (BigInt(length) > opened.size) judgment.grew?.();
    return judgment.read({ opened, bytes: bytes.subarray(0, length), after: fstatSync(fd, { bigint: true }) });
  } finally {
    closeSync(fd);
  }
}
