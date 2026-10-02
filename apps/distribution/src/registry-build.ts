import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { compareVersions, DISTRIBUTION_LIMITS, packageId, version as semverVersion } from '@ia/db/distribution';
import type { DistributionLock } from '@ia/db/distribution';
import { inspectArchiveMetadata, verifyArchive, verifySelectedArchiveClosure } from './archive.js';
import { matchRegistryRelease } from './registry-admission.js';
import { resolveReleases } from './resolve.js';
import {
  bytes,
  contained,
  createFile,
  DistributionError,
  fail,
  json,
  locate,
  replace,
  utf8,
  workspace,
} from './files.js';
import {
  decodePackageIndex,
  decodeRegistryInfo,
  packageIndexPath,
  REGISTRY_LIMITS,
  relabel,
} from './registry-layout.js';
import type { PackageIndex, RegistryInfo, RegistryRelease } from './registry-layout.js';

/** Registry spec §8: the layout builder. Writes stay inside the registry directory and refuse links (files.ts); it never contacts a network. */
export interface RegistryAddRequest {
  readonly dir: string;
  readonly archive: string;
  readonly name?: string | undefined;
  /** Exact target/dependency closure. Dependencies must already be published publicly in this registry. */
  readonly selection?: { readonly lock: DistributionLock; readonly archives: ReadonlyMap<string, Uint8Array> };
}
export interface RegistryWithdrawRequest {
  readonly dir: string;
  readonly id: string;
  readonly version: string;
}
const INFO = 'ia-registry.json';
/** Canonical registry JSON: `json()`'s sorted keys, re-indented by 2 spaces with a trailing newline, so built files diff cleanly. */
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(JSON.parse(json(value)), null, 2) + '\n');
/** Registry files are public static data, served or mirrored by other users: world-readable, unlike install state. */
const PUBLIC = 0o644;
/** The `--registry` directory: absolute, existing, reached without links. */
function registryRoot(dir: string): string {
  if (!isAbsolute(dir)) fail('INPUT-INVALID', 'An absolute --registry is required');
  const path = contained(dir);
  if (!existsSync(path) || !lstatSync(path).isDirectory())
    fail('INPUT-INVALID', `Registry directory must already exist: ${dir}`);
  return workspace(dir);
}
/** Decodes one existing registry document, naming its path; never rewrites a file that does not decode. */
const existing = <T>(root: string, path: string, decode: (text: string) => T): T | null =>
  locate(path, () => {
    const content = bytes(root, path, REGISTRY_LIMITS.indexBytes);
    return content === null ? null : relabel(() => decode(utf8(content)), '', `: ${path}`);
  });
const readInfo = (root: string): RegistryInfo | null => existing(root, INFO, decodeRegistryInfo);
/** `signed`: the index carries the reserved `signatures` field (§3), which decodes but which this builder cannot maintain. */
const readIndex = (root: string, id: string): { readonly index: PackageIndex; readonly signed: boolean } | null =>
  existing(root, packageIndexPath(id), (text) => ({
    index: decodePackageIndex(text, id),
    signed: Object.hasOwn(JSON.parse(text) as object, 'signatures'),
  }));
const unsigned = (read: { readonly signed: boolean } | null, path: string): void => {
  if (read?.signed) fail('INPUT-INVALID', `${path} carries reserved signatures this builder cannot maintain`);
};
/** Creates one new registry file. A file that appeared meanwhile is accepted only if it holds exactly these bytes; the result is read back either way. */
function create(root: string, path: string, content: Buffer): void {
  try {
    createFile(root, path, content, PUBLIC);
  } catch (error) {
    if (!(error instanceof DistributionError && error.code === 'IA-DIST-LOCAL-MODIFICATION')) throw error;
  }
  if (!bytes(root, path, DISTRIBUTION_LIMITS.compressed)?.equals(content))
    fail('CONFLICT', `Registry changed while adding: ${path}`);
}
/** Encodes an index and round-trips it through the Task 2 decoder under the §3 bounds before any write. */
function indexContent(id: string, releases: readonly RegistryRelease[]): Buffer {
  if (releases.length > REGISTRY_LIMITS.releases)
    fail('LIMIT-EXCEEDED', `Registry index exceeds ${REGISTRY_LIMITS.releases} releases`);
  const content = encode({ format: 'ia.registry-package.v1', id, releases });
  if (content.length > REGISTRY_LIMITS.indexBytes)
    fail('LIMIT-EXCEEDED', `Registry index exceeds ${REGISTRY_LIMITS.indexBytes} bytes`);
  relabel(() => decodePackageIndex(utf8(content), id), 'Built registry index does not decode: ');
  return content;
}
/** Contextual admission never permits a registry entry to rely on unpublished or substituted dependency bytes. */
function selectedArchive(root: string, content: Buffer, selection: NonNullable<RegistryAddRequest['selection']>) {
  const pending = inspectArchiveMetadata(content).pending;
  const admitted = verifySelectedArchiveClosure(selection.lock, selection.archives);
  const target = admitted.get(pending.manifest.id);
  if (!target || target.archiveDigest !== pending.archiveDigest || target.manifestDigest !== pending.manifestDigest)
    fail('INTEGRITY-MISMATCH', 'Selected registry target differs from the supplied archive');
  const resolved = resolveReleases(
    [{ id: target.manifest.id, range: target.manifest.version }],
    [...admitted.values()].map((release) => ({
      release,
      location: `sha256:${release.archiveDigest}`,
      withdrawn: false,
    })),
    selection.lock.engine,
  );
  if (resolved.releases.size !== admitted.size)
    fail('INPUT-INVALID', 'Supply only the target and its declared dependency closure');
  for (const [id, dependency] of admitted) {
    if (id === target.manifest.id) continue;
    const listed = readIndex(root, id)?.index.releases.find((row) => row.version === dependency.manifest.version);
    if (
      !listed ||
      listed.withdrawn ||
      listed.access !== 'public' ||
      listed.archive !== dependency.archiveDigest ||
      listed.manifest !== dependency.manifestDigest
    )
      fail(
        'CONFLICT',
        `Selected dependency is not an available exact public registry release: ${id}@${dependency.manifest.version}`,
      );
    matchRegistryRelease(id, listed, dependency);
    const stored = bytes(root, `artifacts/${dependency.archiveDigest}.ia.tgz`, DISTRIBUTION_LIMITS.compressed);
    if (!stored || !stored.equals(Buffer.from(selection.archives.get(dependency.archiveDigest)!)))
      fail('INTEGRITY-MISMATCH', `Registry dependency bytes differ: ${id}@${dependency.manifest.version}`);
  }
  return target;
}
/**
 * Adds one verified, published archive: `artifacts/<archive>.ia.tgz`, then `ia-registry.json` if absent, then the package
 * index, so an index never names a missing artifact. Releases stay in `compareVersions` order (highest first). The same
 * version with the same digests is a no-op; with different digests it refuses `CONFLICT` (§3 append-only).
 */
