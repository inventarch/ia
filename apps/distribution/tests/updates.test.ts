/**
 * Host plugin distribution spec §11: the cached update check and local compatibility. Sources are injected, so no
 * case reaches the npm registry; only the two #436 process cases at the end run the built CLI, a stand-in npm and
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
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
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

// #436: refresh-updates run by hand from a directory the repository controls never starts an npm or git planted there,
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
  'refresh-updates run by hand never starts an npm planted in the working directory; the qualified npm answers from home (#436)',
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
  'refresh-updates run by hand never starts a git planted in the working directory; the qualified git counts the checkout (#436)',
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
