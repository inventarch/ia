import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DistributionLock } from '@inventarch/db/distribution';
import { verifyArchive } from '../src/archive.js';
import { json } from '../src/files.js';
import { applyInstallation, planInstallation } from '../src/install.js';
import { runNative } from '../src/native-command.js';
import { registryAdd, registryWithdraw } from '../src/registry-build.js';
import { decodePackageIndex, decodeRegistryInfo } from '../src/registry-layout.js';
import { registryChooser } from '../src/registry-config.js';
import { resolveFromRegistries } from '../src/registry-resolve.js';
import { resolveReleases } from '../src/resolve.js';
import { fixtureArchive, serveDirectory } from './registry-fixture.js';
import type { FixtureRelease, FixtureReleaseSpec } from './registry-fixture.js';

const made: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
/** Each test gets its own fresh OS-temp directories. */
const temp = (prefix = 'ia-registry-build-'): string => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  made.push(p);
  return p;
};
const refusal = (code: string, message: string | RegExp) => ({
  code: `IA-DIST-${code}`,
  message: typeof message === 'string' ? message : expect.stringMatching(message),
});
const packed = new Map<string, FixtureRelease>();
/** A real packed archive, packed once per spec per process and written to a fresh file. */
function archive(spec: FixtureReleaseSpec): { file: string; release: FixtureRelease } {
  const key = JSON.stringify(spec),
    release = packed.get(key) ?? fixtureArchive(spec);
  packed.set(key, release);
  const file = join(temp('ia-registry-archive-'), `${spec.id.replace('/', '-')}-${spec.version}.ia.tgz`);
  writeFileSync(file, release.bytes);
  return { file, release };
}
/** Every file under `dir`, relative path → bytes. */
function tree(dir: string, at = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [p, b] of tree(dir, path)) out.set(p, b);
    else out.set(path, readFileSync(join(dir, path)));
  }
  return out;
}
const read = (dir: string, path: string): string => readFileSync(join(dir, path), 'utf8');
/** Canonical registry JSON: sorted keys, 2-space indentation, trailing newline. */
const canonical = (value: unknown): string => JSON.stringify(JSON.parse(json(value)), null, 2) + '\n';
const index = (dir: string, id: string) => decodePackageIndex(read(dir, `packages/${id}.json`), id);

