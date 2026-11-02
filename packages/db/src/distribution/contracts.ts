import semver from 'semver';
import {
  array,
  canonicalDistributionJson,
  data,
  DISTRIBUTION_ENGINE_VERSION,
  frozen,
  hash,
  identifier,
  identity,
  InstallationError,
  integer,
  metadataDigest,
  object,
  packageId,
  PACKAGE_ENTRY_ENGINE_VERSION,
  portablePath,
  range,
  refuse,
  requiredRelease,
  satisfies,
  supportsDistributionLockEngine,
  ROOT_RELEASE_CONTROL_ENGINE_VERSION,
  supportsRootReleaseControls,
  sha256,
  sorted,
  text,
  version,
  DISTRIBUTION_LIMITS,
} from './codec.js';

export interface Dependency {
  readonly id: string;
  readonly range: string;
}
export interface ExternalDependency extends Dependency {
  readonly systems: readonly string[];
}
export interface FilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly role: 'source' | 'documentation' | 'asset' | 'license';
}
export interface SystemPin {
  readonly name: string;
  readonly provider: string;
  readonly version: string;
  readonly path: string;
}
/** `repository` and `commit` are both null for an unpublished local pack; recipe and epoch still fix the USTAR bytes and, within one zlib build, the archive bytes. */
export interface ReleaseSource {
  readonly repository: string | null;
  readonly commit: string | null;
  readonly recipe: string;
  readonly epoch: number;
}
interface CommonRelease {
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly engine: string;
  readonly language: readonly ['1.0'];
  readonly source: ReleaseSource;
  readonly license: string;
  readonly description: string;
}
export interface ReleaseDescriptor extends CommonRelease {
  /**
   * The native `@distribution` identity the release ships. Absent for a workspace that releases nothing, such as one a
   * default `ia init` created; a pack of such a descriptor is refused.
   */
  readonly distribution?: string;
  readonly dependencies: readonly ExternalDependency[];
  readonly assets: readonly { readonly path: string; readonly role: 'documentation' | 'asset' | 'license' }[];
}
export interface BundleManifest extends CommonRelease {
  readonly distribution: string;
  readonly roots: readonly string[];
  readonly systems: readonly SystemPin[];
  readonly dependencies: readonly Dependency[];
  readonly files: readonly FilePin[];
}
export interface LockedPackage {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly location: string;
  readonly dependencies: readonly string[];
}
/**
 * One kit a package entry names: the IA release the package carries, by id, version, archive and manifest digest, and
 * the ids its manifest depends on, as a release row names them.
 */
export interface PackageKit {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly dependencies: readonly string[];
}
/**
 * A lock entry of kind `package` (engine 0.1.2, ia-kb `dec-133`): an npm package of kits, such as
 * `@inventarch/public-kits`, recorded by its exact version and npm `dist.integrity`, and the IA releases it carries.
 * npm is transport only: the engine installs each kit as an ordinary release, expanded under
 * `.ia/distributions/store/<archive>/` at band 90 (`lockedReleases`), and a restore refetches the archives by digest.
 */
