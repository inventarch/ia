import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ENTRIES } from './bindings.js';
import { MethodError } from './errors.js';
import { compareVersions, readReleases } from './releases.js';
import type { ReleaseRow } from './releases.js';

/**
 * Method kits as text sources. A kit folder holds `.ia/release.json` (its id and version), `.ia/src` (the records),
 * `.ia/distributions.lock.json` (the language base it pins), `releases.json` (format 1 or 2) and optionally the
 * sidecars `checks.json`, `delivery.json`, `bindings.json` and `onwrite.json`. Files `.ia/release.json` declares under
 * `assets` sit beside `.ia/`. Kits are found in two places: a bundled folder of kit folders, then the IA home's
 * `kits/<folder>/<version>/`. A workspace whose lock installs kits from an npm package of kits also reads them from its
 * store (installed-kits.ts), origin `installed`.
 */
export type KitOrigin = 'bundled' | 'home' | 'installed';
export interface Kit {
  readonly folder: string;
  readonly dir: string;
  readonly id: string;
  readonly version: string | undefined;
  readonly latest: ReleaseRow | null;
  readonly releases: readonly ReleaseRow[];
  readonly origin: KitOrigin;
  /** The folder whose `scripts/` the implementation digest covers beside the kit: the carrying plugin, or a retained copy of it. */
  readonly carrier?: string;
  /** The retained method bytes this kit was read from. */
  readonly retained?: string;
}
export interface KitSources {
  /** A folder of kit folders: the `IA_KITS_DIR` or `--kits` a host names. */
  readonly bundled?: string;
  /** The IA home's kit store, `<IA home>/kits`; null reads none. */
  readonly home?: string | null;
}

const TEXT = /\.(?:ia|json|md|mjs|txt)$/i;
const NUL = String.fromCharCode(0);
export const SIDECARS = ['checks.json', 'delivery.json', 'bindings.json', 'onwrite.json'] as const;

const driveRelative = (value: string): boolean =>
  process.platform === 'win32' && /^[A-Za-z]:/.test(value) && value[2] !== '/' && value[2] !== sep;
/** The IA home: IA_HOME when absolute, else `~/.ia`. A relative value is refused, never resolved against the working directory. */
export function iaHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const value = env['IA_HOME'];
  if (!value) return join(home, '.ia');
  if (!isAbsolute(value) || driveRelative(value))
    throw new MethodError(`IA_HOME must be an absolute path: ${value}`, 'IA-CORE-HOME-RELATIVE');
  return resolve(value);
}

export function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new MethodError(
          `method content must be regular files and directories: ${path}`,
          'IA-CORE-CLOSURE-INTEGRITY',
        );
      return entry.isDirectory() ? walk(path) : [path];
    });
}
export const isText = (path: string): boolean => TEXT.test(path);
export const lf = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
export const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The files `.ia/release.json` declares beside `.ia/`, sorted by path; one that escapes the kit or is missing refuses. */
export function declaredAssets(kitDir: string): readonly { readonly rel: string; readonly abs: string }[] {
  const descriptorPath = join(kitDir, '.ia', 'release.json');
  if (!existsSync(descriptorPath)) return [];
  const assets = ((JSON.parse(readFileSync(descriptorPath, 'utf8')) as { assets?: { path?: unknown }[] }).assets ??
    []) as { path?: unknown }[];
  const root = resolve(kitDir);
  return assets
    .map((asset) => asset?.path)
    .sort()
    .map((path) => {
      if (typeof path !== 'string' || path === '')
        throw new MethodError(`${descriptorPath}: an asset needs a path`, 'IA-CORE-KIT');
      const abs = resolve(root, path);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (
        isAbsolute(path) ||
        /^[A-Za-z]:/.test(path) ||
        rel === '' ||
        rel === '..' ||
        rel.startsWith('../') ||
        isAbsolute(rel)
      )
        throw new MethodError(`declared asset ${path} is absolute or leaves the kit`, 'IA-CORE-KIT');
      if (!existsSync(abs) || !statSync(abs).isFile())
        throw new MethodError(`declared asset ${path} is missing from ${kitDir}`, 'IA-CORE-KIT');
      return { rel, abs };
    });
}