export function registryAdd(request: RegistryAddRequest): {
  readonly status: 'registry-added';
  readonly id: string;
  readonly version: string;
  readonly archive: string;
} {
  const root = registryRoot(request.dir);
  if (!isAbsolute(request.archive)) fail('INPUT-INVALID', 'An absolute --archive is required');
  const content =
    locate(request.archive, () =>
      relabel(
        () => bytes(dirname(request.archive), basename(request.archive), DISTRIBUTION_LIMITS.compressed),
        `Input archive ${request.archive}: `,
      ),
    ) ?? fail('INPUT-INVALID', `Missing input archive: ${request.archive}`);
  const verified = request.selection ? selectedArchive(root, content, request.selection) : verifyArchive(content),
    manifest = verified.manifest,
    digest = verified.archiveDigest;
  if (manifest.source.repository === null)
    fail('INPUT-INVALID', 'An unpublished local archive carries no source provenance and cannot be published');
  const info = readInfo(root);
  if (info !== null && request.name !== undefined && request.name !== info.name)
    fail('CONFLICT', `Registry is already named "${info.name}", not "${request.name}"`);
  const infoContent = info === null ? encode({ format: 'ia.registry.v1', name: request.name ?? basename(root) }) : null;
  if (infoContent !== null) relabel(() => decodeRegistryInfo(utf8(infoContent)), 'Invalid registry name: ');
  const id = manifest.id,
    path = packageIndexPath(id),
    artifact = `artifacts/${digest}.ia.tgz`,
    read = readIndex(root, id),
    releases = read?.index.releases ?? [];
  const entry: RegistryRelease = {
    version: manifest.version,
    archive: digest,
    manifest: verified.manifestDigest,
    engine: manifest.engine,
    language: manifest.language,
    dependencies: manifest.dependencies.map((d) => ({ id: d.id, range: d.range })),
    withdrawn: false,
    access: 'public',
    artifact,
  };
  const listed = releases.find((r) => r.version === entry.version);
  if (listed && (listed.archive !== entry.archive || listed.manifest !== entry.manifest))
    fail('CONFLICT', `Registry already lists ${id}@${entry.version} with different bytes`);
  if (listed && listed.access !== 'public')
    fail('CONFLICT', `Registry already lists ${id}@${entry.version} as licensed`);
  if (!listed) unsigned(read, path);
  const indexed = listed
    ? null
    : indexContent(
        id,
        [...releases, entry].sort((a, b) => compareVersions(a.version, b.version)),
      );
  const present = bytes(root, artifact, DISTRIBUTION_LIMITS.compressed);
  if (present !== null && !present.equals(content))
    fail('CONFLICT', `Registry ${artifact} differs from the bytes its name pins`);
  if (present === null) create(root, artifact, content);
  if (infoContent !== null) create(root, INFO, infoContent);
  if (indexed !== null) replace(root, path, indexed, PUBLIC);
  return { status: 'registry-added', id, version: entry.version, archive: digest };
}
/** Marks one listed release withdrawn (§8); removes nothing and never touches artifacts. Withdrawing a withdrawn release is a no-op. */
export function registryWithdraw(request: RegistryWithdrawRequest): {
  readonly status: 'registry-withdrawn';
  readonly id: string;
  readonly version: string;
} {
  const root = registryRoot(request.dir),
    id = relabel(() => packageId(request.id), 'Invalid --id: '),
    version = relabel(() => semverVersion(request.version), 'Invalid --version: ');
  if (readInfo(root) === null) fail('INPUT-INVALID', `Not a registry: ${request.dir} has no ${INFO}`);
  const read = readIndex(root, id) ?? fail('INPUT-INVALID', `Registry lists no package ${id}`),
    index = read.index,
    path = packageIndexPath(id);
  const listed =
    index.releases.find((r) => r.version === version) ?? fail('INPUT-INVALID', `Registry lists no ${id}@${version}`);
  if (!listed.withdrawn) {
    unsigned(read, path);
    replace(
      root,
      path,
      indexContent(
        id,
        index.releases.map((r) => (r === listed ? { ...r, withdrawn: true } : r)),
      ),
      PUBLIC,
    );
  }
  return { status: 'registry-withdrawn', id, version };
}
