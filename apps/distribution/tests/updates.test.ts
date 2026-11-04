/**
 * Host plugin distribution spec §11 and §7.3: the cached update check and local compatibility. Sources are injected, so no
 * case reaches the npm registry; only the two crowncodes/ia#436 process cases at the end run the built CLI, a stand-in npm and
 * this machine's git.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { HOME_MARKER } from '../src/ia-home.js';
import { runNative } from '../src/native-command.js';
import {
  compareVersions,
  compatibility,
  liveKitSource,
  liveSources,
  newestVersion,
  readIaConfig,
  accountOfferEnabled,
  readUpdateCheck,
  refreshDue,
  refreshUpdates,
  UPDATE_CHECK,
  UPDATE_CHECK_LOCK,
  updateCheckDisabled,
} from '../src/updates.js';
import type { RefreshInput, Sources } from '../src/updates.js';
import { canonicalDistributionJson } from '@inventarch/db/distribution';
import { HomeLockedError } from '../src/home-lock.js';
import { registryAddCollection } from '../src/registry-build.js';
import { buildFixtureRegistry } from './registry-fixture.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-updates-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const unused: Sources = {
  npm: () => {
    throw new Error('npm must not be asked');
  },
  git: () => {
    throw new Error('git must not run');
  },
};

it('refreshes from npm for the npm channel and records a failed source as not checked', async () => {
  const home = join(temp(), '.ia'),
    now = new Date('2026-09-23T12:00:00Z');
  await refreshUpdates(
    { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now },
    { ...unused, npm: () => '0.3.0' },
  );
  expect(readUpdateCheck(home)).toMatchObject({
    schema: 'ia.update-check.v1',
    checkedAt: now.toISOString(),
    cli: { channel: 'npm', current: '0.2.0', latest: '0.3.0', behind: null, checked: true },
    packages: { checked: false },
  });
  await refreshUpdates(
    { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now },
    { ...unused, npm: () => null },
  );
  expect(readUpdateCheck(home)?.cli).toMatchObject({ latest: null, checked: false });
  // The hook keeps nudgedOn in its own plugin data.
  expect(readFileSync(join(home, UPDATE_CHECK), 'utf8')).not.toContain('nudgedOn');
});
it('counts commits behind upstream for a checkout without fetching, and never asks npm', async () => {
  const home = join(temp(), '.ia');
  const seen: string[][] = [];
  await refreshUpdates(
    { home, channel: 'checkout', current: '0.2.0', name: null, checkout: '/src', now: new Date() },
    {
      ...unused,
      git: (cwd, args) => {
        expect(cwd).toBe('/src');
        seen.push([...args]);
        return '4';
      },
    },
  );
  expect(readUpdateCheck(home)?.cli).toMatchObject({ behind: 4, latest: null, checked: true });
  expect(seen.flat()).not.toContain('fetch');
  await refreshUpdates(
    { home, channel: 'checkout', current: '0.2.0', name: null, checkout: '/src', now: new Date() },
    { ...unused, git: () => null },
  );
  expect(readUpdateCheck(home)?.cli).toMatchObject({ behind: null, checked: false });
});
it('an unknown channel has no source: nothing is asked and the check is recorded as not checked', async () => {
  const home = join(temp(), '.ia');
  expect(
    (
      await refreshUpdates(
        { home, channel: 'unknown', current: '0.2.0', name: null, checkout: null, now: new Date() },
        unused,
      )
    ).cli.checked,
  ).toBe(false);
});
it('writes through the IA home, which it creates and marks, and keeps the private account section', async () => {
  const home = join(temp(), '.ia');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, UPDATE_CHECK),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: '2026-09-01T00:00:00Z',
      cli: { channel: 'npm', current: '0.1.0', latest: null, behind: null, checked: false },
      packages: { checked: false },
      account: { notices: ['Your organization supports language 1.0'] },
    }),
  );
  await refreshUpdates(
    { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now: new Date() },
    { ...unused, npm: () => '0.2.0' },
  );
  expect(existsSync(join(home, HOME_MARKER))).toBe(true);
  expect(readUpdateCheck(home)?.account).toEqual({ notices: ['Your organization supports language 1.0'] });
});
it('reads an absent, malformed or foreign cache as none', () => {
  const home = join(temp(), '.ia');
  expect(readUpdateCheck(home)).toBeNull();
  expect(existsSync(home)).toBe(false);
  mkdirSync(join(home, 'state'), { recursive: true });
  for (const text of [
    '{',
    '[]',
    JSON.stringify({ schema: 'other', checkedAt: 'x', cli: {} }),
    JSON.stringify({ schema: 'ia.update-check.v1', checkedAt: 'x', cli: { channel: 1 } }),
    // A timestamp that does not parse would print as "Invalid Date"; the cache is treated as absent instead.
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: 'not a date',
      cli: { channel: 'npm', current: '0.2.0', latest: '0.3.0', behind: null, checked: true },
      packages: { checked: false },
    }),
  ]) {
    writeFileSync(join(home, UPDATE_CHECK), text);
    expect(readUpdateCheck(home), text).toBeNull();
  }
});
it('is due after 24 hours and disabled by IA_NO_UPDATE_CHECK, CI or the IA home config', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  expect(refreshDue(null, now)).toBe(true);
  expect(refreshDue({ checkedAt: '2026-09-23T00:00:00Z' }, now)).toBe(false);
  expect(refreshDue({ checkedAt: '2026-09-22T11:00:00Z' }, now)).toBe(true);
  expect(refreshDue({ checkedAt: 'yesterday' }, now)).toBe(true);
  expect(refreshDue({ checkedAt: '2026-09-25T00:00:00Z' }, now)).toBe(true);
  expect(updateCheckDisabled({ IA_NO_UPDATE_CHECK: '1' }, null)).toBe(true);
  expect(updateCheckDisabled({ IA_NO_UPDATE_CHECK: '0' }, null)).toBe(false);
  expect(updateCheckDisabled({ CI: 'true' }, null)).toBe(true);
  expect(updateCheckDisabled({ CI: '' }, null)).toBe(false);
  expect(updateCheckDisabled({}, { updateCheck: false })).toBe(true);
  expect(updateCheckDisabled({}, null)).toBe(false);
  const home = join(temp(), '.ia');
  expect(readIaConfig(home)).toBeNull();
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ updateCheck: false }));
  expect(readIaConfig(home)).toEqual({ updateCheck: false });
  expect(accountOfferEnabled(readIaConfig(home))).toBe(true);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ accountOffer: false, other: 1 }));
  expect(readIaConfig(home)).toEqual({ accountOffer: false });
  expect(accountOfferEnabled(readIaConfig(home))).toBe(false);
  expect(accountOfferEnabled(null)).toBe(true);
  writeFileSync(join(home, 'config.json'), '{');
  expect(readIaConfig(home)).toBeNull();
});
it('never hands npm a name outside its grammar', () => {
  expect(liveSources.npm('@inventarch/cli & calc')).toBeNull();
  expect(liveSources.npm('')).toBeNull();
});
it('orders versions the way semver does', () => {
  expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0);
  expect(compareVersions('0.3.0', '0.3.0-rc.9')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0-rc.2', '0.3.0-rc.1')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0-rc.10', '0.3.0-rc.9')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBeLessThan(0);
  expect(compareVersions('0.3.0-rc', '0.3.0-rc.1')).toBeLessThan(0);
  expect(compareVersions('0.3.0-1', '0.3.0-rc')).toBeLessThan(0);
  expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0+build.7', '0.3.0')).toBe(0);
  expect(compareVersions('1.0', '1.0.0')).toBe(0);
});
it('compares the workspace language with what this ia reads', () => {
  expect(compatibility(['1.0'], ['1.0'])).toEqual({
    status: 'ok',
    detail: 'Workspace language 1.0; this ia reads 1.0',
  });
  expect(compatibility(['2.0'], ['1.0'])).toEqual({
    status: 'fail',
    detail: 'Workspace language 2.0; this ia reads 1.0; 2.0 is newer than this ia can read',
  });
  expect(compatibility(['0.9'], ['1.0'])).toEqual({
    status: 'warn',
    detail: 'Workspace language 0.9; this ia reads 1.0; 0.9 is no longer read by this ia',
  });
  expect(compatibility(['1.10'], ['1.0', '1.9']).status).toBe('fail');
  expect(compatibility(['1.0'])).toMatchObject({ status: 'ok' });
});
it('refresh-updates is the one mechanism command without a workspace, and validates its flags', async () => {
  const home = join(temp(), '.ia');
  const result = await runNative(['refresh-updates', '--home', home, '--channel', 'unknown', '--current', '0.2.0']);
  expect(result).toMatchObject({
    exitCode: 0,
    result: { schema: 'ia.update-check.v1', cli: { channel: 'unknown', current: '0.2.0', checked: false } },
  });
  expect(readUpdateCheck(home)?.cli.channel).toBe('unknown');
  for (const argv of [
    ['refresh-updates', '--home', 'relative', '--channel', 'npm', '--current', '0.2.0'],
    ['refresh-updates', '--home', home, '--channel', 'brew', '--current', '0.2.0'],
    ['refresh-updates', '--home', home, '--channel', 'npm'],
    ['refresh-updates', '--home', home, '--channel', 'npm', '--current', '0.2.0', '--root', home],
    ['refresh-updates', '--home', home, '--channel', 'checkout', '--current', '0.2.0', '--checkout', 'relative'],
  ])
    await expect(runNative(argv), argv.join(' ')).rejects.toMatchObject({ code: 'IA-DIST-INPUT-INVALID' });
});

// §11 kit entries: one per (registry, kind, id) key of a workspace's installed units, merged under the store lock.
const HEX = (c: string): string => c.repeat(64);
/**
 * A workspace whose lock requests one release per id (each `acme/<name>` at `1.0.0`) and maps the `acme` provider to
 * `registry` (a directory name inside it) in `.ia/registries.json`.
 */
