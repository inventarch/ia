import { publicPackageInputs } from '../release/public-pack.mjs';
import { verifyRelease } from '../distribution/npm-release.mjs';
import { publicSystemNames } from '../native/public-systems.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
// Consume packaging-owner-selected artifacts. No build or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
const args = process.argv.slice(2);
assert(
  args.length === 5,
  'Usage: node tools/runtime/qualify-sdk.mjs <public-tree> <archives> <new-output> <pnpm-launcher> <offline-store>',
);
const [candidate, archives, output, pnpm, store] = args.map((value) => resolve(value));
const inputs = publicPackageInputs(candidate);
const receipt = inputs.receipt;
const packages = [
  'language',
  'graph',
  'compliance',
  'db',
  'runtime',
  'workspace-runtime',
  ...publicSystemNames(candidate),
];
const version = JSON.parse(readFileSync(resolve(candidate, 'releases/current.json'), 'utf8')).version;
const release = verifyRelease(candidate, archives, version);
const inventory = {
  artifacts: release.packages.map((row) => ({
    ...row,
    path: row.filename,
    sha256: createHash('sha256')
      .update(readFileSync(resolve(archives, row.filename)))
      .digest('hex'),
  })),
};
const dependencies = {},
  pins = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
/**
 * A selected archive's bytes, read once through the descriptor it was opened and judged by (CodeQL js/file-system-race):
 * a regular file, not a link, unchanged while it is read. Its digest, its manifest and its pin all come from these bytes.
 */
function archiveBytes(path) {
  let fd;
  try {
    // NOFOLLOW refuses a final link; NONBLOCK keeps a FIFO from blocking the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // A link fails the open (ELOOP) and Windows will not open a directory: refused as the check by name refused them.
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert(opened.isFile(), 'Selected archive is not a regular file');
    // Read at most one byte past the opened size, so a file that grows while it is read cannot pass for the one judged.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    // Windows follows a link on open, so the name must still be that file, as the check by name required.
    const stat = lstatSync(path, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert(
      BigInt(length) === opened.size &&
        fstatSync(fd, { bigint: true }).size === opened.size &&
        stat.dev === opened.dev &&
        stat.ino === opened.ino,
      'Selected archive changed while it was read',
    );
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
for (const name of packages) {
  const matches = inventory.artifacts.filter((file) => file.name === `@inventarch/${name}`);
  assert.equal(matches.length, 1, `Select exactly one @inventarch/${name} archive`);
  assert(/^[A-Za-z0-9_.-]+\.tgz$/.test(matches[0].path), 'Unsafe selected archive path');
  const path = resolve(archives, matches[0].path),
    bytes = archiveBytes(path);
  assert.equal(digest(bytes), matches[0].sha256, 'Selected archive digest mismatch');
  // tar reads the verified bytes from stdin, not the archive by its name; a stream needs gzip named explicitly.
  const packed = JSON.parse(
    execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
      input: bytes,
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
  // pnpm still installs the archive by this path; the pin below records the bytes verified above.
  dependencies[`@inventarch/${name}`] = `file:${path.replaceAll('\\', '/')}`;
  pins.push({
    package: `@inventarch/${name}`,
    archive: basename(path),
    sha256: digest(bytes),
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
      publicInputs: { sha256: inputs.sha256, source: receipt.source },
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
