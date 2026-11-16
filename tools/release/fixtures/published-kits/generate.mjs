#!/usr/bin/env node
/**
 * Regenerates this folder's published-kits fixture from an extracted `@inventarch/public-kits` npm package:
 *
 *   npm pack @inventarch/public-kits@<version>   # in a scratch folder
 *   tar -xzf inventarch-public-kits-<version>.tgz
 *   node tools/release/fixtures/published-kits/generate.mjs <scratch>/package
 *
 * It writes `kits.json.gz`: a gzipped JSON object from each path under `kits/<kit>/` of every kit in `KITS` to its UTF-8
 * text, unchanged. The whole kit folder is kept because `ia floor --verify` reads the kit's manifest, which refuses a
 * declared asset that is missing. Record the package version and its npm integrity in `PROVENANCE.json` after a run.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const KITS = ['ia-authoring', 'ia-kb', 'ia-method'];

const [packageArgument] = process.argv.slice(2);
if (!packageArgument) {
  process.stderr.write('Usage: generate.mjs <extracted @inventarch/public-kits package folder>\n');
  process.exit(2);
}
const packageRoot = resolve(packageArgument);
const files = {};
const walk = (folder) => {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path);
    else files[relative(packageRoot, path).split('\\').join('/')] = readFileSync(path, 'utf8');
  }
};
for (const kit of KITS) walk(join(packageRoot, 'kits', kit));
const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'kits.json.gz');
writeFileSync(out, gzipSync(JSON.stringify(sorted), { level: 9 }));
process.stdout.write(`Wrote ${Object.keys(sorted).length} files of ${KITS.join(', ')} to ${out}\n`);
