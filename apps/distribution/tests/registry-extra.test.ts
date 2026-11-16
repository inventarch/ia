/**
 * `RegistryResolveRequest.extra` and `admits` (registry-resolve.ts): the releases a caller carries itself (the CLI's
 * published language bases) beside the registries' releases, and the caller's own bound on what selection may pick.
 *
 * The exclusion rule: a carried release is offered only when no cached lock pin and no registry release of its id is
 * the same version or the same archive. Whichever of those the pin or registry holds wins, so registry bytes are never
 * replaced by carried ones; and a carried release that is selected comes from its own bytes, never from a registry's.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeDistributionLock } from '@inventarch/db/distribution';
import type { Dependency } from '@inventarch/db/distribution';
import { inspectArchiveMetadata } from '../src/archive.js';
import { cacheArchive } from '../src/install.js';
import { registryChooser } from '../src/registry-config.js';
import { resolveFromRegistries } from '../src/registry-resolve.js';
import type { Acquirer, CandidateRelease, RegistryResolveRequest } from '../src/registry-resolve.js';
import { resolveReleases } from '../src/resolve.js';
import { buildFixtureRegistry, fixtureArchive, serveDirectory } from './registry-fixture.js';
import type { FixtureRelease, FixtureReleaseSpec } from './registry-fixture.js';

const made: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const ENGINE = '0.1.0',
  HTTPS = 'https://registry.test/base/';
const workspaceRoot = (): string => {
  const p = mkdtempSync(join(tmpdir(), 'ia-registry-extra-'));
  made.push(p);
  return p;
};
const registry = async (specs: readonly FixtureReleaseSpec[]) => {
  const built = await buildFixtureRegistry(specs);
  made.push(built.dir);
  return built;
};
const resolveWith = (
  root: string,
  base: string,
  requests: readonly Dependency[],
  more: Partial<RegistryResolveRequest> = {},
) =>
  resolveFromRegistries({
    root,
    requests,
    engine: ENGINE,
    choose: registryChooser({ root, env: {}, flag: base, cwd: root }),
    ...more,
  });
/** A carried release: an unpublished pack of `id@version` (other bytes than any registry release of it), or `release`'s own bytes. */
function carried(spec: FixtureReleaseSpec | FixtureRelease): CandidateRelease & { readonly archive: string } {
  const packed = 'bytes' in spec ? spec : fixtureArchive({ ...spec, repository: null });
  const { pending } = inspectArchiveMetadata(packed.bytes, packed.archive);
  return { release: pending, bytes: packed.bytes, archive: packed.archive };
}
/** `id@version location` for each candidate, sorted. */
const chosen = (candidates: readonly { release: { manifest: { id: string; version: string } }; location: string }[]) =>
  candidates.map((c) => `${c.release.manifest.id}@${c.release.manifest.version} ${c.location}`).sort();
const archives = (
  candidates: readonly { release: { manifest: { id: string }; archiveDigest: string } }[],
  id: string,
) => candidates.filter((c) => c.release.manifest.id === id).map((c) => c.release.archiveDigest);
const cached = (root: string): string[] => readdirSync(join(root, '.ia/distributions/cache')).sort();

it('offers a carried release no registry lists, selected from its own bytes and from no registry', async () => {
  const { dir, releases } = await registry([{ id: 'acme/lib', version: '1.0.0' }]),
    root = workspaceRoot(),
    newer = carried({ id: 'acme/lib', version: '1.1.0' });
  const resolved = await resolveWith(root, dir, [{ id: 'acme/lib', range: '^1.0.0' }], { extra: [newer] });
  expect(chosen(resolved.candidates)).toEqual([`acme/lib@1.1.0 sha256:${newer.archive}`]);
  expect(resolved.sources.has('acme/lib')).toBe(false);
  // The cache holds the carried bytes exactly; the registry's 1.0.0 archive was never fetched.
  expect(cached(root)).toEqual([`${newer.archive}.ia.tgz`]);
  expect(readFileSync(join(root, `.ia/distributions/cache/${newer.archive}.ia.tgz`))).toEqual(newer.bytes);
  expect(releases[0]!.archive).not.toBe(newer.archive);
});

