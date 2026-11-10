import { afterEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names are written exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
afterEach(() => {
  flip.plain = false;
});
import {
  canonicalDistributionJson,
  decodeActivationPointer,
  decodeBundleManifest,
  decodeDistributionLock,
  decodeGenerationInputs,
  decodeReleaseDescriptor,
  deriveGenerationInputs,
  sha256,
} from '../src/distribution/index.js';

// Decision dec-008 (A14, A15). A release descriptor, bundle manifest, lock, generation inputs and activation pointer are
// shared documents: older programs read them, so this release reads the plain `format` name beside `formatVersion` and
// keeps writing the released shape (a `formatVersion` and no name) until the switch flips.
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64);
const common = {
  id: 'test/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/binding/distribution/foundation-distribution',
  engine: '^0.1.0',
  language: ['1.0'],
  source: { repository: 'https://example.com/foundation', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 0 },
  license: 'UNLICENSED',
  description: 'Original test fixture',
};
const files = [{ path: '.ia/src/systems/fixture-system/system.ia', bytes: 0, sha256: sha256(''), role: 'source' }];
const release = { ...common, dependencies: [], assets: [] };
const bundle = {
  ...common,
  roots: ['workspace-system/binding/workspace/foundation-workspace'],
  systems: [
    { name: 'fixture-system', provider: 'example.test', version: '0.1.0', path: '.ia/src/systems/fixture-system' },
  ],
  dependencies: [],
  files,
};
const selected = {
  id: common.id,
  version: common.version,
  archive: hash,
  manifest: other,
  location: `sha256:${hash}`,
  dependencies: [],
};
const lock = { engine: '^0.1.0', requests: [{ id: common.id, range: '^0.1.0' }], packages: [selected] };
const inputs = {
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
const pointer = { generation: hash, previous: null, counter: 1 };

const documents = [
  ['release-descriptor', release, decodeReleaseDescriptor],
  ['bundle-manifest', bundle, decodeBundleManifest],
  ['distribution-lock', lock, decodeDistributionLock],
  ['generation-inputs', inputs, decodeGenerationInputs],
  ['activation-pointer', pointer, decodeActivationPointer],
] as const;

it.each(documents)('%s: reads the released shape and the plain shape, each as written', (name, body, decode) => {
  const released = decode({ formatVersion: 1, ...body } as never) as Record<string, unknown>;
  expect(Object.keys(released)[0]).toBe('formatVersion');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  const plain = decode({ format: name, formatVersion: 1, ...body } as never) as Record<string, unknown>;
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain['format']).toBe(name);
  // Everything but the identity decodes to the same value.
  const { format: _format, ...rest } = plain;
  expect(rest).toEqual(released);
});
it.each(documents)('%s: refuses any other identity', (name, body, decode) => {
  for (const identity of [
    {},
    { format: name },
    { format: name, formatVersion: 2 },
    { format: name, formatVersion: '1' },
    { format: `${name}-1`, formatVersion: 1 },
    { format: `ia.${name}.v1`, formatVersion: 1 },
    { format: 'other-document', formatVersion: 1 },
    { format: 1, formatVersion: 1 },
    { format: 1 },
    { formatVersion: 2 },
    { formatVersion: '1' },
  ])
    expect(() => decode({ ...identity, ...body } as never), JSON.stringify(identity)).toThrow();
});

// The generation inputs a build derives are written by this package, so they follow the switch.
function derived() {
  const manifest = decodeBundleManifest({ formatVersion: 1, ...bundle }),
    metadata = { manifest, archiveDigest: hash, manifestDigest: other };
  const locked = decodeDistributionLock({ formatVersion: 1, ...lock });
  return deriveGenerationInputs(locked, new Map([[manifest.id, metadata]]));
}
it('derives generation inputs in the released shape by default, which is what released programs read', () => {
  expect(canonicalDistributionJson(derived())).toBe(canonicalDistributionJson({ formatVersion: 1, ...inputs }));
  expect(Object.keys(derived())).toEqual(['formatVersion', 'bundles', 'systems']);
});
it('derives generation inputs with the plain format name once the switch flips', () => {
  flip.plain = true;
  expect(Object.keys(derived())).toEqual(['format', 'formatVersion', 'bundles', 'systems']);
  expect(derived()).toMatchObject({ format: 'generation-inputs', formatVersion: 1 });
});
it('compares generation inputs by membership, whichever shape each was written in', async () => {
  const { sameGenerationInputs } = await import('../src/distribution/contracts.js');
  const released = decodeGenerationInputs({ formatVersion: 1, ...inputs }),
    plain = decodeGenerationInputs({ format: 'generation-inputs', formatVersion: 1, ...inputs }),
    different = decodeGenerationInputs({ formatVersion: 1, ...inputs, bundles: [{ id: common.id, archive: other }] });
  expect(sameGenerationInputs(released, plain)).toBe(true);
  expect(sameGenerationInputs(plain, released)).toBe(true);
  expect(sameGenerationInputs(released, different)).toBe(false);
});
