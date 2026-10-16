import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const PUBLICATION_CODES = [
  'IA-PUBLICATION-INVALID',
  'IA-PUBLICATION-PATH-UNSAFE',
  'IA-PUBLICATION-CONFLICT',
  'IA-PUBLICATION-BUSY',
  'IA-PUBLICATION-UNAVAILABLE',
] as const;
export class PublicationError extends Error {
  constructor(
    readonly code: (typeof PUBLICATION_CODES)[number],
    message: string,
  ) {
    super(message);
    this.name = 'PublicationError';
  }
}
export interface PublicationFile {
  readonly path: string;
  readonly text: string;
}
export interface PreparedPublication {
  publish(): string;
  close(): void;
}
export type PublicationStatus = 'absent' | 'applied' | 'partial' | 'unknown';
const fail = (code: PublicationError['code'], message: string): never => {
  throw new PublicationError(code, message);
};
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const require = createRequire(import.meta.url),
  localVolumes = new Set<string>();

export function portableDraftPath(value: unknown): string {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || Buffer.from(value).toString('utf8') !== value)
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Expected a portable Unicode path');
  const parts = value.split('/');
  if (
    parts.some(
      (s) =>
        !s ||
        s === '.' ||
        s === '..' ||
        /[\u0000-\u001f<>:"|?*\\]/.test(s) ||
        /[. ]$/.test(s) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s),
    ) ||
    parts[0]!.toLowerCase() === 'result.json'
  )
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Unsafe or reserved draft path');
  return value;
}
function safe(root: string, path: string): string {
  const target = resolve(root, path),
    rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Path escapes the managed root');
  for (let current = target; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink())
        return fail('IA-PUBLICATION-PATH-UNSAFE', 'Filesystem aliases are unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
  return target;
}
/** Read-only host qualification of the canonical root and supported filesystem. */
export function qualifyPublicationRoot(root: string): string {
  const base = resolve(root);
  if (process.platform !== 'win32' || !/^[a-z]:\\/i.test(base) || !existsSync(base))
    return fail('IA-PUBLICATION-UNAVAILABLE', 'Managed publication requires a qualified local Windows NTFS root');
  safe(base, '');
  if (realpathSync.native(base).toLowerCase() !== base.toLowerCase() || !lstatSync(base).isDirectory())
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Managed root is not a canonical directory');
  const drive = base.slice(0, 2).toUpperCase();
  if (!localVolumes.has(drive)) {
    try {
      // The only interpolation is a validated drive letter, never authored/model text.
      // Query the drive directly; CIM adds a cold WMI service dependency to every CLI process.
      const script = `$ErrorActionPreference='Stop'; $drive=[System.IO.DriveInfo]::new('${drive}\\'); @{DriveType=[int]$drive.DriveType; FileSystem=$drive.DriveFormat} | ConvertTo-Json -Compress`;
      // Cold PowerShell startup exceeded 10s on Windows CI (35559311967).
      // Keep qualification bounded and fail closed; only successful probes are cached.
      const info = JSON.parse(
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000,
        }).trim(),
      ) as { DriveType?: number; FileSystem?: string };
      if (info?.DriveType !== 3 || info.FileSystem !== 'NTFS')
        return fail('IA-PUBLICATION-UNAVAILABLE', 'Remote or unqualified publication filesystem');
      localVolumes.add(drive);
    } catch (error) {
      if (error instanceof PublicationError) throw error;
      return fail(
        'IA-PUBLICATION-UNAVAILABLE',
        `Cannot qualify the publication filesystem: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return base;
}
function destinationPath(root: string, destination: string): string {
  if (!/^\.ia\/work\/generated\/[a-z0-9][a-z0-9-]{0,100}$/.test(destination))
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Destination must be one managed draft directory');
  portableDraftPath(destination);
  return safe(root, destination);
}
function checkedFiles(files: readonly PublicationFile[], metadata: string): readonly PublicationFile[] {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 16 ||
    typeof metadata !== 'string' ||
    Buffer.byteLength(metadata) > 2 * 1024 * 1024 ||
    Buffer.from(metadata).toString('utf8') !== metadata
  )
    return fail('IA-PUBLICATION-INVALID', 'Publication exceeds its bounded contract');
  const paths = new Set<string>();
  let bytes = 0;
  const snapshot = files.map((file) => {
    if (!file || typeof file !== 'object') return fail('IA-PUBLICATION-INVALID', 'Invalid draft file');
    const path = portableDraftPath(file.path),
      key = path.toLowerCase();
    if (paths.has(key) || [...paths].some((p) => p.startsWith(key + '/') || key.startsWith(p + '/')))
      return fail('IA-PUBLICATION-PATH-UNSAFE', 'Draft paths collide');
    paths.add(key);
    if (
      typeof file.text !== 'string' ||
      Buffer.from(file.text).toString('utf8') !== file.text ||
      Buffer.byteLength(file.text) > 1024 * 1024
    )
      return fail('IA-PUBLICATION-INVALID', 'Invalid or oversized draft bytes');
    bytes += Buffer.byteLength(file.text);
    return { path, text: file.text };
  });
  if (bytes > 2 * 1024 * 1024) return fail('IA-PUBLICATION-INVALID', 'Draft byte limit exceeded');
  return snapshot;
}
function acquire(root: string, destination: string): DatabaseSync {
  const locks = safe(root, '.ia/work/publication-locks');
  mkdirSync(locks, { recursive: true });
  safe(root, '.ia/work/publication-locks');
  const file = safe(root, `.ia/work/publication-locks/${hash(destination)}.sqlite`);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    safe(root, relative(root, file + suffix));
    if (existsSync(file + suffix) && (!lstatSync(file + suffix).isFile() || lstatSync(file + suffix).nlink !== 1))
      return fail('IA-PUBLICATION-PATH-UNSAFE', 'Destination lock is aliased');
  }
  // Lazy loading keeps unrelated runtime/CLI consumers free of SQLite initialization.
  const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new Database(file);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db?.close();
    if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error)))
      return fail('IA-PUBLICATION-BUSY', 'Another publisher owns this destination');
    return fail('IA-PUBLICATION-UNAVAILABLE', 'Destination ownership is unavailable');
  }
}
function flush(path: string, text: string): void {
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * Read-only; NOFOLLOW refuses a final link and NONBLOCK keeps a FIFO from blocking the open. Windows defines neither
 * flag, so `?? 0` makes both zero there: it opens through a link, and the identity recheck after the read refuses it.
 */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/**
 * The bytes of the file opened as `fd` from `path`, read through the descriptor: undefined when it is not a regular file
 * of at most `limit` bytes, or when after the read it has another size or `path` names another file; a `path` that names
 * nothing by then throws. At most its size and one byte more are read. The judgment and the bytes are of one file (CodeQL
 * js/file-system-race).
 */
function readOpened(fd: number, path: string, limit: number): Buffer | undefined {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(limit)) return undefined;
  const bytes = Buffer.alloc(Number(stat.size) + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  // On Windows, which opens through a link, the name's identity is the only guard against a link placed after the path
  // check.
  const after = fstatSync(fd, { bigint: true }),
    named = lstatSync(path, { bigint: true });
  return BigInt(length) === stat.size &&
    after.size === stat.size &&
    named.isFile() &&
    named.dev === stat.dev &&
    named.ino === stat.ino
    ? bytes.subarray(0, length)
    : undefined;
}
function cleanup(root: string, stage: string): void {
  const parent = resolve(root, '.ia/work/generated'),
    rel = relative(parent, stage);
  if (isAbsolute(rel) || !/^\.stage-[a-zA-Z0-9]+$/.test(rel))
    return fail('IA-PUBLICATION-PATH-UNSAFE', 'Unsafe staging cleanup');
  safe(root, relative(root, stage));
  rmSync(stage, { recursive: true, force: true });
}

/** Trusted host primitive. Hold this object through the last authority check and always close it. */
export function preparePublication(
  root: string,
  destination: string,
  files: readonly PublicationFile[],
  metadata: string,
): PreparedPublication {
  const snapshot = checkedFiles(files, metadata),
    base = qualifyPublicationRoot(root),
    target = destinationPath(base, destination),
    lock = acquire(base, destination);
  let stage: string | undefined,
    closed = false,
    published = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      if (stage) cleanup(base, stage);
    } finally {
      lock.close();
    }
  };
  try {
    if (existsSync(target)) return fail('IA-PUBLICATION-CONFLICT', 'Draft destination already exists');
    const parent = safe(base, '.ia/work/generated');
    mkdirSync(parent, { recursive: true });
    safe(base, '.ia/work/generated');
    stage = mkdtempSync(resolve(parent, '.stage-'));
    for (const file of [...snapshot, { path: 'result.json', text: metadata }]) {
      const path = safe(base, relative(base, resolve(stage, file.path)));
      mkdirSync(dirname(path), { recursive: true });
      safe(base, relative(base, path));
      flush(path, file.text);
    }
    return {
      close,
      publish: () => {
        if (closed || published || !lock.isTransaction)
          return fail('IA-PUBLICATION-UNAVAILABLE', 'Destination ownership is unavailable');
        destinationPath(base, destination);
        safe(base, relative(base, stage!));
        try {
          // mkdir is the no-replace claim; rename never decides whether a destination is ours.
          mkdirSync(target);
          for (const file of [...snapshot, { path: 'result.json', text: metadata }]) {
            const to = safe(base, `${destination}/${file.path}`),
              from = safe(base, relative(base, resolve(stage!, file.path)));
            mkdirSync(dirname(to), { recursive: true });
            safe(base, `${destination}/${file.path}`);
            linkSync(from, to);
          }
          published = true;
          return destination;
        } catch (error) {
          if (error instanceof PublicationError) throw error;
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            return fail('IA-PUBLICATION-CONFLICT', 'Draft destination or file already exists');
          return fail('IA-PUBLICATION-UNAVAILABLE', 'Publication incomplete; inspect before any retry');
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Acquiring the destination lock proves no cooperating earlier publisher can still apply. */
export async function inspectPublication(
  root: string,
  destination: string,
  files: readonly PublicationFile[],
  metadata: string,
  assertCurrent: () => Promise<void>,
): Promise<PublicationStatus> {
  const snapshot = checkedFiles(files, metadata),
    base = qualifyPublicationRoot(root),
    target = destinationPath(base, destination),
    lock = acquire(base, destination);
  try {
    await assertCurrent();
    destinationPath(base, destination);
    if (!existsSync(target)) return 'absent';
    if (!lstatSync(target).isDirectory()) return 'unknown';
    const marker = safe(base, `${destination}/result.json`);
    let fd: number;
    try {
      fd = openSync(marker, READ);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'partial';
      // A marker that is no regular file within its bound is unknown before any read, as one that opens is; Windows may
      // refuse to open a directory, and an unreadable marker past the bound is unknown, as it was when read by name.
      const named = lstatSync(marker);
      if (!named.isFile() || named.size > 2 * 1024 * 1024) return 'unknown';
      throw error;
    }
    try {
      if (readOpened(fd, marker, 2 * 1024 * 1024)?.toString('utf8') !== metadata) return 'unknown';
    } finally {
      closeSync(fd);
    }
    const expected = new Map([...snapshot.map((f) => [f.path, f.text] as const), ['result.json', metadata] as const]);
    const found: string[] = [];
    const walk = (path: string): boolean => {
      for (const entry of readdirSync(safe(base, `${destination}/${path}`), { withFileTypes: true })) {
        const child = path ? `${path}/${entry.name}` : entry.name,
          full = safe(base, `${destination}/${child}`);
        if (entry.isDirectory()) {
          if (![...expected.keys()].some((p) => p.startsWith(child + '/')) || !walk(child)) return false;
        } else if (entry.isFile()) {
          const text = expected.get(child);
          if (text === undefined) return false;
          const bytes = Buffer.from(text);
          let descriptor: number;
          try {
            descriptor = openSync(full, READ);
          } catch (error) {
            // As when it was read by name: a file of another size is partial before any read, and any other failure
            // throws; for a vanished entry that is the lstat's own error.
            if (lstatSync(full).size !== bytes.length) return false;
            throw error;
          }
          try {
            // One of another size or other bytes, or that its name no longer names, is partial.
            if (!readOpened(descriptor, full, bytes.length)?.equals(bytes)) return false;
          } finally {
            closeSync(descriptor);
          }
          found.push(child);
        } else return false;
      }
      return true;
    };
    return walk('') && found.length === expected.size ? 'applied' : 'partial';
  } finally {
    lock.close();
  }
}
