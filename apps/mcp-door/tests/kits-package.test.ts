import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyInstallation, planInstallation } from '@inventarch/distribution/install';
import { readReleases, sourcesDigest } from '@inventarch/runtime/method';
import { packageBeside } from '../src/main.js';
import { MethodTools } from '../src/method.js';

/**
 * The door at a workspace whose lock records the npm package of default kits as one `package` entry (contract C7). The
 * package is a local stand-in for the unpublished `@inventarch/public-kits`: `fixtures/kits-package/package.template.json`
 * with the ia-kb kit of `fixtures/method/plugin.json.gz` copied into its `kits/ia-kb/` (provenance in
 * `fixtures/kits-package/PROVENANCE.json`), installed under the workspace's `node_modules`.
 */
const fixtures = new URL('./fixtures/', import.meta.url);
const NAME = '@inventarch/public-kits';
const INTEGRITY = `sha512-${'D'.repeat(86)}==`;
let root: string, consumer: string, plugin: string, location: string, env: NodeJS.ProcessEnv;
let manifest: Record<string, unknown>;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-door-kits-package-')));
  const files = JSON.parse(
    gunzipSync(readFileSync(new URL('method/plugin.json.gz', fixtures))).toString('utf8'),
  ) as Record<string, string>;
  plugin = join(root, 'plugin');
  consumer = join(root, 'consumer');
  location = join(consumer, 'node_modules', '@inventarch', 'public-kits');
  for (const [path, text] of Object.entries(files)) {
    const targets = [join(plugin, path)];
    if (path.startsWith('config/kits/ia-kb/')) targets.push(join(location, 'kits', path.slice('config/kits/'.length)));
    for (const target of targets) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  const kitDir = join(location, 'kits', 'ia-kb');
  const releases = readReleases(kitDir);
  const latest = releases.releases.find((row) => row.version === releases.latest)!;
  const template = JSON.parse(readFileSync(new URL('kits-package/package.template.json', fixtures), 'utf8')) as {
    ia: { kits: Record<string, unknown>[] };
  };
  manifest = {
    ...template,
    ia: {
      ...template.ia,
      kits: [{ ...template.ia.kits[0], archive: latest.archive, sources: sourcesDigest(kitDir) }],
    },
  };
  writeFileSync(join(location, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // An installed generation whose lock holds only the package entry: nothing is vendored.
  mkdirSync(join(consumer, '.ia', 'src'), { recursive: true });
  copyFileSync(new URL('method/bindings.json', fixtures), join(consumer, '.ia', 'bindings.json'));
  const lock = {
    formatVersion: 1,
    engine: '^0.1.2',
    requests: [],
    packages: [],
    entries: [
      {
        kind: 'package',
        name: NAME,
        version: '1.0.0',
        integrity: INTEGRITY,
        kits: [{ id: releases.kit, version: latest.version, archive: latest.archive }],
      },
    ],
  };
  applyInstallation(planInstallation(consumer, lock, 'install'));
  env = { ...process.env, IA_HOME: join(root, 'home') };
  for (const name of ['IA_KITS_DIR', 'IA_KITS_PACKAGE', 'IA_CORE_RUN_ROOT', 'IA_CORE_CLOSURES_DIR']) delete env[name];
  mkdirSync(join(root, 'cache'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tools = (kits?: string): MethodTools =>
  new MethodTools({ root: consumer, env, cache: join(root, 'cache'), ...(kits === undefined ? {} : { kits }) });

it('resolves a binding to a kit the lock names through its package, as installed', () => {
  const door = tools();
  const session = door.call('method:session', {}).value as Record<string, unknown>;
  expect(session).toMatchObject({
    kits: [{ kit: 'inventarch/ia-kb-kit', version: '0.9.0', source: 'package' }],
    packages: [{ name: NAME, version: '1.0.0', kits: ['inventarch/ia-kb-kit'], state: 'installed' }],
  });
  expect(String(session['briefing'])).not.toContain('Default kits not installed');
  const catalogue = door.call('method:catalogue', { lane: 'knowledge', word: 'find' }).value as {
    items: Record<string, unknown>[];
  };
  expect(catalogue.items).toMatchObject([{ key: 'knowledge.find', kit: 'inventarch/ia-kb-kit', state: 'bound' }]);
  const answer = door.call('method:method', { key: 'knowledge.find' });
  expect(answer.ok, JSON.stringify(answer.value)).toBe(true);
  const packet = answer.value as { closure: Record<string, unknown>; envelope: Record<string, unknown> };
  expect(packet.closure).toMatchObject({ kit: 'inventarch/ia-kb-kit', version: '0.9.0' });
  expect(packet.envelope).toMatchObject({ kitInstalled: true, kitPackage: `${NAME}@1.0.0` });
}, 120_000);

it('refuses a drifted package by the field, and never falls back to the bundled copy', () => {
  writeFileSync(join(location, 'package.json'), JSON.stringify({ ...manifest, version: '1.0.1' }, null, 2) + '\n');
  try {
    const door = tools(join(plugin, 'config', 'kits'));
    expect(door.call('method:method', { key: 'knowledge.find' }).value).toMatchObject({
      error: {
        code: 'IA-CORE-KITS-PACKAGE-DRIFT',
        message: expect.stringContaining('differs from .ia/distributions.lock.json in version: it has 1.0.1'),
      },
    });
    expect(door.call('method:session', {}).value).toMatchObject({
      kits: [],
      packages: [{ state: 'drift' }],
      briefing: expect.stringContaining('Kits package drift'),
    });
  } finally {
    writeFileSync(join(location, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
});

it('reports default kits not installed in ia_session when the package the lock names is absent', () => {
  const moved = join(root, 'moved');
  renameSync(location, moved);
  try {
    const door = tools(join(plugin, 'config', 'kits'));
    const session = door.call('method:session', {}).value as Record<string, unknown>;
    expect(session).toMatchObject({
      kits: [],
      packages: [{ name: NAME, version: '1.0.0', state: 'not-installed' }],
    });
    expect(String(session['briefing'])).toContain(`Default kits not installed: the lock records ${NAME}@1.0.0`);
    expect(door.call('method:method', { key: 'knowledge.find' }).value).toMatchObject({
      error: { code: 'IA-CORE-KITS-PACKAGE-MISSING', message: expect.stringContaining('default kits not installed') },
    });
    // The folder the door's --kits-package resolved, or IA_KITS_PACKAGE, is read instead of node_modules.
    const named = new MethodTools({ root: consumer, env, cache: join(root, 'cache'), kitsPackage: moved });
    expect(named.call('method:session', {}).value).toMatchObject({ packages: [{ state: 'installed' }] });
  } finally {
    renameSync(moved, location);
  }
});

it('finds the kits package npx installs beside the door', () => {
  const door = join(root, 'npx', 'node_modules', '@inventarch', 'mcp-door', 'dist');
  const kits = join(root, 'npx', 'node_modules', '@inventarch', 'public-kits');
  mkdirSync(door, { recursive: true });
  mkdirSync(kits, { recursive: true });
  writeFileSync(join(kits, 'package.json'), JSON.stringify({ name: NAME }));
  expect(packageBeside(NAME, door)).toBe(kits);
  expect(packageBeside('@inventarch/absent', door)).toBeUndefined();
  expect(packageBeside('../escape', door)).toBeUndefined();
});