it('drops a carried release when the registry lists the same version with another archive: the registry bytes win', async () => {
  const { dir, releases } = await registry([{ id: 'acme/lib', version: '1.0.0' }]),
    published = releases[0]!,
    root = workspaceRoot(),
    other = carried({ id: 'acme/lib', version: '1.0.0' });
  expect(other.archive).not.toBe(published.archive);
  const resolved = await resolveWith(root, dir, [{ id: 'acme/lib', range: '^1.0.0' }], { extra: [other] });
  expect(archives(resolved.candidates, 'acme/lib')).toEqual([published.archive]);
  expect(resolved.sources.has('acme/lib')).toBe(true);
  // The carried archive was never offered, so it never reached the cache either.
  expect(cached(root)).toEqual([`${published.archive}.ia.tgz`]);
});

it('drops a carried release whose archive the registry lists, which then answers from the registry location', async () => {
  const { dir, releases } = await registry([{ id: 'acme/lib', version: '1.0.0' }]),
    published = releases[0]!,
    root = workspaceRoot(),
    requested = serveDirectory(dir, HTTPS);
  const resolved = await resolveWith(root, 'https://registry.test/base', [{ id: 'acme/lib', range: '^1.0.0' }], {
    extra: [carried(published)],
  });
  // The same bytes, but the registry's release: its artifact URL is the location, and it was fetched from there.
  expect(chosen(resolved.candidates)).toEqual([`acme/lib@1.0.0 ${HTTPS}artifacts/${published.archive}.ia.tgz`]);
  expect(requested).toContain(`${HTTPS}artifacts/${published.archive}.ia.tgz`);
  expect(resolved.sources.get('acme/lib')).toMatchObject({ base: { kind: 'https' } });
});

it('drops a carried release a cached lock pin already answers for: the pin is kept at its own location', async () => {
  const { dir } = await registry([{ id: 'acme/other', version: '1.0.0' }]),
    root = workspaceRoot();
  const pinned = fixtureArchive({ id: 'acme/base', version: '1.0.0', repository: null });
  cacheArchive(root, pinned.bytes, pinned.archive);
  const previous = decodeDistributionLock({
    formatVersion: 1,
    engine: ENGINE,
    requests: [{ id: 'acme/base', range: '^1.0.0' }],
    packages: [
      {
        id: 'acme/base',
        version: '1.0.0',
        archive: pinned.archive,
        manifest: pinned.manifest,
        location: `sha256:${pinned.archive}`,
        dependencies: [],
      },
    ],
  });
  // A carried 1.0.0 with other bytes: same version as the pin, so it is not offered.
  const sameVersion = carried({ id: 'acme/base', version: '1.0.0', engine: '>=0.1.0' });
  expect(sameVersion.archive).not.toBe(pinned.archive);
  const resolved = await resolveWith(root, dir, [{ id: 'acme/base', range: '^1.0.0' }], {
    previous,
    extra: [sameVersion],
  });
  expect(archives(resolved.candidates, 'acme/base')).toEqual([pinned.archive]);
  expect(resolveReleases([{ id: 'acme/base', range: '^1.0.0' }], resolved.candidates, ENGINE, previous).lock).toEqual(
    previous,
  );
  expect(cached(root)).toEqual([`${pinned.archive}.ia.tgz`]);
});

