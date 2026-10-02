/**
 * Host plugin distribution spec §11: the cached update check and local compatibility. Sources are injected, so no
 * case reaches npm or runs git.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HOME_MARKER } from '../src/ia-home.js';
import { runNative } from '../src/native-command.js';
import {
  compareVersions,
  compatibility,
  liveSources,
  readIaConfig,
  readUpdateCheck,
  refreshDue,
  refreshUpdates,
  UPDATE_CHECK,
  updateCheckDisabled,
} from '../src/updates.js';
import type { Sources } from '../src/updates.js';

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

it('refreshes from npm for the npm channel and records a failed source as not checked', () => {
  const home = join(temp(), '.ia'),
    now = new Date('2026-09-23T12:00:00Z');
  refreshUpdates(
    { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now },
    { ...unused, npm: () => '0.3.0' },
  );
  expect(readUpdateCheck(home)).toMatchObject({
    schema: 'ia.update-check.v1',
    checkedAt: now.toISOString(),
    cli: { channel: 'npm', current: '0.2.0', latest: '0.3.0', behind: null, checked: true },
    packages: { checked: false },
  });
  refreshUpdates(
    { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now },
    { ...unused, npm: () => null },
  );
  expect(readUpdateCheck(home)?.cli).toMatchObject({ latest: null, checked: false });
  // Amendment item 4: the hook keeps nudgedOn in its own plugin data.
  expect(readFileSync(join(home, UPDATE_CHECK), 'utf8')).not.toContain('nudgedOn');
});
it('counts commits behind upstream for a checkout without fetching, and never asks npm', () => {
  const home = join(temp(), '.ia');
  const seen: string[][] = [];
  refreshUpdates(
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
  refreshUpdates(
    { home, channel: 'checkout', current: '0.2.0', name: null, checkout: '/src', now: new Date() },
    { ...unused, git: () => null },
  );
  expect(readUpdateCheck(home)?.cli).toMatchObject({ behind: null, checked: false });
});
it('an unknown channel has no source: nothing is asked and the check is recorded as not checked', () => {
  const home = join(temp(), '.ia');
  expect(
    refreshUpdates({ home, channel: 'unknown', current: '0.2.0', name: null, checkout: null, now: new Date() }, unused)
      .cli.checked,
  ).toBe(false);
});
it('writes through the IA home, which it creates and marks, and keeps the private account section', () => {
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
  refreshUpdates(
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
