import { systemMember } from '@inventarch/db';
import type { InputSnapshot } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import {
  decodeActivationPointer,
  decodeBundleManifest,
  decodeDistributionLock,
  decodeReleaseDescriptor,
  DISTRIBUTION_LIMITS,
  metadataDigest,
  portablePath,
  sha256,
} from '@inventarch/db/distribution';
import type { BundleManifest } from '@inventarch/db/distribution';
import { isProvenance } from '@inventarch/language';
import type { CompiledRecord, EdgeReference } from '@inventarch/language';
import {
  buildArchive,
  inspectArchiveMetadata,
  verifyArchive,
  verifySelectedArchiveClosure,
  type VerifiedArchive,
} from './archive.js';
import { fail } from './files.js';

export type DistributionSourceInput = Pick<InputSnapshot, 'sources' | 'folders' | 'floorOrigin' | 'activation'>;
export interface DistributionSnapshot extends DistributionSourceInput {
  readonly formatVersion: 1;
  readonly fingerprint: string;
}
export interface PackedDistribution extends VerifiedArchive {
  readonly bytes: Buffer;
  readonly sourceFingerprint: string;
}

/** Closed data guards refuse accessors; these functions never select a physical root. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('INPUT-INVALID', 'Expected snapshot data');
  const names = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    names.length !== keys.length ||
    names.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('INPUT-INVALID', 'Unknown, missing or accessor snapshot field');
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > DISTRIBUTION_LIMITS.files ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !Object.hasOwn(field, 'value'))
  )
    fail('INPUT-INVALID', 'Expected bounded snapshot array');
  return value;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function distributionSnapshot(input: unknown): DistributionSnapshot {
  const row = object(input, [
    'sources',
    'folders',
    'floorOrigin',
    ...(input && typeof input === 'object' && Object.hasOwn(input, 'activation') ? ['activation'] : []),
  ]);
  const activation = Object.hasOwn(row, 'activation') ? decodeActivationPointer(row['activation']) : undefined;
  const floorOrigin = row['floorOrigin'];
  if (floorOrigin !== 'explicit' && floorOrigin !== 'local' && floorOrigin !== 'embedded')
    fail('INPUT-INVALID', 'Invalid snapshot floor origin');
  const aliases = new Set<string>();
  let total = 0;
  const sources = array(row['sources'])
    .map((value) => {
      const source = object(value, ['path', 'text', 'location']),
        path = portablePath(source['path']),
        text = source['text'];
      if (
        typeof text !== 'string' ||
        Buffer.from(text).toString('utf8') !== text ||
        Buffer.byteLength(text) > DISTRIBUTION_LIMITS.file
      )
        fail('INPUT-INVALID', 'Invalid snapshot source bytes');
      total += Buffer.byteLength(text);
      if (total > DISTRIBUTION_LIMITS.expanded) fail('LIMIT-EXCEEDED', 'Snapshot source byte ceiling');
      if (!path.startsWith('.ia/') || !path.endsWith('.ia') || aliases.has(path.toLowerCase()))
        fail('INPUT-INVALID', 'Invalid or aliased snapshot source path');
      aliases.add(path.toLowerCase());
      const location = object(source['location'], ['placement', 'provenance']),
        placement = object(location['placement'], ['kind', 'band', 'reach']);
      const kind = placement['kind'],
        band = placement['band'],
        provenance = location['provenance'];
      if (
        (kind !== 'authored' && kind !== 'adopted' && kind !== 'floor') ||
        band !== ({ authored: 100, adopted: 90, floor: 10 } as const)[kind] ||
        placement['reach'] !== '' ||
        typeof provenance !== 'string' ||
        !isProvenance(provenance)
      )
        fail('INPUT-INVALID', 'Invalid snapshot placement or provenance');
      const floor = path.startsWith('.ia/src/floor/'),
        adopted = /^\.ia\/adopted\/[a-z][a-z0-9-]{0,63}\/[a-f0-9]{64}\/\.ia\/src\//.test(path),
        installed = /^\.ia\/distributions\/store\/[a-f0-9]{64}\/\.ia\/src\//.test(path);
      const generated = activation && path === `.ia/distributions/generations/${activation.generation}/workspace.ia`;
      if (
        floor
          ? kind !== 'floor'
          : adopted || installed
            ? kind !== 'adopted'
            : (!path.startsWith('.ia/src/') && !generated) || kind !== 'authored'
      )
        fail('INPUT-INVALID', 'Source path differs from snapshot placement');
      if ((installed && !activation) || ((adopted || installed) && path.includes('/.ia/src/floor/')))
        fail('INPUT-INVALID', 'Unqualified installed or adopted floor source');
      return Object.freeze({
        path,
        text,
        location: Object.freeze({
          placement: Object.freeze({ kind, band: band as 10 | 90 | 100, reach: '' }),
          provenance,
        }),
      });
    })
    .sort((a, b) => compare(a.path, b.path));
  for (const path of aliases) {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++)
      if (aliases.has(parts.slice(0, count).join('/'))) fail('INPUT-INVALID', 'Snapshot file/directory collision');
  }
  const folders = array(row['folders'])
    .map((value) => {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
        fail('INPUT-INVALID', 'Invalid snapshot system folder');
      return value;
    })
    .sort(compare);
  if (new Set(folders).size !== folders.length) fail('INPUT-INVALID', 'Duplicate snapshot folder');
  const body: DistributionSourceInput = {
    sources: Object.freeze(sources),
    folders: Object.freeze(folders),
    floorOrigin,
    ...(activation ? { activation } : {}),
  };
  return Object.freeze({ formatVersion: 1, ...body, fingerprint: metadataDigest(body) });
}

/** Recompute the complete commitment instead of trusting a typed caller's fingerprint. */
export function verifyDistributionSnapshot(input: unknown): DistributionSnapshot {
  const row = object(input, [
    'formatVersion',
    'fingerprint',
    'sources',
    'folders',
    'floorOrigin',
    ...(input && typeof input === 'object' && Object.hasOwn(input, 'activation') ? ['activation'] : []),
  ]);
  const { formatVersion, fingerprint, ...body } = row,
    result = distributionSnapshot(body);
  if (formatVersion !== 1 || fingerprint !== result.fingerprint) fail('INPUT-INVALID', 'Snapshot fingerprint differs');
  return result;
}

