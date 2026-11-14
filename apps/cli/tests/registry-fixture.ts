import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
/**
 * A minimal copy of apps/distribution/tests/registry-fixture.ts for the consumer CLI's registry tests. The CLI's test
 * typecheck keeps every file under apps/cli, so it cannot import the distribution package's test files; this copy
 * reaches the same mechanisms through the package's public `@inventarch/distribution/snapshot` subpath instead.
 *
 * Every archive is the admitted foundation distribution packed under the spec's id and version, so the registry holds
 * real releases that install through native admission. Nothing here reaches a network: `serveDirectory` answers a
 * stubbed global fetch from the registry directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { readInputs } from '@inventarch/db';
import { canonicalDistributionJson, DISTRIBUTION_ENGINE_VERSION, sha256 } from '@inventarch/db/distribution';
import type { BundleManifest } from '@inventarch/db/distribution';
import { buildArchive, verifyArchive } from '@inventarch/distribution/archive';
import { registryAdd } from '@inventarch/distribution/registry-build';
import { resolveReleases } from '@inventarch/distribution/resolve';
import { distributionSnapshot, packSnapshot } from '@inventarch/distribution/snapshot';
import type { DistributionSnapshot } from '@inventarch/distribution/snapshot';
import { readBases } from '../src/bundled-base.js';
import { cli, repository } from './workspace-fixture.js';

/** The descriptor apps/distribution/tests/snapshot-fixture.ts packs; each release overrides its id, version and dependencies. */
const DESCRIPTOR = {
  formatVersion: 1,
  id: 'fixture/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/definition/distribution/public-language',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  assets: [],
  source: {
    repository: 'https://fixture.example/source-workspaces/foundation',
    commit: 'a'.repeat(64),
    recipe: 'ustar-v1',
    epoch: 1_700_000_000,
  },
  license: 'UNLICENSED',
  description: 'Original registry fixture',
};

/** Serves a registry directory at `base` through a stubbed global fetch; every request must refuse redirects. Returns the requested URLs. */
export function serveDirectory(dir: string, base: string): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    expect(init?.redirect).toBe('error');
    if (!url.startsWith(base)) return new Response('no', { status: 404 });
    try {
      return new Response(readFileSync(join(dir, decodeURIComponent(url.slice(base.length)))));
    } catch {
      return new Response('missing', { status: 404 });
    }
  });
  return requested;
}

export interface FixtureReleaseSpec {
  readonly id: string;
  readonly version: string;
  readonly dependencies?: readonly { readonly id: string; readonly range: string }[];
  readonly withdrawn?: boolean;
  readonly licensed?: boolean;
  readonly repository?: string;
}
export interface FixtureRelease {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
  readonly bytes: Buffer;
}

