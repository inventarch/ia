import { expect, it } from 'vitest';
import {
  canonicalDistributionJson,
  checkInstalledImplementations,
  compareVersions,
  decodeActivationPointer,
  decodeBundleManifest,
  decodeDistributionJson,
  decodeDistributionLock,
  decodeGenerationInputs,
  decodeReleaseDescriptor,
  generationDigest,
  satisfies,
  supportsDistributionLockEngine,
  DISTRIBUTION_ENGINE_VERSION,
  sha256,
} from '../src/distribution/index.js';

const hash = 'a'.repeat(64),
  other = 'b'.repeat(64);
const common = {
  formatVersion: 1,
  id: 'test/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/binding/distribution/foundation-distribution',
  engine: '^0.1.0',
  language: ['1.0'],
  source: { repository: 'https://example.com/foundation', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 0 },
  license: 'UNLICENSED',
  description: 'Original test fixture',
};
const manifest = {
  ...common,
  roots: ['workspace-system/binding/workspace/foundation-workspace'],
  systems: [
    { name: 'fixture-system', provider: 'example.test', version: '0.1.0', path: '.ia/src/systems/fixture-system' },
  ],
  dependencies: [],
  files: [{ path: '.ia/src/systems/fixture-system/system.ia', bytes: 0, sha256: sha256(''), role: 'source' }],
};
const selected = {
  id: common.id,
  version: common.version,
  archive: hash,
  manifest: other,
  location: `sha256:${hash}`,
  dependencies: [],
};
const lock = {
  formatVersion: 1,
  engine: '^0.1.0',
  requests: [{ id: common.id, range: '^0.1.0' }],
  packages: [selected],
};
const inputs = {
  formatVersion: 1,
  bundles: [{ id: common.id, archive: hash }],
  systems: [
    {
      name: 'fixture-system',
      provider: 'example.test',
      version: '0.1.0',
      bundles: [common.id],
      selected: common.id,
      files: ['.ia/src/systems/fixture-system/system.ia'],
    },
  ],
};

it('permits only the exact protected authoring manifest/document roles while retaining hidden/build refusals', () => {
  const assets = [
    { path: '.ia/authoring.resources.json', role: 'asset' },
    { path: '.ia/src/floor/schema.SPEC.md', role: 'documentation' },
    { path: '.ia/src/systems/fixture-system/references/guide.md', role: 'documentation' },
  ];
  expect(decodeReleaseDescriptor({ ...common, dependencies: [], assets }).assets).toHaveLength(3);
  const withAssets = (assets: readonly { path: string; role: string }[]) =>
    [...manifest.files, ...assets.map((a) => ({ ...a, bytes: 0, sha256: sha256('') }))].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    );
  expect(decodeBundleManifest({ ...manifest, files: withAssets(assets) }).files).toHaveLength(4);
  for (const asset of [
    { path: '.ia/authoring.resources.json', role: 'documentation' },
    { path: '.ia/src/floor/schema.SPEC.md', role: 'asset' },
    { path: '.ia/private.json', role: 'asset' },
    { path: '.ia/src/.private/readme.md', role: 'documentation' },
    { path: '.ia/src/systems/fixture-system/node_modules/readme.md', role: 'documentation' },
    { path: 'dist/public.md', role: 'documentation' },
    { path: '.env', role: 'asset' },
  ]) {
    expect(() => decodeReleaseDescriptor({ ...common, dependencies: [], assets: [asset] })).toThrow();
    expect(() => decodeBundleManifest({ ...manifest, files: withAssets([asset]) })).toThrow();
  }
});

