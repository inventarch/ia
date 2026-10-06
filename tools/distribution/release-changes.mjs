import assert from 'node:assert/strict';
import { publicPackages } from './release-packages.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';

export const RELEASE_POLICY = 'releases/current.json';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const stableVersion = (version) =>
  typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
export function compareVersions(left, right) {
  assert.ok(stableVersion(left) && stableVersion(right), 'Stable package versions are required');
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const json = (root, path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
export function releasePolicy(root) {
  const policy = json(root, RELEASE_POLICY);
  assert.equal(policy.format, 'ia.npm-cohort.v1');
  assert.ok(stableVersion(policy.version));
  assert.equal(policy.tag, 'latest', 'Only the reviewed latest publication channel is supported');
  assert.match(policy.baseline.commit, /^[a-f0-9]{40}$/);
  assert.ok(
    compareVersions(policy.version, policy.baseline.version) > 0,
    'Release version must advance the published baseline',
  );
  assert.ok(Array.isArray(policy.cycles));
  git(root, 'merge-base', '--is-ancestor', policy.baseline.commit, 'HEAD');
  return policy;
}
function trackedChanges(root, policy) {
  const excluded = new Set([
    '.ia/public-package-inputs.json',
    'CHANGELOG.md',
    `releases/changesets/${policy.version}.json`,
  ]);
  const files = git(root, 'diff', '--name-only', '--no-renames', policy.baseline.commit, '--')
    .split('\n')
    .filter(Boolean)
    .filter((path) => !excluded.has(path));
  return files.sort().map((path) => {
    const row = { path, sha256: existsSync(resolve(root, path)) ? sha256(readFileSync(resolve(root, path))) : null };
    if (
      path.endsWith('/package.json') &&
      row.sha256 &&
      git(root, 'ls-tree', '--name-only', policy.baseline.commit, '--', path)
    ) {
      const before = JSON.parse(git(root, 'show', policy.baseline.commit + ':' + path)),
        after = json(root, path);
      delete before.version;
      delete after.version;
      const canonical = (value) =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, canonical(value[key])]),
              )
            : value;
      if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) row.cohortOnly = true;
    }
    return row;
  });
}
export function renderChangelog(entries) {
  return (
    '# Changelog\n\nGenerated from reviewed release changesets. Entries describe intended releases; publication is a separate action.\n\n' +
    entries
      .map(
        (entry) =>
          `## ${entry.version}\n\n${entry.summary}\n\n` +
          entry.changes
            .map(
              (change) =>
                `### ${change.title}\n\n${change.summary}\n\nPackages: ${change.packages.map((name) => '`' + name + '`').join(', ')}.\n`,
            )
            .join('\n'),
      )
      .join('\n')
  );
}
/** A repository-relative path prefix in Git's form: forward slashes, no root or drive, no `.` or `..` segment. */
const scopePrefix = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !/^\/|^[A-Za-z]:|\\/.test(path) &&
  path.split('/').every((segment) => segment !== '.' && segment !== '..');
