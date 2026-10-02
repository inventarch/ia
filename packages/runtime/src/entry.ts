import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the process entry named by `argv1` (pass `process.argv[1]` and
 * `import.meta.url`). Node loads an entry from its real path, while npm's `.bin` entries, global installs and pnpm's
 * store links reach it through a link, so the path as invoked is compared first and real paths only when it misses.
 * A path that names no file (it does not exist, runs through a file, or has a name too long for the file system) is not
 * the entry; any other failure to resolve one throws rather than letting a binary exit 0 having done nothing.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  const self = fileURLToPath(moduleUrl);
  if (resolve(argv1) === self) return true;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
