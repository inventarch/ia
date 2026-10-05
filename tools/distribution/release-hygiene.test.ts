import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  releaseChanges,
  compareVersions,
  validateChangeset,
  type Changeset,
  type ReleasePolicy,
} from './release-changes.mjs';
import { releaseGraph } from './release-graph.mjs';
import { executableExports } from './installed-consumer.mjs';
import {
  publicationPlan,
  publicPackages,
  releaseVersions,
  validatePackages,
  verifyRegistryCohort,
} from './npm-release.mjs';
const root = resolve(import.meta.dirname, '../..');
const names = ['@inventarch/a', '@inventarch/b'];
const projects = names.map((name) => ({
  directory: 'packages/' + name.slice(12),
  manifest: { name, version: '1.1.0' },
}));
const policy: ReleasePolicy = {
  format: 'ia.npm-cohort.v1',
  version: '1.1.0',
  tag: 'latest',
  baseline: { commit: 'a'.repeat(40), version: '1.0.0' },
  cycles: [],
};
const coverage = [{ path: 'packages/a/src/index.ts', sha256: 'a'.repeat(64) }];
function changeset(): Changeset {
  return {
    format: 'ia.npm-changeset.v1',
    version: '1.1.0',
    state: 'consumed',
    baseline: policy.baseline,
    summary: 'Public release',
    packages: Object.fromEntries(
      names.map((name) => [
        name,
        { previous: '1.0.0', kind: 'changed', summary: 'Documented API and dependency changes' },
      ]),
    ),
    changes: [
      {
        id: 'runtime',
        title: 'Runtime changes',
        summary: 'Describe the observable change',
        packages: [...names],
        paths: ['packages/'],
      },
    ],
    coverage: coverage.map((row) => ({ ...row, change: 'runtime' })),
  };
}
it('requires one exact version across every public package and the sealed input map', () => {
  const packages = publicPackages(root),
    versions = releaseVersions(root),
    version = JSON.parse(readFileSync(resolve(root, 'releases/current.json'), 'utf8')).version;
  expect(() => validatePackages(packages, version, versions)).not.toThrow();
  const drift = structuredClone(packages);
  drift[0]!.manifest.version = '1.0.0';
  expect(() => validatePackages(drift, version, versions)).toThrow(/version differs/);
});
it('requires all packages and rejects an unknown or unlisted new package in the changeset', () => {
  expect(() => validateChangeset(changeset(), policy, projects, coverage)).not.toThrow();
  const missing = changeset();
  delete missing.packages[names[1]!];
  expect(() => validateChangeset(missing, policy, projects, coverage)).toThrow(/every public package/);
  const unknown = changeset();
  unknown.changes[0]!.packages.push('@inventarch/unknown');
  expect(() => validateChangeset(unknown, policy, projects, coverage)).toThrow(/unknown package/);
});
it('refuses missing changes, an unconsumed entry, stale versions and an unchanged published baseline', () => {
  for (const mutate of [
    (entry: Changeset) => {
      entry.changes = [];
    },
    (entry: Changeset) => {
      entry.state = 'pending';
    },
    (entry: Changeset) => {
      entry.version = '1.0.0';
    },
    (entry: Changeset) => {
      entry.packages[names[0]!]!.previous = '1.1.0';
    },
  ]) {
    const entry = changeset();
    mutate(entry);
    expect(() => validateChangeset(entry, policy, projects, coverage)).toThrow();
  }
  expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
  expect(() => compareVersions('1.1.0-rc.1', '1.0.0')).toThrow();
});
it('binds changed files to exact bytes and rejects stale, missing or mislabeled coverage', () => {
  for (const mutate of [
    (entry: Changeset) => {
      entry.coverage = [];
    },
    (entry: Changeset) => {
      entry.coverage[0]!.sha256 = 'b'.repeat(64);
    },
    (entry: Changeset) => {
      entry.coverage[0]!.change = 'missing';
    },
    (entry: Changeset) => {
      entry.packages[names[0]!]!.kind = 'cohort';
    },
    (entry: Changeset) => {
      entry.changes[0]!.packages = [names[1]!];
    },
  ]) {
    const entry = changeset();
    mutate(entry);
    expect(() => validateChangeset(entry, policy, projects, coverage)).toThrow();
  }
});
it('orders actual packed dependencies and refuses missing, ranged or wrong-version cohort dependencies', () => {
  const rows = [
    { name: names[0]!, version: '1.1.0', dependencies: { [names[1]!]: '1.1.0' } },
    { name: names[1]!, version: '1.1.0' },
  ];
  expect(releaseGraph(rows, '1.1.0', []).groups.map((group) => group.members)).toEqual([[names[1]], [names[0]]]);
  expect(() => releaseGraph(rows.slice(0, 1), '1.1.0', [])).toThrow(/missing cohort dependency/);
  for (const range of ['^1.1.0', '1.0.0', 'workspace:*'])
    expect(() =>
      releaseGraph([{ ...rows[0]!, dependencies: { [names[1]!]: range } }, rows[1]!], '1.1.0', []),
    ).toThrow();
});
it('requires an explicitly reviewed complete cycle group instead of pretending versions remove cycles', () => {
  const rows = names.map((name, index) => ({ name, version: '1.1.0', dependencies: { [names[1 - index]!]: '1.1.0' } }));
  expect(() => releaseGraph(rows, '1.1.0', [])).toThrow(/cycle policy/);
  expect(releaseGraph(rows, '1.1.0', [names]).groups).toEqual([{ members: names, cyclic: true }]);
  expect(() => releaseGraph(rows, '1.1.0', [[names[0]!]])).toThrow(/cycle policy/);
});
it('qualifies only declared executable exports as JavaScript and preserves native data targets', () => {
  const native = {
    name: '@inventarch/example',
    exports: { './native.ia.tgz': './dist/native.ia.tgz', './system-package.json': './dist/system-package.json' },
  };
  expect(executableExports(native)).toEqual([]);
  expect(
    executableExports({
      name: native.name,
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  ).toEqual([native.name]);
  expect(() => executableExports({ ...native, exports: { './native.ia.tgz': './dist/other.tgz' } })).toThrow(
    /data export/,
  );
  expect(() => executableExports({ ...native, exports: { './unknown.json': './dist/unknown.json' } })).toThrow(
    /Unknown executable/,
  );
});
const release = () => ({
  version: '1.1.0',
  tag: 'latest',
  packages: names.map((name) => ({
    name,
    version: '1.1.0',
    filename: 'example.tgz',
    bytes: 1,
    integrity: 'sha512-qualified',
  })),
});
const published = () => ({
  'dist-tags': { latest: '1.1.0' },
  versions: {
    '1.1.0': {
      dist: {
        integrity: 'sha512-qualified',
        tarball: 'https://registry.npmjs.org/example.tgz',
        attestations: {
          url: 'https://registry.npmjs.org/attestations/example',
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
      },
    },
  },
});
it('preflights a partial registry cohort before writes and retries only identical published bytes', () => {
  expect(
    publicationPlan(release(), { [names[0]!]: published(), [names[1]!]: { versions: {} } }).map(
      (entry) => entry.action,
    ),
  ).toEqual(['skip-identical', 'publish']);
  expect(() => publicationPlan(release(), { [names[0]!]: published(), [names[1]!]: null })).toThrow(
    /create the package/,
  );
  const changed = published();
  changed.versions['1.1.0'].dist.integrity = 'sha512-other';
  expect(() => publicationPlan(release(), { [names[0]!]: published(), [names[1]!]: changed })).toThrow(
    /existing npm bytes differ/,
  );
});
it('refuses wrong tags, registry downgrades and an incomplete final cohort', () => {
  const remote = published();
  remote['dist-tags'].latest = '1.0.0';
  expect(() => publicationPlan(release(), { [names[0]!]: remote })).toThrow(/latest tag/);
  expect(() => publicationPlan({ ...release(), tag: 'next' }, {})).toThrow(/release tag/);
  expect(() => publicationPlan(release(), { [names[0]!]: { versions: { '2.0.0': {} } } })).toThrow(/newer stable/);
  expect(() => verifyRegistryCohort(release(), { [names[0]!]: published(), [names[1]!]: { versions: {} } })).toThrow(
    /incomplete published/,
  );
  expect(verifyRegistryCohort(release(), Object.fromEntries(names.map((name) => [name, published()])))).toHaveLength(2);
});
it('refuses missing final provenance and untrusted registry download origins', () => {
  const noProvenance = {
    ...published(),
    versions: {
      '1.1.0': { dist: { integrity: 'sha512-qualified', tarball: 'https://registry.npmjs.org/example.tgz' } },
    },
  };
  expect(() => verifyRegistryCohort(release(), { [names[0]!]: noProvenance, [names[1]!]: published() })).toThrow(
    /provenance/,
  );
  const other = published();
  other.versions['1.1.0'].dist.tarball = 'https://example.invalid/archive';
  expect(() => verifyRegistryCohort(release(), { [names[0]!]: other, [names[1]!]: published() })).toThrow(/origin/);
});

it('allows justified version-only cohort entries but refuses an invented cohort-only exemption', () => {
  const entry = changeset();
  entry.packages[names[0]!]!.kind = 'cohort';
  entry.packages[names[0]!]!.summary = 'No API change; version-only cohort alignment';
  entry.coverage = [{ path: 'packages/a/package.json', sha256: 'a'.repeat(64), cohortOnly: true, change: 'runtime' }];
  expect(() =>
    validateChangeset(entry, policy, projects, [
      { path: 'packages/a/package.json', sha256: 'a'.repeat(64), cohortOnly: true },
    ]),
  ).not.toThrow();
  expect(() =>
    validateChangeset(entry, policy, projects, [{ path: 'packages/a/package.json', sha256: 'a'.repeat(64) }]),
  ).toThrow(/stale/);
});

it('refuses a missing release changeset before an artifact can be prepared', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-missing-changeset-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
  try {
    git('init', '--quiet');
    writeFileSync(resolve(directory, 'baseline.txt'), 'Published baseline');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Published baseline',
    );
    const baseline = git('rev-parse', 'HEAD').trim();
    mkdirSync(resolve(directory, 'releases'));
    writeFileSync(
      resolve(directory, 'releases/current.json'),
      JSON.stringify({ ...policy, baseline: { commit: baseline, version: '1.0.0' } }),
    );
    expect(() => releaseChanges(directory, projects)).toThrow(/Missing required release changeset/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
