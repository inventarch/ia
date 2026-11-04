/**
 * The built CLI hands a typed command to the workspace's installed `@inventarch/cli` (docs/specs/consumer-cli-contract
 * §1.2). The workspace here pins and installs a fake copy that reports what it was given, so each case reads off what
 * the hand-off passed through. The cases run the `ia` bin, `apps/cli/dist/bin.js`, as a typed command does. Requires a current
 * build: run `pnpm --filter @inventarch/cli build`.
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { renderClaudePlugin } from '@inventarch/compliance';
import { sameFile } from '@inventarch/db';
import { runBounded } from '@tools/testing/subprocess.js';
import { cleanup, cli, scratch } from './workspace-fixture.js';

afterAll(cleanup);
const CLI_BIN = resolve(cli, 'dist/bin.js');
const CLI_MAIN = resolve(cli, 'dist/main.js');
const OWN_VERSION = (JSON.parse(readFileSync(resolve(cli, 'package.json'), 'utf8')) as { version: string }).version;
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
// CommonJS, since the fake's package.json declares no type. It reads stdin only when it is not a terminal.
const FAKE = [
  "const { readFileSync } = require('node:fs');",
  "const { isatty } = require('node:tty');",
  "const stdin = isatty(0) ? null : readFileSync(0, 'utf8');",
  // FAKE_SIGNAL_PARENT: signal the copy that handed off, as a terminal signals the whole group, then finish a moment later.
  'if (process.env.FAKE_SIGNAL_PARENT) {',
  '  process.kill(process.ppid, process.env.FAKE_SIGNAL_PARENT);',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
  '}',
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), from: process.env.IA_HANDOFF_FROM, stdin }));',
  "process.stderr.write('fake-stderr');",
  'process.exitCode = Number(process.env.FAKE_EXIT ?? 0);',
  '',
].join('\n');
/** A workspace that pins `@inventarch/cli@9.9.9` and has the fake installed as that copy. */
function workspace(prefix: string): { readonly root: string; readonly fake: string } {
  const root = scratch(prefix);
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  put(resolve(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '9.9.9' } }));
  const copy = resolve(root, 'node_modules/@inventarch/cli');
  put(
    resolve(copy, 'package.json'),
    JSON.stringify({ name: '@inventarch/cli', version: '9.9.9', bin: { ia: 'dist/main.js' } }),
  );
  put(resolve(copy, 'dist/main.js'), FAKE);
  return { root, fake: resolve(copy, 'dist/main.js') };
}
/** This process's environment without either hand-off variable, with the IA home in a scratch directory. */
function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, IA_HOME: resolve(scratch('handoff-home'), '.ia'), ...extra };
  for (const name of ['IA_HANDOFF_FROM', 'IA_NO_HANDOFF']) if (!(name in extra)) delete env[name];
  return env;
}
const run = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) =>
  runBounded(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env,
    timeoutMs: 30_000,
    ...(input === undefined ? {} : { input }),
  });
const handed = (stdout: string) => JSON.parse(stdout) as { argv: string[]; from?: string; stdin: string | null };