function kitWorkspace(ids: readonly string[], registry = 'vendor/registry'): string {
  const root = temp();
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
  writeFileSync(
    join(root, '.ia', 'registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: registry } }),
  );
  const sorted = [...ids].sort();
  const packages = sorted.map((id, n) => ({
    id,
    version: '1.0.0',
    archive: HEX('abcdef'[n]!),
    manifest: HEX('f'),
    location: `sha256:${HEX('abcdef'[n]!)}`,
    dependencies: [],
  }));
  writeFileSync(
    join(root, '.ia', 'distributions.lock.json'),
    canonicalDistributionJson({
      formatVersion: 1,
      engine: '^0.1.0',
      requests: sorted.map((id) => ({ id, range: '1.0.0' })),
      packages,
    }),
  );
  return realpathSync(root);
}
/** A kit source that answers from `versions` (null for an id it lacks) and records every key it is asked. */
function recording(versions: Readonly<Record<string, string | null>>, fail: readonly string[] = []) {
  const asked: { kind: string; id: string; registry: string }[] = [];
  const sources: Sources = {
    ...unused,
    kit: async (unit) => {
      asked.push({ kind: unit.kind, id: unit.id, registry: unit.registry });
      if (fail.includes(unit.id)) throw new Error('registry down');
      return versions[unit.id] ?? null;
    },
  };
  return { sources, asked };
}
const refresh = (home: string, root: string | undefined, sources: Sources, extra: Partial<RefreshInput> = {}) =>
  refreshUpdates(
    {
      home,
      channel: 'unknown',
      current: '0.2.0',
      name: null,
      checkout: null,
      now: new Date('2026-11-03T12:00:00Z'),
      env: {},
      ...(root === undefined ? {} : { root }),
      ...extra,
    },
    sources,
  );
const entriesOf = (home: string) =>
  (readUpdateCheck(home)?.packages.entries ?? []).map((entry) => `${entry.kind} ${entry.id} ${entry.latest}`).sort();
function seed(home: string, entries: readonly object[]): void {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, UPDATE_CHECK),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: '2026-11-03T00:00:00Z',
      cli: { channel: 'unknown', current: '0.2.0', latest: null, behind: null, checked: false },
      packages: { checked: true, entries },
    }),
  );
}

