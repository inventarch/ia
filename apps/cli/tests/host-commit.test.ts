import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { COPILOT_FOLDER } from '@inventarch/distribution/hosts';
import { sourcesDigest } from '@inventarch/runtime/method';
import { initialized } from './host-fixture.js';
import { run, scratch } from './workspace-fixture.js';

/**
 * `--commit` records the default kits package (contract C7) from `npm view`, which `IA_NPM` replaces with
 * tests/fake-npm.mjs: it prints `FAKE_NPM_VIEW` and logs each call to `IA_NPM_LOG`.
 */
const FAKE_NPM = fileURLToPath(new URL('./fake-npm.mjs', import.meta.url));
const INTEGRITY = `sha512-${'F'.repeat(86)}==`;
const KIT_ARCHIVE = 'd'.repeat(64);
const manifest = (sources = 'e'.repeat(64)) => ({
  name: '@inventarch/public-kits',
  version: '1.0.0',
  license: 'Apache-2.0',
  dist: { integrity: INTEGRITY, tarball: 'https://registry.npmjs.org/@inventarch/public-kits/-/public-kits-1.0.0.tgz' },
  ia: {
    format: 1,
    kits: [{ id: 'inventarch/ia-kb-kit', version: '0.9.0', archive: KIT_ARCHIVE, sources, folder: 'ia-kb' }],
  },
});
const npm = <E extends Record<string, string>>(env: E, view: unknown = manifest()) => {
  const log = join(scratch('npm'), 'calls.jsonl');
  return { env: { ...env, IA_NPM: FAKE_NPM, IA_NPM_LOG: log, FAKE_NPM_VIEW: JSON.stringify(view) }, log };
};
const calls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
const lockOf = (root: string) => JSON.parse(readFileSync(resolve(root, '.ia/distributions.lock.json'), 'utf8'));
const ENTRY = {
  kind: 'package',
  name: '@inventarch/public-kits',
  version: '1.0.0',
  integrity: INTEGRITY,
  kits: [{ id: 'inventarch/ia-kb-kit', version: '0.9.0', archive: KIT_ARCHIVE }],
};
const kitsLaunch = (door: string, version = '1.0.0') => [
  '-y',
  '-p',
  `@inventarch/mcp-door@${door}`,
  '-p',
  `@inventarch/public-kits@${version}`,
  'ia-mcp-door',
  '--kits-package',
  '@inventarch/public-kits',
];

