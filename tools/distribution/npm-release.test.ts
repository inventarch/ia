import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  publicPackageInputs,
  refreshPublicPackageInputs,
  PUBLIC_INPUTS,
  PUBLIC_SYSTEM_POLICY,
  COMPATIBILITY,
  verifyPublicCompatibility,
} from '../release/public-pack.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import {
  assertPublisherEnvironment,
  dependencyOrder,
  publicationPlan,
  publicPackages,
  REPOSITORY_URL,
  REGISTRY,
  validatePackages,
  releaseVersions,
  verifyRelease,
  writeReleaseManifest,
} from './npm-release.mjs';
import { committedChanges } from './release-changes.mjs';

const root = resolve(import.meta.dirname, '../..');
/**
 * These tests exercise archive receipts, not release sealing, so they read the checkout as it stands: the input
 * selection it would seal and the changeset as committed. Strict sealing has its own tests and runs in preparation.
 */
const inputs = publicPackageInputs(root, { sealed: false });
const evidence = { inputs, changes: committedChanges(root) };
const checkoutVersion = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')).version;
const archive = Buffer.from('qualified package bytes');
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
const entry = (name = '@inventarch/language') => ({
  name,
  version: '1.0.0',
  filename: 'ia-language-1.0.0.tgz',
  bytes: archive.length,
  integrity,
});
const release = () => ({
  version: '1.0.0',
  tag: 'latest',
  source: { commit: 'a'.repeat(40), dirty: false },
  packages: [entry()],
});
const remote = (value = integrity) => ({
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { dist: { integrity: value } } },
});

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function archiveBytes(manifest: any) {
  const policy = JSON.parse(readFileSync(resolve(root, PUBLIC_SYSTEM_POLICY), 'utf8'));
  const names = policy.owners.map((row: any) => '@inventarch/' + row.native.system).sort();
  const pkg = structuredClone(manifest),
    versions = new Map(publicPackages(root).map((p) => [p.manifest.name, p.manifest.version]));
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).map(([name, value]) => [name, versions.get(name) ?? value]),
  );
  if (names.includes(pkg.name)) pkg.dependencies[names[(names.indexOf(pkg.name) + 1) % names.length]] = pkg.version;
  const bytes = Buffer.from(JSON.stringify(pkg)),
    header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512), Buffer.alloc(1024)]));
}
function compatibilityFixture(directory: string) {
  // A copy: tests mutate the fixture, and the shared expectation must not move with it.
  const source = structuredClone(inputs);
  const policy = JSON.parse(readFileSync(resolve(root, PUBLIC_SYSTEM_POLICY), 'utf8'));
  const manifests = policy.packages.map((owner: string) =>
    JSON.parse(readFileSync(resolve(root, owner, 'package.json'), 'utf8')),
  );
  const compatibility = {
    format: 'ia.system-package-compatibility.v1',
    sourceRevision: source.receipt.sourceRevision,
    sourceManifestSha256: source.sha256,
    baselineOverlay: source.receipt.baselineOverlay,
    recipe: {
      publicCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      publicDirty: false,
      node: process.version,
      pnpm: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager.slice(5),
      lockSha256: sha(readFileSync(resolve(root, 'pnpm-lock.yaml'))),
      files: source.receipt.files.filter(
        (row: { path: string }) => row.path.startsWith('tools/release/') || row.path === PUBLIC_SYSTEM_POLICY,
      ),
      extraction: source.receipt.provenance,
    },
    packages: manifests.map((manifest: { name: string; version: string }) => ({
      package: { name: manifest.name, version: manifest.version },
      archiveSha256: sha(
        readFileSync(
          resolve(directory, manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz'),
        ),
      ),
      bindingSha256: 'a'.repeat(64),
      native: {
        ...policy.owners.find((row: any) => '@inventarch/' + row.native.system === manifest.name).native,
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
function archivesFixture(directory: string) {
  return publicPackages(root).map(({ manifest }) => {
    const filename = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz';
    const bytes = archiveBytes(manifest);
    writeFileSync(resolve(directory, filename), bytes);
    return { name: manifest.name, filename, sha256: sha(bytes) };
  });
}
function inFixture(run: (directory: string) => void) {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-npm-release-test-')));
  try {
    archivesFixture(directory);
    compatibilityFixture(directory);
    run(directory);
  } finally {
    expect(dirname(directory)).toBe(temporaryRoot);
    expect(directory.startsWith(resolve(temporaryRoot, 'ia-npm-release-test-'))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

it('refuses changed archive bytes and a manifest from another source commit', () => {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-npm-release-test-')));
  try {
    const packed = publicPackages(root).map(({ manifest }) => {
      const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
      const bytes = archiveBytes(manifest);
      writeFileSync(resolve(directory, filename), bytes);
      return { name: manifest.name, filename, sha256: sha(bytes) };
    });
    compatibilityFixture(directory);
    const manifest = writeReleaseManifest(root, directory, packed, evidence);
    expect(verifyRelease(root, directory, checkoutVersion, evidence)).toEqual(manifest);
    const first = resolve(directory, packed[0]!.filename);
    const original = readFileSync(first);
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(first, changed);
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence)).toThrow(/archive integrity changed/);
    writeFileSync(first, original);
    writeFileSync(
      resolve(directory, 'npm-release.json'),
      JSON.stringify({ ...manifest, source: { ...manifest.source, commit: '0'.repeat(40) } }),
    );
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence)).toThrow(
      /Archive source must match checkout/,
    );
  } finally {
    expect(dirname(directory)).toBe(temporaryRoot);
    expect(directory.startsWith(resolve(temporaryRoot, 'ia-npm-release-test-'))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('publishes dependencies before their consumers and refuses cycles', () => {
  const projects = [
    { manifest: { name: '@inventarch/cli', dependencies: { '@inventarch/graph': 'workspace:*' } } },
    { manifest: { name: '@inventarch/graph', dependencies: { '@inventarch/language': 'workspace:*' } } },
    { manifest: { name: '@inventarch/language' } },
  ];
  expect(dependencyOrder(projects).map((p) => p.manifest.name)).toEqual([
    '@inventarch/language',
    '@inventarch/graph',
    '@inventarch/cli',
  ]);
  const cyclic = [
    ...projects.slice(0, 2),
    { manifest: { name: '@inventarch/language', dependencies: { '@inventarch/cli': 'workspace:*' } } },
  ];
  expect(() => dependencyOrder(cyclic)).toThrow(/cycle/);
});

it('publishes the new package names of a dependency cycle before the cycle moves any existing package', () =>
  inFixture((directory) => {
    const release = writeReleaseManifest(root, directory, archivesFixture(directory), evidence);
    const cycle = release.graph.groups.find((group: { cyclic: boolean }) => group.cyclic)!.members as string[];
    const order = release.packages
      .map((entry: { name: string }) => entry.name)
      .filter((name: string) => cycle.includes(name));
    const fresh = cycle.filter((name) => release.baselineVersions[name] === null);
    // A new name's first trusted publish is the step most likely to fail; it must fail before any existing member of the
    // cycle moves its `latest` tag. A release without new names keeps the cycle's sorted order.
    expect(order).toEqual([...fresh, ...cycle.filter((name) => !fresh.includes(name))]);
    expect(release.graph.groups.find((group: { cyclic: boolean }) => group.cyclic)!.members).toEqual([...cycle].sort());
  }));

it('allows a missing version only in an existing package configured for first-publish setup', () => {
  expect(publicationPlan(release(), { '@inventarch/language': { versions: {} } })[0]!.action).toBe('publish');
  expect(() => publicationPlan(release(), { '@inventarch/language': null })).toThrow(/create the package/);
});

it('makes retries idempotent only when registry bytes match the qualified archive', () => {
  expect(publicationPlan(release(), { '@inventarch/language': remote() })[0]!.action).toBe('skip-identical');
  expect(() => publicationPlan(release(), { '@inventarch/language': remote('sha512-different') })).toThrow(
    /existing npm bytes differ/,
  );
  expect(() => publicationPlan(release(), { '@inventarch/language': { versions: { '1.0.0': {} } } })).toThrow(
    /existing npm bytes differ/,
  );
});

it('refuses the whole publication plan if a later package conflicts', () => {
  const two = { ...release(), packages: [entry(), entry('@inventarch/graph')] };
  expect(() =>
    publicationPlan(two, { '@inventarch/language': { versions: {} }, '@inventarch/graph': remote('sha512-other') }),
  ).toThrow(/@inventarch\/graph@1.0.0/);
});

const environment = () => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'inventarch/ia',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only',
});
it('requires a clean source commit, the canonical main branch and OIDC without a stored npm token', () => {
  expect(() => assertPublisherEnvironment(release(), environment())).not.toThrow();
  for (const change of [
    { GITHUB_REPOSITORY: 'fork/ia' },
    { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_ACTIONS: '' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
    { NODE_AUTH_TOKEN: 'test-only' },
    { NPM_TOKEN: 'test-only' },
  ])
    expect(() => assertPublisherEnvironment(release(), { ...environment(), ...change })).toThrow();
  expect(() =>
    assertPublisherEnvironment({ ...release(), source: { commit: 'a'.repeat(40), dirty: true } }, environment()),
  ).toThrow(/clean checkout/);
});

it('requires matching repository metadata, public registry and script-free installation for every release package', () => {
  const projects = publicPackages(root);
  expect(projects).toHaveLength(Object.keys(releaseVersions(root, inputs)).length - 1);
  expect(() => validatePackages(projects, checkoutVersion, releaseVersions(root, inputs))).not.toThrow();
  expect(() => validatePackages(projects, '999.0.0')).toThrow(/version differs/);
  const project = {
    directory: 'packages/example',
    manifest: {
      name: '@inventarch/example',
      version: '1.0.0',
      repository: { type: 'git', url: REPOSITORY_URL, directory: 'packages/example' },
      publishConfig: { access: 'public', registry: REGISTRY },
    },
  };
  expect(() => validatePackages([project], '1.0.0-rc.1')).toThrow(/stable release/);
  expect(() =>
    validatePackages(
      [{ ...project, manifest: { ...project.manifest, scripts: { postinstall: 'node install.js' } } }],
      '1.0.0',
    ),
  ).toThrow(/postinstall/);
  expect(() =>
    validatePackages(
      [
        {
          ...project,
          manifest: {
            ...project.manifest,
            repository: { ...project.manifest.repository, url: 'https://example.invalid' },
          },
        },
      ],
      '1.0.0',
    ),
  ).toThrow(/provenance repository/);
});

it('keeps npm OIDC out of the build job and publishes only the same-run qualified artifact', () => {
  const workflow = parse(readFileSync(resolve(root, '.github/workflows/npm-publish.yml'), 'utf8'));
  expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
  // Automatic runs start only from a main commit that changes the selected release or its changeset.
  expect(workflow.on.push).toEqual({ branches: ['main'], paths: ['releases/current.json', 'releases/changesets/**'] });
  expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const oidc = Object.entries(workflow.jobs as Record<string, { permissions?: Record<string, string> }>)
    .filter(([, job]) => job.permissions?.['id-token'])
    .map(([name]) => name);
  expect(oidc).toEqual(['publish']);
  expect(workflow.jobs.select.if).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.prepare.if).toBe("needs.select.outputs.due == 'true'");
  const publisher = workflow.jobs.publish;
  expect(publisher.needs).toEqual(['select', 'prepare']);
  expect(publisher.environment).toBe('npm');
  expect(publisher.permissions['id-token']).toBe('write');
  // Registry readiness is checked before anyone is asked to approve, and the tag follows only a verified cohort.
  expect(workflow.jobs.prepare.steps.some((step: { run?: string }) => /npm:preflight/.test(step.run ?? ''))).toBe(true);
  expect(workflow.jobs.release.needs).toEqual(['select', 'verify']);
  expect(workflow.jobs.release.permissions).toEqual({ contents: 'write', actions: 'write' });
  const versioner = parse(readFileSync(resolve(root, '.github/workflows/release-pr.yml'), 'utf8'));
  expect(versioner.on.push).toEqual({ branches: ['main'] });
  expect(JSON.stringify(versioner)).not.toMatch(/id-token|environment|npm publish|pnpm install/);
  expect(JSON.stringify(versioner)).toMatch(/--published-only/);
  const upload = workflow.jobs.prepare.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const download = publisher.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  expect(download.with.name).toBe(upload.with.name);
  expect(download.with['run-id']).toBeUndefined();
  expect(publisher.steps.some((step: { run?: string }) => /pnpm install|npm ci|pnpm build/.test(step.run ?? ''))).toBe(
    false,
  );
  expect(JSON.stringify(workflow)).not.toMatch(/secrets\.NPM|NODE_AUTH_TOKEN|actions\/cache/);
});

it('refuses a missing or changed system compatibility companion', () =>
  inFixture((directory) => {
    const release = writeReleaseManifest(root, directory, archivesFixture(directory), evidence);
    const path = resolve(directory, COMPATIBILITY),
      before = readFileSync(path);
    writeFileSync(path, Buffer.concat([before, Buffer.from(' ')]));
    expect(() => verifyPublicCompatibility(root, directory, release.systemCompatibility.sha256, { inputs })).toThrow(
      /manifest changed/,
    );
    rmSync(path);
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence)).toThrow();
  }));
it('refuses stale native versions, npm identities and protocol formats before qualification', () =>
  inFixture((directory) => {
    for (const mutate of [
      (row: any) => {
        row.packages[0].native.version = '99.0.0';
      },
      (row: any) => {
        row.packages[0].package.version = '99.0.0';
      },
      (row: any) => {
        row.packages[0].protocols.binding = 99;
      },
      (row: any) => {
        row.packages.pop();
      },
    ]) {
      const compatibility = compatibilityFixture(directory);
      mutate(compatibility);
      writeFileSync(resolve(directory, COMPATIBILITY), JSON.stringify(compatibility));
      expect(() => writeReleaseManifest(root, directory, archivesFixture(directory), evidence)).toThrow(
        /System compatibility/,
      );
    }
  }));
it('refuses changed source recipes and input provenance before qualification', () =>
  inFixture((directory) => {
    for (const mutate of [
      (row: any) => {
        row.sourceRevision = '0'.repeat(40);
      },
      (row: any) => {
        row.recipe.publicCommit = '0'.repeat(40);
      },
      (row: any) => {
        row.recipe.files = [];
      },
      (row: any) => {
        row.recipe.extraction.sourceInputsSha256 = '0'.repeat(64);
      },
      (row: any) => {
        row.recipe.pnpm = '99.0.0';
      },
    ]) {
      const compatibility = compatibilityFixture(directory);
      mutate(compatibility);
      writeFileSync(resolve(directory, COMPATIBILITY), JSON.stringify(compatibility));
      expect(() => writeReleaseManifest(root, directory, archivesFixture(directory), evidence)).toThrow(
        /System compatibility/,
      );
    }
  }));

it('refuses non-system archive mutation after qualification and before release receipt creation', () =>
  inFixture((directory) => {
    const packed = archivesFixture(directory);
    const compatibility = compatibilityFixture(directory);
    const systemNames = new Set(compatibility.packages.map((row: { package: { name: string } }) => row.package.name));
    const entry = packed.find((row) => !systemNames.has(row.name));
    expect(entry).toBeDefined();
    const path = resolve(directory, entry!.filename),
      original = readFileSync(path),
      changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(path, changed);
    expect(() => writeReleaseManifest(root, directory, packed, evidence)).toThrow(/qualified archive bytes differ/);
    expect(existsSync(resolve(directory, 'npm-release.json'))).toBe(false);
    writeFileSync(path, original);
    expect(() =>
      writeReleaseManifest(
        root,
        directory,
        packed.map((row) => (row === entry ? { ...row, sha256: '' } : row)),
        evidence,
      ),
    ).toThrow(/qualified archive hash is required/);
    expect(existsSync(resolve(directory, 'npm-release.json'))).toBe(false);
    const release = writeReleaseManifest(root, directory, packed, evidence);
    expect(verifyRelease(root, directory, checkoutVersion, evidence)).toEqual(release);
  }));

it('refreshes the pinned private VS Code extension without accepting identity changes', () => {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'ia-extension-input-refresh-')));
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(resolve(directory, path)), { recursive: true });
    writeFileSync(resolve(directory, path), JSON.stringify(value));
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: directory, windowsHide: true, stdio: 'pipe' });
  const extension = { name: 'inventarch-ia', publisher: 'inventarch', private: true, version: '1.1.0' };
  const path = 'apps/vscode/package.json';
  try {
    put('package.json', { name: '@inventarch/workspace' });
    put(path, extension);
    const files = ['package.json', path].map((path) => ({ path, sha256: sha(readFileSync(resolve(directory, path))) }));
    const original = {
      format: 'ia.public-package-inputs.v1',
      sourceRevision: 'a'.repeat(40),
      provenance: { sourceTree: 'b'.repeat(40) },
      baselineOverlay: { versions: { npm: { [path]: extension.version } } },
      packageIdentities: { [path]: { name: extension.name, private: true } },
      files,
    };
    put(PUBLIC_INPUTS, original);
    git('init', '--quiet');
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
      'Pinned extension fixture',
    );
    put(path, { ...extension, version: '1.2.0' });
    // An unsealed change refuses the sealed read that release preparation uses. The unsealed read is what a refresh
    // would write, and it writes nothing.
    expect(() => publicPackageInputs(directory)).toThrow(/Changed public package input/);
    const current = publicPackageInputs(directory, { sealed: false });
    expect(readFileSync(resolve(directory, PUBLIC_INPUTS), 'utf8')).toBe(JSON.stringify(original));
    const refreshed = refreshPublicPackageInputs(directory);
    expect({ ...current.receipt.publicRefresh, dirty: true }).toEqual({
      ...refreshed.receipt.publicRefresh,
      dirty: true,
    });
    expect(current.receipt.files).toEqual(refreshed.receipt.files);
    expect(refreshed.receipt.provenance).toEqual(original.provenance);
    expect(refreshed.receipt.sourceRevision).toBe(original.sourceRevision);
    expect(refreshed.receipt.publicRefresh?.npm).toEqual({ [path]: '1.2.0' });
    expect(publicPackageInputs(directory).sha256).toBe(refreshed.sha256);
    for (const changed of [
      { name: 'other-extension' },
      { private: false },
      { publisher: 'other' },
      { version: 'invalid' },
    ]) {
      put(path, { ...extension, ...changed });
      expect(() => refreshPublicPackageInputs(directory)).toThrow(/public package identity/i);
      // Unsealed qualification keeps the identity review: a pull request cannot rename a package either.
      expect(() => publicPackageInputs(directory, { sealed: false })).toThrow(/public package identity/i);
      expect(readFileSync(resolve(directory, PUBLIC_INPUTS))).toEqual(refreshed.bytes);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