it('creates the layout from one verified archive, copying the release metadata from its manifest', () => {
  const dir = temp(),
    { file, release } = archive({ id: 'acme/lib', version: '1.0.0' }),
    manifest = verifyArchive(release.bytes).manifest;
  expect(registryAdd({ dir, archive: file })).toEqual({
    status: 'registry-added',
    id: 'acme/lib',
    version: '1.0.0',
    archive: release.archive,
  });
  expect(decodeRegistryInfo(read(dir, 'ia-registry.json'))).toEqual({ format: 'ia.registry.v1', name: basename(dir) });
  expect(readFileSync(join(dir, 'artifacts', `${release.archive}.ia.tgz`)).equals(release.bytes)).toBe(true);
  expect(index(dir, 'acme/lib')).toEqual({
    format: 'ia.registry-package.v1',
    id: 'acme/lib',
    releases: [
      {
        version: '1.0.0',
        archive: release.archive,
        manifest: release.manifest,
        engine: manifest.engine,
        language: ['1.0'],
        dependencies: [],
        withdrawn: false,
        access: 'public',
        artifact: `artifacts/${release.archive}.ia.tgz`,
      },
    ],
  });
  for (const path of ['ia-registry.json', 'packages/acme/lib.json']) {
    const text = read(dir, path);
    expect(text).toBe(canonical(JSON.parse(text)));
    expect(text).toMatch(/^\{\n {2}"/);
  }
  expect([...tree(dir).keys()].sort()).toEqual([
    `artifacts/${release.archive}.ia.tgz`,
    'ia-registry.json',
    'packages/acme/lib.json',
  ]);
});

it('copies dependencies and honours --name when the registry is created', () => {
  const dir = temp(),
    { file, release } = archive({
      id: 'acme/app',
      version: '1.0.0',
      dependencies: [{ id: 'acme/lib', range: '^1.0.0' }],
    });
  registryAdd({ dir, archive: file, name: 'Acme mirror' });
  expect(decodeRegistryInfo(read(dir, 'ia-registry.json')).name).toBe('Acme mirror');
  expect(index(dir, 'acme/app').releases[0]).toMatchObject({
    archive: release.archive,
    dependencies: [{ id: 'acme/lib', range: '^1.0.0' }],
  });
});

it('keeps releases in compareVersions order (highest first) as versions are added', () => {
  const dir = temp();
  for (const v of ['1.1.0', '1.0.0', '2.0.0'])
    registryAdd({ dir, archive: archive({ id: 'acme/lib', version: v }).file });
  expect(index(dir, 'acme/lib').releases.map((r) => r.version)).toEqual(['2.0.0', '1.1.0', '1.0.0']);
  expect(readdirSync(join(dir, 'artifacts'))).toHaveLength(3);
});

it('treats re-adding identical bytes as a no-op and refuses the same version with different bytes', () => {
  const dir = temp(),
    { file, release } = archive({ id: 'acme/lib', version: '1.0.0' });
  registryAdd({ dir, archive: file });
  const before = tree(dir),
    mtime = statSync(join(dir, 'packages/acme/lib.json')).mtimeMs;
  expect(registryAdd({ dir, archive: file })).toEqual({
    status: 'registry-added',
    id: 'acme/lib',
    version: '1.0.0',
    archive: release.archive,
  });
  expect(tree(dir)).toEqual(before);
  expect(statSync(join(dir, 'packages/acme/lib.json')).mtimeMs).toBe(mtime);
  const other = archive({ id: 'acme/lib', version: '1.0.0', repository: 'https://fixture.example/elsewhere' });
  expect(other.release.archive).not.toBe(release.archive);
  expect(() => registryAdd({ dir, archive: other.file })).toThrow(
    expect.objectContaining(refusal('CONFLICT', /acme\/lib@1\.0\.0/)),
  );
  expect(tree(dir)).toEqual(before);
});

it('refuses an unpublished local archive before writing anything', () => {
  const dir = temp(),
    { file } = archive({ id: 'acme/lib', version: '1.0.0', repository: null });
  expect(() => registryAdd({ dir, archive: file })).toThrow(
    expect.objectContaining(
      refusal('INPUT-INVALID', 'An unpublished local archive carries no source provenance and cannot be published'),
    ),
  );
  expect(readdirSync(dir)).toEqual([]);
});

it('refuses an invalid archive, a relative path and a missing registry directory', () => {
  const dir = temp(),
    bad = join(temp(), 'bad.ia.tgz');
  writeFileSync(bad, 'not an archive');
  expect(() => registryAdd({ dir, archive: bad })).toThrow(
    expect.objectContaining({ code: 'IA-DIST-ARCHIVE-INVALID' }),
  );
  expect(() => registryAdd({ dir, archive: join(dir, 'absent.ia.tgz') })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', `Missing input archive: ${join(dir, 'absent.ia.tgz')}`)),
  );
  expect(() => registryAdd({ dir, archive: 'relative.ia.tgz' })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /absolute --archive/)),
  );
  expect(() => registryAdd({ dir: 'relative', archive: bad })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /absolute --registry/)),
  );
  expect(() => registryAdd({ dir: join(dir, 'missing'), archive: bad })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /must already exist/)),
  );
  expect(readdirSync(dir)).toEqual([]);
});

