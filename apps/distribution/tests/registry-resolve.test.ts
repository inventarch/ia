import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeDistributionLock } from '@inventarch/db/distribution';
import type { Dependency, DistributionLock } from '@inventarch/db/distribution';
import { applyInstallation, cacheArchive, planInstallation } from '../src/install.js';
import { registryChooser } from '../src/registry-config.js';
import { registryWithdrawals, resolveFromRegistries } from '../src/registry-resolve.js';
import type { Acquirer, RegistryResolveRequest } from '../src/registry-resolve.js';
import { resolveReleases } from '../src/resolve.js';
import { buildFixtureRegistry, fixtureArchive, serveDirectory } from './registry-fixture.js';
import type { FixtureReleaseSpec } from './registry-fixture.js';

const made: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const ENGINE = '0.1.0',
  HTTPS = 'https://registry.test/base/';
/** A fresh empty workspace root; the cache is created on first use. */
const workspaceRoot = (): string => {
  const p = mkdtempSync(join(tmpdir(), 'ia-registry-ws-'));
  made.push(p);
  return p;
};
const registry = async (specs: readonly FixtureReleaseSpec[]) => {
  const built = await buildFixtureRegistry(specs);
  made.push(built.dir);
  return built;
};
/** `--registry <base>` for every id, through the real read-once chooser. */
const chooser = (root: string, flag: string) => registryChooser({ root, env: {}, flag, cwd: root });
const resolveWith = (
  root: string,
  base: string,
  requests: readonly Dependency[],
  extra: Partial<RegistryResolveRequest> = {},
) => resolveFromRegistries({ root, requests, engine: ENGINE, choose: chooser(root, base), ...extra });
const pins = (lock: DistributionLock) => lock.packages.map((p) => `${p.id}@${p.version} ${p.location}`);
const indexPath = (dir: string, id: string) => join(dir, 'packages', `${id}.json`);
type Entry = Record<string, unknown> & { version: string };
/** Rewrites one package index in place. */
function editIndex(dir: string, id: string, edit: (releases: Entry[]) => Entry[]): void {
  const index = JSON.parse(readFileSync(indexPath(dir, id), 'utf8')) as { releases: Entry[] };
  writeFileSync(indexPath(dir, id), JSON.stringify({ ...index, releases: edit(index.releases) }));
}
const refusal = (code: string, message: string | RegExp) => ({
  code: `IA-DIST-${code}`,
  message: typeof message === 'string' ? message : expect.stringMatching(message),
});
const appOnLib: FixtureReleaseSpec[] = [
  { id: 'acme/lib', version: '1.0.0' },
  { id: 'acme/lib', version: '1.1.0' },
  { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^1.0.0' }] },
  { id: 'acme/unused', version: '1.0.0' },
];
const find = <R extends { id: string; version: string }>(releases: readonly R[], key: string): R =>
  releases.find((r) => `${r.id}@${r.version}` === key)!;

it('(a) resolves a directory registry on metadata, fetching and verifying only the selected archives', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const app = find(releases, 'acme/app@1.0.0'),
    lib = find(releases, 'acme/lib@1.1.0');
  // An archive selection never picks is never read, so its corruption goes unnoticed.
  writeFileSync(join(dir, 'artifacts', `${find(releases, 'acme/lib@1.0.0').archive}.ia.tgz`), 'corrupt');
  const resolved = await resolveWith(root, dir, requests);
  expect(
    resolved.candidates
      .map((c) => `${c.release.manifest.id}@${c.release.manifest.version} ${c.location} ${c.withdrawn}`)
      .sort(),
  ).toEqual([`acme/app@1.0.0 sha256:${app.archive} false`, `acme/lib@1.1.0 sha256:${lib.archive} false`]);
  expect(readdirSync(join(root, '.ia/distributions/cache')).sort()).toEqual(
    [`${app.archive}.ia.tgz`, `${lib.archive}.ia.tgz`].sort(),
  );
  expect([...resolved.sources.keys()].sort()).toEqual(['acme/app', 'acme/lib']);
  expect(resolved.sources.get('acme/lib')).toMatchObject({
    provider: 'acme',
    level: 'flag',
    source: '--registry',
    base: { kind: 'dir' },
  });
  // The unchanged archive resolver over exactly these candidates reproduces the selection.
  const { lock } = resolveReleases(requests, resolved.candidates, ENGINE);
  expect(pins(lock)).toEqual([`acme/app@1.0.0 sha256:${app.archive}`, `acme/lib@1.1.0 sha256:${lib.archive}`]);
});

it('(b) resolves over HTTPS, opening the registry once and locking artifact URLs', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const requested = serveDirectory(dir, HTTPS),
    app = find(releases, 'acme/app@1.0.0'),
    lib = find(releases, 'acme/lib@1.1.0');
  const resolved = await resolveWith(root, 'https://registry.test/base', requests);
  const { lock } = resolveReleases(requests, resolved.candidates, ENGINE);
  expect(pins(lock)).toEqual([
    `acme/app@1.0.0 ${HTTPS}artifacts/${app.archive}.ia.tgz`,
    `acme/lib@1.1.0 ${HTTPS}artifacts/${lib.archive}.ia.tgz`,
  ]);
  expect(requested.filter((u) => u.endsWith('/ia-registry.json'))).toHaveLength(1);
  expect(requested.filter((u) => u.includes('/artifacts/')).sort()).toEqual(
    [`${HTTPS}artifacts/${app.archive}.ia.tgz`, `${HTTPS}artifacts/${lib.archive}.ia.tgz`].sort(),
  );
  expect(resolved.sources.get('acme/app')).toMatchObject({ base: { kind: 'https', url: HTTPS } });
});

