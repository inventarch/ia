/**
 * host-plugin-distribution §7.3 and dec-007: the Claude plugin and the update cache belong to the copy that renders the
 * one and refreshes the other. After a hand-off that is the copy that handed off, so a handed-off doctor judges both
 * rows against the version `IA_HANDOFF_FROM` names, not its own.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { userRows } from '../src/doctor-user.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, value: unknown): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
// The workspace pins 3.5.0, which runs here; the global 3.5.1 handed off, rendered the plugin and refreshed the cache.
const PINNED = '3.5.0',
  GLOBAL = '3.5.1';
const channel = { kind: 'npm', name: '@inventarch/cli', version: PINNED } as const;
/** An IA home holding the plugin by one of its two routes and a fresh update cache, both written by the global copy. */
function home(prefix: string, plugin: 'materialized' | 'marketplace'): string {
  const home = resolve(scratch(prefix), '.ia');
  if (plugin === 'materialized') {
    put(resolve(home, 'claude/marketplace/plugins/ia/.claude-plugin/plugin.json'), { version: `0.1.0+${GLOBAL}` });
    put(resolve(home, 'claude/marketplace/plugins/ia/ia-plugin.json'), { cli: GLOBAL, channel: 'npm', entry: 'x' });
  } else
    put(resolve(home, 'claude/marketplace-install.json'), {
      marketplace: 'inventarch/marketplace',
      plugin: 'ia@inventarch',
      cli: GLOBAL,
    });
  put(resolve(home, 'state/update-check.json'), {
    schema: 'ia.update-check.v1',
    checkedAt: new Date().toISOString(),
    cli: { channel: 'npm', current: GLOBAL, latest: null, behind: null, checked: true },
    packages: { checked: false },
  });
  return home;
}
/** The global copy's package root: only its package.json is read. */
const global = (version: string | null): string => {
  const root = scratch('doctor-handoff-global');
  if (version !== null) put(resolve(root, 'package.json'), { name: '@inventarch/cli', version });
  return root;
};
const rows = (iaHome: string, env: Record<string, string>) => {
  const { checks } = userRows({
    env: { IA_HOME: iaHome, ...env },
    home: scratch('doctor-handoff-user'),
    packageRoot: scratch('doctor-handoff-pinned'),
    version: PINNED,
    directory: scratch('doctor-handoff-cwd'),
    supplied: undefined,
    root: undefined,
    enclosing: undefined,
    now: new Date(),
    channel,
  });
  const of = (id: string) => checks.find((check) => check.id === id);
  return { plugin: of('plugin-claude'), updates: of('updates') };
};

describe.each(['materialized', 'marketplace'] as const)('a plugin %s by the global copy', (route) => {
  it('without IA_HANDOFF_FROM, both rows judge against this copy', () => {
    const { plugin, updates } = rows(home(`doctor-handoff-own-${route}`, route), {});
    expect(plugin).toMatchObject({ status: 'warn', remedy: 'ia host claude --user --apply' });
    expect(plugin?.detail).toContain(`by ia ${GLOBAL}; this is ia ${PINNED}`);
    expect(updates).toMatchObject({ status: 'unknown', detail: 'Not checked yet; a check runs in the background' });
  });
  it('after a hand-off, both rows judge against the copy that handed off', () => {
    const { plugin, updates } = rows(home(`doctor-handoff-from-${route}`, route), {
      IA_HANDOFF_FROM: global(GLOBAL),
    });
    expect(plugin).toMatchObject({ status: 'ok', remedy: null });
    expect(updates).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^Up to date as of /) });
  });
  it('an IA_HANDOFF_FROM whose package.json cannot be read judges against this copy', () => {
    const { plugin, updates } = rows(home(`doctor-handoff-unread-${route}`, route), { IA_HANDOFF_FROM: global(null) });
    expect(plugin?.status).toBe('warn');
    expect(updates?.status).toBe('unknown');
  });
});
it('after a hand-off, a newer release is measured from the copy that handed off', () => {
  const iaHome = home('doctor-handoff-newer', 'marketplace');
  put(resolve(iaHome, 'state/update-check.json'), {
    schema: 'ia.update-check.v1',
    checkedAt: new Date().toISOString(),
    cli: { channel: 'npm', current: GLOBAL, latest: '3.6.0', behind: null, checked: true },
    packages: { checked: false },
  });
  const { updates } = rows(iaHome, { IA_HANDOFF_FROM: global(GLOBAL) });
  expect(updates).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining(`ia 3.6.0 is available; this is ${GLOBAL}`),
  });
});
