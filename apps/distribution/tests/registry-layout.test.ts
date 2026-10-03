import { expect, it } from 'vitest';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { decodePackageIndex, decodeRegistryInfo, packageIndexPath, REGISTRY_LIMITS } from '../src/registry-layout.js';

const hex = (c: string) => c.repeat(64);
const release = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  archive: hex('a'),
  manifest: hex('b'),
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  withdrawn: false,
  access: 'public',
  artifact: `artifacts/${hex('a')}.ia.tgz`,
  ...extra,
});
const code = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    return error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : String(error);
  }
  return 'no refusal';
};
it('derives index paths from ids and refuses unsafe ids', () => {
  expect(packageIndexPath('inventarch/language')).toBe('packages/inventarch/language.json');
  expect(() => packageIndexPath('../x')).toThrow(/provider\/name/);
});
it('decodes registry info strictly', () => {
  const info = decodeRegistryInfo(JSON.stringify({ format: 'ia.registry.v1', name: 'Fixture' }));
  expect(info).toEqual({ format: 'ia.registry.v1', name: 'Fixture' });
  expect(Object.isFrozen(info)).toBe(true);
  expect(() => decodeRegistryInfo(JSON.stringify({ format: 'ia.registry.v1', name: 'x', extra: 1 }))).toThrow(
    /Unexpected/,
  );
  expect(() => decodeRegistryInfo(JSON.stringify({ format: 'other', name: 'x' }))).toThrow(/registry/);
});
it('decodes a package index and enforces id, artifact, access and uniqueness rules', () => {
  const ok = {
    format: 'ia.registry-package.v1',
    id: 'acme/tools',
    releases: [
      release('1.0.0'),
      release('1.1.0', { archive: hex('c'), manifest: hex('d'), artifact: `artifacts/${hex('c')}.ia.tgz` }),
    ],
  };
  const decoded = decodePackageIndex(JSON.stringify(ok), 'acme/tools');
  expect(decoded.releases).toHaveLength(2);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.releases[0])).toBe(true);
  expect(() => decodePackageIndex(JSON.stringify(ok), 'acme/other')).toThrow(/names a different package/);
  expect(() =>
    decodePackageIndex(
      JSON.stringify({ ...ok, releases: [release('1.0.0', { artifact: 'https://evil.test/x.ia.tgz' })] }),
      'acme/tools',
    ),
  ).toThrow(/artifact/);
  expect(() =>
    decodePackageIndex(JSON.stringify({ ...ok, releases: [release('1.0.0', { access: 'licensed' })] }), 'acme/tools'),
  ).toThrow(/artifact/);
  expect(
    decodePackageIndex(
      JSON.stringify({
        ...ok,
        releases: [{ ...release('1.0.0', { access: 'licensed' }), artifact: undefined }].map(({ artifact, ...r }) => r),
      }),
      'acme/tools',
    ).releases[0]!.access,
  ).toBe('licensed');
  expect(() =>
    decodePackageIndex(JSON.stringify({ ...ok, releases: [release('1.0.0'), release('1.0.0')] }), 'acme/tools'),
  ).toThrow(/once/);
  expect(decodePackageIndex(JSON.stringify({ ...ok, signatures: [] }), 'acme/tools').id).toBe('acme/tools');
  expect(REGISTRY_LIMITS).toEqual({ indexBytes: 4 * 1024 * 1024, releases: 1000, reads: 256 });
});
it('decodes metadata with the same codecs the manifest uses, not a bespoke bounded-text check', () => {
  const ok = { format: 'ia.registry-package.v1', id: 'acme/tools', releases: [release('1.0.0')] };
  // engine and dependency ranges are SemVer ranges, validated by the db `range()` codec.
  expect(() =>
    decodePackageIndex(
      JSON.stringify({ ...ok, releases: [release('1.0.0', { engine: 'not-a-range' })] }),
      'acme/tools',
    ),
  ).toThrow(/SemVer range/);
  expect(() =>
    decodePackageIndex(
      JSON.stringify({
        ...ok,
        releases: [release('1.0.0', { dependencies: [{ id: 'acme/other', range: 'not-a-range' }] })],
      }),
      'acme/tools',
    ),
  ).toThrow(/SemVer range/);
  // version is validated by the db `version()` codec: a non-canonical form refuses instead of silently coexisting with its canonical twin.
  expect(() => decodePackageIndex(JSON.stringify({ ...ok, releases: [release('v1.0.0')] }), 'acme/tools')).toThrow(
    /SemVer/,
  );
  // language must equal exactly ['1.0'], as contracts.ts requires for the manifest it copies.
  expect(() =>
    decodePackageIndex(JSON.stringify({ ...ok, releases: [release('1.0.0', { language: ['1.1'] })] }), 'acme/tools'),
  ).toThrow(/language/);
  expect(() =>
    decodePackageIndex(
      JSON.stringify({ ...ok, releases: [release('1.0.0', { language: ['1.0', '1.0'] })] }),
      'acme/tools',
    ),
  ).toThrow(/language/);
  // dependency count is capped at the manifest's own DISTRIBUTION_LIMITS.bundles, not an arbitrary 64; exactly the cap is still accepted.
  const atCap = Array.from({ length: DISTRIBUTION_LIMITS.bundles }, (_, i) => ({
    id: `acme/dep${i}`,
    range: '^1.0.0',
  }));
  expect(
    decodePackageIndex(JSON.stringify({ ...ok, releases: [release('1.0.0', { dependencies: atCap })] }), 'acme/tools')
      .releases[0]!.dependencies,
  ).toHaveLength(DISTRIBUTION_LIMITS.bundles);
  const tooMany = [...atCap, { id: 'acme/depN', range: '^1.0.0' }];
  expect(() =>
    decodePackageIndex(
      JSON.stringify({ ...ok, releases: [release('1.0.0', { dependencies: tooMany })] }),
      'acme/tools',
    ),
  ).toThrow(/Invalid registry dependency list/);
});
it('refuses a release that depends on itself or lists the same dependency twice, matching contracts.ts', () => {
  const ok = { format: 'ia.registry-package.v1', id: 'acme/tools', releases: [release('1.0.0')] };
  expect(() =>
    decodePackageIndex(
      JSON.stringify({
        ...ok,
        releases: [release('1.0.0', { dependencies: [{ id: 'acme/tools', range: '^1.0.0' }] })],
      }),
      'acme/tools',
    ),
  ).toThrow(/depends on itself/);
  expect(() =>
    decodePackageIndex(
      JSON.stringify({
        ...ok,
        releases: [
          release('1.0.0', {
            dependencies: [
              { id: 'acme/other', range: '^1.0.0' },
              { id: 'acme/other', range: '^2.0.0' },
            ],
          }),
        ],
      }),
      'acme/tools',
    ),
  ).toThrow(/more than once/);
});
it('names the refused field and strips the db error code from release metadata refusals', () => {
  const ok = { format: 'ia.registry-package.v1', id: 'acme/tools', releases: [release('1.0.0')] };
  try {
    decodePackageIndex(
      JSON.stringify({ ...ok, releases: [release('1.0.0', { engine: 'not-a-range' })] }),
      'acme/tools',
    );
    expect.unreachable('expected a refusal');
  } catch (error) {
    const message = (error as Error).message;
    expect(message).not.toMatch(/IA-DB-/);
    expect(message).toMatch(/engine/);
    expect(message).toMatch(/1\.0\.0/);
  }
});
it('reports a non-array releases list, a non-object release and an invalid access value with their own messages', () => {
  const ok = { format: 'ia.registry-package.v1', id: 'acme/tools', releases: [release('1.0.0')] };
  expect(() => decodePackageIndex(JSON.stringify({ ...ok, releases: 'nope' }), 'acme/tools')).toThrow(
    /Registry releases must be an array/,
  );
  expect(code(() => decodePackageIndex(JSON.stringify({ ...ok, releases: 'nope' }), 'acme/tools'))).toBe(
    'IA-DIST-INPUT-INVALID',
  );
  expect(() => decodePackageIndex(JSON.stringify({ ...ok, releases: [null] }), 'acme/tools')).toThrow(/object/);
  expect(() =>
    decodePackageIndex(JSON.stringify({ ...ok, releases: [release('1.0.0', { access: 'secret' })] }), 'acme/tools'),
  ).toThrow(/access/);
});
it('validates expectedId itself with packageId and wraps every db-layer refusal as IA-DIST-INPUT-INVALID', () => {
  const ok = { format: 'ia.registry-package.v1', id: 'acme/tools', releases: [release('1.0.0')] };
  expect(() => decodePackageIndex(JSON.stringify(ok), '../evil')).toThrow(/provider\/name/);
  expect(code(() => decodePackageIndex(JSON.stringify(ok), '../evil'))).toBe('IA-DIST-INPUT-INVALID');
  expect(
    code(() =>
      decodePackageIndex(
        JSON.stringify({ ...ok, releases: [release('1.0.0', { engine: 'not-a-range' })] }),
        'acme/tools',
      ),
    ),
  ).toBe('IA-DIST-INPUT-INVALID');
  expect(code(() => decodeRegistryInfo('not json'))).toBe('IA-DIST-INPUT-INVALID');
  // decodeDistributionJson refuses a duplicate JSON key itself; that db-layer refusal must still surface as IA-DIST-*.
  expect(code(() => decodeRegistryInfo('{"format":"ia.registry.v1","name":"a","name":"b"}'))).toBe(
    'IA-DIST-INPUT-INVALID',
  );
});
