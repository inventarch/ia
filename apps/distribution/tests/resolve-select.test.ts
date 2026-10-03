import { expect, it } from 'vitest';
import { decodeBundleManifest, sha256 } from '@inventarch/db/distribution';
import { buildArchive, verifyArchive } from '../src/archive.js';
import { DistributionError } from '../src/files.js';
import { resolveReleases, selectReleases } from '../src/resolve.js';
import type { MetadataCandidate, ReleaseCandidate } from '../src/resolve.js';

const source = {
  repository: 'https://example.com/fixture',
  commit: 'a'.repeat(40),
  recipe: 'ustar-v1',
  epoch: 1_700_000_000,
};
function release(
  id: string,
  version = '1.0.0',
  dependencies: { id: string; range: string }[] = [],
  systemName = id.split('/')[1]!,
  content = 'original',
): ReleaseCandidate {
  const path = `.ia/src/systems/${systemName}/system.ia`,
    files = new Map([[path, Buffer.from(content)]]);
  const manifest = decodeBundleManifest({
    formatVersion: 1,
    id,
    version,
    distribution: 'workspace-system/definition/distribution/fixture-release',
    roots: ['workspace-system/definition/workspace/fixture-workspace'],
    engine: '^0.1.0',
    language: ['1.0'],
    source,
    license: 'UNLICENSED',
    description: 'Original fixture',
    systems: [{ name: systemName, provider: 'example.test', version: '1.0.0', path: `.ia/src/systems/${systemName}` }],
    dependencies,
    files: [{ path, role: 'source', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
  });
  const archive = verifyArchive(buildArchive(manifest, files));
  return { release: archive, location: `sha256:${archive.archiveDigest}`, withdrawn: false };
}
const cand = (
  id: string,
  version: string,
  deps: { id: string; range: string }[] = [],
  extra: Partial<MetadataCandidate> = {},
): MetadataCandidate => ({
  id,
  version,
  engine: '^0.1.0',
  dependencies: deps,
  archive: sha256(`${id}@${version}`),
  withdrawn: false,
  ...extra,
});
const refusal = (run: () => unknown): DistributionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DistributionError) return error;
    throw error;
  }
  throw Error('Expected a refusal');
};

it('keeps the exact CONFLICT message, highest-first reason order and its 30-reason cap', () => {
  const catalog = Array.from({ length: 40 }, (_, n) =>
    release('test/r', `1.0.${n}`, [{ id: 'test/missing', range: '*' }]),
  );
  const error = refusal(() => resolveReleases([{ id: 'test/r', range: '*' }], catalog, '0.1.0'));
  expect(error.code).toBe('IA-DIST-CONFLICT');
  expect(error.message).toBe(
    `No compatible complete release set: ${Array.from({ length: 30 }, (_, n) => `test/missing: * from test/r@1.0.${39 - n}`).join(' | ')}`,
  );
});
it('backtracks past a leaf whose generation inputs refuse, keeping the refusal as a reason', () => {
  const a = release('test/a', '1.0.0', [], 'shared'),
    b1 = release('test/b', '1.0.0', [], 'shared'),
    b2 = release('test/b', '2.0.0', [], 'shared', 'different');
  const requests = [
      { id: 'test/a', range: '*' },
      { id: 'test/b', range: '*' },
    ],
    resolved = resolveReleases(requests, [a, b1, b2], '0.1.0');
  expect(resolved.lock.packages.map((p) => `${p.id}@${p.version}`)).toEqual(['test/a@1.0.0', 'test/b@1.0.0']);
  expect(resolved.assignments).toBe(3);
  expect([...resolved.releases.keys()]).toEqual(['test/a', 'test/b']);
  // Archive digests depend on the zlib build that packed the fixtures (Homebrew's Node links the system zlib), so each archive
  // pin is checked against the release it names, and the pinned hash covers everything else.
  const byArchive = new Map([a, b1, b2].map((candidate) => [candidate.release.archiveDigest, candidate.release]));
  for (const pkg of resolved.lock.packages)
    expect([byArchive.get(pkg.archive)?.manifestDigest, pkg.location]).toEqual([pkg.manifest, `sha256:${pkg.archive}`]);
  expect(resolved.inputs.bundles).toEqual(resolved.lock.packages.map((pkg) => ({ id: pkg.id, archive: pkg.archive })));
  const lock = {
    ...resolved.lock,
    packages: resolved.lock.packages.map(({ archive: _archive, location: _location, ...pkg }) => pkg),
  };
  const inputs = {
    ...resolved.inputs,
    bundles: resolved.inputs.bundles.map(({ archive: _archive, ...bundle }) => bundle),
  };
  expect(sha256(JSON.stringify({ lock, inputs }))).toBe(
    'b29e10b58f90eb1691501af294e35aa7160c1d31838f0faa428cf49645f9befe',
  );
  const missing = release('test/b', '1.0.0', [{ id: 'test/missing', range: '^1.0.0' }], 'shared');
  const error = refusal(() => resolveReleases(requests, [a, missing, b2], '0.1.0'));
  expect(() =>
    resolveReleases(
      [{ id: 'test/b', range: '*' }],
      [{ ...b2, location: 'https://example.com/wrong.ia.tgz' }, b1],
      '0.1.0',
    ),
  ).toThrow('HTTPS artifact location must end in its pinned digest');
  expect(error.code).toBe('IA-DIST-CONFLICT');
  expect(error.message).toBe(
    'No compatible complete release set: InstallationError: IA-DB-SOURCE-UNAVAILABLE: Distribution conflict: Different provider/version/source bytes for shared | test/missing: ^1.0.0 from test/b@1.0.0',
  );
});
it('selects the highest compatible release set on metadata alone', () => {
  const chosen = selectReleases(
    [{ id: 'acme/app', range: '^1.0.0' }],
    [
      cand('acme/app', '1.0.0', [{ id: 'acme/lib', range: '^2.0.0' }]),
      cand('acme/app', '1.2.0', [{ id: 'acme/lib', range: '^2.1.0' }]),
      cand('acme/lib', '2.0.0'),
      cand('acme/lib', '2.1.3'),
    ],
    '0.1.0',
  );
  expect([...chosen].map(([id, c]) => `${id}@${c.version}`).sort()).toEqual(['acme/app@1.2.0', 'acme/lib@2.1.3']);
});
it('skips withdrawn and engine-incompatible releases and prefers the existing pin', () => {
  const list = [
    cand('acme/lib', '2.0.0'),
    cand('acme/lib', '2.2.0', [], { withdrawn: true }),
    cand('acme/lib', '2.1.0', [], { engine: '^9.0.0' }),
  ];
  expect(selectReleases([{ id: 'acme/lib', range: '*' }], list, '0.1.0').get('acme/lib')!.version).toBe('2.0.0');
  expect(
    selectReleases(
      [{ id: 'acme/lib', range: '*' }],
      [...list, cand('acme/lib', '2.0.5')],
      '0.1.0',
      new Map([['acme/lib', list[0]!.archive]]),
    ).get('acme/lib')!.version,
  ).toBe('2.0.0');
});
it('refuses an unsatisfiable set with CONFLICT', () => {
  const error = refusal(() =>
    selectReleases([{ id: 'acme/lib', range: '^3.0.0' }], [cand('acme/lib', '2.0.0')], '0.1.0'),
  );
  expect(error.code).toBe('IA-DIST-CONFLICT');
  expect(error.message).toMatch(/No compatible complete release set/);
});