it("hands the invocation to the workspace's copy", async () => {
  const { root } = workspace('handoff-run');
  const result = await run(['validate', '--json'], root, environment());
  expect(result.status, result.stderr).toBe(0);
  const got = handed(result.stdout);
  expect(got.argv).toEqual(['validate', '--json']);
  expect(got.from).toBe(realpathSync(cli));
  expect(result.stderr).toBe('fake-stderr');
});
it('decides before it loads its command modules', async () => {
  // A module hook in the copy that hands off records every module it loads; the copy handed to runs without it.
  const dir = scratch('handoff-light');
  const log = resolve(dir, 'loaded.txt');
  const hook = resolve(dir, 'hook.mjs');
  put(log, '');
  put(
    hook,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { registerHooks } from 'node:module';",
      'registerHooks({ load(url, context, next) { appendFileSync(process.env.LOADED_LOG, url + "\\n"); return next(url, context); } });',
      '',
    ].join('\n'),
  );
  const { root } = workspace('handoff-light-run');
  const result = await runBounded(process.execPath, ['--import', pathToFileURL(hook).href, CLI_BIN, 'validate'], {
    cwd: root,
    env: environment({ LOADED_LOG: log }),
    timeoutMs: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(handed(result.stdout).argv).toEqual(['validate']);
  const loaded = readFileSync(log, 'utf8')
    .split('\n')
    .filter((url) => url.startsWith('file:'))
    .map((url) => fileURLToPath(url));
  const own = (file: string) => loaded.some((path) => sameFile(path, resolve(cli, 'dist', file)));
  expect(own('bin.js') && own('handoff.js'), loaded.join('\n')).toBe(true);
  expect(own('main.js') || own('consumer.js'), loaded.join('\n')).toBe(false);
});
it('dist/main.js run directly still dispatches, and answers itself', async () => {
  // The plugin hook's entry and a checkout's `node apps/cli/dist/main.js` reach this module, not the bin.
  const { root } = workspace('handoff-main');
  const result = await runBounded(process.execPath, [CLI_MAIN, '--version'], {
    cwd: root,
    env: environment(),
    timeoutMs: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${OWN_VERSION}\n`);
  expect(result.stderr).toBe('');
});
it('propagates the exit code', async () => {
  const { root } = workspace('handoff-exit');
  const result = await run(['validate'], root, environment({ FAKE_EXIT: '7' }));
  expect(result.status).toBe(7);
});
it('passes stdin through', async () => {
  const { root } = workspace('handoff-stdin');
  const result = await run(['scope', '--params', '-'], root, environment(), '{"a":1}');
  expect(result.status, result.stderr).toBe(0);
  expect(handed(result.stdout).stdin).toBe('{"a":1}');
});
it('hands off for --root from outside', async () => {
  const { root } = workspace('handoff-root');
  const result = await run(['doctor', '--root', root, '--json'], scratch('handoff-outside'), environment());
  expect(result.status, result.stderr).toBe(0);
  expect(handed(result.stdout).argv).toEqual(['doctor', '--root', root, '--json']);
});
it('IA_NO_HANDOFF=1 runs this copy', async () => {
  const { root } = workspace('handoff-off');
  const result = await run(['--version'], root, environment({ IA_NO_HANDOFF: '1' }));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${OWN_VERSION}\n`);
});
it('a copy the repository commits is never run', async () => {
  // An untrusted clone that commits node_modules/@inventarch/cli: a typed command answers from this copy instead.
  const { root } = workspace('handoff-committed');
  const git = (...args: string[]) => runBounded('git', args, { cwd: root, env: process.env, timeoutMs: 30_000 });
  expect((await git('init', '-q')).status).toBe(0);
  expect((await git('add', '-f', 'node_modules/@inventarch/cli/dist/main.js')).status).toBe(0);
  const result = await run(['--version'], root, environment());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${OWN_VERSION}\n`);
  expect(result.stderr).not.toContain('fake-stderr');
});
it('bare ia does not hand off', async () => {
  const { root } = workspace('handoff-bare');
  const result = await run([], root, environment());
  expect(result.status, result.stderr).toBe(0);
  // The help may be styled (FORCE_COLOR), so it is recognized by its parts, not one span.
  expect(result.stdout).toContain(OWN_VERSION);
  expect(result.stdout).toContain('Usage');
  expect(result.stdout).not.toContain('"argv"');
  expect(result.stderr).not.toContain('fake-stderr');
});
it("the session hook's child does not hand off", async () => {
  // The rendered hook runs this entry as its `ia doctor`, with the environment its childEnv() builds.
  const entry = resolve(scratch('handoff-hook-entry'), 'entry.mjs');
  put(
    entry,
    "process.stdout.write(JSON.stringify({ session: { context: ['IA_NO_HANDOFF=' + process.env.IA_NO_HANDOFF], notice: null, nudge: null, refresh: null } }));\n",
  );
  const plugin = scratch('handoff-hook');
  for (const file of renderClaudePlugin({
    version: '0.1.0+x',
    cliVersion: '0.1.0',
    channel: 'npm',
    entry,
    install: 'npm i -g @inventarch/cli@latest.',
    node: process.execPath,
  }))
    put(resolve(plugin, file.path), file.text);
  const { root } = workspace('handoff-hook-project');
  const result = await runBounded(process.execPath, [resolve(plugin, 'plugins/ia/hooks/session-start.mjs')], {
    timeoutMs: 20_000,
    env: environment({ CLAUDE_PROJECT_DIR: root }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('IA_NO_HANDOFF=1');
});
it('a broken local copy is ignored', async () => {
  const { root, fake } = workspace('handoff-broken');
  rmSync(fake);
  const result = await run(['--version'], root, environment());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${OWN_VERSION}\n`);
  expect(result.stderr).toBe('');
});
// The copy that handed off waits for the child through a group signal and exits with the child's code (§3). POSIX only:
// on Windows process.kill ends the target unconditionally, so no portable fixture sends a catchable signal there.
it.skipIf(process.platform === 'win32')(
  'the copy that handed off outlives a signal the child also receives',
  async () => {
    const { root } = workspace('handoff-signal');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const result = await run(['validate'], root, environment({ FAKE_SIGNAL_PARENT: signal }));
      expect({ signal, status: result.status, killed: result.signal }).toEqual({ signal, status: 0, killed: null });
      expect(handed(result.stdout).argv).toEqual(['validate']);
    }
  },
);
it('a workspace whose installed copy is this one, through a junction, runs it without handing off', async () => {
  const root = scratch('handoff-self');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  put(resolve(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': OWN_VERSION } }));
  mkdirSync(resolve(root, 'node_modules/@inventarch'), { recursive: true });
  const link = resolve(root, 'node_modules/@inventarch/cli');
  symlinkSync(cli, link, 'junction');
  try {
    const result = await run(['--version'], root, environment());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${OWN_VERSION}\n`);
    expect(result.stderr).toBe('');
  } finally {
    // The link goes before the scratch directory, so no removal can reach the repository through it.
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  }
});
it('doctor reports a CLI dependency that is not installed', async () => {
  const root = scratch('handoff-doctor');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  put(resolve(root, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
  put(resolve(root, 'package-lock.json'), '{}');
  const result = await run(['doctor', '--json'], root, environment());
  const checks = (JSON.parse(result.stdout) as { checks: { id: string }[] }).checks;
  const at = checks.findIndex((check) => check.id === 'cli-version');
  expect(at, result.stdout).toBeGreaterThan(0);
  expect(checks[at - 1]?.id).toBe('install-channel');
  expect(checks[at]).toMatchObject({ status: 'warn', remedy: 'npm install' });
});
