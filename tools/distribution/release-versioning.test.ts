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
  releaseChanges,
  releaseStatus,
  renderChangelog,
  validateChangesetStructure,
  type Changeset,
  type ReleasePolicy,
} from './release-changes.mjs';
import { bumpVersion, draftNote, inferBump, maxBump, notePaths, releaseBump, validateNote } from './release-notes.mjs';
import { a, b, c, refusal } from './release-fixtures.js';
import { versionRelease } from './release-version.mjs';

const names = ['@inventarch/a', '@inventarch/b'];
const note = (bump: string, packages: string[], title: string) => ({
  format: 'ia.npm-change-note.v1',
  bump,
  title,
  summary: `${title} for package consumers.`,
  packages,
  paths: packages.map((name) => `packages/${name.slice(12)}/`),
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
