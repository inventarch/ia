import { compareVersions, rangeFloor, satisfies, version as exactVersion } from '@inventarch/db/distribution';
import { MethodError } from './errors.js';

/**
 * The language base a reader restores a kit's read root with. A reader carries a set of published bases (the door's
 * `assets/bases.json`); a kit's lock pins one by archive digest. One rule chooses: the locked archive when the reader
 * carries it, else the reader's newest base when it is the same major, not older than the lock, and admitted by the
 * kit's language range. The kit's own folder is never changed; only its read root is restored on the chosen base.
 */
export interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}

/** Which base a read root was restored with, against the one its lock pins: the packet's `envelope.base`. */
export interface KitBaseUse {
  readonly locked: { readonly version: string; readonly archive: string };
  readonly effective: { readonly version: string; readonly archive: string };
  readonly mode: 'exact' | 'compatible';
}

/** The parts of a kit's `.ia/distributions.lock.json` the rule reads. */
export interface KitBaseLock {
  readonly packages?: readonly { readonly id: string; readonly version: string; readonly archive: string }[];
  readonly requests?: readonly { readonly id: string; readonly range: string }[];
}

const CARRIER = '@inventarch/mcp-door';
const refuse = (message: string): never => {
  throw new MethodError(message, 'IA-CORE-CLI-UNSUPPORTED');
};
/** The value, or undefined when the codec refuses it (not canonical SemVer, not a range). */
function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/**
 * Chooses the base for a kit whose lock is `lock`, whose `.ia/release.json` declares `declaredRange` for the language
 * (undefined when it declares none), from the `carried` bases (ascending; the last is the newest). In order:
 *
 * 1. the locked archive, when carried, whatever its version label says (`exact`);
 * 2. another major than the newest carried refuses;
 * 3. a locked version above the newest carried refuses: the reader needs an upgrade, never the kit a downgrade;
 * 4. the newest carried base must satisfy the declared range and the lock's language request, each when present, or
 *    `^<locked version>` when neither is; otherwise it refuses;
 * 5. otherwise the newest carried base (`compatible`).
 *
 * Every refusal is `IA-CORE-CLI-UNSUPPORTED`; `kit` names the kit in it (`<id> <version>`).
 */
export function selectKitBase(
  lock: KitBaseLock,
  declaredRange: string | undefined,
  carried: readonly BasePin[],
  kit?: string,
): { base: BasePin; use: KitBaseUse } {
  const newest = carried.at(-1);
  if (newest === undefined)
    throw new MethodError(`this door carries no language base; reinstall ${CARRIER}`, 'IA-CORE-CLI-MISSING');
  const id = newest.id;
  const label = kit === undefined ? 'this kit' : `kit ${kit}`;
  const row = lock.packages?.find((pkg) => pkg.id === id);
  if (row === undefined) return refuse(`${label} locks no ${id} base, so this door has none to restore it with`);
  const locked = { version: row.version, archive: row.archive };
  const exact = carried.find((base) => base.archive === row.archive);
  if (exact !== undefined)
    return {
      base: exact,
      use: { locked, effective: { version: exact.version, archive: exact.archive }, mode: 'exact' },
    };
  const at = attempt(() => exactVersion(row.version));
  if (at === undefined)
    return refuse(
      `${label} locks ${id} under the version label ${JSON.stringify(row.version)}, which is not a version, and this door does not carry its archive ${row.archive}`,
    );
  const major = (value: string): number => Number(value.split('.')[0]);
  if (major(at) > major(newest.version))
    return refuse(
      `${label} locks ${id} ${at}, major ${major(at)}; this door carries major ${major(newest.version)}, up to ${newest.version}: upgrade ${CARRIER} to a release that carries ${id} ${major(at)}.x`,
    );
  if (major(at) < major(newest.version))
    return refuse(
      `${label} locks ${id} ${at}, major ${major(at)}; this door carries major ${major(newest.version)}, up to ${newest.version}, and does not read an earlier major: the kit needs a release migrated to ${id} ${major(newest.version)}.x`,
    );
  if (compareVersions(at, newest.version) < 0)
    return refuse(`${label} locks ${id} ${at}; this door carries up to ${newest.version}: upgrade ${CARRIER}`);
  const requested = lock.requests?.find((request) => request.id === id)?.range;
  const ranges = [declaredRange, requested].filter((range): range is string => range !== undefined);
  if (ranges.length === 0) ranges.push(`^${at}`);
  if (!ranges.every((range) => attempt(() => satisfies(newest.version, range)) === true)) {
    const above = ranges.some((range) => {
      const floor = attempt(() => rangeFloor(range));
      return floor !== undefined && compareVersions(floor, newest.version) < 0;
    });
    const next = above ? `upgrade ${CARRIER}` : `the kit needs a release whose range admits ${id} ${newest.version}`;
    const required =
      declaredRange !== undefined && requested !== undefined
        ? `${declaredRange} (declared in .ia/release.json) and ${requested} (requested by its lock)`
        : ranges[0];
    return refuse(
      `${label} requires ${id} ${required}, which this door's newest base ${newest.version} does not satisfy, and the locked ${at} (${row.archive}) is not one this door carries: ${next}`,
    );
  }
  return {
    base: newest,
    use: { locked, effective: { version: newest.version, archive: newest.archive }, mode: 'compatible' },
  };
}

/**
 * The lock a read root restored on `base` holds: a copy of the kit's `lock` whose `base.id` row names `base` (archive,
 * location `sha256:<archive>`, manifest, version) and nothing else changed; a row that already says so is left as it
 * is. The restore writes it and the read-root check expects it, so the two cannot drift.
 */
export function lockOnBase<T>(lock: T, base: BasePin): T {
  const copy = JSON.parse(JSON.stringify(lock ?? {})) as { packages?: unknown };
  if (Array.isArray(copy.packages))
    for (const row of copy.packages as Record<string, unknown>[])
      if (row !== null && typeof row === 'object' && row['id'] === base.id)
        Object.assign(row, {
          archive: base.archive,
          location: `sha256:${base.archive}`,
          manifest: base.manifest,
          version: base.version,
        });
  return copy as T;
}