it('round-trips frozen closed release metadata with stable canonical bytes', () => {
  const descriptor = decodeReleaseDescriptor({
    ...common,
    dependencies: [],
    assets: [{ path: 'LICENSE', role: 'license' }],
  });
  expect(decodeReleaseDescriptor(canonicalDistributionJson(descriptor))).toEqual(descriptor);
  expect(Object.isFrozen(descriptor.source)).toBe(true);
  expect(decodeBundleManifest(canonicalDistributionJson(manifest))).toEqual(manifest);
  expect(decodeReleaseDescriptor({ ...descriptor, version: '1.2.3-rc.1+build.4' }).version).toBe('1.2.3-rc.1+build.4');
  expect(() => decodeReleaseDescriptor({ ...descriptor, version: 'v1.2.3' })).toThrow();
  expect(compareVersions('2.0.0', '1.0.0')).toBeLessThan(0);
  expect(satisfies('1.3.0-rc.1', '^1.0.0')).toBe(false);
  expect(satisfies('1.3.0-rc.1', '>=1.3.0-rc.0 <1.3.0')).toBe(true);
});
it('decodes a release descriptor that names no distribution, and a bundle manifest only with one', () => {
  // Position-packet plan amendment B7: a default `ia init` authors no @distribution, so its descriptor omits the key.
  const { distribution: _distribution, ...unnamed } = { ...common, dependencies: [], assets: [] };
  const descriptor = decodeReleaseDescriptor(unnamed);
  expect(Object.hasOwn(descriptor, 'distribution')).toBe(false);
  expect(descriptor.distribution).toBeUndefined();
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(decodeReleaseDescriptor(canonicalDistributionJson(descriptor))).toEqual(descriptor);
  expect(canonicalDistributionJson(descriptor)).not.toContain('distribution');
  // The key is optional, never nullable or loose: present, it must still be a native distribution identity.
  for (const distribution of [null, '', 'workspace-system/binding/workspace/foundation-workspace'])
    expect(() => decodeReleaseDescriptor({ ...unnamed, distribution })).toThrow();
  expect(decodeReleaseDescriptor({ ...unnamed, distribution: common.distribution }).distribution).toBe(
    common.distribution,
  );
  const { distribution: _manifestDistribution, ...anonymous } = manifest;
  expect(() => decodeBundleManifest(anonymous)).toThrow('Unknown, missing or accessor field');
  // The manifest keeps its key order, so its canonical bytes are unchanged.
  expect(Object.keys(decodeBundleManifest(manifest))).toEqual(Object.keys(manifest));
});
it('accepts unpublished local provenance only as a null repository and commit pair', () => {
  const source = { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 };
  const descriptor = decodeReleaseDescriptor({ ...common, source, dependencies: [], assets: [] });
  expect(descriptor.source).toEqual(source);
  expect(decodeReleaseDescriptor(canonicalDistributionJson(descriptor))).toEqual(descriptor);
  expect(decodeBundleManifest({ ...manifest, source }).source).toEqual(source);
  expect(canonicalDistributionJson(decodeBundleManifest(manifest))).toBe(canonicalDistributionJson(manifest));
  for (const partial of [
    { ...common.source, repository: null },
    { ...common.source, commit: null },
    { ...source, commit: 'a'.repeat(40) },
    { repository: null, commit: null, recipe: 'ustar-v1' },
  ])
    expect(() => decodeReleaseDescriptor({ ...common, source: partial, dependencies: [], assets: [] })).toThrow();
});
it('rejects unknown fields/versions, credentials, duplicates, hidden assets and external system aliases', () => {
  const base = { ...common, dependencies: [], assets: [] };
  for (const patch of [
    { unknown: true },
    { formatVersion: 2 },
    { id: 'unqualified' },
    { engine: 'latest' },
    { source: { ...common.source, repository: 'https://user:secret@example.com/' } },
    { assets: [{ path: '.env', role: 'asset' }] },
    {
      dependencies: [
        { id: 'test/a', range: '*', systems: ['x'] },
        { id: 'test/b', range: '*', systems: ['x'] },
      ],
    },
  ])
    expect(() => decodeReleaseDescriptor({ ...base, ...patch })).toThrow();
  expect(() => decodeDistributionJson('{"x":1,"\\u0078":2}')).toThrow('Duplicate');
  for (const json of ['[1,]', '{"x":1}x', '1e999', '"\\ud800"']) expect(() => decodeDistributionJson(json)).toThrow();
});
it('refuses object accessors, cycles, sparse arrays and excessive metadata without invoking getters', () => {
  let invoked = false;
  const accessor = { ...manifest };
  Object.defineProperty(accessor, 'files', {
    get() {
      invoked = true;
      throw Error('getter');
    },
    enumerable: true,
  });
  expect(() => decodeBundleManifest(accessor)).toThrow();
  expect(invoked).toBe(false);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => canonicalDistributionJson(cycle)).toThrow();
  expect(() => canonicalDistributionJson(Array(3))).toThrow();
  expect(() => canonicalDistributionJson({ bytes: 'x'.repeat(4 * 1024 * 1024) })).toThrow();
  expect(() => decodeDistributionJson('['.repeat(18) + '0' + ']'.repeat(18))).toThrow();
});
it('refuses source traversal, floor payloads, aliases, missing declarations and file limits', () => {
  for (const path of ['.ia/src/floor/core.ia', '../escape.ia', 'C:/escape.ia', '.ia/src/systems/fixture-system/con.ia'])
    expect(() => decodeBundleManifest({ ...manifest, files: [{ ...manifest.files[0], path }] })).toThrow();
  expect(() => decodeBundleManifest({ ...manifest, files: [] })).toThrow('Missing system');
  expect(() =>
    decodeBundleManifest({ ...manifest, files: [{ ...manifest.files[0], bytes: 16 * 1024 * 1024 + 1 }] }),
  ).toThrow();
  expect(() =>
    decodeBundleManifest({
      ...manifest,
      files: [
        { ...manifest.files[0], path: 'README.md', role: 'documentation' },
        { ...manifest.files[0], path: 'readme.md', role: 'documentation' },
      ],
    }),
  ).toThrow();
});
it('admits only the release control source whose name matches the selected distribution', () => {
  const source = { ...manifest.files[0]!, path: '.ia/src/releases/foundation-distribution.ia' };
  const candidate = { ...manifest, files: [source, ...manifest.files] };
  expect(decodeBundleManifest({ ...candidate, engine: `^${DISTRIBUTION_ENGINE_VERSION}` }).files).toHaveLength(2);
  for (const engine of ['^0.1.0', '*', '>=0.1.1 || 0.0.9'])
    expect(() => decodeBundleManifest({ ...candidate, engine })).toThrow(
      /Root release control requires distribution engine/,
    );
  expect(decodeBundleManifest(manifest).engine).toBe('^0.1.0');
  for (const path of [
    '.ia/src/participant.ia',
    '.ia/src/releases/other.ia',
    '.ia/src/releases/nested/foundation-distribution.ia',
    '.ia/src/releases/foundation-distribution.json',
  ])
    expect(() =>
      decodeBundleManifest({
        ...candidate,
        engine: `^${DISTRIBUTION_ENGINE_VERSION}`,
        files: [{ ...source, path }, ...manifest.files],
      }),
    ).toThrow(/Source\/asset path/);
});
it('verifies exact reachable locks, direct ranges and immutable portable artifact locations', () => {
  expect(decodeDistributionLock(lock)).toEqual(lock);
  const https = { ...selected, location: `https://example.com/releases/${hash}.ia.tgz` };
  expect(decodeDistributionLock({ ...lock, packages: [https] }).packages[0]).toEqual(https);
  for (const patch of [
    { version: '0.2.0' },
    { location: 'C:/cache/archive.tgz' },
    { location: 'https://example.com/latest.ia.tgz' },
    { dependencies: ['test/missing'] },
    { dependencies: [common.id] },
  ])
    expect(() => decodeDistributionLock({ ...lock, packages: [{ ...selected, ...patch }] })).toThrow();
  expect(() => decodeDistributionLock({ ...lock, requests: [] })).toThrow('Unreachable');
});
it('binds generation identity to every byte and keeps activation counters separate', () => {
  const decoded = decodeGenerationInputs(inputs),
    locked = decodeDistributionLock(lock),
    original = generationDigest(locked, decoded, 'native bytes');
  expect(generationDigest(locked, decoded, 'native bytes')).toBe(original);
  expect(generationDigest(locked, decoded, 'changed')).not.toBe(original);
  const pointer = { formatVersion: 1, generation: original, previous: null, counter: 1 };
  expect(decodeActivationPointer(pointer)).toEqual(pointer);
  expect(decodeActivationPointer({ ...pointer, counter: 2 }).generation).toBe(original);
  expect(() => decodeActivationPointer({ ...pointer, counter: 0 })).toThrow();
  expect(() =>
    decodeGenerationInputs({ ...inputs, systems: [{ ...inputs.systems[0], selected: 'test/other' }] }),
  ).toThrow();
});
it('retains only the released exact lock marker as a legacy 0.1 compatibility line', () => {
  expect(supportsDistributionLockEngine(DISTRIBUTION_ENGINE_VERSION, '0.1.0')).toBe(true);
  expect(supportsDistributionLockEngine('0.2.0', '0.1.0')).toBe(false);
  for (const declared of ['0.1.2', '0.2.0', '=0.1.0'])
    expect(supportsDistributionLockEngine(DISTRIBUTION_ENGINE_VERSION, declared)).toBe(false);
  expect(supportsDistributionLockEngine(DISTRIBUTION_ENGINE_VERSION, '^0.1.0')).toBe(true);
});

