import {
  publicPackageInputs,
  refreshPublicPackageInputs,
  PUBLIC_INPUTS,
  COMPATIBILITY,
  verifyPublicCompatibility,
} from '../release/public-pack.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import {
  assertPublisherEnvironment,
  dependencyOrder,
  publicationOrder,
  publicationPlan,
  publicPackages,
  REPOSITORY_URL,
  REGISTRY,
  REGISTRY_VISIBILITY,
  REGISTRY_WAIT,
  validatePackages,
  releaseVersions,
  verifyRelease,
  writeReleaseManifest,
} from './npm-release.mjs';
import {
  checkout as root,
  compatibilityFixture,
  evidence,
  git,
  inQualifiedCohort,
  inRepository,
  receipts,
  sha,
} from './release-fixtures.js';

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

it('refuses changed archive bytes and a manifest from another source commit', () =>
  inQualifiedCohort((directory, archives) => {
    const packed = receipts(archives);
    const manifest = writeReleaseManifest(root, directory, packed, evidence());
    expect(manifest.packages.map((entry) => entry.name)).toEqual(
      publicationOrder(manifest.graph.groups, manifest.baselineVersions),
    );
    expect(verifyRelease(root, directory, checkoutVersion, evidence())).toEqual(manifest);
    const first = resolve(directory, packed[0]!.filename);
    const original = readFileSync(first);
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(first, changed);
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence())).toThrow(/archive integrity changed/);
    writeFileSync(first, original);
    writeFileSync(
      resolve(directory, 'npm-release.json'),
      JSON.stringify({ ...manifest, source: { ...manifest.source, commit: '0'.repeat(40) } }),
    );
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence())).toThrow(
      /Archive source must match checkout/,
    );
  }));

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

it('publishes every new package name before any existing package moves its latest tag', () => {
  // Dependency groups as releaseGraph returns them: a cycle with a new name, between acyclic groups old and new.
  const groups = [
    { members: ['@inventarch/language'], cyclic: false },
    { members: ['@inventarch/new-leaf'], cyclic: false },
    { members: ['@inventarch/agent-system', '@inventarch/new-system', '@inventarch/session-system'], cyclic: true },
    { members: ['@inventarch/cli'], cyclic: false },
  ];
  const baselines = {
    '@inventarch/language': '1.0.0',
    '@inventarch/new-leaf': null,
    '@inventarch/agent-system': '1.0.0',
    '@inventarch/new-system': null,
    '@inventarch/session-system': '1.0.0',
    '@inventarch/cli': '1.0.0',
  };
  expect(publicationOrder(groups, baselines)).toEqual([
    '@inventarch/new-leaf',
    '@inventarch/new-system',
    '@inventarch/language',
    '@inventarch/agent-system',
    '@inventarch/session-system',
    '@inventarch/cli',
  ]);
  // Without new names the order is the dependency order of the groups.
  const existing = Object.fromEntries(Object.keys(baselines).map((name) => [name, '1.0.0']));
  expect(publicationOrder(groups, existing)).toEqual(groups.flatMap((group) => group.members));
});

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
  expect(projects).toHaveLength(Object.keys(releaseVersions(root, evidence().inputs)).length - 1);
  expect(() => validatePackages(projects, checkoutVersion, releaseVersions(root, evidence().inputs))).not.toThrow();
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

it('runs the release helper on pinned Node and dispatches only after unsuppressed success under strict bash', () => {
  const workflow = parse(readFileSync(resolve(root, '.github/workflows/npm-publish.yml'), 'utf8'));
  const steps = workflow.jobs.release.steps;
  const setup = steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@'));
  const completion = steps.find((step: { run?: string }) => step.run?.includes('github-release.mjs'));
  expect(setup.with).toEqual({ 'node-version': '22.22.2', 'package-manager-cache': false });
  expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(completion));
  expect(completion.shell).toBe('bash');
  expect(
    completion.run
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line && !line.startsWith('#')),
  ).toEqual([
    'set -euo pipefail',
    'node tools/distribution/github-release.mjs',
    'gh workflow run release-pr.yml --ref main',
  ]);
});

