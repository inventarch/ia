import assert from 'node:assert/strict';
import { publicPackages } from './release-packages.mjs';
export { publicPackages, dependencyOrder } from './release-packages.mjs';
import { releaseChanges, releasePolicy, compareVersions, stableVersion } from './release-changes.mjs';
import { packedManifest, releaseGraph } from './release-graph.mjs';
import { verifyPublicCompatibility, publicPackageInputs } from '../release/public-pack.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';

export const REGISTRY = 'https://registry.npmjs.org';
export const REPOSITORY = 'inventarch/ia';
export const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
export const WORKFLOW = 'npm-publish.yml';
export const ENVIRONMENT = 'npm';
/** The npm CLI that publishes, verifies and configures trust; the workflow installs exactly this version. */
export const NPM_VERSION = '12.2.0';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function releaseVersions(root, inputs = publicPackageInputs(root)) {
  const { receipt } = inputs;
  return receipt.publicRefresh?.npm ?? receipt.baselineOverlay.versions.npm;
}

export function validatePackages(projects, version, versions) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'A stable release version is required');
  if (versions) assert.equal(version, versions['apps/cli/package.json'], 'release version differs');
  for (const { directory, manifest } of projects) {
    assert.match(manifest.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.equal(manifest.version, version, `${manifest.name}: release version differs`);
    if (versions) assert.equal(versions[directory + '/package.json'], version, 'Sealed cohort version differs');
    assert.equal(manifest.publishConfig?.tag ?? 'latest', 'latest', 'Unexpected publication tag');
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

/** Each package's published baseline version; null for a package the release publishes for the first time. */
const baselineVersions = (changes) =>
  Object.fromEntries(Object.entries(changes.entry.packages).map(([name, entry]) => [name, entry.previous]));
/**
 * Publication order. New names go first: none has an existing version to break, so a failed first publish of a new name
 * stops the run before any existing package moves its `latest` tag. Existing packages follow in dependency order. Every
 * order of a cycle publishes some package before one it depends on, so a failure among existing packages, including
 * an existing package's first trusted publish, can still leave a partial cohort for a retry to complete.
 */
export function publicationOrder(groups, baselines) {
  const members = groups.flatMap((group) => group.members);
  return [...members.filter((name) => baselines[name] === null), ...members.filter((name) => baselines[name] !== null)];
}
function archiveEntries(root, directory, packed, version, changes) {
  const projects = publicPackages(root),
    byName = new Map(packed.map((entry) => [entry.name, entry]));
  assert.equal(byName.size, projects.length, 'Archive cohort membership differs');
  assert.equal(packed.length, projects.length, 'Duplicate archive entry');
  const entries = projects.map(({ manifest }) => {
    const entry = byName.get(manifest.name);
    assert.ok(entry, 'Missing qualified archive: ' + manifest.name);
    const filename = basename(entry.filename);
    assert.match(filename, /^[a-z0-9][a-z0-9._-]*\.tgz$/);
    const bytes = readFileSync(resolve(directory, filename));
    if (entry.sha256 !== undefined)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'qualified archive bytes differ');
    const installed = packedManifest(resolve(directory, filename), bytes);
    assert.equal(installed.name, manifest.name, 'Packed package identity differs');
    assert.equal(installed.version, version, 'Packed package version differs');
    return {
      name: manifest.name,
      version,
      filename,
      bytes: bytes.length,
      integrity: integrity(bytes),
      manifest: installed,
    };
  });
  const graph = releaseGraph(
    entries.map((entry) => entry.manifest),
    version,
    changes.policy.cycles,
  );
  return {
    graph,
    packages: publicationOrder(graph.groups, baselineVersions(changes)).map((name) => {
      const { manifest, ...entry } = entries.find((entry) => entry.name === name);
      return entry;
    }),
  };
}
/**
 * Release evidence defaults to the strict changeset check and the sealed input descriptor. Archive tests inject
 * `{ changes, inputs }` so they exercise receipts against the current checkout without first sealing a release.
 */
const evidenceFor = (root, projects, evidence) => ({
  changes: evidence.changes ?? releaseChanges(root, projects),
  inputs: evidence.inputs ?? publicPackageInputs(root),
});
// Called only after installed consumers qualify these exact tarballs.
export function writeReleaseManifest(root, directory, packed, evidence = {}) {
  const projects = publicPackages(root),
    version = json(resolve(root, 'apps/cli/package.json')).version,
    { changes, inputs } = evidenceFor(root, projects, evidence);
  validatePackages(projects, version, releaseVersions(root, inputs));
  for (const entry of packed) assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/, 'qualified archive hash is required');
  const compatibility = verifyPublicCompatibility(root, directory, undefined, { inputs });
  const archives = archiveEntries(root, directory, packed, version, changes);
  const release = {
    format: 'ia.npm-release.v2',
    version,
    tag: changes.policy.tag,
    source: {
      repository: REPOSITORY,
      commit: git(root, 'rev-parse', 'HEAD'),
      dirty: git(root, 'status', '--porcelain') !== '',
    },
    changeset: {
      path: changes.path,
      sha256: changes.sha256,
      coverageSha256: changes.coverageSha256,
      commits: changes.commits,
    },
    baselineVersions: baselineVersions(changes),
    graph: archives.graph,
    packages: archives.packages,
    systemCompatibility: { path: 'system-compatibility.json', sha256: compatibility.sha256 },
  };
  writeFileSync(resolve(directory, 'npm-release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
export function verifyRelease(root, directory, version, evidence = {}) {
  const release = json(resolve(directory, 'npm-release.json')),
    projects = publicPackages(root),
    { changes, inputs } = evidenceFor(root, projects, evidence);
  validatePackages(projects, version, releaseVersions(root, inputs));
  assert.equal(release.format, 'ia.npm-release.v2');
  assert.equal(release.version, version);
  assert.equal(release.source.repository, REPOSITORY);
  assert.equal(release.source.commit, git(root, 'rev-parse', 'HEAD'), 'Archive source must match checkout');
  assert.equal(release.tag, changes.policy.tag, 'Release tag differs');
  assert.deepEqual(
    release.changeset,
    { path: changes.path, sha256: changes.sha256, coverageSha256: changes.coverageSha256, commits: changes.commits },
    'Release changeset is stale',
  );
  assert.deepEqual(release.baselineVersions, baselineVersions(changes));
  assert.equal(new Set(release.packages.map((entry) => entry.filename)).size, projects.length);
  for (const entry of release.packages) {
    assert.match(entry.filename, /^[a-z0-9][a-z0-9._-]*\.tgz$/);
    const bytes = readFileSync(resolve(directory, entry.filename));
    assert.equal(bytes.length, entry.bytes, entry.name + ': archive size changed');
    assert.equal(integrity(bytes), entry.integrity, entry.name + ': archive integrity changed');
  }
  const actual = archiveEntries(root, directory, release.packages, version, changes);
  assert.deepEqual(release.packages, actual.packages, 'Packed release cohort differs');
  assert.deepEqual(release.graph, actual.graph, 'Packed release graph differs');
  assert.deepEqual(
    readdirSync(directory)
      .filter((name) => name.endsWith('.tgz'))
      .sort(),
    release.packages.map((entry) => entry.filename).sort(),
  );
  assert.equal(release.systemCompatibility?.path, 'system-compatibility.json');
  verifyPublicCompatibility(root, directory, release.systemCompatibility.sha256, { inputs });
  return release;
}
export function publicationPlan(release, registryPackages) {
  assert.ok(stableVersion(release.version));
  assert.equal(release.tag, 'latest', 'Unexpected release tag');
  return release.packages.map((entry) => {
    assert.equal(entry.version, release.version, 'Registry plan has a mixed cohort');
    const remote = registryPackages[entry.name];
    assert.ok(
      remote,
      entry.name +
        ': create the package and configure its trusted publisher first with pnpm npm:setup --apply; see tools/distribution/NPM-PUBLISHING.md',
    );
    const previous = release.baselineVersions?.[entry.name];
    if (previous) assert.ok(compareVersions(entry.version, previous) > 0, 'Release did not advance published baseline');
    const newer = Object.keys(remote.versions ?? {})
      .filter(stableVersion)
      .find((version) => compareVersions(version, entry.version) > 0);
    assert.ok(!newer, entry.name + ': registry already has a newer stable version');
    const published = remote.versions?.[entry.version];
    if (published) {
      assert.equal(
        published.dist?.integrity,
        entry.integrity,
        entry.name + '@' + entry.version + ': existing npm bytes differ',
      );
      assert.equal(
        remote['dist-tags']?.latest,
        entry.version,
        entry.name + ': existing version has an unexpected latest tag; no automatic tag repair',
      );
    }
    return { ...entry, action: published ? 'skip-identical' : 'publish' };
  });
}
export function verifyRegistryCohort(release, registryPackages) {
  const plan = publicationPlan(release, registryPackages);
  for (const entry of plan) {
    assert.equal(entry.action, 'skip-identical', entry.name + ': incomplete published cohort');
    const dist = registryPackages[entry.name].versions[entry.version].dist;
    assert.equal(new URL(dist.tarball).origin, REGISTRY, 'Unexpected registry tarball origin');
    assert.ok(dist.attestations?.provenance, 'Published package lacks npm provenance');
    assert.equal(new URL(dist.attestations.url).origin, REGISTRY, 'Unexpected attestation origin');
  }
  return plan;
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
    options: {
      directory: { type: 'string', default: 'artifacts/npm' },
      version: { type: 'string' },
      tag: { type: 'string', default: 'latest' },
      'reviewed-changeset': { type: 'string' },
    },
  });
  assert.equal(positionals.length, 1, 'Use plan, trust-commands, preflight, verify-registry or publish');
  const root = resolve(import.meta.dirname, '../..');
  const version = values.version ?? json(resolve(root, 'apps/cli/package.json')).version;
  const projects = publicPackages(root);
  validatePackages(projects, version, releaseVersions(root));
  assert.equal(values.tag, releasePolicy(root).tag, 'Requested release tag differs');
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
  assert.ok(['publish', 'preflight', 'verify-registry'].includes(positionals[0]));
  if (positionals[0] === 'publish') {
    assertPublisherEnvironment(release, process.env);
    assert.equal(git(root, 'status', '--porcelain'), '', 'Publishing checkout must be clean');
    // The npm environment approval is the publication checkpoint; the reviewer sees this digest in the prepare
    // summary. A dispatcher who passes a reviewed digest still binds the run to it.
    if (values['reviewed-changeset'])
      assert.equal(
        values['reviewed-changeset'],
        release.changeset.sha256,
        'Reviewed changeset digest differs from the prepared release',
      );
    console.log(`Publishing ${release.changeset.path} sha256:${release.changeset.sha256}`);
  }
  const registryPackages = Object.fromEntries(
    await Promise.all(release.packages.map(async ({ name }) => [name, await registryPackage(name)])),
  );
  if (positionals[0] === 'verify-registry') {
    const checked = verifyRegistryCohort(release, registryPackages);
    for (const entry of checked) {
      const dist = registryPackages[entry.name].versions[entry.version].dist;
      const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(30000) });
      assert.ok(response.ok);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, entry.bytes);
      assert.equal(integrity(bytes), entry.integrity, 'Downloaded registry bytes differ');
    }
    console.log(
      JSON.stringify(
        {
          version: release.version,
          packages: checked.length,
          integrity: 'verified',
          latest: 'verified',
          provenance: 'present; npm audit signatures performs cryptographic verification',
        },
        null,
        2,
      ),
    );
    return;
  }
  const plan = publicationPlan(release, registryPackages);
  if (positionals[0] === 'preflight') {
    console.log(
      JSON.stringify(
        {
          plan,
          trust:
            'Package presence does not prove trusted-publisher authorization; verify the configured repo/workflow/environment separately',
        },
        null,
        2,
      ),
    );
    return;
  }
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
        release.tag,
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
