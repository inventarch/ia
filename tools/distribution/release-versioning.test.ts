import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { PublicPackage } from './npm-release.mjs';
import {
  collectChanges,
  trackedChanges,
  releaseChanges,
  releaseNotes,
  releaseStatus,
  renderChangelog,
  validateChangesetStructure,
  validateChangeset,
  type Changeset,
  type ReleasePolicy,
} from './release-changes.mjs';
import { bumpVersion, draftNote, inferBump, maxBump, notePaths, releaseBump, validateNote } from './release-notes.mjs';
import { a, b, c, changeset, refusal, inRepository, git as fixtureGit } from './release-fixtures.js';
import { pullRequestBody, versionRelease, type VersionResult } from './release-version.mjs';
import { prepareNativeSelection } from '../release/native-selectors.mjs';

const names = ['@inventarch/a', '@inventarch/b'];
const note = (bump: string, packages: string[], title: string) => ({
  format: 'ia.npm-change-note.v1',
  bump,
  title,
  summary: `${title} for package consumers.`,
  packages,
  paths: packages.map((name) => `packages/${name.slice(12)}/`),
});

/** Rendering does not need a Git checkout and must never alter the reviewed release files. */
function withReleaseBody(run: (root: string, entry: Changeset, result: VersionResult, save: () => void) => void) {
  const root = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-release-pr-body-'))),
    entry = changeset(),
    result: VersionResult = {
      action: 'version',
      state: 'published',
      version: entry.version,
      baseline: entry.baseline,
      bump: 'minor',
      changeset: `releases/changesets/${entry.version}.json`,
      sha256: 'b'.repeat(64),
      files: 42,
      notes: ['runtime'],
    };
  mkdirSync(resolve(root, 'releases/changesets'), { recursive: true });
  const save = () => {
    writeFileSync(resolve(root, result.changeset!), JSON.stringify(entry, null, 2) + '\n');
    writeFileSync(resolve(root, 'CHANGELOG.md'), renderChangelog([entry]));
  };
  try {
    save();
    run(root, entry, result, save);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('retains complete inline notes and metadata when the whole PR description fits', () => {
  withReleaseBody((root, _entry, result) => {
    for (const notes of [['runtime'], []]) {
      const body = pullRequestBody(root, { ...result, notes });
      expect(body).toContain(releaseNotes(root, result.version));
      expect(body).toContain(`| Notes consumed | ${notes.length ? '`runtime`' : 'none'} |`);
      expect(body).toContain(`| Changeset SHA256 | \`${result.sha256}\` |`);
      expect(body).toContain('### Review');
      expect(body).toContain('### After merge');
      expect(body).toContain('environment approval');
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(65_536);
    }
  });
});

it('includes the entire envelope in the exact UTF-8 budget and falls back one byte above it', () => {
  withReleaseBody((root, entry, result, save) => {
    entry.summary = 'x';
    save();
    const overhead = Buffer.byteLength(pullRequestBody(root, result), 'utf8') - 1;
    entry.summary = 'x'.repeat(60_000 - overhead);
    save();
    const exact = pullRequestBody(root, result);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(60_000);
    expect(exact).toContain(releaseNotes(root, result.version));
    entry.summary += 'x';
    save();
    const compact = pullRequestBody(root, result);
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(60_000);
    expect(compact).toContain('exceed the inline description budget');
    expect(compact).not.toContain(entry.summary);
  });
});

it.each(['é', '中', '🚀'])('preserves oversized %s notes in linked files without slicing Unicode', (character) => {
  withReleaseBody((root, entry, result, save) => {
    entry.summary = character.repeat(30_000);
    entry.changes[0]!.summary = `Complete final note: ${character}`;
    save();
    const files = [result.changeset!, 'CHANGELOG.md'],
      before = files.map((path) => readFileSync(resolve(root, path))),
      full = releaseNotes(root, result.version),
      body = pullRequestBody(root, result);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(body.length).toBeLessThan(65_536);
    expect([...body].length).toBeLessThan(65_536);
    expect(body).toContain('[changelog](https://github.com/inventarch/ia/blob/release/next/CHANGELOG.md)');
    expect(body).toContain(`[changeset](https://github.com/inventarch/ia/blob/release/next/${result.changeset})`);
    expect(body).toContain(`| Changeset SHA256 | \`${result.sha256}\` |`);
    expect(body).toContain('| Notes consumed | 1 (see the complete changeset) |');
    expect(body).toContain('### Review');
    expect(body).toContain('### After merge');
    expect(body).toContain('environment approval');
    expect(body).not.toContain('�');
    expect(releaseNotes(root, result.version)).toBe(full);
    expect(full).toContain(entry.changes[0]!.summary);
    expect(files.map((path) => readFileSync(resolve(root, path)))).toEqual(before);
  });
});

it('bounds an oversized consumed-note list even when the release prose is short', () => {
  withReleaseBody((root, _entry, result) => {
    result.notes = Array.from({ length: 10_000 }, (_, i) => `note-${i}`);
    const body = pullRequestBody(root, result);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(body).toContain('| Notes consumed | 10000 (see the complete changeset) |');
    expect(body).not.toContain('`note-9999`');
    expect(body).toContain('[changeset](');
  });
});

it('derives the next version from the largest pending bump and refuses skipped versions', () => {
  expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  expect(maxBump(['patch', 'major', 'minor'])).toBe('major');
  expect(() => maxBump([])).toThrow();
  expect(releaseBump('1.0.0', '1.1.0')).toBe('minor');
  expect(() => releaseBump('1.0.0', '1.2.0')).toThrow(/not the next/);
  expect(() => bumpVersion('1.0.0-rc.1', 'patch')).toThrow();
});

it('infers a bump only when every commit carries a conventional type', () => {
  expect(inferBump(['fix: guard empty input'])).toBe('patch');
  expect(inferBump(['fix: a', 'feat(cli): add flag'])).toBe('minor');
  expect(inferBump(['feat!: drop legacy format'])).toBe('major');
  expect(inferBump(['chore: tidy\n\nBREAKING CHANGE: removes an export'])).toBe('major');
  expect(inferBump(['feat: add', 'Plain subject'])).toBeNull();
  expect(inferBump([])).toBeNull();
});

it('accepts only complete notes for known packages under unreserved names', () => {
  expect(() => validateNote('faster-a', note('minor', [names[0]!], 'Faster A'), names)).not.toThrow();
  expect(() => validateNote('a-tests', note('none', [names[0]!], 'Cover A'), names)).not.toThrow();
  for (const [id, value] of [
    ['Faster-A', note('minor', [names[0]!], 'Faster A')],
    ['cohort-alignment', note('minor', [names[0]!], 'Faster A')],
    ['faster-a', note('huge', [names[0]!], 'Faster A')],
    ['faster-a', note('minor', [], 'Faster A')],
    ['faster-a', note('minor', ['@inventarch/unknown'], 'Faster A')],
    ['faster-a', note('minor', [names[0]!], 'Two\nlines')],
    ['faster-a', { ...note('minor', [names[0]!], 'Faster A'), extra: true }],
    ['faster-a', { ...note('minor', [names[0]!], 'Faster A'), paths: ['../outside'] }],
  ] as const)
    expect(() => validateNote(id, value, names)).toThrow();
});

it('refuses a bare @name in note prose, which would mention a GitHub account where the notes are published', () => {
  const prose = (title: string, summary: string) => ({ ...note('minor', [names[0]!], title), summary });
  for (const [title, summary] of [
    ['A `@workspace` field', 'Every `@decision`, `@spec` and `@task` record; `@inventarch/graph` is a package.'],
    [
      'Scoped packages stay plain',
      'Moves into @inventarch/graph and @inventarch/workspace-runtime; mail admin@example.com.',
    ],
  ])
    expect(() => validateNote('faster-a', prose(title!, summary!), names)).not.toThrow();
  for (const [title, summary, bare] of [
    ['@workspace declares its sources', 'Fine.', '@workspace'],
    ['A title', 'A @decision may carry a revision.', '@decision'],
    ['A title', 'Every @decision/@spec record.', '@decision'],
    ['A title', '@law, `@principle` and @convention.', '@law'],
    ['A title', 'An @authoring-guide names its file.', '@authoring-guide'],
  ])
    expect(() => validateNote('faster-a', prose(title!, summary!), names)).toThrow(`writes ${bare} bare`);
});

it('claims package directories and repository areas without covering another package', () => {
  const projects = names.map((name) => ({
    directory: 'packages/' + name.slice(12),
    manifest: { name, version: '1.0.0' },
  }));
  expect(
    notePaths(
      projects,
      [names[0]!],
      ['packages/a/src/x.ts', 'tools/build.mjs', 'packages/README.md', 'README.md', 'releases/pending/x.json'],
    ),
  ).toEqual(['README.md', 'packages/README.md', 'packages/a/', 'tools/']);
});

it('keeps internal maintenance entries out of the changelog and package-free', () => {
  const policy: ReleasePolicy = {
    format: 'ia.npm-cohort.v1',
    version: '1.1.0',
    tag: 'latest',
    baseline: { commit: 'a'.repeat(40), version: '1.0.0' },
    cycles: [],
  };
  const projects = names.map((name) => ({
    directory: 'packages/' + name.slice(12),
    manifest: { name, version: '1.1.0' },
  }));
  const entry: Changeset = {
    format: 'ia.npm-changeset.v1',
    version: '1.1.0',
    state: 'consumed',
    baseline: policy.baseline,
    bump: 'minor',
    summary: 'Release',
    packages: Object.fromEntries(
      names.map((name) => [name, { previous: '1.0.0', kind: 'changed', summary: 'Changed' }]),
    ),
    changes: [
      { id: 'feature', title: 'Feature', summary: 'Adds it', packages: [...names], paths: ['packages/'] },
      {
        id: 'repository-maintenance',
        title: 'Maintenance',
        summary: 'CI',
        packages: [],
        internal: true,
        paths: ['tools/'],
      },
    ],
    coverage: [],
  };
  expect(() => validateChangesetStructure(entry, policy, projects)).not.toThrow();
  expect(renderChangelog([entry])).toContain('### Feature');
  expect(renderChangelog([entry])).not.toContain('Maintenance');
  const leaky = structuredClone(entry);
  leaky.changes[1]!.packages = [names[0]!];
  expect(() => validateChangesetStructure(leaky, policy, projects)).toThrow(/internal changes name none/);
  const wrongBump = { ...structuredClone(entry), bump: 'major' as const };
  expect(() => validateChangesetStructure(wrongBump, policy, projects)).toThrow(/bump differs/);
});

it('versions, amends and protects a release from pending notes in a real repository', async () => {
  const temporaryRoot = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-release-version-test-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const projects = (): PublicPackage[] =>
    names.map((name) => {
      const directory = 'packages/' + name.slice(12);
      return { directory, manifest: read(directory + '/package.json') };
    });
  try {
    git('-c', 'init.defaultBranch=main', 'init', '--quiet');
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      git('config', key!, value!);
    for (const name of names) write(`packages/${name.slice(12)}/package.json`, { name, version: '1.0.0' });
    write('packages/a/index.txt', 'one\n');
    write('tools/build.txt', 'build\n');
    const baseline = commit('Published 1.0.0');

    // A hand-prepared 1.1.0, published and tagged.
    for (const name of names) write(`packages/${name.slice(12)}/package.json`, { name, version: '1.1.0' });
    write('packages/a/index.txt', 'two\n');
    write('releases/current.json', {
      format: 'ia.npm-cohort.v1',
      version: '1.1.0',
      tag: 'latest',
      baseline: { commit: baseline, version: '1.0.0' },
      cycles: [],
    });
    write('releases/changesets/1.1.0.json', {
      format: 'ia.npm-changeset.v1',
      version: '1.1.0',
      state: 'consumed',
      baseline: { commit: baseline, version: '1.0.0' },
      summary: 'First coordinated release.',
      packages: {
        [names[0]!]: { previous: '1.0.0', kind: 'changed', summary: 'A changes.' },
        [names[1]!]: { previous: '1.0.0', kind: 'cohort', summary: 'Version only.' },
      },
      changes: [
        {
          id: 'a-change',
          title: 'A change',
          summary: 'A changes.',
          packages: names,
          paths: ['packages/', 'releases/'],
        },
      ],
      coverage: [],
    });
    git('add', '-A');
    collectChanges(root, projects());
    const published = commit('Release 1.1.0');
    git('tag', 'v1.1.0');
    expect(releaseStatus(root, projects())).toMatchObject({ state: 'published', pendingNotes: [], nextVersion: null });
    expect(await versionRelease(root, projects(), { write: true, registry: null })).toMatchObject({ action: 'none' });

    // A package change after publication needs a note; a tooling change does not.
    write('packages/a/index.txt', 'three\n');
    write('tools/build.txt', 'build 2\n');
    commit('Speed up a');
    expect(() => releaseStatus(root, projects())).toThrow(/need a pending release note[\s\S]*@inventarch\/a/);

    git('switch', '--quiet', '-c', 'feature');
    write('packages/a/extra.txt', 'extra\n');
    commit('feat(a): add extra output');
    const drafted = draftNote(root, projects(), { base: 'main' });
    expect(drafted.note).toMatchObject({
      bump: 'minor',
      title: 'add extra output',
      packages: [names[0]],
      paths: ['packages/a/'],
    });
    git('switch', '--quiet', 'main');
    git('merge', '--quiet', '--no-edit', 'feature');

    // A no-impact note satisfies the check but never starts a release on its own.
    write('releases/pending/a-tests.json', note('none', [names[0]!], 'Cover A with tests'));
    commit('Describe a tests');
    expect(releaseStatus(root, projects())).toMatchObject({ pendingNotes: ['a-tests'], nextVersion: null });
    expect(await versionRelease(root, projects(), { write: true, registry: null })).toMatchObject({
      action: 'none',
      pending: 1,
    });

    write('releases/pending/faster-a.json', note('minor', [names[0]!], 'Faster A'));
    commit('Describe a');
    expect(releaseStatus(root, projects())).toMatchObject({
      pendingNotes: ['a-tests', 'faster-a'],
      nextVersion: '1.2.0',
    });
    write('scratch.txt', 'dirty\n');
    await expect(versionRelease(root, projects(), { write: true, registry: null })).rejects.toThrow(/Commit or stash/);
    rmSync(resolve(root, 'scratch.txt'));
    // A tag without the registry cohort is an unfinished publication, not a baseline.
    await expect(versionRelease(root, projects(), { write: false, registry: async () => false })).rejects.toThrow(
      /lacks part of the 1\.1\.0 cohort/,
    );

    // A failure after the first write restores every file the versioner touched.
    writeFileSync(resolve(root, 'packages/b/package.json'), JSON.stringify({ name: names[1], version: '1.1.0' }));
    commit('Compact b manifest');
    await expect(versionRelease(root, projects(), { write: true, registry: null })).rejects.toThrow(
      /expected top-level version/,
    );
    expect(git('status', '--porcelain')).toBe('');
    write('packages/b/package.json', { name: names[1], version: '1.1.0' });
    commit('Restore b manifest');

    const versioned = await versionRelease(root, projects(), { write: true, registry: null });
    expect(versioned).toMatchObject({
      action: 'version',
      version: '1.2.0',
      bump: 'minor',
      notes: ['a-tests', 'faster-a'],
    });
    expect(pullRequestBody(root, versioned)).toContain(releaseNotes(root, '1.2.0'));
    expect(projects().map((project) => project.manifest.version)).toEqual(['1.2.0', '1.2.0']);
    expect(read('releases/current.json').baseline).toEqual({ commit: published, version: '1.1.0' });
    expect(existsSync(resolve(root, 'releases/pending/faster-a.json'))).toBe(false);
    const entry = read('releases/changesets/1.2.0.json') as Changeset;
    expect(entry.changes.map((change) => change.id)).toEqual([
      'a-tests',
      'faster-a',
      'cohort-alignment',
      'repository-maintenance',
    ]);
    expect(entry.packages[names[0]!]).toEqual({
      previous: '1.1.0',
      kind: 'changed',
      summary: 'Cover A with tests. Faster A.',
    });
    expect(entry.packages[names[1]!]!.kind).toBe('cohort');
    expect(entry.changes.find((change) => change.id === 'repository-maintenance')).toMatchObject({
      internal: true,
      packages: [],
      paths: ['releases/', 'tools/'],
    });
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog.indexOf('## 1.2.0')).toBeLessThan(changelog.indexOf('## 1.1.0'));
    expect(changelog).not.toContain('Repository maintenance');
    expect(() => releaseChanges(root, projects())).not.toThrow();
    commit('Release 1.2.0');
    expect(releaseStatus(root, projects())).toMatchObject({ state: 'prepared', pendingNotes: [] });
    await expect(versionRelease(root, projects(), { write: false, registry: async () => true })).rejects.toThrow(
      /npm already has 1\.2\.0 but v1\.2\.0 is missing/,
    );

    // Tooling merged after the release commit leaves it alone unless a maintainer asks for a refresh.
    write('tools/build.txt', 'build 3\n');
    commit('Tooling after the release commit');
    expect(await versionRelease(root, projects(), { write: true, registry: null })).toMatchObject({ action: 'none' });
    expect(() => releaseChanges(root, projects())).toThrow(/coverage is missing or stale/);
    expect(await versionRelease(root, projects(), { write: true, registry: null, refresh: true })).toMatchObject({
      action: 'refresh',
      version: '1.2.0',
    });
    expect(() => releaseChanges(root, projects())).not.toThrow();
    commit('Refresh 1.2.0');

    // Before publication a larger bump amends and renames the unpublished release; CI waits for the tag instead.
    write('packages/b/index.txt', 'b\n');
    write('releases/pending/breaking-b.json', note('major', [names[1]!], 'Breaking B'));
    commit('Break b');
    expect(releaseStatus(root, projects()).nextVersion).toBe('2.0.0');
    expect(await versionRelease(root, projects(), { write: true, registry: null, publishedOnly: true })).toMatchObject({
      action: 'none',
      pending: 1,
    });
    expect(await versionRelease(root, projects(), { write: true, registry: null })).toMatchObject({
      action: 'amend',
      version: '2.0.0',
      bump: 'major',
    });
    expect(existsSync(resolve(root, 'releases/changesets/1.2.0.json'))).toBe(false);
    const amended = read('releases/changesets/2.0.0.json') as Changeset;
    expect(amended.changes.map((change) => change.id)).toEqual([
      'a-tests',
      'faster-a',
      'breaking-b',
      'repository-maintenance',
    ]);
    expect(amended.baseline.version).toBe('1.1.0');
    expect(() => releaseChanges(root, projects())).not.toThrow();
    commit('Release 2.0.0');

    // A published changeset is immutable.
    git('tag', 'v2.0.0');
    write('releases/changesets/2.0.0.json', { ...amended, summary: 'Rewritten after publication.' });
    expect(() => releaseStatus(root, projects())).toThrow(/changed after v2\.0\.0 was published/);
  } finally {
    expect(dirname(root)).toBe(temporaryRoot);
    rmSync(root, { recursive: true, force: true });
  }
  // About fifty Git subprocesses; Windows and macOS runners take several times the local duration.
}, 120_000);

const x = '@inventarch/x';
/** The refusal for a tagged cohort that npm has only partly published, naming every package it lacks. */
const unfinished = (...missing: string[]) =>
  refusal(
    `v1.1.0 exists but npm lacks part of the 1.1.0 cohort (${missing.join(', ')}); finish that publication first`,
  );

/**
 * A real repository whose `v1.1.0` tag published `released`, one commit after a 1.0.0 commit that held `initial`.
 * Packages live at packages/<short name>. The 1.1.0 changeset lists `listed`; with `changeset: false` the tagged
 * commit carries none, and with `history: true` the 1.0.0 commit carries a changeset that lists `initial`.
 */
function taggedRelease(
  released: string[],
  { initial = released, listed = released, changeset = true, history = false } = {},
) {
  const root = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-release-cohort-test-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const manifest = (name: string, version: string) =>
    write(`packages/${name.slice(12)}/package.json`, { name, version });
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  // Every package directory, as publicPackages finds them, so moves, renames and removals show.
  const projects = (): PublicPackage[] =>
    readdirSync(resolve(root, 'packages'))
      .filter((entry) => existsSync(resolve(root, `packages/${entry}/package.json`)))
      .map((entry) => ({ directory: `packages/${entry}`, manifest: read(`packages/${entry}/package.json`) }));
  try {
    git('-c', 'init.defaultBranch=main', 'init', '--quiet');
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      git('config', key!, value!);
    for (const name of initial) manifest(name, '1.0.0');
    // Two earlier changesets whose string order differs from their version order.
    if (history)
      for (const version of ['0.9.0', '0.10.0'])
        write(`releases/changesets/${version}.json`, {
          format: 'ia.npm-changeset.v1',
          version,
          state: 'consumed',
          summary: 'Earlier release.',
          packages: Object.fromEntries(
            initial.map((name) => [name, { previous: null, kind: 'changed', summary: 'Earlier release.' }]),
          ),
          changes: [
            { id: 'first', title: 'First', summary: 'Earlier release.', packages: initial, paths: ['packages/'] },
          ],
          coverage: [],
        });
    const baseline = { commit: commit('Published 1.0.0'), version: '1.0.0' };
    for (const name of initial.filter((name) => !released.includes(name)))
      rmSync(resolve(root, 'packages/' + name.slice(12)), { recursive: true });
    for (const name of released) manifest(name, '1.1.0');
    write('releases/current.json', {
      format: 'ia.npm-cohort.v1',
      version: '1.1.0',
      tag: 'latest',
      baseline,
      cycles: [],
    });
    if (changeset)
      write('releases/changesets/1.1.0.json', {
        format: 'ia.npm-changeset.v1',
        version: '1.1.0',
        state: 'consumed',
        baseline,
        summary: 'Coordinated release.',
        packages: Object.fromEntries(
          listed.map((name) => [name, { previous: '1.0.0', kind: 'cohort', summary: 'Version only.' }]),
        ),
        changes: [
          { id: 'release', title: 'Release', summary: 'Version only.', packages: released, paths: ['packages/'] },
        ],
        coverage: [],
      });
    commit('Release 1.1.0');
    git('tag', 'v1.1.0');
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, git, write, read, manifest, commit, projects };
}

/** A registry that holds exactly the given `name@version` entries and records every lookup. */
function registryOf(...published: string[]) {
  const asked: string[] = [];
  const registry = async (name: string, version: string) => {
    asked.push(`${name}@${version}`);
    return published.includes(`${name}@${version}`);
  };
  return { asked, registry };
}

it('checks npm for the tagged cohort only: a new package, unregistered or bootstrapped, is never looked up', async () => {
  const repo = taggedRelease(names);
  const fetched: string[] = [];
  try {
    repo.manifest(c, '1.1.0');
    repo.write('releases/pending/add-c.json', note('minor', [c], 'Add C'));
    repo.commit('feat(c): add C');
    // npm answers 404 for a name nobody created, and npm:setup leaves only its 0.0.0-stage placeholder.
    for (const created of [false, true]) {
      vi.stubGlobal('fetch', async (url: string) => {
        const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
        fetched.push(name);
        if (name !== c) return Response.json({ versions: { '1.0.0': {}, '1.1.0': {} } });
        if (!created) return new Response('{}', { status: 404 });
        return Response.json({ 'dist-tags': { latest: '0.0.0-stage' }, versions: { '0.0.0-stage': {} } });
      });
      expect(await versionRelease(repo.root, repo.projects())).toMatchObject({
        action: 'version',
        version: '1.2.0',
        bump: 'minor',
      });
    }
    expect(fetched.sort()).toEqual([a, a, b, b]);
  } finally {
    vi.unstubAllGlobals();
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('checks a moved package under its npm name, keeps its published baseline and refuses any other', async () => {
  const repo = taggedRelease(names);
  try {
    repo.git('mv', 'packages/b', 'packages/b-moved');
    repo.write('releases/pending/move-b.json', { ...note('minor', [b], 'Move B'), paths: ['packages/b-moved/'] });
    repo.commit('feat(b): move B');
    await expect(
      versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`).registry }),
    ).rejects.toThrow(unfinished(b));
    const npm = registryOf(`${a}@1.1.0`, `${b}@1.1.0`);
    expect(await versionRelease(repo.root, repo.projects(), { write: true, registry: npm.registry })).toMatchObject({
      action: 'version',
      version: '1.2.0',
    });
    const path = 'releases/changesets/1.2.0.json',
      written = repo.read(path);
    expect(written.packages[b]).toMatchObject({ previous: '1.1.0' });
    // The strict release check derives the same baselines and refuses a changeset that records any other.
    for (const [name, previous] of [
      [b, null],
      [a, '1.0.0'],
    ] as const) {
      repo.write(path, {
        ...written,
        packages: { ...written.packages, [name]: { ...written.packages[name], previous } },
      });
      expect(() => releaseChanges(repo.root, repo.projects())).toThrow(
        refusal('Changeset package baseline differs from source evidence'),
      );
    }
    repo.write(path, written);
    expect(() => releaseChanges(repo.root, repo.projects())).not.toThrow();
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('checks a renamed package under its published name and records the new name as new', async () => {
  const repo = taggedRelease(names);
  try {
    repo.write('packages/b/package.json', { name: c, version: '1.1.0' });
    repo.write('releases/pending/rename-b.json', { ...note('minor', [c], 'Rename B to C'), paths: ['packages/b/'] });
    repo.commit('feat(c): rename B to C');
    await expect(
      versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`).registry }),
    ).rejects.toThrow(unfinished(b));
    const npm = registryOf(`${a}@1.1.0`, `${b}@1.1.0`);
    expect(await versionRelease(repo.root, repo.projects(), { write: true, registry: npm.registry })).toMatchObject({
      action: 'version',
      version: '1.2.0',
    });
    expect(npm.asked.sort()).toEqual([`${a}@1.1.0`, `${b}@1.1.0`]);
    expect(repo.read('releases/changesets/1.2.0.json').packages[c]).toMatchObject({ previous: null });
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('still requires a package the tag published after it is removed', async () => {
  const repo = taggedRelease(names);
  try {
    repo.git('rm', '--quiet', '-r', 'packages/b');
    repo.write('releases/pending/faster-a.json', note('minor', [a], 'Faster A'));
    repo.commit('feat(a): drop B');
    await expect(
      versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`).registry }),
    ).rejects.toThrow(unfinished(b));
    expect(
      await versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`, `${b}@1.1.0`).registry }),
    ).toMatchObject({ action: 'version', version: '1.2.0' });
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('gives a package that returns after a release dropped it the newest version an earlier changeset lists, else none', async () => {
  for (const history of [true, false]) {
    const repo = taggedRelease(names, { initial: [...names, x], history });
    try {
      repo.manifest(x, '1.1.0');
      repo.write('releases/pending/restore-x.json', note('minor', [x], 'Restore X'));
      repo.commit('feat(x): restore X');
      const npm = registryOf(`${a}@1.1.0`, `${b}@1.1.0`, `${x}@1.0.0`);
      expect(await versionRelease(repo.root, repo.projects(), { write: true, registry: npm.registry })).toMatchObject({
        action: 'version',
        version: '1.2.0',
      });
      expect(npm.asked.sort()).toEqual([`${a}@1.1.0`, `${b}@1.1.0`]);
      const path = 'releases/changesets/1.2.0.json',
        written = repo.read(path);
      expect(written.packages[x]).toMatchObject({ previous: history ? '0.10.0' : null });
      // The strict check derives the same baseline and refuses a changeset that records another.
      repo.write(path, {
        ...written,
        packages: { ...written.packages, [x]: { ...written.packages[x], previous: history ? null : '1.1.0' } },
      });
      expect(() => releaseChanges(repo.root, repo.projects())).toThrow(
        refusal('Changeset package baseline differs from source evidence'),
      );
      repo.write(path, written);
      repo.commit('Release 1.2.0');
      // The publish workflow runs the strict check on the committed release commit.
      expect(() => releaseChanges(repo.root, repo.projects())).not.toThrow();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
}, 60_000);

it('refuses a tag whose cohort npm has only partly published', async () => {
  const repo = taggedRelease(names);
  try {
    repo.write('releases/pending/faster-a.json', note('minor', [a], 'Faster A'));
    repo.commit('Describe a');
    await expect(
      versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`).registry }),
    ).rejects.toThrow(unfinished(b));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('reads the published cohort from the tag, not from a later copy of its changeset', async () => {
  const repo = taggedRelease(names);
  try {
    const entry = repo.read('releases/changesets/1.1.0.json');
    delete entry.packages[b];
    repo.write('releases/changesets/1.1.0.json', entry);
    repo.write('releases/pending/faster-a.json', note('minor', [a], 'Faster A'));
    repo.commit('Describe a');
    await expect(
      versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`).registry }),
    ).rejects.toThrow(unfinished(b));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('checks every current package when the tag carries no changeset or one that lists no packages', async () => {
  for (const options of [{ changeset: false }, { listed: [] }]) {
    const repo = taggedRelease(names, options);
    try {
      repo.manifest(c, '1.1.0');
      repo.write('releases/pending/add-c.json', note('minor', [c], 'Add C'));
      repo.commit('feat(c): add C');
      await expect(
        versionRelease(repo.root, repo.projects(), { registry: registryOf(`${a}@1.1.0`, `${b}@1.1.0`).registry }),
      ).rejects.toThrow(unfinished(c));
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
}, 60_000);

it('refuses an in-place rename against a tag that lists no packages before writing the changeset, leaving the checkout clean', async () => {
  const repo = taggedRelease(names, { listed: [] });
  try {
    repo.write('packages/b/package.json', { name: c, version: '1.1.0' });
    repo.write('releases/pending/rename-b.json', { ...note('minor', [c], 'Rename B to C'), paths: ['packages/b/'] });
    repo.commit('feat(c): rename B to C');
    await expect(versionRelease(repo.root, repo.projects(), { write: true, registry: null })).rejects.toThrow(
      refusal('Package identity differs from published baseline'),
    );
    expect(repo.git('status', '--porcelain')).toBe('');
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it('treats a 404 for a published package as missing and an error status as a registry failure', async () => {
  const repo = taggedRelease(names);
  try {
    repo.write('releases/pending/faster-a.json', note('minor', [a], 'Faster A'));
    repo.commit('Describe a');
    for (const [status, expected] of [
      [404, unfinished(b)],
      [503, refusal(`${b}: registry returned 503`)],
    ] as const) {
      vi.stubGlobal('fetch', async (url: string) =>
        url.endsWith(encodeURIComponent(b))
          ? new Response('', { status })
          : Response.json({ versions: { '1.1.0': {} } }),
      );
      await expect(versionRelease(repo.root, repo.projects())).rejects.toThrow(expected);
    }
  } finally {
    vi.unstubAllGlobals();
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 60_000);

it.each([
  { path: 'packages/a/src/index.ts', cohortOnly: undefined },
  { path: 'packages/a/src/index.ts-extra/package.json', cohortOnly: true },
])('refuses generated alignment entries without exact fresh applicability: $path', (row) => {
  const entry = changeset();
  entry.changes[0]!.id = 'cohort-alignment';
  entry.changes[0]!.paths = ['packages/a/src/index.ts'];
  entry.coverage = [
    {
      path: row.path,
      sha256: 'a'.repeat(64),
      ...(row.cohortOnly ? { cohortOnly: true } : {}),
      change: 'cohort-alignment',
    },
  ];
  const actual = entry.coverage.map(({ change: _change, ...proof }) => proof);
  expect(() =>
    validateChangeset(
      entry,
      { format: 'ia.npm-cohort.v1', version: entry.version, tag: 'latest', baseline: entry.baseline, cycles: [] },
      [a, b].map((name) => ({ directory: 'packages/' + name.slice(12), manifest: { name, version: entry.version } })),
      actual,
    ),
  ).toThrow(/applicable changeset entry/);
});

const nativeSystems = ['agent-system', 'session-system'] as const;
const nativeOwner = (system: string) => `.ia/src/systems/${system}`;
const nativeDeclaration = (system: string, version: string) =>
  `#! ia 1.0\n\n@system ${system}\n  version "${version}"\n  description "Retained meaning"\n\n@agent unrelated\n  description "Retained other record"\n`;
const nativePaths = [
  'apps/cli/tests/fixtures/composition-workspace/.ia/release.json',
  ...nativeSystems.flatMap((system) => [
    nativeOwner(system) + '/system.ia',
    `examples/public-language/contracts/${system}.ia`,
  ]),
  'tools/distribution/system-package-policy.json',
  'examples/public-language/versions.json',
];

/**
 * A published npm release (3.0.0 by default, from its prior npm version) with two native owners whose archives default
 * to 3.0.0; `natives` gives an owner or the language its own version. Native packing tests the twelve-archive inventory.
 */
async function withAlignedRelease(
  run: (repo: {
    root: string;
    write: (path: string, value: unknown) => void;
    read: (path: string) => any;
    commit: (message: string) => Promise<string>;
    projects: () => PublicPackage[];
    note: (narrowOwner?: boolean, bump?: 'patch' | 'minor' | 'major') => Promise<void>;
  }) => Promise<void>,
  release: { prior?: string; published?: string; natives?: Record<string, string> } = {},
) {
  const { prior = '2.0.0', published = '3.0.0', natives = {} } = release;
  await inRepository(async (root) => {
    const write = (path: string, value: unknown) => {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    };
    const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    const commit = async (message: string) => {
      await fixtureGit(root, 'add', '-A');
      await fixtureGit(root, 'commit', '--quiet', '-m', message);
      return fixtureGit(root, 'rev-parse', 'HEAD');
    };
    const directories = ['apps/cli', ...nativeSystems.map(nativeOwner)];
    const projects = () => directories.map((directory) => ({ directory, manifest: read(directory + '/package.json') }));
    const select = (npmVersion: string, nativeVersion: string, own: Record<string, string> = {}) => {
      const version = (id: string) => own[id] ?? nativeVersion;
      write('apps/cli/tests/fixtures/composition-workspace/.ia/release.json', {
        formatVersion: 1,
        id: 'local/demo',
        version: '0.1.0',
        engine: '^0.1.1',
        language: ['1.0'],
        dependencies: [{ id: 'inventarch/language', range: '^' + version('language'), systems: [...nativeSystems] }],
        assets: [],
      });
      for (const directory of directories)
        write(directory + '/package.json', { name: '@inventarch/' + directory.split('/').at(-1), version: npmVersion });
      for (const system of nativeSystems)
        for (const path of [nativeOwner(system) + '/system.ia', `examples/public-language/contracts/${system}.ia`])
          write(path, nativeDeclaration(system, version(system)));
      write('tools/distribution/system-package-policy.json', {
        format: 'ia.system-package-policy.v2',
        packages: nativeSystems.map(nativeOwner),
        owners: nativeSystems.map((system) => ({
          owner: nativeOwner(system),
          kind: 'native-only',
          npmVersion,
          native: {
            system,
            id: 'inventarch/' + system,
            version: version(system),
            distribution: 'workspace-system/definition/distribution/package-' + system,
          },
        })),
      });
      write('examples/public-language/versions.json', {
        format: 'ia.public-native-versions.v1',
        language: version('language'),
      });
    };
    write('package.json', { name: '@inventarch/workspace', private: true });
    select(prior, prior === '2.0.0' ? '1.2.0' : '3.0.0');
    write('apps/cli/index.txt', 'CLI before\n');
    write(nativeOwner('agent-system') + '/references/guide.md', 'Guide before\n');
    write('releases/native/current.json', { retained: 'Native regeneration is a separate operation.' });
    const baseline = { commit: await commit('Published npm ' + prior), version: prior };
    select(published, '3.0.0', natives);
    // A tracked lookalike filename proves exact matching independently of the version-only proof.
    write(nativeOwner('agent-system') + '/system.ia-extra/package.json', {
      name: 'fixture-only',
      private: true,
      version: published,
    });
    write('releases/current.json', {
      format: 'ia.npm-cohort.v1',
      version: published,
      tag: 'latest',
      baseline,
      cycles: [],
    });
    const names = projects().map(({ manifest }) => manifest.name);
    write(`releases/changesets/${published}.json`, {
      format: 'ia.npm-changeset.v1',
      version: published,
      state: 'consumed',
      baseline,
      bump: releaseBump(prior, published),
      summary: 'Aligned release.',
      packages: Object.fromEntries(
        names.map((name) => [name, { previous: prior, kind: 'changed', summary: 'Aligned release.' }]),
      ),
      changes: [
        {
          id: 'aligned-release',
          title: 'Aligned release',
          summary: 'Aligned artifact versions.',
          packages: names,
          paths: ['apps/', '.ia/', 'examples/', 'tools/', 'releases/'],
        },
      ],
      coverage: [],
    });
    await fixtureGit(root, 'add', '-A');
    collectChanges(root, projects());
    await commit('Publish aligned ' + published);
    await fixtureGit(root, 'tag', 'v' + published);
    const note = async (narrowOwner = false, bump: 'patch' | 'minor' | 'major' = 'patch') => {
      write('apps/cli/index.txt', 'CLI corrected\n');
      write('releases/pending/cli-fix.json', {
        format: 'ia.npm-change-note.v1',
        bump,
        title: 'Correct CLI output',
        summary: 'CLI output is corrected.',
        packages: ['@inventarch/cli'],
        paths: ['apps/cli/'],
      });
      if (narrowOwner) {
        const path = nativeOwner('agent-system') + '/references/guide.md';
        write(path, 'Guide corrected\n');
        write('releases/pending/agent-guide.json', {
          format: 'ia.npm-change-note.v1',
          bump: 'none',
          title: 'Clarify agent guide',
          summary: 'The guide is clearer.',
          packages: ['@inventarch/agent-system'],
          paths: [path],
        });
      }
      await commit('Describe next release');
    };
    await run({ root, write, read, commit, projects, note });
  });
}

it.each([
  ['3.0.0', 'patch', '3.0.1'],
  ['3.0.0', 'minor', '3.1.0'],
  ['3.1.0', 'minor', '3.2.0'],
  ['3.14.0', 'minor', '3.15.0'],
] as const)(
  'keeps every 3.0.0 native selector when npm %s takes an npm-only %s to %s',
  async (published, bump, version) => {
    // Each fixture release is the next version after its prior one: 2.0.0 -> 3.0.0, 3.0.0 -> 3.1.0, 3.13.0 -> 3.14.0.
    const minor = Number(published.split('.')[1]),
      prior = minor === 0 ? '2.0.0' : `3.${minor - 1}.0`;
    await withAlignedRelease(
      async ({ root, read, projects, note }) => {
        await note(true, bump);
        const selectors = nativePaths
            .filter((path) => path !== 'tools/distribution/system-package-policy.json')
            .map((path) => readFileSync(resolve(root, path))),
          ledger = readFileSync(resolve(root, 'releases/native/current.json'));
        const result = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
        expect(result).toMatchObject({ action: 'version', version, nativeRegenerationRequired: true });
        expect(projects().map(({ manifest }) => manifest.version)).toEqual([version, version, version]);
        expect(
          read('tools/distribution/system-package-policy.json').owners.map(
            (owner: { npmVersion: string; native: { version: string } }) => [owner.npmVersion, owner.native.version],
          ),
        ).toEqual([
          [version, '3.0.0'],
          [version, '3.0.0'],
        ]);
        expect(
          nativePaths
            .filter((path) => path !== 'tools/distribution/system-package-policy.json')
            .map((path) => readFileSync(resolve(root, path))),
        ).toEqual(selectors);
        expect(readFileSync(resolve(root, 'releases/native/current.json'))).toEqual(ledger);
        const entry = read(result.changeset!) as Changeset;
        expect(entry.changes.find(({ id }) => id === 'cohort-alignment')).toMatchObject({
          packages: ['@inventarch/agent-system', '@inventarch/session-system'],
          paths: nativeSystems.map((system) => nativeOwner(system) + '/package.json'),
          summary: `Version metadata only: packages follow the coordinated ${version} release; native artifact versions follow their own selection.`,
        });
        expect(entry.coverage.some((row) => row.path.endsWith('/system.ia'))).toBe(false);
        expect(() => releaseChanges(root, projects())).not.toThrow();
      },
      { prior, published },
    );
  },
  120_000,
);

it('aligns mixed major-3 native selectors, including one still at 3.0.0, to an npm 4.0.0 release', async () => {
  await withAlignedRelease(
    async ({ root, read, projects, note }) => {
      expect(read('tools/distribution/system-package-policy.json').owners[1].native.version).toBe('3.0.0');
      await note(true, 'major');
      const result = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
      expect(result).toMatchObject({ action: 'version', version: '4.0.0', bump: 'major' });
      expect(
        read('tools/distribution/system-package-policy.json').owners.map(
          (owner: { npmVersion: string; native: { version: string } }) => [owner.npmVersion, owner.native.version],
        ),
      ).toEqual([
        ['4.0.0', '4.0.0'],
        ['4.0.0', '4.0.0'],
      ]);
      expect(read('examples/public-language/versions.json').language).toBe('4.0.0');
      expect(read('apps/cli/tests/fixtures/composition-workspace/.ia/release.json').dependencies[0].range).toBe(
        '^4.0.0',
      );
      for (const system of nativeSystems)
        for (const path of [nativeOwner(system) + '/system.ia', `examples/public-language/contracts/${system}.ia`])
          expect(readFileSync(resolve(root, path), 'utf8')).toBe(nativeDeclaration(system, '4.0.0'));
      expect(() => releaseChanges(root, projects())).not.toThrow();
    },
    { prior: '3.3.0', published: '3.4.0', natives: { 'agent-system': '3.2.1', language: '3.1.0' } },
  );
}, 120_000);

it('aligns every native selector at an npm major and covers a narrowly documented owner exactly', async () => {
  await withAlignedRelease(async ({ root, read, projects, note }) => {
    await note(true, 'major');
    const ledger = readFileSync(resolve(root, 'releases/native/current.json'));
    const result = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    expect(result).toMatchObject({ action: 'version', version: '4.0.0', nativeRegenerationRequired: true });
    expect(projects().map(({ manifest }) => manifest.version)).toEqual(['4.0.0', '4.0.0', '4.0.0']);
    const systems = read('tools/distribution/system-package-policy.json');
    expect(
      systems.owners.map((owner: { npmVersion: string; native: { version: string } }) => [
        owner.npmVersion,
        owner.native.version,
      ]),
    ).toEqual([
      ['4.0.0', '4.0.0'],
      ['4.0.0', '4.0.0'],
    ]);
    expect(read('examples/public-language/versions.json').language).toBe('4.0.0');
    for (const system of nativeSystems)
      for (const path of [nativeOwner(system) + '/system.ia', `examples/public-language/contracts/${system}.ia`])
        expect(readFileSync(resolve(root, path), 'utf8')).toBe(nativeDeclaration(system, '4.0.0'));
    expect(readFileSync(resolve(root, 'releases/native/current.json'))).toEqual(ledger);
    const entry = read(result.changeset!) as Changeset;
    expect(entry.changes.find(({ id }) => id === 'cohort-alignment')).toMatchObject({
      summary:
        'Version metadata only: packages follow the coordinated 4.0.0 release, and every native artifact aligns to 4.0.0 at this breaking major.',
      packages: ['@inventarch/agent-system', '@inventarch/session-system'],
      paths: nativeSystems
        .flatMap((system) => [nativeOwner(system) + '/package.json', nativeOwner(system) + '/system.ia'])
        .sort(),
    });
    for (const path of nativeSystems.flatMap((system) => [
      nativeOwner(system) + '/package.json',
      nativeOwner(system) + '/system.ia',
    ]))
      expect(entry.coverage.find((row) => row.path === path)).toMatchObject({
        cohortOnly: true,
        change: 'cohort-alignment',
      });
    expect(() => releaseChanges(root, projects())).not.toThrow();
  });
}, 120_000);

it('collects a later per-archive native selection with no refresh, and names the fix for a semantic change', async () => {
  await withAlignedRelease(async ({ root, write, read, commit, projects, note }) => {
    await note(true, 'minor');
    await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    await commit('Prepare 3.1.0');
    // The native release writer then selects a dependency-only session-system bump and a language bump.
    const selected = {
      'inventarch/agent-system': '3.0.0',
      'inventarch/session-system': '3.0.1',
      'inventarch/language': '3.0.1',
    };
    for (const [path, text] of prepareNativeSelection(root, '3.1.0', selected)) write(path, text);
    await commit('Select native versions');
    const declaration = nativeOwner('session-system') + '/system.ia',
      entry = collectChanges(root, projects()).entry;
    expect(entry.changes.find(({ id }) => id === 'cohort-alignment')!.paths).toContain(declaration);
    expect(entry.changes.find(({ id }) => id === 'repository-maintenance')!.paths).toContain('examples/');
    expect(entry.coverage.find((row) => row.path === declaration)).toMatchObject({
      cohortOnly: true,
      change: 'cohort-alignment',
    });
    expect(readFileSync(resolve(root, declaration), 'utf8')).toBe(nativeDeclaration('session-system', '3.0.1'));
    expect(read('examples/public-language/versions.json').language).toBe('3.0.1');
    expect(() => releaseChanges(root, projects())).not.toThrow();
    await commit('Collect release coverage');
    expect(() => releaseStatus(root, projects())).not.toThrow();
    // A semantic declaration change still needs its own reviewed scope, and both checks name the fix.
    write(declaration, nativeDeclaration('session-system', '3.0.1').replace('Retained meaning', 'Changed behavior'));
    expect(() => collectChanges(root, projects())).toThrow(
      `No reviewed change scope for ${declaration}: describe it with pnpm release:note, then run pnpm release:version --write to fold the note into the 3.1.0 release`,
    );
    expect(() => releaseStatus(root, projects())).toThrow(
      /Run: pnpm release:note [\s\S]*, then pnpm release:version --write to fold it into the prepared 3\.1\.0 release/,
    );
  });
}, 120_000);

/** Byte and index equality prove that late failures restore the whole reviewed fixture, including removed notes. */
async function alignedFixtureSnapshot(root: string) {
  const files = (await fixtureGit(root, 'ls-files')).split('\n').filter(Boolean);
  return {
    files: Object.fromEntries(files.map((path) => [path, readFileSync(resolve(root, path))])),
    index: await fixtureGit(root, 'ls-files', '--stage'),
    status: await fixtureGit(root, 'status', '--porcelain'),
  };
}

it('refreshes stale native selectors even when same-version npm major coverage is already fresh', async () => {
  await withAlignedRelease(async ({ root, write, read, commit, projects, note }) => {
    await note(true, 'major');
    await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    const selected = nativePaths.map((path) => readFileSync(resolve(root, path))),
      ledger = readFileSync(resolve(root, 'releases/native/current.json'));
    await commit('Prepare aligned 4.0.0');

    // Reproduce an older versioner: npm fields and its collected hashes are fresh, while every native selector lags.
    const policy = read('tools/distribution/system-package-policy.json');
    for (const owner of policy.owners) owner.native.version = '3.0.0';
    const fixture = read('apps/cli/tests/fixtures/composition-workspace/.ia/release.json');
    fixture.dependencies[0].range = '^3.0.0';
    write('apps/cli/tests/fixtures/composition-workspace/.ia/release.json', fixture);
    write('tools/distribution/system-package-policy.json', policy);
    write('examples/public-language/versions.json', { format: 'ia.public-native-versions.v1', language: '3.0.0' });
    for (const system of nativeSystems)
      for (const path of [nativeOwner(system) + '/system.ia', `examples/public-language/contracts/${system}.ia`])
        write(path, nativeDeclaration(system, '3.0.0'));
    collectChanges(root, projects());
    await commit('Collect npm coverage while native selectors lag');
    expect(() => releaseChanges(root, projects())).not.toThrow();
    expect(projects().map(({ manifest }) => manifest.version)).toEqual(['4.0.0', '4.0.0', '4.0.0']);
    expect(
      read('tools/distribution/system-package-policy.json').owners.map(
        (owner: { npmVersion: string }) => owner.npmVersion,
      ),
    ).toEqual(['4.0.0', '4.0.0']);

    const result = await versionRelease(root, projects(), {
      write: true,
      registry: null,
      sealInputs: false,
      refresh: true,
    });
    expect(result).toMatchObject({ action: 'refresh', version: '4.0.0', nativeRegenerationRequired: true });
    expect(nativePaths.map((path) => readFileSync(resolve(root, path)))).toEqual(selected);
    expect(readFileSync(resolve(root, 'releases/native/current.json'))).toEqual(ledger);
    expect(() => releaseChanges(root, projects())).not.toThrow();
  });
}, 120_000);

it('restores native selectors, the index, removed notes and sealed-input bytes after a late sealing failure', async () => {
  await withAlignedRelease(async ({ root, write, commit, projects, note }) => {
    await note(true, 'major');
    // This reaches sealing only after selector writes, git rm of notes and successful release collection.
    write('.ia/public-package-inputs.json', { sentinel: 'Keep these exact reviewed input bytes on failure.' });
    await commit('Retain an existing input seal');
    expect(existsSync(resolve(root, 'tools/distribution/public-content-policy.json'))).toBe(false);
    const before = await alignedFixtureSnapshot(root);
    expect(before.status).toBe('');

    await expect(versionRelease(root, projects(), { write: true, registry: null })).rejects.toThrow(
      /public-content-policy\.json/,
    );

    expect(await alignedFixtureSnapshot(root)).toEqual(before);
    expect(existsSync(resolve(root, 'releases/changesets/4.0.0.json'))).toBe(false);
    expect(existsSync(resolve(root, 'releases/pending/cli-fix.json'))).toBe(true);
    expect(existsSync(resolve(root, 'releases/pending/agent-guide.json'))).toBe(true);
  });
}, 120_000);

it('refuses a semantic edit under generated alignment, rejects a forged proof, and accepts authored fallback coverage', async () => {
  await withAlignedRelease(async ({ root, write, read, commit, projects, note }) => {
    await note(true, 'major');
    const result = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    await commit('Prepare aligned 4.0.0');
    const path = nativeOwner('agent-system') + '/system.ia',
      entry = read(result.changeset!) as Changeset,
      policy = read('releases/current.json') as ReleasePolicy;
    expect(entry.packages['@inventarch/agent-system']!.kind).toBe('changed');
    expect(entry.coverage.find((row) => row.path === path)).toMatchObject({
      cohortOnly: true,
      change: 'cohort-alignment',
    });
    write(path, nativeDeclaration('agent-system', '4.0.0').replace('Retained meaning', 'Changed behavior'));
    const actual = trackedChanges(root, policy),
      semantic = actual.find((row) => row.path === path);
    expect(semantic).toBeDefined();
    expect(semantic).not.toHaveProperty('cohortOnly');
    expect(() => collectChanges(root, projects())).toThrow('No reviewed change scope for ' + path);

    // Fresh hashes remove stale coverage as an alternative explanation for the strict applicability refusal.
    const fresh: Changeset = {
      ...structuredClone(entry),
      coverage: actual.map((row) => ({ ...row, change: entry.coverage.find((old) => old.path === row.path)!.change })),
    };
    expect(() => validateChangeset(fresh, policy, projects(), actual)).toThrow(
      'Changed file lacks an applicable changeset entry',
    );

    const forged = structuredClone(fresh);
    forged.coverage.find((row) => row.path === path)!.cohortOnly = true;
    write(result.changeset!, forged);
    expect(() => releaseChanges(root, projects())).toThrow(/coverage is missing or stale/);

    fresh.changes.push({
      id: 'agent-behavior',
      title: 'Correct agent behavior',
      summary: 'The agent behavior is corrected.',
      packages: ['@inventarch/agent-system'],
      paths: [nativeOwner('agent-system') + '/'],
    });
    write(result.changeset!, fresh);
    const collected = collectChanges(root, projects());
    expect(collected.entry.coverage.find((row) => row.path === path)).toMatchObject({ change: 'agent-behavior' });
    expect(collected.entry.coverage.find((row) => row.path === path)).not.toHaveProperty('cohortOnly');
    expect(() => releaseChanges(root, projects())).not.toThrow();
  });
}, 120_000);

it('lists exact generated filenames, adding a sibling manifest only by its own fresh version-only proof', async () => {
  await withAlignedRelease(async ({ root, write, read, commit, projects, note }) => {
    await note(true, 'major');
    const result = await versionRelease(root, projects(), { write: true, registry: null, sealInputs: false });
    await commit('Prepare aligned 4.0.0');
    const path = nativeOwner('agent-system') + '/system.ia-extra/package.json',
      entry = read(result.changeset!) as Changeset,
      policy = read('releases/current.json') as ReleasePolicy;
    expect(entry.changes.find(({ id }) => id === 'cohort-alignment')!.paths).toContain(
      nativeOwner('agent-system') + '/system.ia',
    );
    write(path, { name: 'fixture-only', private: true, version: '4.0.0' });
    const actual = trackedChanges(root, policy);
    expect(actual.find((row) => row.path === path)).toMatchObject({ cohortOnly: true });
    // Collect applies the versioner's rule: the sibling joins by its own exact path, not by the system.ia prefix.
    const regenerated = collectChanges(root, projects()).entry;
    expect(regenerated.changes.find(({ id }) => id === 'cohort-alignment')!.paths).toContain(path);
    expect(regenerated.coverage.find((row) => row.path === path)).toMatchObject({
      cohortOnly: true,
      change: 'cohort-alignment',
    });
    const fresh: Changeset = {
      ...structuredClone(entry),
      coverage: actual.map((row) => ({
        ...row,
        change: row.path === path ? 'cohort-alignment' : entry.coverage.find((old) => old.path === row.path)!.change,
      })),
    };
    expect(() => validateChangeset(fresh, policy, projects(), actual)).toThrow(
      'Changed file lacks an applicable changeset entry',
    );

    fresh.changes.push({
      id: 'agent-fixture',
      title: 'Align agent fixture',
      summary: 'The internal guide fixture follows the release.',
      packages: ['@inventarch/agent-system'],
      paths: [nativeOwner('agent-system') + '/'],
    });
    write(result.changeset!, fresh);
    expect(collectChanges(root, projects()).entry.coverage.find((row) => row.path === path)).toMatchObject({
      cohortOnly: true,
      change: 'agent-fixture',
    });
  });
}, 120_000);

it('refuses an undocumented semantic native change before generated alignment can authorize it', async () => {
  await withAlignedRelease(async ({ root, write, commit, projects, note }) => {
    await note(true);
    const path = nativeOwner('agent-system') + '/system.ia';
    write(path, nativeDeclaration('agent-system', '3.0.0').replace('Retained meaning', 'Undocumented behavior'));
    await commit('Change behavior outside the reviewed guide scope');
    const before = await alignedFixtureSnapshot(root);
    await expect(versionRelease(root, projects(), { write: true, registry: null, sealInputs: false })).rejects.toThrow(
      /need a pending release note before versioning:[\s\S]*agent-system\/system\.ia/,
    );
    expect(await alignedFixtureSnapshot(root)).toEqual(before);
    expect(existsSync(resolve(root, 'releases/changesets/3.0.1.json'))).toBe(false);
  });
}, 120_000);

it('runs the production versioner in a plain Node child that rejects every non-builtin package import', async () => {
  await withAlignedRelease(async ({ root, projects, note }) => {
    await note(true);
    // The release PR workflow runs this module before dependency installation. Keep that property executable.
    const loader = `import { isBuiltin } from 'node:module';
export async function resolve(specifier, context, nextResolve) {
  if (!isBuiltin(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/') &&
      !specifier.startsWith('file:') && !specifier.startsWith('data:'))
    throw new Error('Blocked non-builtin import: ' + specifier);
  return nextResolve(specifier, context);
}`;
    const dataUrl = (text: string) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64'),
      registration = dataUrl(
        `import { register } from 'node:module'; register(${JSON.stringify(dataUrl(loader))}, import.meta.url);`,
      ),
      moduleUrl = new URL('./release-version.mjs', import.meta.url).href,
      source = `import assert from 'node:assert/strict';
await assert.rejects(import('fixture-nonbuiltin-dependency'), /Blocked non-builtin import/);
const { versionRelease } = await import(${JSON.stringify(moduleUrl)});
const result = await versionRelease(${JSON.stringify(root)}, ${JSON.stringify(projects())}, { write: true, registry: null, sealInputs: false });
process.stdout.write(JSON.stringify(result));`;
    const output = execFileSync(process.execPath, ['--import', registration, '--input-type=module', '--eval', source], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    expect(JSON.parse(output)).toMatchObject({ action: 'version', version: '3.0.1', nativeRegenerationRequired: true });
    expect(() => releaseChanges(root, projects())).not.toThrow();
  });
}, 120_000);

it.each([false, true])(
  'keeps required native regeneration and resealing instructions in the PR body (compact=%s)',
  (compact) => {
    withReleaseBody((root, entry, result, save) => {
      result.nativeRegenerationRequired = true;
      if (compact) entry.summary = 'x'.repeat(60_001);
      save();
      const files = [result.changeset!, 'CHANGELOG.md'],
        before = files.map((path) => readFileSync(resolve(root, path))),
        body = pullRequestBody(root, result);
      expect(body.includes('exceed the inline description budget')).toBe(compact);
      expect(body).toContain('Native archive regeneration and qualification are still required.');
      for (const command of [
        'vocabulary:generate',
        'public:generate',
        'authoring:generate',
        'native:version --write',
        'platform:qualify',
        'release:collect',
        'npm:inputs',
        'npm:prepare',
      ])
        expect(body).toContain('`pnpm ' + command + '`');
      expect(body).toContain('fixed point');
      expect(body).toContain('regenerate projections');
      expect(body).toContain('After all source/generated bytes are final');
      expect(body).toContain('Selector updates do not qualify archives or authorize publication.');
      expect(body).not.toContain('--refresh');
      expect(body).toContain(`| Changeset SHA256 | \`${result.sha256}\` |`);
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(60_000);
      expect(files.map((path) => readFileSync(resolve(root, path)))).toEqual(before);
    });
  },
);
