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
import { compareVersions, rangeFloor, satisfies } from '@inventarch/db/distribution';
import { MethodError } from './errors.js';
import { lockOnBase } from './kit-base.js';
import type { BasePin, KitBaseUse } from './kit-base.js';
import { declaredAssets, homeFolder, iaHome, isText, lf, sourcesDigest, walk } from './kits.js';
import type { Kit } from './kits.js';
import { canonical } from './packet.js';

/**
 * The read root of a kit: a restored copy of its workspace in a per-user cache folder, keyed by its source digests and
 * the language base it is restored with. Nothing is written into the kit's own folder. The native restore is the
 * caller's (`KitRestore`): `select` chooses the base for a kit (`selectKitBase` over the bases the host carries), and
 * `apply` installs it in process into a fresh copy whose lock is `lockOnBase(lock, base)`: only the language row moves,
 * and only when it names anything other than the chosen base.
 */
export type KitRestore = {
  select(kit: Kit): { base: BasePin; use: KitBaseUse };
  apply(root: string, kit: Kit, base: BasePin): void;
};

const LOCK = 'distributions.lock.json';

const NUL = String.fromCharCode(0);

/**
 * The default parent of the read-root cache: `kit-roots-v1` under the IA home (or `kit-roots` once it holds the
 * `authoritative` marker; `homeFolder`), which is this user's, never the shared
 * system temporary folder. The IA home is created when missing and named through its links.
 */
export function kitCache(env: NodeJS.ProcessEnv = process.env): string {
  const home = iaHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return homeFolder(realpathSync(home), 'kit-roots');
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

/** A root's `.ia/distributions.lock.json` as canonical JSON, or null when it is missing or unreadable. */
function canonicalLock(root: string, transform: (lock: unknown) => unknown = (lock) => lock): string | null {
  try {
    return canonical(transform(JSON.parse(readFileSync(join(root, '.ia', LOCK), 'utf8')) as unknown));
  } catch {
    return null;
  }
}

const complete = (dir: string): boolean => existsSync(join(dir, '.ia', 'distributions', 'active.json'));

/**
 * The lowest IA release (`x.y.z`, no prerelease) a `works` range admits. Readers are compared as the release they lead
 * to, so this, never the range's own lowest version, is the least reader the range admits. Throws when `works` is not a
 * SemVer range or admits no release: `>4 <3`, and also `>=4.0.0-alpha <4.0.0`, which only a prerelease satisfies.
 */
export function worksFloor(works: unknown): string {
  if (typeof works !== 'string') throw new MethodError('works is not a SemVer range', 'IA-CORE-KIT');
  // Each `||` alternative is one interval: its lowest release is its lowest version without the prerelease tag.
  const floors = works.split('||').flatMap((part) => {
    try {
      const lowest = /^\d+\.\d+\.\d+/.exec(rangeFloor(part))![0];
      return satisfies(lowest, part) ? [lowest] : [];
    } catch {
      return [];
    }
  });
  // Refuses the whole range when it is malformed, whatever its parts gave.
  rangeFloor(works);
  // compareVersions orders the highest first.
  const lowest = floors.sort((a, b) => compareVersions(b, a))[0];
  if (lowest === undefined) throw new MethodError('works admits no IA release', 'IA-CORE-KIT');
  return lowest;
}

/**
 * Whether a reader may read a kit's latest release.
 *
 * A release row that names `works`, the range of IA versions (`@inventarch/cli`) the release works with, is read by
 * every reader the range admits and by no other; its `cli`, the version it was packed with, is then provenance only
 * (ia-kb design/kit-lifecycle dec-002). A prerelease reader counts as the release it leads to, so a range is read over
 * releases only: one that admits nothing but prereleases admits no reader and is refused as no range at all. A `works` that is not a
 * SemVer range admitting some version refuses `IA-CORE-KIT`: a kit whose claim cannot be read is not taken as claiming nothing.
 *
 * A row without `works` keeps the earlier rule: only a reader of the major the release was packed with, or a later one,
 * since a 3.x release locks a 3.x language base. A reader of unknown version is let through either way.
 */
export function assertReadable(
  kit: Kit,
  reader: { readonly version?: string | undefined; readonly source: string },
): void {
  const label = `kit ${kit.id} ${kit.latest?.version}`;
  const works = kit.latest?.works;
  // An uncanonical reader version (a leading zero, a missing part) is an unknown one.
  const release = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:[-+].*)?$/.exec(reader.version ?? '')?.[1];
  if (works !== undefined) {
    let floor: string, admitted: boolean;
    try {
      floor = worksFloor(works);
      admitted = satisfies(release ?? floor, works as string);
    } catch {
      throw new MethodError(
        `${label} names works ${JSON.stringify(works)}, which is not a SemVer range that admits an IA release`,
        'IA-CORE-KIT',
      );
    }
    if (!admitted)
      throw new MethodError(
        `${label} works with IA ${String(works)}; this reader is ${reader.version} (${reader.source}): ${
          // compareVersions orders the highest first: at or above the range's lowest version, the reader is too new.
          compareVersions(release!, floor) <= 0
            ? 'the kit needs a release whose range admits it'
            : 'upgrade the reader to a version in that range'
        }`,
        'IA-CORE-CLI-UNSUPPORTED',
      );
    return;
  }
  const packed = /^@inventarch\/cli ((\d+)\.\S*)$/.exec(String(kit.latest?.cli ?? ''));
  const major = Number(/^(\d+)\./.exec(reader.version ?? '')?.[1]);
  if (packed && Number.isInteger(major) && major < Number(packed[2]))
    throw new MethodError(
      `${label} was packed with @inventarch/cli ${packed[1]}, whose language base this reader cannot restore: it resolves ${reader.version} (${reader.source})`,
      'IA-CORE-CLI-UNSUPPORTED',
    );
}
/**
 * The restored read root of a kit and the base it was restored with, restoring a fresh copy when the cache holds no
 * complete one. The key covers the kit's sources, its lock and the chosen base's archive, so roots restored on
 * different bases never mix. A cached root is checked against the kit: its sources without the lock, and its lock,
 * which must be the kit's lock with only the language row moved to the chosen base (`lockOnBase`, the rewrite a
 * restore's `apply` makes). The cache's parent is `options.base`, else `kitCache(options.env)`.
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
    const expected = canonicalLock(kit.dir, (lock) => lockOnBase(lock, base));
    if (expected === null || canonicalLock(target) !== expected)
      throw new MethodError(
        `the restored lock at ${target} is not the kit's lock on the ${base.id} ${base.version} archive it was restored with`,
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
