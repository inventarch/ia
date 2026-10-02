/**
 * Runs the generated session hook (packages/compliance/src/host-plugin.ts's `HOOK`) for real with `node`, covering
 * what packages/compliance/tests/host-plugin.test.ts does not: the hook's own 5s timeout, the once-per-day update
 * nudge, and two end-to-end runs against the actual built CLI as the hook's `ia doctor` entry (a non-workspace
 * directory, then a freshly initialized one). The end-to-end cases require a current `apps/cli/dist/main.js`:
 * run `pnpm --filter @ia/cli build` (and, transitively, `pnpm --filter @ia/distribution build` and
 * `pnpm --filter @ia/compliance build`) first.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { renderClaudePlugin } from '@ia/compliance';
import { runBounded } from '@tools/testing/subprocess.js';
import { cleanup, cli, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanup);

const FAKE = resolve(import.meta.dirname, 'fake-doctor.mjs');
const CLI_MAIN = resolve(cli, 'dist/main.js');

/** Renders the §6.1 plugin tree into a fresh scratch directory with `entry` as its recorded CLI, and returns the hook's path. */
function renderHook(entry: string): string {
  const dir = scratch('hook');
  for (const file of renderClaudePlugin({
    version: '0.1.0+x',
    cliVersion: '0.1.0',
    channel: 'npm',
    entry,
    install: 'npm i -g @inventarch/cli@latest.',
  })) {
    mkdirSync(dirname(resolve(dir, file.path)), { recursive: true });
    writeFileSync(resolve(dir, file.path), file.text);
  }
  return resolve(dir, 'plugins/ia/hooks/session-start.mjs');
}
function runHook(hookPath: string, env: NodeJS.ProcessEnv, timeout = 20_000) {
  return runBounded(process.execPath, [hookPath], { timeoutMs: timeout, env });
}
const session = (notice: string | null, nudge: string | null = null) =>
  JSON.stringify({ session: { context: ['line one', 'line two'], notice, nudge, refresh: null } });

it('reports a timeout instead of blocking the session, and exits well inside the SessionStart budget', async () => {
  const hookPath = renderHook(FAKE);
  const start = Date.now();
  const result = await runHook(
    hookPath,
    { ...process.env, FAKE_DOCTOR: 'sleep', CLAUDE_PROJECT_DIR: scratch('project') },
    15_000,
  );
  const elapsed = Date.now() - start;
  expect(result.status, result.stderr).toBe(0);
  // The hook's own spawnSync caps the doctor call at 5s; a generous margin over that absorbs process-spawn overhead
  // without masking a regression that let the timeout fall through to the hook's own 20s test-level ceiling.
  expect(elapsed).toBeLessThan(7_500);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toBe('IA status unavailable: ia doctor timed out.');
  expect(payload.systemMessage).toBeUndefined();
});

it('shows the update nudge at most once per local day, recording today in the plugin data directory', async () => {
  const hookPath = renderHook(FAKE);
  const data = scratch('plugin-data');
  const env = {
    ...process.env,
    FAKE_DOCTOR: session('IA: update', 'update'),
    CLAUDE_PROJECT_DIR: scratch('project'),
    CLAUDE_PLUGIN_DATA: data,
  };
  const first = await runHook(hookPath, env);
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).systemMessage).toBe('IA: update');
  const second = await runHook(hookPath, env);
  expect(second.status, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout).systemMessage).toBeUndefined();
  expect(readFileSync(resolve(data, 'nudged-on'), 'utf8')).toBe(new Date().toLocaleDateString('en-CA'));
});

it('shows the nudge again on a new local day rather than staying silent forever after the first', async () => {
  const hookPath = renderHook(FAKE);
  const data = scratch('plugin-data-stale');
  mkdirSync(data, { recursive: true });
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  writeFileSync(resolve(data, 'nudged-on'), yesterday);
  const env = {
    ...process.env,
    FAKE_DOCTOR: session('IA: update', 'update'),
    CLAUDE_PROJECT_DIR: scratch('project'),
    CLAUDE_PLUGIN_DATA: data,
  };
  const result = await runHook(hookPath, env);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).systemMessage).toBe('IA: update');
  expect(readFileSync(resolve(data, 'nudged-on'), 'utf8')).toBe(new Date().toLocaleDateString('en-CA'));
});

// The real `ia doctor` is read-only: clearing NODE_OPTIONS (as tests/host.test.ts does) keeps an inherited
// --conditions=development from repointing the built packages this hook loads at their source instead.
// IA_NO_UPDATE_CHECK: doctor would otherwise name a due refresh (spec §11.1) and the hook would start it detached,
// writing the scratch IA home after these assertions, and possibly after cleanup.
const e2eEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_OPTIONS: '',
  IA_NO_UPDATE_CHECK: '1',
  ...extra,
});

it('end to end: a non-workspace directory reports it without ever claiming to search the filesystem', async () => {
  const hookPath = renderHook(CLI_MAIN);
  const project = scratch('e2e-none');
  const iaHome = resolve(scratch('e2e-none-home-parent'), 'ia-home');
  const result = await runHook(hookPath, e2eEnv({ CLAUDE_PROJECT_DIR: project, IA_HOME: iaHome }), 30_000);
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toContain('not an InventArch workspace');
  expect(payload.hookSpecificOutput.additionalContext).toContain('Do not search the filesystem');
  expect(payload.systemMessage).toBeUndefined();
  // Doctor never writes: the IA home it was pointed at is still exactly as absent as it started.
  expect(existsSync(iaHome)).toBe(false);
});

// Two chained 30s spawnSync calls (init, then the hook) leave zero slack under the file's 60s testTimeout;
// this case gets its own budget so process-spawn variance on a loaded machine doesn't turn into a false failure.
it('end to end: a freshly initialized workspace reports it and offers Claude host registration', async () => {
  const iaHome = scratch('e2e-workspace-home');
  const project = resolve(scratch('e2e-workspace'), 'demo');
  const init = await runBounded(process.execPath, [CLI_MAIN, 'init', project, '--apply', '--yes'], {
    timeoutMs: 30_000,
    env: e2eEnv({ IA_HOME: iaHome }),
  });
  expect(init.status, init.stderr).toBe(0);

  const hookPath = renderHook(CLI_MAIN);
  const result = await runHook(hookPath, e2eEnv({ CLAUDE_PROJECT_DIR: project, IA_HOME: iaHome }), 30_000);
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toContain('InventArch workspace');
  expect(payload.systemMessage).toBe('IA: this workspace has no Claude host registration; run ia host claude --apply');
}, 90_000);
