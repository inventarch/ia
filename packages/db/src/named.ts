import { lstatSync } from 'node:fs';
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