function textField(record: CompiledRecord, key: string): string {
  const fields = record.head.filter((f) => f.key === key);
  if (fields.length !== 1 || !('text' in fields[0]!.value))
    fail('CLOSURE-INVALID', `Expected ${record.identity}.${key}`);
  return (fields[0]!.value as { text: string }).text;
}
/** Visits compiled semantic data, including references beneath conditional fields/cells. */
function references(value: unknown, add: (ref: EdgeReference) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v) => {
      references(v, add);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (
    (row['kind'] === 'ref' && typeof row['discriminator'] === 'string' && typeof row['name'] === 'string') ||
    (row['kind'] === 'identity' && typeof row['identity'] === 'string')
  ) {
    add(row as unknown as EdgeReference);
    return;
  }
  Object.values(row).forEach((v) => {
    references(v, add);
  });
}
/** Shared whole-system packing over exact source and explicit asset bytes. */
export function packSnapshot(
  input: DistributionSnapshot,
  descriptorInput: unknown,
  assetInput: ReadonlyMap<string, Uint8Array>,
): PackedDistribution {
  const pending = preparePack(input, descriptorInput, assetInput);
  return Object.freeze({ ...verifyArchive(pending.bytes), ...pending });
}

/** Explicit dependent-authoring pack; existing standalone pack semantics remain unchanged. */
export function packSnapshotWithDependencies(
  input: DistributionSnapshot,
  descriptorInput: unknown,
  assetInput: ReadonlyMap<string, Uint8Array>,
  dependencyLock: unknown,
  dependencyArchives: ReadonlyMap<string, Uint8Array>,
): PackedDistribution {
  const lock = decodeDistributionLock(dependencyLock);
  verifySelectedArchiveClosure(lock, dependencyArchives);
  const pending = preparePack(input, descriptorInput, assetInput);
  const { manifest, archiveDigest: archive, manifestDigest } = inspectArchiveMetadata(pending.bytes).pending;
  if (lock.packages.some((pkg) => pkg.id === manifest.id))
    fail('CLOSURE-INVALID', 'Dependency selection already contains the packed release');
  const selected = decodeDistributionLock({
    ...lock,
    requests: [{ id: manifest.id, range: manifest.version }],
    packages: [
      ...lock.packages,
      {
        id: manifest.id,
        version: manifest.version,
        archive,
        manifest: manifestDigest,
        location: `sha256:${archive}`,
        dependencies: manifest.dependencies.map((item) => item.id),
      },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
  const archives = new Map(dependencyArchives);
  archives.set(archive, pending.bytes);
  const verified = verifySelectedArchiveClosure(selected, archives).get(manifest.id);
  if (!verified) fail('CLOSURE-INVALID', 'Packed release missing from selected closure');
  return Object.freeze({ ...verified, ...pending });
}

/** Atomically verifies mutually dependent whole-system releases; no pending member escapes as verified. */
export function packSnapshotSet(
  input: DistributionSnapshot,
  releases: readonly { readonly descriptor: unknown; readonly assets: ReadonlyMap<string, Uint8Array> }[],
): readonly PackedDistribution[] {
  if (!Array.isArray(releases) || !releases.length || releases.length > DISTRIBUTION_LIMITS.bundles)
    fail('INPUT-INVALID', 'Expected a bounded nonempty release set');
  const snapshot = verifyDistributionSnapshot(input);
  const pending = releases.map((release) => preparePack(snapshot, release.descriptor, release.assets, true));
  const metadata = pending.map((row) => inspectArchiveMetadata(row.bytes).pending);
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: metadata[0]!.manifest.engine,
    requests: metadata
      .map((row) => ({ id: row.manifest.id, range: row.manifest.version }))
      .sort((a, b) => compare(a.id, b.id)),
    packages: metadata
      .map((row) => ({
        id: row.manifest.id,
        version: row.manifest.version,
        archive: row.archiveDigest,
        manifest: row.manifestDigest,
        location: `sha256:${row.archiveDigest}`,
        dependencies: row.manifest.dependencies.map((dependency) => dependency.id),
      }))
      .sort((a, b) => compare(a.id, b.id)),
  });
  if (metadata.some((row) => row.manifest.engine !== lock.engine))
    fail('CLOSURE-INVALID', 'Release set engine contracts differ');
  const archives = new Map(pending.map((row, index) => [metadata[index]!.archiveDigest, row.bytes]));
  const verified = verifySelectedArchiveClosure(lock, archives);
  return Object.freeze(
    pending.map((row, index) => Object.freeze({ ...verified.get(metadata[index]!.manifest.id)!, ...row })),
  );
}

function preparePack(
  input: DistributionSnapshot,
  descriptorInput: unknown,
  assetInput: ReadonlyMap<string, Uint8Array>,
  selectedDeclaration = false,
): { readonly bytes: Buffer; readonly sourceFingerprint: string } {
  const before = verifyDistributionSnapshot(input),
    descriptor = decodeReleaseDescriptor(descriptorInput);
  // A descriptor may name no distribution (db's release descriptor, plan amendment B7): it releases nothing.
  if (descriptor.distribution === undefined)
    fail('CLOSURE-INVALID', 'Release descriptor names no distribution; there is nothing to pack');
  if (!(assetInput instanceof Map) || assetInput.size !== descriptor.assets.length)
    fail('INPUT-INVALID', 'Assets differ from exact descriptor inventory');
  const assets = new Map<string, Buffer>();
  let assetBytes = 0;
  for (const asset of descriptor.assets) {
    const content = assetInput.get(asset.path);
    if (!(content instanceof Uint8Array) || content.length > DISTRIBUTION_LIMITS.file)
      fail('CLOSURE-INVALID', `Missing or oversized explicit asset: ${asset.path}`);
    assetBytes += content.length;
    if (assetBytes > DISTRIBUTION_LIMITS.expanded) fail('LIMIT-EXCEEDED', 'Asset byte ceiling');
    assets.set(asset.path, Buffer.from(content));
  }
  const reader = new EditorSnapshot({ root: '', ...before });
  try {
    const errors = reader.report.findings.filter((f) => f.severity === 'error');
    if (errors.length || reader.refused.length || reader.inspect().blockedSystems.length)
      fail(
        'ADMISSION-FAILED',
        errors.length ? JSON.stringify(errors) : 'Native snapshot contains refused records or blocked systems',
      );
    const records = reader.records(),
      distribution = records.find((r) => r.identity === descriptor.distribution && r.discriminator === 'distribution');
    if (!distribution) fail('CLOSURE-INVALID', 'Distribution must be one admitted native declaration');
    const declarationOwner = systemMember(distribution.source.path);
    if (
      !declarationOwner ||
      declarationOwner.root !== `.ia/src/systems/${declarationOwner.name}` ||
      (!selectedDeclaration && descriptor.dependencies.some((d) => d.systems.includes(declarationOwner.name)))
    )
      fail('CLOSURE-INVALID', 'Release must include its own authored distribution declaration');
    const fields = distribution.sections
      .filter((s) => s.name === 'distribution')
      .flatMap((s) => s.fields)
      .filter((f) => 'key' in f && f.key === 'records');
    const field = fields[0];
    if (
      fields.length !== 1 ||
      !field ||
      !('value' in field) ||
      field.when ||
      field.value.kind !== 'list' ||
      !field.value.items.length ||
      field.value.items.some((v) => v.kind !== 'ref')
    )
      fail('CLOSURE-INVALID', 'Distribution requires unconditional typed roots');
    const resolve = (ref: EdgeReference): CompiledRecord => {
      const result = reader.resolve(ref);
      if (!result.ok) fail('CLOSURE-INVALID', `${result.code}: ${JSON.stringify(ref)}`);
      const node = records.find((r) => r.identity === result.identity);
      if (!node) fail('CLOSURE-INVALID', 'Resolved reference is unavailable');
      return node;
    };
    const roots = field.value.items.map((v) => resolve(v as EdgeReference)),
      selected = new Set<string>(),
      pending: string[] = [],
      usedExternal = new Set<string>();
    const externals = new Map(descriptor.dependencies.flatMap((d) => d.systems.map((s) => [s, d.id] as const)));
    const include = (record: CompiledRecord): void => {
      if (record.source.path.startsWith('.ia/src/floor/')) return;
      const member = systemMember(record.source.path);
      if (!member) fail('CLOSURE-INVALID', 'Release roots must belong to native system folders');
      const external = externals.get(member.name);
      if (external) {
        usedExternal.add(external);
        return;
      }
      if (member.root !== `.ia/src/systems/${member.name}`)
        fail('CLOSURE-INVALID', 'Adopted dependencies must be explicitly externalized');
      if (!selected.has(member.name)) {
        selected.add(member.name);
        pending.push(member.name);
      }
    };
    include(distribution);
    roots.forEach(include);
    while (pending.length) {
      const name = pending.shift()!,
        system = records.find(
          (r) =>
            r.discriminator === 'system' && r.name === name && r.source.path === `.ia/src/systems/${name}/system.ia`,
        );
      if (!system) fail('CLOSURE-INVALID', `No admitted system declaration for ${name}`);
      for (const requirement of system.sections
        .filter((section) => section.name === 'requires')
        .flatMap((section) => section.fields)) {
        if (!('item' in requirement) || !('text' in requirement.item))
          fail('CLOSURE-INVALID', 'Invalid admitted system requirement');
        // The fixed language floor is provided by the target and never bundled.
        if (requirement.item.text !== 'floor')
          include(resolve({ kind: 'ref', discriminator: 'system', name: requirement.item.text }));
      }
      for (const record of records.filter((r) => systemMember(r.source.path)?.name === name))
        references(record, (ref) => include(resolve(ref)));
    }
    if (descriptor.dependencies.some((d) => !usedExternal.has(d.id)))
      fail('CLOSURE-INVALID', 'Unused external dependency assignment');
    const files = new Map<string, Buffer>(),
      pins: BundleManifest['files'][number][] = [];
    for (const source of before.sources) {
      const member = systemMember(source.path);
      if (!member || !selected.has(member.name) || member.root !== `.ia/src/systems/${member.name}`) continue;
      const content = Buffer.from(source.text);
      files.set(source.path, content);
      pins.push({ path: source.path, bytes: content.length, sha256: sha256(content), role: 'source' });
    }
    for (const asset of descriptor.assets) {
      const content = assets.get(asset.path)!;
      files.set(asset.path, content);
      pins.push({ ...asset, bytes: content.length, sha256: sha256(content) });
    }
    const systems = [...selected].sort().map((name) => {
      const record = records.find((r) => r.discriminator === 'system' && r.name === name)!;
      return {
        name,
        path: `.ia/src/systems/${name}`,
        provider: textField(record, 'provider'),
        version: textField(record, 'version'),
      };
    });
    const { assets: _assets, dependencies, ...common } = descriptor;
    const manifest = decodeBundleManifest({
      ...common,
      roots: [...new Set(roots.map((r) => r.identity))].sort(),
      systems,
      dependencies: dependencies.map(({ id, range }) => ({ id, range })),
      files: pins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    });
    const archive = buildArchive(manifest, files);
    return Object.freeze({ bytes: archive, sourceFingerprint: before.fingerprint });
  } finally {
    reader.close();
  }
}