export interface PackageEntry {
  readonly kind: 'package';
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly kits: readonly PackageKit[];
}
/** A lock entry that is not a release: the kinds `LOCK_ENTRY_KINDS` names. */
export type LockEntry = PackageEntry;
/** The entry kinds this engine reads; any other kind is an engine this reader is not. */
export const LOCK_ENTRY_KINDS: readonly LockEntry['kind'][] = Object.freeze(['package']);
export interface DistributionLock {
  readonly formatVersion: 1;
  readonly engine: string;
  readonly requests: readonly Dependency[];
  readonly packages: readonly LockedPackage[];
  /** Entries that are not releases, present only when the lock holds one; such a lock declares engine ^0.1.2 or newer. */
  readonly entries?: readonly LockEntry[];
}
export interface GenerationInputs {
  readonly formatVersion: 1;
  readonly bundles: readonly { readonly id: string; readonly archive: string }[];
  readonly systems: readonly {
    readonly name: string;
    readonly provider: string;
    readonly version: string;
    readonly bundles: readonly string[];
    readonly selected: string;
    readonly files: readonly string[];
  }[];
}
export interface ActivationPointer {
  readonly formatVersion: 1;
  readonly generation: string;
  readonly previous: string | null;
  readonly counter: number;
}
const commonKeys = [
  'formatVersion',
  'id',
  'version',
  'distribution',
  'engine',
  'language',
  'source',
  'license',
  'description',
];
function format(row: Record<string, unknown>): void {
  if (row['formatVersion'] !== 1) refuse('Unsupported distribution format');
}
function url(value: unknown): string {
  const v = text(value, 2048);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return refuse('Expected HTTPS URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.href !== v)
    refuse('Expected canonical credential-free HTTPS URL without query/fragment');
  return v;
}
/** The fields both documents share; `distribution` is decoded whenever the row carries the key. */
function common(row: Record<string, unknown>): CommonRelease & { readonly distribution?: string } {
  format(row);
  const source = object(row['source'], ['repository', 'commit', 'recipe', 'epoch']);
  const local = source['repository'] === null && source['commit'] === null,
    commit = local ? null : text(source['commit'], 64);
  if (commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) refuse('Expected immutable source commit');
  const grammar = array(row['language'], 1);
  if (grammar.length !== 1 || grammar[0] !== '1.0') refuse('Unsupported grammar');
  const distribution = Object.hasOwn(row, 'distribution') ? identity(row['distribution']) : undefined;
  if (distribution !== undefined && !distribution.includes('/distribution/'))
    refuse('Expected a native distribution identity');
  return {
    formatVersion: 1,
    id: packageId(row['id']),
    version: version(row['version']),
    ...(distribution === undefined ? {} : { distribution }),
    engine: range(row['engine']),
    language: ['1.0'],
    source: {
      repository: local ? null : url(source['repository']),
      commit,
      recipe: identifier(source['recipe']),
      epoch: integer(source['epoch'], 8_589_934_591),
    },
    license: text(row['license'], 128),
    description: text(row['description'], 1024),
  };
}
function dependencies(value: unknown): readonly Dependency[] {
  return sorted(
    array(value, DISTRIBUTION_LIMITS.bundles).map((v) => {
      const r = object(v, ['id', 'range']);
      return { id: packageId(r['id']), range: range(r['range']) };
    }),
    (d) => d.id,
  );
}
export function decodeDistributionRequests(input: unknown): readonly Dependency[] {
  return frozen(dependencies(data(input)));
}
function names(value: unknown, decode = identifier): readonly string[] {
  return sorted(array(value).map(decode), (s) => s);
}
function publicAsset(path: string, role: unknown): boolean {
  if (path === 'distribution.json' || /(?:^|\/)(?:node_modules|dist)(?:\/|$)/i.test(path)) return false;
  const parts = path.split('/');
  if (!parts.some((part) => part.startsWith('.'))) return true;
  if (path === '.ia/authoring.resources.json') return role === 'asset';
  return (
    role === 'documentation' &&
    path.startsWith('.ia/src/') &&
    path.endsWith('.md') &&
    parts.slice(1).every((part) => !part.startsWith('.'))
  );
}
export function decodeReleaseDescriptor(input: unknown): ReleaseDescriptor {
  // `distribution` is the one optional key; every other key stays exact.
  const value = data(input),
    named = value !== null && typeof value === 'object' && Object.hasOwn(value, 'distribution');
  const row = object(value, [...commonKeys.filter((key) => named || key !== 'distribution'), 'dependencies', 'assets']),
    body = common(row);
  const dependencies = sorted(
    array(row['dependencies'], DISTRIBUTION_LIMITS.bundles).map((v) => {
      const r = object(v, ['id', 'range', 'systems']);
      const systems = names(r['systems']);
      if (!systems.length) refuse('External dependency must name systems');
      return { id: packageId(r['id']), range: range(r['range']), systems };
    }),
    (d) => d.id,
  );
  const external = dependencies.flatMap((d) => d.systems);
  if (new Set(external).size !== external.length || dependencies.some((d) => d.id === body.id))
    refuse('Duplicate/self external dependency');
  const assets = sorted(
    array(row['assets']).map((v): ReleaseDescriptor['assets'][number] => {
      const r = object(v, ['path', 'role']),
        role = r['role'];
      if (role !== 'documentation' && role !== 'asset' && role !== 'license') refuse('Invalid asset role');
      const path = portablePath(r['path']);
      if (!publicAsset(path, role))
        refuse('Assets must be explicit public paths or protected authoring assets outside hidden/build trees');
      return { path, role };
    }),
    (a) => a.path,
  );
  return frozen({ ...body, dependencies, assets });
}
export function decodeBundleManifest(input: unknown): BundleManifest {
  const row = object(data(input), [...commonKeys, 'roots', 'systems', 'dependencies', 'files']),
    body = common(row),
    roots = names(row['roots'], identity);
  if (!roots.length) refuse('Empty native roots');
  const systems = sorted(
    array(row['systems']).map((v) => {
      const r = object(v, ['name', 'provider', 'version', 'path']),
        name = identifier(r['name']),
        path = portablePath(r['path']);
      if (path !== `.ia/src/systems/${name}`) refuse('System path mismatch');
      return { name, path, provider: text(r['provider'], 128), version: version(r['version']) };
    }),
    (s) => s.name,
  );
  if (!systems.length) refuse('Empty native closure');
  const aliases = new Set<string>();
  let total = 0;
  const files = sorted(
    array(row['files'], DISTRIBUTION_LIMITS.files - 1).map((v): FilePin => {
      const r = object(v, ['path', 'bytes', 'sha256', 'role']),
        path = portablePath(r['path']),
        role = r['role'];
      if (!['source', 'documentation', 'asset', 'license'].includes(String(role))) refuse('Invalid file role');
      if (aliases.has(path.toLowerCase())) refuse('Case-alias file inventory');
      aliases.add(path.toLowerCase());
      const bytes = integer(r['bytes'], DISTRIBUTION_LIMITS.file);
      total += bytes;
      if (total > DISTRIBUTION_LIMITS.expanded) refuse('Expanded file budget');
      const system = systems.find((s) => path.startsWith(`${s.path}/`));
      const releaseControl = path === `.ia/src/releases/${body.distribution!.split('/')[3]}.ia`;
      if (role === 'source' && releaseControl && !supportsRootReleaseControls(body.engine))
        refuse(`Root release control requires distribution engine >=${ROOT_RELEASE_CONTROL_ENGINE_VERSION}`);
      if (role === 'source' ? (!system && !releaseControl) || !path.endsWith('.ia') : !publicAsset(path, role))
        refuse('Source/asset path mismatch');
      return { path, bytes, sha256: hash(r['sha256']), role: role as FilePin['role'] };
    }),
    (f) => f.path,
  );
  for (const s of systems)
    if (!files.some((f) => f.path === `${s.path}/system.ia` && f.role === 'source'))
      refuse('Missing system declaration');
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/');
    for (let n = 1; n < parts.length; n++)
      if (aliases.has(parts.slice(0, n).join('/'))) refuse('File/directory inventory collision');
  }
  const deps = dependencies(row['dependencies']);
  if (deps.some((d) => d.id === body.id)) refuse('Self bundle dependency');
  // A manifest's keys are exact, `distribution` included, so common() decoded it; it keeps its place among the keys.
  return frozen({ ...body, distribution: body.distribution!, roots, systems, dependencies: deps, files });
}
const LOCK_KEYS: readonly string[] = ['formatVersion', 'engine', 'requests', 'packages'];
/** An npm package name: lowercase, optionally scoped, at most 214 bytes. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** npm's `dist.integrity` of a published tarball: SRI SHA-512. */
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
function incompatible(message: string): never {
  throw new InstallationError('engine-incompatible', message);
}
/**
 * A lock that holds more than a 0.1.1 lock (`entries`, or a field no engine of this line knows) is judged by its engine
 * first, so a reader that does not support it says which `ia` does instead of refusing a field it does not know. An
 * entry kind this reader does not know is refused the same way. A lock of the four 0.1.1 fields is decoded as before.
 */
