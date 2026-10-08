// The installed-CLI scenario of `pnpm packages:qualify` (installed-views.mjs), run against this checkout's built CLI
// rather than the packed one, so its expectations meet the CLI in a gate that runs locally: packages:qualify itself
// packs and installs every public package, which only CI does.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { qualifyInstalledViews } from './installed-views.mjs';

const repository = resolve(import.meta.dirname, '../..'),
  temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'ia-installed-views-')));
afterAll(() => {
  if (!relative(realpathSync(tmpdir()), temporary).startsWith('ia-installed-views-'))
    throw new Error('Unsafe test cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it('meets the installed-CLI expectations of packages:qualify with the built CLI', () => {
  const cli = resolve(repository, 'apps/cli/dist/main.js'),
    cwd = resolve(temporary, 'cli consumer with spaces'),
    home = resolve(temporary, 'home'),
    workspace = resolve(temporary, 'workspace with spaces');
  for (const path of [cwd, home]) mkdirSync(path, { recursive: true });
  writeFileSync(
    resolve(cwd, 'offline.mjs'),
    "globalThis.fetch = () => { throw new Error('Installed CLI qualification must not use the network'); };\n",
  );
  // The environment packages:qualify gives the installed CLI: every home, cache and configuration under one directory.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    IA_HOME: resolve(home, 'ia'),
    IA_HOST_HOME: resolve(home, 'ia'),
    IA_CONFIG_HOME: resolve(home, 'config/ia'),
    IA_REGISTRY: '',
    IA_NO_UPDATE_CHECK: '1',
    APPDATA: resolve(home, 'AppData/Roaming'),
    LOCALAPPDATA: resolve(home, 'AppData/Local'),
    XDG_CONFIG_HOME: resolve(home, 'config'),
    XDG_CACHE_HOME: resolve(home, 'cache'),
    XDG_DATA_HOME: resolve(home, 'data'),
    CODEX_HOME: resolve(home, '.codex'),
    CLAUDE_CONFIG_DIR: resolve(home, '.claude'),
    NODE_OPTIONS: '',
    NO_COLOR: '1',
  };
  const invoke = (args: readonly string[]): string =>
    execFileSync(process.execPath, ['--import', './offline.mjs', cli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  expect(JSON.parse(invoke(['init', workspace, '--apply', '--yes', '--json'])).applied.status).toBe('initialized');
  invoke(['validate', '--root', workspace, '--json']);
  for (const host of ['claude', 'codex']) invoke(['host', host, '--root', workspace, '--apply', '--yes', '--json']);
  invoke(['validate', '--root', workspace, '--json']);
  expect(qualifyInstalledViews(cli, cwd, env, workspace)).toEqual([
    'capture idempotence',
    'read bodies and digests',
    'next dependency order and declared status',
    'read/next observe uncaptured edits',
    'read/next no writes',
    'read/capture/next refusals',
    'compile 1.x compatibility',
  ]);
}, 600_000);
