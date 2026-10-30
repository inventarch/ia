import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
    for (const name of readdirSync(dir).sort()) {
      if (name.includes('\\') || name.includes(':') || name.includes('\0')) fail('unsafe retained path');
      const path = join(dir, name),
        rel = relative(root, path).replace(/\\/g, '/');
      if (rel === '.ia/distributions' || rel === '.ia/work') continue;
      const entry = lstatSync(path);
      const key = rel.normalize('NFC').toLowerCase();
      if (folded.has(key)) fail(`case-fold collision in method: ${rel}`);
      folded.add(key);
      if (entry.isSymbolicLink()) fail(`method symlink is unsupported: ${rel}`);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) fail(`method content is not a file: ${rel}`);
      const data = readFileSync(path);
      bytes += data.length;
      if (data.length > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024 || found.length >= 10000)
        fail('retained method resource limit exceeded');
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
    let current = carrier;
    for (const [index, part] of path.split('/').entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index === 0 ? !stat.isDirectory() : !stat.isFile()))
        fail(`core support input is not regular: ${path}`);
      if (index === 1 && stat.size > 256 * 1024) fail(`core support input is too large: ${path}`);
    }
    const data = readFileSync(current);
    if (data.length > 256 * 1024) fail(`core support input is too large: ${path}`);
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