it('keeps an existing registry name, refusing a different --name and a malformed ia-registry.json', () => {
  const dir = temp(),
    { file } = archive({ id: 'acme/lib', version: '1.0.0' });
  writeFileSync(join(dir, 'ia-registry.json'), JSON.stringify({ format: 'ia.registry.v1', name: 'Existing' }));
  const info = readFileSync(join(dir, 'ia-registry.json'));
  expect(() => registryAdd({ dir, archive: file, name: 'Other' })).toThrow(
    expect.objectContaining(refusal('CONFLICT', /Existing/)),
  );
  expect(existsSync(join(dir, 'artifacts'))).toBe(false);
  registryAdd({ dir, archive: file, name: 'Existing' });
  registryAdd({ dir, archive: archive({ id: 'acme/lib', version: '1.1.0' }).file });
  expect(readFileSync(join(dir, 'ia-registry.json')).equals(info)).toBe(true);
  const broken = temp();
  writeFileSync(join(broken, 'ia-registry.json'), '{"format":"ia.registry.v1"}');
  expect(() => registryAdd({ dir: broken, archive: file })).toThrow(
    expect.objectContaining({ ...refusal('INPUT-INVALID', /ia-registry\.json/), path: 'ia-registry.json' }),
  );
  expect(readdirSync(broken)).toEqual(['ia-registry.json']);
});

it('refuses a malformed existing index, naming it, and never overwrites it', () => {
  const dir = temp(),
    { file } = archive({ id: 'acme/lib', version: '1.0.0' });
  mkdirSync(join(dir, 'packages/acme'), { recursive: true });
  writeFileSync(join(dir, 'packages/acme/lib.json'), '{"format":"ia.registry-package.v1","id":"acme/lib"}');
  const before = tree(dir);
  expect(() => registryAdd({ dir, archive: file })).toThrow(
    expect.objectContaining({
      ...refusal('INPUT-INVALID', /packages\/acme\/lib\.json/),
      path: 'packages/acme/lib.json',
    }),
  );
  expect(tree(dir)).toEqual(before);
});

it('refuses an artifact file whose bytes differ from its digest name, leaving the index unwritten', () => {
  const dir = temp(),
    { file, release } = archive({ id: 'acme/lib', version: '1.0.0' });
  mkdirSync(join(dir, 'artifacts'));
  writeFileSync(join(dir, 'artifacts', `${release.archive}.ia.tgz`), 'tampered');
  expect(() => registryAdd({ dir, archive: file })).toThrow(
    expect.objectContaining(refusal('CONFLICT', new RegExp(`artifacts/${release.archive}\\.ia\\.tgz`))),
  );
  expect(existsSync(join(dir, 'packages'))).toBe(false);
  // An artifact already holding exactly the bytes is kept as-is.
  const good = temp();
  mkdirSync(join(good, 'artifacts'));
  writeFileSync(join(good, 'artifacts', `${release.archive}.ia.tgz`), release.bytes);
  registryAdd({ dir: good, archive: file });
  expect(index(good, 'acme/lib').releases.map((r) => r.version)).toEqual(['1.0.0']);
});

it('enforces the release count and index size bounds before writing', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0'),
    { file } = archive({ id: 'acme/lib', version: '1.0.0' });
  const entry = (v: string, n: number, dependencies: { id: string; range: string }[] = []) => ({
    version: v,
    archive: hex(n),
    manifest: hex(n),
    engine: '^0.1.0',
    language: ['1.0'],
    dependencies,
    withdrawn: false,
    access: 'public',
    artifact: `artifacts/${hex(n)}.ia.tgz`,
  });
  const seed = (releases: unknown[]) => {
    const dir = temp();
    mkdirSync(join(dir, 'packages/acme'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/acme/lib.json'),
      JSON.stringify({ format: 'ia.registry-package.v1', id: 'acme/lib', releases }),
    );
    return dir;
  };
  const full = seed(Array.from({ length: 1000 }, (_, n) => entry(`0.0.${n}`, n + 1)));
  expect(() => registryAdd({ dir: full, archive: file })).toThrow(
    expect.objectContaining(refusal('LIMIT-EXCEEDED', /1000 releases/)),
  );
  expect(existsSync(join(full, 'artifacts'))).toBe(false);
  // A compact index just under 4 MiB grows past it once re-encoded with indentation.
  const deps = Array.from({ length: 128 }, (_, n) => ({
      id: `acme/dependency-${'x'.repeat(90)}-${n}`,
      range: '^1.0.0',
    })),
    releases: unknown[] = [];
  while (JSON.stringify(releases).length + JSON.stringify(entry('0.0.0', 1, deps)).length < 4 * 1024 * 1024 - 4096)
    releases.push(entry(`0.0.${releases.length}`, releases.length + 1, deps));
  const large = seed(releases);
  expect(() => registryAdd({ dir: large, archive: file })).toThrow(
    expect.objectContaining(refusal('LIMIT-EXCEEDED', /4194304 bytes/)),
  );
  expect(existsSync(join(large, 'artifacts'))).toBe(false);
});