export function validateChangeset(entry, policy, projects, actualCoverage) {
  assert.equal(entry.format, 'ia.npm-changeset.v1');
  assert.equal(entry.version, policy.version, 'Changeset version differs');
  assert.equal(entry.state, 'consumed', 'Unconsumed changeset');
  assert.deepEqual(entry.baseline, policy.baseline, 'Changeset baseline is stale');
  assert.ok(entry.summary?.trim(), 'Release summary is required');
  const names = projects.map((p) => p.manifest.name).sort();
  assert.deepEqual(
    Object.keys(entry.packages).sort(),
    names,
    'Changeset must account for every public package exactly',
  );
  for (const project of projects) {
    assert.equal(project.manifest.version, policy.version, `${project.manifest.name}: cohort version differs`);
    const impact = entry.packages[project.manifest.name];
    assert.ok(
      ['changed', 'cohort'].includes(impact.kind) && impact.summary?.trim(),
      'Package impact or justified cohort entry is required',
    );
    assert.ok(
      impact.previous === null ||
        (stableVersion(impact.previous) && compareVersions(policy.version, impact.previous) > 0),
      'Package version must advance its published baseline',
    );
  }
  assert.ok(Array.isArray(entry.changes) && entry.changes.length, 'Changeset changes are required');
  const ids = new Set();
  for (const change of entry.changes) {
    assert.match(change.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(change.id), `Duplicate change entry: ${change.id}`);
    ids.add(change.id);
    assert.ok(change.title?.trim() && change.summary?.trim(), 'Changes need reviewable prose');
    assert.ok(
      Array.isArray(change.packages) &&
        change.packages.length &&
        new Set(change.packages).size === change.packages.length,
    );
    assert.ok(
      change.packages.every((name) => names.includes(name)),
      'Changeset names an unknown package',
    );
    assert.ok(
      Array.isArray(change.paths) && change.paths.length && change.paths.every(scopePrefix),
      'Change scope is required',
    );
  }
  assert.ok(Array.isArray(entry.coverage));
  assert.deepEqual(
    entry.coverage.map(({ path, sha256, cohortOnly }) => ({
      path,
      sha256,
      ...(cohortOnly ? { cohortOnly: true } : {}),
    })),
    actualCoverage,
    'Changeset coverage is missing or stale; review the diff and collect again',
  );
  for (const row of entry.coverage) {
    const change = entry.changes.find((change) => change.id === row.change);
    assert.ok(
      change && change.paths.some((prefix) => row.path.startsWith(prefix)),
      'Changed file lacks an applicable changeset entry',
    );
    const owner = projects.find((project) => row.path.startsWith(project.directory + '/'));
    assert.ok(!owner || change.packages.includes(owner.manifest.name), 'Changed package omitted from its change entry');
    assert.ok(
      !owner || entry.packages[owner.manifest.name].kind === 'changed' || row.cohortOnly === true,
      'Changed package cannot claim only a cohort bump',
    );
  }
  for (const name of names)
    assert.ok(
      entry.changes.some((change) => change.packages.includes(name)),
      'Package has no release notes',
    );
}
export function releaseChanges(root, projects) {
  const policy = releasePolicy(root),
    path = `releases/changesets/${policy.version}.json`;
  assert.ok(existsSync(resolve(root, path)), 'Missing required release changeset');
  const entry = json(root, path);
  const entries = readdirSync(resolve(root, 'releases/changesets'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const other = json(root, 'releases/changesets/' + name);
      assert.equal(name, other.version + '.json', 'Changeset filename/version differs');
      assert.equal(other.state, 'consumed', 'Unconsumed changeset');
      assert.ok(compareVersions(other.version, policy.version) <= 0, 'Unconsumed future changeset');
      if (other.version !== policy.version) {
        const original = git(root, 'show', `${policy.baseline.commit}:releases/changesets/${name}`);
        assert.equal(JSON.stringify(other), JSON.stringify(JSON.parse(original)), 'Historical changeset changed');
      }
      return other;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
  validateChangeset(entry, policy, projects, trackedChanges(root, policy));
  for (const project of projects) {
    let previous = null;
    const path = project.directory + '/package.json';
    const exists = git(root, 'ls-tree', '--name-only', policy.baseline.commit, '--', path);
    if (exists) {
      const prior = JSON.parse(git(root, 'show', policy.baseline.commit + ':' + path));
      assert.equal(prior.name, project.manifest.name, 'Package identity differs from published baseline');
      previous = prior.version;
    }
    assert.equal(
      entry.packages[project.manifest.name].previous,
      previous,
      'Changeset package baseline differs from source evidence',
    );
  }
  assert.equal(
    readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
    renderChangelog(entries),
    'Generated changelog is stale',
  );
  const bytes = readFileSync(resolve(root, path));
  return {
    policy,
    entry,
    path,
    sha256: sha256(bytes),
    coverageSha256: sha256(JSON.stringify(entry.coverage)),
    commits: git(root, 'log', '--reverse', '--format=%H %s', `${policy.baseline.commit}..HEAD`)
      .split('\n')
      .filter(Boolean),
  };
}
export function collectChanges(root, projects) {
  const policy = releasePolicy(root),
    path = `releases/changesets/${policy.version}.json`,
    entry = json(root, path);
  entry.coverage = trackedChanges(root, policy).map((row) => {
    const matches = entry.changes
      .flatMap((change) =>
        change.paths.filter((prefix) => row.path.startsWith(prefix)).map((prefix) => ({ change: change.id, prefix })),
      )
      .sort((a, b) => b.prefix.length - a.prefix.length || a.change.localeCompare(b.change));
    assert.ok(matches.length, 'No reviewed change scope for ' + row.path);
    return { ...row, change: matches[0].change };
  });
  validateChangeset(entry, policy, projects, trackedChanges(root, policy));
  writeFileSync(resolve(root, path), JSON.stringify(entry, null, 2) + '\n');
  const entries = readdirSync(resolve(root, 'releases/changesets'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => json(root, 'releases/changesets/' + name))
    .sort((a, b) => compareVersions(b.version, a.version));
  writeFileSync(resolve(root, 'CHANGELOG.md'), renderChangelog(entries));
  return releaseChanges(root, projects);
}
if (isEntry(process.argv[1], import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..');
  assert.ok(['check', 'collect'].includes(process.argv[2]) && process.argv.length === 3, 'Use check or collect');
  const result =
    process.argv[2] === 'collect'
      ? collectChanges(root, publicPackages(root))
      : releaseChanges(root, publicPackages(root));
  console.log(
    JSON.stringify(
      {
        version: result.policy.version,
        changeset: result.path,
        sha256: result.sha256,
        coveredFiles: result.entry.coverage.length,
        commits: result.commits,
      },
      null,
      2,
    ),
  );
}
