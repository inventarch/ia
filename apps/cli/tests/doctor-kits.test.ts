/**
 * host-plugin-distribution §7.3 and §11: doctor's kit rows and the refresh it schedules, read from the per-registry
 * update cache and local configuration only.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonicalDistributionJson } from '@inventarch/db/distribution';
import type { Channel } from '../src/channel.js';
import { KIT_COLLECTIONS, serializeKitCollections } from '@inventarch/distribution/kit-collections';
import { readUpdateCheck, refreshUpdates } from '@inventarch/distribution/updates';
import { userRows } from '../src/doctor-user.js';
import { MARKETPLACE_RECORD, readMarketplaceRecord, writeMarketplaceRecord } from '../src/marketplace-record.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const NOW = new Date('2026-11-03T12:00:00Z');
const VERSION = '3.5.1';
const CHANNEL: Channel = { kind: 'npm', name: '@inventarch/cli', version: VERSION };
const HEX = (c: string): string => c.repeat(64);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** A workspace whose lock requests `acme/<id>` releases at 1.0.0 and maps `acme` to `vendor/registry`. */
function workspace(ids: readonly string[]): { readonly root: string; readonly registry: string } {
  const root = realpathSync(scratch('doctor-kits'));
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  put(
    join(root, '.ia/registries.json'),
    JSON.stringify({ format: 'ia.registries.v1', registries: { acme: 'vendor/registry' } }),
  );
  const sorted = [...ids].sort();
  if (sorted.length > 0)
    put(
      join(root, '.ia/distributions.lock.json'),
      canonicalDistributionJson({
        formatVersion: 1,
        engine: '^0.1.0',
        requests: sorted.map((id) => ({ id, range: '1.0.0' })),
        packages: sorted.map((id, n) => ({
          id,
          version: '1.0.0',
          archive: HEX('abcdef'[n]!),
          manifest: HEX('f'),
          location: `sha256:${HEX('abcdef'[n]!)}`,
          dependencies: [],
        })),
      }),
    );
  return { root, registry: join(root, 'vendor/registry') };
}
/** An IA home whose cache was refreshed at `checkedAt` for this ia, holding `entries`. */
function home(entries: readonly Record<string, unknown>[], checkedAt = NOW.toISOString()): string {
  const at = resolve(scratch('doctor-kits-home'), '.ia');
  put(
    join(at, 'state/update-check.json'),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt,
      cli: { channel: 'npm', current: VERSION, latest: null, behind: null, checked: true },
      packages: { checked: entries.length > 0, entries },
    }),
  );
  return at;
}
const facts = (iaHome: string, root: string | undefined, env: Record<string, string> = {}) =>
  userRows({
    env: { IA_HOME: iaHome, ...env },
    home: scratch('doctor-kits-user'),
    packageRoot: scratch('doctor-kits-package'),
    version: VERSION,
    directory: root ?? scratch('doctor-kits-cwd'),
    supplied: root,
    root,
    enclosing: undefined,
    now: NOW,
    channel: CHANNEL,
  }).facts;
const entry = (registry: string, id: string, latest: string | null, checkedAt = NOW.toISOString()) => ({
  registry,
  kind: 'release',
  id,
  latest,
  checkedAt,
});

it('scheduled refresh is null when the global stamp and every kit key are fresh', () => {
  const { root, registry } = workspace(['acme/a']);
  expect(facts(home([entry(registry, 'acme/a', '1.0.0')]), root).refresh).toBeNull();
});
it('scheduled refresh is not null when the global stamp is fresh but a kit key is missing', () => {
  const { root } = workspace(['acme/a']);
  expect(facts(home([]), root).refresh).not.toBeNull();
  // Or older than a day.
  const { root: stale, registry } = workspace(['acme/a']);
  expect(facts(home([entry(registry, 'acme/a', '1.0.0', '2026-11-01T00:00:00Z')]), stale).refresh).not.toBeNull();
});
it('refreshNow is non-null on a fresh cache and carries --force', () => {
  const { root, registry } = workspace(['acme/a']);
  const now = facts(home([entry(registry, 'acme/a', '1.0.0')]), root);
  expect(now.refresh).toBeNull();
  expect(now.refreshNow).toEqual(expect.arrayContaining(['refresh-updates', '--root', root, '--force']));
  expect(now.refreshNowWhy).toBeNull();
});
it('refreshNow is non-null with updateCheck false in config', () => {
  const { root } = workspace(['acme/a']);
  const at = home([]);
  put(join(at, 'config.json'), JSON.stringify({ updateCheck: false }));
  const read = facts(at, root);
  expect(read.refresh).toBeNull();
  expect(read.refreshNow).not.toBeNull();
});
it('refreshNow is null with IA_NO_UPDATE_CHECK=1 and says why', () => {
  const { root } = workspace(['acme/a']);
  const read = facts(home([]), root, { IA_NO_UPDATE_CHECK: '1' });
  expect(read.refreshNow).toBeNull();
  expect(read.refreshNowWhy).toContain('IA_NO_UPDATE_CHECK=1');
  // CI does not block it.
  expect(facts(home([]), root, { CI: 'true' }).refreshNow).not.toBeNull();
});
it('the refresh argv carries --root for a workspace and not without one', () => {
  const { root } = workspace(['acme/a']);
  const at = home([], '2026-11-01T00:00:00Z');
  const rooted = facts(at, root).refresh!;
  expect(rooted.slice(rooted.indexOf('--root'), rooted.indexOf('--root') + 2)).toEqual(['--root', root]);
  expect(rooted).not.toContain('--force');
  const bare = facts(at, undefined);
  expect(bare.refresh).not.toContain('--root');
  expect(bare.refreshNow).not.toContain('--force');
});

