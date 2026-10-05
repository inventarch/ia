/**
 * #436: `ia` commands a user runs by hand from a directory the repository controls never start a program planted there.
 * Each case runs the built CLI (`apps/cli/dist/main.js`, so `pnpm --filter @inventarch/cli build` first) from such a directory,
 * with a PATH whose first entries are relative or empty, so they name that directory, and checks that the plants never
 * ran while the program on a qualified entry did. `ia host claude --user --apply` also records the Node running it, by
 * absolute path, for the plugin's hook (item 1).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { nodeCommand } from '@inventarch/distribution/host';
import { runBounded } from '@tools/testing/subprocess.js';
import { cleanup, cli, repository, scratch } from './workspace-fixture.js';

afterAll(cleanup);
const CLI_MAIN = resolve(cli, 'dist/main.js');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fake-claude.mjs');
const windows = process.platform === 'win32';
const PLACEHOLDER = '$' + '{CLAUDE_PLUGIN_ROOT}';

// This machine's own program, found on this process's PATH, to stand on a qualified entry of the CLI's PATH.
function realProgram(name: string): string {
  for (const dir of (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => entry.replace(/"/g, ''))
    .filter((entry) => isAbsolute(entry))) {
    const file = resolve(dir, windows ? `${name}.exe` : name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`no ${name} on this machine's PATH`);
}
// A `name` the repository plants in `dir`, recording that it ran. On Windows it is a .cmd, which only cmd.exe runs; the
// marker is named through %~dp0 because cmd.exe reads a batch file in the OEM code page, which may not hold the temp path.
function plant(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const marker = resolve(dir, `${name}-ran.txt`);
  if (windows) writeFileSync(resolve(dir, `${name}.cmd`), `@echo planted> "%~dp0${name}-ran.txt"\r\n`);
  else {
    writeFileSync(resolve(dir, name), `#!/bin/sh\necho planted > '${marker}'\n`);
    chmodSync(resolve(dir, name), 0o755);
  }
  return marker;
}
// On Windows, a `name`.exe that a lookup without a shell would start: a copy of hostname.exe, which fails on any argument.
function plantExe(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  if (windows)
    copyFileSync(
      resolve(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'hostname.exe'),
      resolve(dir, `${name}.exe`),
    );
}
const ran = (markers: readonly string[]): string[] => markers.filter((marker) => existsSync(marker));
// The CLI's environment: this process's, without PATH in any spelling, an inherited NoDefaultCurrentDirectoryInExePath
// (a machine that sets it could hide a failure) or the test-only IA_CLAUDE, plus a scratch IA home and `path`.
function cliEnv(path: readonly string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dropped = new Set(['path', 'nodefaultcurrentdirectoryinexepath', 'ia_claude', 'ia_home']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!dropped.has(key.toLowerCase())) env[key] = value;
  return { ...env, IA_HOME: resolve(scratch('lookup-home'), '.ia'), ...extra, PATH: path.join(delimiter) };
}
const runCli = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, node = process.execPath) =>
  runBounded(node, [CLI_MAIN, ...args], { cwd, env, timeoutMs: 60_000 });
const git = async (args: readonly string[], cwd: string): Promise<string> => {
  const result = await runBounded(realProgram('git'), args, { cwd, timeoutMs: 30_000 });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
};

it('ia doctor run by hand in a repository never starts a git planted there; the qualified git reads the channel (#436)', async () => {
  const project = scratch('lookup-doctor');
  const markers = [plant(project, 'git'), plant(resolve(project, 'bin'), 'git')];
  plantExe(project, 'git');
  plantExe(resolve(project, 'bin'), 'git');
  const head = await git(['-C', repository, 'rev-parse', 'HEAD'], repository);
  const result = await runCli(['doctor', '--json'], project, cliEnv(['bin', '', dirname(realProgram('git'))]));
  expect(ran(markers)).toEqual([]);
  const channel = JSON.parse(result.stdout).checks.find((check: { id: string }) => check.id === 'install-channel');
  // The source checkout this CLI runs from, read by the real git: a plant that ran instead would leave no commit.
  expect(channel.detail, result.stderr).toContain(` at ${head.slice(0, 12)}`);
});

it('ia init run by hand never starts a git planted in the target repository; the qualified git reads its provenance (#436)', async () => {
  const target = resolve(scratch('lookup-init'), 'demo');
  mkdirSync(target);
  await git(['init', '-q'], target);
  await git(
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--no-verify',
      '--allow-empty',
      '-m',
      't',
    ],
    target,
  );
  await git(['remote', 'add', 'origin', 'https://example.com/demo.git'], target);
  const head = await git(['rev-parse', 'HEAD'], target);
  const markers = [plant(target, 'git'), plant(resolve(target, 'bin'), 'git')];
  plantExe(target, 'git');
  plantExe(resolve(target, 'bin'), 'git');
  const result = await runCli(['init', target, '--json'], target, cliEnv(['bin', '', dirname(realProgram('git'))]));
  expect(ran(markers)).toEqual([]);
  expect(result.status, result.stderr).toBe(0);
  const plan = JSON.parse(result.stdout).plan;
  expect(plan.starter.provenance).toEqual({ status: 'sourced', missing: null });
  expect(plan.starter.descriptor.source).toMatchObject({ repository: 'https://example.com/demo.git', commit: head });
});

it('ia host claude --user never starts a claude planted in the working directory; the qualified one runs from the home directory (#436)', async () => {
  const project = scratch('lookup-claude'),
    bin = scratch('lookup-claude-bin'),
    log = resolve(bin, 'claude.log');
  const markers = [plant(project, 'claude'), plant(resolve(project, 'bin'), 'claude')];
  plantExe(resolve(project, 'bin'), 'claude');
  // The claude on the qualified entry records its working directory, its PATH and its arguments, one per line.
  if (windows) writeFileSync(resolve(bin, 'claude.cmd'), '@(echo %CD%& echo %PATH%& echo %*)>> "%~dp0claude.log"\r\n');
  else {
    writeFileSync(resolve(bin, 'claude'), `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$PATH" "$*"; } >> '${log}'\n`);
    chmodSync(resolve(bin, 'claude'), 0o755);
  }
  const result = await runCli(['host', 'claude', '--user', '--json'], project, cliEnv(['bin', '', bin]));
  expect(ran(markers)).toEqual([]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).plan.claude).toBe(true);
  const [cwd, path, args, ...rest] = readFileSync(log, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  expect([path, args, rest.filter(Boolean)]).toEqual([bin, '--version', []]);
  expect(windows ? cwd!.toLowerCase() : cwd).toBe(windows ? homedir().toLowerCase() : realpathSync(homedir()));
});

it('ia host claude --user --apply records the Node running it, by absolute path, for the plugin hook on macOS and Linux (#436)', async () => {
  const project = scratch('lookup-record');
  const env = cliEnv(['bin', ''], { IA_CLAUDE: FAKE_CLAUDE, IA_CLAUDE_LOG: resolve(project, 'claude.log') });
  // A version-manager shim (asdf, nodenv, Volta) starts the real Node, whose own path is what gets recorded: the shim,
  // which would choose a Node from the project's version files, is not. Windows has no shell script to stand in for one.
  let node = process.execPath;
  if (!windows) {
    const shims = scratch('lookup-shims');
    node = resolve(shims, 'node');
    writeFileSync(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(node, 0o755);
  }
  const result = await runCli(['host', 'claude', '--user', '--apply', '--yes', '--json'], project, env, node);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const hooks = JSON.parse(
    readFileSync(resolve(env['IA_HOME']!, 'claude/marketplace/plugins/ia/hooks/hooks.json'), 'utf8'),
  );
  // Shell form: the Node quoted on macOS and Linux; on Windows the earlier `node` by name (host plugin distribution design §6.1).
  const command = windows ? 'node' : `"${nodeCommand(process.execPath)}"`;
  expect(hooks.hooks.SessionStart).toStrictEqual([
    {
      matcher: 'startup|clear',
      hooks: [{ type: 'command', command: `${command} "${PLACEHOLDER}/hooks/session-start.mjs"`, timeout: 10 }],
    },
  ]);
  if (!windows) expect(realpathSync(nodeCommand(process.execPath))).toBe(realpathSync(process.execPath));
});
