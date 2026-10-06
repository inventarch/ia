import { packageManagerCommand } from '../entry/package-manager.mjs';
// Consume packaging-owner-selected artifacts. No build or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
const args = process.argv.slice(2);
assert(
  args.length === 5,
  'Usage: node tools/runtime/qualify-sdk.mjs <public-tree> <archives> <new-output> <pnpm-launcher> <offline-store>',
);
const [candidate, archives, output, pnpm, store] = args.map((value) => resolve(value));
const receipt = JSON.parse(readFileSync(resolve(candidate, '.git/ia-extraction.json'), 'utf8'));
assert(receipt.sourceRevision, 'Require a public extraction receipt');
const packages = [
  'language',
  'graph',
  'compliance',
  'db',
  'runtime',
  'session-system',
  'agent-system',
  'authoring-system',
  'template-system',
  'workspace-runtime',
  'agent-composition-system',
  'compliance-system',
  'governance-system',
  'hook-authoring-system',
  'learning-system',
  'work-system',
  'workspace-system',
];
const inventory = JSON.parse(readFileSync(resolve(archives, 'public-artifacts.json'), 'utf8')),
  dependencies = {},
  pins = [];
assert.equal(inventory.sourceRevision, receipt.sourceRevision, 'Artifact source revision mismatch');
assert.deepEqual(inventory.source, receipt, 'Artifact extraction receipt mismatch');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const file of receipt.files)
  assert.equal(digest(readFileSync(resolve(candidate, file.path))), file.sha256, `Changed candidate ${file.path}`);
for (const name of packages) {
  const matches = inventory.artifacts.filter((file) => file.name === `@inventarch/${name}`);
  assert.equal(matches.length, 1, `Select exactly one @inventarch/${name} archive`);
  assert(/^[A-Za-z0-9_.-]+\.tgz$/.test(matches[0].path), 'Unsafe selected archive path');
  const path = resolve(archives, matches[0].path),
    stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(digest(readFileSync(path)), matches[0].sha256, 'Selected archive digest mismatch');
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', basename(path), 'package/package.json'], {
      cwd: archives,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(packed.name, matches[0].name, 'Selected archive name mismatch');
  assert.equal(packed.version, matches[0].version, 'Selected archive version mismatch');
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [dependency, version] of Object.entries(packed[group] ?? {}))
      if (dependency.startsWith('@inventarch/')) {
        const selected = inventory.artifacts.filter((row) => row.name === dependency);
        assert(
          packages.some((name) => dependency === `@inventarch/${name}`),
          'SDK closure includes unselected workspace package',
        );
        assert.equal(selected.length, 1, 'Duplicate/missing SDK closure package');
        assert.equal(version, selected[0].version, 'SDK closure version mismatch');
      }
  dependencies[`@inventarch/${name}`] = `file:${path.replaceAll('\\', '/')}`;
  pins.push({
    package: `@inventarch/${name}`,
    archive: basename(path),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  });
}
mkdirSync(output);
writeFileSync(
  resolve(output, 'package.json'),
  JSON.stringify({ private: true, type: 'module', dependencies }, null, 2),
);
writeFileSync(
  resolve(output, 'pnpm-workspace.yaml'),
  JSON.stringify({ packages: ['.'], overrides: dependencies }, null, 2),
);
let nativeFiles = 0;
function copyNative(from, to) {
  assert(!lstatSync(from).isSymbolicLink(), 'Native candidate aliases refuse');
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (['node_modules', 'dist', '.git'].includes(name)) continue;
    const source = resolve(from, name),
      target = resolve(to, name),
      stat = lstatSync(source);
    assert(!stat.isSymbolicLink(), 'Native candidate aliases refuse');
    if (stat.isDirectory()) copyNative(source, target);
    else if (name.endsWith('.ia')) {
      copyFileSync(source, target);
      nativeFiles++;
    }
  }
}
copyNative(resolve(candidate, '.ia/src'), resolve(output, '.ia/src'));
const recipe = resolve(candidate, '.ia/src/systems/agent-composition-system/tests/sdk-runtime');
mkdirSync(resolve(output, 'sdk-runtime/native'), { recursive: true });
copyFileSync(resolve(recipe, 'recipe.mjs'), resolve(output, 'sdk-runtime/recipe.mjs'));
for (const file of ['system.ia.fixture', 'records.ia.fixture', 'read.ia.fixture'])
  copyFileSync(resolve(recipe, 'native', file), resolve(output, 'sdk-runtime/native', file));
const install = packageManagerCommand(pnpm, ['install', '--offline', '--ignore-scripts', '--store-dir', store]);
writeFileSync(
  resolve(output, 'install.log'),
  execFileSync(install.command, install.args, { cwd: output, encoding: 'utf8', timeout: 120000, windowsHide: true }),
);
const qualification = JSON.parse(
  execFileSync(process.execPath, [resolve(output, 'sdk-runtime/recipe.mjs'), output, resolve(output, 'sessions')], {
    cwd: output,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  }),
);
const readFixturePath = '.ia/src/systems/agent-composition-system/tests/installed-read-fixture.mjs';
copyFileSync(resolve(candidate, readFixturePath), resolve(output, 'installed-read-fixture.mjs'));
const installedRead = JSON.parse(
  execFileSync(
    process.execPath,
    [
      resolve(output, 'installed-read-fixture.mjs'),
      output,
      resolve(output, 'read-sessions'),
      '--mutate-installed-code',
    ],
    { cwd: output, encoding: 'utf8', timeout: 120000, windowsHide: true },
  ),
);
writeFileSync(resolve(output, 'installed-read-qualification.json'), JSON.stringify(installedRead, null, 2));
copyFileSync(
  resolve(candidate, 'packages/workspace-runtime/tests/public-spec-fixture.mjs'),
  resolve(output, 'public-spec-fixture.mjs'),
);
const publicSpec = JSON.parse(
  execFileSync(
    process.execPath,
    [resolve(output, 'public-spec-fixture.mjs'), output, resolve(output, 'spec-body-workspace')],
    { cwd: output, encoding: 'utf8', timeout: 120000, windowsHide: true },
  ),
);
writeFileSync(resolve(output, 'public-spec-qualification.json'), JSON.stringify(publicSpec, null, 2));
copyFileSync(
  resolve(candidate, '.ia/src/systems/agent-composition-system/tests/spec-read-boundary-fixture.mjs'),
  resolve(output, 'spec-read-boundary-fixture.mjs'),
);
const specReadBoundary = JSON.parse(
  execFileSync(
    process.execPath,
    [resolve(output, 'spec-read-boundary-fixture.mjs'), output, resolve(output, 'spec-read-boundary-workspace')],
    { cwd: output, encoding: 'utf8', timeout: 120000, windowsHide: true },
  ),
);
writeFileSync(resolve(output, 'spec-read-boundary-qualification.json'), JSON.stringify(specReadBoundary, null, 2));
writeFileSync(
  resolve(output, 'qualification.json'),
  JSON.stringify(
    {
      extraction: receipt,
      archives: pins,
      nativeFiles,
      node: process.version,
      qualification,
      installedRead,
      publicSpec,
      specReadBoundary,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, nativeFiles, archives: pins.length, paidProviderCalls: 0, passed: true }));
