/**
 * `ia host <host> --user`: docs/specs/host-plugin-distribution/README.md §6.3 (amended, item 5) and §7.1.
 *
 * Every case sets IA_HOME to a scratch directory and IA_CLAUDE to tests/fake-claude.mjs, so no test writes the real
 * IA home or runs the real `claude`, which would change the user's Claude configuration.
 */
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { claudeRunner } from '../src/claude-cli.js';
import { USER_PLUGIN_MISSING } from '../src/host.js';
import { quote } from '../src/render.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);
const FAKE = resolve(import.meta.dirname, 'fake-claude.mjs');
function setup(extra: Record<string, string> = {}) {
  const base = scratch('user-host'),
    log = resolve(base, 'claude.log');
  writeFileSync(log, '');
  return { log, env: { IA_HOME: resolve(base, '.ia'), IA_CLAUDE: FAKE, IA_CLAUDE_LOG: log, ...extra } };
}
const INSTALLED = {
  FAKE_CLAUDE_PLUGINS: JSON.stringify([{ id: 'ia@inventarch', version: '0.1.0', scope: 'user', enabled: true }]),
  FAKE_CLAUDE_MARKETPLACES: JSON.stringify([{ name: 'inventarch', source: 'directory' }]),
};
const calls = (log: string): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const registration = (home: string): string[][] => [
  ['plugin', 'marketplace', 'add', resolve(home, 'claude/marketplace')],
  ['plugin', 'install', 'ia@inventarch', '--scope', 'user'],
];