it('(c) refuses an index whose metadata differs from the archive it names', async () => {
  const { dir } = await registry(appOnLib),
    requests = [{ id: 'acme/app', range: '^1.0.0' }],
    mismatch = refusal('INTEGRITY-MISMATCH', 'Registry metadata differs from the archive it names: acme/app@1.0.0');
  const original = readFileSync(indexPath(dir, 'acme/app'), 'utf8'),
    variant = (edit: (r: Entry) => Entry) => {
      writeFileSync(indexPath(dir, 'acme/app'), original);
      editIndex(dir, 'acme/app', (list) => list.map(edit));
    };
  variant((r) => ({ ...r, dependencies: [] }));
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(mismatch);
  variant((r) => ({ ...r, manifest: 'f'.repeat(64) }));
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(mismatch);
  variant((r) => ({ ...r, engine: '>=0.1.0' }));
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(mismatch);
  variant((r) => ({ ...r, dependencies: [{ id: 'acme/lib', range: '^1.1.0' }] }));
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(mismatch);
  variant((r) => r);
  await expect(resolveWith(workspaceRoot(), dir, requests)).resolves.toBeDefined();
});

it('(d) refuses a request only a licensed release satisfies, and resolves it through an injected acquirer', async () => {
  const { dir, releases } = await registry([
    { id: 'acme/lib', version: '1.0.0' },
    { id: 'acme/lib', version: '2.0.0', licensed: true },
  ]);
  const licensed = find(releases, 'acme/lib@2.0.0'),
    requests = [{ id: 'acme/lib', range: '^2.0.0' }];
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/lib@2.0.0 is available only as a licensed release; this CLI has no licensed acquisition path',
    ),
  );
  // A public release that satisfies the range wins without an acquirer.
  const open = await resolveWith(workspaceRoot(), dir, [{ id: 'acme/lib', range: '*' }]);
  expect(open.candidates.map((c) => c.release.manifest.version)).toEqual(['1.0.0']);
  const root = workspaceRoot(),
    asked: unknown[] = [];
  const acquirer: Acquirer = {
    async acquire(release) {
      asked.push(release);
      cacheArchive(root, releases.find((r) => r.archive === release.archive)!.bytes, release.archive);
      return { location: `sha256:${release.archive}` };
    },
  };
  const resolved = await resolveWith(root, dir, requests, { acquirer });
  expect(asked).toEqual([{ id: 'acme/lib', version: '2.0.0', archive: licensed.archive, manifest: licensed.manifest }]);
  expect(pins(resolveReleases(requests, resolved.candidates, ENGINE).lock)).toEqual([
    `acme/lib@2.0.0 sha256:${licensed.archive}`,
  ]);
  // An acquirer must deliver the exact archive it was asked for.
  const wrong: Acquirer = {
    async acquire() {
      return { location: `sha256:${'e'.repeat(64)}` };
    },
  };
  await expect(resolveWith(workspaceRoot(), dir, requests, { acquirer: wrong })).rejects.toMatchObject({
    code: 'IA-DIST-INTEGRITY-MISMATCH',
  });
  const lazy: Acquirer = {
    async acquire(release) {
      return { location: `sha256:${release.archive}` };
    },
  };
  await expect(resolveWith(workspaceRoot(), dir, requests, { acquirer: lazy })).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', /acme\/lib@2\.0\.0/),
  );
});

it('refuses with LICENSE-REQUIRED when a licensed-only release sits deep in the dependency graph', async () => {
  const { dir } = await registry([
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/mid', range: '^1.0.0' }] },
    { id: 'acme/mid', version: '1.0.0', dependencies: [{ id: 'acme/core', range: '^1.0.0' }] },
    // The licensed release's own dependency is read too, so the licensed rerun can complete and name it.
    { id: 'acme/core', version: '1.0.0', licensed: true, dependencies: [{ id: 'acme/base', range: '^1.0.0' }] },
    { id: 'acme/base', version: '1.0.0' },
  ]);
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/app', range: '*' }])).rejects.toMatchObject(
    refusal('LICENSE-REQUIRED', /^acme\/core@1\.0\.0 is available only as a licensed release/),
  );
});

it('(e) refuses when the registry changed the bytes of a locked release, but not when a locked version is simply absent', async () => {
  const { dir, releases } = await registry([
      { id: 'acme/lib', version: '2.0.0' },
      { id: 'acme/lib', version: '2.1.0' },
    ]),
    requests = [{ id: 'acme/lib', range: '^2.0.0' }];
  const root = workspaceRoot(),
    first = resolveReleases(
      requests,
      (await resolveWith(root, dir, [{ id: 'acme/lib', range: '2.0.0' }])).candidates,
      ENGINE,
    ).lock;
  const swap = (lock: DistributionLock, version: string, archive: string) =>
    decodeDistributionLock({
      ...lock,
      requests: [{ id: 'acme/lib', range: '*' }],
      packages: lock.packages.map((p) => ({ ...p, version, archive, location: `sha256:${archive}` })),
    });
  await expect(
    resolveWith(root, dir, requests, { previous: swap(first, '2.0.0', 'a'.repeat(64)) }),
  ).rejects.toMatchObject(refusal('CONFLICT', 'Registry changed the bytes of a published release: acme/lib@2.0.0'));
  const moved = decodeDistributionLock({
    ...first,
    packages: first.packages.map((p) => ({ ...p, manifest: 'b'.repeat(64) })),
  });
  await expect(resolveWith(root, dir, requests, { previous: moved })).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry changed the bytes of a published release: acme/lib@2.0.0'),
  );
  // The id may have been re-resolved since, so an absent locked version is not a conflict during install or update.
  const absent = await resolveWith(root, dir, requests, { previous: swap(first, '1.9.0', 'c'.repeat(64)) });
  expect(absent.candidates.map((c) => c.release.archiveDigest)).toEqual([find(releases, 'acme/lib@2.1.0').archive]);
});