it('plans, writes and removes the committed bootstrap for Copilot, with no machine-local path', async () => {
  const { root, env: base } = await initialized();
  const { env, log } = npm(base);
  const before = lockOf(root);
  expect(before.engine).toBe('0.1.1');
  const planned = await run(['host', 'copilot', '--commit', '--root', root, '--json'], { env });
  expect(planned.exitCode, planned.stdout).toBe(0);
  const plan = JSON.parse(planned.stdout) as { door: string };
  const version = plan.door.slice('@inventarch/mcp-door@'.length);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(plan).toEqual({
    version: 1,
    command: 'host',
    host: 'copilot',
    mode: 'commit',
    remove: false,
    door: `@inventarch/mcp-door@${version}`,
    kitsPackage: {
      name: '@inventarch/public-kits',
      version: '1.0.0',
      integrity: INTEGRITY,
      kits: ['inventarch/ia-kb-kit'],
    },
    files: [
      { path: `${COPILOT_FOLDER}/copilot-instructions.md`, kind: 'instructions', action: 'create' },
      { path: 'AGENTS.md', kind: 'instructions', action: 'create' },
      { path: '.vscode/mcp.json', kind: 'mcp', action: 'create' },
      { path: `${COPILOT_FOLDER}/mcp.json`, kind: 'mcp', action: 'create' },
      { path: '.ia/distributions.lock.json', kind: 'lock', action: 'update' },
    ],
    applied: false,
  });
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  // A plan writes nothing, the lock included; it asked npm for the latest version.
  expect(lockOf(root)).toEqual(before);
  expect(calls(log)).toEqual([['view', '@inventarch/public-kits@latest', '--json']]);
  const applied = await run(['host', 'copilot', '--commit', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  for (const path of [
    `${COPILOT_FOLDER}/copilot-instructions.md`,
    'AGENTS.md',
    '.vscode/mcp.json',
    `${COPILOT_FOLDER}/mcp.json`,
  ]) {
    const text = readFileSync(resolve(root, path), 'utf8');
    expect(text).not.toContain(root);
    expect(text).not.toContain(env.IA_HOST_HOME);
  }
  expect(JSON.parse(readFileSync(resolve(root, '.vscode/mcp.json'), 'utf8')).servers.ia.args).toEqual(
    kitsLaunch(version),
  );
  expect(readFileSync(resolve(root, 'AGENTS.md'), 'utf8')).toContain('`ia_session`');
  // The lock gains the one package entry beside its releases, under the engine that reads it; nothing is vendored.
  const after = lockOf(root);
  expect(after).toEqual({ ...before, engine: '^0.1.2', entries: [ENTRY] });
  expect(existsSync(resolve(root, 'node_modules'))).toBe(false);
  // A rerun keeps the version the lock pins and asks npm nothing.
  const asked = calls(log).length;
  const again = await run(['host', 'copilot', '--commit', '--root', root, '--json'], { env });
  expect(JSON.parse(again.stdout).files.find((file: { kind: string }) => file.kind === 'lock').action).toBe(
    'unchanged',
  );
  expect(calls(log)).toHaveLength(asked);
  const removed = await run(['host', 'copilot', '--commit', '--remove', '--apply', '--yes', '--root', root, '--json'], {
    env,
  });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(existsSync(resolve(root, 'AGENTS.md'))).toBe(false);
  expect(existsSync(resolve(root, `${COPILOT_FOLDER}/mcp.json`))).toBe(false);
  // A removal keeps the lock entry another host's bootstrap may still start.
  expect(lockOf(root).entries).toEqual([ENTRY]);
});

it('pins --kits-package-version through npm view, and refuses a package npm cannot describe', async () => {
  const { root, env: base } = await initialized();
  const { env, log } = npm(base);
  const pinned = await run(
    ['host', 'claude', '--commit', '--kits-package-version', '1.2.0', '--apply', '--yes', '--root', root, '--json'],
    { env },
  );
  expect(pinned.exitCode, pinned.stdout).toBe(0);
  expect(calls(log).at(-1)).toEqual(['view', '@inventarch/public-kits@1.2.0', '--json']);
  expect(lockOf(root).entries[0].version).toBe('1.2.0');
  const door = JSON.parse(pinned.stdout).door.slice('@inventarch/mcp-door@'.length);
  expect(JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')).mcpServers.ia.args).toEqual(
    kitsLaunch(door, '1.2.0'),
  );
  const missing = await run(
    ['host', 'codex', '--commit', '--kits-package-version', '2.0.0', '--root', root, '--json'],
    {
      env: { ...env, FAKE_NPM_VIEW: '' },
    },
  );
  expect(missing.exitCode).toBe(3);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    code: 'IA-CLI-KITS-PACKAGE-UNAVAILABLE',
    message: expect.stringContaining(
      'npm view @inventarch/public-kits@2.0.0 did not describe the default kits package',
    ),
    next: expect.stringContaining('--kits-package-version <version>'),
  });
  const noKits = await run(['host', 'codex', '--commit', '--kits-package-version', '2.0.0', '--root', root, '--json'], {
    env: { ...env, FAKE_NPM_VIEW: JSON.stringify({ ...manifest(), ia: undefined }) },
  });
  expect(JSON.parse(noKits.stdout)).toMatchObject({
    code: 'IA-CLI-KITS-PACKAGE-UNAVAILABLE',
    message: expect.stringContaining('no format 1 ia.kits list'),
  });
  expect(
    (await run(['host', 'claude', '--kits-package-version', '1.0.0', '--root', root, '--json'], { env })).exitCode,
  ).toBe(2);
  expect(
    (await run(['host', 'claude', '--commit', '--kits-package-version', 'latest', '--root', root, '--json'], { env }))
      .exitCode,
  ).toBe(2);
});

