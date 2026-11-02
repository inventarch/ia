import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { MethodError, objectAt } from './errors.js';
import { iaHome, kitAt, listKits, readLock } from './kits.js';
import type { Kit, KitSources, LockedPackage } from './kits.js';

/**
 * Kits a workspace installs from an npm package of kits (contract C7b, ia-kb `dec-133`). The lock's `package` entry
 * names each kit's IA release by id, version, archive and manifest digest; the engine installs it like any release,
 * expanded under `.ia/distributions/store/<archive>/` at band 90. npm is transport only, so a kit is read from that
 * store, never from the npm package folder. A store payload is not a kit folder (it has no `releases.json` and no lock
 * of its own), so it is materialized once per archive under `<IA home>/installed-kits-v1/<archive>/`: its pinned files,
 * each checked against the manifest the lock pins, a format 1 `releases.json` of its one release, and a
 * `.ia/distributions.lock.json` pinning its dependencies exactly as the workspace lock does. A kit the lock names that
 * the store lacks is not installed yet: a fresh clone runs `ia restore`.
 */
export const INSTALLED_KITS_DIRECTORY = 'installed-kits-v1';
export const STORE = join('.ia', 'distributions', 'store');
/** What a session and a refusal say when the lock names kits the store lacks. */
export const RESTORE_NEEDED = 'run ia restore';

export interface LockedKit {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly dependencies: readonly string[];
  /** `<name>@<version>` of the package entry that names it. */
  readonly package: string;
}
const HEX = /^[a-f0-9]{64}$/;
const malformed = (message: string): never => {
  throw new MethodError(`.ia/distributions.lock.json: ${message}`, 'IA-CORE-LOCK-MALFORMED');
};

/** The kits the lock's package entries name, in lock order; none without entries or a lock. */
export function lockedPackageKits(root: string): LockedKit[] {
  const lock = readLock(root);
  if (lock?.entries === undefined) return [];
  if (!Array.isArray(lock.entries)) return malformed('entries must be a list');
  return lock.entries.flatMap((value): LockedKit[] => {
    const entry = objectAt(value) ?? malformed('an entry must be an object');
    if (entry['kind'] !== 'package') return [];
    const kits = entry['kits'];
    if (!Array.isArray(kits)) return malformed('a package entry needs a kits list');
    return kits.map((row) => {
      const kit = objectAt(row) ?? malformed('a kit row must be an object');
      const { id, version, archive, manifest } = kit;
      const dependencies = Array.isArray(kit['dependencies']) ? (kit['dependencies'] as unknown[]).map(String) : [];
      if (
        typeof id !== 'string' ||
        typeof version !== 'string' ||
        typeof archive !== 'string' ||
        !HEX.test(archive) ||
        typeof manifest !== 'string' ||
        !HEX.test(manifest)
      )
        return malformed('a kit row needs its id, version, archive and manifest digests');
      return {
        id,
        version,
        archive,
        manifest,
        dependencies,
        package: `${String(entry['name'])}@${String(entry['version'])}`,
      };
    });
  });
}

/** Whether the lock's package entries name kit `id`. */
export const packagedKit = (root: string, id: string): LockedKit | undefined =>
  lockedPackageKits(root).find((kit) => kit.id === id);

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
interface Pin {
  readonly path: string;
  readonly sha256: string;
}
const pinsOf = (manifest: Record<string, unknown>): Pin[] =>
  ((manifest['files'] ?? []) as { path?: unknown; sha256?: unknown }[]).map((file) => {
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || file.path.split('/').includes('..'))
      throw new MethodError('an installed manifest names an unsafe file', 'IA-CORE-CLOSURE-INTEGRITY');
    return { path: file.path, sha256: file.sha256 };
  });