/** One digest over a kit's sources (paths and LF-normalized bytes): `.ia/`, the declared assets, then each sidecar present. */
export function sourcesDigest(kitDir: string): string {
  const hash = createHash('sha256');
  const ia = join(kitDir, '.ia');
  const feed = (rel: string, path: string): void => {
    hash.update(rel + NUL);
    const bytes = readFileSync(path);
    hash.update(isText(path) ? lf(bytes) : bytes);
    hash.update(NUL);
  };
  for (const path of walk(ia).filter(
    (p) => !relative(ia, p).startsWith('distributions') && !relative(ia, p).startsWith('work'),
  ))
    feed(relative(kitDir, path).replace(/\\/g, '/'), path);
  for (const { rel, abs } of declaredAssets(kitDir)) feed(rel, abs);
  for (const name of SIDECARS) if (existsSync(join(kitDir, name))) feed(name, join(kitDir, name));
  return hash.digest('hex');
}

/**
 * A fail-closed execution fingerprint: every carried kit file but its release history, then the carrier's `scripts/`
 * when the kit has a carrier. Appending a release never changes it.
 */
export function implementationDigest(
  kit: Pick<Kit, 'dir' | 'carrier'>,
  carrier: string | undefined = kit.carrier,
): string {
  const hash = createHash('sha256');
  const roots: [string, string | undefined][] = [
    ['kit', kit.dir],
    ['scripts', carrier === undefined ? undefined : join(carrier, 'scripts')],
  ];
  for (const [label, root] of roots) {
    if (root === undefined || !existsSync(root)) continue;
    for (const file of walk(root)) {
      const path = relative(root, file).replace(/\\/g, '/');
      if (path.startsWith('.ia/distributions/') || path.startsWith('.ia/work/')) continue;
      if (label === 'kit' && (path === 'releases.json' || path.startsWith('releases/'))) continue;
      hash
        .update(label + '/' + path + NUL)
        .update(readFileSync(file))
        .update(NUL);
    }
  }
  return hash.digest('hex');
}

export function readDescriptor(kitDir: string): Record<string, unknown> {
  const path = join(kitDir, '.ia', 'release.json');
  if (!existsSync(path)) throw new MethodError(`${kitDir} carries no .ia/release.json`, 'IA-CORE-KIT');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

export function kitAt(kitDir: string, folder: string, origin: KitOrigin, carrier?: string): Kit {
  const releases = readReleases(kitDir);
  const descriptor = existsSync(join(kitDir, '.ia', 'release.json')) ? readDescriptor(kitDir) : {};
  const latest =
    (releases.latest
      ? releases.releases.find((release) => release.version === releases.latest)
      : releases.releases.at(-1)) ?? null;
  const version = typeof descriptor['version'] === 'string' ? descriptor['version'] : undefined;
  return {
    folder,
    dir: kitDir,
    id: releases.kit,
    version,
    latest,
    releases: releases.releases,
    origin,
    ...(carrier === undefined ? {} : { carrier }),
  };
}

/** One flat folder of kits: each subfolder holding a releases.json. */
export function folderKits(dir: string, origin: KitOrigin = 'bundled', carrier?: string): Kit[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => existsSync(join(dir, name, 'releases.json')))
    .map((folder) => kitAt(join(dir, folder), folder, origin, carrier));
}

/** The kits installed in the IA home: for each `<folder>`, every `<version>` whose descriptor names that version, newest first. */
export function homeKits(dir: string | null | undefined): Kit[] {
  if (!dir || !existsSync(dir)) return [];
  const found: Kit[] = [];
  for (const folder of readdirSync(dir).sort()) {
    const base = join(dir, folder);
    if (!statSync(base).isDirectory()) continue;
    const versions = readdirSync(base)
      .filter((version) => existsSync(join(base, version, 'releases.json')))
      .sort((x, y) => compareVersions(y, x));
    for (const version of versions) {
      const kit = kitAt(join(base, version), folder, 'home');
      if (kit.version === version) found.push(kit);
    }
  }
  return found;
}

