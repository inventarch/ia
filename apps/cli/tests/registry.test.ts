/**
 * `ia install`, `ia update` and `ia restore` from registries: docs/specs/registry/README.md §§4–6, and the
 * consumer contract's §§2.8–2.11. Also `ia doctor`'s registry routing rows (§4, "Doctor").
 *
 * Every registry here is a directory the distribution fixture builds from real packed archives, so each digest, lock
 * and installed generation is one the mechanisms produced. An HTTPS registry is the same directory served through a
 * stubbed global fetch; nothing here reaches a network, and a test that must not fetch at all traps fetch so that a
 * fetch would fail it. Every run reads its own empty user configuration (`makeHost` sets IA_CONFIG_HOME), so the
 * precedence ladder never reaches the real per-user file.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_REGISTRIES } from '@ia/distribution/registry';
import {
  baseCompanionArchive,
  buildFixtureRegistry,
  fixtureArchive,
  indexEntry,
  registryOf,
  selectedRegistry,
  serveDirectory,
  sourcedClosure,
} from './registry-fixture.js';
import type { FixtureReleaseSpec, SourcedRelease } from './registry-fixture.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

const BASE = 'https://registry.test/base/';
/**
 * Registry spec §4 level 5: the one built-in mapping, read from the distribution package rather than spelled here, so
 * this public suite names neither the default provider nor its host.
 */
const [DEFAULT_PROVIDER, DEFAULT_BASE] = Object.entries(DEFAULT_REGISTRIES)[0]!;
const DEFAULT_INFO = `${DEFAULT_BASE}/ia-registry.json`;
const APP_ON_LIB: readonly FixtureReleaseSpec[] = [
  { id: 'acme/lib', version: '1.0.0' },
  { id: 'acme/app', version: '1.0.0', dependencies: [{ id: 'acme/lib', range: '^1.0.0' }] },
];

interface Locked {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly location: string;
}
interface Envelope {
  readonly plan: {
    readonly lock: {
      readonly requests: readonly { id: string; range: string }[];
      readonly packages: readonly Locked[];
    };
    readonly changes: { readonly added: readonly string[]; readonly updated: readonly string[] };
  };
  readonly applied?: { readonly status: string };
  readonly registries?: readonly { readonly provider: string; readonly base: string; readonly level: string }[];
  readonly withdrawn?: readonly string[];
}
interface Failure {
  readonly code: string;
  readonly exit: number;
  readonly message: string;
  readonly next: string | null;
  readonly where: { path: string | null } | null;
}

const fixtures: string[] = [];
// No test reaches a network: fetch throws unless a test installs its own stub, and every stub is removed after it.
beforeEach(() => {
  trapFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  cleanup();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registry(specs: readonly FixtureReleaseSpec[]): string {
  const dir = buildFixtureRegistry(specs);
  fixtures.push(dir);
  return dir;
}
/** An empty directory to install into, as `ia install --root` accepts one; the fixture archives admit on their own. */
function target(): string {
  const root = resolve(scratch('registry'), 'target');
  mkdirSync(root, { recursive: true });
  return root;
}
let template: string | undefined, companion: string | undefined;
/**
 * A workspace `ia init --apply` created, copied from one template initialized once per file. Its lock pins the bundled
 * base at a `sha256:` location, and that archive is unpublished, so no registry can list it (registry spec §5.1).
 */
async function initialized(): Promise<{ readonly root: string; readonly base: Locked }> {
  if (template === undefined) {
    const created = resolve(scratch('registry-init'), 'template');
    const result = await run(['init', created, '--apply', '--yes', '--json']);
    expect(result.exitCode, result.stdout).toBe(0);
    template = created;
  }
  const root = resolve(scratch('registry-init'), 'demo');
  cpSync(template, root, { recursive: true });
  const lock = JSON.parse(readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8')) as { packages: Locked[] };
  expect(lock.packages).toHaveLength(1);
  const base = lock.packages[0]!;
  return { root, base };
}
/** A directory registry serving `acme/app@1.0.0`, a published companion of the bundled base (see `baseCompanionArchive`). */
function companionRegistry(root: string, base: Locked): string {
  if (companion === undefined) {
    const spec = { id: 'acme/app', version: '1.0.0' };
    companion = registryOf([
      [spec, baseCompanionArchive(spec, readFileSync(join(root, '.ia/distributions/cache', `${base.archive}.ia.tgz`)))],
    ]);
    fixtures.push(companion);
  }
  return companion;
}
/** Registry spec §3: releases are appended to an index, never rewritten, except for the withdrawal flag. */
function editIndex(
  dir: string,
  id: string,
  edit: (releases: Record<string, unknown>[]) => Record<string, unknown>[],
): void {
  const file = join(dir, 'packages', `${id}.json`);
  const index = JSON.parse(readFileSync(file, 'utf8')) as { releases: Record<string, unknown>[] };
  writeFileSync(file, JSON.stringify({ ...index, releases: edit(index.releases) }));
}
/** Publishes one more real release into a fixture registry, in the layout `buildFixtureRegistry` writes. */
function addRelease(dir: string, spec: FixtureReleaseSpec): void {
  const release = fixtureArchive(spec);
  writeFileSync(join(dir, `artifacts/${release.archive}.ia.tgz`), release.bytes);
  editIndex(dir, spec.id, (releases) => [...releases, indexEntry(release, spec)]);
}
/** A fetch that fails the test if it is ever called; `calls` shows whether it was. */
function trapFetch(): ReturnType<typeof vi.fn> {
  const trapped = vi.fn(async () => {
    throw new TypeError('network trapped');
  });
  vi.stubGlobal('fetch', trapped);
  return trapped;
}
/** Every file under `.ia/`, by workspace-relative path, with its bytes: the installed state two workspaces must share. */
function installedState(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path).replaceAll('\\', '/')] = readFileSync(path).toString('base64');
    }
  };
  walk(join(root, '.ia'));
  return files;
}
const json = <T>(stdout: string): T => JSON.parse(stdout) as T;
const flat = (text: string): string => text.replace(/\s+/g, ' ');