it('reads the old packages form', () => {
  const home = join(temp(), '.ia');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, UPDATE_CHECK),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: '2026-11-03T00:00:00Z',
      cli: { channel: 'npm', current: '0.2.0', latest: null, behind: null, checked: false },
      packages: { checked: false },
    }),
  );
  expect(readUpdateCheck(home)?.packages).toEqual({ checked: false });
  // An entry that cannot be read is dropped; the rest stay.
  seed(home, [
    { registry: 'npm', kind: 'package', id: '@acme/kits', latest: '1.2.0', checkedAt: '2026-11-03T00:00:00Z' },
    { registry: 'npm', kind: 'nope', id: 'x', latest: null, checkedAt: '2026-11-03T00:00:00Z' },
  ]);
  expect(entriesOf(home)).toEqual(['package @acme/kits 1.2.0']);
});
it('merges entries across refreshes and keeps other workspaces’ keys', async () => {
  const home = join(temp(), '.ia');
  await refresh(home, kitWorkspace(['acme/a']), recording({ 'acme/a': '1.1.0' }).sources);
  await refresh(home, kitWorkspace(['acme/b']), recording({ 'acme/b': '2.0.0' }).sources);
  expect(entriesOf(home)).toEqual(['release acme/a 1.1.0', 'release acme/b 2.0.0']);
  expect(readUpdateCheck(home)?.packages.checked).toBe(true);
});
it('two registries for one kit id keep two entries', async () => {
  const home = join(temp(), '.ia');
  const first = recording({ 'acme/x': '1.1.0' }),
    second = recording({ 'acme/x': '1.2.0' });
  await refresh(home, kitWorkspace(['acme/x'], 'vendor/one'), first.sources);
  await refresh(home, kitWorkspace(['acme/x'], 'vendor/two'), second.sources);
  expect(first.asked[0]!.registry).not.toBe(second.asked[0]!.registry);
  expect(readUpdateCheck(home)?.packages.entries?.map((entry) => entry.registry)).toEqual([
    first.asked[0]!.registry,
    second.asked[0]!.registry,
  ]);
});
it('one stale key refetches only that key, and without force a fresh key is not fetched', async () => {
  const home = join(temp(), '.ia'),
    root = kitWorkspace(['acme/a', 'acme/b']);
  const first = recording({ 'acme/a': '1.0.0', 'acme/b': '1.0.0' });
  await refresh(home, root, first.sources);
  const [a, b] = readUpdateCheck(home)!.packages.entries!;
  seed(home, [a!, { ...b!, checkedAt: '2026-11-01T00:00:00Z' }]);
  const second = recording({ 'acme/a': '9.0.0', 'acme/b': '1.1.0' });
  await refresh(home, root, second.sources);
  expect(second.asked.map((unit) => unit.id)).toEqual(['acme/b']);
  expect(entriesOf(home)).toEqual(['release acme/a 1.0.0', 'release acme/b 1.1.0']);
});
it('a registry failure records latest null for that key only', async () => {
  const home = join(temp(), '.ia');
  await refresh(
    home,
    kitWorkspace(['acme/a', 'acme/b']),
    recording({ 'acme/a': '1.1.0', 'acme/b': '2.0.0' }, ['acme/b']).sources,
  );
  expect(entriesOf(home)).toEqual(['release acme/a 1.1.0', 'release acme/b null']);
});
it('the newest non-withdrawn version wins even when the index lists it last or withdrawn first', () => {
  expect(
    newestVersion([
      { version: '3.0.0', withdrawn: true },
      { version: '1.0.0', withdrawn: false },
      { version: '1.10.0', withdrawn: false },
      { version: '1.9.0', withdrawn: false },
    ]),
  ).toBe('1.10.0');
  expect(newestVersion([{ version: '1.0.0', withdrawn: true }])).toBeNull();
});
it('a package is asked of npm, a collection of the kit index, a release of the release index', async () => {
  const { dir } = await buildFixtureRegistry([
    { id: 'acme/rel', version: '1.2.0' },
    { id: 'acme/rel', version: '1.0.0' },
  ]);
  made.push(dir);
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/kit',
    releases: ['3.0.0', '1.0.0'].map((version) => ({
      version,
      withdrawn: false,
      distributions: [{ id: 'acme/rel', range: '^1.0.0' }],
    })),
  });
  const npm: string[] = [];
  const kit = liveKitSource({
    npm: (name) => {
      npm.push(name);
      return '4.0.0';
    },
  });
  expect(await kit({ registry: 'npm', kind: 'package', id: '@acme/kits' })).toBe('4.0.0');
  expect(npm).toEqual(['@acme/kits']);
  expect(await kit({ registry: dir, kind: 'collection', id: 'acme/kit' })).toBe('3.0.0');
  expect(await kit({ registry: dir, kind: 'release', id: 'acme/rel' })).toBe('1.2.0');
  // Each kind is asked of its own index: a release id has no kit index, and a kit id no release index.
  expect(await kit({ registry: dir, kind: 'collection', id: 'acme/rel' })).toBeNull();
  expect(await kit({ registry: dir, kind: 'release', id: 'acme/kit' })).toBeNull();
  expect(npm).toEqual(['@acme/kits']);
});
it('an entry older than 30 days is dropped', async () => {
  const home = join(temp(), '.ia');
  seed(home, [
    { registry: 'npm', kind: 'package', id: '@acme/old', latest: '1.0.0', checkedAt: '2026-09-01T00:00:00Z' },
  ]);
  await refresh(home, kitWorkspace(['acme/a']), recording({ 'acme/a': '1.0.0' }).sources);
  expect(entriesOf(home)).toEqual(['release acme/a 1.0.0']);
});
it('force refetches a fresh key and its cached latest changes', async () => {
  const home = join(temp(), '.ia'),
    root = kitWorkspace(['acme/a', 'acme/b']);
  await refresh(home, root, recording({ 'acme/a': '1.0.0', 'acme/b': '1.0.0' }).sources);
  const fresh = recording({ 'acme/a': '1.1.0', 'acme/b': '1.0.0' });
  await refresh(home, root, fresh.sources);
  expect(fresh.asked).toEqual([]);
  const forced = recording({ 'acme/a': '1.1.0', 'acme/b': '1.0.0' });
  // An explicit check made a minute later.
  await refresh(home, root, forced.sources, { force: true, now: new Date('2026-11-03T12:01:00Z') });
  expect(forced.asked.map((unit) => unit.id)).toEqual(['acme/a', 'acme/b']);
  expect(entriesOf(home)).toEqual(['release acme/a 1.1.0', 'release acme/b 1.0.0']);
  await expect(refresh(home, undefined, forced.sources, { force: true })).rejects.toMatchObject({
    code: 'IA-DIST-INPUT-INVALID',
  });
});
it('interleaved refreshes from two workspaces keep both', async () => {
  const home = join(temp(), '.ia');
  const later = new Date('2026-11-03T12:01:00Z');
  await refresh(home, kitWorkspace(['acme/a']), recording({ 'acme/a': '1.1.0' }).sources, {
    // B runs to completion between A's lookups and A's write.
    afterFetch: async () => {
      await refresh(home, kitWorkspace(['acme/b']), recording({ 'acme/b': '2.0.0' }).sources, {
        now: later,
        current: '0.3.0',
      });
    },
  });
  expect(entriesOf(home)).toEqual(['release acme/a 1.1.0', 'release acme/b 2.0.0']);
  // The newer run's CLI fields stand.
  expect(readUpdateCheck(home)).toMatchObject({ checkedAt: later.toISOString(), cli: { current: '0.3.0' } });
});
it('a held store lock leaves the file untouched', async () => {
  const home = join(temp(), '.ia');
  seed(home, []);
  const before = readFileSync(join(home, UPDATE_CHECK), 'utf8');
  writeFileSync(
    join(home, UPDATE_CHECK_LOCK),
    JSON.stringify({
      token: 'held',
      pid: process.pid,
      start: null,
      host: hostname(),
      createdAt: new Date().toISOString(),
    }),
  );
  await expect(
    refresh(home, kitWorkspace(['acme/a']), recording({ 'acme/a': '1.1.0' }).sources, { lockWaitMs: 100 }),
  ).rejects.toBeInstanceOf(HomeLockedError);
  expect(readFileSync(join(home, UPDATE_CHECK), 'utf8')).toBe(before);
  expect(existsSync(join(home, UPDATE_CHECK_LOCK))).toBe(true);
});
it('refresh-updates --root rejects a relative path, --force without --root is rejected, and the cache exists when runNative resolves', async () => {
  const home = join(temp(), '.ia'),
    root = kitWorkspace([]);
  const base = ['refresh-updates', '--home', home, '--channel', 'unknown', '--current', '0.2.0'];
  for (const argv of [
    [...base, '--root', 'relative'],
    [...base, '--force'],
  ])
    await expect(runNative(argv), argv.join(' ')).rejects.toMatchObject({ code: 'IA-DIST-INPUT-INVALID' });
  expect(await runNative([...base, '--root', root, '--force'])).toMatchObject({ exitCode: 0 });
  expect(existsSync(join(home, UPDATE_CHECK))).toBe(true);
});