let foundation: { readonly snapshot: DistributionSnapshot; readonly systems: readonly string[] } | undefined;
/** The admitted foundation workspace, captured once per process from the committed prose sources; its copy is removed at once. */
function foundationSnapshot(): { readonly snapshot: DistributionSnapshot; readonly systems: readonly string[] } {
  if (foundation !== undefined) return foundation;
  const root = mkdtempSync(join(tmpdir(), 'ia-cli-registry-source-'));
  try {
    copyPublicLanguageFixture(repository, root);
    const input = readInputs(root);
    const snapshot = distributionSnapshot({
      sources: input.sources,
      folders: input.folders,
      floorOrigin: input.floorOrigin,
      ...(input.activation ? { activation: input.activation } : {}),
    });
    const systems = packSnapshot(snapshot, DESCRIPTOR, new Map())
      .manifest.systems.map((system) => system.name)
      .filter((name) => name !== 'workspace-system')
      .sort();
    foundation = { snapshot, systems };
    return foundation;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A real archive that installs. A release with dependencies takes its non-workspace systems from them, split across
 * the dependencies, so the installed closure is the foundation's. Source provenance is `https://fixture.example/<id>`
 * unless `repository` names another, which changes the bytes without changing the id or version.
 */
export function fixtureArchive(spec: FixtureReleaseSpec): FixtureRelease {
  const { snapshot, systems } = foundationSnapshot(),
    dependencies = spec.dependencies ?? [];
  const source = { ...DESCRIPTOR.source, repository: spec.repository ?? `https://fixture.example/${spec.id}` };
  const external = dependencies.map((dependency, k) => ({
    ...dependency,
    systems: systems.filter((_, n) => n % dependencies.length === k),
  }));
  const packed = packSnapshot(
    snapshot,
    { ...DESCRIPTOR, id: spec.id, version: spec.version, dependencies: external, source },
    new Map(),
  );
  return {
    id: spec.id,
    version: spec.version,
    archive: packed.archiveDigest,
    manifest: packed.manifestDigest,
    bytes: Buffer.from(packed.bytes),
  };
}

/** The engine range every fixture release declares, copied into its index entry as the layout requires. */
export const FIXTURE_ENGINE = DESCRIPTOR.engine;

/**
 * A published release that installs beside an `ia init` workspace's bundled base: the base archive's own sources
 * repacked under the spec's id and version with published provenance. Every system it carries has the base's exact
 * provider, version and file pins, so the two never disagree about a system. Floor sources keep their floor placement.
 */
export function baseCompanionArchive(spec: FixtureReleaseSpec, baseArchive: Uint8Array): FixtureRelease {
  const base = verifyArchive(baseArchive);
  // The archive carries its systems but not the floor they were checked against; packing reads the committed floor
  // the base was packed with (examples/public-language/manifest.json), as tools/native/public-language.ts does.
  const { floor } = JSON.parse(readFileSync(join(repository, 'examples/public-language/manifest.json'), 'utf8')) as {
    floor: string[];
  };
  const sources = [
    ...floor.map((path) => ({
      path,
      text: readFileSync(join(repository, path), 'utf8').replace(/\r\n/g, '\n'),
      location: { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' },
    })),
    ...[...base.files]
      .filter(([path]) => path.endsWith('.ia'))
      .map(([path, bytes]) => ({
        path,
        text: bytes.toString('utf8'),
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      })),
  ];
  const snapshot = distributionSnapshot({
    sources,
    folders: base.manifest.systems.map((system) => system.name),
    floorOrigin: 'local',
  });
  const descriptor = {
    ...DESCRIPTOR,
    id: spec.id,
    version: spec.version,
    distribution: base.manifest.distribution,
    source: { ...DESCRIPTOR.source, repository: spec.repository ?? `https://fixture.example/${spec.id}` },
  };
  const packed = packSnapshot(snapshot, descriptor, new Map());
  return {
    id: spec.id,
    version: spec.version,
    archive: packed.archiveDigest,
    manifest: packed.manifestDigest,
    bytes: Buffer.from(packed.bytes),
  };
}
/**
 * A published language base the CLI carries (apps/cli/assets, which the build fills from the bases ledger): its pin and
 * exact archive bytes. A workspace locked on it is one an earlier CLI that bundled this base initialized.
 */
export function baseArchiveAt(version: string): FixtureRelease {
  const base = readBases(cli).find((carried) => carried.pin.version === version);
  if (base === undefined) throw new Error(`The CLI carries no language base ${version}`);
  const { id, archive, manifest } = base.pin;
  return { id, version, archive, manifest, bytes: base.bytes };
}
/**
 * A kit that depends on the language at `range`: the product-structure release of `sourcedClosure`, cut again with its
 * language dependency at `range` and published provenance. It was packed against the carried newest base, so it
 * installs on it.
 */
export async function languageKit(range: string): Promise<SourcedRelease> {
  const tool = pathToFileURL(join(repository, 'tools/release/product-structure.mjs')).href;
  const { productStructure } = (await import(tool)) as { readonly productStructure: ProductStructure };
  const { product } = productStructure(repository);
  const manifest = {
    ...product.manifest,
    dependencies: product.manifest.dependencies.map((dependency) =>
      dependency.id === 'inventarch/language' ? { ...dependency, range } : dependency,
    ),
    source: { ...product.manifest.source, repository: 'https://fixture.example/kit', commit: 'a'.repeat(40) },
  };
  const bytes = buildArchive(manifest, product.files);
  return {
    manifest,
    files: product.files,
    bytes,
    archiveDigest: sha256(bytes),
    manifestDigest: sha256(canonicalDistributionJson(manifest)),
  };
}
/**
 * A language base as a registry or catalog would publish it: the carried base `version`'s manifest and files, cut again
 * with published provenance (no registry lists an unpublished archive, §5.1), so its archive differs from the carried one.
 * `as` labels the cut with another version, standing for a base this CLI does not carry.
 */
export function publishedBase(version: string, as = version): SourcedRelease {
  const base = readBases(cli).find((carried) => carried.pin.version === version);
  if (base === undefined) throw new Error(`The CLI carries no language base ${version}`);
  const { manifest: carried, files } = verifyArchive(base.bytes);
  const manifest = {
    ...carried,
    version: as,
    source: { ...carried.source, repository: 'https://fixture.example/language', commit: 'b'.repeat(40) },
  };
  const bytes = buildArchive(manifest, files);
  return {
    manifest,
    files,
    bytes,
    archiveDigest: sha256(bytes),
    manifestDigest: sha256(canonicalDistributionJson(manifest)),
  };
}
/**
 * A directory registry listing exactly `releases`, each index entry copied from the manifest its archive carries (§3);
 * the releases of one id share its index, in the order given.
 */
export function sourcedRegistry(releases: readonly SourcedRelease[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-cli-registry-'));
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put('ia-registry.json', JSON.stringify({ format: 'ia.registry.v1', name: 'Fixture' }));
  const indexes = new Map<string, unknown[]>();
  for (const { manifest, bytes, archiveDigest, manifestDigest } of releases) {
    put(`artifacts/${archiveDigest}.ia.tgz`, bytes);
    const entry = {
      version: manifest.version,
      archive: archiveDigest,
      manifest: manifestDigest,
      engine: manifest.engine,
      language: manifest.language,
      dependencies: manifest.dependencies
        .map(({ id, range }) => ({ id, range }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      withdrawn: false,
      access: 'public',
      artifact: `artifacts/${archiveDigest}.ia.tgz`,
    };
    indexes.set(manifest.id, [...(indexes.get(manifest.id) ?? []), entry]);
  }
  for (const [id, entries] of indexes)
    put(`packages/${id}.json`, JSON.stringify({ format: 'ia.registry-package.v1', id, releases: entries }));
  return dir;
}
/** A registry directory holding the given releases exactly, in the `ia.registry.v1` layout. */
export function registryOf(releases: readonly (readonly [FixtureReleaseSpec, FixtureRelease])[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-cli-registry-')),
    indexes = new Map<string, unknown[]>();
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put('ia-registry.json', JSON.stringify({ format: 'ia.registry.v1', name: 'Fixture' }));
  for (const [spec, release] of releases) {
    put(`artifacts/${release.archive}.ia.tgz`, release.bytes);
    indexes.set(spec.id, [...(indexes.get(spec.id) ?? []), indexEntry(release, spec)]);
  }
  for (const [id, entries] of indexes)
    put(`packages/${id}.json`, JSON.stringify({ format: 'ia.registry-package.v1', id, releases: entries }));
  return dir;
}

/** A registry directory holding real packed archives in the `ia.registry.v1` layout (registry spec §3); licensed releases get no artifact file. */
export function buildFixtureRegistry(specs: readonly FixtureReleaseSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-cli-registry-')),
    indexes = new Map<string, unknown[]>();
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put('ia-registry.json', JSON.stringify({ format: 'ia.registry.v1', name: 'Fixture' }));
  for (const spec of specs) {
    const release = fixtureArchive(spec),
      licensed = spec.licensed === true;
    if (!licensed) put(`artifacts/${release.archive}.ia.tgz`, release.bytes);
    indexes.set(spec.id, [...(indexes.get(spec.id) ?? []), indexEntry(release, spec)]);
  }
  for (const [id, releases] of indexes)
    put(`packages/${id}.json`, JSON.stringify({ format: 'ia.registry-package.v1', id, releases }));
  return dir;
}

/** One package-index entry for a release, its metadata copied from the manifest the archive carries (§3). */
export function indexEntry(release: FixtureRelease, spec: FixtureReleaseSpec): Record<string, unknown> {
  const licensed = spec.licensed === true;
  return {
    version: spec.version,
    archive: release.archive,
    manifest: release.manifest,
    engine: FIXTURE_ENGINE,
    language: ['1.0'],
    dependencies: [...(spec.dependencies ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
    withdrawn: spec.withdrawn === true,
    access: licensed ? 'licensed' : 'public',
    ...(licensed ? {} : { artifact: `artifacts/${release.archive}.ia.tgz` }),
  };
}

/** One release of the sourced dependent closure: the manifest and payload an archive carries, with its exact bytes. */
export interface SourcedRelease {
  readonly manifest: BundleManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly bytes: Buffer;
  readonly archiveDigest: string;
  readonly manifestDigest: string;
}
type ProductStructure = (root: string) => {
  readonly language: { readonly bytes: Uint8Array };
  readonly product: { readonly manifest: BundleManifest; readonly files: ReadonlyMap<string, Uint8Array> };
};
let sourced: readonly [SourcedRelease, SourcedRelease] | undefined;
/**
 * The actual dependent authoring closure the release tool emits (tools/release/product-structure.mjs): the public
 * language and the product-structure release whose guides resolve only through it, so the product refuses standalone
 * verification. Both are repacked with published provenance, as the distribution suite does, because `registry add`
 * refuses an unpublished archive. The tool is loaded by URL: it sits outside this package, which the CLI's test
 * typecheck keeps to apps/cli, and it composes the distribution sources exactly as a release does.
 */
export async function sourcedClosure(): Promise<readonly [SourcedRelease, SourcedRelease]> {
  if (sourced !== undefined) return sourced;
  const tool = pathToFileURL(join(repository, 'tools/release/product-structure.mjs')).href;
  const { productStructure } = (await import(tool)) as { readonly productStructure: ProductStructure };
  const packed = productStructure(repository);
  const [language, product] = [verifyArchive(packed.language.bytes), packed.product].map((release): SourcedRelease => {
    const manifest = {
      ...release.manifest,
      source: { ...release.manifest.source, repository: 'https://fixture.example/selected', commit: 'a'.repeat(40) },
    };
    const bytes = buildArchive(manifest, release.files);
    return {
      manifest,
      files: release.files,
      bytes,
      archiveDigest: sha256(bytes),
      manifestDigest: sha256(canonicalDistributionJson(manifest)),
    };
  }) as [SourcedRelease, SourcedRelease];
  sourced = [language, product];
  return sourced;
}

/**
 * A directory registry holding the sourced closure exactly as `registry add` publishes it: dependency first, each target
 * through its own exact `selection { lock, archives }` (apps/distribution/SPEC.md, "Registry layout publication with
 * explicit selection"). Nothing is written into the layout by hand.
 */
export function selectedRegistry(closure: readonly [SourcedRelease, SourcedRelease]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ia-cli-registry-')),
    inputs = mkdtempSync(join(tmpdir(), 'ia-cli-registry-input-'));
  try {
    closure.forEach((target, k) => {
      const members = closure.slice(0, k + 1),
        requests = [{ id: target.manifest.id, range: target.manifest.version }];
      const candidates = members.map((release) => ({
        release,
        location: `sha256:${release.archiveDigest}`,
        withdrawn: false,
      }));
      const { lock } = resolveReleases(requests, candidates, DISTRIBUTION_ENGINE_VERSION);
      const archive = join(inputs, `${target.archiveDigest}.ia.tgz`);
      writeFileSync(archive, target.bytes);
      registryAdd({
        dir,
        archive,
        selection: { lock, archives: new Map(members.map((release) => [release.archiveDigest, release.bytes])) },
      });
    });
  } finally {
    rmSync(inputs, { recursive: true, force: true });
  }
  return dir;
}
