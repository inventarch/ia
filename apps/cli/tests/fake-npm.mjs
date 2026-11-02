// Test double for npm (src/kits-package.ts). Each call's argv is appended to $IA_NPM_LOG when that is set.
// - `view <spec> --json` prints $FAKE_NPM_VIEW, a JSON manifest, with `version` set to the spec's exact version when it
//   names one; with $FAKE_NPM_VIEW unset it prints an npm E404 and exits 1.
// - `cache add <spec>` copies $FAKE_NPM_TARBALL into $FAKE_NPM_CACHE's content-addressed store, where npm's cacache
//   keeps it (`_cacache/content-v2/sha512/<h[0:2]>/<h[2:4]>/<h[4:]>`); unset, it exits 1.
// - `config get cache` prints $FAKE_NPM_CACHE.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.IA_NPM_LOG) appendFileSync(process.env.IA_NPM_LOG, JSON.stringify(args) + '\n');
const fail = (message) => {
  process.stderr.write(`npm error ${message}\n`);
  process.exit(1);
};
if (args[0] === 'config' && args[1] === 'get' && args[2] === 'cache') {
  process.stdout.write(`${process.env.FAKE_NPM_CACHE ?? ''}\n`);
  process.exit(0);
}
if (args[0] === 'cache' && args[1] === 'add') {
  const tarball = process.env.FAKE_NPM_TARBALL,
    cache = process.env.FAKE_NPM_CACHE;
  if (!tarball || !cache) fail(`code E404 404 Not Found - GET https://registry.npmjs.org/${args[2] ?? ''}`);
  const hex = createHash('sha512').update(readFileSync(tarball)).digest('hex');
  const target = join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(tarball, target);
  process.exit(0);
}
const view = process.env.FAKE_NPM_VIEW;
if (args[0] !== 'view' || args[2] !== '--json' || !view)
  fail(`code E404 404 Not Found - GET https://registry.npmjs.org/${args[1] ?? ''}`);
const manifest = JSON.parse(view);
const exact = /@(\d+\.\d+\.\d+)$/.exec(args[1] ?? '');
process.stdout.write(JSON.stringify(exact ? { ...manifest, version: exact[1] } : manifest, null, 2) + '\n');
