import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { MethodError, objectAt } from './errors.js';
import { kitAt, listKits, readLock, sourcesDigest } from './kits.js';
import type { Kit, KitSources } from './kits.js';

/**
 * The npm package of kits a lock records as one entry (contract C7, dec-122): `{ kind: "package", name, version,
 * integrity, kits: [{ id, version, archive }] }` in `.ia/distributions.lock.json` `entries`. Nothing is vendored. The
 * package is found where the host put it: `IA_KITS_PACKAGE` (or the door's `--kits-package`) names its folder, else
 * `node_modules/<name>` is resolved upward from the workspace. Before its kits count as installed, its `package.json`
 * (`version`, `ia.kits`) must repeat the entry, each `kits/<folder>` must hold the release and sources `ia.kits` claims,
 * and npm's record of the install, where one is beside it, must hold the entry's integrity. Any mismatch is drift, which
 * names the field. A kit named by an entry is never read from another copy (dec-117): absent or drifted, it refuses.
 */
export const DEFAULT_KITS_PACKAGE = '@inventarch/public-kits';
export const KITS_PACKAGE_ENV = 'IA_KITS_PACKAGE';
/** What a missing package's session line and refusal begin with. */
export const DEFAULT_KITS_MISSING = 'default kits not installed';

export interface PackageKit {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
}
export interface KitsPackageEntry {
  readonly kind: 'package';
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly kits: readonly PackageKit[];
}
export type KitsPackageStatus = 'installed' | 'not-installed' | 'drift';
export interface KitsPackageReport {
  readonly entry: KitsPackageEntry;
  readonly status: KitsPackageStatus;
  /** The folder the package was read from, or null when none was found. */
  readonly dir: string | null;
  /** The verified kits, empty unless installed. */
  readonly kits: readonly Kit[];
  /** Whether npm's record of the install was found and holds the entry's integrity. */
  readonly integrity: 'verified' | 'unchecked' | null;
  /** The lock field the package differs in, for drift. */
  readonly field?: string;
  /** The refusal a binding to one of its kits meets, unless installed. */
  readonly error?: MethodError;
}

const malformed = (message: string): never => {
  throw new MethodError(`.ia/distributions.lock.json: ${message}`, 'IA-CORE-LOCK-MALFORMED');
};
const string = (value: unknown, where: string): string =>
  typeof value === 'string' && value !== '' ? value : malformed(`${where} must be a string`);

/** The package entries of the lock at root, in lock order; none for a lock without `entries` or no lock. */
export function lockedKitPackages(root: string): KitsPackageEntry[] {
  const lock = readLock(root) as { readonly entries?: unknown } | undefined;
  if (lock?.entries === undefined) return [];
  if (!Array.isArray(lock.entries)) return malformed('entries must be a list');
  return lock.entries.flatMap((value, index): KitsPackageEntry[] => {
    const row = objectAt(value) ?? malformed(`entries[${index}] must be an object`);
    if (row['kind'] !== 'package') return [];
    const kits = row['kits'];
    if (!Array.isArray(kits)) return malformed(`entries[${index}].kits must be a list`);
    return [
      {
        kind: 'package',
        name: string(row['name'], `entries[${index}].name`),
        version: string(row['version'], `entries[${index}].version`),
        integrity: string(row['integrity'], `entries[${index}].integrity`),
        kits: kits.map((kit, at) => {
          const k = objectAt(kit) ?? malformed(`entries[${index}].kits[${at}] must be an object`);
          return {
            id: string(k['id'], `entries[${index}].kits[${at}].id`),
            version: string(k['version'], `entries[${index}].kits[${at}].version`),
            archive: string(k['archive'], `entries[${index}].kits[${at}].archive`),
          };
        }),
      },
    ];
  });
}