it('IA_NO_UPDATE_CHECK=1 stops every lookup, forced or not, and writes nothing', async () => {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    fetched.push(String(input));
    return new Response('no', { status: 404 });
  });
  try {
    const home = join(temp(), '.ia'),
      root = kitWorkspace(['acme/a']);
    const throwing: Sources = {
      npm: () => {
        throw new Error('npm must not be asked');
      },
      git: () => {
        throw new Error('git must not run');
      },
      kit: async () => {
        throw new Error('no kit source may be asked');
      },
    };
    const offline = { IA_NO_UPDATE_CHECK: '1' };
    await refreshUpdates(
      {
        home,
        channel: 'npm',
        current: '0.2.0',
        name: '@inventarch/cli',
        checkout: null,
        now: new Date(),
        root,
        force: true,
        env: offline,
      },
      throwing,
    );
    // The live kit source, which opens the workspace's registry over fetch, is not reached either.
    await refreshUpdates(
      {
        home,
        channel: 'unknown',
        current: '0.2.0',
        name: null,
        checkout: null,
        now: new Date(),
        root,
        force: true,
        env: offline,
      },
      { npm: throwing.npm, git: throwing.git },
    );
    expect(fetched).toEqual([]);
    expect(existsSync(join(home, UPDATE_CHECK))).toBe(false);
    // The command line reads the process environment.
    vi.stubEnv('IA_NO_UPDATE_CHECK', '1');
    const result = await runNative([
      'refresh-updates',
      '--home',
      home,
      '--channel',
      'unknown',
      '--current',
      '0.2.0',
      '--root',
      root,
      '--force',
    ]);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(fetched).toEqual([]);
    expect(existsSync(join(home, UPDATE_CHECK))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('IA_NO_UPDATE_CHECK=1 still counts a checkout against its upstream, which needs no network', async () => {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    fetched.push(String(input));
    return new Response('no', { status: 404 });
  });
  try {
    const home = join(temp(), '.ia'),
      root = kitWorkspace(['acme/a']);
    const counted: string[][] = [];
    const check = await refreshUpdates(
      {
        home,
        channel: 'checkout',
        current: '0.2.0',
        name: null,
        checkout: '/src',
        now: new Date(),
        root,
        force: true,
        env: { IA_NO_UPDATE_CHECK: '1' },
      },
      {
        npm: () => {
          throw new Error('npm must not be asked');
        },
        git: (_cwd, args) => {
          counted.push([...args]);
          return '3';
        },
        kit: async () => {
          throw new Error('no kit source may be asked');
        },
      },
    );
    expect(counted).toEqual([['rev-list', '--count', 'HEAD..@{upstream}']]);
    expect(check.cli).toMatchObject({ channel: 'checkout', behind: 3, checked: true });
    expect(readUpdateCheck(home)?.cli).toMatchObject({ behind: 3, checked: true });
    expect(readUpdateCheck(home)?.packages.entries).toBeUndefined();
    expect(fetched).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

// crowncodes/ia#436: refresh-updates run by hand from a directory the repository controls never starts an npm or git planted there,
// through a relative or empty PATH entry or, on Windows, the search of the working directory. The built CLI runs from
// such a directory, so `pnpm --filter @inventarch/distribution build` first.
const CLI = join(import.meta.dirname, '../dist/cli.js');
const windows = process.platform === 'win32';
// Above the CLI run's own 60 s bound plus the git setup, so the subprocess bound, not the 30 s case default, decides.
const PROCESS_CASE = 120_000;
// A `name` the repository plants in `dir`, recording that it ran: a .cmd on Windows, which only cmd.exe runs, beside a
// `name`.exe copied from hostname.exe, which a lookup without a shell would start.
function plant(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, `${name}-ran.txt`);
  if (windows) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo planted> "%~dp0${name}-ran.txt"\r\n`);
    copyFileSync(
      join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'hostname.exe'),
      join(dir, `${name}.exe`),
    );
  } else {
    writeFileSync(join(dir, name), `#!/bin/sh\necho planted > '${marker}'\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return marker;
}
// The program on a qualified entry: it records its working directory and PATH, then prints `answer`.
function legit(dir: string, name: string, answer: string): string {
  const log = join(dir, `${name}.log`);
  if (windows)
    writeFileSync(join(dir, `${name}.cmd`), `@(echo %CD%& echo %PATH%)>> "%~dp0${name}.log"\r\n@echo ${answer}\r\n`);
  else {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$PATH"; } >> '${log}'\nprintf '%s\\n' '${answer}'\n`,
    );
    chmodSync(join(dir, name), 0o755);
  }
  return log;
}
function lookupEnv(path: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!['path', 'nodefaultcurrentdirectoryinexepath'].includes(key.toLowerCase())) env[key] = value;
  return { ...env, PATH: path.join(delimiter) };
}
const seenFrom = (log: string) =>
  readFileSync(log, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim());
