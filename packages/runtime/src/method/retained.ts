import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { MethodError } from './errors.js';
import { findKit, folderKits, iaHome } from './kits.js';
import type { Kit } from './kits.js';
import { canonical } from './packet.js';

/**
 * Retained method bytes: an exact copy of a kit and of its carrier's scripts and support files, stored by the digest of
 * its manifest under the closure store, so a pin keeps reading the bytes it resolved. The layout is the `ia` plugin's:
 * `config/kits/<folder>/...`, `scripts/...`, `.claude-plugin/plugin.json` and `config/qualified-process-tools.json`.
 */
const FORMAT = 'inventarch.method-bytes/1';
const SUPPORT = ['.claude-plugin/plugin.json', 'config/qualified-process-tools.json'] as const;
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => {
  throw new MethodError(message, 'IA-CORE-CLOSURE-INTEGRITY');
};

/** The closure store: IA_CORE_CLOSURES_DIR, else `<IA home>/method-closures-v1`. */
export const closureStore = (env: NodeJS.ProcessEnv = process.env): string =>
  env['IA_CORE_CLOSURES_DIR'] ? env['IA_CORE_CLOSURES_DIR'] : join(iaHome(env), 'method-closures-v1');

/** Read-only: NOFOLLOW refuses a final link and NONBLOCK keeps a FIFO from blocking the open; Windows has neither (zero). */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/**
 * The bytes of the regular file at `path`, of at most `limit` bytes, judged and read through one descriptor (CodeQL
 * js/file-system-race). Where the open follows a final link (Windows), the name must still name the file that was read.
 */
function readRegular(path: string, label: string, limit: number, tooLarge: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail(`method symlink is unsupported: ${label}`);
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) fail(`method content is not a file: ${label}`);
    if (opened.size > BigInt(limit)) fail(tooLarge);
    const data = readFileSync(fd);
    const named = lstatSync(path, { bigint: true });
    if (BigInt(data.length) !== opened.size || !named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino)
      fail(`method content changed while it was read: ${label}`);
    return data;
  } finally {
    closeSync(fd);
  }
}

interface Entry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
interface Loaded extends Entry {
  readonly data: Buffer;
}
function files(root: string): Loaded[] {
  const found: Loaded[] = [],
    folded = new Set<string>();
  let bytes = 0;
  const visit = (dir: string): void => {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`method directory is not regular: ${dir}`);
    const listed = readdirSync(dir, { withFileTypes: true }),
      types = new Map(listed.map((dirent) => [dirent.name, dirent]));
    for (const name of [...types.keys()].sort()) {
      if (name.includes('\\') || name.includes(':') || name.includes('\0')) fail('unsafe retained path');
      const path = join(dir, name),
        rel = relative(root, path).replace(/\\/g, '/');
      if (rel === '.ia/distributions' || rel === '.ia/work') continue;
      const key = rel.normalize('NFC').toLowerCase();
      if (folded.has(key)) fail(`case-fold collision in method: ${rel}`);
      folded.add(key);
      // The entry's type is the listing's; a file's is judged again on the descriptor its bytes are read through.
      const entry = types.get(name);
      if (entry?.isSymbolicLink()) fail(`method symlink is unsupported: ${rel}`);
      if (entry?.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry?.isFile()) fail(`method content is not a file: ${rel}`);
      const data = readRegular(path, rel, 16 * 1024 * 1024, 'retained method resource limit exceeded');
      bytes += data.length;
      if (bytes > 128 * 1024 * 1024 || found.length >= 10000) fail('retained method resource limit exceeded');
      found.push({ path: rel, sha256: sha(data), bytes: data.length, data });
    }
  };
  visit(root);
  return found;
}
const byPath = (a: Entry, b: Entry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const inventory = (root: string): Entry[] =>
  files(root)
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
    .sort(byPath);

function supportFiles(carrier: string): Loaded[] {
  return SUPPORT.map((path) => {
    const [folder, file] = path.split('/') as [string, string];
    const stat = lstatSync(join(carrier, folder));
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`core support input is not regular: ${path}`);
    const data = readRegular(join(carrier, folder, file), path, 256 * 1024, `core support input is too large: ${path}`);
    return { path, sha256: sha(data), bytes: data.length, data };
  });
}
function verify(root: string, manifest: { format?: unknown; files?: unknown }, digest: string): void {
  if (manifest.format !== FORMAT || sha(canonical(manifest)) !== digest)
    fail('retained method manifest digest mismatch');
  if (canonical(inventory(join(root, 'payload'))) !== canonical(manifest.files))
    fail('retained method bytes differ from their content digest');
}

/** The kit read from retained bytes; a missing or altered copy refuses. */
export function retainedKit(digest: string, store: string = closureStore()): Kit {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) fail('invalid retained method digest');
  const root = join(store, digest),
    path = join(root, 'manifest.json');
  if (!existsSync(path))
    throw new MethodError(
      `retained method ${digest} is missing; restore its exact bytes or explicitly rebind`,
      'IA-CORE-CLOSURE-MISSING',
    );
  let manifest: { format?: unknown; kit?: unknown; files?: unknown } = {};
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest;
  } catch {
    fail('retained method manifest is not JSON');
  }
  verify(root, manifest, digest);
  const payload = join(root, 'payload');
  const kit = findKit(String(manifest.kit), folderKits(join(payload, 'config', 'kits'), 'bundled'));
  return { ...kit, carrier: payload, retained: digest };
}

/** Retains a kit's exact bytes and its carrier's, and reads it back from the copy. */
export function retainKit(kit: Kit, store: string = closureStore()): Kit {
  if (kit.retained) return retainedKit(kit.retained, store);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(kit.folder)) fail('unsafe kit folder');
  const carrier = kit.carrier;
  const scripts = carrier === undefined ? undefined : join(carrier, 'scripts');
  const collect = <T extends Entry>(read: (root: string) => T[]): T[] =>
    [
      ...read(kit.dir).map((entry) => ({ ...entry, path: `config/kits/${kit.folder}/${entry.path}` })),
      ...(scripts === undefined || !existsSync(scripts)
        ? []
        : read(scripts).map((entry) => ({ ...entry, path: `scripts/${entry.path}` }))),
      ...(carrier === undefined ? [] : (supportFiles(carrier) as unknown as T[])),
    ].sort(byPath);
  const source = collect(files);
  if (source.length > 10000 || source.reduce((sum, entry) => sum + entry.bytes, 0) > 128 * 1024 * 1024)
    fail('retained method resource limit exceeded');
  const manifest = {
    format: FORMAT,
    kit: kit.id,
    files: source.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  };
  const digest = sha(canonical(manifest));
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const target = join(store, digest);
  if (existsSync(target)) return retainedKit(digest, store);
  const work = mkdtempSync(join(store, 'staging-'));
  try {
    for (const entry of source) {
      const destination = join(work, 'payload', entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.data, { flag: 'wx' });
    }
    writeFileSync(join(work, 'manifest.json'), canonical(manifest) + '\n', { flag: 'wx' });
    verify(work, manifest, digest);
    const now = collect(inventory).map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
    if (canonical(now) !== canonical(manifest.files)) fail('method changed while retaining its bytes');
    try {
      renameSync(work, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
    return retainedKit(digest, store);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
