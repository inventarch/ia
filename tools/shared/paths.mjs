import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** @param {unknown} error */
const missing = (error) => /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';

/** A portable relative file path below a real directory; inspect existing ancestors even for new outputs.
 * @param {string} root @param {string} path @param {{allowMissing?: boolean}} [options]
 */
export function containedFile(root, path, { allowMissing = false } = {}) {
  if (
    !path ||
    path !== path.normalize('NFC') ||
    /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Unsafe contained file path: ' + path);
  if (!lstatSync(root).isDirectory()) throw new Error('Repository root is not a directory');
  const target = resolve(root, path);
  for (let current = target; ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw new Error('Aliased or hardlinked path: ' + current);
      if (current === target ? !stat.isFile() : !stat.isDirectory())
        throw new Error('Unexpected file kind: ' + current);
    } catch (error) {
      if (!allowMissing || !missing(error)) throw error;
    }
    if (dirname(current) === current) break;
  }
  return target;
}

/** Read one bounded regular file through a stable descriptor; the returned bytes never exceed the ceiling.
 * @param {string} root @param {string} path @param {number} limit @returns {Buffer}
 */
export function readRegular(root, path, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid file byte ceiling');
  const target = containedFile(root, path),
    before = lstatSync(target);
  if (before.size > limit) throw new Error('Unbounded file: ' + path);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit)
      throw new Error('Aliased or changed file: ' + path);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0,
      count;
    do {
      count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
    } while (count && length < bytes.length);
    const after = fstatSync(fd),
      retained = lstatSync(containedFile(root, path));
    if (
      length !== stat.size ||
      [after, retained].some(
        (value) =>
          value.ino !== stat.ino ||
          value.dev !== stat.dev ||
          value.size !== stat.size ||
          value.mtimeMs !== stat.mtimeMs ||
          value.nlink !== 1,
      )
    )
      throw new Error('File changed during read: ' + path);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