it('prefers the locked pin, and lets a newer release win for the id named by preferredExcept', async () => {
  const { dir, releases } = await registry([
      { id: 'acme/lib', version: '1.0.0' },
      { id: 'acme/lib', version: '1.1.0' },
    ]),
    root = workspaceRoot();
  const requests = [{ id: 'acme/lib', range: '^1.0.0' }];
  const previous = resolveReleases(
    requests,
    (await resolveWith(root, dir, [{ id: 'acme/lib', range: '1.0.0' }])).candidates,
    ENGINE,
  ).lock;
  const kept = await resolveWith(root, dir, requests, { previous });
  expect(pins(resolveReleases(requests, kept.candidates, ENGINE, previous).lock)).toEqual([
    `acme/lib@1.0.0 sha256:${find(releases, 'acme/lib@1.0.0').archive}`,
  ]);
  const updated = await resolveWith(root, dir, requests, { previous, preferredExcept: 'acme/lib' });
  expect(pins(resolveReleases(requests, updated.candidates, ENGINE, previous).lock)).toEqual([
    `acme/lib@1.1.0 sha256:${find(releases, 'acme/lib@1.1.0').archive}`,
  ]);
});

it('reads a dependency without an index as having no releases, so selection refuses with its own reason', async () => {
  const { dir } = await registry([
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/missing', range: '^1.0.0' }] },
  ]);
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/app', range: '*' }])).rejects.toMatchObject(
    refusal('CONFLICT', 'No compatible complete release set: acme/missing: ^1.0.0 from acme/app@1.0.0'),
  );
});

it('(f) refuses a metadata closure beyond 256 registry reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-registry-wide-'));
  made.push(dir);
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(value));
  };
  put('ia-registry.json', { format: 'ia.registry.v1', name: 'Wide' });
  const release = (n: number) => ({
    version: `1.0.${n}`,
    archive: String(n).repeat(64),
    manifest: 'f'.repeat(64),
    engine: '^0.1.0',
    language: ['1.0'],
    withdrawn: false,
    access: 'public',
    artifact: `artifacts/${String(n).repeat(64)}.ia.tgz`,
    dependencies: Array.from({ length: 100 }, (_, k) => ({ id: `acme/dep${n * 100 + k}`, range: '*' })),
  });
  put('packages/acme/root.json', {
    format: 'ia.registry-package.v1',
    id: 'acme/root',
    releases: [1, 2, 3].map(release),
  });
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/root', range: '*' }])).rejects.toMatchObject(
    refusal('RESOLUTION-LIMIT', 'Resolution exceeded 256 registry reads'),
  );
});

it('(g) reports withdrawn locked releases and refuses a locked release the index no longer lists or has changed', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const lock = resolveReleases(requests, (await resolveWith(root, dir, requests)).candidates, ENGINE).lock,
    choose = chooser(root, dir);
  expect(await registryWithdrawals(root, lock, choose)).toEqual([]);
  editIndex(dir, 'acme/lib', (list) => list.map((r) => (r.version === '1.1.0' ? { ...r, withdrawn: true } : r)));
  expect(await registryWithdrawals(root, lock, choose)).toEqual(['acme/lib@1.1.0']);
  editIndex(dir, 'acme/lib', (list) =>
    list.map((r) =>
      r.version === '1.1.0'
        ? {
            ...r,
            withdrawn: false,
            archive: find(releases, 'acme/lib@1.0.0').archive,
            artifact: `artifacts/${find(releases, 'acme/lib@1.0.0').archive}.ia.tgz`,
          }
        : r,
    ),
  );
  await expect(registryWithdrawals(root, lock, choose)).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry changed the bytes of a published release: acme/lib@1.1.0'),
  );
  editIndex(dir, 'acme/lib', (list) => list.filter((r) => r.version !== '1.1.0'));
  await expect(registryWithdrawals(root, lock, choose)).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry no longer lists the locked release: acme/lib@1.1.0'),
  );
  unlinkSync(indexPath(dir, 'acme/app'));
  await expect(registryWithdrawals(root, lock, choose)).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry no longer lists the locked release: acme/app@1.0.0'),
  );
});

it('names the artifact URL when an HTTPS artifact fetch fails, and the base when a directory lacks the artifact', async () => {
  const { dir, releases } = await registry(appOnLib),
    requests = [{ id: 'acme/app', range: '^1.0.0' }],
    app = find(releases, 'acme/app@1.0.0');
  serveDirectory(dir, HTTPS);
  const served = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes('/artifacts/'))
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    return served(input, init);
  });
  const url = `${HTTPS}artifacts/${app.archive}.ia.tgz`;
  await expect(resolveWith(workspaceRoot(), 'https://registry.test/base', requests)).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', `Artifact request ${url} failed: fetch failed (connect ECONNREFUSED)`),
  );
  vi.unstubAllGlobals();
  serveDirectory(dir, HTTPS);
  unlinkSync(join(dir, 'artifacts', `${app.archive}.ia.tgz`));
  await expect(resolveWith(workspaceRoot(), 'https://registry.test/base', requests)).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', `Artifact request ${url} returned 404`),
  );
  await expect(resolveWith(workspaceRoot(), dir, requests)).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', `Registry ${dir} has no artifacts/${app.archive}.ia.tgz`),
  );
});

