import fs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { RunnerError } from './errors.js';

const RESPONSE_BYTES = 65536;
const same = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const refuse = (message: string): never => {
  throw new RunnerError('IA-RUNNER-ARGUMENT', message, 'ia-runner --help');
};

/** An explicit local response is data: read at most 64 KiB from one unchanged regular file. */
export function readResponseFile(path: string): string {
  try {
    const before = fs.lstatSync(path, { bigint: true });
    if (!before.isFile()) refuse('Response must be a regular file');
    if (before.size > BigInt(RESPONSE_BYTES)) refuse('Response file exceeds 64 KiB');
    const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!same(before, fs.fstatSync(fd, { bigint: true }))) refuse('Response file changed before reading');
      const buffer = Buffer.alloc(RESPONSE_BYTES);
      let total = 0;
      while (total < buffer.byteLength) {
        const count = fs.readSync(fd, buffer, total, buffer.byteLength - total, null);
        if (count === 0) break;
        total += count;
      }
      // The fixed buffer bounds reads even if the file grows after either metadata check.
      if (
        BigInt(total) !== before.size ||
        !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(path, { bigint: true }))
      )
        refuse('Response file changed while reading');
      return buffer.toString('utf8', 0, total);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    return refuse('Response file is unavailable or changed');
  }
}
