/**
 * The built `ia` without a terminal (consumer CLI contract §1.2 and §7.9's contract test): a piped bare `ia`, with or
 * without `CI`, prints byte-for-byte the help `ia --help` prints and the help rendered in-process, at exit 0, and never
 * opens the console. The CI-on-a-TTY half is console-entry.test.ts's, through the injected entry.
 */
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import type { Host } from '../src/consumer.js';
import { renderHelp } from '../src/consumer.js';
import { resolveCapabilities } from '../src/render.js';
import { EXTENSIONS, packageRoot, version } from '../src/self.js';

const main = resolve(import.meta.dirname, '../dist/main.js');
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 20_000;
const run = (args: readonly string[], env: NodeJS.ProcessEnv) =>
  runBounded(process.execPath, [main, ...args], { cwd: packageRoot, env, timeoutMs: SUBPROCESS });
const help = (env: NodeJS.ProcessEnv): string => {
  const terminal = { env, isTTY: false, columns: undefined };
  const host: Host = {
    cwd: packageRoot,
    env,
    stdout: terminal,
    stderr: terminal,
    interaction: { interactive: false, write: () => {}, read: () => Promise.resolve(null) },
    version: version(),
    packageRoot,
  };
  return renderHelp(host, resolveCapabilities(terminal, {}), EXTENSIONS);
};

it('bare ia without a terminal prints byte-identical help', async () => {
  const env = { ...process.env, CI: '' };
  const bare = await run([], env);
  const asked = await run(['--help'], env);
  expect(bare.status).toBe(0);
  expect(asked.status).toBe(0);
  expect(bare.stdout).toBe(asked.stdout);
  expect(bare.stdout).toBe(help(env));
  expect(bare.stdout).not.toContain('\x1b[?1049h');
  expect(bare.stderr).toBe('');
});
it('bare ia with CI set and piped stdio prints help', async () => {
  const env = { ...process.env, CI: '1' };
  const bare = await run([], env);
  expect(bare.status).toBe(0);
  expect(bare.stdout).toBe(help(env));
  expect(bare.stdout).not.toContain('\x1b[?1049h');
});