it('refuses a directory artifact that is hard-linked', async () => {
  const { dir, releases } = await registry([{ id: 'acme/lib', version: '1.0.0' }]),
    lib = find(releases, 'acme/lib@1.0.0');
  linkSync(join(dir, 'artifacts', `${lib.archive}.ia.tgz`), join(dir, 'alias.tgz'));
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/lib', range: '*' }])).rejects.toMatchObject({
    code: 'IA-DIST-PATH-UNSAFE',
  });
});

it('guards what an acquirer returns and names the release it was acquiring', async () => {
  const { dir, releases } = await registry([
      { id: 'acme/lib', version: '2.0.0', licensed: true },
      { id: 'acme/other', version: '1.0.0' },
    ]),
    requests = [{ id: 'acme/lib', range: '^2.0.0' }];
  const nothing = {
    async acquire() {
      return null;
    },
  } as unknown as Acquirer;
  await expect(resolveWith(workspaceRoot(), dir, requests, { acquirer: nothing })).rejects.toMatchObject(
    refusal('INTEGRITY-MISMATCH', /for acme\/lib@2\.0\.0$/),
  );
  const broken: Acquirer = {
    async acquire() {
      throw new Error('license server down');
    },
  };
  await expect(resolveWith(workspaceRoot(), dir, requests, { acquirer: broken })).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', 'Acquirer failed for acme/lib@2.0.0: license server down'),
  );
  const controller = new AbortController(),
    reason = new Error('stopped');
  const aborting: Acquirer = {
    async acquire() {
      controller.abort(reason);
      throw reason;
    },
  };
  await expect(
    resolveWith(workspaceRoot(), dir, requests, { acquirer: aborting, signal: controller.signal }),
  ).rejects.toBe(reason);
  // Wrong bytes under the right name: the verifier's refusal, prefixed with the release.
  const root = workspaceRoot();
  const forged: Acquirer = {
    async acquire(release) {
      mkdirSync(join(root, '.ia/distributions/cache'), { recursive: true });
      writeFileSync(
        join(root, `.ia/distributions/cache/${release.archive}.ia.tgz`),
        find(releases, 'acme/other@1.0.0').bytes,
      );
      return { location: `sha256:${release.archive}` };
    },
  };
  await expect(resolveWith(root, dir, requests, { acquirer: forged })).rejects.toMatchObject(
    refusal('ARCHIVE-INVALID', 'acme/lib@2.0.0: Archive digest mismatch'),
  );
});

it('names only licensed picks whose exclusion leaves no complete release set', async () => {
  const { dir } = await registry([
    {
      id: 'acme/app',
      version: '1.0.0',
      dependencies: [
        { id: 'acme/core', range: '^1.0.0' },
        { id: 'acme/lib', range: '^1.0.0' },
      ],
    },
    { id: 'acme/lib', version: '1.0.0' },
    { id: 'acme/lib', version: '1.1.0', licensed: true },
    { id: 'acme/core', version: '1.0.0', licensed: true },
  ]);
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/app', range: '*' }])).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/core@1.0.0 is available only as a licensed release; this CLI has no licensed acquisition path',
    ),
  );
});

it('names a licensed pick whose id also has a public release when only the licensed one fits', async () => {
  const { dir } = await registry([
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/core', range: '^2.0.0' }] },
    { id: 'acme/core', version: '1.0.0' },
    { id: 'acme/core', version: '2.0.0', licensed: true },
  ]);
  await expect(
    resolveWith(workspaceRoot(), dir, [
      { id: 'acme/app', range: '*' },
      { id: 'acme/core', range: '*' },
    ]),
  ).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/core@2.0.0 is available only as a licensed release; this CLI has no licensed acquisition path',
    ),
  );
});

it('does not name a licensed pick chosen only because it is the highest version', async () => {
  // Both licensed ids have an admissible public release (`*`), so "no public alternative" cannot tell them apart.
  const { dir } = await registry([
    { id: 'acme/a', version: '1.0.0' },
    { id: 'acme/a', version: '2.0.0', licensed: true },
    { id: 'acme/x', version: '1.0.0', dependencies: [{ id: 'acme/core', range: '^2.0.0' }] },
    { id: 'acme/core', version: '1.0.0' },
    { id: 'acme/core', version: '2.0.0', licensed: true },
  ]);
  await expect(
    resolveWith(workspaceRoot(), dir, [
      { id: 'acme/a', range: '*' },
      { id: 'acme/core', range: '*' },
      { id: 'acme/x', range: '*' },
    ]),
  ).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/core@2.0.0 is available only as a licensed release; this CLI has no licensed acquisition path',
    ),
  );
});

