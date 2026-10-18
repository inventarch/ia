// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/** A portable relative file path below a real directory; inspect existing ancestors even for new outputs.
 * @param {string} root @param {string} path @param {{allowMissing?: boolean}} [options]
 */
export function containedFile(
  root: string,
  path: string,
  {
    allowMissing,
  }?: {
    allowMissing?: boolean;
  },
): string;
/** Read one bounded regular file through a stable descriptor; the returned bytes never exceed the ceiling.
 * @param {string} root @param {string} path @param {number} limit @returns {Buffer}
 */
export function readRegular(root: string, path: string, limit: number): Buffer;
