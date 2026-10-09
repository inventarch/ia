import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { PUBLIC_INPUTS, publicPackageInputs, refreshPublicPackageInputs } from '../release/public-pack.mjs';
import { REGISTRY } from './npm-release.mjs';
import {
  RELEASE_POLICY,
  SYSTEM_PACKAGE_POLICY,
  baselineVersion,
  changesetPath,
  collectChanges,
  publishedCohort,
  publishedCommit,
  releaseChanges,
  releaseNotes,
  releasePolicy,
  releaseTag,
  sha256,
  trackedChanges,
} from './release-changes.mjs';
import { GENERATED_CHANGES, bumpVersion, maxBump, packageOwner, pendingNotes, releaseBump } from './release-notes.mjs';
import { publicPackages } from './release-packages.mjs';

/** Private files that follow the cohort version: the editor extension and the dependency attribution its build writes. */
export const EDITOR_MANIFEST = 'apps/vscode/package.json';
export const EDITOR_NOTICES = 'apps/vscode/THIRD_PARTY_NOTICES.txt';
const json = (root, path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sentence = (text) => text.trim().replace(/\.?$/, '.');
const generatedSummary = (version, count, titles) =>
  `Coordinated ${version} release of the ${count} public npm packages: ${titles.map((t) => t.trim().replace(/\.$/, '')).join('; ')}.`;

/** Rewrite one top-level manifest version and prove nothing else changed. */
function setManifestVersion(root, path, from, to) {
  const file = resolve(root, path),
    text = readFileSync(file, 'utf8'),
    pattern = /^( {2}"version": ")([^"]+)(",?\r?)$/m,
    match = pattern.exec(text);
  assert.ok(match && match[2] === from, `${path}: expected top-level version ${from}`);
  const next = text.replace(pattern, `$1${to}$3`),
    before = JSON.parse(text),
    after = JSON.parse(next);
  assert.deepEqual({ ...after, version: before.version }, before, `${path}: version rewrite changed other fields`);
  writeFileSync(file, next);
}
function setPolicyVersions(root, from, to) {
  const file = resolve(root, SYSTEM_PACKAGE_POLICY),
    text = readFileSync(file, 'utf8'),
    next = text.replaceAll(`"npmVersion": "${from}"`, `"npmVersion": "${to}"`),
    before = JSON.parse(text),
    after = JSON.parse(next);
  for (const owner of before.owners) owner.npmVersion = to;
  assert.deepEqual(after, before, `${SYSTEM_PACKAGE_POLICY}: every npmVersion must move from ${from} to ${to}`);
  writeFileSync(file, next);
}
function setNoticeVersions(root, names, from, to) {
  const file = resolve(root, EDITOR_NOTICES);
  let text = readFileSync(file, 'utf8');
  for (const name of names)
    text = text.replace(new RegExp(`^${escape(name)}@${escape(from)}(\r?)$`, 'gm'), `${name}@${to}$1`);
  assert.ok(
    !names.some((name) => new RegExp(`^${escape(name)}@${escape(from)}\r?$`, 'm').test(text)),
    `${EDITOR_NOTICES}: cohort attribution still names ${from}`,
  );
  writeFileSync(file, text);
}
/** Areas outside every package. Package roots are claimed file by file so this entry can never cover a package. */
function maintenancePaths(rows) {
  return [
    ...new Set(
      rows.map(({ path }) => {
        const top = path.split('/')[0];
        return path.includes('/') && !['packages', 'apps', '.ia'].includes(top) ? top + '/' : path;
      }),
    ),
  ].sort();
}
/** Put every file the versioner wrote or removed back to HEAD; files new since HEAD are removed. */
function rollback(root, paths) {
  for (const path of new Set(paths)) {
    if (git(root, 'ls-tree', '--name-only', 'HEAD', '--', path)) {
      git(root, 'restore', '--source=HEAD', '--staged', '--worktree', '--', path);
    } else {
      git(root, 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', path);
      rmSync(resolve(root, path), { force: true });
    }
  }
}
async function registryHas(name, version) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return false;
  assert.ok(response.ok, `${name}: registry returned ${response.status}`);
  return Object.hasOwn((await response.json()).versions ?? {}, version);
}

/**
 * Fold pending notes into the next coordinated release. A published version (its `v<version>` tag exists) becomes the
 * new baseline. An unpublished prepared release is amended in place (renamed if the notes raise its bump), or with
 * `refresh` re-collected when it has no notes but its coverage went stale. `publishedOnly` waits instead: a prepared
 * release may already be publishing from its own commit, and amending main underneath it would strand the notes.
 * Every refusal happens before the first write; a later failure restores the files the versioner touched.
 */
export async function versionRelease(root, projects, options = {}) {
  const { write = false, registry = registryHas, sealInputs = true, refresh = false, publishedOnly = false } = options;
  const policy = releasePolicy(root),
    names = projects.map((project) => project.manifest.name).sort(),
    notes = pendingNotes(root, names),
    published = publishedCommit(root, policy.version);
  if (write) assert.equal(git(root, 'status', '--porcelain'), '', 'Commit or stash local changes before versioning');
  if (registry) {
    // A tag is complete when npm has every package its changeset lists, by npm name, wherever the package lives now and
    // even after its removal. npm isn't asked about a name that changeset doesn't list: it joins with the next version.
    // A tag without a changeset, or with one that lists no packages, falls back to every current package.
    const checked = published
      ? (publishedCohort(root, { commit: published, version: policy.version }) ?? names)
      : names;
    const listed = await Promise.all(checked.map((name) => registry(name, policy.version)));
    if (published) {
      const missing = checked.filter((_, index) => !listed[index]);
      assert.ok(
        !missing.length,
        `${releaseTag(policy.version)} exists but npm lacks part of the ${policy.version} cohort (${missing.join(', ')}); finish that publication first`,
      );
    } else
      assert.ok(
        !listed.some(Boolean),
        `npm already has ${policy.version} but ${releaseTag(policy.version)} is missing; rerun the publish workflow's release job or tag the published commit`,
      );
  }
  const state = published ? 'published' : 'prepared',
    none = (reason) => ({ action: 'none', state, version: policy.version, pending: notes.length, reason });
  if (!published && publishedOnly)
    return none(
      `${policy.version} is prepared but not yet published; pending notes wait for ${releaseTag(policy.version)}`,
    );
  if (!notes.length) {
    if (published) return none('No pending release notes');
    if (!refresh) return none(`${policy.version} is prepared; pass --refresh to re-collect it`);
    try {
      releaseChanges(root, projects);
      return none(`${policy.version} is prepared and current`);
    } catch {}
  }
  const baseline = published ? { commit: published, version: policy.version } : policy.baseline,
    existing = published ? null : json(root, changesetPath(policy.version)),
    // `none` notes ride along with the next release but never start one.
    bumps = notes.map(({ note }) => note.bump).filter((bump) => bump !== 'none');
  if (existing) bumps.push(existing.bump ?? releaseBump(baseline.version, policy.version));
  else if (!bumps.length) return none('Pending notes record no consumer-facing change; they wait for the next release');
  const bump = maxBump(bumps),
    version = bumpVersion(baseline.version, bump),
    action = published ? 'version' : notes.length ? 'amend' : 'refresh';
  const plan = { action, state, previous: policy.version, version, bump, baseline, notes: notes.map(({ id }) => id) };
  if (!write) return plan;

  const kept = (existing?.changes ?? []).filter((change) => !GENERATED_CHANGES.includes(change.id)),
    ids = new Set(kept.map((change) => change.id));
  const fromNotes = notes.map(({ id, note }) => {
    let unique = id;
    for (let suffix = 2; ids.has(unique); suffix++) unique = `${id}-${suffix}`;
    ids.add(unique);
    return {
      id: unique,
      title: note.title,
      summary: note.summary,
      packages: [...note.packages].sort(),
      paths: note.paths,
    };
  });
  const authored = [...kept, ...fromNotes],
    named = new Set(authored.flatMap((change) => change.packages)),
    directories = new Map(projects.map((project) => [project.manifest.name, project.directory])),
    cohort = names.filter((name) => !named.has(name)),
    changes = [...authored];
  if (cohort.length)
    changes.push({
      id: 'cohort-alignment',
      title: 'Coordinated version alignment',
      summary: `Packages without their own changes move to ${version} with the cohort; their contents are unchanged.`,
      packages: cohort,
      paths: cohort.map((name) => directories.get(name) + '/package.json'),
    });
  const claimed = (row) => changes.some((change) => change.paths.some((prefix) => row.path.startsWith(prefix)));
  // Refuse before writing. Version bumps only add cohort-only manifest rows, which never need a note.
  const orphaned = new Map();
  for (const row of trackedChanges(root, { ...policy, version, baseline })) {
    const owner = packageOwner(projects, row.path);
    if (owner && !row.cohortOnly && (!named.has(owner) || !claimed(row)))
      orphaned.set(owner, [...(orphaned.get(owner) ?? []), row.path]);
  }
  assert.equal(
    orphaned.size,
    0,
    'Changed public packages need a pending release note before versioning:\n' +
      [...orphaned].map(([name, paths]) => `  ${name}: ${paths.slice(0, 3).join(', ')}`).join('\n'),
  );

  const touched = [RELEASE_POLICY],
    removed = notes.map(({ path }) => path),
    path = changesetPath(version);
  if (version !== policy.version) {
    touched.push(...projects.map((project) => project.directory + '/package.json'));
    for (const optional of [EDITOR_MANIFEST, EDITOR_NOTICES, SYSTEM_PACKAGE_POLICY])
      if (existsSync(resolve(root, optional))) touched.push(optional);
    if (existing) removed.push(changesetPath(policy.version));
  }
  try {
    if (version !== policy.version) {
      for (const project of projects)
        setManifestVersion(root, project.directory + '/package.json', policy.version, version);
      if (touched.includes(EDITOR_MANIFEST)) setManifestVersion(root, EDITOR_MANIFEST, policy.version, version);
      if (touched.includes(EDITOR_NOTICES)) setNoticeVersions(root, names, policy.version, version);
      if (touched.includes(SYSTEM_PACKAGE_POLICY)) setPolicyVersions(root, policy.version, version);
    }
    if (removed.length) git(root, 'rm', '--quiet', '--', ...removed);
    writeFileSync(resolve(root, RELEASE_POLICY), JSON.stringify({ ...policy, version, baseline }, null, 2) + '\n');
    const unclaimed = trackedChanges(root, { ...policy, version, baseline }).filter((row) => !claimed(row));
    if (unclaimed.length)
      changes.push({
        id: 'repository-maintenance',
        title: 'Repository maintenance',
        summary: 'Tooling, workflow, documentation and release bookkeeping outside the published package contents.',
        packages: [],
        internal: true,
        paths: maintenancePaths(unclaimed),
      });
    const released = publishedCohort(root, baseline);
    const packages = Object.fromEntries(
      names.map((name) => {
        const prior = existing?.packages[name],
          previous = baselineVersion(root, baseline, released, { name, directory: directories.get(name) });
        if (!named.has(name)) {
          const summary =
            prior?.kind === 'cohort'
              ? prior.summary
              : 'No package changes; version aligned with the coordinated cohort.';
          return [name, { previous, kind: 'cohort', summary }];
        }
        // Keep a reviewed summary and append new note titles; otherwise summarize every change naming the package.
        const base = prior?.kind === 'changed' ? prior.summary.trim() : '',
          titles = (base ? fromNotes : authored)
            .filter((change) => change.packages.includes(name))
            .map((change) => sentence(change.title))
            .filter((title) => !base.includes(title));
        return [name, { previous, kind: 'changed', summary: [base, ...titles].filter(Boolean).join(' ') }];
      }),
    );
    const generated = generatedSummary(
      policy.version,
      names.length,
      kept.map((change) => change.title),
    );
    const summary =
      !existing || existing.summary === generated
        ? generatedSummary(
            version,
            names.length,
            authored.map((change) => change.title),
          )
        : existing.summary;
    const entry = { format: 'ia.npm-changeset.v1', version, state: 'consumed', baseline, bump, summary };
    writeFileSync(resolve(root, path), JSON.stringify({ ...entry, packages, changes, coverage: [] }, null, 2) + '\n');
    git(root, 'add', '--', ...touched, path);
    // Validate against the manifests as written, not the versions read before the bump.
    const current = projects.map(({ directory }) => ({ directory, manifest: json(root, directory + '/package.json') }));
    const result = collectChanges(root, current);
    git(root, 'add', '--', path, 'CHANGELOG.md');
    if (sealInputs && existsSync(resolve(root, PUBLIC_INPUTS))) {
      refreshPublicPackageInputs(root);
      git(root, 'add', '--', PUBLIC_INPUTS);
      publicPackageInputs(root);
    }
    return {
      ...plan,
      changeset: path,
      sha256: sha256(readFileSync(resolve(root, path))),
      files: result.entry.coverage.length,
    };
  } catch (error) {
    rollback(root, [...touched, ...removed, path, 'CHANGELOG.md', PUBLIC_INPUTS]);
    throw error;
  }
}

export function pullRequestBody(root, result) {
  const notes = result.notes.length ? result.notes.map((id) => `\`${id}\``).join(', ') : 'none';
  return `## Release ${result.version}

${releaseNotes(root, result.version)}
| | |
| --- | --- |
| Published baseline | ${result.baseline.version} (\`${result.baseline.commit.slice(0, 12)}\`) |
| Bump | ${result.bump} |
| Changeset | \`${result.changeset}\` |
| Changeset SHA256 | \`${result.sha256}\` |
| Covered files | ${result.files} |
| Notes consumed | ${notes} |

### Review

Check that the release prose matches the diff since the baseline. Edit the changeset prose on this branch if needed, then run \`pnpm release:collect\` and \`pnpm npm:inputs\`.

### After merge

Merging changes \`releases/current.json\` and the changeset. **Publish npm packages** then waits for Public quality on the merge commit, prepares and preflights the exact archives, and pauses for \`npm\` environment approval. After registry verification it tags \`${releaseTag(result.version)}\` and creates the GitHub release.

_Generated by \`pnpm release:version\`._
`;
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'published-only': { type: 'boolean', default: false },
      'pr-body': { type: 'string' },
    },
  });
  const root = resolve(import.meta.dirname, '../..');
  const result = await versionRelease(root, publicPackages(root), {
    write: values.write,
    registry: values.offline ? null : registryHas,
    refresh: values.refresh,
    publishedOnly: values['published-only'],
  });
  if (values['pr-body'] && result.changeset) writeFileSync(values['pr-body'], pullRequestBody(root, result));
  console.log(JSON.stringify(result, null, 2));
}