it('names every individually necessary licensed pick, including one whose id has a public release', async () => {
  const { dir } = await registry([
    { id: 'acme/x', version: '1.0.0', dependencies: [{ id: 'acme/core', range: '^2.0.0' }] },
    { id: 'acme/core', version: '1.0.0' },
    { id: 'acme/core', version: '2.0.0', licensed: true },
    { id: 'acme/util', version: '1.0.0', licensed: true },
  ]);
  await expect(
    resolveWith(workspaceRoot(), dir, [
      { id: 'acme/core', range: '*' },
      { id: 'acme/util', range: '*' },
      { id: 'acme/x', range: '*' },
    ]),
  ).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/core@2.0.0, acme/util@1.0.0 are available only as licensed releases; this CLI has no licensed acquisition path',
    ),
  );
});

it('names all licensed picks when none is individually necessary', async () => {
  // Either licensed id completes the set through a different x, so excluding one alone still succeeds.
  const { dir } = await registry([
    { id: 'acme/x', version: '1.0.0', dependencies: [{ id: 'acme/q', range: '^1.0.0' }] },
    { id: 'acme/x', version: '2.0.0', dependencies: [{ id: 'acme/p', range: '^1.0.0' }] },
    { id: 'acme/p', version: '1.0.0', licensed: true },
    { id: 'acme/q', version: '1.0.0', licensed: true },
  ]);
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/x', range: '*' }])).rejects.toMatchObject(
    refusal(
      'LICENSE-REQUIRED',
      'acme/p@1.0.0 is available only as a licensed release; this CLI has no licensed acquisition path',
    ),
  );
});

it('installs a registry resolution through native admission', async () => {
  const { dir } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const { lock } = resolveReleases(requests, (await resolveWith(root, dir, requests)).candidates, ENGINE);
  expect(applyInstallation(planInstallation(root, lock, 'install'))).toMatchObject({ status: 'installed' });
  expect(
    (JSON.parse(readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8')) as DistributionLock).packages.map(
      (p) => p.id,
    ),
  ).toEqual(['acme/app', 'acme/lib']);
});

/** A user registries file mapping providers to bases, through the real chooser (§4 level 4). */
function userMapped(root: string, registries: Record<string, string>) {
  const config = mkdtempSync(join(tmpdir(), 'ia-registry-config-'));
  made.push(config);
  writeFileSync(join(config, 'registries.json'), JSON.stringify({ format: 'ia.registries.v1', registries }));
  return registryChooser({ root, env: { IA_CONFIG_HOME: config }, cwd: root });
}
it('never reads an id only an unselectable release depends on', async () => {
  const { dir } = await registry([
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'nowhere/lib', range: '^1.0.0' }] },
    { id: 'acme/app', version: '2.0.0' },
  ]);
  const root = workspaceRoot();
  const resolved = await resolveFromRegistries({
    root,
    requests: [{ id: 'acme/app', range: '^2.0.0' }],
    engine: ENGINE,
    choose: userMapped(root, { acme: dir }),
  });
  expect(resolved.candidates.map((c) => c.release.manifest.version)).toEqual(['2.0.0']);
  // The same dependency, once a request can reach it, is read and refused as unmapped.
  await expect(
    resolveFromRegistries({
      root,
      requests: [{ id: 'acme/app', range: '^1.0.0' }],
      engine: ENGINE,
      choose: userMapped(root, { acme: dir }),
    }),
  ).rejects.toMatchObject({ code: 'IA-DIST-REGISTRY-UNMAPPED' });
});

it('never contacts an unreachable base for an id no selectable release needs', async () => {
  const { dir } = await registry([
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'far/lib', range: '^1.0.0' }] },
    { id: 'acme/app', version: '2.0.0' },
  ]);
  const root = workspaceRoot(),
    contacted: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    contacted.push(String(input));
    throw new TypeError('fetch failed');
  });
  await resolveFromRegistries({
    root,
    requests: [{ id: 'acme/app', range: '^2.0.0' }],
    engine: ENGINE,
    choose: userMapped(root, { acme: dir, far: 'https://far.test/registry' }),
  });
  expect(contacted).toEqual([]);
  await expect(
    resolveFromRegistries({
      root,
      requests: [{ id: 'acme/app', range: '^1.0.0' }],
      engine: ENGINE,
      choose: userMapped(root, { acme: dir, far: 'https://far.test/registry' }),
    }),
  ).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', 'Registry request https://far.test/registry/ia-registry.json failed: fetch failed'),
  );
});

