import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { readInputs } from '@inventarch/db';
import { canonicalDistributionJson, sha256, type BundleManifest } from '@inventarch/db/distribution';
import { buildArchive, verifyArchive } from '../src/archive.js';
import { distributionSnapshot, packSnapshot, type PackedDistribution } from '../src/snapshot.js';
import { descriptor, repository, sourceInput } from './snapshot-fixture.js';
import { planInstallationSnapshot } from '../src/installation-core.js';
import { resolveReleases } from '../src/resolve.js';

const manifestPath = '.ia/authoring.resources.json';
let snapshot: ReturnType<typeof distributionSnapshot>,
  packed: PackedDistribution,
  assets: Map<string, Buffer>,
  release: typeof descriptor;
beforeAll(() => {
  snapshot = distributionSnapshot(sourceInput(readInputs(repository)));
  const manifest = JSON.parse(readFileSync(resolve(repository, manifestPath), 'utf8')) as { files: { path: string }[] };
  const selected = [
    { path: 'LICENSE', role: 'license' },
    { path: manifestPath, role: 'asset' },
    ...manifest.files.map((f) => ({ path: f.path, role: 'documentation' })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  release = { ...descriptor, license: 'MIT', assets: selected };
  assets = new Map(selected.map((asset) => [asset.path, readFileSync(resolve(repository, asset.path))]));
  packed = packSnapshot(snapshot, release, assets);
}, 30_000);
function rewritten(
  changes: ReadonlyMap<string, Buffer>,
  removed: ReadonlySet<string> = new Set(),
  extra: readonly { path: string; role: 'documentation'; content: Buffer }[] = [],
  transform?: (value: BundleManifest) => BundleManifest,
): Buffer {
  const files = new Map<string, Buffer>(
    [...packed.files]
      .filter(([path]) => !removed.has(path))
      .map(([path, bytes]) => [path, Buffer.from(changes.get(path) ?? bytes)]),
  );
  for (const file of extra) files.set(file.path, file.content);
  const pins = [
    ...packed.manifest.files.filter((pin) => !removed.has(pin.path)),
    ...extra.map((file) => ({
      path: file.path,
      bytes: file.content.length,
      sha256: sha256(file.content),
      role: file.role,
    })),
  ]
    .map((pin) => ({ ...pin, bytes: files.get(pin.path)!.length, sha256: sha256(files.get(pin.path)!) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = { ...packed.manifest, files: pins };
  return buildArchive(transform ? transform(manifest) : manifest, files);
}
it('refuses native guide packing without its explicit resource closure', () => {
  expect(snapshot.sources.some((s) => s.path.endsWith('/records/public-guides.ia'))).toBe(true);
  expect(() =>
    packSnapshot(snapshot, { ...descriptor, license: 'MIT' }, new Map([['LICENSE', assets.get('LICENSE')!]])),
  ).toThrow(/authoring/i);
});
it('verifies all actual guide assets and the embedded-floor joins without reading an application root', () => {
  const verified = verifyArchive(packed.bytes);
  expect(verified.files.get(manifestPath)).toEqual(assets.get(manifestPath));
  expect(verified.manifest.files.filter((f) => f.role === 'documentation')).toHaveLength(67);
});
it('cannot reuse successful structural evidence for tampered bytes or a caller-supplied digest', () => {
  expect(verifyArchive(packed.bytes).archiveDigest).toBe(packed.archiveDigest);
  const altered = rewritten(new Map([[manifestPath, Buffer.from('{}')]]));
  expect(() => verifyArchive(altered, packed.archiveDigest)).toThrow(/digest/i);
  expect(() => verifyArchive(altered)).toThrow(/authoring/i);
  expect(verifyArchive(packed.bytes).files.get(manifestPath)).toEqual(assets.get(manifestPath));
});
it('rejects canonical archives with missing, altered or stray protected resource assets', () => {
  const path = '.ia/src/systems/authoring-system/reference/agent-profile.md';
  for (const archive of [
    rewritten(new Map(), new Set([path])),
    rewritten(new Map([[path, Buffer.from('# Different bytes\n')]])),
    rewritten(new Map(), new Set(), [
      {
        path: '.ia/src/systems/authoring-system/private.md',
        role: 'documentation',
        content: Buffer.from('Unselected protected data\n'),
      },
    ]),
  ])
    expect(() => verifyArchive(archive)).toThrow(/authoring/i);
}, 30_000);
it('rejects partial and external source claims and a native primary that disagrees with its exact association', () => {
  const manifest = JSON.parse(assets.get(manifestPath)!.toString('utf8')) as {
    associations: { owner: { source: string } }[];
  };
  manifest.associations[0]!.owner.source = 'external';
  expect(() => verifyArchive(rewritten(new Map([[manifestPath, Buffer.from(JSON.stringify(manifest))]])))).toThrow(
    /authoring/i,
  );
  expect(() =>
    verifyArchive(
      rewritten(new Map(), new Set(), [], (m) => ({
        ...m,
        dependencies: [{ id: 'external/missing', range: '^1.0.0' }],
      })),
    ),
  ).toThrow(/authoring/i);
  const path = '.ia/src/systems/authoring-system/records/public-guides.ia',
    original = packed.files.get(path)!.toString('utf8');
  const changed = original.replace(
    'document ".ia/src/systems/authoring-system/reference/agent-profile.md"',
    'document ".ia/src/systems/authoring-system/reference/capability.md"',
  );
  expect(changed).not.toBe(original);
  expect(() => verifyArchive(rewritten(new Map([[path, Buffer.from(changed)]])))).toThrow(/authoring/i);
}, 30_000);
it('revalidates authoring evidence when installing an otherwise exactly pinned archive', () => {
  const base = distributionSnapshot({
    sources: snapshot.sources.filter((source) => source.location.placement.kind === 'floor'),
    folders: [],
    floorOrigin: snapshot.floorOrigin,
  });
  const { lock } = resolveReleases(
    [{ id: packed.manifest.id, range: packed.manifest.version }],
    [{ release: packed, location: `sha256:${packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  const request = {
    base,
    current: null,
    lock,
    archives: new Map([[packed.archiveDigest, packed.bytes]]),
    operation: 'install' as const,
  };
  expect(planInstallationSnapshot(request).inputs.systems).toHaveLength(11);
  let altered!: BundleManifest;
  const bytes = rewritten(new Map([[manifestPath, Buffer.from('{}')]]), new Set(), [], (value) => {
    altered = value;
    return value;
  });
  const archive = sha256(bytes),
    changed = {
      ...lock,
      packages: lock.packages.map((pkg) => ({
        ...pkg,
        archive,
        manifest: sha256(canonicalDistributionJson(altered)),
        location: `sha256:${archive}`,
      })),
    };
  expect(() => planInstallationSnapshot({ ...request, lock: changed, archives: new Map([[archive, bytes]]) })).toThrow(
    /authoring/i,
  );
}, 30_000);
