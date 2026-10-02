import {
  array,
  canonicalDistributionJson,
  data,
  frozen,
  hash,
  identifier,
  identity,
  integer,
  metadataDigest,
  object,
  packageId,
  portablePath,
  range,
  refuse,
  satisfies,
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
  readonly distribution: string;
  readonly engine: string;
  readonly language: readonly ['1.0'];
  readonly source: ReleaseSource;
  readonly license: string;
  readonly description: string;
}
export interface ReleaseDescriptor extends CommonRelease {
  readonly dependencies: readonly ExternalDependency[];
  readonly assets: readonly { readonly path: string; readonly role: 'documentation' | 'asset' | 'license' }[];
}
export interface BundleManifest extends CommonRelease {
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
export interface DistributionLock {
  readonly formatVersion: 1;
  readonly engine: string;
  readonly requests: readonly Dependency[];
  readonly packages: readonly LockedPackage[];
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
function common(row: Record<string, unknown>): CommonRelease {
  format(row);
  const source = object(row['source'], ['repository', 'commit', 'recipe', 'epoch']);
  const local = source['repository'] === null && source['commit'] === null,
    commit = local ? null : text(source['commit'], 64);
  if (commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) refuse('Expected immutable source commit');
  const grammar = array(row['language'], 1);
  if (grammar.length !== 1 || grammar[0] !== '1.0') refuse('Unsupported grammar');
  const distribution = identity(row['distribution']);
  if (!distribution.includes('/distribution/')) refuse('Expected a native distribution identity');
  return {
    formatVersion: 1,
    id: packageId(row['id']),
    version: version(row['version']),
    distribution,
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
  const row = object(data(input), [...commonKeys, 'dependencies', 'assets']),
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
      if (role === 'source' ? !system || !path.endsWith('.ia') : !publicAsset(path, role))
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
  return frozen({ ...body, roots, systems, dependencies: deps, files });
}
export function decodeDistributionLock(input: unknown): DistributionLock {
  const row = object(data(input), ['formatVersion', 'engine', 'requests', 'packages']);
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
  const reached = new Set<string>();
  const visit = (id: string): void => {
    if (reached.has(id)) return;
    reached.add(id);
    byId.get(id)!.dependencies.forEach(visit);
  };
  requests.forEach((r) => visit(r.id));
  if (reached.size !== packages.length) refuse('Unreachable locked package');
  return frozen({ formatVersion: 1, engine, requests, packages });
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