/**
 * The carrier of a bundled kit folder: the plugin that sets `IA_KITS_DIR` to its `config/kits`, when that folder sits in
 * a plugin with `scripts/`. Its scripts are part of the implementation digest the plugin's own resolver records.
 */
export function carrierOf(bundled: string | undefined): string | undefined {
  if (bundled === undefined) return undefined;
  const dir = resolve(bundled);
  const plugin = resolve(dir, '..', '..');
  return dir === join(plugin, 'config', 'kits') && existsSync(join(plugin, 'scripts')) ? plugin : undefined;
}

/** The kits a resolve can read: the bundled folder first, then the newest home version of each kit it does not carry. */
export function listKits(sources: KitSources): Kit[] {
  const carried =
    sources.bundled === undefined ? [] : folderKits(sources.bundled, 'bundled', carrierOf(sources.bundled));
  const ids = new Set(carried.map((kit) => kit.id));
  const carrier = carrierOf(sources.bundled);
  const fromHome: Kit[] = [];
  for (const kit of homeKits(sources.home))
    if (!ids.has(kit.id)) {
      ids.add(kit.id);
      fromHome.push(carrier === undefined ? kit : { ...kit, carrier });
    }
  return [...carried, ...fromHome];
}

/** A kit by id or by folder. */
export function findKit(ref: string, kits: readonly Kit[]): Kit {
  const kit = kits.find((k) => k.id === ref) ?? kits.find((k) => k.folder === ref);
  if (!kit)
    throw new MethodError(
      `no kit ${ref} is carried by this plugin or installed in the IA home; known: ${kits.map((k) => k.id).join(', ') || 'none'}`,
      'IA-CORE-KIT-UNKNOWN',
    );
  return kit;
}

export interface KitRecordName {
  readonly system: string;
  readonly word: string;
  readonly name: string;
}
/** A kit's record names as (system, word, name), read from its text sources. */
export function kitRecordNames(kitDir: string): KitRecordName[] {
  const systems = join(kitDir, '.ia', 'src', 'systems');
  const names: KitRecordName[] = [];
  if (!existsSync(systems)) return names;
  for (const system of readdirSync(systems).sort()) {
    const dir = join(systems, system);
    const records = join(dir, 'records');
    const files = [
      join(dir, 'system.ia'),
      ...(existsSync(records)
        ? readdirSync(records)
            .filter((f) => f.endsWith('.ia'))
            .sort()
            .map((f) => join(records, f))
        : []),
    ].filter((f) => existsSync(f));
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(/^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/gm))
        names.push({ system, word: m[1]!, name: m[2]! });
  }
  const key = (r: KitRecordName): string => `${r.system}/${r.word}/${r.name}`;
  return names.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

const PLACEMENTS: Readonly<Record<string, string>> = {
  capability: 'agent-composition-system/definition/capability/',
  'agent-profile': 'agent-composition-system/binding/agent-profile/',
  playbook: 'governance-system/definition/procedure/',
  convention: 'governance-system/governance/convention/',
  principle: 'governance-system/governance/principle/',
  law: 'governance-system/governance/law/',
  check: 'compliance-system/check/gate/',
  contract: 'compliance-system/contract/signature/',
  mandate: 'agent-system/policy/mandate/',
};
/** The identity a kit record of a fixed-placement word resolves to; a name holding a slash is already an identity. */
export function identityOf(word: string, name: string): string | undefined {
  if (name.includes('/')) return name;
  const prefix = PLACEMENTS[word];
  return prefix === undefined ? undefined : prefix + name;
}

