import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  verifyRelease,
  writeReleaseManifest,
} from './npm-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const archive = Buffer.from('qualified package bytes');
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
const entry = (name = '@inventarch/language') => ({
  name,
  version: '1.0.0',
  filename: 'ia-language-1.0.0.tgz',
  bytes: archive.length,
  integrity,
});
const release = () => ({ source: { commit: 'a'.repeat(40), dirty: false }, packages: [entry()] });
const remote = (value = integrity) => ({ versions: { '1.0.0': { dist: { integrity: value } } } });

it('refuses changed archive bytes and a manifest from another source commit', () => {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(resolve(temporaryRoot, 'ia-npm-release-test-')));
  try {
    const packed = publicPackages(root).map(({ manifest }) => {
      const filename = `${manifest.name.replace('@', '').replace('/', '-')}-1.0.0.tgz`;
      writeFileSync(resolve(directory, filename), archive);
      return { name: manifest.name, filename };
    });
    const manifest = writeReleaseManifest(root, directory, packed);
    expect(verifyRelease(root, directory, '1.0.0')).toEqual(manifest);
    const first = resolve(directory, packed[0]!.filename);
    const changed = Buffer.from(archive);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(first, changed);
    expect(() => verifyRelease(root, directory, '1.0.0')).toThrow(/archive integrity changed/);
    writeFileSync(first, archive);
    writeFileSync(
      resolve(directory, 'npm-release.json'),
      JSON.stringify({ ...manifest, source: { ...manifest.source, commit: '0'.repeat(40) } }),
    );
    expect(() => verifyRelease(root, directory, '1.0.0')).toThrow(/Archive source must match checkout/);
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
  expect(projects).toHaveLength(15);
  expect(() => validatePackages(projects, '1.0.0')).not.toThrow();
  expect(() => validatePackages(projects, '1.0.1')).toThrow(/version differs/);
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
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.prepare.permissions['id-token']).toBeUndefined();
  const publisher = workflow.jobs.publish;
  expect(publisher.needs).toBe('prepare');
  expect(publisher.environment).toBe('npm');
  expect(publisher.permissions['id-token']).toBe('write');
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