const home = windows ? homedir().toLowerCase() : realpathSync(homedir());

it(
  'refresh-updates run by hand never starts an npm planted in the working directory; the qualified npm answers from home (crowncodes/ia#436)',
  async () => {
    const project = temp(),
      bin = temp(),
      iaHome = join(temp(), '.ia');
    const markers = [plant(project, 'npm'), plant(join(project, 'bin'), 'npm')];
    // npm on Windows is npm.cmd, so the qualified one is a script there too.
    const log = legit(bin, 'npm', '"9.9.9"');
    const result = await runBounded(
      process.execPath,
      [CLI, 'refresh-updates', '--home', iaHome, '--channel', 'npm', '--current', '0.2.0', '--name', '@inventarch/cli'],
      { cwd: project, env: lookupEnv(['bin', '', bin]), timeoutMs: 60_000 },
    );
    expect(markers.filter((marker) => existsSync(marker))).toEqual([]);
    expect(result.status, result.stderr).toBe(0);
    expect(readUpdateCheck(iaHome)?.cli).toMatchObject({ latest: '9.9.9', checked: true });
    const [cwd, path] = seenFrom(log);
    expect([windows ? cwd!.toLowerCase() : cwd, path]).toEqual([home, bin]);
  },
  PROCESS_CASE,
);