/** The lock that pins a kit's dependencies as the workspace lock does: their rows and theirs, transitively. */
function kitLock(root: string, manifest: Record<string, unknown>): unknown {
  const lock = readLock(root) ?? {};
  const rows: LockedPackage[] = [...((lock.packages ?? []) as LockedPackage[]), ...lockedPackageKits(root)];
  const dependencies = ((manifest['dependencies'] ?? []) as { id: string; range: string }[]).map(({ id, range }) => ({
    id,
    range,
  }));
  const needed = new Map<string, LockedPackage>();
  const visit = (id: string): void => {
    if (needed.has(id)) return;
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      throw new MethodError(`installed kit depends on ${id}, which the workspace lock does not install`, 'IA-CORE-KIT');
    needed.set(id, row);
    (row.dependencies ?? []).forEach(visit);
  };
  dependencies.forEach((dependency) => visit(dependency.id));
  return {
    engine: '0.1.1',
    formatVersion: 1,
    packages: [...needed.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row) => ({
        archive: row.archive,
        dependencies: row.dependencies ?? [],
        id: row.id,
        location: (row as { location?: string }).location ?? `sha256:${row.archive}`,
        manifest: (row as { manifest?: string }).manifest,
        version: row.version,
      })),
    requests: dependencies.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

const COMPLETE = '.installed-kit.json';
/** The materialized kit folder of one installed kit, made from the store once and checked on every read. */
function materialize(root: string, kit: LockedKit, home: string): string {
  const store = join(root, STORE, kit.archive);
  const manifestBytes = readFileSync(join(store, 'distribution.json'));
  if (sha256(manifestBytes) !== kit.manifest)
    throw new MethodError(
      `installed kit ${kit.id} ${kit.version}: ${STORE}/${kit.archive}/distribution.json is not the manifest the lock pins; ${RESTORE_NEEDED}`,
      'IA-CORE-CLOSURE-INTEGRITY',
    );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (manifest['id'] !== kit.id || manifest['version'] !== kit.version)
    throw new MethodError(`installed kit ${kit.id}: its manifest names another release`, 'IA-CORE-CLOSURE-INTEGRITY');
  const pins = pinsOf(manifest);
  const parent = join(home, INSTALLED_KITS_DIRECTORY);
  const target = join(parent, kit.archive);
  const intact = (dir: string): boolean =>
    existsSync(join(dir, COMPLETE)) &&
    pins.every((pin) => existsSync(join(dir, pin.path)) && sha256(readFileSync(join(dir, pin.path))) === pin.sha256);
  if (intact(target)) return target;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(parent, 'tmp-'));
  try {
    for (const pin of pins) {
      const bytes = readFileSync(join(store, pin.path));
      if (sha256(bytes) !== pin.sha256)
        throw new MethodError(
          `installed kit ${kit.id}: ${STORE}/${kit.archive}/${pin.path} differs from its pin; ${RESTORE_NEEDED}`,
          'IA-CORE-CLOSURE-INTEGRITY',
        );
      mkdirSync(dirname(join(work, pin.path)), { recursive: true });
      writeFileSync(join(work, pin.path), bytes);
    }
    writeFileSync(
      join(work, 'releases.json'),
      JSON.stringify(
        {
          kit: kit.id,
          releases: [{ version: kit.version, archive: kit.archive, manifest: kit.manifest, records: [] }],
        },
        null,
        2,
      ) + '\n',
    );
    mkdirSync(join(work, '.ia'), { recursive: true });
    writeFileSync(join(work, '.ia', 'distributions.lock.json'), JSON.stringify(kitLock(root, manifest)) + '\n');
    writeFileSync(join(work, COMPLETE), JSON.stringify({ kit: kit.id, archive: kit.archive, manifest: kit.manifest }));
    rmSync(target, { recursive: true, force: true });
    try {
      renameSync(work, target);
    } catch (error) {
      if (!intact(target)) throw error;
    }
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface InstalledKits {
  /** The kits the lock's package entries name that the store holds, origin `installed`. */
  readonly kits: readonly Kit[];
  /** Those the store lacks: the workspace needs `ia restore`. */
  readonly missing: readonly LockedKit[];
}
/** The kits the workspace at root installs from its package entries, read from its store. */
export function installedPackageKits(root: string, env: NodeJS.ProcessEnv = process.env): InstalledKits {
  const locked = lockedPackageKits(root);
  if (locked.length === 0) return { kits: [], missing: [] };
  const home = iaHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const kits: Kit[] = [],
    missing: LockedKit[] = [];
  for (const kit of locked) {
    if (!existsSync(join(root, STORE, kit.archive, 'distribution.json'))) {
      missing.push(kit);
      continue;
    }
    const dir = materialize(root, kit, realpathSync(home));
    kits.push(kitAt(dir, kit.id.slice(kit.id.indexOf('/') + 1), 'installed'));
  }
  return { kits, missing };
}

/** The refusal a binding to a kit the store lacks meets. */
export const restoreRefusal = (kit: LockedKit): MethodError =>
  new MethodError(
    `kit ${kit.id} ${kit.version} is installed from ${kit.package} by .ia/distributions.lock.json, but ${STORE} does not hold it yet: ${RESTORE_NEEDED}`,
    'IA-CORE-KIT-RESTORE-REQUIRED',
  );

/**
 * The kits a resolve at a workspace reads: the bundled folder's, then each kit the lock's package entries install, then
 * the IA home's. A kit a package entry names comes only from the store, so one the store lacks is never answered by
 * another copy. Outside a workspace, or with no package entry, it is `listKits` unchanged.
 */
export function workspaceKits(
  sources: KitSources,
  root: string | null,
  env?: NodeJS.ProcessEnv,
): { readonly kits: Kit[]; readonly missing: readonly LockedKit[] } {
  const all = listKits(sources);
  if (root === null) return { kits: all, missing: [] };
  const installed = installedPackageKits(root, env);
  const named = new Set([...installed.kits.map((kit) => kit.id), ...installed.missing.map((kit) => kit.id)]);
  if (named.size === 0) return { kits: all, missing: [] };
  const kept = all.filter((kit) => !named.has(kit.id));
  return {
    kits: [
      ...kept.filter((kit) => kit.origin === 'bundled'),
      ...installed.kits,
      ...kept.filter((kit) => kit.origin !== 'bundled'),
    ],
    missing: installed.missing,
  };
}
