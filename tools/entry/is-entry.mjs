import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the process entry named by `argv1`: a tool calls it with `process.argv[1]` and
 * `import.meta.url`. It is the same function as `isEntry` in `@inventarch/runtime/entry`, kept here without dependencies so a
 * tool that imports it hashes one more file rather than the runtime's closure. Node loads an entry from its real path,
 * so the path as invoked is compared first and real paths only when it misses. Only a path that names no file (missing,
 * through a file, or a name too long) means "not the entry"; any other failure to resolve one throws rather than letting
 * a tool exit 0 having done nothing.
 * @param {string | undefined} argv1
 * @param {string} moduleUrl
 * @returns {boolean}
 */
export function isEntry(argv1, moduleUrl) {
  if (argv1 === undefined) return false;
  const self = fileURLToPath(moduleUrl);
  if (resolve(argv1) === self) return true;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? ''))
      return false;
    throw error;
  }
}