// §7.3 rows. A workspace with a package entry, an intact collection and a plain release, each a unit.
const PACKAGE_ENTRY = {
  kind: 'package',
  name: '@acme/kits',
  version: '1.0.0',
  integrity: `sha512-${'A'.repeat(86)}==`,
  kits: [{ id: 'acme/kit-one', version: '1.0.0', archive: HEX('e'), manifest: HEX('f'), dependencies: [] }],
};
const locked = (id: string, archive: string) => ({
  id,
  version: '1.0.0',
  archive: HEX(archive),
  manifest: HEX('f'),
  location: `sha256:${HEX(archive)}`,
  dependencies: [],
});
function mixed(): { readonly root: string; readonly registry: string } {
  const { root, registry } = workspace([]);
  const lock = canonicalDistributionJson({
    formatVersion: 1,
    engine: '^0.1.2',
    requests: [
      { id: 'acme/rel', range: '1.0.0' },
      { id: 'acme/x', range: '1.0.0' },
    ],
    packages: [locked('acme/rel', 'a'), locked('acme/x', 'b')],
    entries: [PACKAGE_ENTRY],
  });
  put(join(root, '.ia/distributions.lock.json'), lock);
  put(
    join(root, KIT_COLLECTIONS),
    serializeKitCollections({
      format: 'ia-kit-collections',
      formatVersion: 1,
      lock: createHash('sha256').update(lock).digest('hex'),
      collections: [
        {
          id: 'acme/kit',
          version: '1.0.0',
          registry,
          members: [{ id: 'acme/x', version: '1.0.0', archive: HEX('b') }],
        },
      ],
      unknown: [],
    }),
  );
  return { root, registry };
}
const rows = (iaHome: string, root: string, env: Record<string, string> = {}) =>
  userRows({
    env: { IA_HOME: iaHome, ...env },
    home: scratch('doctor-kits-user'),
    packageRoot: scratch('doctor-kits-package'),
    version: VERSION,
    directory: root,
    supplied: root,
    root,
    enclosing: undefined,
    now: NOW,
    channel: CHANNEL,
  }).checks;
const kitsOf = (checks: ReturnType<typeof rows>) => checks.filter((check) => check.id.startsWith('kit'));
const pkg = (latest: string | null, checkedAt = NOW.toISOString()) => ({
  registry: 'npm',
  kind: 'package',
  id: '@acme/kits',
  latest,
  checkedAt,
});
const coll = (registry: string, latest: string | null) => ({
  ...entry(registry, 'acme/kit', latest),
  kind: 'collection',
});