// This machine's own git, found on this process's PATH, to stand on a qualified entry of the command's PATH.
function realGit(): string {
  for (const dir of (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => entry.replace(/"/g, ''))
    .filter((entry) => isAbsolute(entry))) {
    const file = join(dir, windows ? 'git.exe' : 'git');
    if (existsSync(file)) return file;
  }
  throw new Error("no git on this machine's PATH");
}
async function git(args: readonly string[]): Promise<void> {
  const result = await runBounded(
    realGit(),
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { timeoutMs: 30_000 },
  );
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
}

it(
  'refresh-updates run by hand never starts a git planted in the working directory; the qualified git counts the checkout (crowncodes/ia#436)',
  async () => {
    const project = temp(),
      upstream = temp(),
      checkout = join(temp(), 'clone'),
      iaHome = join(temp(), '.ia');
    // A checkout two commits behind its upstream as of its last fetch.
    await git(['-C', upstream, 'init', '-q']);
    await git(['-C', upstream, 'commit', '-q', '--no-verify', '--allow-empty', '-m', '1']);
    await git(['clone', '-q', upstream, checkout]);
    for (const message of ['2', '3'])
      await git(['-C', upstream, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
    await git(['-C', checkout, 'fetch', '-q']);
    const markers = [plant(project, 'git'), plant(join(project, 'bin'), 'git')];
    const result = await runBounded(
      process.execPath,
      [CLI, 'refresh-updates', '--home', iaHome, '--channel', 'checkout', '--current', '0.2.0', '--checkout', checkout],
      { cwd: project, env: lookupEnv(['bin', '', dirname(realGit())]), timeoutMs: 60_000 },
    );
    expect(markers.filter((marker) => existsSync(marker))).toEqual([]);
    expect(result.status, result.stderr).toBe(0);
    expect(readUpdateCheck(iaHome)?.cli).toMatchObject({ behind: 2, checked: true });
  },
  PROCESS_CASE,
);

it('a cache stamped in the future (a clock stepped back) is replaced by the next refresh, forced or not', async () => {
  for (const force of [false, true]) {
    const home = join(temp(), '.ia'),
      root = kitWorkspace(['acme/a']),
      now = new Date();
    await refresh(home, root, recording({ 'acme/a': '1.0.0' }).sources, { now });
    // The clock then steps back a year: every stamp the cache holds lies in the future.
    const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      stored = readUpdateCheck(home)!;
    writeFileSync(
      join(home, UPDATE_CHECK),
      JSON.stringify({
        ...stored,
        checkedAt: future,
        packages: {
          checked: true,
          entries: [
            ...stored.packages.entries!.map((entry) => ({ ...entry, checkedAt: future })),
            { registry: 'npm', kind: 'package', id: '@acme/gone', latest: '9.0.0', checkedAt: future },
          ],
        },
      }),
    );
    const next = recording({ 'acme/a': '1.1.0' });
    const check = await refresh(home, root, next.sources, { now, force });
    expect(
      next.asked.map((unit) => unit.id),
      `force ${force}`,
    ).toEqual(['acme/a']);
    expect(check.checkedAt, `force ${force}`).toBe(now.toISOString());
    expect(refreshDue(check, now), `force ${force}`).toBe(false);
    expect(entriesOf(home), `force ${force}`).toEqual(['release acme/a 1.1.0']);
  }
});