it('refuses a registry directory reached through a link and a link inside it', () => {
  const real = temp(),
    parent = temp(),
    { file } = archive({ id: 'acme/lib', version: '1.0.0' });
  symlinkSync(real, join(parent, 'linked'), 'junction');
  expect(() => registryAdd({ dir: join(parent, 'linked'), archive: file })).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  const dir = temp(),
    outside = temp();
  symlinkSync(outside, join(dir, 'artifacts'), 'junction');
  expect(() => registryAdd({ dir, archive: file })).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
  expect(readdirSync(outside)).toEqual([]);
  expect(readdirSync(real)).toEqual([]);
});

it('withdraws a release without removing anything, idempotently', () => {
  const dir = temp(),
    a = archive({ id: 'acme/lib', version: '1.0.0' }),
    b = archive({ id: 'acme/lib', version: '1.1.0' });
  registryAdd({ dir, archive: a.file });
  registryAdd({ dir, archive: b.file });
  const artifacts = readdirSync(join(dir, 'artifacts')).sort();
  expect(registryWithdraw({ dir, id: 'acme/lib', version: '1.0.0' })).toEqual({
    status: 'registry-withdrawn',
    id: 'acme/lib',
    version: '1.0.0',
  });
  expect(index(dir, 'acme/lib').releases.map((r) => `${r.version} ${r.withdrawn} ${r.archive}`)).toEqual([
    `1.1.0 false ${b.release.archive}`,
    `1.0.0 true ${a.release.archive}`,
  ]);
  expect(readdirSync(join(dir, 'artifacts')).sort()).toEqual(artifacts);
  const text = read(dir, 'packages/acme/lib.json');
  expect(text).toBe(canonical(JSON.parse(text)));
  const before = tree(dir),
    mtime = statSync(join(dir, 'packages/acme/lib.json')).mtimeMs;
  expect(registryWithdraw({ dir, id: 'acme/lib', version: '1.0.0' })).toEqual({
    status: 'registry-withdrawn',
    id: 'acme/lib',
    version: '1.0.0',
  });
  expect(tree(dir)).toEqual(before);
  expect(statSync(join(dir, 'packages/acme/lib.json')).mtimeMs).toBe(mtime);
  expect(() => registryWithdraw({ dir, id: 'acme/lib', version: '9.9.9' })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /acme\/lib@9\.9\.9/)),
  );
  expect(() => registryWithdraw({ dir, id: 'acme/other', version: '1.0.0' })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /acme\/other/)),
  );
  expect(tree(dir)).toEqual(before);
  expect(() => registryWithdraw({ dir: temp(), id: 'acme/lib', version: '1.0.0' })).toThrow(
    expect.objectContaining(refusal('INPUT-INVALID', /no ia-registry\.json/)),
  );
});

