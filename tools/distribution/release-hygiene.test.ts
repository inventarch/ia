import '../temp/physical-temp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { releaseChanges, compareVersions, validateChangeset, type Changeset } from './release-changes.mjs';
import { releaseGraph } from './release-graph.mjs';
import { publicPackageInputs } from '../release/public-pack.mjs';
import { executableExports } from './installed-consumer.mjs';
import {
  publicationPlan,
  publicPackages,
  releaseVersions,
  validatePackages,
  verifyRegistryCohort,
} from './npm-release.mjs';
import {
  a,
  b,
  changeset,
  checkout as root,
  coverage,
  git,
  inRepository,
  policy,
  project,
  refusal,
} from './release-fixtures.js';
const names = [a, b];
const projects = names.map(project);
const staleCoverage = (path: string) =>
  `Changeset coverage is missing or stale for 1 file(s): ${path}. Review the diff, then run pnpm release:collect (or pnpm release:version --write --refresh)`;
it('requires one exact version across every public package and the input map', () => {
  const packages = publicPackages(root),
    versions = releaseVersions(root, publicPackageInputs(root, { sealed: false })),
    version = JSON.parse(readFileSync(resolve(root, 'releases/current.json'), 'utf8')).version;
  expect(() => validatePackages(packages, version, versions)).not.toThrow();
  const drift = structuredClone(packages);
  drift[0]!.manifest.version = '1.0.0';
  expect(() => validatePackages(drift, version, versions)).toThrow(/version differs/);
});
const validate = (entry: Changeset) => () => validateChangeset(entry, policy(), projects, coverage());
it('requires all packages and rejects an unknown or unlisted new package in the changeset', () => {
  expect(validate(changeset())).not.toThrow();
  const missing = changeset();
  delete missing.packages[b];
  expect(validate(missing)).toThrow(refusal('Changeset must account for every public package exactly'));
  const unknown = changeset();
  unknown.changes[0]!.packages.push('@inventarch/unknown');
  expect(validate(unknown)).toThrow(refusal('Changeset names an unknown package'));
});
// Missing changes, a missing change entry and an omitted package are refused in release-refusals.test.ts.
it('refuses an unconsumed entry, stale versions and an unchanged published baseline', () => {
  for (const [mutate, message] of [
    [
      (entry: Changeset) => {
        entry.state = 'pending';
      },
      'Unconsumed changeset',
    ],
    [
      (entry: Changeset) => {
        entry.version = '1.0.0';
      },
      'Changeset version differs',
    ],
    [
      (entry: Changeset) => {
        entry.packages[a]!.previous = '1.1.0';
      },
      'Package version must advance its published baseline',
    ],
  ] as const) {
    const entry = changeset();
    mutate(entry);
    expect(validate(entry)).toThrow(refusal(message));
  }
  expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
  expect(() => compareVersions('1.1.0-rc.1', '1.0.0')).toThrow();
});
it('binds changed files to exact bytes and rejects stale coverage or a cohort-only claim on a changed package', () => {
  for (const [mutate, message] of [
    [
      (entry: Changeset) => {
        entry.coverage = [];
      },
      staleCoverage('packages/a/src/index.ts'),
    ],
    [
      (entry: Changeset) => {
        entry.coverage[0]!.sha256 = 'b'.repeat(64);
      },
      staleCoverage('packages/a/src/index.ts'),
    ],
    [
      (entry: Changeset) => {
        entry.packages[a]!.kind = 'cohort';
      },
      'Changed package cannot claim only a cohort bump',
    ],
  ] as const) {
    const entry = changeset();
    mutate(entry);
    expect(validate(entry)).toThrow(refusal(message));
  }
});
it('orders actual packed dependencies and refuses missing, ranged or wrong-version cohort dependencies', () => {
  const rows = [
    { name: names[0]!, version: '1.1.0', dependencies: { [names[1]!]: '1.1.0' } },
    { name: names[1]!, version: '1.1.0' },
  ];
  expect(releaseGraph(rows, '1.1.0', []).groups.map((group) => group.members)).toEqual([[names[1]], [names[0]]]);
  expect(() => releaseGraph(rows.slice(0, 1), '1.1.0', [])).toThrow(
    refusal('@inventarch/a: missing cohort dependency @inventarch/b'),
  );
  for (const [range, message] of [
    ['^1.1.0', '@inventarch/a: dependency @inventarch/b must use exact cohort version'],
    ['1.0.0', '@inventarch/a: dependency @inventarch/b must use exact cohort version'],
    ['workspace:*', '@inventarch/a: unsupported packed dependency source'],
  ])
    expect(() => releaseGraph([{ ...rows[0]!, dependencies: { [names[1]!]: range! } }, rows[1]!], '1.1.0', [])).toThrow(
      refusal(message!),
    );
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
  entry.packages[a]!.kind = 'cohort';
  entry.packages[a]!.summary = 'No API change; version-only cohort alignment';
  entry.coverage = [{ path: 'packages/a/package.json', sha256: 'a'.repeat(64), cohortOnly: true, change: 'runtime' }];
  expect(() =>
    validateChangeset(entry, policy(), projects, [
      { path: 'packages/a/package.json', sha256: 'a'.repeat(64), cohortOnly: true },
    ]),
  ).not.toThrow();
  expect(() =>
    validateChangeset(entry, policy(), projects, [{ path: 'packages/a/package.json', sha256: 'a'.repeat(64) }]),
  ).toThrow(refusal(staleCoverage('packages/a/package.json')));
});

it('refuses a missing release changeset before an artifact can be prepared', () =>
  inRepository(async (directory) => {
    writeFileSync(resolve(directory, 'baseline.txt'), 'Published baseline');
    await git(directory, 'add', '.');
    await git(directory, 'commit', '--quiet', '-m', 'Published baseline');
    const baseline = await git(directory, 'rev-parse', 'HEAD');
    mkdirSync(resolve(directory, 'releases'));
    writeFileSync(
      resolve(directory, 'releases/current.json'),
      JSON.stringify({ ...policy(), baseline: { commit: baseline, version: '1.0.0' } }),
    );
    expect(() => releaseChanges(directory, projects)).toThrow(refusal('Missing required release changeset'));
  }));