it('kits info when none installed', () => {
  const { root } = workspace([]);
  expect(kitsOf(rows(home([]), root))).toEqual([
    expect.objectContaining({ id: 'kits', status: 'info', detail: 'no kits installed', remedy: null, fix: null }),
  ]);
});
it("kits ok when every unit's key is current, and it states the oldest check time", () => {
  const { root, registry } = mixed();
  const at = home([
    pkg('1.0.0', '2026-11-03T09:30:00Z'),
    coll(registry, '1.0.0'),
    entry(registry, 'acme/rel', '0.9.0', '2026-11-02T08:15:00Z'),
  ]);
  expect(kitsOf(rows(at, root))).toEqual([
    expect.objectContaining({
      id: 'kits',
      status: 'ok',
      detail: '3 kits, all current · checked 2026-11-02 08:15 UTC',
      fix: null,
    }),
  ]);
});
it('warn and one kit-update row per unit behind, with the fix for its source', () => {
  const { root, registry } = mixed();
  const checks = kitsOf(
    rows(home([pkg('1.2.0'), coll(registry, '2.0.0'), entry(registry, 'acme/rel', '1.1.0')]), root),
  );
  expect(checks[0]).toMatchObject({
    id: 'kits',
    status: 'warn',
    detail: expect.stringMatching(/^3 of 3 kits have updates · checked /),
  });
  const fixes = Object.fromEntries(checks.slice(1).map((check) => [check.id, [check.detail, check.remedy, check.fix]]));
  expect(fixes).toEqual({
    'kit-update:@acme/kits': [
      '@acme/kits 1.0.0 → 1.2.0 (package)',
      'ia install --package @acme/kits@1.2.0',
      { program: 'ia', argv: ['install', '--package', '@acme/kits@1.2.0'], flow: 'preview-apply', writesTo: 'repo' },
    ],
    'kit-update:acme/kit': [
      'acme/kit 1.0.0 → 2.0.0 (collection)',
      'ia install acme/kit@2.0.0',
      { program: 'ia', argv: ['install', 'acme/kit@2.0.0'], flow: 'preview-apply', writesTo: 'repo' },
    ],
    'kit-update:acme/rel': [
      'acme/rel 1.0.0 → 1.1.0 (release)',
      // The remedy keeps the update command's own form; only the fix names the version, so the pin moves.
      'ia update acme/rel',
      { program: 'ia', argv: ['update', 'acme/rel', '--to', '1.1.0'], flow: 'preview-apply', writesTo: 'repo' },
    ],
  });
});
it('an unknown collection identity is warn with a reinstall fix', () => {
  const { root } = workspace(['acme/x']);
  const lock = readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8');
  put(
    join(root, KIT_COLLECTIONS),
    serializeKitCollections({
      format: 'ia-kit-collections',
      formatVersion: 1,
      lock: createHash('sha256').update(lock).digest('hex'),
      collections: [],
      unknown: [{ id: 'acme/kit', members: ['acme/x'] }],
    }),
  );
  expect(kitsOf(rows(home([]), root))[0]).toMatchObject({
    id: 'kits',
    status: 'warn',
    detail: expect.stringMatching(/^collection identity unknown: acme\/kit/),
    remedy: 'ia install acme/kit',
    fix: { program: 'ia', argv: ['install', 'acme/kit'], flow: 'preview-apply', writesTo: 'repo' },
  });
});
it('a committed record whose unknown id is an option offers no fix that passes it', () => {
  const { root } = workspace(['acme/x']);
  const lock = readFileSync(join(root, '.ia/distributions.lock.json'), 'utf8');
  put(
    join(root, KIT_COLLECTIONS),
    JSON.stringify({
      format: 'ia-kit-collections-1',
      lock: createHash('sha256').update(lock).digest('hex'),
      collections: [],
      unknown: [{ id: '--root=/other', members: ['acme/x'] }],
    }),
  );
  const kits = kitsOf(rows(home([]), root));
  expect(JSON.stringify(kits)).not.toContain('--root=/other');
});
it('unknown for a unit missing from the cache, or cached under another registry', () => {
  const { root } = workspace(['acme/a']);
  expect(kitsOf(rows(home([]), root))[0]).toMatchObject({ status: 'unknown', detail: 'not checked: 1 of 1 kit' });
  expect(kitsOf(rows(home([entry('/elsewhere', 'acme/a', '1.0.0')]), root))[0]).toMatchObject({ status: 'unknown' });
  // Or a week old, which the detail dates.
  const { root: old, registry } = workspace(['acme/a']);
  expect(kitsOf(rows(home([entry(registry, 'acme/a', '1.0.0', '2026-10-20T00:00:00Z')]), old))[0]).toMatchObject({
    status: 'unknown',
    detail: 'not checked: 1 of 1 kit (oldest check 2026-10-20 00:00 UTC)',
  });
});
it('a known update outranks an unknown unit', () => {
  const { root, registry } = workspace(['acme/a', 'acme/b']);
  const checks = kitsOf(rows(home([entry(registry, 'acme/a', '2.0.0')]), root));
  expect(checks.map((check) => [check.id, check.status])).toEqual([
    ['kits', 'warn'],
    ['kit-update:acme/a', 'warn'],
  ]);
});
it('an unmapped registry is unknown with its reason, not a throw', () => {
  const { root } = workspace(['acme/a']);
  writeFileSync(join(root, '.ia/registries.json'), JSON.stringify({ format: 'ia.registries.v1', registries: {} }));
  expect(kitsOf(rows(home([]), root))[0]).toMatchObject({
    status: 'unknown',
    detail: expect.stringContaining('acme/a: IA-DIST-REGISTRY-UNMAPPED'),
  });
});
it('an install by npm package is never asked of the kit index', async () => {
  const { root } = workspace([]);
  put(
    join(root, '.ia/distributions.lock.json'),
    canonicalDistributionJson({
      formatVersion: 1,
      engine: '^0.1.2',
      requests: [],
      packages: [],
      entries: [PACKAGE_ENTRY],
    }),
  );
  const at = resolve(scratch('doctor-kits-home'), '.ia');
  const npm: string[] = [];
  await refreshUpdates(
    { home: at, channel: 'unknown', current: VERSION, name: null, checkout: null, now: NOW, root, env: {} },
    {
      npm: (name) => {
        npm.push(name);
        return '1.3.0';
      },
      git: () => null,
    },
  );
  expect(npm).toEqual(['@acme/kits']);
  expect(readUpdateCheck(at)?.packages.entries).toEqual([pkg('1.3.0')]);
});