it('runs add and withdraw as native commands without --root', async () => {
  const dir = temp(),
    { file, release } = archive({ id: 'acme/lib', version: '1.0.0' });
  expect(await runNative(['registry', 'add', '--registry', dir, '--archive', file])).toEqual({
    result: { status: 'registry-added', id: 'acme/lib', version: '1.0.0', archive: release.archive },
    exitCode: 0,
  });
  expect(decodeRegistryInfo(read(dir, 'ia-registry.json')).name).toBe(basename(dir));
  const named = temp();
  await runNative(['registry', 'add', '--registry', named, '--archive', file, '--name', 'Named']);
  expect(decodeRegistryInfo(read(named, 'ia-registry.json')).name).toBe('Named');
  expect(
    await runNative(['registry', 'withdraw', '--registry', dir, '--id', 'acme/lib', '--version', '1.0.0']),
  ).toEqual({ result: { status: 'registry-withdrawn', id: 'acme/lib', version: '1.0.0' }, exitCode: 0 });
  expect(index(dir, 'acme/lib').releases[0]!.withdrawn).toBe(true);
  await expect(runNative(['registry', 'add', '--registry', dir])).rejects.toMatchObject(
    refusal('INPUT-INVALID', 'Missing --archive'),
  );
  await expect(
    runNative(['registry', 'withdraw', '--registry', dir, '--id', 'acme/lib', '--archive', file]),
  ).rejects.toMatchObject(refusal('INPUT-INVALID', /Unknown\/duplicate/));
  await expect(runNative(['registry', 'publish', '--registry', dir])).rejects.toMatchObject(
    refusal('INPUT-INVALID', 'Unknown native command'),
  );
  await expect(runNative(['registry', 'add', '--root', dir, '--archive', file])).rejects.toMatchObject(
    refusal('INPUT-INVALID', /Unknown\/duplicate/),
  );
});

it('builds a directory that the registry resolver reads, skipping a withdrawn release', async () => {
  const dir = temp(),
    a = archive({ id: 'acme/lib', version: '1.0.0' }),
    b = archive({ id: 'acme/lib', version: '1.1.0' });
  registryAdd({ dir, archive: a.file });
  registryAdd({ dir, archive: b.file });
  const choose = () => ({
    provider: 'acme',
    base: { kind: 'dir' as const, path: dir },
    level: 'flag' as const,
    source: '--registry',
  });
  const resolve = async () =>
    (
      await resolveFromRegistries({
        root: temp('ia-registry-ws-'),
        requests: [{ id: 'acme/lib', range: '^1.0.0' }],
        engine: '0.1.0',
        choose,
      })
    ).candidates.map((c) => `${c.release.manifest.version} ${c.location}`);
  expect(await resolve()).toEqual([`1.1.0 sha256:${b.release.archive}`]);
  registryWithdraw({ dir, id: 'acme/lib', version: '1.1.0' });
  expect(await resolve()).toEqual([`1.0.0 sha256:${a.release.archive}`]);
});

it('writes nothing outside the registry directory', () => {
  const parent = temp(),
    dir = join(parent, 'registry');
  mkdirSync(dir);
  registryAdd({ dir, archive: archive({ id: 'acme/lib', version: '1.0.0' }).file });
  expect(readdirSync(parent)).toEqual(['registry']);
  expect(dirname(dir)).toBe(parent);
});

