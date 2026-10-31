import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { MethodError } from './errors.js';
import { declaredAssets, iaHome, isText, lf, sourcesDigest, walk } from './kits.js';
import type { Kit } from './kits.js';

/**
 * The read root of a kit: a restored copy of its workspace in a per-user cache folder, keyed by its source digests, so
 * any reader opens it with the language base its lock pins. Nothing is written into the kit's own folder. The native
 * restore is the caller's (`KitRestore`): a host that carries the language base installs it in process.
 */
export type KitRestore = (root: string, kit: Kit) => void;

const NUL = String.fromCharCode(0);

/**
 * The default parent of the read-root cache: `kit-roots-v1` under the IA home, which is this user's, never the shared
 * system temporary folder. The IA home is created when missing and named through its links.
 */
export function kitCache(env: NodeJS.ProcessEnv = process.env): string {
  const home = iaHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return join(realpathSync(home), 'kit-roots-v1');
}

/** The folder under `base` that holds this user's restored copies, refused when another user owns it. */
export function userCache(base: string): string {
  const at0 = resolve(base);
  for (let at = at0; ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new MethodError('Aliased or non-directory cache parent', 'IA-CORE-KIT');
    if (at === dirname(at)) break;
  }
  const who = (typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username).replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  );
  const dir = join(at0, `inventarch-core-${who}`);
  const prior = lstatSync(dir, { throwIfNoEntry: false });
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink()))
    throw new MethodError('Aliased or non-directory cache', 'IA-CORE-KIT');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid === 'function' && statSync(dir).uid !== process.getuid())
    throw new MethodError(`${dir} belongs to another user; set IA_HOME to a private folder`, 'IA-CORE-KIT');
  return dir;
}

function normalize(dir: string): void {
  for (const path of walk(dir)) {
    if (!isText(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\r\n')) writeFileSync(path, text.replace(/\r\n/g, '\n'));
  }
}

function readSourceDigest(root: string, normalized = false): string {
  const hash = createHash('sha256');
  const ia = join(root, '.ia');
  for (const file of walk(ia)) {
    const path = relative(ia, file).replace(/\\/g, '/');
    if (path.startsWith('distributions/') || path.startsWith('work/')) continue;
    const bytes = readFileSync(file);
    hash
      .update(path + NUL)
      .update(normalized && isText(file) ? lf(bytes) : bytes)
      .update(NUL);
  }
  return hash.digest('hex');
}

const complete = (dir: string): boolean => existsSync(join(dir, '.ia', 'distributions', 'active.json'));

/**
 * A kit can be read only by a reader of the major its latest release was packed with, or a later one: a 3.x release
 * locks a 3.x language base. A reader of unknown version is let through.
 */
export function assertReadable(
  kit: Kit,
  reader: { readonly version?: string | undefined; readonly source: string },
): void {
  const packed = /^@inventarch\/cli ((\d+)\.\S*)$/.exec(String(kit.latest?.cli ?? ''));
  const major = Number(/^(\d+)\./.exec(reader.version ?? '')?.[1]);
  if (packed && Number.isInteger(major) && major < Number(packed[2]))
    throw new MethodError(
      `kit ${kit.id} ${kit.latest?.version} was packed with @inventarch/cli ${packed[1]}, whose language base this reader cannot restore: it resolves ${reader.version} (${reader.source})`,
      'IA-CORE-CLI-UNSUPPORTED',
    );
}

/**
 * The restored read root of a kit, restoring a fresh copy when the cache holds no complete one. The cache's parent is
 * `options.base`, else `kitCache(options.env)`.
 */
export function kitReadRoot(
  kit: Kit,
  restore: KitRestore,
  options: { readonly base?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string {
  const cache = userCache(options.base ?? kitCache(options.env));
  const target = join(
    cache,
    `kit-${basename(kit.folder)}-${createHash('sha256')
      .update(sourcesDigest(kit.dir))
      .update(readSourceDigest(kit.dir, true))
      .digest('hex')}`,
  );
  const verified = (): string => {
    if (readSourceDigest(target) !== readSourceDigest(kit.dir, true))
      throw new MethodError(`restored method sources were altered at ${target}`, 'IA-CORE-CLOSURE-INTEGRITY');
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      const expected = readFileSync(abs);
      const bytes = isText(abs) ? lf(expected) : expected;
      if (!existsSync(join(target, rel)) || !readFileSync(join(target, rel)).equals(bytes))
        throw new MethodError(`restored method asset was altered: ${rel}`, 'IA-CORE-CLOSURE-INTEGRITY');
    }
    return target;
  };
  if (complete(target)) return verified();
  const work = mkdtempSync(join(cache, 'tmp-'));
  try {
    cpSync(join(kit.dir, '.ia'), join(work, '.ia'), { recursive: true });
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      copyFileSync(abs, join(work, rel));
    }
    normalize(work);
    restore(work, kit);
    if (existsSync(target) && !complete(target)) rmSync(target, { recursive: true, force: true });
    try {
      renameSync(work, target);
    } catch (error) {
      if (complete(target)) return verified();
      throw new MethodError(
        `could not place the restored kit at ${target}: ${(error as Error).message}`,
        'IA-CORE-KIT',
      );
    }
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
