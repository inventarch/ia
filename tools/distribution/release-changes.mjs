import assert from 'node:assert/strict';
import { manifestProblems, publicPackages } from './release-packages.mjs';
import { BUMPS, bumpVersion, maxBump, packageOwner, pendingNotes, releaseBump } from './release-notes.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { publicPackageInputs } from '../release/public-pack.mjs';

export const RELEASE_POLICY = 'releases/current.json';
export const SYSTEM_PACKAGE_POLICY = 'tools/distribution/system-package-policy.json';
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
export const changesetPath = (version) => `releases/changesets/${version}.json`;
export const releaseTag = (version) => `v${version}`;
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
/** The commit a published version was released from, by its immutable `v<version>` tag; null while unpublished. */
export function publishedCommit(root, version) {
  try {
    return git(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${releaseTag(version)}^{commit}`);
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}
export function trackedChanges(root, policy, since = policy.baseline.commit) {
  const excluded = new Set(['.ia/public-package-inputs.json', 'CHANGELOG.md', changesetPath(policy.version)]);
  const files = git(root, 'diff', '--name-only', '--no-renames', since, '--')
    .split('\n')
    .filter(Boolean)
    .filter((path) => !excluded.has(path));
  return files.sort().map((path) => {
    const row = { path, sha256: existsSync(resolve(root, path)) ? sha256(readFileSync(resolve(root, path))) : null };
    if (path.endsWith('/package.json') && row.sha256 && git(root, 'ls-tree', '--name-only', since, '--', path)) {
      const before = JSON.parse(git(root, 'show', since + ':' + path)),
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
            // Internal entries account for repository files outside every package; consumers see no change.
            .filter((change) => !change.internal)
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
/** Everything except exact file coverage: the part of a changeset a person writes. */
export function validateChangesetStructure(entry, policy, projects) {
  assert.equal(entry.format, 'ia.npm-changeset.v1');
  assert.equal(entry.version, policy.version, 'Changeset version differs');
  assert.equal(entry.state, 'consumed', 'Unconsumed changeset');
  assert.deepEqual(entry.baseline, policy.baseline, 'Changeset baseline is stale');
  assert.ok(entry.summary?.trim(), 'Release summary is required');
  if (entry.bump !== undefined)
    assert.equal(entry.bump, releaseBump(policy.baseline.version, policy.version), 'Changeset bump differs');
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
    assert.ok(change.internal === undefined || change.internal === true, 'Internal changes are marked true');
    assert.ok(
      Array.isArray(change.packages) &&
        (change.internal ? change.packages.length === 0 : change.packages.length > 0) &&
        new Set(change.packages).size === change.packages.length,
      'Package changes name their packages; internal changes name none',
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
  for (const name of names)
    assert.ok(
      entry.changes.some((change) => change.packages.includes(name)),
      'Package has no release notes',
    );
}
export function validateChangeset(entry, policy, projects, actualCoverage) {
  validateChangesetStructure(entry, policy, projects);
  assert.ok(Array.isArray(entry.coverage));
  const recorded = entry.coverage.map(({ path, sha256, cohortOnly }) => ({
    path,
    sha256,
    ...(cohortOnly ? { cohortOnly: true } : {}),
  }));
  if (JSON.stringify(recorded) !== JSON.stringify(actualCoverage)) {
    // Name the files rather than dumping two coverage arrays of several hundred rows.
    const key = (row) => JSON.stringify([row.path, row.sha256, row.cohortOnly === true]),
      have = new Set(recorded.map(key)),
      want = new Set(actualCoverage.map(key));
    const stale = [
      ...new Set(
        [...actualCoverage.filter((row) => !have.has(key(row))), ...recorded.filter((row) => !want.has(key(row)))].map(
          (row) => row.path,
        ),
      ),
    ];
    assert.fail(
      `Changeset coverage is missing or stale for ${stale.length} file(s): ${stale.slice(0, 5).join(', ')}` +
        `${stale.length > 5 ? ', …' : ''}. Review the diff, then run pnpm release:collect (or pnpm release:version --write --refresh)`,
    );
  }
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
}
/** Every changeset, newest first; changesets other than the current version must match the published baseline. */
function changesetHistory(root, policy) {
  return readdirSync(resolve(root, 'releases/changesets'))
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
}
/** The strict release check: the exact source a publication may be prepared from. */
export function releaseChanges(root, projects) {
  const policy = releasePolicy(root),
    path = changesetPath(policy.version);
  assert.ok(existsSync(resolve(root, path)), 'Missing required release changeset');
  const entry = json(root, path);
  const entries = changesetHistory(root, policy);
  const pending = pendingNotes(
    root,
    projects.map((project) => project.manifest.name),
  );
  assert.equal(
    pending.length,
    0,
    'Pending release notes are not part of this release; run pnpm release:version to fold them in',
  );
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
/**
 * The current version's changeset as committed, in the shape `releaseChanges` returns, without the freshness checks
 * that only a release commit passes. Archive tests use it to exercise receipts against any checkout.
 */
export function committedChanges(root) {
  const policy = releasePolicy(root),
    path = changesetPath(policy.version),
    bytes = readFileSync(resolve(root, path)),
    entry = JSON.parse(bytes.toString('utf8'));
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
/**
 * The pull-request check. It never asks a contributor to rewrite the consumed changeset: package changes outside
 * the prepared release must carry a pending note, and `pnpm release:version` folds notes into the next release.
 */
export function releaseStatus(root, projects) {
  const policy = releasePolicy(root),
    names = projects.map((project) => project.manifest.name).sort();
  for (const project of projects)
    assert.equal(
      project.manifest.version,
      policy.version,
      `${project.manifest.name}: version differs from ${RELEASE_POLICY}`,
    );
  if (existsSync(resolve(root, SYSTEM_PACKAGE_POLICY)))
    for (const owner of json(root, SYSTEM_PACKAGE_POLICY).owners)
      assert.equal(owner.npmVersion, policy.version, `${owner.owner}: npmVersion differs from ${RELEASE_POLICY}`);
  const notes = pendingNotes(root, names);
  const path = changesetPath(policy.version);
  assert.ok(existsSync(resolve(root, path)), 'Missing required release changeset');
  const entry = json(root, path),
    entries = changesetHistory(root, policy),
    published = publishedCommit(root, policy.version);
  let covered = new Set();
  if (published) {
    assert.equal(
      JSON.stringify(entry),
      JSON.stringify(JSON.parse(git(root, 'show', `${published}:${path}`))),
      `${path} changed after ${releaseTag(policy.version)} was published`,
    );
  } else {
    validateChangesetStructure(entry, policy, projects);
    covered = new Set(entry.coverage.map((row) => row.path + '\0' + row.sha256));
  }
  assert.equal(
    readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
    renderChangelog(entries),
    'Generated changelog is stale; run pnpm release:collect',
  );
  const noted = new Set(notes.flatMap(({ note }) => note.packages));
  const outside = trackedChanges(root, policy, published ?? policy.baseline.commit).filter(
    (row) => !row.cohortOnly && !covered.has(row.path + '\0' + row.sha256),
  );
  const missing = new Map();
  for (const row of outside) {
    const owner = packageOwner(projects, row.path);
    if (owner && !noted.has(owner)) missing.set(owner, [...(missing.get(owner) ?? []), row.path]);
  }
  assert.equal(
    missing.size,
    0,
    'Changed public packages need a pending release note:\n' +
      [...missing]
        .map(([name, paths]) => `  ${name}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}`)
        .join('\n') +
      '\nRun: pnpm release:note --bump <none|patch|minor|major> --title "…" --summary "…" (none: no consumer-facing change)',
  );
  // `none` notes ride along with the next release but never start one.
  const bumps = notes.map(({ note }) => note.bump).filter((bump) => bump !== 'none');
  const next = !notes.length
    ? null
    : published
      ? bumps.length
        ? bumpVersion(policy.version, maxBump(bumps))
        : null
      : bumpVersion(
          policy.baseline.version,
          maxBump([entry.bump ?? releaseBump(policy.baseline.version, policy.version), ...bumps]),
        );
  return {
    version: policy.version,
    state: published ? 'published' : 'prepared',
    published,
    pendingNotes: notes.map(({ id }) => id),
    unreleasedFiles: outside.length,
    nextVersion: next,
  };
}
/** Re-derive exact coverage from the reviewed change scopes and regenerate the changelog. */
export function collectChanges(root, projects) {
  const policy = releasePolicy(root),
    path = changesetPath(policy.version),
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
  writeFileSync(resolve(root, 'CHANGELOG.md'), renderChangelog(changesetHistory(root, policy)));
  return releaseChanges(root, projects);
}
/** GitHub release notes for one consumed changeset. */
export function releaseNotes(root, version) {
  const entry = json(root, changesetPath(version));
  // Drop the changelog preamble and the version heading; the GitHub release carries its own title.
  const section = renderChangelog([entry]).split('\n').slice(6).join('\n').trim();
  return `${section}\n\nInstall: \`npm install @inventarch/cli@${version}\`\n`;
}
if (isEntry(process.argv[1], import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { strict: { type: 'boolean', default: false }, version: { type: 'string' } },
  });
  const root = resolve(import.meta.dirname, '../..');
  assert.ok(
    positionals.length === 1 && ['check', 'collect', 'notes'].includes(positionals[0]),
    'Use check [--strict], collect or notes --version <version>',
  );
  // Both checks refuse a manifest the version rewrite or the packed exports cannot rely on.
  if (positionals[0] === 'check') {
    const problems = manifestProblems(root);
    assert.equal(problems.length, 0, 'Package manifests need repair:\n' + problems.map((row) => '  ' + row).join('\n'));
  }
  if (positionals[0] === 'notes') {
    assert.ok(stableVersion(values.version), 'notes requires --version');
    process.stdout.write(releaseNotes(root, values.version));
  } else if (positionals[0] === 'check' && !values.strict) {
    const status = releaseStatus(root, publicPackages(root));
    // The selection a release would seal: new or renamed public packages refuse here, in the pull request.
    publicPackageInputs(root, { sealed: false });
    console.log(JSON.stringify(status, null, 2));
  } else {
    const result =
      positionals[0] === 'collect'
        ? collectChanges(root, publicPackages(root))
        : releaseChanges(root, publicPackages(root));
    // Release preparation packs exactly the committed descriptor, so it must already be sealed.
    if (positionals[0] === 'check') publicPackageInputs(root);
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
}
