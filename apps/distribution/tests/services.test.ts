import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeDistributionLock } from '@ia/db/distribution';
import { json, sha256 } from '../src/files.js';
import { applyHost, planHost } from '../src/host.js';
import { applyInstallation, cacheArchive, planInstallation } from '../src/install.js';
import { resolveReleases } from '../src/resolve.js';
import {
  acquireArtifact,
  cachedCandidates,
  formatSource,
  openWorkspaceSession,
  packToDirectory,
  planRestore,
  pruneLockRequest,
  readInstalledState,
  readWorkspaceLock,
  resolveCatalog,
  validateWorkspace,
  workOutputPath,
  writeWorkOutput,
} from '../src/services.js';
import { fixtureArchive } from './registry-fixture.js';
import { descriptor, snapshotFixture } from './snapshot-fixture.js';

let fixture: ReturnType<typeof snapshotFixture>;
beforeAll(() => {
  fixture = snapshotFixture();
}, 30000);
afterAll(() => {
  fixture?.close();
});
const code = (error: unknown): string =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : String(error);
const refusal = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    return code(error);
  }
  return 'no refusal';
};
/** Both placement and portability refuse with PATH-UNSAFE, so the message says which rule fired. */
const refused = (body: () => unknown): readonly [string, string] => {
  try {
    body();
  } catch (error) {
    return [code(error), (error as Error).message];
  }
  return ['no refusal', ''];
};
/** Every test that writes into a source workspace gets its own copy; fixture.root stays pristine. */
function sourceCopy(): string {
  const root = fixture.target();
  cpSync(fixture.root, root, { recursive: true });
  return root;
}
const asyncRefusal = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    return code(error);
  }
  return 'no refusal';
};
function installed(): string {
  const root = fixture.target();
  cacheArchive(root, fixture.packed.bytes);
  const selected = resolveReleases(
    [{ id: fixture.packed.manifest.id, range: '^0.1.0' }],
    [{ release: fixture.packed, location: `sha256:${fixture.packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  applyInstallation(planInstallation(root, selected.lock, 'install'));
  return root;
}

it('plans a restore as reviewable data and applies the same plan separately', async () => {
  const root = installed(),
    before = readFileSync(join(root, '.ia/distributions/active.json'), 'utf8');
  const planned = await planRestore({ root, offline: true });
  expect(planned.withdrawn).toEqual([]);
  expect(planned.plan).toMatchObject({ formatVersion: 1, operation: 'restore', root });
  expect(readFileSync(join(root, '.ia/distributions/active.json'), 'utf8')).toBe(before);
  expect(applyInstallation(planned.plan)).toMatchObject({ status: 'installed', counter: 2 });
});

it('saves output only as a new relative file under .ia/work', () => {
  const root = fixture.target();
  expect(workOutputPath({ root, path: '.ia/work/plan.json' })).toBe('.ia/work/plan.json');
  expect(workOutputPath({ root, path: join(root, '.ia/work/draft.ia'), acceptAbsolute: true })).toBe(
    '.ia/work/draft.ia',
  );
  expect(refused(() => workOutputPath({ root, path: 'notes/plan.json' }))).toEqual([
    'IA-DIST-PATH-UNSAFE',
    'Saved plans require a new .ia/work file',
  ]);
  // Absolute and traversing spellings never reach the placement rule; portable() refuses them first.
  expect(refused(() => workOutputPath({ root, path: '/tmp/plan.json' }))).toEqual([
    'IA-DIST-PATH-UNSAFE',
    'Unsafe relative path: /tmp/plan.json',
  ]);
  expect(refused(() => workOutputPath({ root, path: '.ia/work/../src/plan.json' }))).toEqual([
    'IA-DIST-PATH-UNSAFE',
    'Unsafe relative path: .ia/work/../src/plan.json',
  ]);
  const [platformCode, platformMessage] = refused(() =>
    workOutputPath({ root, path: join(root, '.ia/work/plan.json') }),
  );
  expect(platformCode).toBe('IA-DIST-PATH-UNSAFE');
  expect(platformMessage).toMatch(/^Unsafe relative path: /);
  writeWorkOutput({ root, path: '.ia/work/plan.json', content: Buffer.from('{}\n') });
  expect(existsSync(join(root, '.ia/work/plan.json'))).toBe(true);
  // Placement refuses before content resolves, so serializing can never preempt an unsafe destination.
  let serialized = false;
  const content = (): Buffer => {
    serialized = true;
    return Buffer.from('{}\n');
  };
  expect(refusal(() => writeWorkOutput({ root, path: 'notes/plan.json', content }))).toBe('IA-DIST-PATH-UNSAFE');
  expect(serialized).toBe(false);
  // Newness is a second rule: the prefix check passes and createFile refuses the existing entry.
  expect(refusal(() => writeWorkOutput({ root, path: '.ia/work/plan.json', content: Buffer.from('{}\n') }))).toBe(
    'IA-DIST-LOCAL-MODIFICATION',
  );
});

it('resolves a local catalog entry and a cached remote entry without a request', async () => {
  const root = fixture.target(),
    archive = fixture.packed.archiveDigest;
  fixture.put(root, 'vendor/foundation.ia.tgz', fixture.packed.bytes);
  const local = await resolveCatalog({ root, entries: [{ path: 'vendor/foundation.ia.tgz', withdrawn: false }] });
  expect(local.map((entry) => entry.location)).toEqual([`sha256:${archive}`]);
  const url = `https://example.invalid/releases/${archive}.ia.tgz`;
  const remote = await resolveCatalog({ root, entries: [{ url, digest: archive, withdrawn: true }] });
  expect(remote).toMatchObject([{ location: url, withdrawn: true }]);
  expect(remote[0]!.release.archiveDigest).toBe(archive);
  expect(await asyncRefusal(() => acquireArtifact({ root, url, digest: archive, offline: true }))).toBe('no refusal');
  expect(await asyncRefusal(() => resolveCatalog({ root, entries: { path: 'vendor/foundation.ia.tgz' } }))).toBe(
    'IA-DIST-INPUT-INVALID',
  );
});

it('refuses acquisition before any request when the location is not an immutable artifact', async () => {
  const root = fixture.target(),
    archive = fixture.packed.archiveDigest;
  const rejected: readonly (readonly [string, string])[] = [
    [`https://example.invalid/${archive}.ia.tgz`, 'f'.repeat(63)],
    [`http://example.invalid/${archive}.ia.tgz`, archive],
    [`https://user:secret@example.invalid/${archive}.ia.tgz`, archive],
    [`https://example.invalid/${archive}.ia.tgz?token=1`, archive],
    [`https://example.invalid/${archive}.ia.tgz#part`, archive],
    [`https://example.invalid/releases/${'e'.repeat(64)}.ia.tgz`, archive],
  ];
  for (const [url, digest] of rejected)
    expect(await asyncRefusal(() => acquireArtifact({ root, url, digest }))).toBe('IA-DIST-INPUT-INVALID');
  expect(
    await asyncRefusal(() =>
      acquireArtifact({ root, url: `https://example.invalid/${archive}.ia.tgz`, digest: archive, offline: true }),
    ),
  ).toBe('IA-DIST-RESTORE-REQUIRED');
});

it('only observes hosts when the caller opts in, and reports none registered when none exist', () => {
  // Host observation walks the filesystem; a caller that never asked must not receive a fabricated `[]`.
  expect(readInstalledState({ root: fixture.target() })).toEqual({ status: 'uninstalled' });
  expect(readInstalledState({ root: fixture.target() }).hosts).toBeUndefined();
  expect(readInstalledState({ root: fixture.target(), hosts: true })).toEqual({ status: 'uninstalled', hosts: [] });
  const root = installed(),
    state = readInstalledState({ root });
  expect(state.status).toBe('installed');
  expect(state.hosts).toBeUndefined();
  expect(readInstalledState({ root, hosts: true }).hosts).toEqual([]);
  expect(state.lock).toEqual(readWorkspaceLock({ root }));
  // pointer and inputs reach the native list/doctor wire; compare them with the written generation.
  expect(state.pointer).toEqual(JSON.parse(readFileSync(join(root, '.ia/distributions/active.json'), 'utf8')));
  const generation = `.ia/distributions/generations/${state.pointer!.generation}/inputs.json`;
  expect(state.inputs).toEqual(JSON.parse(readFileSync(join(root, generation), 'utf8')));
  expect(refusal(() => readWorkspaceLock({ root: fixture.target() }))).toBe('IA-DIST-INPUT-INVALID');
});

it('keeps reading installed state when a host state file is corrupted, reporting that host stale rather than throwing', () => {
  const root = fixture.target(),
    cache = fixture.target();
  const inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] }),
    launcher = '// l\n';
  mkdirSync(join(cache, 'scripts'), { recursive: true });
  writeFileSync(join(cache, 'inventory.json'), inventory);
  writeFileSync(join(cache, 'scripts/ia.mjs'), launcher);
  writeFileSync(
    join(cache, 'release.json'),
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  applyHost(planHost(root, 'claude', cache));
  // Disk corruption or a truncated write, not anything any code path here produces.
  writeFileSync(join(root, '.ia/distributions/hosts/claude-workspace.json'), 'not json at all');
  expect(() => readInstalledState({ root, hosts: true })).not.toThrow();
  expect(readInstalledState({ root, hosts: true }).hosts).toEqual([
    {
      host: 'claude',
      status: 'stale',
      release: null,
      cache: null,
      launcher: null,
      launcherExists: false,
      reasons: ['state-invalid'],
      elements: [],
    },
  ]);
});

