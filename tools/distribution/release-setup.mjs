import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
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
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { ENVIRONMENT, NPM_VERSION, REGISTRY, REPOSITORY, REPOSITORY_URL, WORKFLOW } from './npm-release.mjs';
import { publicPackages } from './release-packages.mjs';

/**
 * One-time account and repository setup for automated publication. The default run only reads; `--apply` makes the
 * account writes a maintainer would otherwise make by hand. npm requires a package to exist before a trusted
 * publisher can be configured, so a missing name is created by staging a placeholder prerelease that is never
 * approved: the reviewed version itself is published by the workflow with OIDC and provenance.
 */
export const BOOTSTRAP_VERSION = '0.0.0-bootstrap.0';
export const BOOTSTRAP_TAG = 'bootstrap';
const NAME = /^@inventarch\/[a-z0-9-]+$/;

/** npm 12.2.0's engine range (^22.22.2 || ^24.15.0 || >=26.0.0): an older Node runs it only with warnings. */
export function npmEngineSupported(version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor >= 15;
  return major >= 26;
}
/** A workflow file that declares top-level permissions keeps them whatever the repository's default token is. */
export function declaresPermissions(workflowText) {
  return /^permissions:/m.test(workflowText);
}

export function trustArgs(name) {
  assert.match(name, NAME, 'Unexpected package name');
  return [
    'trust',
    'github',
    name,
    '--file',
    WORKFLOW,
    '--repo',
    REPOSITORY,
    '--environment',
    ENVIRONMENT,
    '--allow-publish',
    '--yes',
  ];
}
/** A listing names this repository and workflow when the package already trusts it, in JSON or in text. */
export function trustConfigured(listing) {
  const text = listing.toLowerCase();
  return text.includes(REPOSITORY) && text.includes(WORKFLOW);
}
/** The placeholder that only creates the name. Its version can never collide with a cohort release. */
export function bootstrapManifest(name) {
  assert.match(name, NAME, 'Unexpected package name');
  return {
    name,
    version: BOOTSTRAP_VERSION,
    description: 'Creates the package name so its trusted publisher can be configured. Never approved or installed.',
    license: 'Apache-2.0',
    repository: { type: 'git', url: REPOSITORY_URL },
  };
}
/** What each package still needs. `unknown` trust is reported, never guessed into a write. */
export function npmSetupPlan(names, state) {
  return names.map((name) => {
    const { exists, trust } = state[name];
    const actions = !exists ? ['bootstrap', 'trust'] : trust === 'missing' ? ['trust'] : [];
    return { name, exists, trust: exists ? trust : 'missing', actions };
  });
}
/**
 * Differences between the repository's GitHub settings and what the release workflows need. A read-only default
 * token is proposed only when every workflow declares its own permissions, so the change cannot narrow one.
 */
export function githubSetupPlan(state, rulesets, { everyWorkflowDeclaresPermissions = false } = {}) {
  const issues = [];
  if (!state.environment) issues.push({ setting: 'environment', fix: 'create' });
  else {
    if (!state.environment.reviewers.length) issues.push({ setting: 'environment-reviewers', fix: 'add' });
    if (!state.environment.branches.includes('main') || state.environment.branches.length !== 1)
      issues.push({ setting: 'environment-branches', fix: 'main only' });
  }
  if (!state.workflow?.can_approve_pull_request_reviews)
    issues.push({ setting: 'actions-create-pull-requests', fix: 'allow' });
  if (everyWorkflowDeclaresPermissions && state.workflow?.default_workflow_permissions !== 'read')
    issues.push({ setting: 'default-token-permissions', fix: 'read' });
  for (const name of rulesets)
    if (!state.rulesets.includes(name)) issues.push({ setting: 'ruleset:' + name, fix: 'create' });
  return issues;
}

// ---- I/O -------------------------------------------------------------------------------------------------------