it('passes only admissible releases to selection, so a full index stays under the candidate bound', async () => {
  const { dir, releases } = await registry([
    { id: 'acme/lib', version: '1.0.0' },
    { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^1.0.0' }] },
  ]);
  const filler = Array.from({ length: 999 }, (_, n) => {
    const archive = n.toString(16).padStart(64, '0');
    return {
      version: `0.0.${n}`,
      archive,
      manifest: 'f'.repeat(64),
      engine: '^0.1.0',
      language: ['1.0'],
      dependencies: [],
      withdrawn: false,
      access: 'public',
      artifact: `artifacts/${archive}.ia.tgz`,
    };
  });
  editIndex(dir, 'acme/lib', (list) => [...filler, ...list]);
  const resolved = await resolveWith(workspaceRoot(), dir, [{ id: 'acme/app', range: '*' }]);
  expect(resolved.candidates.map((c) => c.release.archiveDigest).sort()).toEqual(
    [find(releases, 'acme/app@1.0.0').archive, find(releases, 'acme/lib@1.0.0').archive].sort(),
  );
});

it('reports an unprovisioned default registry as unavailable, and a configured base without its info file as not a registry', async () => {
  const root = workspaceRoot(),
    config = mkdtempSync(join(tmpdir(), 'ia-registry-config-'));
  made.push(config);
  vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
  const defaults = () => registryChooser({ root, env: { IA_CONFIG_HOME: config }, cwd: root }),
    flagged = () => registryChooser({ root, env: {}, flag: 'https://registry.test/empty', cwd: root });
  const unavailable = refusal(
    'ARTIFACT-UNAVAILABLE',
    'The default registry https://api.inventarch.dev/registry/ is not available; pass --registry, map the provider in .ia/registries.json, or use --catalog',
  );
  const requests = [{ id: 'inventarch/foundation', range: '*' }];
  await expect(resolveFromRegistries({ root, requests, engine: ENGINE, choose: defaults() })).rejects.toMatchObject(
    unavailable,
  );
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: ENGINE,
    requests,
    packages: [
      {
        id: 'inventarch/foundation',
        version: '1.0.0',
        archive: 'a'.repeat(64),
        manifest: 'b'.repeat(64),
        location: `sha256:${'a'.repeat(64)}`,
        dependencies: [],
      },
    ],
  });
  await expect(registryWithdrawals(root, lock, defaults())).rejects.toMatchObject(unavailable);
  const notRegistry = refusal('INPUT-INVALID', 'Not a registry: https://registry.test/empty/ has no ia-registry.json');
  await expect(resolveFromRegistries({ root, requests, engine: ENGINE, choose: flagged() })).rejects.toMatchObject(
    notRegistry,
  );
  await expect(registryWithdrawals(root, lock, flagged())).rejects.toMatchObject(notRegistry);
});

// Registry spec §5.1 and §6.3, operator decision 2026-09-23: cached lock pins answer for themselves.
const fetchedIndexes = (requested: readonly string[]) =>
  requested.filter((u) => u.includes('/packages/')).map((u) => u.slice(`${HTTPS}packages/`.length));
const fetchedArtifacts = (requested: readonly string[]) => requested.filter((u) => u.includes('/artifacts/'));
/** An unpublished (null-provenance) archive cached in `root`, as `ia init` caches its bundled base, and its lock entry. */
function unpublishedBase(root: string) {
  const base = fixtureArchive({ id: 'acme/base', version: '1.0.0', repository: null });
  cacheArchive(root, base.bytes, base.archive);
  return {
    base,
    locked: {
      id: 'acme/base',
      version: '1.0.0',
      archive: base.archive,
      manifest: base.manifest,
      location: `sha256:${base.archive}`,
      dependencies: [] as string[],
    },
  };
}
/** `lock` with one more locked and requested package. */
const withLocked = (
  lock: DistributionLock | undefined,
  locked: ReturnType<typeof unpublishedBase>['locked'],
): DistributionLock =>
  decodeDistributionLock({
    formatVersion: 1,
    engine: lock?.engine ?? ENGINE,
    requests: [...(lock?.requests ?? []), { id: locked.id, range: '*' }].sort((a, b) => (a.id < b.id ? -1 : 1)),
    packages: [...(lock?.packages ?? []), locked].sort((a, b) => (a.id < b.id ? -1 : 1)),
  });

it('(h) keeps cached lock pins without reading their indexes and reads only the ids the command names', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    base = 'https://registry.test/base',
    first = [{ id: 'acme/app', range: '^1.0.0' }];
  const requested = serveDirectory(dir, HTTPS);
  const previous = resolveReleases(first, (await resolveWith(root, base, first)).candidates, ENGINE).lock;
  requested.length = 0;
  const requests = [...first, { id: 'acme/unused', range: '*' }],
    unused = find(releases, 'acme/unused@1.0.0');
  const resolved = await resolveWith(root, base, requests, { previous, named: ['acme/unused'] });
  expect(fetchedIndexes(requested)).toEqual(['acme/unused.json']);
  expect(fetchedArtifacts(requested)).toEqual([`${HTTPS}artifacts/${unused.archive}.ia.tgz`]);
  expect(pins(resolveReleases(requests, resolved.candidates, ENGINE, previous).lock)).toEqual(
    [...pins(previous), `acme/unused@1.0.0 ${HTTPS}artifacts/${unused.archive}.ia.tgz`].sort(),
  );
  // A kept pin came from no registry; only the named id did.
  expect([...resolved.sources.keys()]).toEqual(['acme/unused']);
});