it('marketplace absent, invalid and present', () => {
  const { root } = workspace([]);
  const at = home([]);
  const marketplace = () => rows(at, root).find((check) => check.id === 'marketplace');
  expect(marketplace()).toMatchObject({
    status: 'info',
    detail: 'no plugin installed from a marketplace',
    remedy: 'ia host claude --user --apply',
    fix: { program: 'ia', argv: ['host', 'claude', '--user', '--apply'], flow: 'preview-apply', writesTo: 'user' },
  });
  put(join(at, MARKETPLACE_RECORD), '{');
  expect(marketplace()).toMatchObject({ status: 'warn', remedy: 'ia host claude --user --apply' });
  writeMarketplaceRecord(at, 'ia@inventarch', '3.5.0', '2026-11-02T21:07:45.123Z');
  expect(marketplace()).toMatchObject({
    status: 'ok',
    detail: 'inventarch/marketplace · ia@inventarch · installed by ia 3.5.0 · last checked 2026-11-02 21:07 UTC',
    remedy: null,
    fix: null,
  });
});
it('a record without checkedAt says not recorded, stays valid, and reads the same whatever its mtime', () => {
  const { root } = workspace([]);
  const at = home([]);
  writeMarketplaceRecord(at, 'ia@inventarch', '3.5.0', null);
  expect(readMarketplaceRecord(at)).toMatchObject({ state: 'present', checkedAt: null });
  const first = rows(at, root).find((check) => check.id === 'marketplace');
  expect(first).toMatchObject({ status: 'ok', detail: expect.stringMatching(/ · last checked: not recorded$/) });
  utimesSync(join(at, MARKETPLACE_RECORD), new Date('2020-01-01'), new Date('2020-01-01'));
  expect(rows(at, root).find((check) => check.id === 'marketplace')).toEqual(first);
});
it('a home lock whose owner is gone is a row naming the file; a running, foreign-host or unreadable owner is none', () => {
  const { root } = workspace([]);
  const at = home([]);
  const dead = Number(
    spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout,
  );
  const lock = (name: string, owner: Record<string, unknown> | string): string => {
    const path = join(at, name);
    put(path, typeof owner === 'string' ? owner : JSON.stringify(owner));
    return path;
  };
  const owner = (extra: Record<string, unknown>) => ({
    token: 't',
    pid: dead,
    start: null,
    host: hostname(),
    createdAt: '2026-11-03T10:00:00.000Z',
    ...extra,
  });
  const locks = () => rows(at, root).filter((check) => check.id.startsWith('home-lock:'));
  expect(locks()).toEqual([]);
  // Not gone: a running process, another host, a token that does not parse.
  const cache = lock('state/update-check.json.lock', owner({ pid: process.pid }));
  expect(locks()).toEqual([]);
  // A running pid whose start differs is another process; only Linux reports a start time to compare.
  lock('state/update-check.json.lock', owner({ pid: process.pid, start: 'not-this-start' }));
  expect(locks()).toEqual(
    process.platform === 'linux'
      ? [
          expect.objectContaining({
            id: 'home-lock:state/update-check.json.lock',
            detail: expect.stringContaining('whose pid now names another process'),
          }),
        ]
      : [],
  );
  lock('state/update-check.json.lock', owner({ host: 'some-other-host' }));
  expect(locks()).toEqual([]);
  lock('state/update-check.json.lock', '{');
  expect(locks()).toEqual([]);
  // Gone: this host, a pid that has exited.
  lock('state/update-check.json.lock', owner({}));
  const tracked = lock('tracked-workspaces.json.lock', owner({}));
  expect(locks()).toEqual([
    expect.objectContaining({
      id: 'home-lock:state/update-check.json.lock',
      status: 'warn',
      detail: expect.stringContaining(cache),
      remedy: expect.stringContaining(`delete ${cache} by hand`),
      fix: null,
    }),
    expect.objectContaining({
      id: 'home-lock:tracked-workspaces.json.lock',
      status: 'warn',
      remedy: expect.stringContaining(`delete ${tracked} by hand`),
    }),
  ]);
});
