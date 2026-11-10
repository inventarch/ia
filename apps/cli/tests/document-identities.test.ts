import { afterEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names are written exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import { buildArtifact } from '../src/compile.js';
import { descriptorText, starterDescriptor } from '../src/init.js';
import { lockWithPackage, viewPackage } from '../src/kits-package.js';
import type { Npm } from '../src/kits-package.js';

// Decision dec-008 (A14, A15). The `ia` block of a kit package's package.json, the release descriptor `ia init` writes
// and the distribution lock are read by programs released separately, so this release reads the plain `format` name with
// `formatVersion` and keeps writing the released shapes until the switch flips.
afterEach(() => {
  flip.plain = false;
});

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const kit = { id: 'inventarch/one', version: '1.0.0', archive: 'a'.repeat(64), manifest: 'b'.repeat(64) };
const npmWith =
  (ia: unknown): Npm =>
  () => ({
    status: 0,
    stdout: JSON.stringify({ name: '@x/kits', version: '1.0.0', dist: { integrity: INTEGRITY }, ia }),
    output: '',
  });
const view = (ia: unknown) => viewPackage(npmWith(ia), '@x/kits', '1.0.0', 'try again');

it('kit-package: reads the released integer format and the plain shape of the ia block, and refuses any other', () => {
  for (const identity of [{ format: 1 }, { format: 'kit-package', formatVersion: 1 }])
    expect(view({ ...identity, kits: [kit] }).kits).toEqual([kit]);
  for (const identity of [
    { format: 2 },
    { format: '1' },
    { format: 1, formatVersion: 1 },
    { format: 'kit-package' },
    { format: 'kit-package', formatVersion: 2 },
    { format: 'ia.kit-package.v1', formatVersion: 1 },
    { format: 'other-document', formatVersion: 1 },
    { formatVersion: 1 },
    {},
  ])
    expect(() => view({ ...identity, kits: [kit] }), JSON.stringify(identity)).toThrow(/ia\.kits list/);
});

const entry = {
  kind: 'package' as const,
  name: '@x/kits',
  version: '1.0.0',
  integrity: INTEGRITY,
  kits: [{ ...kit, dependencies: [] }],
};
it('distribution lock: a package lock is written in the released shape by default and the plain shape once flipped', () => {
  const released = lockWithPackage(undefined, entry) as unknown as Record<string, unknown>;
  expect(Object.keys(released)[0]).toBe('formatVersion');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  flip.plain = true;
  const plain = lockWithPackage(undefined, entry) as unknown as Record<string, unknown>;
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain).toMatchObject({ format: 'distribution-lock', formatVersion: 1 });
  // A lock read in either shape keeps its own shape when a package is added to it.
  flip.plain = false;
  expect(lockWithPackage(plain as never, entry)).toMatchObject({ format: 'distribution-lock' });
  expect(Object.hasOwn(lockWithPackage(released as never, entry), 'format')).toBe(false);
});

const base = { pin: { id: 'inventarch/language', version: '1.0.0' }, systems: ['workspace-system'] } as never;
const provenance = {
  source: { repository: null, commit: null, recipe: 'ustar-v1' as const, epoch: 0 },
  missing: null,
};
it('release-descriptor: init writes the released shape by default and the plain shape once flipped', () => {
  const released = JSON.parse(descriptorText(starterDescriptor('x/y', 'y', base, provenance))) as Record<
    string,
    unknown
  >;
  expect(Object.keys(released)[0]).toBe('formatVersion');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  flip.plain = true;
  const plain = JSON.parse(descriptorText(starterDescriptor('x/y', 'y', base, provenance))) as Record<string, unknown>;
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain).toMatchObject({ format: 'release-descriptor', formatVersion: 1 });
});

it('compiled: the deprecated artifact writer names itself beside formatVersion only once the switch flips', () => {
  const session = {
    admission: () => ({ findings: [], revision: 'r' }),
    reader: { records: () => [] },
  } as never;
  const released = buildArtifact('/root', session).artifact as unknown as Record<string, unknown>;
  expect(Object.keys(released)[0]).toBe('formatVersion');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  flip.plain = true;
  const plain = buildArtifact('/root', session).artifact as unknown as Record<string, unknown>;
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain).toMatchObject({ format: 'compiled', formatVersion: 1 });
});