it('cancels an in-flight archive stream without caching partial bytes', async () => {
  const root = fixture.target(),
    controller = new AbortController(),
    reason = new Error('interrupted');
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      started();
    },
    cancel,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Response(body);
    }),
  );
  try {
    const pending = acquireArtifact({
      root,
      url: `https://example.invalid/${fixture.packed.archiveDigest}.ia.tgz`,
      digest: fixture.packed.archiveDigest,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await reading;
    controller.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
    expect(existsSync(join(root, '.ia/distributions/install-lock.json'))).toBe(false);
    await expect(resolveCatalog({ root, entries: [], signal: controller.signal })).rejects.toBe(reason);
    await expect(planRestore({ root, offline: true, signal: controller.signal })).rejects.toBe(reason);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('names the artifact URL on every transport refusal and keeps the caller abort unchanged (registry spec §6.4)', async () => {
  const root = fixture.target(),
    digest = fixture.packed.archiveDigest,
    url = `https://example.invalid/releases/${digest}.ia.tgz`;
  const failure = async (): Promise<[string, string]> => {
    try {
      await acquireArtifact({ root, url, digest });
    } catch (error) {
      return [code(error), (error as Error).message];
    }
    return ['no refusal', ''];
  };
  try {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
    expect(await failure()).toEqual(['IA-DIST-ARTIFACT-UNAVAILABLE', `Artifact request ${url} returned 503`]);
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    expect(await failure()).toEqual(['IA-DIST-ARTIFACT-UNAVAILABLE', `Artifact request ${url} returned 404`]);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND example.invalid') });
    });
    expect(await failure()).toEqual([
      'IA-DIST-ARTIFACT-UNAVAILABLE',
      `Artifact request ${url} failed: fetch failed (getaddrinfo ENOTFOUND example.invalid)`,
    ]);
    vi.stubGlobal(
      'fetch',
      async () => new Response('x', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }),
    );
    expect(await failure()).toEqual(['IA-DIST-LIMIT-EXCEEDED', `Remote archive exceeds its byte ceiling: ${url}`]);
    const controller = new AbortController(),
      reason = new Error('stopped');
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      controller.abort(reason);
      options.signal!.throwIfAborted();
      return new Response(null);
    });
    await expect(acquireArtifact({ root, url, digest, signal: controller.signal })).rejects.toBe(reason);
    expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('prunes only directly requested distributions from a lock', () => {
  const lock = readWorkspaceLock({ root: installed() });
  expect(refusal(() => pruneLockRequest({ lock, id: 'fixture/absent' }))).toBe('IA-DIST-INPUT-INVALID');
  expect(pruneLockRequest({ lock, id: fixture.packed.manifest.id })).toMatchObject({ requests: [], packages: [] });
});

it('refuses to prune a distribution another direct request still reaches', () => {
  const base = 'a'.repeat(64),
    leaf = 'c'.repeat(64);
  const shared = decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: [
      { id: 'fixture/base', range: '^0.1.0' },
      { id: 'fixture/leaf', range: '^0.1.0' },
    ],
    packages: [
      {
        id: 'fixture/base',
        version: '0.1.0',
        archive: base,
        manifest: 'b'.repeat(64),
        location: `sha256:${base}`,
        dependencies: [],
      },
      {
        id: 'fixture/leaf',
        version: '0.1.0',
        archive: leaf,
        manifest: 'd'.repeat(64),
        location: `sha256:${leaf}`,
        dependencies: ['fixture/base'],
      },
    ],
  });
  expect(refusal(() => pruneLockRequest({ lock: shared, id: 'fixture/base' }))).toBe('IA-DIST-CONFLICT');
  expect(pruneLockRequest({ lock: shared, id: 'fixture/leaf' }).packages.map((p) => p.id)).toEqual(['fixture/base']);
});

