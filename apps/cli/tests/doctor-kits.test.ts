/**
 * host-plugin-distribution §7.3 and §11: doctor's kit rows and the refresh it schedules, read from the per-registry
 * update cache and local configuration only.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonicalDistributionJson } from '@inventarch/db/distribution';
import type { Channel } from '../src/channel.js';
import { userRows } from '../src/doctor-user.js';
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
