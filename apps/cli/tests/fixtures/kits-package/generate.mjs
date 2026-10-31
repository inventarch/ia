// Makes this fixture again: a local stand-in for the npm package @inventarch/public-kits (contract C7b), carrying the
// IA archive of the ia-kb kit at 0.9.0. Usage, from the repository root after `pnpm build`:
//   node apps/cli/tests/fixtures/kits-package/generate.mjs apps/cli/dist/main.js
// It copies config/kits/ia-kb/** out of apps/mcp-door/tests/fixtures/method/plugin.json.gz (marketplace 63f5d75), runs
// `ia restore --offline --apply --yes` and `ia pack --descriptor .ia/release.json` there with the given CLI, checks the
// archive and manifest digests against the kit's releases.json row for 0.9.0, and writes the layout the marketplace's
// `tools/kit.mjs package --build` writes (inventarch/marketplace c3256c2, packages/public-kits): archives/<sha256>.ia.tgz,
// archives/<sha256>.distribution.json (the manifest, whose file sha256 is the manifest digest), kits/ia-kb/ (the
// sidecars and release history the archive lacks) and package.json, kept here as package.json.txt.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { canonicalDistributionJson } from '../../../../../packages/db/dist/distribution/index.js';
import { sourcesDigest } from '../../../../../packages/runtime/dist/method/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(process.argv[2] ?? 'apps/cli/dist/main.js');
const plugin = resolve(here, '../../../../mcp-door/tests/fixtures/method/plugin.json.gz');
const work = mkdtempSync(join(tmpdir(), 'ia-kits-package-'));
try {
  const kit = join(work, 'ia-kb');
  const files = JSON.parse(gunzipSync(readFileSync(plugin)).toString('utf8'));
  for (const [path, text] of Object.entries(files))
    if (path.startsWith('config/kits/ia-kb/')) {
      const target = join(kit, path.slice('config/kits/ia-kb/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  const env = { ...process.env, IA_HOME: join(work, 'home'), IA_HOST_HOME: join(work, 'host-home') };
  execFileSync(process.execPath, [cli, 'restore', '--offline', '--apply', '--yes', '--root', kit], { env });
  const packed = JSON.parse(
    execFileSync(process.execPath, [cli, 'pack', '--descriptor', '.ia/release.json', '--root', kit, '--json'], {
      env,
      encoding: 'utf8',
    }),
  );
  const row = JSON.parse(readFileSync(join(kit, 'releases.json'), 'utf8')).releases.find((r) => r.version === '0.9.0');
  if (packed.archive !== row.archive || packed.manifestDigest !== row.manifest)
    throw new Error(
      `packed ${packed.archive}/${packed.manifestDigest}, releases.json names ${row.archive}/${row.manifest}`,
    );
  mkdirSync(join(here, 'archives'), { recursive: true });
  writeFileSync(join(here, 'archives', packed.path), readFileSync(join(kit, '.ia', 'work', 'dist', packed.path)));
  writeFileSync(
    join(here, 'archives', `${packed.archive}.distribution.json`),
    canonicalDistributionJson(packed.manifest),
  );
  rmSync(join(here, 'kits'), { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    const rel = path.slice('config/kits/ia-kb/'.length);
    if (!path.startsWith('config/kits/ia-kb/') || !/^(?:[a-z]+\.json|releases\/[^/]+\.json)$/.test(rel)) continue;
    mkdirSync(dirname(join(here, 'kits', 'ia-kb', rel)), { recursive: true });
    writeFileSync(join(here, 'kits', 'ia-kb', rel), text);
  }
  const manifest = {
    name: '@inventarch/public-kits',
    version: '1.0.0',
    private: true,
    license: 'Apache-2.0',
    files: ['archives', 'kits'],
    ia: {
      format: 1,
      kits: [
        {
          id: packed.manifest.id,
          version: packed.manifest.version,
          archive: packed.archive,
          manifest: packed.manifestDigest,
          sources: sourcesDigest(kit),
          folder: 'ia-kb',
        },
      ],
    },
  };
  writeFileSync(join(here, 'package.json.txt'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`${packed.manifest.id}@${packed.manifest.version} ${packed.archive}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