it('plans without writing, then materializes and registers through claude', async () => {
  const { log, env } = setup();
  const planned = JSON.parse((await run(['host', 'claude', '--user', '--json'], { env })).stdout);
  expect(planned).toMatchObject({
    version: 1,
    command: 'host',
    user: true,
    host: 'claude',
    apply: false,
    plan: { claude: true, installed: null },
  });
  expect(planned.plan.commands).toEqual(registration(env.IA_HOME));
  expect(existsSync(env.IA_HOME)).toBe(false);
  expect(calls(log)).toEqual([]);
  const applied = await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(JSON.parse(applied.stdout).applied).toMatchObject({ status: 'plugin-registered', ran: planned.plan.commands });
  expect(calls(log)).toEqual(planned.plan.commands);
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace/plugins/ia/hooks/session-start.mjs'))).toBe(true);
  // A second plan reads the materialized plugin back.
  const again = JSON.parse((await run(['host', 'claude', '--user', '--json'], { env })).stdout);
  expect(again.plan.installed).toEqual({ version: planned.plan.plugin.version });
});
it('registers with the same two idempotent commands when already installed (spec §2.3)', async () => {
  const { env } = setup(INSTALLED);
  const planned = JSON.parse((await run(['host', 'claude', '--user', '--json'], { env })).stdout);
  expect(planned.plan.commands).toEqual(registration(env.IA_HOME));
});
it('prints each claude command in the human plan', async () => {
  const { env } = setup();
  const planned = await run(['host', 'claude', '--user'], { env });
  expect(planned.exitCode).toBe(0);
  // commandFacts breaks a long command with a trailing backslash; joined back, each command reads whole.
  const text = planned.stdout.replace(/ \\\n\s*/g, ' ');
  for (const command of registration(env.IA_HOME)) expect(text).toContain(`claude ${command.map(quote).join(' ')}`);
  expect(text).toContain('This is a preview. Nothing has been written.');
  const removal = (
    await run(['host', 'claude', '--user', '--remove'], { env: { ...env, ...INSTALLED } })
  ).stdout.replace(/ \\\n\s*/g, ' ');
  expect(removal).toContain('claude plugin uninstall ia@inventarch --scope user');
  expect(removal).toContain('claude plugin marketplace remove inventarch');
  expect(existsSync(env.IA_HOME)).toBe(false);
});
it('prints the commands when claude is not available', async () => {
  const { env } = setup({ IA_CLAUDE: resolve(scratch('none'), 'missing.mjs') });
  const applied = JSON.parse((await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env })).stdout);
  expect(applied.plan.claude).toBe(false);
  expect(applied.plan.commands).toEqual(registration(env.IA_HOME));
  expect(applied.applied).toMatchObject({ status: 'plugin-materialized', ran: [] });
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace/plugins/ia/.claude-plugin/plugin.json'))).toBe(true);
  // Removal without claude deletes only the directory, says so in its status, and keeps the warning.
  const removed = await run(['host', 'claude', '--user', '--remove', '--apply', '--yes', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).applied).toMatchObject({ status: 'plugin-directory-removed', ran: [] });
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace'))).toBe(false);
  const human = await run(['host', 'claude', '--user', '--remove', '--apply', '--yes'], { env });
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain('Deleted the plugin directory; not removed from Claude.');
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(
    'claude could not be run: run the claude commands above by hand.',
  );
});
it('refuses a claude command that fails, naming it', async () => {
  const { env } = setup({ IA_CLAUDE_EXIT: '1' });
  const result = await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env });
  expect(result.exitCode).toBe(3);
  const refusal = JSON.parse(result.stdout);
  expect(refusal).toMatchObject({ ok: false, code: 'IA-CLI-HOST-COMMAND-FAILED' });
  expect(refusal.message).toContain('claude plugin marketplace add');
  expect(refusal.next).toContain('ia host claude --user --apply');
});
it('refuses an install that fails after the marketplace was added, keeping the directory', async () => {
  const { log, env } = setup({ IA_CLAUDE_FAIL_ON: 'plugin install' });
  const result = await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env });
  expect(result.exitCode, result.stdout).toBe(3);
  const refusal = JSON.parse(result.stdout);
  expect(refusal).toMatchObject({ ok: false, code: 'IA-CLI-HOST-COMMAND-FAILED' });
  expect(refusal.message).toContain('claude plugin install ia@inventarch --scope user exited 1');
  expect(refusal.next).toBe(
    'Run "claude plugin install ia@inventarch --scope user" yourself to see why, then rerun "ia host claude --user --apply".',
  );
  expect(calls(log)).toEqual(registration(env.IA_HOME));
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace/plugins/ia/.claude-plugin/plugin.json'))).toBe(true);
});
it('refuses an uninstall that fails during removal, keeping the directory', async () => {
  const { log, env } = setup();
  expect((await run(['host', 'claude', '--user', '--apply', '--yes'], { env })).exitCode).toBe(0);
  writeFileSync(log, '');
  const result = await run(['host', 'claude', '--user', '--remove', '--apply', '--yes', '--json'], {
    env: { ...env, ...INSTALLED, IA_CLAUDE_FAIL_ON: 'plugin uninstall' },
  });
  expect(result.exitCode, result.stdout).toBe(3);
  const refusal = JSON.parse(result.stdout);
  expect(refusal).toMatchObject({ ok: false, code: 'IA-CLI-HOST-COMMAND-FAILED' });
  expect(refusal.next).toContain('then rerun "ia host claude --user --remove --apply"');
  // The marketplace remove never ran, and the directory Claude still points at is kept.
  expect(calls(log)).toEqual([['plugin', 'uninstall', 'ia@inventarch', '--scope', 'user']]);
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace/plugins/ia/.claude-plugin/plugin.json'))).toBe(true);
});
it('passes the fake only the variables this invocation was given', async () => {
  const { log, env } = setup();
  const inherited = process.env['IA_CLAUDE_FAIL_ON'];
  process.env['IA_CLAUDE_FAIL_ON'] = 'plugin';
  try {
    const result = await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env });
    expect(result.exitCode, result.stdout).toBe(0);
  } finally {
    if (inherited === undefined) delete process.env['IA_CLAUDE_FAIL_ON'];
    else process.env['IA_CLAUDE_FAIL_ON'] = inherited;
  }
  expect(calls(log)).toEqual(registration(env.IA_HOME));
});
// #436: ia looks claude up itself, on qualified PATH entries only, and runs what it found by absolute path from the home
// directory with only those entries in PATH; Windows rules run here on every platform with an in-memory file system.
it('runs claude on Windows by absolute path: a claude.exe without a shell, else a claude.cmd through cmd.exe (#436)', () => {
  const seen: { command: string; args: readonly string[]; options: Readonly<Record<string, unknown>> }[] = [];
  const result = (status: number | null) =>
    ({ pid: 0, output: [], stdout: '', stderr: '', status, signal: null }) as SpawnSyncReturns<string>;
  const files = (present: readonly string[]) => ({
    statSync: (target: string) => {
      const key = target.toLowerCase();
      if (present.some((file) => file.toLowerCase() === key)) return { isFile: () => true, isDirectory: () => false };
      if (present.some((file) => file.toLowerCase().startsWith(`${key}\\`)))
        return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    },
    accessSync: () => undefined,
  });
  const record = (command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) => (
    seen.push({ command, args, options }), result(0)
  );
  const env = { Path: 'bin;;C:\\npm;D:\\Claude', SystemRoot: 'C:\\WINDOWS' };
  const childEnv = { SystemRoot: 'C:\\WINDOWS', PATH: 'C:\\npm;D:\\Claude', NoDefaultCurrentDirectoryInExePath: '1' };
  // A claude.exe anywhere on a qualified entry wins over a claude.cmd before it, and runs with no shell.
  const direct = claudeRunner(env, {
    platform: 'win32',
    spawn: record,
    fs: files(['bin\\claude.exe', 'C:\\npm\\claude.cmd', 'D:\\Claude\\claude.exe']),
  });
  expect(direct.available).toBe(true);
  direct.run(['plugin', 'marketplace', 'add', 'C:\\a b\\marketplace']);
  expect(seen).toEqual([
    {
      command: 'D:\\Claude\\claude.exe',
      args: ['--version'],
      options: { cwd: homedir(), env: childEnv, timeout: 10_000, windowsHide: true },
    },
    {
      command: 'D:\\Claude\\claude.exe',
      args: ['plugin', 'marketplace', 'add', 'C:\\a b\\marketplace'],
      options: { cwd: homedir(), env: childEnv, timeout: 120_000, windowsHide: true },
    },
  ]);
  // Only an npm claude.cmd: cmd.exe from SystemRoot, its switches and the quoted line passed verbatim.
  seen.length = 0;
  const shim = claudeRunner(env, {
    platform: 'win32',
    spawn: record,
    fs: files(['bin\\claude.exe', 'C:\\npm\\claude.cmd']),
  });
  expect(shim.available).toBe(true);
  shim.run(['plugin', 'marketplace', 'add', 'C:\\a b\\marketplace']);
  const shell = { cwd: homedir(), env: childEnv, windowsHide: true, windowsVerbatimArguments: true };
  expect(seen).toEqual([
    {
      command: 'C:\\WINDOWS\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" --version"'],
      options: { ...shell, timeout: 10_000 },
    },
    {
      command: 'C:\\WINDOWS\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" plugin marketplace add "C:\\a b\\marketplace""'],
      options: { ...shell, timeout: 120_000 },
    },
  ]);
  // An argument cmd.exe would rewrite refuses before anything runs.
  const before = seen.length;
  expect(() => shim.run(['plugin', 'marketplace', 'add', 'C:\\100%\\marketplace'])).toThrow(
    expect.objectContaining({ code: 'IA-CLI-HOST-COMMAND-FAILED' }),
  );
  expect(() => shim.run(['plugin', 'marketplace', 'add', 'C:\\a"b'])).toThrow(
    expect.objectContaining({ code: 'IA-CLI-HOST-COMMAND-FAILED' }),
  );
  expect(seen.length).toBe(before);
  // A claude only in the project, behind the relative entry, is not found: nothing runs and claude is unavailable.
  seen.length = 0;
  expect(
    claudeRunner(env, { platform: 'win32', spawn: record, fs: files(['bin\\claude.exe', 'bin\\claude.cmd']) })
      .available,
  ).toBe(false);
  expect(seen).toEqual([]);
});
it('runs claude on POSIX by the absolute path found on a qualified PATH entry, from the home directory (#436)', () => {
  const seen: { command: string; args: readonly string[]; options: Readonly<Record<string, unknown>> }[] = [];
  const record = (command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) =>
    (seen.push({ command, args, options }),
    { pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null }) as SpawnSyncReturns<string>;
  const fs = {
    statSync: (target: string) => {
      if (target === '/opt/claude/bin/claude' || target === 'bin/claude')
        return { isFile: () => true, isDirectory: () => false };
      if (target === '/opt/claude/bin' || target === 'bin') return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    },
    accessSync: () => undefined,
  };
  const runner = claudeRunner(
    { PATH: 'bin::/opt/claude/bin', HOME: '/home/u' },
    { platform: 'linux', spawn: record, fs },
  );
  expect(runner.available).toBe(true);
  expect(seen).toEqual([
    {
      command: '/opt/claude/bin/claude',
      args: ['--version'],
      options: {
        cwd: homedir(),
        env: { PATH: '/opt/claude/bin', HOME: '/home/u' },
        timeout: 10_000,
        windowsHide: true,
      },
    },
  ]);
  seen.length = 0;
  expect(claudeRunner({ PATH: 'bin::' }, { platform: 'linux', spawn: record, fs }).available).toBe(false);
  expect(seen).toEqual([]);
});
it('refuses a marketplace held by another run as IA-DIST-INSTALL-BUSY, naming what to close', async () => {
  const { log, env } = setup();
  // A lock naming a live process (this one) is never taken over (plugin-home.ts acquireLock).
  mkdirSync(resolve(env.IA_HOME, 'claude'), { recursive: true });
  writeFileSync(resolve(env.IA_HOME, 'claude/.lock'), String(process.pid));
  const result = await run(['host', 'claude', '--user', '--apply', '--yes', '--json'], { env });
  expect(result.exitCode).toBe(3);
  const refusal = JSON.parse(result.stdout);
  expect(refusal).toMatchObject({ ok: false, code: 'IA-DIST-INSTALL-BUSY' });
  expect(refusal.message).toContain(resolve(env.IA_HOME, 'claude/.lock'));
  expect(refusal.next).toBe(
    `Wait for any other "ia host --user" run to finish and close Claude Code sessions, editors or terminals using ${resolve(env.IA_HOME, 'claude')}; ` +
      `if no run is active, delete ${resolve(env.IA_HOME, 'claude/.lock')}; then rerun "ia host claude --user --apply".`,
  );
  expect(calls(log)).toEqual([]);
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace'))).toBe(false);
});
it('refuses planned and partial hosts, and --root or --context with --user', async () => {
  const { env } = setup();
  expect(JSON.parse((await run(['host', 'cursor', '--user', '--json'], { env })).stdout)).toMatchObject({
    code: 'IA-DIST-HOST-UNSUPPORTED',
  });
  expect(JSON.parse((await run(['host', 'codex', '--user', '--json'], { env })).stdout)).toMatchObject({
    code: 'IA-DIST-HOST-UNSUPPORTED',
  });
  const planned = await run(['host', 'cursor', '--json'], { env });
  expect(planned.exitCode).toBe(3);
  expect(JSON.parse(planned.stdout)).toMatchObject({
    code: 'IA-DIST-HOST-UNSUPPORTED',
    message: 'Cursor support is planned; nothing was written',
  });
  expect((await run(['host', 'nope', '--user', '--json'], { env })).exitCode).toBe(2);
  expect((await run(['host', 'claude', '--user', '--root', scratch('r')], { env })).exitCode).toBe(2);
  expect((await run(['host', 'claude', '--user', '--context', 'x'], { env })).exitCode).toBe(2);
  expect(existsSync(env.IA_HOME)).toBe(false);
});
it('refuses usage and unsupported hosts before running claude at all, the --version probe included (contract §3)', async () => {
  const { env } = setup();
  const recorded = resolve(scratch('user-host-calls'), 'calls.log');
  writeFileSync(recorded, '');
  const recording = { ...env, IA_CLAUDE_CALLS: recorded };
  const root = await run(['host', 'claude', '--user', '--root', scratch('r'), '--json'], { env: recording });
  expect(root.exitCode, root.stdout).toBe(2);
  const unknown = await run(['host', 'vim', '--user', '--json'], { env: recording });
  expect(unknown.exitCode, unknown.stdout).toBe(2);
  for (const name of ['cursor', 'codex'])
    expect((await run(['host', name, '--user', '--json'], { env: recording })).exitCode).toBe(3);
  expect(calls(recorded)).toEqual([]);
  // The recorder works: a plan that passes every check probes claude once.
  expect((await run(['host', 'claude', '--user', '--json'], { env: recording })).exitCode).toBe(0);
  expect(calls(recorded)).toEqual([['--version']]);
});
it('refuses an IA home that looks like a workspace at plan time', async () => {
  const { env } = setup();
  mkdirSync(resolve(env.IA_HOME, 'src'), { recursive: true });
  const result = await run(['host', 'claude', '--user', '--json'], { env });
  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: 'IA-DIST-PATH-UNSAFE',
    next: `Move ${resolve(env.IA_HOME, 'src')} out of the IA home, or set IA_HOME to another absolute directory.`,
  });
});
it('removes only what claude lists, then the directory (uninstall and remove exit 1 when absent, spec §2.3)', async () => {
  const { log, env } = setup();
  expect((await run(['host', 'claude', '--user', '--apply', '--yes'], { env })).exitCode).toBe(0);
  writeFileSync(log, '');
  const removed = await run(['host', 'claude', '--user', '--remove', '--apply', '--yes', '--json'], {
    env: { ...env, ...INSTALLED },
  });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).applied).toMatchObject({ status: 'plugin-removed' });
  expect(calls(log)).toEqual([
    ['plugin', 'uninstall', 'ia@inventarch', '--scope', 'user'],
    ['plugin', 'marketplace', 'remove', 'inventarch'],
  ]);
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace'))).toBe(false);
  writeFileSync(log, '');
  expect((await run(['host', 'claude', '--user', '--remove', '--apply', '--yes'], { env })).exitCode).toBe(0);
  expect(calls(log)).toEqual([]);
});
it('removes nothing and runs no claude command when nothing is registered or materialized', async () => {
  const { log, env } = setup();
  const planned = JSON.parse((await run(['host', 'claude', '--user', '--remove', '--json'], { env })).stdout);
  expect(planned.plan.commands).toEqual([]);
  const removed = await run(['host', 'claude', '--user', '--remove', '--apply', '--yes', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).applied).toMatchObject({ status: 'plugin-removed', ran: [] });
  expect(calls(log)).toEqual([]);
  expect(existsSync(resolve(env.IA_HOME, 'claude/marketplace'))).toBe(false);
});
it('does not uninstall a plugin claude lists at another scope', async () => {
  const { env } = setup({
    FAKE_CLAUDE_PLUGINS: JSON.stringify([{ id: 'ia@inventarch', version: '0.1.0', scope: 'project', enabled: true }]),
    FAKE_CLAUDE_MARKETPLACES: INSTALLED.FAKE_CLAUDE_MARKETPLACES,
  });
  const planned = JSON.parse((await run(['host', 'claude', '--user', '--remove', '--json'], { env })).stdout);
  expect(planned.plan.commands).toEqual([['plugin', 'marketplace', 'remove', 'inventarch']]);
});
it('names the missing user-level plugin in a workspace plan, and stops once it is materialized (spec §7.1)', async () => {
  const { log, env } = setup();
  const root = resolve(scratch('user-host-workspace'), 'demo');
  const initialized = await run(['init', root, '--apply', '--yes', '--json'], { env });
  expect(initialized.exitCode, initialized.stdout).toBe(0);
  const planned = JSON.parse((await run(['host', 'claude', '--root', root, '--json'], { env })).stdout);
  expect(planned.plan.userPlugin).toEqual({ installed: false, command: 'ia host claude --user --apply' });
  const human = await run(['host', 'claude', '--root', root], { env });
  expect(human.exitCode).toBe(0);
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(USER_PLUGIN_MISSING);
  expect(USER_PLUGIN_MISSING).toBe(
    'The user-level plugin is not installed; run "ia host claude --user --apply" to add it.',
  );
  // Codex has no user-level plugin, so its plan carries no such field.
  expect(
    JSON.parse((await run(['host', 'codex', '--root', root, '--json'], { env })).stdout).plan.userPlugin,
  ).toBeUndefined();
  // The workspace plan only names the command; claude was never asked anything.
  expect(calls(log)).toEqual([]);
  expect((await run(['host', 'claude', '--user', '--apply', '--yes'], { env })).exitCode).toBe(0);
  expect(JSON.parse((await run(['host', 'claude', '--root', root, '--json'], { env })).stdout).plan.userPlugin).toEqual(
    { installed: true, command: 'ia host claude --user --apply' },
  );
  expect((await run(['host', 'claude', '--root', root], { env })).stdout.replace(/\s+/g, ' ')).not.toContain(
    'The user-level plugin is not installed',
  );
});
