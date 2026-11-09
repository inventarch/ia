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
import type { BasePin, KitBaseUse } from './kit-base.js';
import { declaredAssets, iaHome, isText, lf, sourcesDigest, walk } from './kits.js';
import type { Kit } from './kits.js';

/**
 * The read root of a kit: a restored copy of its workspace in a per-user cache folder, keyed by its source digests and
 * the language base it is restored with. Nothing is written into the kit's own folder. The native restore is the
 * caller's (`KitRestore`): `select` chooses the base for a kit (`selectKitBase` over the bases the host carries), and
 * `apply` installs it in process into a fresh copy, rewriting only that copy's lock row when the base is a compatible
 * one rather than the locked archive.
 */
export type KitRestore = {
  select(kit: Kit): { base: BasePin; use: KitBaseUse };
  apply(root: string, kit: Kit, base: BasePin): void;
};

const LOCK = 'distributions.lock.json';

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

/** A digest of `.ia/` without its installation and work folders; `withLock` false leaves out the lock too. */
function readSourceDigest(root: string, normalized = false, withLock = true): string {
  const hash = createHash('sha256');
  const ia = join(root, '.ia');
  for (const file of walk(ia)) {
    const path = relative(ia, file).replace(/\\/g, '/');
    if (path.startsWith('distributions/') || path.startsWith('work/') || (!withLock && path === LOCK)) continue;
    const bytes = readFileSync(file);
    hash
      .update(path + NUL)
      .update(normalized && isText(file) ? lf(bytes) : bytes)
      .update(NUL);
  }
  return hash.digest('hex');
}

/** The archive a root's lock pins for package `id`, or undefined when the lock is missing, unreadable or has no row. */
function lockedArchive(root: string, id: string): unknown {
  try {
    const lock = JSON.parse(readFileSync(join(root, '.ia', LOCK), 'utf8')) as {
      packages?: { id?: unknown; archive?: unknown }[];
    };
    return lock.packages?.find((pkg) => pkg.id === id)?.archive;
  } catch {
    return undefined;
  }
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
 * The restored read root of a kit and the base it was restored with, restoring a fresh copy when the cache holds no
 * complete one. The key covers the kit's sources, its lock and the chosen base's archive, so roots restored on
 * different bases never mix. A cached root is checked against the kit: its sources without the lock, which a compatible
 * restore rewrites, and its lock's language row, which must name the chosen archive. The cache's parent is
 * `options.base`, else `kitCache(options.env)`.
 */
export function kitReadRoot(
  kit: Kit,
  restore: KitRestore,
  options: { readonly base?: string; readonly env?: NodeJS.ProcessEnv } = {},
): { root: string; base: KitBaseUse } {
  const { base, use } = restore.select(kit);
  const cache = userCache(options.base ?? kitCache(options.env));
  const target = join(
    cache,
    `kit-${basename(kit.folder)}-${createHash('sha256')
      .update(sourcesDigest(kit.dir))
      .update(readSourceDigest(kit.dir, true))
      .update(base.archive)
      .digest('hex')}`,
  );
  const found = { root: target, base: use };
  const verified = (): { root: string; base: KitBaseUse } => {
    if (readSourceDigest(target, false, false) !== readSourceDigest(kit.dir, true, false))
      throw new MethodError(`restored method sources were altered at ${target}`, 'IA-CORE-CLOSURE-INTEGRITY');
    if (lockedArchive(target, base.id) !== base.archive)
      throw new MethodError(
        `the restored lock at ${target} does not name the ${base.id} ${base.version} archive it was restored with`,
        'IA-CORE-CLOSURE-INTEGRITY',
      );
    for (const { rel, abs } of declaredAssets(kit.dir)) {
      const expected = readFileSync(abs);
      const bytes = isText(abs) ? lf(expected) : expected;
      if (!existsSync(join(target, rel)) || !readFileSync(join(target, rel)).equals(bytes))
        throw new MethodError(`restored method asset was altered: ${rel}`, 'IA-CORE-CLOSURE-INTEGRITY');
    }
    return found;
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
    restore.apply(work, kit, base);
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
    return found;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