it.skipIf(process.platform === 'win32')('writes every registry file world-readable (0644), whatever the umask', () => {
  // A narrow umask shows the mode is set explicitly; worker threads cannot change the umask, so there the default one applies.
  const dir = temp();
  let previous: number | undefined;
  try {
    previous = process.umask(0o077);
  } catch {
    previous = undefined;
  }
  try {
    const { release } = archive({ id: 'acme/lib', version: '1.0.0' });
    registryAdd({ dir, archive: archive({ id: 'acme/lib', version: '1.0.0' }).file });
    const paths = ['ia-registry.json', 'packages/acme/lib.json', `artifacts/${release.archive}.ia.tgz`];
    for (const path of paths) expect(statSync(join(dir, path)).mode & 0o777).toBe(0o644);
    registryWithdraw({ dir, id: 'acme/lib', version: '1.0.0' });
    expect(statSync(join(dir, 'packages/acme/lib.json')).mode & 0o777).toBe(0o644);
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
});

it('refuses to rewrite an index carrying reserved signatures, keeping an identical re-add a no-op', () => {
  const dir = temp(),
    a = archive({ id: 'acme/lib', version: '1.0.0' }),
    b = archive({ id: 'acme/lib', version: '1.1.0' });
  registryAdd({ dir, archive: a.file });
  const indexFile = join(dir, 'packages/acme/lib.json');
  writeFileSync(indexFile, canonical({ ...(JSON.parse(readFileSync(indexFile, 'utf8')) as object), signatures: [] }));
  const before = tree(dir),
    refused = refusal(
      'INPUT-INVALID',
      'packages/acme/lib.json carries reserved signatures this builder cannot maintain',
    );
  expect(registryAdd({ dir, archive: a.file })).toMatchObject({ status: 'registry-added', version: '1.0.0' });
  expect(() => registryAdd({ dir, archive: b.file })).toThrow(expect.objectContaining(refused));
  expect(() => registryWithdraw({ dir, id: 'acme/lib', version: '1.0.0' })).toThrow(expect.objectContaining(refused));
  expect(tree(dir)).toEqual(before);
});

it('refuses a hard-linked index and a hard-linked input archive, naming the archive path', () => {
  const dir = temp(),
    a = archive({ id: 'acme/lib', version: '1.0.0' }),
    b = archive({ id: 'acme/lib', version: '1.1.0' });
  registryAdd({ dir, archive: a.file });
  linkSync(join(dir, 'packages/acme/lib.json'), join(dir, 'alias.json'));
  const before = tree(dir);
  expect(() => registryAdd({ dir, archive: b.file })).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE', path: 'packages/acme/lib.json' }),
  );
  expect(() => registryWithdraw({ dir, id: 'acme/lib', version: '1.0.0' })).toThrow(
    expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }),
  );
  expect(tree(dir)).toEqual(before);
  const fresh = temp();
  linkSync(b.file, `${b.file}.alias`);
  expect(() => registryAdd({ dir: fresh, archive: b.file })).toThrow(
    expect.objectContaining({
      ...refusal('PATH-UNSAFE', `Input archive ${b.file}: Expected unaliased regular file: ${basename(b.file)}`),
      path: b.file,
    }),
  );
  expect(readdirSync(fresh)).toEqual([]);
});

/** A dependent app and its library, added to a fresh registry directory with the builder. */
function builtAppOnLib() {
  const dir = temp(),
    lib = archive({ id: 'acme/lib', version: '1.0.0' }),
    app = archive({ id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^1.0.0' }] });
  registryAdd({ dir, archive: lib.file });
  registryAdd({ dir, archive: app.file });
  return { dir, lib: lib.release, app: app.release };
}
const resolveBuilt = (root: string, flag: string) =>
  resolveFromRegistries({
    root,
    requests: [{ id: 'acme/app', range: '^1.0.0' }],
    engine: '0.1.0',
    choose: registryChooser({ root, env: {}, flag, cwd: root }),
  });

it('serves a built directory over HTTPS, locking artifact URLs', async () => {
  const { dir, lib, app } = builtAppOnLib(),
    root = temp('ia-registry-ws-'),
    base = 'https://registry.test/base/';
  const requested = serveDirectory(dir, base);
  const { lock } = resolveReleases(
    [{ id: 'acme/app', range: '^1.0.0' }],
    (await resolveBuilt(root, 'https://registry.test/base')).candidates,
    '0.1.0',
  );
  expect(lock.packages.map((p) => `${p.id}@${p.version} ${p.location}`)).toEqual([
    `acme/app@1.0.0 ${base}artifacts/${app.archive}.ia.tgz`,
    `acme/lib@1.0.0 ${base}artifacts/${lib.archive}.ia.tgz`,
  ]);
  expect(requested.filter((u) => u.includes('/artifacts/')).sort()).toEqual(
    [`${base}artifacts/${app.archive}.ia.tgz`, `${base}artifacts/${lib.archive}.ia.tgz`].sort(),
  );
});

it('installs from a built directory through native admission', async () => {
  const { dir } = builtAppOnLib(),
    root = temp('ia-registry-ws-');
  const { lock } = resolveReleases(
    [{ id: 'acme/app', range: '^1.0.0' }],
    (await resolveBuilt(root, dir)).candidates,
    '0.1.0',
  );
  expect(applyInstallation(planInstallation(root, lock, 'install'))).toMatchObject({ status: 'installed' });
  expect(
    (JSON.parse(readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8')) as DistributionLock).packages.map(
      (p) => p.id,
    ),
  ).toEqual(['acme/app', 'acme/lib']);
});
