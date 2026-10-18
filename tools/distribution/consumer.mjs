import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { parseOptions } from '../shared/args.mjs';
import { checkWrite } from '../shared/check-write.mjs';
import { containedFile, readRegular } from '../shared/paths.mjs';
import {
  COMPATIBILITY,
  packPublicPackages,
  publicPackageInputs,
  verifyPublicCompatibility,
} from '../release/public-pack.mjs';
import { publicPackages, verifyRelease } from './npm-release.mjs';
import { packedManifest } from './release-graph.mjs';

/** @typedef {{name:string,version:string,filename:string,owner:string,sha256:string}} Archive */
/** @param {string|Buffer} bytes */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {unknown} value @param {string[]} keys */
const shape = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.sort().join(',');
/** The producer owns this stable pointer; each cohort below it remains an immutable artifact set.
 * @param {string} root
 */
export function qualificationPath(root, run = process.env['IA_TEST_ORCHESTRATION']) {
  if (run !== undefined) assert(/^[a-f0-9-]{36}$/.test(run), 'Invalid qualification run');
  return resolve(root, 'artifacts/qualification/packed', process.platform, ...(run ? [run] : []), 'qualification.json');
}

/** Describe already-produced archives; this function does not pack or seal release inputs.
 * @param {string} root @param {string} directory @param {readonly {name:string,filename:string,sha256:string}[]} packed
 */
export function qualificationManifest(root, directory, packed) {
  const source = publicPackageInputs(root, { sealed: false }),
    projects = publicPackages(root);
  const archives = packed.map((row) => {
    const project = projects.find((project) => project.manifest.name === row.name);
    assert(project, 'Unexpected qualification package');
    return {
      name: row.name,
      version: project.manifest.version,
      owner: project.directory,
      filename: basename(row.filename),
      sha256: row.sha256,
    };
  });
  return {
    format: 'ia.package-qualification.v1',
    mode: 'qualification',
    source: source.receipt.source,
    inputDigest: source.receipt.inputDigest,
    sourceManifestSha256: source.sha256,
    platform: String(process.platform),
    arch: process.arch,
    node: process.version,
    packageManager: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager,
    compatibility: { filename: COMPATIBILITY, sha256: sha(readRegular(directory, COMPATIBILITY, 4 * 1024 * 1024)) },
    archives,
  };
}

/** Verify the supplied ordinary receipt and exact archive bytes. Never fall back to packing on refusal.
 * @param {string} root @param {string} path
 */
export function readQualification(root, path) {
  path = resolve(path);
  const directory = dirname(path),
    manifest = JSON.parse(readRegular(directory, basename(path), 4 * 1024 * 1024).toString('utf8'));
  assert(
    shape(manifest, [
      'format',
      'mode',
      'source',
      'inputDigest',
      'sourceManifestSha256',
      'platform',
      'arch',
      'node',
      'packageManager',
      'compatibility',
      'archives',
    ]) &&
      manifest.format === 'ia.package-qualification.v1' &&
      manifest.mode === 'qualification',
    'Ordinary qualification receipt required',
  );
  const inputs = publicPackageInputs(root, { sealed: false });
  assert.equal(JSON.stringify(manifest.source), JSON.stringify(inputs.receipt.source), 'Qualification source changed');
  assert.equal(manifest.inputDigest, inputs.receipt.inputDigest, 'Qualification inputs changed');
  assert.equal(manifest.sourceManifestSha256, inputs.sha256, 'Qualification source receipt changed');
  assert.equal(manifest.platform, process.platform, 'Qualification platform differs');
  assert.equal(manifest.arch, process.arch, 'Qualification architecture differs');
  assert.equal(manifest.node, process.version, 'Qualification Node differs');
  assert.equal(
    manifest.packageManager,
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager,
    'Qualification package manager differs',
  );
  assert(
    shape(manifest.compatibility, ['filename', 'sha256']) &&
      typeof manifest.compatibility.filename === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.compatibility.sha256),
    'Invalid qualification compatibility pin',
  );
  const companion = containedFile(directory, manifest.compatibility.filename),
    archivesDirectory = dirname(companion);
  assert.equal(basename(companion), COMPATIBILITY, 'Qualification compatibility name differs');
  const projects = publicPackages(root);
  assert(
    Array.isArray(manifest.archives) && manifest.archives.length === projects.length,
    'Qualification cohort membership differs',
  );
  const names = new Set(),
    filenames = new Set();
  /** @type {Archive[]} */
  const packed = manifest.archives.map(
    /** @param {Archive} row */ (row) => {
      assert(shape(row, ['name', 'version', 'owner', 'filename', 'sha256']), 'Invalid qualification archive');
      const project = projects.find((project) => project.manifest.name === row.name);
      assert(
        project && row.version === project.manifest.version && row.owner === project.directory,
        'Qualification archive identity differs',
      );
      assert(!names.has(row.name) && !filenames.has(row.filename), 'Duplicate qualification archive');
      names.add(row.name);
      filenames.add(row.filename);
      assert(
        typeof row.filename === 'string' && /^[a-f0-9]{64}$/.test(row.sha256),
        'Invalid qualification archive pin',
      );
      const filename = containedFile(directory, row.filename);
      assert.equal(dirname(filename), archivesDirectory, 'Qualification archives must share the companion directory');
      assert.equal(
        basename(filename),
        `${row.name.replace('@', '').replace('/', '-')}-${row.version}.tgz`,
        'Qualification archive filename differs',
      );
      const bytes = readRegular(directory, row.filename, 256 * 1024 * 1024);
      assert.equal(sha(bytes), row.sha256, 'Qualification archive digest changed');
      const identity = packedManifest(filename, bytes);
      assert.equal(identity.name, row.name, 'Packed qualification name differs');
      assert.equal(identity.version, row.version, 'Packed qualification version differs');
      return { ...row, filename };
    },
  );
  const verified = verifyPublicCompatibility(root, archivesDirectory, manifest.compatibility.sha256, { inputs });
  return {
    packed,
    compatibility: verified.compatibility,
    compatibilitySha256: verified.sha256,
    manifest: path,
    archivesDirectory,
  };
}