it('installs from a directory registry named by --registry, pins sha256 locations and names the registry', async () => {
  const dir = registry(APP_ON_LIB),
    root = target(),
    trapped = trapFetch();
  const preview = await run(['install', 'acme/app', '--root', root, '--registry', dir]);
  expect(preview.exitCode, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('Registry');
  expect(preview.stdout).toContain(resolve(dir));
  expect(preview.stdout).toContain('flag');
  expect(preview.stdout).toContain(`Apply with "ia install acme/app --registry`);
  expect(existsSync(join(root, '.ia/distributions.lock.json'))).toBe(false);

  const applied = await run(['install', 'acme/app', '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const result = json<Envelope>(applied.stdout);
  expect(result.applied?.status).toBe('installed');
  expect(result.plan.lock.packages.map((pkg) => pkg.id)).toEqual(['acme/app', 'acme/lib']);
  for (const pkg of result.plan.lock.packages) {
    expect(pkg.location).toBe(`sha256:${pkg.archive}`);
    // §6.1: the plan names, for each package, the registry base it came from.
    expect(result.registries?.find((source) => source.provider === pkg.id.split('/')[0])?.base).toBe(resolve(dir));
  }
  expect(result.registries).toEqual([{ provider: 'acme', base: resolve(dir), level: 'flag' }]);
  expect(existsSync(join(root, '.ia/distributions.lock.json'))).toBe(true);
  expect(trapped).not.toHaveBeenCalled();

  // §10.1: a repeat install is unchanged.
  const again = json<Envelope>(
    (await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json'])).stdout,
  );
  expect(again.plan.changes.added).toEqual([]);
  expect(again.plan.changes.updated).toEqual([]);
});

it('installs with no flag when .ia/registries.json maps the provider to a directory inside the workspace', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  cpSync(dir, join(root, 'vendor/registry'), { recursive: true });
  mkdirSync(join(root, '.ia'), { recursive: true });
  writeFileSync(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: 'vendor/registry' } }),
  );
  trapFetch();
  const applied = await run(['install', 'acme/app', '--root', root, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const result = json<Envelope>(applied.stdout);
  expect(result.plan.lock.packages.map((pkg) => pkg.id)).toEqual(['acme/app', 'acme/lib']);
  expect(result.registries).toEqual([{ provider: 'acme', base: resolve(root, 'vendor/registry'), level: 'workspace' }]);
});

it('pins HTTPS artifact URLs from IA_REGISTRY and restores a fresh clone to byte-identical installed state', async () => {
  const dir = registry(APP_ON_LIB),
    root = target(),
    env = { IA_REGISTRY: 'https://registry.test/base' };
  const requested = serveDirectory(dir, BASE);
  const applied = await run(['install', 'acme/app', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  const result = json<Envelope>(applied.stdout);
  for (const pkg of result.plan.lock.packages) expect(pkg.location).toBe(`${BASE}artifacts/${pkg.archive}.ia.tgz`);
  expect(result.registries).toEqual([{ provider: 'acme', base: BASE, level: 'env' }]);

  // A fresh clone carries only what is committed: the lock (and authored sources, of which this workspace has none).
  const clone = target();
  mkdirSync(join(clone, '.ia'), { recursive: true });
  copyFileSync(join(root, '.ia/distributions.lock.json'), join(clone, '.ia/distributions.lock.json'));
  if (existsSync(join(root, '.ia/src'))) cpSync(join(root, '.ia/src'), join(clone, '.ia/src'), { recursive: true });
  requested.length = 0;
  const restored = await run(['restore', '--root', clone, '--apply', '--yes', '--json'], { env });
  expect(restored.exitCode, restored.stdout).toBe(0);
  expect(json<Envelope>(restored.stdout).registries).toEqual([{ provider: 'acme', base: BASE, level: 'env' }]);
  // §6.3: restore reads each locked package's index, and the bytes come from the locked locations.
  expect(requested).toContain(`${BASE}packages/acme/lib.json`);
  for (const pkg of result.plan.lock.packages) expect(requested).toContain(pkg.location);
  expect(installedState(clone)).toEqual(installedState(root));
});

it('refuses an unmapped provider at class 3 and names the workspace file and the flag', async () => {
  const root = target();
  trapFetch();
  const machine = await run(['install', 'acme/app', '--root', root, '--json']);
  expect(machine.exitCode).toBe(3);
  const failure = json<Failure>(machine.stdout);
  expect(failure).toMatchObject({ code: 'IA-DIST-REGISTRY-UNMAPPED', exit: 3 });
  expect(failure.next).toContain('.ia/registries.json');
  expect(failure.next).toContain('--registry');
  const human = await run(['install', 'acme/app', '--root', root]);
  expect(human.exitCode).toBe(3);
  expect(human.stderr).toContain('IA-DIST-REGISTRY-UNMAPPED');
  expect(flat(human.stderr)).toContain('.ia/registries.json');
  expect(existsSync(join(root, '.ia'))).toBe(false);
  expect(failure.message).toContain('provider acme (needed for acme/app)');

  // A locked package needs its provider mapped too, and the refusal names the id that needed it, not only the provider.
  const dir = registry([...APP_ON_LIB, { id: 'beta/tool', version: '1.0.0' }]),
    installed = target();
  expect(
    (await run(['install', 'acme/app', '--root', installed, '--registry', dir, '--apply', '--yes'])).exitCode,
  ).toBe(0);
  cpSync(dir, join(installed, 'vendor/registry'), { recursive: true });
  // A cached pin answers for itself (§5.1), so the locked acme packages are looked up only once their cache is gone.
  rmSync(join(installed, '.ia/distributions/cache'), { recursive: true, force: true });
  writeFileSync(
    join(installed, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { beta: 'vendor/registry' } }),
  );
  const locked = json<Failure>((await run(['install', 'beta/tool', '--root', installed, '--json'])).stdout);
  expect(locked).toMatchObject({ code: 'IA-DIST-REGISTRY-UNMAPPED', exit: 3 });
  expect(locked.message).toMatch(/provider acme \(needed for acme\/(?:app|lib)\)/);
});

it('locates a refusal from .ia/registries.json at that file', async () => {
  const root = target();
  mkdirSync(join(root, '.ia'), { recursive: true });
  writeFileSync(join(root, '.ia/registries.json'), JSON.stringify({ format: 'ia.registries.v0', registries: {} }));
  const failure = json<Failure>((await run(['install', 'acme/app', '--root', root, '--json'])).stdout);
  expect(failure).toMatchObject({ code: 'IA-DIST-INPUT-INVALID', exit: 3 });
  expect(failure.where?.path).toBe('.ia/registries.json');
  const human = await run(['install', 'acme/app', '--root', root]);
  expect(human.stderr).toContain('.ia/registries.json');
});

it('refuses --registry beside --catalog or --offline at parse time', async () => {
  const root = target();
  for (const argv of [
    ['install', 'acme/app', '--registry', 'x', '--catalog', 'c.json'],
    ['install', 'acme/app', '--registry', 'x', '--offline'],
    ['update', 'acme/app', '--registry', 'x', '--catalog', 'c.json'],
    ['update', 'acme/app', '--offline', '--registry', 'x'],
    ['restore', '--registry', 'x', '--catalog', 'c.json', '--apply', '--yes'],
    ['restore', '--registry', 'x', '--offline', '--apply', '--yes'],
  ]) {
    const got = await run([...argv, '--root', root]);
    expect(got.exitCode, argv.join(' ')).toBe(2);
    expect(got.stderr, argv.join(' ')).toContain('mutually exclusive');
  }
  expect(readdirSync(root)).toEqual([]);
});

it('installs offline from the workspace cache with the network trapped, ignoring unrelated cached duplicates', async () => {
  const dir = registry(APP_ON_LIB),
    first = target();
  expect((await run(['install', 'acme/app', '--root', first, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  // A second workspace holding only that cache, plus an unrelated id cached twice at one version with different bytes.
  const root = target(),
    cache = join(root, '.ia/distributions/cache');
  mkdirSync(cache, { recursive: true });
  cpSync(join(first, '.ia/distributions/cache'), cache, { recursive: true });
  for (const repository of ['https://fixture.example/one', 'https://fixture.example/two']) {
    const stale = fixtureArchive({ id: 'other/thing', version: '1.0.0', repository });
    writeFileSync(join(cache, `${stale.archive}.ia.tgz`), stale.bytes);
  }
  const trapped = trapFetch();
  const offline = await run(['install', 'acme/app', '--root', root, '--offline', '--apply', '--yes', '--json']);
  expect(offline.exitCode, offline.stdout).toBe(0);
  const result = json<Envelope>(offline.stdout);
  expect(result.plan.lock.packages.map((pkg) => [pkg.id, pkg.location])).toEqual(
    result.plan.lock.packages.map((pkg) => [pkg.id, `sha256:${pkg.archive}`]),
  );
  expect(result.plan.lock.packages.map((pkg) => pkg.id)).toEqual(['acme/app', 'acme/lib']);
  expect(result.registries).toBeUndefined();
  expect(trapped).not.toHaveBeenCalled();
  // The duplicate is real: asking for that id reaches it and refuses.
  const duplicate = await run(['install', 'other/thing', '--root', root, '--offline', '--json']);
  expect(duplicate.exitCode).toBe(3);
  expect(json<Failure>(duplicate.stdout).code).toBe('IA-DIST-CONFLICT');
});

it('updates a direct request without --to to the newest release in its existing range', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  expect(
    (await run(['install', 'acme/app', 'acme/lib', '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode,
  ).toBe(0);
  addRelease(dir, { id: 'acme/lib', version: '1.1.0' });
  const version = (envelope: Envelope, id: string): string | undefined =>
    envelope.plan.lock.packages.find((pkg) => pkg.id === id)?.version;
  // An install keeps the lock's pin (§5.2's preference); only update drops it.
  const kept = json<Envelope>((await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json'])).stdout);
  expect(version(kept, 'acme/lib')).toBe('1.0.0');
  const updated = await run(['update', 'acme/lib', '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(updated.exitCode, updated.stdout).toBe(0);
  const result = json<Envelope>(updated.stdout);
  expect(version(result, 'acme/lib')).toBe('1.1.0');
  expect(result.plan.changes.updated).toEqual(['acme/lib']);
  // §6.2: the direct request keeps its range.
  expect(result.plan.lock.requests).toEqual([
    { id: 'acme/app', range: '*' },
    { id: 'acme/lib', range: '*' },
  ]);
  // A package that is not a direct request is refused, as update --to refuses it.
  const other = target();
  expect((await run(['install', 'acme/app', '--root', other, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  const indirect = await run(['update', 'acme/lib', '--root', other, '--registry', dir, '--json']);
  expect(indirect.exitCode).toBe(3);
  expect(json<Failure>(indirect.stdout).message).toContain('acme/lib is not a direct request');
});

it('refuses a restore whose locked release the registry withdrew, unless --allow-withdrawn', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  expect((await run(['install', 'acme/app', '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  editIndex(dir, 'acme/lib', (releases) => releases.map((release) => ({ ...release, withdrawn: true })));
  const refused = await run(['restore', '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(refused.exitCode).toBe(3);
  const failure = json<Failure>(refused.stdout);
  expect(failure.code).toBe('IA-DIST-RELEASE-WITHDRAWN');
  expect(failure.message).toContain('--allow-withdrawn');
  expect(failure.message).toContain('acme/lib@1.0.0');

  const human = await run(['restore', '--root', root, '--registry', dir, '--allow-withdrawn', '--apply', '--yes']);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(flat(human.stdout)).toContain('Withdrawn releases accepted with --allow-withdrawn: acme/lib@1.0.0.');
  const machine = json<Envelope>(
    (await run(['restore', '--root', root, '--registry', dir, '--allow-withdrawn', '--apply', '--yes', '--json']))
      .stdout,
  );
  expect(machine.withdrawn).toEqual(['acme/lib@1.0.0']);
  expect(machine.registries).toEqual([{ provider: 'acme', base: resolve(dir), level: 'flag' }]);
});

it('reports an unavailable default registry at class 4 and names every other source', async () => {
  for (const status of [503, 404]) {
    const root = target(),
      requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      requested.push(String(input));
      return new Response('unavailable', { status });
    });
    const machine = await run(['install', `${DEFAULT_PROVIDER}/x`, '--root', root, '--json']);
    expect(machine.exitCode, `${status}: ${machine.stdout}`).toBe(4);
    const failure = json<Failure>(machine.stdout);
    expect(failure).toMatchObject({ code: 'IA-DIST-ARTIFACT-UNAVAILABLE', exit: 4 });
    for (const named of ['--registry', '.ia/registries.json', '--catalog'])
      expect(failure.next, `${status} ${named}`).toContain(named);
    expect(requested).toEqual([DEFAULT_INFO]);
    const human = await run(['install', `${DEFAULT_PROVIDER}/x`, '--root', root]);
    expect(human.exitCode).toBe(4);
    expect(human.stderr).toContain('IA-DIST-ARTIFACT-UNAVAILABLE');
    expect(existsSync(join(root, '.ia'))).toBe(false);
  }
});

it('gives an unreachable registry index a registry remedy, not a catalog one', async () => {
  const root = target();
  vi.stubGlobal('fetch', async (input: string | URL) =>
    String(input).endsWith('/ia-registry.json')
      ? new Response(JSON.stringify({ format: 'ia.registry.v1', name: 'Down' }))
      : new Response('unavailable', { status: 503 }),
  );
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', BASE, '--json']);
  expect(machine.exitCode).toBe(4);
  const failure = json<Failure>(machine.stdout);
  expect(failure.code).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  expect(failure.message).toContain(`${BASE}packages/acme/app.json`);
  for (const named of ['network access', '--registry', '.ia/registries.json', '--catalog'])
    expect(failure.next).toContain(named);
  expect(failure.next).not.toContain('catalog entry');
});

it('gives an artifact an HTTPS registry cannot serve a registry remedy, not a catalog one', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  serveDirectory(dir, BASE);
  const served = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) =>
    String(input).includes('/artifacts/') ? new Response('unavailable', { status: 503 }) : served(input, init),
  );
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', BASE, '--json']);
  expect(machine.exitCode).toBe(4);
  const failure = json<Failure>(machine.stdout);
  expect(failure.code).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  expect(failure.message).toMatch(
    /^Artifact request https:\/\/registry\.test\/base\/artifacts\/[0-9a-f]{64}\.ia\.tgz returned 503$/,
  );
  for (const named of ['network access', '--registry', '.ia/registries.json', '--catalog'])
    expect(failure.next).toContain(named);
  expect(failure.next).not.toContain('catalog entry');
});

it('names an incomplete directory registry when it lacks an artifact it lists', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  for (const name of readdirSync(join(dir, 'artifacts'))) rmSync(join(dir, 'artifacts', name));
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json']);
  expect(machine.exitCode).toBe(4);
  const failure = json<Failure>(machine.stdout);
  expect(failure.code).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  expect(failure.message).toMatch(/has no artifacts\/[0-9a-f]{64}\.ia\.tgz$/);
  expect(failure.next).toContain('incomplete');
  expect(failure.next).toContain('ia-distribution registry add');
  expect(failure.next).not.toContain('Retry when the host is reachable');
});

it('restores the committed lock over an active generation it drifted from', async () => {
  const dir = registry(APP_ON_LIB),
    root = target(),
    lockPath = join(root, '.ia/distributions.lock.json');
  expect(
    (await run(['install', 'acme/app', 'acme/lib', '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode,
  ).toBe(0);
  const committed = readFileSync(lockPath);
  addRelease(dir, { id: 'acme/lib', version: '1.1.0' });
  expect((await run(['update', 'acme/lib', '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  // The portable lock goes back to the committed one (a checkout of an older commit); the active generation does not.
  writeFileSync(lockPath, committed);
  // Every other operation still refuses the drift; restore is what repairs it.
  const install = json<Failure>(
    (await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json'])).stdout,
  );
  expect(install).toMatchObject({ code: 'IA-DB-SOURCE-UNAVAILABLE', exit: 3 });
  expect(install.message).toContain('lock-drift');
  const restored = await run(['restore', '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(restored.exitCode, restored.stdout).toBe(0);
  const result = json<Envelope>(restored.stdout);
  expect(result.plan.lock.packages.find((pkg) => pkg.id === 'acme/lib')?.version).toBe('1.0.0');
  expect(readFileSync(lockPath)).toEqual(committed);
  // The workspace is consistent again, so an ordinary install plans against it.
  expect((await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json'])).exitCode).toBe(0);
});

it('reports an oversized registry document at class 4', async () => {
  const root = target();
  vi.stubGlobal(
    'fetch',
    async () => new Response('{}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
  );
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', BASE, '--json']);
  expect(machine.exitCode).toBe(4);
  const failure = json<Failure>(machine.stdout);
  expect(failure.code).toBe('IA-DIST-LIMIT-EXCEEDED');
  expect(failure.message).toBe(`Registry document exceeds 4 MiB: ${BASE}ia-registry.json`);
  // A size limit is not a network fault, so the remedy is another source rather than a retry.
  expect(failure.next).toContain('4 MiB');
  expect(failure.next).not.toContain('network access');
  for (const named of ['--registry', '.ia/registries.json', '--catalog']) expect(failure.next).toContain(named);
});

it('refuses a licensed-only release at class 3 and names the catalog route', async () => {
  const dir = registry([{ id: 'acme/app', version: '1.0.0', licensed: true }]),
    root = target();
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json']);
  expect(machine.exitCode).toBe(3);
  const failure = json<Failure>(machine.stdout);
  expect(failure.code).toBe('IA-DIST-LICENSE-REQUIRED');
  expect(failure.message).toContain('acme/app@1.0.0');
  expect(failure.next).toContain('licensed acquisition');
  expect(failure.next).toContain('--catalog');
});

it('names the cache file to delete when a cached archive is unreadable, and the cache when it is over its bound', async () => {
  const root = target(),
    cache = join(root, '.ia/distributions/cache'),
    digest = 'c'.repeat(64);
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, `${digest}.ia.tgz`), 'not an archive');
  trapFetch();
  const invalid = json<Failure>((await run(['install', 'acme/app', '--root', root, '--offline', '--json'])).stdout);
  expect(invalid).toMatchObject({ code: 'IA-DIST-ARCHIVE-INVALID', exit: 3 });
  expect(invalid.where?.path).toBe(`.ia/distributions/cache/${digest}.ia.tgz`);
  expect(invalid.next).toContain(`Delete .ia/distributions/cache/${digest}.ia.tgz`);

  for (let n = 0; n <= 1000; n += 1) writeFileSync(join(cache, `${n.toString(16).padStart(64, '0')}.ia.tgz`), '');
  const full = json<Failure>((await run(['install', 'acme/app', '--root', root, '--offline', '--json'])).stdout);
  expect(full).toMatchObject({ code: 'IA-DIST-LIMIT-EXCEEDED', exit: 3 });
  expect(full.next).toContain('.ia/distributions/cache/');
  expect(full.next).toContain('--registry');
});

// Registry spec §5.1 and §6.3 (operator decision 2026-09-23): an `ia init` workspace keeps its unpublished base pin.
it('installs from a registry into an initialized workspace without consulting any registry about the bundled base', async () => {
  const { root, base } = await initialized(),
    dir = companionRegistry(root, base),
    trapped = trapFetch();
  const applied = await run(['install', 'acme/app', '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const result = json<Envelope>(applied.stdout);
  expect(result.plan.lock.packages.map((pkg) => pkg.id)).toEqual(['acme/app', base.id].sort());
  expect(result.plan.lock.packages.find((pkg) => pkg.id === base.id)).toEqual(base);
  expect(result.registries).toEqual([{ provider: 'acme', base: resolve(dir), level: 'flag' }]);
  expect(trapped).not.toHaveBeenCalled();
});

it('installs and restores in an initialized workspace whose .ia/registries.json maps only the new provider', async () => {
  const { root, base } = await initialized(),
    dir = companionRegistry(root, base),
    trapped = trapFetch();
  cpSync(dir, join(root, 'vendor/registry'), { recursive: true });
  writeFileSync(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: 'vendor/registry' } }),
  );
  const applied = await run(['install', 'acme/app', '--root', root, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(json<Envelope>(applied.stdout).plan.lock.packages.find((pkg) => pkg.id === base.id)).toEqual(base);
  // §6.3: restore asks the registries of the published pins whether they were withdrawn, and skips the unpublished base.
  const restored = await run(['restore', '--root', root, '--apply', '--yes', '--json']);
  expect(restored.exitCode, restored.stdout).toBe(0);
  expect(json<Envelope>(restored.stdout).registries).toEqual([
    { provider: 'acme', base: resolve(root, 'vendor/registry'), level: 'workspace' },
  ]);
  expect(trapped).not.toHaveBeenCalled();
});

it('consults the base registry when update names the bundled base, and reports it unavailable at class 4', async () => {
  const { root, base } = await initialized(),
    requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    requested.push(String(input));
    return new Response('unavailable', { status: 503 });
  });
  const machine = await run(['update', base.id, '--root', root, '--json']);
  expect(machine.exitCode, machine.stdout).toBe(4);
  expect(json<Failure>(machine.stdout).code).toBe('IA-DIST-ARTIFACT-UNAVAILABLE');
  expect(requested).toEqual([DEFAULT_INFO]);
});

it('names only new or changed requests from a --requests file, so an unchanged base request consults no registry', async () => {
  const { root, base } = await initialized(),
    dir = companionRegistry(root, base),
    trapped = trapFetch();
  const lock = JSON.parse(readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8')) as {
    requests: { id: string; range: string }[];
  };
  mkdirSync(join(root, '.ia/work'), { recursive: true });
  const requests = [...lock.requests, { id: 'acme/app', range: '*' }].sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(join(root, '.ia/work/requests.json'), JSON.stringify(requests));
  // Only acme is mapped, so reading the base's index would reach the (trapped) default registry.
  cpSync(dir, join(root, 'vendor/registry'), { recursive: true });
  writeFileSync(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: 'vendor/registry' } }),
  );
  const applied = await run([
    'install',
    '--requests',
    '.ia/work/requests.json',
    '--root',
    root,
    '--apply',
    '--yes',
    '--json',
  ]);
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(json<Envelope>(applied.stdout).plan.lock.packages.find((pkg) => pkg.id === base.id)).toEqual(base);
  expect(trapped).not.toHaveBeenCalled();
});

it('reports a filesystem failure with a CLI code, never a raw Node code', async () => {
  const dir = registry(APP_ON_LIB),
    root = target();
  // The workspace cache is a file, so caching a fetched archive fails in the filesystem, not in a service check.
  mkdirSync(join(root, '.ia/distributions'), { recursive: true });
  writeFileSync(join(root, '.ia/distributions/cache'), 'not a directory');
  const machine = await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json']);
  expect(machine.exitCode).toBe(3);
  expect(json<Failure>(machine.stdout).code).toMatch(/^IA-[A-Z]+-[A-Z-]+$/);
});

it('locates a failure at a corrupt cached base and names deleting it', async () => {
  const { root, base } = await initialized(),
    dir = companionRegistry(root, base),
    path = `.ia/distributions/cache/${base.archive}.ia.tgz`;
  writeFileSync(join(root, path), 'corrupt');
  // The corrupt pin is not usable, so the base is looked up; no registry lists an unpublished archive, so that fails.
  const failure = json<Failure>(
    (await run(['install', 'acme/app', '--root', root, '--registry', dir, '--json'])).stdout,
  );
  expect(failure.where?.path).toBe(path);
  expect(failure.next).toContain(`Delete ${path}`);
});

// Registry spec §4 "Doctor" (M5.4 plan Task 10): for each provider in the lock's requests and packages, the base it
// resolves to and the level that chose it. Doctor never contacts a registry, so every test here traps fetch.
interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly detail: string;
  readonly remedy: string | null;
}
const registryRows = (stdout: string): DoctorCheck[] =>
  json<{ checks: DoctorCheck[] }>(stdout).checks.filter((check) => check.id.startsWith('registry-'));

it('doctor reports the registry each provider routes to and the level that chose it', async () => {
  const { root, base } = await initialized(),
    dir = companionRegistry(root, base),
    trapped = trapFetch();
  cpSync(dir, join(root, 'vendor/registry'), { recursive: true });
  writeFileSync(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: 'vendor/registry' } }),
  );
  expect((await run(['install', 'acme/app', '--root', root, '--apply', '--yes'])).exitCode).toBe(0);
  const doctor = await run(['doctor', '--root', root, '--json']);
  // One row per provider, in provider order: acme from the workspace file, the bundled base's provider from the default.
  const expected: DoctorCheck[] = [
    {
      id: 'registry-acme',
      title: 'Registry acme',
      status: 'info',
      detail: `${resolve(realpathSync(root), 'vendor/registry')} (from workspace: .ia/registries.json)`,
      remedy: null,
    },
    {
      id: `registry-${DEFAULT_PROVIDER}`,
      title: `Registry ${DEFAULT_PROVIDER}`,
      status: 'info',
      detail: `${DEFAULT_BASE}/ (from default: built-in default)`,
      remedy: null,
    },
  ];
  expect(registryRows(doctor.stdout)).toEqual(expected.sort((a, b) => (a.id < b.id ? -1 : 1)));
  expect((await run(['doctor', '--root', root])).stdout).toContain('Registry acme');
  expect(trapped).not.toHaveBeenCalled();
});

it('doctor warns about a locked provider that no level maps, and names .ia/registries.json', async () => {
  const dir = registry(APP_ON_LIB),
    root = target(),
    trapped = trapFetch();
  // --registry answers for its own command only (§4 level 1), so afterwards no level maps acme.
  expect((await run(['install', 'acme/app', '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  const rows = registryRows((await run(['doctor', '--root', root, '--json'])).stdout);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'registry-acme', title: 'Registry acme', status: 'warn' });
  expect(rows[0]!.detail).toContain('IA-DIST-REGISTRY-UNMAPPED');
  expect(rows[0]!.detail).toContain('provider acme');
  expect(rows[0]!.remedy).toContain('.ia/registries.json');
  expect(trapped).not.toHaveBeenCalled();
});

it('doctor reports an HTTPS registry chosen by IA_REGISTRY without fetching from it', async () => {
  const dir = registry(APP_ON_LIB),
    root = target(),
    env = { IA_REGISTRY: 'https://registry.test/base' };
  serveDirectory(dir, BASE);
  expect((await run(['install', 'acme/app', '--root', root, '--apply', '--yes'], { env })).exitCode).toBe(0);
  const trapped = trapFetch();
  const rows = registryRows((await run(['doctor', '--root', root, '--json'], { env })).stdout);
  expect(rows).toEqual([
    {
      id: 'registry-acme',
      title: 'Registry acme',
      status: 'info',
      detail: `${BASE} (from env: IA_REGISTRY)`,
      remedy: null,
    },
  ]);
  expect(trapped).not.toHaveBeenCalled();
});

// §4 names the providers of the workspace's requests and lock, so the rows follow the portable lock, not an installed
// generation: a fresh clone has only the lock, and an installation whose activation pointer is missing, unusable or
// drifted from still has one.
const TWO_PROVIDERS: readonly FixtureReleaseSpec[] = [...APP_ON_LIB, { id: 'beta/tool', version: '1.0.0' }];
/**
 * An installation through --registry, which answers for its own command only (§4 level 1), so afterwards
 * `.ia/registries.json` maps beta and no level maps acme.
 */
async function mappedAndUnmapped(dir: string, ids: readonly string[] = ['acme/app', 'beta/tool']): Promise<string> {
  const root = target();
  expect((await run(['install', ...ids, '--root', root, '--registry', dir, '--apply', '--yes'])).exitCode).toBe(0);
  writeFileSync(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { beta: 'vendor/registry' } }),
  );
  return root;
}
/** The rows for a lock naming acme and beta at `root`: acme unmapped, beta from the workspace file. */
function expectMappedAndUnmapped(stdout: string, root: string): void {
  const rows = registryRows(stdout);
  expect(rows.map((row) => row.id)).toEqual(['registry-acme', 'registry-beta']);
  // The rows sit right after the generation row, before the pending-state row.
  const ids = json<{ checks: DoctorCheck[] }>(stdout).checks.map((check) => check.id);
  expect(ids.slice(ids.indexOf('generation'), ids.indexOf('pending') + 1)).toEqual([
    'generation',
    'registry-acme',
    'registry-beta',
    'pending',
  ]);
  expect(rows[0]).toMatchObject({ title: 'Registry acme', status: 'warn' });
  expect(rows[0]!.detail).toContain('IA-DIST-REGISTRY-UNMAPPED');
  expect(rows[0]!.remedy).toContain('.ia/registries.json');
  expect(rows[1]).toEqual({
    id: 'registry-beta',
    title: 'Registry beta',
    status: 'info',
    detail: `${resolve(realpathSync(root), 'vendor/registry')} (from workspace: .ia/registries.json)`,
    remedy: null,
  });
}
/** The generation row when the installed state cannot be read: its own finding, which the routing rows never replace. */
const expectUnreadGeneration = (stdout: string, root: string): void =>
  expect(json<{ checks: DoctorCheck[] }>(stdout).checks.find((check) => check.id === 'generation')).toEqual({
    id: 'generation',
    title: 'Generation',
    status: 'unknown',
    detail: 'Not checked; IA-DB-SOURCE-UNAVAILABLE',
    remedy: `ia-distribution recover --root ${realpathSync(root)}`,
  });

it('doctor reports each provider of a fresh clone that carries only the portable lock', async () => {
  const root = await mappedAndUnmapped(registry(TWO_PROVIDERS)),
    fresh = clone(root);
  copyFileSync(join(root, '.ia/registries.json'), join(fresh, '.ia/registries.json'));
  const trapped = trapFetch();
  const doctor = await run(['doctor', '--root', fresh, '--json']);
  expect(doctor.exitCode, doctor.stdout).toBe(0);
  expectMappedAndUnmapped(doctor.stdout, fresh);
  expectUnreadGeneration(doctor.stdout, fresh);
  expect((await run(['doctor', '--root', fresh])).stdout).toContain('Registry acme');
  expect(trapped).not.toHaveBeenCalled();
});

it('doctor reports the portable lock of an installation whose activation pointer is missing, unusable or drifted from', async () => {
  const dir = registry(TWO_PROVIDERS),
    trapped = trapFetch();
  const missing = await mappedAndUnmapped(dir),
    unusable = await mappedAndUnmapped(dir),
    drifted = await mappedAndUnmapped(dir, ['acme/app']);
  rmSync(join(missing, '.ia/distributions/active.json'));
  writeFileSync(join(unusable, '.ia/distributions/active.json'), '{}');
  // The active generation locks acme alone; the portable lock, as a checkout of another commit leaves it, names beta too.
  copyFileSync(join(missing, '.ia/distributions.lock.json'), join(drifted, '.ia/distributions.lock.json'));
  for (const root of [missing, unusable, drifted]) {
    const doctor = await run(['doctor', '--root', root, '--json']);
    expect(doctor.exitCode, doctor.stdout).toBe(0);
    expectMappedAndUnmapped(doctor.stdout, root);
    expectUnreadGeneration(doctor.stdout, root);
  }
  expect(trapped).not.toHaveBeenCalled();
});

it('doctor warns for every provider of a fresh clone whose .ia/registries.json refuses', async () => {
  const fresh = clone(await mappedAndUnmapped(registry(TWO_PROVIDERS)));
  writeFileSync(join(fresh, '.ia/registries.json'), JSON.stringify({ format: 'ia.registries.v0', registries: {} }));
  const trapped = trapFetch();
  const rows = registryRows((await run(['doctor', '--root', fresh, '--json'])).stdout);
  expect(rows.map((row) => [row.id, row.status, row.remedy])).toEqual([
    ['registry-acme', 'warn', null],
    ['registry-beta', 'warn', null],
  ]);
  for (const row of rows)
    expect(row.detail).toBe('IA-DIST-INPUT-INVALID: Invalid .ia/registries.json: format must be ia.registries.v1');
  expect(trapped).not.toHaveBeenCalled();
});

it('doctor names no provider from a lock it cannot read or while an apply is interrupted, and keeps those findings', async () => {
  const dir = registry(TWO_PROVIDERS),
    trapped = trapFetch();
  // As on main, a lock that cannot be read names no provider; the generation row stays `unknown`, installed or not.
  const installed = await mappedAndUnmapped(dir),
    fresh = clone(installed);
  for (const root of [installed, fresh]) {
    writeFileSync(join(root, '.ia/distributions.lock.json'), '{');
    const doctor = await run(['doctor', '--root', root, '--json']);
    expect(doctor.exitCode, doctor.stdout).toBe(0);
    expect(registryRows(doctor.stdout)).toEqual([]);
    expectUnreadGeneration(doctor.stdout, root);
  }
  // Recovery may put the previous lock back, so an interrupted apply's providers wait for it, like its generation row.
  const interrupted = await mappedAndUnmapped(dir);
  writeFileSync(join(interrupted, '.ia/distributions/pending.json'), '{}');
  const doctor = await run(['doctor', '--root', interrupted, '--json']);
  expect(doctor.exitCode, doctor.stdout).toBe(1);
  expect(registryRows(doctor.stdout)).toEqual([]);
  expect(trapped).not.toHaveBeenCalled();
});

// LKI-09: the consumer over a selected closure published through `registry add` dependency-first. The product's guides
// resolve only through its declared language dependency, so it refuses standalone verification, and the only route that
// installs it is registry selection (apps/distribution/SPEC.md, "Public registry selected admission"). The standalone
// catalog and licensed routes keep refusing it until their own caller cutover.
const PRODUCT = 'inventarch/product-structure@0.1.0';
async function published(): Promise<{
  readonly dir: string;
  readonly closure: readonly [SourcedRelease, SourcedRelease];
}> {
  const closure = await sourcedClosure(),
    dir = selectedRegistry(closure);
  fixtures.push(dir);
  return { dir, closure };
}
/** The lock rows the consumer must pin for the closure, in the lock's id order, at `sha256:` or artifact-URL locations. */
const pinned = (closure: readonly SourcedRelease[], location: (archive: string) => string) =>
  [...closure]
    .sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1))
    .map((release) => ({
      id: release.manifest.id,
      version: release.manifest.version,
      archive: release.archiveDigest,
      location: location(release.archiveDigest),
    }));
const lockRows = (envelope: Envelope) =>
  envelope.plan.lock.packages.map(({ id, version, archive, location }) => ({ id, version, archive, location }));
/** A fresh clone: the committed lock alone, plus the cache when `cache` says the clone kept it. */
function clone(root: string, cache = false): string {
  const copy = target();
  mkdirSync(join(copy, '.ia'), { recursive: true });
  copyFileSync(join(root, '.ia/distributions.lock.json'), join(copy, '.ia/distributions.lock.json'));
  if (cache) cpSync(join(root, '.ia/distributions/cache'), join(copy, '.ia/distributions/cache'), { recursive: true });
  return copy;
}

it('installs a selected closure published dependency-first from a directory registry, and replays it unchanged and offline', async () => {
  const { dir, closure } = await published(),
    root = target(),
    trapped = trapFetch();
  const applied = await run(['install', PRODUCT, '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  const result = json<Envelope>(applied.stdout);
  expect(result.applied?.status).toBe('installed');
  expect(lockRows(result)).toEqual(pinned(closure, (archive) => `sha256:${archive}`));
  expect(result.registries).toEqual([{ provider: 'inventarch', base: resolve(dir), level: 'flag' }]);
  for (const release of closure)
    expect(readFileSync(join(root, `.ia/distributions/cache/${release.archiveDigest}.ia.tgz`))).toEqual(release.bytes);

  // Replay: a repeat install plans no change and moves neither the lock nor any installed byte.
  const before = installedState(root);
  const again = await run(['install', PRODUCT, '--root', root, '--registry', dir, '--json']);
  expect(again.exitCode, again.stdout).toBe(0);
  expect(json<Envelope>(again.stdout).plan.changes).toMatchObject({ added: [], updated: [] });
  expect(installedState(root)).toEqual(before);

  // Offline replay: a clone that kept the cache restores and installs the same closure with no registry at all.
  const restored = clone(root, true);
  const offline = await run(['restore', '--root', restored, '--offline', '--apply', '--yes', '--json']);
  expect(offline.exitCode, offline.stdout).toBe(0);
  expect(installedState(restored)).toEqual(installedState(root));
  const cached = clone(root, true);
  rmSync(join(cached, '.ia/distributions.lock.json'));
  const fromCache = await run(['install', PRODUCT, '--root', cached, '--offline', '--apply', '--yes', '--json']);
  expect(fromCache.exitCode, fromCache.stdout).toBe(0);
  expect(lockRows(json<Envelope>(fromCache.stdout))).toEqual(lockRows(result));
  expect(trapped).not.toHaveBeenCalled();
});

it('installs the selected closure from an HTTPS registry and restores a fresh clone byte-identically; a corrupt dependent refuses with no cache effects', async () => {
  const { dir, closure } = await published(),
    root = target(),
    env = { IA_REGISTRY: 'https://registry.test/base' };
  serveDirectory(dir, BASE);
  const applied = await run(['install', PRODUCT, '--root', root, '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(lockRows(json<Envelope>(applied.stdout))).toEqual(
    pinned(closure, (archive) => `${BASE}artifacts/${archive}.ia.tgz`),
  );

  const fresh = clone(root);
  const restored = await run(['restore', '--root', fresh, '--apply', '--yes', '--json'], { env });
  expect(restored.exitCode, restored.stdout).toBe(0);
  expect(installedState(fresh)).toEqual(installedState(root));

  // The dependent's bytes change after the lock pinned them: neither a new install nor a restore caches the language first.
  writeFileSync(join(dir, `artifacts/${closure[1].archiveDigest}.ia.tgz`), 'corrupt');
  for (const argv of [
    ['install', PRODUCT, '--root', target()],
    ['restore', '--root', clone(root)],
  ]) {
    const refused = await run([...argv, '--apply', '--yes', '--json'], { env });
    expect(refused.exitCode, refused.stdout).toBe(3);
    expect(json<Failure>(refused.stdout), argv[0]).toMatchObject({
      code: 'IA-DIST-ARCHIVE-INVALID',
      exit: 3,
      message: 'Archive digest mismatch',
    });
    const at = argv[argv.length - 1]!;
    expect(existsSync(join(at, '.ia/distributions/cache')), argv[0]).toBe(false);
    expect(existsSync(join(at, '.ia/distributions/active.json')), argv[0]).toBe(false);
  }
});

it('refuses index metadata that skews from the published dependent archive before caching any member', async () => {
  const { dir, closure } = await published(),
    root = target();
  editIndex(dir, closure[1].manifest.id, (releases) =>
    releases.map((release) => ({ ...release, manifest: 'f'.repeat(64) })),
  );
  const refused = await run(['install', PRODUCT, '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(refused.exitCode, refused.stdout).toBe(3);
  expect(json<Failure>(refused.stdout).code).toBe('IA-DIST-INTEGRITY-MISMATCH');
  expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
});

it('keeps the standalone catalog and licensed routes refusing the dependent closure the registry route installs', async () => {
  const { dir, closure } = await published(),
    [language, product] = closure;
  // --catalog is the legacy standalone path: each row is admitted alone, so the dependent product refuses its guides.
  const root = target();
  mkdirSync(join(root, '.ia/work'), { recursive: true });
  for (const release of closure) writeFileSync(join(root, `.ia/work/${release.archiveDigest}.ia.tgz`), release.bytes);
  const catalog = [product, language].map((release) => ({
    path: `.ia/work/${release.archiveDigest}.ia.tgz`,
    withdrawn: false,
  }));
  writeFileSync(join(root, '.ia/work/catalog.json'), JSON.stringify(catalog));
  const standalone = await run([
    'install',
    PRODUCT,
    '--root',
    root,
    '--catalog',
    '.ia/work/catalog.json',
    '--apply',
    '--yes',
    '--json',
  ]);
  expect(standalone.exitCode, standalone.stdout).toBe(3);
  expect(json<Failure>(standalone.stdout).code).toBe('IA-DIST-CLOSURE-INVALID');
  expect(existsSync(join(root, '.ia/distributions.lock.json'))).toBe(false);
  expect(existsSync(join(root, `.ia/distributions/cache/${product.archiveDigest}.ia.tgz`))).toBe(false);

  // Licensed acquisition has no public caller: a dependent listed only as licensed refuses by name, and nothing is cached.
  editIndex(dir, product.manifest.id, (releases) =>
    releases.map((release) => {
      const row: Record<string, unknown> = { ...release, access: 'licensed' };
      delete row['artifact'];
      return row;
    }),
  );
  const licensed = target();
  const refused = await run(['install', PRODUCT, '--root', licensed, '--registry', dir, '--apply', '--yes', '--json']);
  expect(refused.exitCode, refused.stdout).toBe(3);
  const failure = json<Failure>(refused.stdout);
  expect(failure.code).toBe('IA-DIST-LICENSE-REQUIRED');
  expect(failure.message).toContain(`${product.manifest.id}@${product.manifest.version}`);
  expect(existsSync(join(licensed, '.ia/distributions/cache'))).toBe(false);
});
