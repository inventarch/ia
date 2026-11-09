import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';

/** `path`, when present, is the workspace-relative file the refusal concerns, so a caller can locate it without parsing the message. */
export class DistributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'DistributionError';
  }
}
export function fail(code: string, message: string): never {
  throw new DistributionError(`IA-DIST-${code}`, message);
}
/**
 * Run `work` for one file; a refusal it raises without a location is re-raised naming `path`, its code and message
 * unchanged. That covers the codec's own coded refusals too (`decodeDistributionJson` raises `IA-DB-*`), so a file
 * that does not even parse is located like one that parses into the wrong shape.
 */
export function locate<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DistributionError) {
      if (error.path === undefined) throw new DistributionError(error.code, error.message, path);
      throw error;
    }
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^IA-/.test(error.code) &&
      !('path' in error)
    )
      throw new DistributionError(error.code, error.message, path);
    throw error;
  }
}
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const digest = (value: unknown): string => sha256(stableSerialize(value));
/** Plain transport JSON; digests use graph's separately typed stable serializer. */
export const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return item;
  }) + '\n';
export function portable(path: string): string {
  if (
    !path ||
    path !== path.normalize('NFC') ||
    path.length > 1024 ||
    /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    fail('PATH-UNSAFE', `Unsafe relative path: ${path}`);
  return path;
}
/** Checks every existing ancestor, including the caller-selected absolute root. */
export function contained(root: string, path = ''): string {
  const absolute = resolve(root),
    volume = parse(absolute).root;
  let current = volume;
  for (const segment of absolute.slice(volume.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      fail('PATH-UNSAFE', `Link/junction is not allowed: ${current}`);
  }
  for (const segment of path ? portable(path).split('/') : []) {
    current = join(current, segment);
    // lstat also detects dangling links; existsSync alone does not.
    try {
      if (lstatSync(current).isSymbolicLink()) fail('PATH-UNSAFE', `Link/junction is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}
export function workspace(path: string): string {
  if (!isAbsolute(path)) fail('INPUT-INVALID', 'An absolute --root is required');
  const result = contained(path);
  if (!existsSync(result) || !lstatSync(result).isDirectory())
    fail('INPUT-INVALID', 'Workspace root must be an existing directory');
  return realpathSync(result);
}
export function bytes(root: string, path: string, limit = 1024 * 1024): Buffer | null {
  const target = contained(root, path);
  try {
    return unaliased(target, path, lstatSync(target), limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/**
 * The bytes of `target`, which `stat` (its own lstat, taken by the caller) says is an unaliased regular file within `limit`;
 * `path` names it in refusals. Containment is the caller's: `bytes` checks it first, and a walk that has already checked
 * every level above `target` passes the lstat it took rather than walking the path again.
 */
export function unaliased(target: string, path: string, stat: Stats, limit: number): Buffer {
  if (!stat.isFile() || stat.nlink !== 1) fail('PATH-UNSAFE', `Expected unaliased regular file: ${path}`);
  if (stat.size > limit) fail('LIMIT-EXCEEDED', `File exceeds ${limit} bytes: ${path}`);
  const content = readFileSync(target);
  if (content.length > limit) fail('LIMIT-EXCEEDED', `File grew beyond its bound: ${path}`);
  return content;
}
export function utf8(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return fail('INPUT-INVALID', 'Expected exact UTF-8 bytes');
  }
}
export function syncDirectory(path: string): void {
  // Windows does not expose fsync on directory handles. File flush + same-volume
  // rename is the available primitive there; crash qualification records the OS.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** `mode` defaults to owner-only; a caller writing public static data (a registry) passes 0o644. It is set explicitly, so umask does not narrow it. */
export function replace(root: string, path: string, content: Buffer | null, mode = 0o600): void {
  const target = contained(root, path);
  if (content === null) {
    if (existsSync(target)) {
      unlinkSync(target);
      syncDirectory(dirname(target));
    }
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  contained(root, path);
  const temp = drafted(target, content, mode);
  try {
    renameSync(temp, target);
    syncDirectory(dirname(target));
  } finally {
    rmSync(temp, { force: true });
  }
}
/**
 * A complete, fsynced temporary sibling of `target` holding `content`, which `replace` renames and `createFile` links
 * into place. A step that fails removes it again, so a failed write leaves no temporary file. Neither publisher locks
 * the target: a writer that saves it between a caller's last read and the rename is replaced, which a caller narrows
 * by reading the file through an opened handle just before (as `ia author` does) but cannot close.
 */
function drafted(target: string, content: Buffer, mode: number): string {
  const temp = `${target}.${randomUUID()}.tmp`,
    fd = openSync(temp, 'wx', mode);
  try {
    try {
      if (mode !== 0o600) fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return temp;
}
/** Publish one complete draft file without replacing an existing directory entry. */
export function createFile(root: string, path: string, content: Buffer, mode = 0o600): void {
  const target = contained(root, path);
  mkdirSync(dirname(target), { recursive: true });
  contained(root, path);
  const temp = drafted(target, content, mode);
  try {
    linkSync(temp, target);
    syncDirectory(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('LOCAL-MODIFICATION', 'Draft output already exists');
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}
export function canonicalJson(content: Buffer): unknown {
  const text = utf8(content);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('INPUT-INVALID', 'Malformed managed JSON');
  }
  if (json(value) !== text) fail('INPUT-INVALID', 'Managed JSON must use exact canonical encoding');
  return value;
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    fail('INPUT-INVALID', 'Unexpected managed object fields');
  return value as Record<string, unknown>;
}
/**
 * A document that declares a plain `format` name and an integer `formatVersion` (decision dec-005), or one of the exact
 * legacy literals written before that change (no `formatVersion`; an explicit allow-list mapping each literal to the
 * version it stood for, never suffix parsing). `keys` are the fields besides `format`/`formatVersion`. Returns the row,
 * the version it carries and the legacy literal read (null for the plain shape); a different format, or a plain format
 * with a version not in `versions`, refuses with `message`.
 */
export function versionedDocument(
  value: unknown,
  spec: {
    readonly format: string;
    readonly versions: readonly number[];
    readonly legacy: Readonly<Record<string, number>>;
  },
  keys: readonly string[],
  message = 'Unexpected managed object fields',
): { readonly row: Record<string, unknown>; readonly version: number; readonly legacy: string | null } {
  const declared =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['format']
      : undefined;
  if (declared === spec.format) {
    const row = object(value, ['format', 'formatVersion', ...keys]),
      version = row['formatVersion'];
    if (typeof version !== 'number' || !spec.versions.includes(version)) fail('INPUT-INVALID', message);
    return { row, version, legacy: null };
  }
  const literal = typeof declared === 'string' && Object.hasOwn(spec.legacy, declared) ? declared : undefined;
  if (literal === undefined) fail('INPUT-INVALID', message);
  return { row: object(value, ['format', ...keys]), version: spec.legacy[literal]!, legacy: literal };
}
/** `versionedDocument` for a format that has only one version. */
export function versionedObject(
  value: unknown,
  spec: { readonly format: string; readonly version: number; readonly legacy: readonly string[] },
  keys: readonly string[],
  message?: string,
): { readonly row: Record<string, unknown>; readonly legacy: string | null } {
  const { row, legacy } = versionedDocument(
    value,
    {
      format: spec.format,
      versions: [spec.version],
      legacy: Object.fromEntries(spec.legacy.map((literal) => [literal, spec.version])),
    },
    keys,
    message,
  );
  return { row, legacy };
}