const packageName = (dir: string): string | undefined => {
  try {
    const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
};
/**
 * Where the package an entry names is: `explicit` (the door's `--kits-package`, else `IA_KITS_PACKAGE`), when the lock
 * names one package or that folder's `package.json` names this one; else the nearest `node_modules/<name>` at or above
 * the workspace root. `searched` lists every folder looked in, for a refusal.
 */
export function kitsPackageLocation(
  entry: Pick<KitsPackageEntry, 'name'>,
  root: string,
  options: { readonly explicit?: string | undefined; readonly only?: boolean } = {},
): { readonly dir: string | null; readonly searched: readonly string[] } {
  const searched: string[] = [];
  if (options.explicit !== undefined) {
    if (!isAbsolute(options.explicit))
      throw new MethodError(`${KITS_PACKAGE_ENV} must be an absolute path: ${options.explicit}`, 'IA-CORE-USAGE');
    const dir = resolve(options.explicit);
    if (options.only === true || packageName(dir) === entry.name) {
      searched.push(dir);
      if (existsSync(join(dir, 'package.json'))) return { dir, searched };
      return { dir: null, searched };
    }
  }
  let at = resolve(root);
  for (let depth = 0; depth < 64; depth++) {
    const dir = join(at, 'node_modules', ...entry.name.split('/'));
    searched.push(dir);
    if (existsSync(join(dir, 'package.json'))) return { dir, searched };
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return { dir: null, searched };
}

/** npm's integrity for the install at dir, from the hidden lockfile of the `node_modules` that holds it, if any. */
export function installedIntegrity(dir: string): string | undefined {
  let at = resolve(dir);
  for (let depth = 0; depth < 64 && basename(at) !== 'node_modules'; depth++) {
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
  if (basename(at) !== 'node_modules') return undefined;
  const record = join(at, '.package-lock.json');
  if (!existsSync(record)) return undefined;
  try {
    const packages = (
      JSON.parse(readFileSync(record, 'utf8')) as { packages?: Record<string, { integrity?: unknown }> }
    ).packages;
    const key = `node_modules/${relative(at, dir).replace(/\\/g, '/')}`;
    const integrity = packages?.[key]?.integrity;
    return typeof integrity === 'string' ? integrity : undefined;
  } catch {
    return undefined;
  }
}

const FOLDER = /^[a-z0-9][a-z0-9._-]*$/;
class Drift extends Error {
  constructor(
    readonly field: string,
    readonly found: string,
    readonly locked: string,
  ) {
    super(field);
  }
}
const differ = (field: string, found: unknown, locked: unknown): never => {
  throw new Drift(field, found === undefined ? '(absent)' : String(found), String(locked));
};

/** The kits of the package at dir, once its `package.json`, kit folders and install record repeat the entry. */
export function verifyKitsPackage(
  entry: KitsPackageEntry,
  dir: string,
): { readonly kits: readonly Kit[]; readonly integrity: 'verified' | 'unchecked' } {
  let manifest: Record<string, unknown>;
  try {
    manifest = objectAt(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))) ?? {};
  } catch {
    return differ('package.json', 'unreadable', `${entry.name}@${entry.version}`);
  }
  if (manifest['name'] !== entry.name) differ('name', manifest['name'], entry.name);
  if (manifest['version'] !== entry.version) differ('version', manifest['version'], entry.version);
  const ia = objectAt(manifest['ia']);
  if (ia?.['format'] !== 1 || !Array.isArray(ia['kits'])) differ('ia', 'no format 1 ia.kits list', 'format 1');
  const listed = (ia!['kits'] as unknown[]).map((row) => objectAt(row) ?? {});
  const ids = (rows: readonly { readonly id?: unknown }[]): string =>
    rows
      .map((row) => String(row.id))
      .sort()
      .join(', ');
  if (ids(listed) !== ids(entry.kits)) differ('ia.kits', ids(listed), ids(entry.kits));
  const kits = entry.kits.map((locked) => {
    const row = listed.find((candidate) => candidate['id'] === locked.id)!;
    const at = `ia.kits[${locked.id}]`;
    if (row['version'] !== locked.version) differ(`${at}.version`, row['version'], locked.version);
    if (row['archive'] !== locked.archive) differ(`${at}.archive`, row['archive'], locked.archive);
    const folder = row['folder'];
    if (typeof folder !== 'string' || !FOLDER.test(folder)) return differ(`${at}.folder`, folder, 'a kit folder name');
    const kitDir = join(dir, 'kits', folder);
    if (!existsSync(join(kitDir, 'releases.json')) || !statSync(kitDir).isDirectory())
      differ(`kits/${folder}`, 'missing', `${locked.id}@${locked.version}`);
    let kit: Kit;
    try {
      kit = kitAt(kitDir, folder, 'package');
    } catch (error) {
      return differ(`kits/${folder}`, `unreadable (${(error as Error).message})`, `${locked.id}@${locked.version}`);
    }
    if (kit.id !== locked.id) differ(`kits/${folder} id`, kit.id, locked.id);
    const version = kit.latest?.version ?? kit.version;
    if (version !== locked.version) differ(`kits/${folder} version`, version, locked.version);
    if (kit.latest?.archive !== locked.archive) differ(`kits/${folder} archive`, kit.latest?.archive, locked.archive);
    let sources: string;
    try {
      sources = sourcesDigest(kitDir);
    } catch (error) {
      return differ(`kits/${folder}`, `unreadable (${(error as Error).message})`, `${locked.id}@${locked.version}`);
    }
    if (sources !== row['sources']) differ(`${at}.sources`, sources, row['sources']);
    return kit;
  });
  const installed = installedIntegrity(dir);
  if (installed !== undefined && installed !== entry.integrity) differ('integrity', installed, entry.integrity);
  return { kits, integrity: installed === undefined ? 'unchecked' : 'verified' };
}

/** How to put the package where a reader finds it, for a refusal's next step. */
const remedy = (entry: KitsPackageEntry): string =>
  `start the door with npx -y -p @inventarch/mcp-door@<version> -p ${entry.name}@${entry.version} ia-mcp-door --kits-package ${entry.name} (what ia host <host> --commit writes), set ${KITS_PACKAGE_ENV} to its folder, or npm install ${entry.name}@${entry.version} in the workspace`;

/** Each package entry of the lock at root, found, verified and reported; nothing throws for a missing or drifted one. */
export function workspaceKitsPackages(
  root: string,
  options: { readonly explicit?: string | undefined; readonly env?: NodeJS.ProcessEnv } = {},
): KitsPackageReport[] {
  const entries = lockedKitPackages(root);
  const explicit = options.explicit ?? (options.env ?? process.env)[KITS_PACKAGE_ENV] ?? undefined;
  return entries.map((entry): KitsPackageReport => {
    const { dir, searched } = kitsPackageLocation(entry, root, {
      explicit: explicit === '' ? undefined : explicit,
      only: entries.length === 1,
    });
    if (dir === null)
      return {
        entry,
        status: 'not-installed',
        dir: null,
        kits: [],
        integrity: null,
        error: new MethodError(
          `${DEFAULT_KITS_MISSING}: the lock names ${entry.name}@${entry.version} (${entry.kits.map((kit) => kit.id).join(', ')}), which is not at ${searched.length > 1 ? `${searched[0]} or in a node_modules folder above it` : searched[0]}; ${remedy(entry)}`,
          'IA-CORE-KITS-PACKAGE-MISSING',
        ),
      };
    try {
      const verified = verifyKitsPackage(entry, dir);
      return { entry, status: 'installed', dir, kits: verified.kits, integrity: verified.integrity };
    } catch (error) {
      if (!(error instanceof Drift)) throw error;
      return {
        entry,
        status: 'drift',
        dir,
        kits: [],
        integrity: null,
        field: error.field,
        error: new MethodError(
          `kits package drift: ${entry.name} at ${dir} differs from .ia/distributions.lock.json in ${error.field}: it has ${error.found}, the lock records ${error.locked}. Install ${entry.name}@${entry.version} exactly, or rerun ia host <host> --commit to record the package you have`,
          'IA-CORE-KITS-PACKAGE-DRIFT',
        ),
      };
    }
  });
}

/** The report of the package entry that names kit `id`, if any. */
export const packageOf = (reports: readonly KitsPackageReport[], id: string): KitsPackageReport | undefined =>
  reports.find((report) => report.entry.kits.some((kit) => kit.id === id));

/**
 * The kits a resolve at a workspace reads: the bundled folder's, then each verified package's, then the IA home's. A
 * kit a package entry names comes only from that package, whatever its state, so a missing or drifted package is never
 * answered by another copy. Outside a workspace, or with no package entry, it is `listKits` unchanged.
 */
export function workspaceKits(
  sources: KitSources,
  root: string | null,
  env?: NodeJS.ProcessEnv,
): { readonly kits: Kit[]; readonly packages: readonly KitsPackageReport[] } {
  const all = listKits(sources);
  if (root === null) return { kits: all, packages: [] };
  const packages = workspaceKitsPackages(root, {
    ...(sources.package === undefined ? {} : { explicit: sources.package }),
    ...(env === undefined ? {} : { env }),
  });
  if (!packages.length) return { kits: all, packages };
  const named = new Set(packages.flatMap((report) => report.entry.kits.map((kit) => kit.id)));
  const kept = all.filter((kit) => !named.has(kit.id));
  return {
    kits: [
      ...kept.filter((kit) => kit.origin === 'bundled'),
      ...packages.flatMap((report) => report.kits),
      ...kept.filter((kit) => kit.origin !== 'bundled'),
    ],
    packages,
  };
}
