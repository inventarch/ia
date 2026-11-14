#!/usr/bin/env node
/**
 * Regenerates this folder's method fixture from a checkout of the public marketplace and a built ia CLI:
 *
 *   node apps/mcp-door/tests/fixtures/method/generate.mjs <marketplace checkout> <ia CLI dist/main.js>
 *
 * It writes `plugin.json.gz` (the `ia` plugin's scripts and support files and the `ia-kb` kit, each path to its UTF-8 text),
 * then runs that plugin's own `resolve.mjs` for `knowledge.find` and `knowledge.check` in one task over a consumer whose
 * `.ia/bindings.json` is `bindings.json` and whose lock installs the ia-kb kit and the language base it depends on
 * (the kit's published archive and the bundled base archive, through this checkout's own `planInstallation` and
 * `applyInstallation`, so the lock and its active generation agree), and writes each packet as `golden-<activity>.json` and the task pin as
 * `golden-pin.json`. The temporary root is written `<ROOT>` with forward slashes, the envelope is removed, and each
 * packet's digest is recomputed over that content with the plugin's own `packetDigest`. Record the marketplace commit
 * in `PROVENANCE.json` after a run.
 *
 * The plugin is written exactly as published: the kit's lock pins the language base its release was packed on, and the
 * CLI's `ia restore` that `resolve.mjs` runs carries every published base, so it restores the kit on that base exactly.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const [marketplaceArgument, cliArgument] = process.argv.slice(2);
if (!marketplaceArgument || !cliArgument) {
  process.stderr.write('Usage: generate.mjs <marketplace checkout> <ia CLI dist/main.js>\n');
  process.exit(2);
}
const out = dirname(fileURLToPath(import.meta.url));
const marketplace = resolve(marketplaceArgument);
const cli = resolve(cliArgument);
const plugin = join(marketplace, 'plugins', 'ia');
const { packetDigest } = await import(pathToFileURL(join(plugin, 'scripts', 'lib', 'packet.mjs')).href);
const SUBJECT = 'the decision records';

/** Installs the kit and its language base into the consumer through the checkout's built distribution package. */
async function install(consumer) {
  const repository = resolve(out, '../../../../..');
  const { applyInstallation, cacheArchive, planInstallation } = await import(
    pathToFileURL(join(repository, 'apps', 'distribution', 'dist', 'install.js')).href
  );
  const base = JSON.parse(readFileSync(join(repository, 'apps', 'mcp-door', 'assets', 'base.json'), 'utf8'));
  const kits = join(repository, 'apps', 'cli', 'tests', 'fixtures', 'kits-package');
  const kit = JSON.parse(readFileSync(join(kits, 'package.json.txt'), 'utf8')).ia.kits[0];
  cacheArchive(
    consumer,
    readFileSync(join(repository, 'apps', 'mcp-door', 'assets', 'base', `${base.archive}.ia.tgz`)),
    base.archive,
  );
  cacheArchive(consumer, readFileSync(join(kits, 'archives', `${kit.archive}.ia.tgz`)), kit.archive);
  const row = (release, dependencies) => ({
    id: release.id,
    version: release.version,
    archive: release.archive,
    manifest: release.manifest,
    location: `sha256:${release.archive}`,
    dependencies,
  });
  applyInstallation(
    planInstallation(
      consumer,
      {
        formatVersion: 1,
        engine: '^0.1.2',
        requests: [
          { id: kit.id, range: `^${kit.version}` },
          { id: base.id, range: `^${base.version}` },
        ],
        packages: [row(kit, [base.id]), row(base, [])],
      },
      'install',
    ),
  );
}

const files = {};
const add = (root, prefix, dir = root) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) add(root, prefix, path);
    else files[prefix + relative(root, path).split('\\').join('/')] = readFileSync(path, 'utf8');
  }
};
add(join(plugin, 'scripts'), 'scripts/');
for (const path of ['.claude-plugin/plugin.json', 'config/qualified-process-tools.json'])
  files[path] = readFileSync(join(plugin, path), 'utf8');
add(join(marketplace, 'kits', 'ia-kb'), 'config/kits/ia-kb/');
writeFileSync(join(out, 'plugin.json.gz'), gzipSync(Buffer.from(JSON.stringify(files)), { level: 9 }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-method-golden-')));
try {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'plugin', path)), { recursive: true });
    writeFileSync(join(root, 'plugin', path), text);
  }
  mkdirSync(join(root, 'consumer', '.ia', 'src'), { recursive: true });
  cpSync(join(out, 'bindings.json'), join(root, 'consumer', '.ia', 'bindings.json'));
  await install(join(root, 'consumer'));
  mkdirSync(join(root, 'tmp'));
  const env = {
    ...process.env,
    IA_HOME: join(root, 'home'),
    IA_CORE_KITS_DIR: join(root, 'plugin', 'config', 'kits'),
    IA_CLI_PATH: cli,
    IA_CORE_HOST: 'golden',
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMPDIR: join(root, 'tmp'),
  };
  const swap = (value) => {
    if (typeof value === 'string')
      return value.includes(root) ? value.split(root).join('<ROOT>').split('\\').join('/') : value;
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)]));
    return value;
  };
  const subject = `sha256:${createHash('sha256').update(SUBJECT, 'utf8').digest('hex')}`;
  for (const activity of ['find', 'check']) {
    const ran = spawnSync(
      process.execPath,
      [
        join(root, 'plugin', 'scripts', 'resolve.mjs'),
        ...['--entry', 'knowledge', '--activity', activity, '--root', join(root, 'consumer')],
        ...['--project', 'consumer', '--task', 'golden', '--subject', subject],
      ],
      { env, encoding: 'utf8' },
    );
    if (ran.status !== 0) throw new Error(`resolve.mjs ${activity} exited ${ran.status}: ${ran.stdout}${ran.stderr}`);
    const { envelope, ...packet } = JSON.parse(ran.stdout);
    if (packetDigest(packet) !== packet.digest)
      throw new Error(`resolve.mjs ${activity} printed a digest that drifted`);
    const golden = swap(packet);
    golden.digest = packetDigest(golden);
    writeFileSync(join(out, `golden-${activity}.json`), `${JSON.stringify(golden, null, 2)}\n`);
  }
  const { createdAt, ...pin } = JSON.parse(
    readFileSync(join(root, 'home', 'work-v1', 'consumer', 'golden', 'binding.json'), 'utf8'),
  );
  writeFileSync(join(out, 'golden-pin.json'), `${JSON.stringify(swap(pin), null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