export interface KitCheck {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly record: string;
  readonly timeout: number;
  readonly arguments: unknown;
}
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const readSidecar = (kit: Pick<Kit, 'dir'>, name: string): Record<string, unknown> | undefined => {
  const path = join(kit.dir, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : undefined;
};

/** The checks a kit's runner may run (`checks.json`); a name that is not a @check record of the kit is dropped into `undeclared`. */
export function kitChecks(kit: Pick<Kit, 'dir'>): {
  readonly checks: Readonly<Record<string, KitCheck>>;
  readonly undeclared: readonly string[];
} {
  const path = join(kit.dir, 'checks.json');
  const parsed = readSidecar(kit, 'checks.json');
  if (parsed === undefined) return { checks: {}, undeclared: [] };
  if (parsed['format'] !== 1 || !plainObject(parsed['checks']))
    throw new MethodError(`${path} is malformed (format 1 with a checks object)`, 'IA-CORE-KIT');
  const declared = new Set(
    kitRecordNames(kit.dir)
      .filter((r) => r.word === 'check')
      .map((r) => r.name),
  );
  const checks: Record<string, KitCheck> = {},
    undeclared: string[] = [];
  for (const [name, value] of Object.entries(parsed['checks'])) {
    if (!declared.has(name)) {
      undeclared.push(name);
      continue;
    }
    const spec = (value ?? {}) as Record<string, unknown>;
    const argv = spec['argv'];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string'))
      throw new MethodError(`${path}: check ${name} needs a non-empty argv of strings`, 'IA-CORE-KIT');
    const timeout = spec['timeout'];
    if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0))
      throw new MethodError(
        `${path}: check ${name} needs a timeout that is a positive integer of seconds`,
        'IA-CORE-KIT',
      );
    checks[name] = {
      argv: argv as string[],
      cwd: (spec['cwd'] as string | undefined) ?? 'workspace',
      record: (spec['record'] as string | undefined) ?? `compliance-system/check/gate/${name}`,
      timeout: (timeout as number | undefined) ?? 600,
      arguments: spec['arguments'],
    };
  }
  return { checks, undeclared };
}

/** The capabilities a kit delivers whole (`delivery.json`); a name that is not a @capability record goes to `undeclared`. */
export function kitDelivery(kit: Pick<Kit, 'dir'>): {
  readonly whole: readonly string[];
  readonly undeclared: readonly string[];
} {
  const path = join(kit.dir, 'delivery.json');
  const parsed = readSidecar(kit, 'delivery.json');
  if (parsed === undefined) return { whole: [], undeclared: [] };
  const listed = parsed['whole'];
  if (
    parsed['format'] !== 1 ||
    !Array.isArray(listed) ||
    !listed.every((name) => typeof name === 'string' && name !== '')
  )
    throw new MethodError(`${path} is malformed (format 1 with a whole list of capability names)`, 'IA-CORE-KIT');
  const declared = new Set(
    kitRecordNames(kit.dir)
      .filter((r) => r.word === 'capability')
      .map((r) => r.name),
  );
  const whole: string[] = [],
    undeclared: string[] = [];
  for (const name of listed as string[]) (declared.has(name) ? whole : undeclared).push(name);
  return { whole, undeclared };
}

export interface Recommendation {
  readonly kit: string;
  readonly capability: string;
  readonly profile?: string;
}
/**
 * What a kit recommends a repository bind, and what it resolves outside a workspace (`bindings.json`). A key whose
 * capability or profile is not a record of the kit is dropped into `undeclared`; `unbound` is null when the kit lists none.
 */
export function kitBindings(kit: Pick<Kit, 'dir' | 'id'>): {
  readonly recommend: Readonly<Record<string, Recommendation>>;
  readonly unbound: readonly string[] | null;
  readonly undeclared: readonly string[];
} {
  const path = join(kit.dir, 'bindings.json');
  const parsed = readSidecar(kit, 'bindings.json');
  if (parsed === undefined) return { recommend: {}, unbound: null, undeclared: [] };
  const keyPattern = new RegExp(`^(?:${ENTRIES.join('|')})\\.(?:[a-z][a-z0-9-]*|\\*)$`);
  const listed = parsed['unbound'];
  if (
    parsed['format'] !== 1 ||
    !plainObject(parsed['recommend']) ||
    (listed !== undefined &&
      !(Array.isArray(listed) && listed.every((name) => typeof name === 'string' && name !== '')))
  )
    throw new MethodError(
      `${path} is malformed (format 1 with a recommend object and an optional unbound list of capability names)`,
      'IA-CORE-KIT',
    );
  const names = kitRecordNames(kit.dir);
  const capabilities = new Set(names.filter((r) => r.word === 'capability').map((r) => r.name));
  const profiles = new Set(names.filter((r) => r.word === 'agent-profile').map((r) => r.name));
  const recommend: Record<string, Recommendation> = {},
    undeclared: string[] = [];
  for (const [key, value] of Object.entries(parsed['recommend'])) {
    const row = value as Record<string, unknown>;
    if (
      !keyPattern.test(key) ||
      !plainObject(value) ||
      typeof row['capability'] !== 'string' ||
      (row['profile'] !== undefined && typeof row['profile'] !== 'string')
    )
      throw new MethodError(
        `${path}: ${key} needs an <entry>.<activity> key (entry ${ENTRIES.join(', ')}) and { capability, profile? }`,
        'IA-CORE-KIT',
      );
    const capability = row['capability'],
      profile = row['profile'] as string | undefined;
    if (!capabilities.has(capability) || (profile && !profiles.has(profile))) {
      undeclared.push(key);
      continue;
    }
    recommend[key] = { kit: kit.id, capability, ...(profile ? { profile } : {}) };
  }
  let unbound: string[] | null = null;
  if (listed) {
    unbound = [];
    for (const name of listed as string[]) (capabilities.has(name) ? unbound : undeclared).push(name);
  }
  return { recommend, unbound, undeclared };
}

