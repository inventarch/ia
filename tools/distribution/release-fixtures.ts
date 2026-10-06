import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, vi } from 'vitest';
import { COMPATIBILITY, PUBLIC_SYSTEM_POLICY, publicPackageInputs } from '../release/public-pack.mjs';
import { runBounded } from '../testing/subprocess.js';
import { publicPackages, type PackageManifest } from './npm-release.mjs';
import type { Changeset, ReleasePolicy } from './release-changes.mjs';

// Fixtures shared by the release test files: refusal matchers, a minimal changeset, throwaway Git repositories and a
// qualified archive cohort of this checkout.

/** This checkout, whose sealed release the archive fixtures pack as the publishing commands would. */
export const checkout = resolve(import.meta.dirname, '../..');
export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * The authored message must be the whole first line: after an equality refusal Node appends its own actual/expected
 * comparison.
 */
export const firstLine = (text: string) =>
  expect.stringMatching(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n[\\s\\S]*)?$`));
/** A refusal by its assertion code and authored message, so an unrelated error cannot satisfy it. */
export const refusal = (message: string) =>
  expect.objectContaining({ code: 'ERR_ASSERTION', generatedMessage: false, message: firstLine(message) });

export const [a, b, c] = ['@inventarch/a', '@inventarch/b', '@inventarch/c'] as const;
export const project = (name: string) => ({
  directory: 'packages/' + name.slice(12),
  manifest: { name, version: '1.1.0' },
});
export const policy = (): ReleasePolicy => ({
  format: 'ia.npm-cohort.v1',
  version: '1.1.0',
  tag: 'latest',
  baseline: { commit: 'a'.repeat(40), version: '1.0.0' },
  cycles: [],
});
export const coverage = () => [{ path: 'packages/a/src/index.ts', sha256: 'a'.repeat(64) }];
/** A valid 1.1.0 changeset in which a changes and b is a version-only cohort entry. */
export function changeset(): Changeset {
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

const GIT_TIMEOUT = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 15_000;
/** Configuration pinned for every Git command in a fixture repository, the release code's own included. */
const FIXTURE_GIT_CONFIG = {
  'user.name': 'Fixture',
  'user.email': 'fixture@example.invalid',
  'commit.gpgsign': 'false',
  'core.hooksPath': '/dev/null',
  'core.autocrlf': 'false',
  'init.defaultBranch': 'main',
};
/** Inherited variables that would point Git at another repository, index or object store, as inside a Git hook. */
const REPOSITORY_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CONFIG_PARAMETERS',
];
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = await runBounded('git', args, { cwd, timeoutMs: GIT_TIMEOUT });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed (${String(run.status)}): ${run.stderr}`);
  return run.stdout.trim();
}
/**
 * A throwaway Git repository. The pinned configuration travels in the environment, so the release code's own `git`
 * calls see it too, not only the fixture's.
 */
export async function inRepository(run: (repository: string) => Promise<void>): Promise<void> {
  const repository = mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-release-fixture-'));
  const pins = Object.entries(FIXTURE_GIT_CONFIG);
  vi.stubEnv('GIT_CONFIG_COUNT', String(pins.length));
  pins.forEach(([key, value], index) => {
    vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
    vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value);
  });
  for (const name of REPOSITORY_OVERRIDES) vi.stubEnv(name, undefined);
  try {
    await git(repository, 'init', '--quiet');
    await run(repository);
  } finally {
    vi.unstubAllEnvs();
    rmSync(repository, { recursive: true, force: true });
  }
}

/** A gzipped ustar archive holding only package/package.json. */
export function tarball(manifest: object): Buffer {
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
interface SystemPolicy {
  packages: string[];
  owners: { native: { system: string; id: string; version: string } }[];
}
const systemPolicy = (): SystemPolicy => JSON.parse(readFileSync(resolve(checkout, PUBLIC_SYSTEM_POLICY), 'utf8'));
const archiveName = (manifest: { name: string; version: string }) =>
  `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
export interface QualifiedArchive {
  name: string;
  filename: string;
  sha256: string;
  packed: PackageManifest;
  system: boolean;
}
/**
 * Archives of this checkout's public cohort, packed as the release would pack them: exact cohort versions, plus the
 * native ring that forms the one reviewed cycle.
 */
export function archivesFixture(directory: string): QualifiedArchive[] {
  const systems = systemPolicy()
      .owners.map((owner) => '@inventarch/' + owner.native.system)
      .sort(),
    projects = publicPackages(checkout),
    versions = new Map(projects.map(({ manifest }) => [manifest.name, manifest.version]));
  return projects.map(({ manifest }) => {
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
}
/** The system compatibility companion for the archives in `directory`, written beside them. */
export function compatibilityFixture(directory: string) {
  const source = publicPackageInputs(checkout),
    policy = systemPolicy();
  const manifests: PackageManifest[] = policy.packages.map((owner) =>
    JSON.parse(readFileSync(resolve(checkout, owner, 'package.json'), 'utf8')),
  );
  const compatibility = {
    format: 'ia.system-package-compatibility.v1',
    sourceRevision: source.receipt.sourceRevision,
    sourceManifestSha256: source.sha256,
    baselineOverlay: source.receipt.baselineOverlay,
    recipe: {
      publicCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
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
        selection: { path: 'dist/native-selection.json', sha256: 'e'.repeat(64) },
        archiveSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
      },
      codeDigest: 'd'.repeat(64),
      protocols: { distribution: 1, binding: 2, language: ['1.0'] },
    })),
  };
  writeFileSync(resolve(directory, COMPATIBILITY), JSON.stringify(compatibility));
  return compatibility;
}
/** The receipts qualification hands to the release manifest. */
export const receipts = (archives: readonly QualifiedArchive[]) =>
  archives.map(({ name, filename, sha256 }) => ({ name, filename, sha256 }));

/** A temporary directory holding a qualified cohort and its compatibility companion. */
export function inQualifiedCohort(run: (directory: string, archives: QualifiedArchive[]) => void): void {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-npm-release-test-')));
  try {
    const archives = archivesFixture(directory);
    compatibilityFixture(directory);
    run(directory, archives);
  } finally {
    expect(dirname(directory)).toBe(temporaryRoot);
    expect(directory.startsWith(resolve(temporaryRoot, 'ia-npm-release-test-'))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
}