const root = resolve(import.meta.dirname, '../..');
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}
/** The running Node's own npm, located without a shell so Windows needs no npm.cmd. */
function bundledNpm() {
  const base = dirname(process.execPath);
  const candidate = [
    resolve(base, 'node_modules/npm/bin/npm-cli.js'),
    resolve(base, '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find(existsSync);
  assert.ok(candidate, 'Cannot find the npm bundled with this Node; pass --npm-cli <path to npm-cli.js>');
  return candidate;
}
/** The pinned publishing CLI. Trust and staged publishing need a newer npm than Node 22 bundles. */
function pinnedNpm(override) {
  if (override) return resolve(override);
  const prefix = resolve(realpathSync(tmpdir()), `ia-npm-cli-${NPM_VERSION}`);
  const cli = resolve(prefix, 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(cli)) {
    mkdirSync(prefix, { recursive: true });
    run(process.execPath, [
      bundledNpm(),
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--package-lock=false',
      '--ignore-scripts',
      `npm@${NPM_VERSION}`,
    ]);
  }
  const version = run(process.execPath, [cli, '--version']).trim();
  assert.equal(version, NPM_VERSION, `Expected npm ${NPM_VERSION}, found ${version}`);
  return cli;
}
async function registryExists(name) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return false;
  assert.ok(response.ok, `${name}: registry returned ${response.status}`);
  return true;
}
function ghCommand() {
  for (const candidate of ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'])
    try {
      run(candidate, ['--version']);
      return candidate;
    } catch {}
  return null;
}
const ghJson = (gh, path, options = {}) =>
  JSON.parse(run(gh, ['api', ...(options.args ?? []), path], options) || 'null');
function githubState(gh) {
  const environment = (() => {
    try {
      const value = ghJson(gh, `repos/${REPOSITORY}/environments/${ENVIRONMENT}`, { stdio: 'pipe' });
      const reviewers =
        value.protection_rules
          ?.filter((rule) => rule.type === 'required_reviewers')
          .flatMap((rule) => rule.reviewers.map((row) => row.reviewer.login ?? row.reviewer.slug)) ?? [];
      const branches = value.deployment_branch_policy?.custom_branch_policies
        ? ghJson(gh, `repos/${REPOSITORY}/environments/${ENVIRONMENT}/deployment-branch-policies`, {
            stdio: 'pipe',
          }).branch_policies.map((row) => row.name)
        : [];
      return { reviewers, branches };
    } catch (error) {
      if (/HTTP 404/.test(String(error.stderr ?? error.message))) return null;
      throw error;
    }
  })();
  return {
    environment,
    workflow: ghJson(gh, `repos/${REPOSITORY}/actions/permissions/workflow`, { stdio: 'pipe' }),
    rulesets: ghJson(gh, `repos/${REPOSITORY}/rulesets`, { stdio: 'pipe' }).map((row) => row.name),
  };
}
function codeOwner() {
  const line = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8')
    .split('\n')
    .find((row) => row.startsWith('* '));
  const owner = line?.split(/\s+/)[1]?.replace(/^@/, '');
  assert.ok(owner, 'Pass --reviewer: .github/CODEOWNERS names no default owner');
  return owner;
}
function applyGithub(gh, issues, reviewer) {
  const put = (path, body, method = 'PUT') =>
    run(gh, ['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(body), stdio: 'pipe' });
  if (issues.some((issue) => issue.setting.startsWith('environment'))) {
    const [org, team] = reviewer.split('/');
    const id = team
      ? ghJson(gh, `orgs/${org}/teams/${team}`).id
      : ghJson(gh, `users/${reviewer}`, { stdio: 'pipe' }).id;
    put(`repos/${REPOSITORY}/environments/${ENVIRONMENT}`, {
      reviewers: [{ type: team ? 'Team' : 'User', id }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    const policies = ghJson(gh, `repos/${REPOSITORY}/environments/${ENVIRONMENT}/deployment-branch-policies`, {
      stdio: 'pipe',
    }).branch_policies;
    for (const policy of policies.filter((row) => row.name !== 'main'))
      run(gh, [
        'api',
        '-X',
        'DELETE',
        `repos/${REPOSITORY}/environments/${ENVIRONMENT}/deployment-branch-policies/${policy.id}`,
      ]);
    if (!policies.some((row) => row.name === 'main'))
      put(
        `repos/${REPOSITORY}/environments/${ENVIRONMENT}/deployment-branch-policies`,
        { name: 'main', type: 'branch' },
        'POST',
      );
    console.log(`Environment ${ENVIRONMENT}: main only, required reviewer ${reviewer}`);
  }
  const pullRequests = issues.some((issue) => issue.setting === 'actions-create-pull-requests'),
    readToken = issues.some((issue) => issue.setting === 'default-token-permissions');
  if (pullRequests || readToken) {
    const current = ghJson(gh, `repos/${REPOSITORY}/actions/permissions/workflow`, { stdio: 'pipe' });
    const next = {
      default_workflow_permissions: readToken ? 'read' : current.default_workflow_permissions,
      can_approve_pull_request_reviews: true,
    };
    try {
      put(`repos/${REPOSITORY}/actions/permissions/workflow`, next);
      console.log(`Actions may create pull requests; default workflow token: ${next.default_workflow_permissions}`);
    } catch (error) {
      console.error(
        `Could not update Actions workflow permissions: ${String(error.stderr ?? error.message).trim()}\n` +
          `If the ${REPOSITORY.split('/')[0]} organization blocks it, enable it in the organization's Actions settings.`,
      );
      process.exitCode = 1;
    }
  }
  for (const issue of issues.filter((row) => row.setting.startsWith('ruleset:'))) {
    const name = issue.setting.slice('ruleset:'.length);
    run(gh, ['api', '-X', 'POST', `repos/${REPOSITORY}/rulesets`, '--input', `.github/rulesets/${name}.json`], {
      stdio: 'pipe',
    });
    console.log(`Ruleset ${name}: created from .github/rulesets/${name}.json`);
  }
}
function applyNpm(cli, plan) {
  const npm = (args, options = {}) => run(process.execPath, [cli, ...args], options);
  const scratch = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
  try {
    for (const row of plan) {
      if (row.actions.includes('bootstrap')) {
        const directory = resolve(scratch, row.name.slice('@inventarch/'.length));
        mkdirSync(directory);
        writeFileSync(resolve(directory, 'package.json'), JSON.stringify(bootstrapManifest(row.name), null, 2) + '\n');
        writeFileSync(
          resolve(directory, 'README.md'),
          `# ${row.name}\n\nPlaceholder that creates this name for trusted publishing. Install a released version.\n`,
        );
        console.log(`Staging ${row.name}@${BOOTSTRAP_VERSION} to create the name (it is never approved)`);
        npm(['stage', 'publish', directory, '--access', 'public', '--tag', BOOTSTRAP_TAG], { stdio: 'inherit' });
      }
      if (row.actions.includes('trust')) {
        console.log(`Trusting ${REPOSITORY} ${WORKFLOW} (environment ${ENVIRONMENT}) to publish ${row.name}`);
        npm(trustArgs(row.name), { stdio: 'inherit' });
        assert.ok(trustConfigured(npm(['trust', 'list', row.name])), `${row.name}: trusted publisher not confirmed`);
      }
      if (row.actions.includes('bootstrap')) rejectBootstrap(npm, row.name);
    }
  } finally {
    assert.ok(scratch.startsWith(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
    rmSync(scratch, { recursive: true, force: true });
  }
}
/**
 * The id of the placeholder stage in `npm stage list --json` output. npm documents the command, not its JSON shape,
 * so this searches every object for the placeholder version and an id field, and returns null rather than guess.
 */
export function bootstrapStageId(listing) {
  let value;
  try {
    value = JSON.parse(listing);
  } catch {
    return null;
  }
  const pending = [value];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.version === BOOTSTRAP_VERSION) {
      const id = node.id ?? node.stageId ?? node.stage_id;
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
    pending.push(...Object.values(node));
  }
  return null;
}
/** Withdraw the placeholder stage so only the workflow's reviewed version is ever approved. */
function rejectBootstrap(npm, name) {
  let id = null;
  try {
    id = bootstrapStageId(npm(['stage', 'list', name, '--json'], { stdio: 'pipe' }));
  } catch {}
  if (!id) {
    console.log(
      `Reject the ${name}@${BOOTSTRAP_VERSION} stage: npm stage list ${name}, then npm stage reject <stage-id>`,
    );
    return;
  }
  npm(['stage', 'reject', String(id)], { stdio: 'inherit' });
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'npm-cli': { type: 'string' },
      reviewer: { type: 'string' },
      'skip-github': { type: 'boolean', default: false },
      'skip-npm': { type: 'boolean', default: false },
    },
  });
  const names = publicPackages(root)
    .map((project) => project.manifest.name)
    .sort();
  const report = { npm: null, github: null };
  if (!values['skip-npm']) {
    if (!npmEngineSupported(process.version)) {
      const message = `npm ${NPM_VERSION} needs Node 22.22.2 or later; this is ${process.version}`;
      assert.ok(!values.apply, message + '. Switch Node (for example fnm use 22.22.2) before --apply.');
      console.log(message + '; reading anyway.');
    }
    const cli = pinnedNpm(values['npm-cli']);
    let loggedIn = true;
    try {
      run(process.execPath, [cli, 'whoami'], { stdio: 'pipe' });
    } catch {
      loggedIn = false;
    }
    const state = {};
    for (const name of names) {
      const exists = await registryExists(name);
      let trust = 'unknown';
      if (exists && loggedIn)
        try {
          trust = trustConfigured(run(process.execPath, [cli, 'trust', 'list', name], { stdio: 'pipe' }))
            ? 'configured'
            : 'missing';
        } catch {}
      state[name] = { exists, trust };
    }
    const plan = npmSetupPlan(names, state);
    report.npm = { loggedIn, packages: plan };
    console.table(
      plan.map(({ name, exists, trust, actions }) => ({ name, exists, trust, needs: actions.join(' + ') })),
    );
    if (!loggedIn) console.log('npm: log in with `npm login` (2FA required) to read and configure trusted publishers.');
    if (values.apply) {
      assert.ok(loggedIn, 'npm login is required to apply');
      const unknown = plan.filter((row) => row.trust === 'unknown');
      assert.equal(unknown.length, 0, 'Trust could not be read for: ' + unknown.map((row) => row.name).join(', '));
      applyNpm(cli, plan);
    }
  }
  if (!values['skip-github']) {
    const gh = ghCommand();
    const rulesets = readdirSync(resolve(root, '.github/rulesets'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(resolve(root, '.github/rulesets', name), 'utf8')).name);
    let state = null;
    try {
      if (gh) state = githubState(gh);
    } catch (error) {
      console.log(
        `GitHub: ${
          String(error.stderr ?? error.message)
            .trim()
            .split('\n')[0]
        }`,
      );
    }
    if (!state) console.log('GitHub: run `gh auth login` as a repository admin to read and apply settings.');
    else {
      const workflows = readdirSync(resolve(root, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name));
      const issues = githubSetupPlan(state, rulesets, {
        everyWorkflowDeclaresPermissions: workflows.every((name) =>
          declaresPermissions(readFileSync(resolve(root, '.github/workflows', name), 'utf8')),
        ),
      });
      report.github = { state, issues };
      console.table(issues.length ? issues : [{ setting: 'all', fix: 'none needed' }]);
      if (values.apply && issues.length) applyGithub(gh, issues, values.reviewer ?? codeOwner());
    }
    if (values.apply) assert.ok(state, 'GitHub settings could not be read; nothing was applied there');
  }
  if (!values.apply) console.log('\nRead-only. Re-run with --apply to make these changes.');
}
