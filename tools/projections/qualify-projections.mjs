import { ensureQualification, installConsumer } from '../distribution/consumer.mjs';
import { parseOptions } from '../shared/args.mjs';
import '../temp/physical-temp.mjs';
import { compiledSystemFolders } from '../native/public-systems.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { readInputs } from '../../packages/db/dist/index.js';

const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env.npm_execpath;

if (!pnpm) throw new Error('Build first, then run pnpm projections:qualify');
let options;
try {
  options = parseOptions(process.argv.slice(2), { values: ['manifest'] });
} catch (error) {
  console.error(String(error));
  process.exit(2);
}
const selected = ensureQualification(root, pnpm, options.value('manifest'));
const temporary = mkdtempSync(resolve(tmpdir(), 'ia-packed-projections-'));
// Supported public qualification accepts no optional modes, so its temporary consumer is always removed.

const folders = [
  'packages/language',
  'packages/graph',
  'packages/compliance',
  'packages/db',
  'packages/runtime',
  'packages/workspace-runtime',
  ...compiledSystemFolders(root),
];
try {
  const consumer = resolve(temporary, 'consumer with spaces');
  const names = folders.map((folder) => JSON.parse(readFileSync(resolve(root, folder, 'package.json'), 'utf8')).name);
  const packed = selected.packed.filter((row) => names.includes(row.name));
  installConsumer(consumer, packed, pnpm, { name: 'independent-projections-consumer', names });

  const systems = readInputs(root, { adopted: [] }).sources.map((source) => source.path);
  for (const source of readInputs(root, { adopted: [] }).sources) {
    if (!systems.includes(source.path)) continue;
    const path = resolve(consumer, 'fixture/foundation', source.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.text);
  }
  cpSync(resolve(root, 'tools/projections/fixtures/synthetic-review'), resolve(consumer, 'fixture/synthetic-review'), {
    recursive: true,
  });
  cpSync(resolve(root, 'tools/projections/fixtures/compile-prose.mjs'), resolve(consumer, 'verify.mjs'));
  cpSync(resolve(root, 'tools/projections/fixtures/link-walk.mjs'), resolve(consumer, 'link-walk.mjs'));
  const output = execFileSync(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.match(output, /"packedProjections":true/);
  assert.equal(output.match(/"packedLinks":true/g)?.length, 3);
  console.log(output.trim());
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      packages: folders.length,
      qualification: 'isolated public package compilation and static files; distribution lifecycle remains open',
    }),
  );
} finally {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(resolve(tmpdir(), 'ia-packed-projections-')))
    throw new Error('Unsafe qualification cleanup');
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