export interface LockedPackage {
  readonly id: string;
  readonly version: string;
  readonly archive?: string;
  readonly dependencies?: readonly string[];
}
/** The distribution lock of the IA workspace at root, or undefined; `entries` holds its non-release rows (installed-kits.ts). */
export function readLock(
  root: string,
): { readonly packages?: readonly LockedPackage[]; readonly entries?: readonly unknown[] } | undefined {
  const lockPath = join(root, '.ia', 'distributions.lock.json');
  if (!existsSync(lockPath)) return undefined;
  return JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: LockedPackage[]; entries?: unknown[] };
}
/**
 * The installed kit: the lock's release row for the kit's id, or the kit row of a package entry that names it, which the
 * engine installs as an ordinary release (contract C7b).
 */
export function installedKit(root: string, kitId: string): LockedPackage | undefined {
  const lock = readLock(root);
  const row = (lock?.packages ?? []).find((pkg) => pkg.id === kitId);
  if (row !== undefined) return row;
  for (const entry of Array.isArray(lock?.entries) ? lock.entries : []) {
    const kits = (entry as { kind?: unknown; kits?: unknown }).kits;
    if ((entry as { kind?: unknown }).kind !== 'package' || !Array.isArray(kits)) continue;
    const kit = (kits as LockedPackage[]).find((candidate) => candidate?.id === kitId);
    if (kit !== undefined) return kit;
  }
  return undefined;
}

/**
 * A pin is usable only while the kit's release, source digest and implementation still match it; historical release
 * metadata is not historical bytes, so drift refuses rather than relabelling current instructions.
 */
export function assertPinnedKit(
  kit: Kit,
  pinned: {
    readonly version?: string | null | undefined;
    readonly archive?: string | null | undefined;
    readonly sources?: string | null | undefined;
    readonly implementation?: string | null | undefined;
  },
): void {
  if (!pinned || !/^[a-f0-9]{64}$/.test(pinned.sources ?? ''))
    throw new MethodError(
      `kit ${kit.id} has no verifiable source pin; explicitly rebind it`,
      'IA-CORE-PIN-UNAVAILABLE',
    );
  const current = {
    version: kit.latest?.version ?? kit.version ?? null,
    archive: kit.latest?.archive ?? null,
    sources: sourcesDigest(kit.dir),
  };
  if (
    current.version !== pinned.version ||
    current.archive !== (pinned.archive ?? null) ||
    current.sources !== pinned.sources
  )
    throw new MethodError(
      `kit ${kit.id} no longer matches its pinned release and source bytes; restore the exact release or explicitly rebind`,
      'IA-CORE-PIN-UNAVAILABLE',
    );
  if (!pinned.implementation || pinned.implementation !== implementationDigest(kit))
    throw new MethodError(
      `kit ${kit.id} runner/helper bytes are not verified against this pin; restore the exact implementation or explicitly rebind`,
      'IA-CORE-PIN-UNAVAILABLE',
    );
}
