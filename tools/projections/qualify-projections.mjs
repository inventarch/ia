import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { readInputs } from '../../packages/db/dist/index.js';

const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Build first, then run pnpm projections:qualify');
const temporary = mkdtempSync(resolve(tmpdir(), 'ia-packed-projections-'));
const run = (args, cwd) => execFileSync(process.execPath, [pnpm, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const folders = [
  'packages/language',
  'packages/graph',
  'packages/compliance',
  'packages/db',
  'packages/runtime',
  '.ia/src/systems/session-system',
  '.ia/src/systems/agent-system',
  '.ia/src/systems/agent-composition-system',
];
folders.push('.ia/src/systems/template-system', '.ia/src/systems/authoring-system');
if (process.argv.length !== 2)
  throw new Error('Public projection qualification accepts no optional private or live-host modes');
try {
  const archives = resolve(temporary, 'archives'),
    consumer = resolve(temporary, 'consumer with spaces');
  mkdirSync(archives);
  mkdirSync(consumer);
  const dependencies = {};
  for (const folder of folders) {
    const path = resolve(root, folder),
      manifest = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
    run(['pack', '--pack-destination', archives], path);
    dependencies[manifest.name] =
      'file:' +
      resolve(archives, manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz').replaceAll(
        '\\',
        '/',
      );
  }
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'independent-prose-consumer',
        private: true,
        type: 'module',
        dependencies,
        pnpm: { overrides: dependencies },
      },
      null,
      2,
    ),
  );
  run(['install', '--prefer-offline', '--ignore-scripts'], consumer);
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
  const output = execFileSync(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.match(output, /"packedProjections":true/);
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