/** The package where `npm install` would put it in the workspace: kits/ia-kb holds the release ia.kits claims. */
function installPackage(root: string, version = '1.0.0'): string {
  const location = resolve(root, 'node_modules', '@inventarch', 'public-kits');
  const kit = join(location, 'kits', 'ia-kb');
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(kit, path)), { recursive: true });
    writeFileSync(join(kit, path), JSON.stringify(value, null, 2) + '\n');
  };
  put('.ia/release.json', { id: 'inventarch/ia-kb-kit', version: '0.9.0' });
  put('releases.json', {
    format: 2,
    kit: 'inventarch/ia-kb-kit',
    latest: '0.9.0',
    releases: [{ version: '0.9.0', archive: KIT_ARCHIVE, file: 'releases/0.9.0.json' }],
  });
  put('releases/0.9.0.json', {
    format: 2,
    kit: 'inventarch/ia-kb-kit',
    version: '0.9.0',
    archive: KIT_ARCHIVE,
    records: [],
  });
  const { dist: _dist, ...packageJson } = manifest(sourcesDigest(kit));
  writeFileSync(join(location, 'package.json'), JSON.stringify({ ...packageJson, version }, null, 2) + '\n');
  return location;
}

it('validates and restores a lock entry: default kits not installed, installed, then drift by the field', async () => {
  const { root, env: base } = await initialized();
  const { env } = npm(base);
  expect(
    (await run(['host', 'claude', '--commit', '--apply', '--yes', '--root', root, '--json'], { env })).exitCode,
  ).toBe(0);
  const validate = async () => {
    const result = await run(['validate', '--root', root, '--json'], { env });
    return { exitCode: result.exitCode, rows: JSON.parse(result.stdout).kitsPackages };
  };
  expect(await validate()).toMatchObject({
    exitCode: 0,
    rows: [{ name: '@inventarch/public-kits', version: '1.0.0', state: 'not-installed' }],
  });
  const human = await run(['validate', '--root', root], { env });
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(
    'Default kits not installed: the lock names @inventarch/public-kits@1.0.0 (inventarch/ia-kb-kit), which is not at',
  );
  const restored = await run(['restore', '--offline', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(restored.exitCode, restored.stdout).toBe(0);
  expect(JSON.parse(restored.stdout).kitsPackages).toMatchObject([{ state: 'not-installed' }]);
  installPackage(root);
  expect(await validate()).toMatchObject({ exitCode: 0, rows: [{ state: 'installed' }] });
  installPackage(root, '1.0.1');
  expect(await validate()).toMatchObject({
    exitCode: 1,
    rows: [{ state: 'drift', field: 'version', message: expect.stringContaining('in version: it has 1.0.1') }],
  });
  const refused = await run(['restore', '--offline', '--apply', '--yes', '--root', root, '--json'], { env });
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'IA-DIST-KITS-PACKAGE-DRIFT' });
});

it('sends Copilot without --commit to the committed bootstrap, and refuses --commit for Cursor', async () => {
  const { root, env } = await initialized();
  const plain = await run(['host', 'copilot', '--root', root, '--json'], { env });
  expect(plain.exitCode).toBe(3);
  expect(JSON.parse(plain.stdout)).toMatchObject({
    code: 'IA-DIST-HOST-UNSUPPORTED',
    message: 'GitHub Copilot takes only the committed bootstrap; nothing was written',
  });
  expect((await run(['host', 'cursor', '--commit', '--root', root, '--json'], { env })).exitCode).toBe(2);
  expect((await run(['host', 'claude', '--commit', '--user', '--json'], { env })).exitCode).toBe(2);
});