it('refuses a carried release whose bytes do not carry the manifest it declares', async () => {
  const { dir } = await registry([{ id: 'acme/other', version: '1.0.0' }]),
    root = workspaceRoot(),
    newer = carried({ id: 'acme/lib', version: '1.1.0' }),
    impostor = carried({ id: 'acme/lib', version: '1.1.0', engine: '>=0.1.0' });
  // The metadata of one pack over the bytes of another.
  const forged: CandidateRelease = {
    release: { ...newer.release, archiveDigest: impostor.archive },
    bytes: impostor.bytes,
  };
  await expect(
    resolveWith(root, dir, [{ id: 'acme/lib', range: '^1.0.0' }], { extra: [forged] }),
  ).rejects.toMatchObject({ code: 'IA-DIST-INTEGRITY-MISMATCH' });
});

it('on the legacy licensed path, a selected carried release is cached from its own bytes beside the acquired one', async () => {
  // acme/app is licensed and needs acme/lib ^1.0.0, which only the carried release satisfies.
  const { dir, releases } = await registry([
      { id: 'acme/lib', version: '0.9.0' },
      { id: 'acme/app', version: '1.0.0', licensed: true, dependencies: [{ id: 'acme/lib', range: '^1.0.0' }] },
    ]),
    app = releases.find((r) => r.id === 'acme/app')!,
    root = workspaceRoot(),
    lib = carried({ id: 'acme/lib', version: '1.0.0' });
  const acquirer: Acquirer = {
    async acquire(release) {
      cacheArchive(root, app.bytes, release.archive);
      return { location: `sha256:${release.archive}` };
    },
  };
  const requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const resolved = await resolveWith(root, dir, requests, { acquirer, extra: [lib] });
  expect(chosen(resolved.candidates)).toEqual([
    `acme/app@1.0.0 sha256:${app.archive}`,
    `acme/lib@1.0.0 sha256:${lib.archive}`,
  ]);
  expect(resolved.sources.has('acme/lib')).toBe(false);
  expect(readFileSync(join(root, `.ia/distributions/cache/${lib.archive}.ia.tgz`))).toEqual(lib.bytes);
  // Without the carried release nothing satisfies acme/lib ^1.0.0.
  await expect(resolveWith(workspaceRoot(), dir, requests, { acquirer })).rejects.toMatchObject({
    code: 'IA-DIST-CONFLICT',
  });
});

it('admits bounds what selection may pick, from the registry and carried releases alike', async () => {
  const { dir, releases } = await registry([
      { id: 'acme/lib', version: '1.0.0' },
      { id: 'acme/lib', version: '1.1.0' },
    ]),
    lower = releases.find((r) => r.version === '1.0.0')!;
  const asked: string[] = [];
  const atLeast11 = ({ id, version }: { id: string; version: string; archive: string }): boolean => {
    asked.push(`${id}@${version}`);
    return id !== 'acme/lib' || version !== '1.0.0';
  };
  // A range only the refused release satisfies finds nothing.
  await expect(
    resolveWith(workspaceRoot(), dir, [{ id: 'acme/lib', range: '~1.0.0' }], { admits: atLeast11 }),
  ).rejects.toMatchObject({ code: 'IA-DIST-CONFLICT' });
  expect(asked).toContain('acme/lib@1.0.0');
  // A carried release it refuses is not offered either, and one it admits is.
  const carriedLower = carried({ id: 'acme/lib', version: '1.0.0', engine: '>=0.1.0' }),
    carriedHigher = carried({ id: 'acme/lib', version: '1.2.0' });
  const root = workspaceRoot();
  const resolved = await resolveWith(root, dir, [{ id: 'acme/lib', range: '^1.0.0' }], {
    admits: atLeast11,
    extra: [carriedLower, carriedHigher],
  });
  expect(chosen(resolved.candidates)).toEqual([`acme/lib@1.2.0 sha256:${carriedHigher.archive}`]);
  // Without the bound, the lower release is what a ~1.0.0 range selects.
  const open = await resolveWith(workspaceRoot(), dir, [{ id: 'acme/lib', range: '~1.0.0' }]);
  expect(archives(open.candidates, 'acme/lib')).toEqual([lower.archive]);
});
