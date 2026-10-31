import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import { packDistribution } from '@inventarch/distribution/pack';
import { folderKits, readReleases } from '@inventarch/runtime/method';
import { MethodTools, restoreKit } from '../src/method.js';
import { Protocol } from '../src/protocol.js';

/**
 * The door at a workspace whose lock installs kits from an npm package of kits (contract C7b, ia-kb `dec-133`). npm is
 * transport only: the engine installs the package entry's kits as ordinary releases in the workspace store, and the
 * door reads them from there. The kit is the ia-kb kit of `fixtures/method/plugin.json.gz` (marketplace 63f5d75,
 * Apache-2.0; `fixtures/method/PROVENANCE.json`), packed here with this package's language base into exactly the
 * archive its `releases.json` names for 0.9.0, so the entry pins the published release.
 */
const fixtures = new URL('./fixtures/', import.meta.url);
const BASE = JSON.parse(readFileSync(new URL('../assets/base.json', import.meta.url), 'utf8')) as {
  id: string;
  version: string;
  archive: string;
  manifest: string;
};
let root: string, consumer: string, plugin: string, env: NodeJS.ProcessEnv;
let kit: { id: string; version: string; archive: string; manifest: string; bytes: Buffer };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-door-installed-kits-')));
  const files = JSON.parse(
    gunzipSync(readFileSync(new URL('method/plugin.json.gz', fixtures))).toString('utf8'),
  ) as Record<string, string>;
  plugin = join(root, 'plugin');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(plugin, path)), { recursive: true });
    writeFileSync(join(plugin, path), text);
  }
  // `ia pack` of the fixture kit, in a copy restored with the language base it locks.
  const source = join(root, 'kits', 'ia-kb');
  for (const [path, text] of Object.entries(files))
    if (path.startsWith('config/kits/ia-kb/')) {
      const target = join(source, path.slice('config/kits/ia-kb/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  restoreKit(source, folderKits(join(root, 'kits'))[0]!);
  const packed = packDistribution(source, readFileSync(join(source, '.ia', 'release.json'), 'utf8'));
  const released = readReleases(source).releases.find((row) => row.version === '0.9.0')!;
  kit = {
    id: packed.manifest.id,
    version: packed.manifest.version,
    archive: packed.archiveDigest,
    manifest: packed.manifestDigest,
    bytes: packed.bytes,
  };
  expect([kit.archive, kit.manifest]).toEqual([released.archive, released['manifest']]);
  // A workspace that installs the language base by request and the kit through one package entry.
  consumer = join(root, 'consumer');
  mkdirSync(join(consumer, '.ia', 'src'), { recursive: true });
  copyFileSync(new URL('method/bindings.json', fixtures), join(consumer, '.ia', 'bindings.json'));
  cacheArchive(consumer, readFileSync(new URL(`../assets/base/${BASE.archive}.ia.tgz`, import.meta.url)), BASE.archive);
  cacheArchive(consumer, kit.bytes, kit.archive);
  applyInstallation(
    planInstallation(
      consumer,
      {
        formatVersion: 1,
        engine: '^0.1.2',
        requests: [{ id: BASE.id, range: `^${BASE.version}` }],
        packages: [
          {
            id: BASE.id,
            version: BASE.version,
            archive: BASE.archive,
            manifest: BASE.manifest,
            location: `sha256:${BASE.archive}`,
            dependencies: [],
          },
        ],
        entries: [
          {
            kind: 'package',
            name: '@inventarch/public-kits',
            version: '1.0.0',
            integrity: `sha512-${'D'.repeat(86)}==`,
            kits: [
              {
                id: kit.id,
                version: kit.version,
                archive: kit.archive,
                manifest: kit.manifest,
                dependencies: [BASE.id],
              },
            ],
          },
        ],
      },
      'install',
    ),
  );
  env = { ...process.env, IA_HOME: join(root, 'home') };
  for (const name of ['IA_KITS_DIR', 'IA_CORE_RUN_ROOT', 'IA_CORE_CLOSURES_DIR']) delete env[name];
  mkdirSync(join(root, 'cache'));
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tools = (kits?: string): MethodTools =>
  new MethodTools({ root: consumer, env, cache: join(root, 'cache'), ...(kits === undefined ? {} : { kits }) });

it('reads a kit the package entry installs from the workspace store, as an installed release', () => {
  const door = tools();
  const session = door.call('method:session', {}).value as Record<string, unknown>;
  expect(session, JSON.stringify(session)).toMatchObject({
    kits: [{ kit: 'inventarch/ia-kb-kit', version: '0.9.0', source: 'installed' }],
  });
  expect(session).not.toHaveProperty('restore');
  expect(door.call('method:catalogue', { lane: 'knowledge', word: 'find' }).value).toMatchObject({
    items: [{ key: 'knowledge.find', kit: 'inventarch/ia-kb-kit', state: 'bound' }],
  });
  const answer = door.call('method:method', { key: 'knowledge.find' });
  expect(answer.ok, JSON.stringify(answer.value)).toBe(true);
  const packet = answer.value as { closure: Record<string, unknown>; envelope: Record<string, unknown> };
  expect(packet.closure).toMatchObject({ kit: 'inventarch/ia-kb-kit', version: '0.9.0', archive: kit.archive });
  expect(packet.envelope).toMatchObject({ kitInstalled: true });
  // The bundled copy of the same kit is never read in its place.
  const bundled = tools(join(plugin, 'config', 'kits')).call('method:session', {}).value as { kits: unknown[] };
  expect(bundled.kits).toEqual([{ kit: 'inventarch/ia-kb-kit', version: '0.9.0', source: 'installed' }]);
}, 120_000);

it('tells a fresh clone to run ia restore, and never answers the kit from another copy', () => {
  const installed = join(consumer, '.ia', 'distributions');
  const moved = join(root, 'distributions');
  renameSync(installed, moved);
  try {
    const door = tools(join(plugin, 'config', 'kits'));
    const session = door.call('method:session', {}).value as Record<string, unknown>;
    expect(session, JSON.stringify(session)).toMatchObject({
      workspace: null,
      kits: [],
      restore: { kits: ['inventarch/ia-kb-kit@0.9.0'] },
    });
    expect((session['restore'] as { message: string }).message).toContain('run ia restore');
    expect(String(session['briefing'])).toContain('Kits not restored:');
    expect(door.call('method:method', { key: 'knowledge.find' }).ok).toBe(false);
    // The protocol still starts, as a door launched in a fresh clone does: the method tools answer, the read tools refuse.
    const protocol = new Protocol(consumer, { kits: join(plugin, 'config', 'kits'), env, cache: join(root, 'cache') });
    protocol.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    protocol.request({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const call = (name: string) =>
      protocol.request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: name === 'ia_session' ? {} : { operation: 'x' } },
      })?.result as { structuredContent: Record<string, unknown>; isError: boolean };
    expect(call('ia_session').structuredContent).toMatchObject({ restore: { kits: ['inventarch/ia-kb-kit@0.9.0'] } });
    protocol.close();
  } finally {
    renameSync(moved, installed);
  }
});