/** Explicit ordinary producer: pack outside the checkout, then publish one manifest after all archive copies.
 * @param {string} root @param {string} pnpm
 */
export function prepareQualification(root, pnpm) {
  const temporaryRoot = realpathSync(tmpdir()),
    temporary = mkdtempSync(resolve(temporaryRoot, 'ia-qualification-'));
  try {
    const bundled = packPublicPackages(root, resolve(temporary, 'archives'), pnpm, { sealed: false });
    const path = qualificationPath(root),
      generation = 'cohort-' + randomUUID(),
      parent = dirname(path);
    containedFile(
      root,
      'artifacts/qualification/packed/' +
        process.platform +
        '/' +
        (process.env['IA_TEST_ORCHESTRATION'] ? process.env['IA_TEST_ORCHESTRATION'] + '/' : '') +
        generation +
        '/qualification.json',
      { allowMissing: true },
    );
    const destination = resolve(parent, generation);
    mkdirSync(destination, { recursive: true });
    for (const row of bundled.packed)
      copyFileSync(row.filename, containedFile(destination, basename(row.filename), { allowMissing: true }));
    copyFileSync(
      resolve(temporary, 'archives', COMPATIBILITY),
      containedFile(destination, COMPATIBILITY, { allowMissing: true }),
    );
    const manifest = qualificationManifest(root, destination, bundled.packed);
    // Validate the immutable generation before publishing the stable pointer.
    checkWrite(destination, new Map([['qualification.json', JSON.stringify(manifest, null, 2) + '\n']]), {
      write: true,
    });
    readQualification(root, resolve(destination, 'qualification.json'));
    for (const archive of manifest.archives) archive.filename = generation + '/' + archive.filename;
    manifest.compatibility.filename = generation + '/' + manifest.compatibility.filename;
    checkWrite(parent, new Map([['qualification.json', JSON.stringify(manifest, null, 2) + '\n']]), { write: true });
    return readQualification(root, path);
  } finally {
    assert.equal(dirname(temporary), temporaryRoot);
    assert(basename(temporary).startsWith('ia-qualification-'));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** An explicit manifest (including the orchestrator environment) is always mandatory evidence, never a hint.
 * @param {string} root @param {string} pnpm @param {string|undefined} [requested]
 */
export function ensureQualification(root, pnpm, requested = process.env['IA_QUALIFICATION_MANIFEST']) {
  const path = requested === undefined ? qualificationPath(root) : resolve(root, requested);
  if (requested !== undefined || existsSync(path)) return readQualification(root, path);
  console.log('Preparing ordinary archives with packages:pack before qualification.');
  return prepareQualification(root, pnpm);
}

/** Release trust remains separate: a qualification manifest never satisfies this verifier.
 * The optional evidence is the release verifier's controlled fixture seam; command callers never supply it.
 * @param {string} root @param {string} directory @param {import('./npm-release.mjs').ReleaseEvidence} [evidence]
 */
export function releaseArtifacts(root, directory, evidence) {
  assert(existsSync(resolve(directory, 'npm-release.json')), 'Sealed release receipt required');
  const inputs = evidence?.inputs ?? publicPackageInputs(root);
  const version = JSON.parse(readFileSync(resolve(root, 'releases/current.json'), 'utf8')).version;
  const release = verifyRelease(root, directory, version, { ...evidence, inputs });
  const projects = publicPackages(root);
  const packed = release.packages.map((row) => ({
    name: row.name,
    version: row.version,
    filename: containedFile(directory, row.filename),
    owner: projects.find((project) => project.manifest.name === row.name)?.directory ?? '',
    sha256: sha(readRegular(directory, row.filename, 256 * 1024 * 1024)),
  }));
  return { release, packed };
}

/** @param {readonly Archive[]} packed @param {readonly string[]} [names] */
export function consumerDependencies(packed, names = packed.map((row) => row.name)) {
  assert.equal(new Set(names).size, names.length, 'Duplicate consumer package selection');
  return Object.fromEntries(
    names.map((name) => {
      const rows = packed.filter((row) => row.name === name);
      assert.equal(rows.length, 1, 'Select exactly one ' + name + ' archive');
      assert(rows[0]);
      return [name, 'file:' + rows[0].filename.replaceAll('\\', '/')];
    }),
  );
}

/** Shared installation mechanics, independent of the caller's qualification or release trust predicate.
 * @param {string} directory @param {readonly Archive[]} packed @param {string} pnpm
 * @param {{name?:string,names?:readonly string[],offline?:boolean,store?:string}} [options]
 */
export function installConsumer(
  directory,
  packed,
  pnpm,
  { name = 'ia-artifact-consumer', names, offline = false, store } = {},
) {
  // Validate the entire selection before effects, then install only copies of these verified bytes.
  consumerDependencies(packed, names);
  let total = 0;
  const snapshots = packed.map((row) => {
    const bytes = readRegular(dirname(row.filename), basename(row.filename), 256 * 1024 * 1024);
    assert.equal(sha(bytes), row.sha256, 'Consumer archive digest changed');
    total += bytes.length;
    assert(total <= 512 * 1024 * 1024, 'Consumer archive cohort exceeds byte ceiling');
    return { row, bytes };
  });
  assert.equal(
    new Set(packed.map((row) => basename(row.filename))).size,
    packed.length,
    'Duplicate consumer archive filename',
  );
  mkdirSync(directory, { recursive: true });
  containedFile(directory, 'package.json', { allowMissing: true });
  const archives = mkdtempSync(resolve(directory, '.ia-archives-'));
  for (const { row, bytes } of snapshots)
    writeFileSync(containedFile(archives, basename(row.filename), { allowMissing: true }), bytes, { flag: 'wx' });
  const copies = packed.map((row) => ({ ...row, filename: resolve(archives, basename(row.filename)) }));
  const overrides = consumerDependencies(copies),
    dependencies = consumerDependencies(copies, names);
  checkWrite(
    directory,
    new Map([
      ['package.json', JSON.stringify({ name, private: true, type: 'module', dependencies }, null, 2) + '\n'],
      ['pnpm-workspace.yaml', JSON.stringify({ packages: ['.'], overrides }, null, 2) + '\n'],
    ]),
    { write: true },
  );
  const command = packageManagerCommand(pnpm, [
    'install',
    offline ? '--offline' : '--prefer-offline',
    '--ignore-scripts',
    '--lockfile=false',
    ...(store ? ['--store-dir', store] : []),
  ]);
  return execFileSync(command.command, command.args, {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

if (isEntry(process.argv[1], import.meta.url)) {
  let valid = false;
  try {
    assert.equal(process.argv[2], 'pack', 'Usage: consumer.mjs pack');
    parseOptions(process.argv.slice(3), {});
    valid = true;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
  if (valid)
    try {
      assert(process.env['npm_execpath'], 'Run through pnpm packages:pack');
      const result = prepareQualification(resolve(import.meta.dirname, '../..'), process.env['npm_execpath']);
      console.log(
        JSON.stringify({
          mode: 'qualification',
          manifest: result.manifest,
          archives: result.packed.map(({ name, sha256 }) => ({ name, sha256 })),
        }),
      );
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
    }
}
