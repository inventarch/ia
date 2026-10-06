import type { ProjectionFile } from './projection-format.js';

/** Bundled deterministic read-only routine. No imports from a checkout, network or effect runner. */
export function resourceVerifier(files: readonly Pick<ProjectionFile, 'path' | 'bytes' | 'sha256'>[]): string {
  return `import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
// Built-in-only equivalent of packages/db/src/paths.ts unaliased/linked; same owner policy.
function linked(path) {
  const absolute = resolve(path), volume = parse(absolute).root; let current = volume;
  for (const part of absolute.slice(volume.length).split(/[\\\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  }
  return false;
}
function unaliased(path, real) {
  if (path === real) return true;
  if (process.platform === 'win32') return resolve(path).toLowerCase() === real.toLowerCase() && !linked(resolve(path));
  return path === resolve(path) && !linked(path);
}
const inventory = ${JSON.stringify(files)};
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--root' || !isAbsolute(process.argv[3])) throw new Error('Usage: verify-resources.mjs --root <absolute product directory>');
  const supplied = process.argv[3], root = resolve(supplied);
  const actualRoot = realpathSync.native(root);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || (process.platform !== 'win32' && supplied !== root) || !unaliased(root, actualRoot)) throw new Error('Product root is unavailable or aliased; supply its trusted canonical physical path');
  for (const file of inventory) {
    const path = resolve(root, file.path), rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Resource escapes product root');
    let current = root;
    for (const part of rel.split(sep)) { current = resolve(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('Resource path is aliased'); }
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes || file.bytes > 1048576) throw new Error('Resource is missing, aliased or has changed size: ' + file.path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const same = (stat) => stat.isFile() && stat.nlink === 1 && before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size && before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs;
      if (!same(fstatSync(fd))) throw new Error('Resource changed before read: ' + file.path);
      const bytes = Buffer.alloc(file.bytes + 1); let length = 0;
      while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
      if (length !== file.bytes || !same(fstatSync(fd)) || !same(lstatSync(path)) || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== file.sha256) throw new Error('Resource changed: ' + file.path);
    } finally { closeSync(fd); }
  }
  process.stdout.write(JSON.stringify({ status: 'verified', files: inventory.length, effectAuthority: 'none' }) + '\\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'refused', code: 'IA-SKILL-RESOURCE-INVALID', message: error.message }) + '\\n');
  process.exitCode = 1;
}
`;
}