// A change detector: NPM-PUBLISHING.md documents these values.
it('pins the frozen registry visibility bound at 15 minutes, polling every 20 s, and the verify job limit at 30 minutes', () => {
  expect(REGISTRY_VISIBILITY).toEqual({ timeoutMs: 15 * 60_000, intervalMs: 20_000 });
  expect(Object.isFrozen(REGISTRY_VISIBILITY)).toBe(true);
  const workflow = parse(readFileSync(resolve(root, '.github/workflows/npm-publish.yml'), 'utf8'));
  expect(workflow.jobs.verify['timeout-minutes']).toBe(30);
});

it('waits in verify-registry with that bound, a real delay, the monotonic process clock and stderr', async () => {
  expect(Object.isFrozen(REGISTRY_WAIT)).toBe(true);
  expect({ timeoutMs: REGISTRY_WAIT.timeoutMs, intervalMs: REGISTRY_WAIT.intervalMs }).toEqual({
    timeoutMs: 15 * 60_000,
    intervalMs: 20_000,
  });
  expect(REGISTRY_WAIT.log).toBe(console.error);
  const before = performance.now(),
    read = REGISTRY_WAIT.now(),
    after = performance.now();
  expect(read).toBeGreaterThanOrEqual(before);
  expect(read).toBeLessThanOrEqual(after);
  await REGISTRY_WAIT.sleep(40);
  expect(performance.now() - after).toBeGreaterThanOrEqual(20);
});

it('refuses a missing or changed system compatibility companion', () =>
  inQualifiedCohort((directory, archives) => {
    const release = writeReleaseManifest(root, directory, receipts(archives), evidence());
    const path = resolve(directory, COMPATIBILITY),
      before = readFileSync(path);
    writeFileSync(path, Buffer.concat([before, Buffer.from(' ')]));
    expect(() =>
      verifyPublicCompatibility(root, directory, release.systemCompatibility.sha256, { inputs: evidence().inputs }),
    ).toThrow(/manifest changed/);
    rmSync(path);
    expect(() => verifyRelease(root, directory, checkoutVersion, evidence())).toThrow();
  }));
it('refuses stale native versions, npm identities and protocol formats before qualification', () =>
  inQualifiedCohort((directory, archives) => {
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
      expect(() => writeReleaseManifest(root, directory, receipts(archives), evidence())).toThrow(
        /System compatibility/,
      );
    }
  }));
it('refuses changed source recipes and input provenance before qualification', () =>
  inQualifiedCohort((directory, archives) => {
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
      expect(() => writeReleaseManifest(root, directory, receipts(archives), evidence())).toThrow(
        /System compatibility/,
      );
    }
  }));

it('refuses non-system archive mutation after qualification and before release receipt creation', () =>
  inQualifiedCohort((directory, archives) => {
    const packed = receipts(archives);
    const systemNames = new Set(compatibilityFixture(directory).packages.map((row) => row.package.name));
    const entry = packed.find((row) => !systemNames.has(row.name));
    expect(entry).toBeDefined();
    const path = resolve(directory, entry!.filename),
      original = readFileSync(path),
      changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(path, changed);
    expect(() => writeReleaseManifest(root, directory, packed, evidence())).toThrow(/qualified archive bytes differ/);
    expect(existsSync(resolve(directory, 'npm-release.json'))).toBe(false);
    writeFileSync(path, original);
    expect(() =>
      writeReleaseManifest(
        root,
        directory,
        packed.map((row) => (row === entry ? { ...row, sha256: '' } : row)),
        evidence(),
      ),
    ).toThrow(/qualified archive hash is required/);
    expect(existsSync(resolve(directory, 'npm-release.json'))).toBe(false);
    const release = writeReleaseManifest(root, directory, packed, evidence());
    expect(verifyRelease(root, directory, checkoutVersion, evidence())).toEqual(release);
  }));

it('refreshes the pinned private VS Code extension without accepting identity changes', () =>
  inRepository(async (directory) => {
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(resolve(directory, path)), { recursive: true });
      writeFileSync(resolve(directory, path), JSON.stringify(value));
    };
    const extension = { name: 'inventarch-ia', publisher: 'inventarch', private: true, version: '1.1.0' };
    const path = 'apps/vscode/package.json';
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
    await git(directory, 'add', '.');
    await git(directory, 'commit', '--quiet', '-m', 'Pinned extension fixture');
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
  }));