it('(i) reads a cached pin index once a dependency range excludes the pinned version', async () => {
  const { dir, releases } = await registry([
    ...appOnLib,
    { id: 'acme/newapp', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^1.1.0' }] },
  ]);
  const root = workspaceRoot(),
    base = 'https://registry.test/base',
    requested = serveDirectory(dir, HTTPS);
  const previous = resolveReleases(
    [{ id: 'acme/lib', range: '1.0.0' }],
    (await resolveWith(root, base, [{ id: 'acme/lib', range: '1.0.0' }])).candidates,
    ENGINE,
  ).lock;
  requested.length = 0;
  const requests = [
    { id: 'acme/lib', range: '^1.0.0' },
    { id: 'acme/newapp', range: '*' },
  ];
  const resolved = await resolveWith(root, base, requests, { previous, named: ['acme/newapp'] });
  expect(fetchedIndexes(requested)).toEqual(['acme/newapp.json', 'acme/lib.json']);
  expect(pins(resolveReleases(requests, resolved.candidates, ENGINE, previous).lock)).toContain(
    `acme/lib@1.1.0 ${HTTPS}artifacts/${find(releases, 'acme/lib@1.1.0').archive}.ia.tgz`,
  );
});

it('(j) reads the index of a named locked id and of a locked id whose pin is not usable from the cache', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    base = 'https://registry.test/base',
    requested = serveDirectory(dir, HTTPS);
  const requests = [{ id: 'acme/lib', range: '^1.0.0' }],
    lib = find(releases, 'acme/lib@1.0.0');
  const previous = resolveReleases(
    requests,
    (await resolveWith(root, base, [{ id: 'acme/lib', range: '1.0.0' }])).candidates,
    ENGINE,
  ).lock;
  requested.length = 0;
  // Named: its index is read; the lock's location equals the registry's, so the registry candidate is the one kept.
  const named = await resolveWith(root, base, requests, { previous, named: ['acme/lib'] });
  expect(fetchedIndexes(requested)).toEqual(['acme/lib.json']);
  expect(fetchedArtifacts(requested)).toEqual([]);
  expect(pins(resolveReleases(requests, named.candidates, ENGINE, previous).lock)).toEqual(pins(previous));
  expect([...named.sources.keys()]).toEqual(['acme/lib']);
  // Not named, but not cached: its index is read and the archive fetched again.
  requested.length = 0;
  unlinkSync(join(root, '.ia/distributions/cache', `${lib.archive}.ia.tgz`));
  const uncached = await resolveWith(root, base, requests, { previous, named: [] });
  expect(fetchedIndexes(requested)).toEqual(['acme/lib.json']);
  expect(fetchedArtifacts(requested)).toEqual([`${HTTPS}artifacts/${lib.archive}.ia.tgz`]);
  expect(pins(resolveReleases(requests, uncached.candidates, ENGINE, previous).lock)).toEqual(pins(previous));
  // Cached but not the lock's bytes (a corrupt copy): not usable, so it is read too, and the corrupt copy then refuses,
  // located at the cache file.
  requested.length = 0;
  writeFileSync(join(root, '.ia/distributions/cache', `${lib.archive}.ia.tgz`), 'corrupt');
  await expect(resolveWith(root, base, requests, { previous, named: [] })).rejects.toMatchObject({
    code: 'IA-DIST-ARCHIVE-INVALID',
    path: `.ia/distributions/cache/${lib.archive}.ia.tgz`,
  });
  expect(fetchedIndexes(requested)).toEqual(['acme/lib.json']);
});

it('(k) keeps a pin and its lock location when a named registry lists the same archive elsewhere', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/lib', range: '^1.0.0' }];
  serveDirectory(dir, HTTPS);
  const previous = resolveReleases(
    requests,
    (await resolveWith(root, 'https://registry.test/base', [{ id: 'acme/lib', range: '1.0.0' }])).candidates,
    ENGINE,
  ).lock;
  vi.unstubAllGlobals();
  // The same release through a directory registry: one candidate, at the lock's HTTPS location, from no registry.
  const resolved = await resolveWith(root, dir, requests, { previous, named: ['acme/lib'] });
  expect(resolved.candidates.map((c) => `${c.release.manifest.version} ${c.location}`)).toEqual([
    `1.0.0 ${HTTPS}artifacts/${find(releases, 'acme/lib@1.0.0').archive}.ia.tgz`,
  ]);
  expect([...resolved.sources.keys()]).toEqual([]);
  // The unchanged resolver accepts the merged candidate set: one candidate per id@version, so its identity check holds.
  expect(pins(resolveReleases(requests, resolved.candidates, ENGINE, previous).lock)).toEqual(pins(previous));
  // A withdrawn entry for the pinned archive withdraws the pin too, so the newest remaining release wins.
  editIndex(dir, 'acme/lib', (list) => list.map((r) => (r.version === '1.0.0' ? { ...r, withdrawn: true } : r)));
  const withdrawn = await resolveWith(root, dir, requests, { previous, named: ['acme/lib'] });
  expect(withdrawn.candidates.map((c) => c.release.manifest.version)).toEqual(['1.1.0']);
});

it('(l) exempts an unpublished pin from the append-only check and never reads it unless named', async () => {
  const { dir } = await registry([...appOnLib, { id: 'acme/base', version: '1.0.0' }]),
    root = workspaceRoot(),
    base = 'https://registry.test/base';
  const requested = serveDirectory(dir, HTTPS),
    { locked } = unpublishedBase(root),
    previous = withLocked(undefined, locked);
  // The registry lists a published acme/base@1.0.0 with other bytes; the unpublished pin is not that release, so no conflict.
  const named = await resolveWith(root, base, [{ id: 'acme/base', range: '*' }], { previous });
  expect(fetchedIndexes(requested)).toEqual(['acme/base.json']);
  expect(named.candidates.map((c) => c.location)).toEqual([locked.location]);
  // A registry that lists nothing for it is no conflict either.
  editIndex(dir, 'acme/base', () => []);
  const empty = await resolveWith(root, base, [{ id: 'acme/base', range: '*' }], { previous });
  expect(empty.candidates.map((c) => c.location)).toEqual([locked.location]);
  // Not named, it is never read.
  requested.length = 0;
  const requests = [
    { id: 'acme/app', range: '^1.0.0' },
    { id: 'acme/base', range: '*' },
  ];
  const other = await resolveWith(root, base, requests, { previous, named: ['acme/app'] });
  expect(fetchedIndexes(requested)).toEqual(['acme/app.json', 'acme/lib.json']);
  expect(pins(resolveReleases(requests, other.candidates, ENGINE, previous).lock)).toContain(
    `acme/base@1.0.0 ${locked.location}`,
  );
});

