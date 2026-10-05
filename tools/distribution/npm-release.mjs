import assert from 'node:assert/strict';
import { verifyPublicCompatibility, publicPackageInputs } from '../release/public-pack.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';

export const REGISTRY = 'https://registry.npmjs.org';
export const REPOSITORY = 'inventarch/ia';
export const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
export const WORKFLOW = 'npm-publish.yml';
export const ENVIRONMENT = 'npm';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function publicPackages(root) {
  const projects = [];
  for (const parent of ['packages', 'apps', '.ia/src/systems']) {
    for (const child of readdirSync(resolve(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${child.name}`;
      const path = resolve(root, directory, 'package.json');
      if (child.isDirectory() && existsSync(path)) {
        const manifest = json(path);
        if (!manifest.private) projects.push({ directory, manifest });
      }
    }
  }
  assert.ok(projects.length, 'No public packages found');
  return dependencyOrder(projects);
}

export function dependencyOrder(projects) {
  const byName = new Map(projects.map((project) => [project.manifest.name, project]));
  assert.equal(byName.size, projects.length, 'Duplicate public package name');
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(name) {
    assert.ok(!visiting.has(name), `Package dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const project = byName.get(name);
    for (const dependency of Object.keys(project.manifest.dependencies ?? {}).sort()) {
      if (byName.has(dependency)) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(project);
  }
  for (const name of [...byName.keys()].sort()) visit(name);
  return ordered;
}

export function releaseVersions(root) {
  const { receipt } = publicPackageInputs(root);
  return receipt.publicRefresh?.npm ?? receipt.baselineOverlay.versions.npm;
}

export function validatePackages(projects, version, versions) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'A stable release version is required');
  if (versions) assert.equal(version, versions['apps/cli/package.json'], 'release version differs');
  for (const { directory, manifest } of projects) {
    assert.match(manifest.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.equal(
      manifest.version,
      versions ? versions[directory + '/package.json'] : version,
      `${manifest.name}: release version differs`,
    );
    assert.equal(manifest.publishConfig?.access, 'public', `${manifest.name}: public access required`);
    assert.equal(manifest.publishConfig?.registry, REGISTRY, `${manifest.name}: npm registry required`);
    assert.equal(manifest.repository?.type, 'git');
    assert.equal(manifest.repository?.url, REPOSITORY_URL, `${manifest.name}: provenance repository differs`);
    assert.equal(manifest.repository?.directory, directory);
    for (const lifecycle of [
      'preinstall',
      'install',
      'postinstall',
      'prepack',
      'prepare',
      'prepublishOnly',
      'publish',
      'postpublish',
    ]) {
      assert.ok(!manifest.scripts?.[lifecycle], `${manifest.name}: release must not require ${lifecycle}`);
    }
  }
}

// Called only after the installed consumers have qualified these exact tarballs.
export function writeReleaseManifest(root, directory, packed) {
  const projects = publicPackages(root);
  const version = json(resolve(root, 'apps/cli/package.json')).version;
  validatePackages(projects, version, releaseVersions(root));
  assert.equal(packed.length, projects.length);
  const byName = new Map(packed.map((entry) => [entry.name, entry]));
  assert.equal(byName.size, projects.length);
  const compatibility = verifyPublicCompatibility(root, directory);
  const release = {
    format: 'ia.npm-release.v1',
    systemCompatibility: { path: 'system-compatibility.json', sha256: compatibility.sha256 },
    version,
    source: {
      repository: REPOSITORY,
      commit: git(root, 'rev-parse', 'HEAD'),
      dirty: git(root, 'status', '--porcelain') !== '',
    },
    packages: projects.map(({ manifest }) => {
      const packedFile = byName.get(manifest.name);
      assert.ok(packedFile, `${manifest.name}: missing qualified archive`);
      const filename = basename(packedFile.filename);
      const bytes = readFileSync(resolve(directory, filename));
      assert.match(packedFile.sha256 ?? '', /^[a-f0-9]{64}$/, `${manifest.name}: qualified archive hash is required`);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        packedFile.sha256,
        `${manifest.name}: qualified archive bytes differ`,
      );
      return {
        name: manifest.name,
        version: manifest.version,
        filename,
        bytes: bytes.length,
        integrity: integrity(bytes),
      };
    }),
  };
  writeFileSync(resolve(directory, 'npm-release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}

export function verifyRelease(root, directory, version) {
  const release = json(resolve(directory, 'npm-release.json'));
  const projects = publicPackages(root);
  validatePackages(projects, version, releaseVersions(root));
  assert.equal(release.format, 'ia.npm-release.v1');
  assert.equal(release.systemCompatibility?.path, 'system-compatibility.json');
  assert.equal(release.version, version);
  assert.equal(release.source.repository, REPOSITORY);
  assert.equal(release.source.commit, git(root, 'rev-parse', 'HEAD'), 'Archive source must match checkout');
  assert.deepEqual(
    release.packages.map((entry) => entry.name),
    projects.map(({ manifest }) => manifest.name),
  );
  assert.equal(new Set(release.packages.map((entry) => entry.filename)).size, projects.length);
  for (const entry of release.packages) {
    assert.equal(entry.version, projects.find((project) => project.manifest.name === entry.name)?.manifest.version);
    assert.match(entry.filename, /^[a-z0-9][a-z0-9._-]*\.tgz$/);
    const bytes = readFileSync(resolve(directory, entry.filename));
    assert.equal(bytes.length, entry.bytes, `${entry.name}: archive size changed`);
    assert.equal(integrity(bytes), entry.integrity, `${entry.name}: archive integrity changed`);
  }
  assert.deepEqual(
    readdirSync(directory)
      .filter((name) => name.endsWith('.tgz'))
      .sort(),
    release.packages.map((entry) => entry.filename).sort(),
  );
  verifyPublicCompatibility(root, directory, release.systemCompatibility.sha256);
  return release;
}

export function publicationPlan(release, registryPackages) {
  // Validate every existing version before the first write, including retries after a partial publish.
  return release.packages.map((entry) => {
    const remote = registryPackages[entry.name];
    assert.ok(
      remote,
      `${entry.name}: create the package and configure its trusted publisher first; see tools/distribution/NPM-PUBLISHING.md`,
    );
    const published = remote.versions?.[entry.version];
    if (published)
      assert.equal(
        published.dist?.integrity,
        entry.integrity,
        `${entry.name}@${entry.version}: existing npm bytes differ`,
      );
    return { ...entry, action: published ? 'skip-identical' : 'publish' };
  });
}

async function registryPackage(name) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  assert.ok(response.ok, `${name}: registry returned ${response.status}`);
  return response.json();
}

export function assertPublisherEnvironment(release, env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Publishing runs in GitHub Actions');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Dispatch the publishing workflow from main');
  assert.equal(env.GITHUB_SHA, release.source.commit, 'OIDC workflow commit must match the archive source');
  assert.equal(release.source.dirty, false, 'Publishing requires archives from a clean checkout');
  assert.ok(
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'GitHub OIDC permission is required',
  );
  assert.ok(!env.NODE_AUTH_TOKEN && !env.NPM_TOKEN, 'Use OIDC without an npm token');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { directory: { type: 'string', default: 'artifacts/npm' }, version: { type: 'string' } },
  });
  assert.equal(positionals.length, 1, 'Use plan, trust-commands or publish');
  const root = resolve(import.meta.dirname, '../..');
  const version = values.version ?? json(resolve(root, 'apps/cli/package.json')).version;
  const projects = publicPackages(root);
  validatePackages(projects, version, releaseVersions(root));
  if (positionals[0] === 'trust-commands') {
    for (const { manifest } of projects) {
      console.log(
        `npm trust github ${manifest.name} --repo ${REPOSITORY} --file ${WORKFLOW} --environment ${ENVIRONMENT} --allow-publish`,
      );
    }
    return;
  }
  const directory = resolve(root, values.directory);
  const release = verifyRelease(root, directory, version);
  if (positionals[0] === 'plan') {
    console.log(JSON.stringify(release, null, 2));
    return;
  }
  assert.equal(positionals[0], 'publish', 'Use plan, trust-commands or publish');
  assertPublisherEnvironment(release, process.env);
  assert.equal(git(root, 'status', '--porcelain'), '', 'Publishing checkout must be clean');
  const registryPackages = Object.fromEntries(
    await Promise.all(release.packages.map(async ({ name }) => [name, await registryPackage(name)])),
  );
  const plan = publicationPlan(release, registryPackages);
  for (const entry of plan) {
    console.log(`${entry.action}: ${entry.name}@${entry.version}`);
    if (entry.action === 'skip-identical') continue;
    execFileSync(
      'npm',
      [
        'publish',
        resolve(directory, entry.filename),
        '--registry',
        REGISTRY,
        '--access',
        'public',
        '--tag',
        'latest',
        '--provenance',
        '--ignore-scripts',
      ],
      { cwd: root, stdio: 'inherit' },
    );
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