it('shapes an installed-implementation catalog once for its reader and its binders (review finding B-N9)', () => {
  const available = {
    id: 'captured-source-read-v1',
    status: 'available',
    version: 1,
    operation: 'authoring-system/binding/operation/read-captured-source',
    handler: 'ia.captured-source.read.v1',
    input: 'captured-source-read-input-v1',
    output: 'captured-source-read-output-v1',
    module: 'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js',
    digest: 'c'.repeat(64),
    packages: ['@inventarch/agent-composition-system', '@inventarch/db'],
  };
  const catalog = (operations: unknown[]) => ({
    format: 'ia.installed-implementations.v1',
    evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
    operations,
  });
  const revoked = { id: 'withdrawn-v1', status: 'revoked', reason: 'withdrawn by its producer' },
    unavailable = { id: 'zeta-v1', status: 'unavailable', reason: 'not shipped' };
  const checked = checkInstalledImplementations(catalog([available, revoked, unavailable]));
  expect(checked.ok && checked.value.operations.map((row) => row.status)).toEqual([
    'available',
    'revoked',
    'unavailable',
  ]);
  for (const [bad, reason] of [
    [catalog([{ ...available, closure: 'f'.repeat(64) }]), 'Invalid available installed operation'],
    [
      catalog([{ ...available, module: 'runtime/node_modules/@inventarch/db/../x.js' }]),
      'Invalid available installed operation',
    ],
    [
      catalog([{ ...available, module: 'runtime/node_modules/@inventarch/db\\x.js' }]),
      'Invalid available installed operation',
    ],
    [catalog([{ ...available, module: 'runtime/node_modules/other/index.js' }]), 'lies outside its package closure'],
    [
      catalog([{ ...available, packages: ['@inventarch/db', '@inventarch/agent-composition-system'] }]),
      'Invalid available',
    ],
    [catalog([{ ...revoked, reason: '' }]), 'Invalid revoked installed operation'],
    [catalog([{ ...available, status: 'pending' }]), 'available, unavailable or revoked'],
    [catalog([unavailable, available]), 'sorted by id and unique'],
    [{ ...catalog([]), format: 'ia.installed-implementations.v2' }, 'Unknown installed-implementation catalog format'],
    [
      { ...catalog([]), evaluators: { format: 'ia-evaluator-catalog/2.0', entries: [] } },
      'not an ia-evaluator-catalog/1.x',
    ],
  ] as const)
    expect(checkInstalledImplementations(bad)).toEqual({ ok: false, reason: expect.stringContaining(reason) });
  // Review finding B2-N11: the checked value is a frozen plain-data copy, so a later change to the input, or an
  // accessor that answers differently when read again, cannot alter what was checked.
  const input = catalog([{ ...available }]),
    copy = checkInstalledImplementations(input);
  expect(copy.ok && Object.isFrozen(copy.value.operations[0])).toBe(true);
  (input.operations[0] as { id: string }).id = 'changed-v1';
  expect(copy.ok && copy.value.operations[0]!.id).toBe('captured-source-read-v1');
  const shifting = catalog([]);
  Object.defineProperty(shifting, 'operations', { enumerable: true, get: () => [] });
  expect(checkInstalledImplementations(shifting)).toEqual({
    ok: false,
    reason: 'The installed-implementation catalog is not plain, acyclic, bounded data',
  });
});