it('(m) skips unpublished pins in registryWithdrawals, and reads every other locked package', async () => {
  const { dir } = await registry(appOnLib),
    root = workspaceRoot(),
    base = 'https://registry.test/base',
    requests = [{ id: 'acme/app', range: '^1.0.0' }];
  const requested = serveDirectory(dir, HTTPS);
  const { locked } = unpublishedBase(root),
    lock = withLocked(
      resolveReleases(requests, (await resolveWith(root, base, requests)).candidates, ENGINE).lock,
      locked,
    );
  requested.length = 0;
  expect(await registryWithdrawals(root, lock, chooser(root, base))).toEqual([]);
  expect(fetchedIndexes(requested).sort()).toEqual(['acme/app.json', 'acme/lib.json']);
  // A fresh clone has no cached copy to show the base is unpublished, so the registry is asked and does not list it.
  const clone = workspaceRoot();
  await expect(registryWithdrawals(clone, lock, chooser(clone, base))).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry no longer lists the locked release: acme/base@1.0.0'),
  );
});

it('(n) still refuses a published cached pin whose index is read and changed its bytes', async () => {
  const { dir, releases } = await registry(appOnLib),
    root = workspaceRoot(),
    requests = [{ id: 'acme/lib', range: '^1.0.0' }];
  const previous = resolveReleases(
    requests,
    (await resolveWith(root, dir, [{ id: 'acme/lib', range: '1.0.0' }])).candidates,
    ENGINE,
  ).lock;
  const other = find(releases, 'acme/lib@1.1.0').archive;
  editIndex(dir, 'acme/lib', (list) =>
    list.map((r) => (r.version === '1.0.0' ? { ...r, archive: other, artifact: `artifacts/${other}.ia.tgz` } : r)),
  );
  await expect(resolveWith(root, dir, requests, { previous, named: ['acme/lib'] })).rejects.toMatchObject(
    refusal('CONFLICT', 'Registry changed the bytes of a published release: acme/lib@1.0.0'),
  );
  // Not named and usable from the cache, the pin answers for itself and the changed index is not read.
  await expect(resolveWith(root, dir, requests, { previous, named: [] })).resolves.toBeDefined();
});

it('(o) looks up a cached pin whose engine range no longer admits the running engine', async () => {
  const { dir, releases } = await registry([
    { id: 'acme/lib', version: '1.0.0', engine: '<0.1.0' },
    { id: 'acme/lib', version: '1.1.0' },
    { id: 'acme/unused', version: '1.0.0' },
  ]);
  const root = workspaceRoot(),
    old = find(releases, 'acme/lib@1.0.0');
  cacheArchive(root, old.bytes, old.archive);
  const previous = decodeDistributionLock({
    formatVersion: 1,
    engine: ENGINE,
    requests: [{ id: 'acme/lib', range: '^1.0.0' }],
    packages: [
      {
        id: 'acme/lib',
        version: '1.0.0',
        archive: old.archive,
        manifest: old.manifest,
        location: `sha256:${old.archive}`,
        dependencies: [],
      },
    ],
  });
  const requests = [
    { id: 'acme/lib', range: '^1.0.0' },
    { id: 'acme/unused', range: '*' },
  ];
  const resolved = await resolveWith(root, dir, requests, { previous, named: ['acme/unused'] });
  expect(pins(resolveReleases(requests, resolved.candidates, ENGINE, previous).lock)).toEqual([
    `acme/lib@1.1.0 sha256:${find(releases, 'acme/lib@1.1.0').archive}`,
    `acme/unused@1.0.0 sha256:${find(releases, 'acme/unused@1.0.0').archive}`,
  ]);
  expect([...resolved.sources.keys()].sort()).toEqual(['acme/lib', 'acme/unused']);
});

it('(p) refuses a registry release whose archive is unpublished', async () => {
  const { dir } = await registry([{ id: 'acme/lib', version: '1.0.0', repository: null }]);
  await expect(resolveWith(workspaceRoot(), dir, [{ id: 'acme/lib', range: '*' }])).rejects.toMatchObject(
    refusal('INTEGRITY-MISMATCH', 'Registry lists an unpublished archive: acme/lib@1.0.0'),
  );
});

it('(q) keeps an unpublished pin over a same-version registry release even for the id update names', async () => {
  const { dir } = await registry([{ id: 'acme/base', version: '1.0.0' }]),
    root = workspaceRoot();
  const { locked } = unpublishedBase(root),
    previous = withLocked(undefined, locked);
  const updated = await resolveWith(root, dir, [{ id: 'acme/base', range: '*' }], {
    previous,
    preferredExcept: 'acme/base',
  });
  expect(updated.candidates.map((c) => c.location)).toEqual([locked.location]);
});

it('(r) locates a refusal at a corrupt cached pin when the registry cannot stand in for it', async () => {
  const { dir } = await registry(appOnLib),
    root = workspaceRoot(),
    { locked } = unpublishedBase(root);
  const path = `.ia/distributions/cache/${locked.archive}.ia.tgz`;
  writeFileSync(join(root, path), 'corrupt');
  // No registry lists the unpublished base, so with its cached copy corrupt nothing can satisfy its request.
  await expect(
    resolveWith(
      root,
      dir,
      [
        { id: 'acme/app', range: '^1.0.0' },
        { id: 'acme/base', range: '*' },
      ],
      { previous: withLocked(undefined, locked), named: ['acme/app'] },
    ),
  ).rejects.toMatchObject({ code: 'IA-DIST-CONFLICT', path });
});