function admitExtension(row: Record<string, unknown>, reader: string): void {
  const declared = row['engine'];
  if (
    typeof declared === 'string' &&
    semver.validRange(declared) !== null &&
    !supportsDistributionLockEngine(reader, declared)
  )
    incompatible(
      `Lock requires distribution engine ${declared}; this reader is ${reader}. It needs ${requiredRelease(declared) ?? 'a newer IA'}. Use a compatible IA installation; preserve the lock and its engine range.`,
    );
  const entries = row['entries'];
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const kind = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['kind'] : undefined;
    if (typeof kind !== 'string' || !(LOCK_ENTRY_KINDS as readonly string[]).includes(kind))
      incompatible(
        `Lock entry kind ${typeof kind === 'string' ? kind : '(none)'} is unknown to distribution engine ${reader}; it needs a newer IA. Use a compatible IA installation; preserve the lock.`,
      );
  }
}
/**
 * Every release the lock installs: its `packages` and each kit its package entries name, the latter as a release row
 * located by digest (`sha256:<archive>`), sorted by id. Membership, closures, the store, restore and collection read
 * this, so a packaged kit is an installed release like any other.
 */
export function lockedReleases(lock: DistributionLock): readonly LockedPackage[] {
  if (lock.entries === undefined) return lock.packages;
  const kits = lock.entries.flatMap((entry) =>
    entry.kits.map(
      (kit): LockedPackage => ({
        id: kit.id,
        version: kit.version,
        archive: kit.archive,
        manifest: kit.manifest,
        location: `sha256:${kit.archive}`,
        dependencies: kit.dependencies,
      }),
    ),
  );
  return [...lock.packages, ...kits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function lockEntries(value: unknown, engine: string, packages: readonly LockedPackage[]): readonly LockEntry[] {
  const rows = array(value, DISTRIBUTION_LIMITS.bundles);
  if (!rows.length) refuse('A lock with no entries omits the entries field');
  if (!semver.subset(engine, `>=${PACKAGE_ENTRY_ENGINE_VERSION}`))
    refuse(
      `A lock with entries declares distribution engine >=${PACKAGE_ENTRY_ENGINE_VERSION} (such as ^${PACKAGE_ENTRY_ENGINE_VERSION}), so no earlier engine reads it`,
    );
  const entries = sorted(
    rows.map((v): PackageEntry => {
      const r = object(v, ['kind', 'name', 'version', 'integrity', 'kits']);
      if (r['kind'] !== 'package') refuse('Unknown lock entry kind');
      const name = text(r['name'], 214),
        integrity = text(r['integrity'], 128);
      if (!NPM_NAME.test(name)) refuse('Expected an npm package name');
      if (!NPM_INTEGRITY.test(integrity)) refuse('Expected the npm sha512 integrity of the package');
      const kits = sorted(
        array(r['kits'], DISTRIBUTION_LIMITS.bundles).map((k): PackageKit => {
          const kit = object(k, ['id', 'version', 'archive', 'manifest', 'dependencies']);
          return {
            id: packageId(kit['id']),
            version: version(kit['version']),
            archive: hash(kit['archive']),
            manifest: hash(kit['manifest']),
            dependencies: names(kit['dependencies'], packageId),
          };
        }),
        (kit) => kit.id,
      );
      if (!kits.length) refuse('A package entry names at least one kit');
      return { kind: 'package', name, version: version(r['version']), integrity, kits };
    }),
    (entry) => entry.name,
  );
  const named = new Set(packages.map((p) => p.id));
  for (const entry of entries)
    for (const kit of entry.kits) {
      if (named.has(kit.id)) refuse(`Kit ${kit.id} is named twice: by package ${entry.name} and by another lock row`);
      named.add(kit.id);
    }
  // A packaged kit's dependencies are installed releases too, as a release row's are.
  for (const entry of entries)
    for (const kit of entry.kits)
      if (kit.dependencies.some((id) => id === kit.id || !named.has(id))) refuse('Missing/self locked dependency');
  return entries;
}
/** The portable lock. `reader` is the engine judging it: this one, unless a test plays an older reader. */
export function decodeDistributionLock(input: unknown, reader: string = DISTRIBUTION_ENGINE_VERSION): DistributionLock {
  const value = data(input);
  const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (plain && Reflect.ownKeys(value).some((key) => !LOCK_KEYS.includes(key as string)))
    admitExtension(value as Record<string, unknown>, reader);
  const row = object(value, plain && Object.hasOwn(value, 'entries') ? [...LOCK_KEYS, 'entries'] : LOCK_KEYS);
  format(row);
  const engine = range(row['engine']),
    requests = dependencies(row['requests']);
  const packages = sorted(
    array(row['packages'], DISTRIBUTION_LIMITS.bundles).map((v): LockedPackage => {
      const r = object(v, ['id', 'version', 'archive', 'manifest', 'location', 'dependencies']),
        archive = hash(r['archive']),
        location = text(r['location'], 2048);
      if (location !== `sha256:${archive}`) {
        url(location);
        if (!new URL(location).pathname.endsWith(`/${archive}.ia.tgz`))
          refuse('HTTPS artifact location must end in its pinned digest');
      }
      return {
        id: packageId(r['id']),
        version: version(r['version']),
        archive,
        manifest: hash(r['manifest']),
        location,
        dependencies: names(r['dependencies'], packageId),
      };
    }),
    (p) => p.id,
  );
  const byId = new Map(packages.map((p) => [p.id, p]));
  for (const request of requests) {
    const p = byId.get(request.id);
    if (!p || !satisfies(p.version, request.range)) refuse('Lock does not satisfy direct request');
  }
  for (const p of packages)
    if (p.dependencies.some((id) => id === p.id || !byId.has(id))) refuse('Missing/self locked dependency');
  const entries = row['entries'] === undefined ? undefined : lockEntries(row['entries'], engine, packages);
  // The roots are the direct requests and each kit a package entry names: a release a packaged kit depends on, such as
  // the language base, is reachable through that kit.
  const reached = new Set<string>();
  const visit = (id: string): void => {
    if (reached.has(id)) return;
    reached.add(id);
    byId.get(id)?.dependencies.forEach(visit);
  };
  requests.forEach((r) => visit(r.id));
  for (const kit of (entries ?? []).flatMap((entry) => entry.kits)) kit.dependencies.forEach(visit);
  if ([...reached].filter((id) => byId.has(id)).length !== packages.length) refuse('Unreachable locked package');
  if (entries === undefined) return frozen({ formatVersion: 1, engine, requests, packages });
  return frozen({ formatVersion: 1, engine, requests, packages, entries });
}
export function decodeGenerationInputs(input: unknown): GenerationInputs {
  const row = object(data(input), ['formatVersion', 'bundles', 'systems']);
  format(row);
  const bundles = sorted(
      array(row['bundles'], DISTRIBUTION_LIMITS.bundles).map((v) => {
        const r = object(v, ['id', 'archive']);
        return { id: packageId(r['id']), archive: hash(r['archive']) };
      }),
      (b) => b.id,
    ),
    ids = new Set(bundles.map((b) => b.id));
  const systems = sorted(
    array(row['systems']).map((v) => {
      const r = object(v, ['name', 'provider', 'version', 'bundles', 'selected', 'files']),
        name = identifier(r['name']),
        providers = names(r['bundles'], packageId),
        selected = packageId(r['selected']),
        files = names(r['files'], portablePath);
      if (
        !providers.length ||
        selected !== providers[0] ||
        providers.some((p) => !ids.has(p)) ||
        !files.includes(`.ia/src/systems/${name}/system.ia`) ||
        files.some((f) => !f.startsWith(`.ia/src/systems/${name}/`) || !f.endsWith('.ia'))
      )
        refuse('Invalid generation membership');
      return {
        name,
        provider: text(r['provider'], 128),
        version: version(r['version']),
        bundles: providers,
        selected,
        files,
      };
    }),
    (s) => s.name,
  );
  if (!bundles.length !== !systems.length) refuse('Empty generation mismatch');
  return frozen({ formatVersion: 1, bundles, systems });
}
export function decodeActivationPointer(input: unknown): ActivationPointer {
  const row = object(data(input), ['formatVersion', 'generation', 'previous', 'counter']);
  format(row);
  return frozen({
    formatVersion: 1,
    generation: hash(row['generation']),
    previous: row['previous'] === null ? null : hash(row['previous']),
    counter: integer(row['counter'], Number.MAX_SAFE_INTEGER, 1),
  });
}
export function generationDigest(lock: DistributionLock, inputs: GenerationInputs, workspace: string | null): string {
  const files = [
    { path: 'inputs.json', text: canonicalDistributionJson(decodeGenerationInputs(inputs)) },
    { path: 'lock.json', text: canonicalDistributionJson(decodeDistributionLock(lock)) },
    ...(workspace === null ? [] : [{ path: 'workspace.ia', text: workspace }]),
  ];
  if (
    workspace !== null &&
    (Buffer.from(workspace).toString('utf8') !== workspace || Buffer.byteLength(workspace) > DISTRIBUTION_LIMITS.file)
  )
    refuse('Invalid generated workspace bytes');
  return metadataDigest(files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text), sha256: sha256(f.text) })));
}
