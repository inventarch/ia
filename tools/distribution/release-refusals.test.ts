import '../temp/physical-temp.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { COMPATIBILITY, PUBLIC_SYSTEM_POLICY, publicPackageInputs } from '../release/public-pack.mjs';
import { runBounded } from '../testing/subprocess.js';
import {
  committedChanges,
  collectChanges,
  releaseChanges,
  releasePolicy,
  validateChangeset,
  type Changeset,
  type ReleasePolicy,
} from './release-changes.mjs';
import { releaseGraph, type PackedManifest } from './release-graph.mjs';
import {
  publicationPlan,
  publicPackages,
  verifyRegistryCohort,
  verifyRelease,
  writeReleaseManifest,
  type PackageManifest,
  type ReleaseArchive,
  type RegistryPackage,
} from './npm-release.mjs';

// One case per release refusal. Each pins the refusal's assertion code and authored message, and checks the nearest
// accepted input too, so a different check failing first, or an unrelated error, cannot satisfy it. The authored
// message must be the whole first line: after an equality refusal Node appends its own actual/expected comparison.
const firstLine = (text: string) =>
  expect.stringMatching(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n[\\s\\S]*)?$`));
const refusal = (message: string) =>
  expect.objectContaining({ code: 'ERR_ASSERTION', generatedMessage: false, message: firstLine(message) });
const [a, b, c] = ['@inventarch/a', '@inventarch/b', '@inventarch/c'] as const;
const project = (name: string) => ({ directory: 'packages/' + name.slice(12), manifest: { name, version: '1.1.0' } });

const policy = (): ReleasePolicy => ({
  format: 'ia.npm-cohort.v1',
  version: '1.1.0',
  tag: 'latest',
  baseline: { commit: 'a'.repeat(40), version: '1.0.0' },
  cycles: [],
});
const coverage = () => [{ path: 'packages/a/src/index.ts', sha256: 'a'.repeat(64) }];
function changeset(): Changeset {
  return {
    format: 'ia.npm-changeset.v1',
    version: '1.1.0',
    state: 'consumed',
    baseline: { commit: 'a'.repeat(40), version: '1.0.0' },
    summary: 'Public release',
    packages: {
      [a]: { previous: '1.0.0', kind: 'changed', summary: 'Adds an export' },
      [b]: { previous: '1.0.0', kind: 'cohort', summary: 'Version-only cohort alignment' },
    },
    changes: [
      {
        id: 'runtime',
        title: 'Runtime changes',
        summary: 'Describe the observable change',
        packages: [a, b],
        paths: ['packages/'],
      },
    ],
    coverage: coverage().map((row) => ({ ...row, change: 'runtime' })),
  };
}
const validate =
  (entry: Changeset, projects = [project(a), project(b)]) =>
  () =>
    validateChangeset(entry, policy(), projects, coverage());

it('refuses a changeset without change entries', () => {
  const entry = changeset();
  expect(validate(entry)).not.toThrow();
  entry.changes = [];
  expect(validate(entry)).toThrow(refusal('Changeset changes are required'));
});

it('refuses a changed package file whose change entry omits that package', () => {
  const entry = changeset();
  entry.changes = [
    { id: 'runtime', title: 'Runtime changes', summary: 'Changes b', packages: [b], paths: ['packages/'] },
    { id: 'docs', title: 'Documentation', summary: 'Describes a', packages: [a], paths: ['docs/'] },
  ];
  expect(validate(entry)).toThrow(refusal('Changed package omitted from its change entry'));
  entry.changes[0]!.packages = [a, b];
  expect(validate(entry)).not.toThrow();
});

it('refuses a public package without release notes', () => {
  const entry = changeset();
  entry.changes[0]!.packages = [a];
  expect(validate(entry)).toThrow(refusal('Package has no release notes'));
  entry.changes.push({ id: 'cohort', title: 'Cohort', summary: 'Aligns b', packages: [b], paths: ['packages/b/'] });
  expect(validate(entry)).not.toThrow();
});

it('refuses a changeset recorded against another published baseline', () => {
  expect(validate(changeset())).not.toThrow();
  for (const baseline of [
    { commit: 'b'.repeat(40), version: '1.0.0' },
    { commit: 'a'.repeat(40), version: '0.9.0' },
  ]) {
    const entry = changeset();
    entry.baseline = baseline;
    expect(validate(entry)).toThrow(refusal('Changeset baseline is stale'));
  }
});

it('refuses a change scope that leaves the repository', () => {
  const inside = changeset();
  inside.changes[0]!.paths.push('docs/');
  expect(validate(inside)).not.toThrow();
  for (const path of ['../', 'packages/../../outside/']) {
    const entry = changeset();
    entry.changes[0]!.paths.push(path);
    expect(validate(entry)).toThrow(refusal('Change scope is required'));
  }
});

it('refuses a changed file whose change entry is missing or does not scope its path', () => {
  const missing = changeset();
  missing.coverage[0]!.change = 'missing';
  expect(validate(missing)).toThrow(refusal('Changed file lacks an applicable changeset entry'));
  const outside = changeset();
  outside.changes[0]!.paths = ['docs/'];
  expect(validate(outside)).toThrow(refusal('Changed file lacks an applicable changeset entry'));
  outside.changes[0]!.paths = ['packages/a/src/'];
  expect(validate(outside)).not.toThrow();
});

it('refuses a public package manifest outside the cohort version', () => {
  const projects = [project(a), project(b)];
  expect(validate(changeset(), projects)).not.toThrow();
  projects[1]!.manifest.version = '1.0.0';
  expect(validate(changeset(), projects)).toThrow(refusal('@inventarch/b: cohort version differs'));
});

it('refuses a package impact without a known kind and a summary', () => {
  for (const kind of ['changed', 'cohort']) {
    const entry = changeset();
    entry.packages[b]!.kind = kind;
    expect(validate(entry)).not.toThrow();
  }
  for (const impact of [
    { kind: 'unchanged', summary: 'Not a release kind' },
    { kind: 'cohort', summary: ' ' },
    { kind: 'changed', summary: '' },
  ]) {
    const entry = changeset();
    entry.packages[b] = { previous: '1.0.0', ...impact };
    expect(validate(entry)).toThrow(refusal('Package impact or justified cohort entry is required'));
  }
});

it('refuses two change entries with one identity', () => {
  const entry = changeset();
  entry.changes.push({ ...entry.changes[0]!, packages: [b], paths: ['packages/b/'] });
  expect(validate(entry)).toThrow(
    expect.objectContaining({
      code: 'ERR_ASSERTION',
      generatedMessage: false,
      message: 'Duplicate change entry: runtime',
    }),
  );
  entry.changes[1]!.id = 'cohort';
  expect(validate(entry)).not.toThrow();
});

const packed = (name: string, fields: Partial<PackedManifest> = {}): PackedManifest => ({
  name,
  version: '1.1.0',
  ...fields,
});

it('refuses a private workspace dependency in a public archive', () => {
  const graph = releaseGraph([packed(a, { dependencies: { '@iam/scope': '1.0.0', yaml: '2.9.0' } })], '1.1.0', []);
  expect(graph.dependencies).toEqual({ [a]: [] });
  expect(() => releaseGraph([packed(a, { dependencies: { '@ia/runtime': '1.1.0' } })], '1.1.0', [])).toThrow(
    refusal('Private dependency in public archive'),
  );
});

it('refuses a packed dependency that the registry cannot resolve', () => {
  expect(releaseGraph([packed(a, { dependencies: { yaml: '^2.9.0' } })], '1.1.0', []).dependencies).toEqual({
    [a]: [],
  });
  for (const range of [
    'workspace:*',
    'catalog:',
    'file:../yaml',
    'link:../yaml',
    'https://example.invalid/yaml.tgz',
    'http://example.invalid/yaml.tgz',
    'git+https://example.invalid/yaml.git',
    'git://example.invalid/yaml.git',
    'github:example/yaml',
    'gitlab:example/yaml',
    'bitbucket:example/yaml',
  ])
    for (const name of ['yaml', b])
      expect(() => releaseGraph([packed(a, { dependencies: { [name]: range } }), packed(b)], '1.1.0', [])).toThrow(
        refusal('@inventarch/a: unsupported packed dependency source'),
      );
});

it('reads optional and peer dependencies as cohort edges with exact versions', () => {
  for (const section of ['optionalDependencies', 'peerDependencies'] as const) {
    const ranged = packed(a);
    ranged[section] = { [b]: '^1.1.0' };
    expect(() => releaseGraph([ranged, packed(b)], '1.1.0', [])).toThrow(
      refusal('@inventarch/a: dependency @inventarch/b must use exact cohort version'),
    );
    const exact = packed(a);
    exact[section] = { [b]: '1.1.0' };
    const graph = releaseGraph([exact, packed(b)], '1.1.0', []);
    expect(graph.dependencies).toEqual({ [a]: [b], [b]: [] });
    expect(graph.groups.map((group) => group.members)).toEqual([[b], [a]]);
  }
});

it('refuses a packed manifest outside the cohort version', () => {
  expect(releaseGraph([packed(a), packed(b)], '1.1.0', []).groups).toHaveLength(2);
  expect(() => releaseGraph([packed(a), packed(b, { version: '1.0.0' })], '1.1.0', [])).toThrow(
    refusal('@inventarch/b: packed cohort version differs'),
  );
});

it('refuses one package packed twice', () => {
  expect(releaseGraph([packed(a), packed(b)], '1.1.0', []).groups).toHaveLength(2);
  expect(() => releaseGraph([packed(a), packed(a)], '1.1.0', [])).toThrow(refusal('Duplicate packed package'));
});

it('refuses a reviewed cycle that the packed graph no longer contains', () => {
  const cyclic = [packed(a, { dependencies: { [b]: '1.1.0' } }), packed(b, { dependencies: { [a]: '1.1.0' } })];
  expect(releaseGraph(cyclic, '1.1.0', [[b, a]]).groups).toEqual([{ members: [a, b], cyclic: true }]);
  const acyclic = [packed(a, { dependencies: { [b]: '1.1.0' } }), packed(b)];
  expect(() => releaseGraph(acyclic, '1.1.0', [[a, b]])).toThrow(
    refusal('Packed dependency cycle policy differs; review the complete cycle'),
  );
});

const archive = (name: string, version = '1.1.0'): ReleaseArchive => ({
  name,
  version,
  filename: name.slice(12) + '.tgz',
  bytes: 1,
  integrity: 'sha512-qualified',
});
const cohort = () => ({ version: '1.1.0', tag: 'latest', packages: [archive(a), archive(b)] });
const unpublished = (): RegistryPackage => ({ versions: {} });
const published = (attestations = 'https://registry.npmjs.org/-/npm/v1/attestations/example'): RegistryPackage => ({
  'dist-tags': { latest: '1.1.0' },
  versions: {
    '1.1.0': {
      dist: {
        integrity: 'sha512-qualified',
        tarball: 'https://registry.npmjs.org/example.tgz',
        attestations: { url: attestations, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
      },
    },
  },
});

it('refuses a publication plan that does not advance a package past its published baseline', () => {
  const registry = { [a]: unpublished(), [b]: unpublished() };
  expect(
    publicationPlan({ ...cohort(), baselineVersions: { [a]: '1.0.0', [b]: null } }, registry).map(
      (entry) => entry.action,
    ),
  ).toEqual(['publish', 'publish']);
  for (const previous of ['1.1.0', '1.2.0'])
    expect(() => publicationPlan({ ...cohort(), baselineVersions: { [a]: '1.0.0', [b]: previous } }, registry)).toThrow(
      refusal('Release did not advance published baseline'),
    );
});

it('refuses a publication plan that mixes cohort versions', () => {
  const registry = { [a]: unpublished(), [b]: unpublished() };
  const release = cohort();
  expect(publicationPlan(release, registry).map((entry) => entry.version)).toEqual(['1.1.0', '1.1.0']);
  release.packages[1] = archive(b, '1.0.0');
  expect(() => publicationPlan(release, registry)).toThrow(refusal('Registry plan has a mixed cohort'));
});

it('refuses a published cohort whose provenance attestation comes from another origin', () => {
  const registry = { [a]: published(), [b]: published() };
  expect(verifyRegistryCohort(cohort(), registry).map((entry) => entry.action)).toEqual([
    'skip-identical',
    'skip-identical',
  ]);
  for (const url of [
    'https://example.invalid/attestations/example',
    'http://registry.npmjs.org/attestations/example',
  ]) {
    registry[b] = published(url);
    expect(() => verifyRegistryCohort(cohort(), registry)).toThrow(refusal('Unexpected attestation origin'));
  }
});

const GIT_TIMEOUT = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 15_000;
/** Git for a throwaway fixture repository, with identity, signing, hooks and line endings pinned on every command. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = await runBounded(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, timeoutMs: GIT_TIMEOUT },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed (${String(run.status)}): ${run.stderr}`);
  return run.stdout.trim();
}
async function inRepository(run: (repository: string) => Promise<void>): Promise<void> {
  const repository = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-release-refusal-'));
  try {
    await git(repository, 'init', '--quiet');
    await run(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}
function put(repository: string, path: string, value: unknown): void {
  mkdirSync(dirname(resolve(repository, path)), { recursive: true });
  writeFileSync(resolve(repository, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
async function commit(repository: string, message: string): Promise<string> {
  await git(repository, 'add', '--all');
  await git(repository, 'commit', '--quiet', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}
const cohortPolicy = (baseline: string, version = '1.1.0') => ({
  format: 'ia.npm-cohort.v1',
  version,
  tag: 'latest',
  baseline: { commit: baseline, version: '1.0.0' },
  cycles: [],
});
const releaseProjects = () => [project(a), project(b), project(c)];
const history = () => ({
  format: 'ia.npm-changeset.v1',
  version: '1.0.0',
  state: 'consumed',
  summary: 'First public release.',
  changes: [
    { id: 'initial', title: 'Initial release', summary: 'Publishes a and b.', packages: [a, b], paths: ['packages/'] },
  ],
});
/**
 * A published 1.0.0 baseline of a and b, then a sealed 1.1.0 release in which a changes, b is a version-only cohort
 * entry and c is new. Sealing runs the contributor's own collect step and commits its result.
 */
async function sealedRelease(repository: string): Promise<void> {
  put(repository, 'packages/a/package.json', { name: a, version: '1.0.0' });
  put(repository, 'packages/b/package.json', { name: b, version: '1.0.0' });
  put(repository, 'releases/changesets/1.0.0.json', history());
  const baseline = await commit(repository, 'Published baseline');
  for (const name of [a, b, c]) put(repository, `packages/${name.slice(12)}/package.json`, { name, version: '1.1.0' });
  put(repository, 'packages/a/src/index.ts', 'export const answer = 42;\n');
  put(repository, 'releases/current.json', cohortPolicy(baseline));
  put(repository, 'releases/changesets/1.1.0.json', {
    format: 'ia.npm-changeset.v1',
    version: '1.1.0',
    state: 'consumed',
    baseline: { commit: baseline, version: '1.0.0' },
    summary: 'Fixture release.',
    packages: {
      [a]: { previous: '1.0.0', kind: 'changed', summary: 'Adds an export.' },
      [b]: { previous: '1.0.0', kind: 'cohort', summary: 'Version-only cohort alignment.' },
      [c]: { previous: null, kind: 'changed', summary: 'First release.' },
    },
    changes: [
      {
        id: 'fixture',
        title: 'Fixture changes',
        summary: 'Adds an export and a package.',
        packages: [a, b, c],
        paths: ['packages/', 'releases/'],
      },
    ],
    coverage: [],
  });
  await git(repository, 'add', '--all');
  const sealed = collectChanges(repository, releaseProjects());
  expect(sealed.entry.coverage.map((row) => [row.path, row.cohortOnly === true])).toEqual([
    ['packages/a/package.json', true],
    ['packages/a/src/index.ts', false],
    ['packages/b/package.json', true],
    ['packages/c/package.json', false],
    ['releases/current.json', false],
  ]);
  await commit(repository, 'Release 1.1.0');
}

it('refuses a rewritten historical changeset even after the contributor reseals', () =>
  inRepository(async (repository) => {
    await sealedRelease(repository);
    expect(releaseChanges(repository, releaseProjects()).commits).toHaveLength(1);
    put(repository, 'releases/changesets/1.0.0.json', { ...history(), summary: 'Rewritten after publication.' });
    expect(() => collectChanges(repository, releaseProjects())).toThrow(refusal('Historical changeset changed'));
    expect(() => releaseChanges(repository, releaseProjects())).toThrow(refusal('Historical changeset changed'));
  }));

it('refuses a changelog that no longer renders the reviewed changesets', () =>
  inRepository(async (repository) => {
    await sealedRelease(repository);
    const changelog = readFileSync(resolve(repository, 'CHANGELOG.md'), 'utf8');
    put(repository, 'CHANGELOG.md', changelog + '\nAn unreviewed claim.\n');
    expect(() => releaseChanges(repository, releaseProjects())).toThrow(refusal('Generated changelog is stale'));
    put(repository, 'CHANGELOG.md', changelog);
    const entry = JSON.parse(readFileSync(resolve(repository, 'releases/changesets/1.1.0.json'), 'utf8'));
    entry.changes[0].summary = 'Revised release prose.';
    put(repository, 'releases/changesets/1.1.0.json', entry);
    expect(() => releaseChanges(repository, releaseProjects())).toThrow(refusal('Generated changelog is stale'));
    collectChanges(repository, releaseProjects());
    expect(readFileSync(resolve(repository, 'CHANGELOG.md'), 'utf8')).toContain('Revised release prose.');
    expect(() => releaseChanges(repository, releaseProjects())).not.toThrow();
  }));

it('refuses package baselines that differ from the published sources', () =>
  inRepository(async (repository) => {
    await sealedRelease(repository);
    const path = 'releases/changesets/1.1.0.json',
      sealed = readFileSync(resolve(repository, path), 'utf8');
    expect(releaseChanges(repository, releaseProjects()).entry.packages[c]!.previous).toBeNull();
    for (const [name, previous] of [
      [b, '0.9.0'],
      [b, null],
      [c, '1.0.0'],
    ] as const) {
      const entry = JSON.parse(sealed);
      entry.packages[name].previous = previous;
      put(repository, path, entry);
      expect(() => releaseChanges(repository, releaseProjects())).toThrow(
        refusal('Changeset package baseline differs from source evidence'),
      );
    }
  }));

it('refuses a release version that does not advance the published baseline', () =>
  inRepository(async (repository) => {
    put(repository, 'README.md', 'Published baseline\n');
    const baseline = await commit(repository, 'Published baseline');
    put(repository, 'releases/current.json', cohortPolicy(baseline));
    expect(releasePolicy(repository)).toEqual(cohortPolicy(baseline));
    for (const version of ['1.0.0', '0.9.0']) {
      put(repository, 'releases/current.json', cohortPolicy(baseline, version));
      expect(() => releasePolicy(repository)).toThrow(refusal('Release version must advance the published baseline'));
    }
  }));

it('refuses a published baseline that is not an ancestor of the release checkout', () =>
  inRepository(async (repository) => {
    // Ancestry is checked by Git itself, so the refusal is its exit status and the command it reports as failed.
    const notAncestor = (revision: string) =>
      expect.objectContaining({
        status: 1,
        message: firstLine(`Command failed: git merge-base --is-ancestor ${revision} HEAD`),
      });
    put(repository, 'README.md', 'Published baseline\n');
    const baseline = await commit(repository, 'Published baseline');
    put(repository, 'README.md', 'Release candidate\n');
    const candidate = await commit(repository, 'Release candidate');
    // The policy stays untracked, so it survives each checkout below.
    put(repository, 'releases/current.json', cohortPolicy(baseline));
    expect(releasePolicy(repository).baseline.commit).toBe(baseline);
    put(repository, 'releases/current.json', cohortPolicy(candidate));
    await git(repository, 'checkout', '--quiet', baseline);
    expect(() => releasePolicy(repository)).toThrow(notAncestor(candidate));
    await git(repository, 'checkout', '--quiet', '--orphan', 'unrelated');
    await git(repository, 'commit', '--quiet', '-m', 'Unrelated history');
    put(repository, 'releases/current.json', cohortPolicy(baseline));
    expect(() => releasePolicy(repository)).toThrow(notAncestor(baseline));
  }));

// Archive checks read this checkout as it stands: the input selection it would seal and its changeset as committed.
// Strict sealing is release preparation's job and has its own refusals above.
const checkout = resolve(import.meta.dirname, '../..');
const evidence = { inputs: publicPackageInputs(checkout, { sealed: false }), changes: committedChanges(checkout) };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const archiveName = (manifest: PackageManifest) =>
  `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
/** A gzipped ustar archive holding only package/package.json. */
function tarball(manifest: object): Buffer {
  const body = Buffer.from(JSON.stringify(manifest)),
    header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]));
}
interface Qualified {
  name: string;
  filename: string;
  sha256: string;
  packed: PackageManifest;
  system: boolean;
}
/**
 * Qualified archives of this checkout's public cohort, packed as the release would pack them (exact cohort versions,
 * plus the native ring that forms the one reviewed cycle), and their system compatibility companion.
 */
async function inQualifiedCohort(run: (directory: string, qualified: Qualified[]) => void): Promise<void> {
  const directory = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-release-refusal-'));
  try {
    const policy: {
      packages: string[];
      owners: { native: { system: string; id: string; version: string } }[];
    } = JSON.parse(readFileSync(resolve(checkout, PUBLIC_SYSTEM_POLICY), 'utf8'));
    const systems = policy.owners.map((owner) => '@inventarch/' + owner.native.system).sort(),
      projects = publicPackages(checkout),
      versions = new Map(projects.map(({ manifest }) => [manifest.name, manifest.version]));
    const qualified = projects.map(({ manifest }) => {
      const dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [name, versions.get(name) ?? range]),
      );
      const ring = systems.indexOf(manifest.name);
      if (ring >= 0) dependencies[systems[(ring + 1) % systems.length]!] = manifest.version;
      const packed = { ...manifest, dependencies },
        bytes = tarball(packed);
      writeFileSync(resolve(directory, archiveName(manifest)), bytes);
      return { name: manifest.name, filename: archiveName(manifest), sha256: sha(bytes), packed, system: ring >= 0 };
    });
    const source = structuredClone(evidence.inputs);
    const manifests: PackageManifest[] = policy.packages.map((owner) =>
      JSON.parse(readFileSync(resolve(checkout, owner, 'package.json'), 'utf8')),
    );
    const compatibility = {
      format: 'ia.system-package-compatibility.v1',
      sourceRevision: source.receipt.sourceRevision,
      sourceManifestSha256: source.sha256,
      baselineOverlay: source.receipt.baselineOverlay,
      recipe: {
        publicCommit: await git(checkout, 'rev-parse', 'HEAD'),
        publicDirty: false,
        node: process.version,
        pnpm: JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8')).packageManager.slice(5),
        lockSha256: sha(readFileSync(resolve(checkout, 'pnpm-lock.yaml'))),
        files: source.receipt.files.filter(
          (row) => row.path.startsWith('tools/release/') || row.path === PUBLIC_SYSTEM_POLICY,
        ),
        extraction: source.receipt.provenance,
      },
      packages: manifests.map((manifest) => ({
        package: { name: manifest.name, version: manifest.version },
        archiveSha256: sha(readFileSync(resolve(directory, archiveName(manifest)))),
        bindingSha256: 'a'.repeat(64),
        native: {
          ...policy.owners.find((owner) => '@inventarch/' + owner.native.system === manifest.name)!.native,
          archiveSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
        },
        codeDigest: 'd'.repeat(64),
        protocols: { distribution: 1, binding: 2, language: ['1.0'] },
      })),
    };
    writeFileSync(resolve(directory, COMPATIBILITY), JSON.stringify(compatibility));
    run(directory, qualified);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const receipts = (qualified: Qualified[]) =>
  qualified.map(({ name, filename, sha256 }) => ({ name, filename, sha256 }));

it('refuses a qualified archive whose packed manifest is outside the cohort version', () =>
  inQualifiedCohort((directory, qualified) => {
    // The compatibility companion binds the system archives, so the skew goes into another archive, and its qualified
    // hash is updated to match: an archive that qualification accepted although it carries the wrong version.
    const target = qualified.find((row) => !row.system)!,
      path = resolve(directory, target.filename),
      original = readFileSync(path),
      skewed = tarball({ ...target.packed, version: '1.0.0' });
    writeFileSync(path, skewed);
    const packed = receipts(qualified).map((row) => (row.name === target.name ? { ...row, sha256: sha(skewed) } : row));
    expect(() => writeReleaseManifest(checkout, directory, packed, evidence)).toThrow(
      refusal('Packed package version differs'),
    );
    expect(existsSync(resolve(directory, 'npm-release.json'))).toBe(false);
    writeFileSync(path, original);
    expect(writeReleaseManifest(checkout, directory, receipts(qualified), evidence).packages).toHaveLength(
      qualified.length,
    );
  }));

it('refuses a release receipt whose packed graph differs from its archives', () =>
  inQualifiedCohort((directory, qualified) => {
    const release = writeReleaseManifest(checkout, directory, receipts(qualified), evidence);
    expect(verifyRelease(checkout, directory, release.version, evidence)).toEqual(release);
    const groups = release.graph.groups.map((group) => ({ ...group, cyclic: !group.cyclic }));
    writeFileSync(
      resolve(directory, 'npm-release.json'),
      JSON.stringify({ ...release, graph: { ...release.graph, groups } }, null, 2) + '\n',
    );
    expect(() => verifyRelease(checkout, directory, release.version, evidence)).toThrow(
      refusal('Packed release graph differs'),
    );
  }));
