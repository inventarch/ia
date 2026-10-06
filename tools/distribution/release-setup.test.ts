import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ENVIRONMENT, NPM_VERSION, REPOSITORY, WORKFLOW } from './npm-release.mjs';
import { stableVersion } from './release-changes.mjs';
import {
  BOOTSTRAP_TAG,
  BOOTSTRAP_VERSION,
  bootstrapManifest,
  bootstrapStageId,
  declaresPermissions,
  githubSetupPlan,
  npmEngineSupported,
  npmSetupPlan,
  trustArgs,
  trustConfigured,
} from './release-setup.mjs';

const root = resolve(import.meta.dirname, '../..');

it('trusts exactly the publishing workflow, environment and repository', () => {
  expect(trustArgs('@inventarch/cli')).toEqual([
    'trust',
    'github',
    '@inventarch/cli',
    '--file',
    'npm-publish.yml',
    '--repo',
    'inventarch/ia',
    '--environment',
    'npm',
    '--allow-publish',
    '--yes',
  ]);
  expect([WORKFLOW, REPOSITORY, ENVIRONMENT]).toEqual(['npm-publish.yml', 'inventarch/ia', 'npm']);
  expect(() => trustArgs('@inventarch/cli --allow-stage-publish')).toThrow(/Unexpected package name/);
  expect(() => trustArgs('left-pad')).toThrow(/Unexpected package name/);
});

it('reads a trust listing in JSON or text and refuses another repository or workflow', () => {
  expect(trustConfigured(JSON.stringify([{ repository: 'inventarch/ia', file: 'npm-publish.yml' }]))).toBe(true);
  expect(trustConfigured('GitHub  inventarch/ia  npm-publish.yml  environment: npm')).toBe(true);
  expect(trustConfigured('GitHub  inventarch/ia  release.yml')).toBe(false);
  expect(trustConfigured('GitHub  someone/ia  npm-publish.yml')).toBe(false);
  expect(trustConfigured('')).toBe(false);
});

it('creates a name with a placeholder prerelease that can never be a cohort version', () => {
  const manifest = bootstrapManifest('@inventarch/work-system');
  expect(manifest).toMatchObject({
    name: '@inventarch/work-system',
    version: BOOTSTRAP_VERSION,
    license: 'Apache-2.0',
  });
  expect(stableVersion(BOOTSTRAP_VERSION)).toBe(false);
  expect(BOOTSTRAP_TAG).not.toBe('latest');
  expect(manifest).not.toHaveProperty('scripts');
  expect(() => bootstrapManifest('@other/work-system')).toThrow();
});

it('bootstraps only missing names, trusts only untrusted packages and never guesses unknown trust', () => {
  const plan = npmSetupPlan(['@inventarch/a', '@inventarch/b', '@inventarch/c', '@inventarch/d'], {
    '@inventarch/a': { exists: false, trust: 'unknown' },
    '@inventarch/b': { exists: true, trust: 'missing' },
    '@inventarch/c': { exists: true, trust: 'configured' },
    '@inventarch/d': { exists: true, trust: 'unknown' },
  });
  expect(plan.map((row) => [row.name, row.trust, row.actions])).toEqual([
    ['@inventarch/a', 'missing', ['bootstrap', 'trust']],
    ['@inventarch/b', 'missing', ['trust']],
    ['@inventarch/c', 'configured', []],
    ['@inventarch/d', 'unknown', []],
  ]);
});

it('requires a reviewed main-only environment, pull-request creation and every declared ruleset', () => {
  const ready = {
    environment: { reviewers: ['crowncodes'], branches: ['main'] },
    workflow: { can_approve_pull_request_reviews: true },
    rulesets: ['main', 'tags'],
  };
  expect(githubSetupPlan(ready, ['main', 'tags'])).toEqual([]);
  expect(githubSetupPlan({ ...ready, environment: null }, ['main'])).toEqual([
    { setting: 'environment', fix: 'create' },
  ]);
  expect(
    githubSetupPlan(
      { ...ready, environment: { reviewers: [], branches: ['main', 'release/*'] }, workflow: {}, rulesets: ['main'] },
      ['main', 'tags'],
    ).map((issue) => issue.setting),
  ).toEqual(['environment-reviewers', 'environment-branches', 'actions-create-pull-requests', 'ruleset:tags']);
  // A write default token is narrowed only when every workflow declares its own permissions.
  const writeToken = { ...ready, workflow: { ...ready.workflow, default_workflow_permissions: 'write' } };
  expect(githubSetupPlan(writeToken, ['main', 'tags'])).toEqual([]);
  expect(githubSetupPlan(writeToken, ['main', 'tags'], { everyWorkflowDeclaresPermissions: true })).toEqual([
    { setting: 'default-token-permissions', fix: 'read' },
  ]);
});

it('narrows the default token only for workflows that each declare top-level permissions', () => {
  expect(declaresPermissions(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs: {}'].join('\n'))).toBe(
    true,
  );
  // Job-level permissions alone leave any other job on the repository default.
  expect(declaresPermissions(['name: x', 'jobs:', '  a:', '    permissions:', '      contents: read'].join('\n'))).toBe(
    false,
  );
  const workflows = [
    'codeql.yml',
    'inventarch-review.yml',
    'npm-publish.yml',
    'platform-quality.yml',
    'release-pr.yml',
  ];
  for (const name of workflows)
    expect([name, declaresPermissions(readFileSync(resolve(root, '.github/workflows', name), 'utf8'))]).toEqual([
      name,
      true,
    ]);
});

it('runs the pinned npm only on a Node its engine range admits', () => {
  for (const version of ['v22.22.2', 'v22.23.0', 'v24.15.0', 'v26.0.0']) expect(npmEngineSupported(version)).toBe(true);
  for (const version of ['v22.22.0', 'v22.21.9', 'v24.14.1', 'v25.9.0', 'v20.19.0'])
    expect(npmEngineSupported(version)).toBe(false);
});

it('finds only the placeholder stage id and returns null rather than guessing', () => {
  expect(bootstrapStageId(JSON.stringify([{ id: 'stg_1', version: BOOTSTRAP_VERSION }]))).toBe('stg_1');
  expect(
    bootstrapStageId(
      JSON.stringify({
        stages: [
          { version: '1.1.0', id: 'real' },
          { stageId: 7, version: BOOTSTRAP_VERSION },
        ],
      }),
    ),
  ).toBe('7');
  expect(bootstrapStageId(JSON.stringify([{ id: 'real', version: '1.1.0' }]))).toBeNull();
  expect(bootstrapStageId('stg_1  0.0.0-bootstrap.0')).toBeNull();
});

it('pins the same npm CLI in the setup command and every publishing workflow job', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/npm-publish.yml'), 'utf8');
  const pins = [...workflow.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  expect(pins.length).toBeGreaterThanOrEqual(3);
  expect(new Set(pins)).toEqual(new Set([NPM_VERSION]));
});
