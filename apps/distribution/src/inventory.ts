import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { unaliased } from '@inventarch/db';
import { metadataDigest } from '@inventarch/db/distribution';

const required = ['archive', 'pack', 'resolve', 'snapshot', 'install', 'installation-core', 'inventory', 'transfer'];
const runtime = /\.(?:[cm]?[jt]sx?|json|node|wasm)$/;
const declaration = /\.d\.[cm]?ts$/;
function refuse(): never {
  throw new Error('Installed distribution runtime is missing, mixed or aliased');
}
/**
 * A name that reaches nothing: removed once it was listed, or listed under a name that is not UTF-8, which Node decodes
 * lossily on Linux.
 */
const unreached = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
/** The entries of `directory`; a directory its listed name no longer reaches refuses. */
function listed(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (unreached(error)) return refuse();
    throw error;
  }
}
/** The lstat of `path`, which is never opened; a name that no longer reaches an entry refuses. */
function present(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    if (unreached(error)) return refuse();
    throw error;
  }
}
/**
 * The bytes of the runtime file at `path`. It is opened before it is judged, so the file judged is the file hashed (CodeQL
 * js/file-system-race): never through a link where the platform refuses one at the open, never waiting on a FIFO, read
 * through that descriptor no further than one byte past its size, and still the file at `path` afterwards, which on
 * Windows, without either open flag, is the one link check. Hard links are admitted, as pnpm's store links every installed
 * file, so its change time is not compared: linking the same store file elsewhere changes it but no byte. Every failure,
 * an open that fails included, is the one refusal.
 */
function runtimeBytes(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return refuse();
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return refuse();
    // No file of more than 2147483647 bytes is read, as readFileSync read none, and no read asks readSync for more.
    if (opened.size > 0x7fffffffn) return refuse();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, Math.min(bytes.length - length, 0x7fffffff), null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    let named: BigIntStats;
    try {
      named = lstatSync(path, { bigint: true });
    } catch {
      return refuse();
    }
    if (
      !named.isFile() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      BigInt(length) !== opened.size
    )
      return refuse();
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Explicit installed byte inventory. A root override is trusted qualification configuration only. */
export function installedDistributionDigest(root = import.meta.dirname): string {
  if (!isAbsolute(root) || root.split(/[\\/]/).some((part) => part === '.' || part === '..')) return refuse();
  root = resolve(root);
  const volume = parse(root).root;
  let current = volume;
  for (const part of relative(volume, root).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    // Another case or normalization of an existing name is the same directory (crowncodes/ia#315); a link is refused on its own.
    if (lstatSync(current).isSymbolicLink() || !unaliased(current, realpathSync.native(current))) return refuse();
  }
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return refuse();
  const files: { path: string; sha256: string }[] = [],
    names = new Set<string>();
  function visit(directory: string): void {
    for (const entry of listed(directory)) {
      const absolute = resolve(directory, entry.name),
        path = relative(root, absolute).replaceAll('\\', '/'),
        key = path.toLowerCase(),
        hashed = runtime.test(entry.name) && !declaration.test(entry.name),
        // A runtime file the listing reports is judged by the descriptor it is hashed through. Any other entry is judged by
        // its lstat, as before: Windows lists every reparse point as a link, so only a real link refuses as one, and a name
        // that no longer reaches its entry refuses rather than passing unread.
        kind = entry.isFile() && hashed ? entry : present(absolute);
      if (names.has(key) || kind.isSymbolicLink() || path.normalize('NFC') !== path) return refuse();
      names.add(key);
      if (kind.isDirectory()) visit(absolute);
      else if (!kind.isFile()) refuse();
      else if (hashed) files.push({ path, sha256: createHash('sha256').update(runtimeBytes(absolute)).digest('hex') });
    }
  }
  visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const source = files.some((file) => /\.[cm]?tsx?$/.test(file.path)),
    emitted = files.some((file) => /\.[cm]?jsx?$/.test(file.path));
  if (source === emitted || !required.every((name) => names.has(`${name}.${source ? 'ts' : 'js'}`))) return refuse();
  return metadataDigest({ version: 'ia-distribution-runtime-v1', kind: source ? 'source' : 'emitted', files });
}