it('reports admission through a standalone validation service', () => {
  const clean = validateWorkspace({ root: fixture.root });
  expect(clean).toMatchObject({ status: 'admitted' });
  expect(clean.records).toBeGreaterThan(0);
  expect(clean.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const broken = sourceCopy();
  fixture.put(broken, '.ia/src/broken.ia', 'this is not an ia record\n');
  const refusedWorkspace = validateWorkspace({ root: broken });
  expect(refusedWorkspace.status).toBe('refused');
  expect(refusedWorkspace.findings.some((f) => f.severity === 'error')).toBe(true);
  expect(refusedWorkspace.revision).not.toBe(clean.revision);
});

it('keeps a session verdict consistent with the handle it reports on after a refresh', () => {
  const root = sourceCopy(),
    session = openWorkspaceSession({ root });
  try {
    expect(session.admission()).toMatchObject({ status: 'admitted' });
    expect(session.within()).toMatch(/[0-9a-f-]{36}/);
    fixture.put(root, '.ia/src/broken.ia', 'this is not an ia record\n');
    session.reader.refresh();
    // formatSource refreshes this same handle, so a captured verdict would pair 'admitted' with errors.
    const after = session.admission();
    expect(after.status).toBe('refused');
    expect(after.findings.some((f) => f.severity === 'error')).toBe(true);
    expect(refusal(() => session.within())).toBe('IA-DIST-CLOSURE-INCOMPLETE');
  } finally {
    session.close();
  }
});

it('mints a scope token per call so one session can draft more than one file', () => {
  const root = sourceCopy(),
    session = openWorkspaceSession({ root });
  try {
    const first = session.within();
    // refresh() builds a new view even when the sources are unchanged, and formatSource refreshes on every
    // call. A token minted once is still admitted by the handle — the generation did not change — but it stays
    // bound to the records of the view it was minted against.
    session.reader.refresh();
    const second = session.within();
    expect(second).not.toBe(first);
    // The check the draft gate performs is object identity against the live records
    // (.ia/src/systems/authoring-system/src/index.ts:26). The older token fails it; the fresh one passes.
    const live = (token: string): boolean => {
      const selected = session.reader.snapshot({ within: token }).records,
        all = session.reader.records();
      return selected.length === all.length && selected.every((node, index) => node === all[index]);
    };
    expect(live(first)).toBe(false);
    expect(live(second)).toBe(true);
    // The observable the defect produced: every file after the first refused, with no diagnostics at all.
    // Three authored record files, taken from whichever corpus the copy holds, so the public tree runs it too.
    const paths = [
      ...new Set(
        session.reader
          .records()
          .map((node) => node.source.path)
          .filter((path) => /^\.ia\/src\/systems\/[^/]+\/records\/[^/]+\.ia$/.test(path)),
      ),
    ]
      .sort()
      .slice(0, 3);
    expect(paths).toHaveLength(3);
    for (const path of paths)
      expect(formatSource({ session, path, text: readFileSync(join(root, path), 'utf8') }), path).toMatchObject({
        status: 'draft',
        path,
      });
  } finally {
    session.close();
  }
});

it('packs into an explicit output directory and refuses to replace an existing archive', () => {
  const out = fixture.target(),
    sourceRoot = sourceCopy(),
    descriptorPath = 'release.json';
  writeFileSync(join(sourceRoot, descriptorPath), JSON.stringify(descriptor));
  const request = { sourceRoot, descriptorPath, outputRoot: out };
  const packed = packToDirectory(request);
  expect(packed).toMatchObject({ status: 'packed', path: `${packed.archive}.ia.tgz` });
  expect(existsSync(join(out, packed.path))).toBe(true);
  expect(refusal(() => packToDirectory(request))).toBe('IA-DIST-LOCAL-MODIFICATION');
});

it('refuses a descriptor that changed between the packing read and the recheck', () => {
  const out = fixture.target(),
    sourceRoot = sourceCopy(),
    descriptorPath = 'recheck.json';
  const target = join(sourceRoot, descriptorPath),
    original = JSON.stringify(descriptor);
  writeFileSync(target, original);
  // The destination callback is the one caller-controlled point between the read and the recheck; a
  // concurrent writer reaches the same branch but needs a second process.
  const rewrite = (): string => {
    writeFileSync(target, original + ' ');
    return out;
  };
  let raised: unknown;
  try {
    packToDirectory({ sourceRoot, descriptorPath, outputRoot: rewrite });
  } catch (error) {
    raised = error;
  }
  expect(code(raised)).toBe('IA-DIST-SOURCE-CHANGED');
  // Names the descriptor recheck, not packDistribution's own source/input rechecks, which already passed.
  expect((raised as Error).message).toBe('Release descriptor changed during packing');
  expect(readdirSync(out)).toEqual([]);
});

const CACHE = '.ia/distributions/cache';
it('offers every cached archive as a verified, unwithdrawn candidate and ignores what is not one (registry spec §5.4)', () => {
  const root = fixture.target();
  expect(cachedCandidates({ root })).toEqual([]);
  const lib = fixtureArchive({ id: 'acme/lib', version: '2.0.0' });
  cacheArchive(root, fixture.packed.bytes);
  cacheArchive(root, lib.bytes);
  fixture.put(root, `${CACHE}/notes.txt`, 'not an archive');
  fixture.put(root, `${CACHE}/${'A'.repeat(64)}.ia.tgz`, 'upper-case digest');
  fixture.put(root, `${CACHE}/${'b'.repeat(64)}.ia.tgz.partial`, 'partial');
  mkdirSync(join(root, CACHE, `${'c'.repeat(64)}.ia.tgz`));
  const candidates = cachedCandidates({ root }),
    expected = [
      [fixture.packed.archiveDigest, fixture.packed.manifest.id],
      [lib.archive, 'acme/lib'],
    ].sort(([a], [b]) => (a! < b! ? -1 : 1));
  expect(candidates.map((c) => [c.release.archiveDigest, c.release.manifest.id, c.location, c.withdrawn])).toEqual(
    expected.map(([digest, id]) => [digest, id, `sha256:${digest}`, false]),
  );
  // Verified, then reduced to manifest-level metadata: planning re-reads the selected archives, so no files are held.
  for (const c of candidates) {
    expect(c.release).not.toHaveProperty('files');
    expect(Object.keys(c.release).sort()).toEqual(['archiveDigest', 'manifest', 'manifestDigest']);
    expect(Object.isFrozen(c.release)).toBe(true);
  }
  const { lock } = resolveReleases([{ id: 'acme/lib', range: '*' }], candidates, '0.1.0');
  expect(lock.packages.map((p) => `${p.id}@${p.version} ${p.location}`)).toEqual([
    `acme/lib@2.0.0 sha256:${lib.archive}`,
  ]);
});

it('offers only cached releases reachable from the given ids, so an unrelated stale duplicate never conflicts', () => {
  const root = fixture.target(),
    published = fixtureArchive({ id: 'acme/lib', version: '2.0.0' }),
    local = fixtureArchive({ id: 'acme/lib', version: '2.0.0', repository: null });
  const app = fixtureArchive({ id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^2.0.0' }] });
  expect(published.archive).not.toBe(local.archive);
  for (const bytes of [fixture.packed.bytes, published.bytes, local.bytes, app.bytes]) cacheArchive(root, bytes);
  const id = fixture.packed.manifest.id,
    ids = (reach?: readonly string[]) =>
      cachedCandidates({ root, ...(reach ? { reach } : {}) })
        .map((c) => c.release.manifest.id)
        .sort();
  expect(ids()).toEqual([id, 'acme/app', 'acme/lib', 'acme/lib'].sort());
  expect(ids([id])).toEqual([id]);
  expect(ids([])).toEqual([]);
  expect(ids(['acme/absent'])).toEqual([]);
  // The unrelated duplicate is left out, so the request resolves.
  expect(
    resolveReleases([{ id, range: '^0.1.0' }], cachedCandidates({ root, reach: [id] }), '0.1.0').lock.packages.map(
      (p) => p.id,
    ),
  ).toEqual([id]);
  // Reachable through a cached manifest's dependency, the duplicate is ambiguous and refuses.
  expect(ids(['acme/app'])).toEqual(['acme/app', 'acme/lib', 'acme/lib']);
  expect(
    refused(() =>
      resolveReleases([{ id: 'acme/app', range: '*' }], cachedCandidates({ root, reach: ['acme/app'] }), '0.1.0'),
    ),
  ).toEqual(['IA-DIST-CONFLICT', 'Immutable release identity has different bytes/status: acme/lib@2.0.0']);
  expect(refusal(() => cachedCandidates({ root, reach: 'acme/app' as unknown as string[] }))).toBe(
    'IA-DIST-INPUT-INVALID',
  );
});

it('refuses a corrupt, misnamed, aliased or oversized cache with the verifier and file-system codes', () => {
  const corrupt = fixture.target(),
    path = `${CACHE}/${'f'.repeat(64)}.ia.tgz`;
  fixture.put(corrupt, path, 'corrupt');
  expect(refused(() => cachedCandidates({ root: corrupt }))).toEqual([
    'IA-DIST-ARCHIVE-INVALID',
    'Archive digest mismatch',
  ]);
  let raised: unknown;
  try {
    cachedCandidates({ root: corrupt });
  } catch (error) {
    raised = error;
  }
  expect((raised as { path?: string }).path).toBe(path);
  // Right bytes under another digest's name: the verifier's refusal, never a candidate filed under the wrong digest.
  const misnamed = fixture.target();
  fixture.put(misnamed, `${CACHE}/${'e'.repeat(64)}.ia.tgz`, fixture.packed.bytes);
  expect(refused(() => cachedCandidates({ root: misnamed }))).toEqual([
    'IA-DIST-ARCHIVE-INVALID',
    'Archive digest mismatch',
  ]);
  const aliased = fixture.target();
  cacheArchive(aliased, fixture.packed.bytes);
  linkSync(join(aliased, CACHE, `${fixture.packed.archiveDigest}.ia.tgz`), join(aliased, CACHE, 'alias'));
  expect(refusal(() => cachedCandidates({ root: aliased }))).toBe('IA-DIST-PATH-UNSAFE');
  // The bound is checked before any archive is read, so these empty files never reach the verifier.
  const crowded = fixture.target();
  mkdirSync(join(crowded, CACHE), { recursive: true });
  for (let n = 0; n < 1001; n++) writeFileSync(join(crowded, CACHE, `${n.toString(16).padStart(64, '0')}.ia.tgz`), '');
  expect(refused(() => cachedCandidates({ root: crowded }))).toEqual([
    'IA-DIST-LIMIT-EXCEEDED',
    'Archive cache holds more than 1000 archives',
  ]);
});

it('refuses a restore of registry-withdrawn pins unless accepted, without reading a catalog (registry spec §6.3)', async () => {
  const root = fixture.target(),
    lib = fixtureArchive({ id: 'acme/lib', version: '2.0.0' });
  const { lock } = resolveReleases(
    [{ id: 'acme/lib', range: '*' }],
    [{ release: cacheArchive(root, lib.bytes), location: `sha256:${lib.archive}`, withdrawn: false }],
    '0.1.0',
  );
  const pinned = ['acme/lib@2.0.0'];
  await expect(
    planRestore({ root, lock, withdrawn: pinned, allowWithdrawn: false, withdrawnRefusalPrefix: 'X' }),
  ).rejects.toMatchObject({ code: 'IA-DIST-RELEASE-WITHDRAWN', message: 'X: acme/lib@2.0.0' });
  const accepted = await planRestore({ root, lock, withdrawn: pinned, allowWithdrawn: true });
  expect(accepted.withdrawn).toEqual(pinned);
  expect(accepted.plan).toMatchObject({ formatVersion: 1, operation: 'restore', root });
  expect((await planRestore({ root, lock, withdrawn: [] })).withdrawn).toEqual([]);
  // Offline ignores withdrawal status, as it ignores the catalog.
  expect((await planRestore({ root, lock, withdrawn: pinned, offline: true })).withdrawn).toEqual([]);
  // A catalog and a registry withdrawal list are exclusive sources.
  expect(await asyncRefusal(() => planRestore({ root, lock, withdrawn: [], catalog: [] }))).toBe(
    'IA-DIST-INPUT-INVALID',
  );
  for (const withdrawn of [
    'acme/lib@2.0.0',
    [1],
    ['acme/lib@1.0.0'],
    ['acme/lib'],
    [...pinned, ...pinned],
  ] as unknown as string[][])
    expect(
      await asyncRefusal(() => planRestore({ root, lock, withdrawn, allowWithdrawn: true })),
      JSON.stringify(withdrawn),
    ).toBe('IA-DIST-INPUT-INVALID');
});
