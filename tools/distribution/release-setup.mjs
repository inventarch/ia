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
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { ENVIRONMENT, NPM_VERSION, REGISTRY, REPOSITORY, REPOSITORY_URL, WORKFLOW } from './npm-release.mjs';
import { compareVersions } from './release-changes.mjs';
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
/** Installed Node version directories (`v22.22.2`, …) the pinned npm supports, newest first. */
export function compatibleNodeVersions(names) {
  return names
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name) && npmEngineSupported(name))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
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
/**
 * The trust a package has, from `npm trust list <name> --json`: npm prints nothing when there is none, and one
 * `{ id, type, file, repository, environment }` object per configuration (the registry allows one per package).
 */
export function trustState(listing) {
  const text = listing.trim();
  if (!text) return { state: 'missing' };
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { state: 'unknown' };
  }
  const matches =
    (config?.type ?? 'github') === 'github' &&
    config.repository === REPOSITORY &&
    basename(String(config.file ?? '')) === WORKFLOW &&
    config.environment === ENVIRONMENT;
  return { state: matches ? 'configured' : 'different', config };
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
/**
 * What each package still needs. Trust that was not read (it needs 2FA) or that names another repository, workflow
 * or environment is reported, never guessed into a write.
 */
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
/**
 * The stage id in `npm stage publish --json` or `npm stage list --json` output. A publish names it `stageId` beside
 * the package's own `id` (`name@version`); a listed stage names it `id`.
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
      const id =
        node.stageId ?? node.stage_id ?? (typeof node.id === 'string' && node.id.includes('@') ? null : node.id);
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
    pending.push(...Object.values(node));
  }
  return null;
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
const failure = (error) => String(error.stderr ?? '') + String(error.stdout ?? '') + String(error.message ?? '');
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
/**
 * A Node the pinned npm supports: `--node`, this Node, or the newest one fnm has installed, so the command works from
 * a shell whose own Node is older. Returns null when none is installed.
 */
function npmNode(override) {
  if (override) {
    const version = run(resolve(override), ['--version']).trim();
    assert.ok(npmEngineSupported(version), `${override} is Node ${version}; npm ${NPM_VERSION} needs 22.22.2 or later`);
    return resolve(override);
  }
  if (npmEngineSupported(process.version)) return process.execPath;
  const roots = [
    process.env.FNM_DIR,
    process.platform === 'win32' && process.env.APPDATA && resolve(process.env.APPDATA, 'fnm'),
    resolve(homedir(), '.local/share/fnm'),
    resolve(homedir(), 'Library/Application Support/fnm'),
  ].filter(Boolean);
  for (const directory of roots.map((root) => resolve(root, 'node-versions')).filter(existsSync))
    for (const name of compatibleNodeVersions(readdirSync(directory))) {
      const bin = resolve(directory, name, 'installation', process.platform === 'win32' ? 'node.exe' : 'bin/node');
      if (existsSync(bin)) return bin;
    }
  return null;
}
/** The pinned publishing CLI. Trust and staged publishing need a newer npm than Node 22 bundles. */
function pinnedNpm(override, node) {
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
  const version = run(node, [cli, '--version']).trim();
  assert.equal(version, NPM_VERSION, `Expected npm ${NPM_VERSION}, found ${version}`);
  return cli;
}
async function registryExists(name) {
  // The registry's CDN keeps serving a cached 404 for minutes after a name is created, so a rerun soon after a
  // bootstrap would try to create it again. A unique query bypasses that cache.
  const url = `${REGISTRY}/${encodeURIComponent(name)}?fresh=${Date.now()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } });
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

/**
 * npm account writes. Staging a placeholder needs no 2FA, but reading or changing trust does, and npm can only ask for
 * it when attached to a terminal. So one listing runs interactively first: confirming it in the browser with "skip
 * two-factor authentication for the next 5 minutes" lets every later read and write proceed without prompts.
 */
function applyNpm(npm, names, exists) {
  // Authenticate before any write: a failed 2FA then leaves nothing half done. A name npm does not have yet cannot
  // be listed, so the first existing package carries the interactive confirmation.
  const anchor = names.find((name) => exists[name]);
  const authenticate = () => {
    if (!anchor) return;
    console.log(
      '\nnpm needs two-factor authentication to read and change trusted publishers. When the browser asks, tick\n' +
        '"skip two-factor authentication for the next 5 minutes" so the remaining steps run without prompts.\n',
    );
    npm(['trust', 'list', anchor], { stdio: 'inherit' });
  };
  const lastLine = (error) => failure(error).trim().split('\n').at(-1);
  const readTrust = (name, retry = true) => {
    try {
      return trustState(npm(['trust', 'list', name, '--json'], { stdio: 'pipe' }));
    } catch (error) {
      if (retry && /EOTP|one-time password/.test(failure(error))) {
        authenticate();
        return readTrust(name, false);
      }
      throw new Error(`${name}: could not read trust. ${lastLine(error)}`);
    }
  };
  authenticate();

  const scratch = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
  try {
    for (const name of names.filter((row) => !exists[row])) {
      const directory = resolve(scratch, name.slice('@inventarch/'.length));
      mkdirSync(directory);
      writeFileSync(resolve(directory, 'package.json'), JSON.stringify(bootstrapManifest(name), null, 2) + '\n');
      writeFileSync(
        resolve(directory, 'README.md'),
        `# ${name}\n\nPlaceholder that creates this name for trusted publishing. Install a released version.\n`,
      );
      console.log(`Staging ${name}@${BOOTSTRAP_VERSION} to create the name; it is never approved`);
      npm(['stage', 'publish', directory, '--access', 'public', '--tag', BOOTSTRAP_TAG, '--ignore-scripts', '--json'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    }
  } finally {
    assert.ok(scratch.startsWith(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
    rmSync(scratch, { recursive: true, force: true });
  }

  const results = [];
  for (const name of names) {
    let { state, config } = readTrust(name);
    if (state === 'missing') {
      console.log(`Trusting ${REPOSITORY} ${WORKFLOW} (environment ${ENVIRONMENT}) to publish ${name}`);
      npm(trustArgs(name), { stdio: 'inherit' });
      ({ state, config } = readTrust(name));
      assert.equal(state, 'configured', `${name}: the trusted publisher was not confirmed after configuring it`);
      state = 'added';
    }
    results.push({ name, trust: state, ...(state === 'different' ? { current: JSON.stringify(config) } : {}) });
  }
  // Reject every placeholder stage still pending, including one an interrupted earlier run left behind, so only the
  // workflow's reviewed version is ever approved.
  for (const name of names) {
    let id = null;
    try {
      id = bootstrapStageId(npm(['stage', 'list', name, '--json'], { stdio: 'pipe' }));
    } catch (error) {
      console.log(`${name}: could not list stages (${lastLine(error)})`);
    }
    if (id) {
      console.log(`Rejecting the ${name}@${BOOTSTRAP_VERSION} placeholder stage`);
      npm(['stage', 'reject', id], { stdio: 'inherit' });
    }
  }
  console.table(results);
  const different = results.filter((row) => row.trust === 'different' || row.trust === 'unknown');
  if (different.length) {
    console.error(
      'These packages trust another repository, workflow or environment, or their trust could not be read.\n' +
        'npm allows one configuration per package:\n' +
        different
          .map((row) => `  ${row.name}: npm trust revoke ${row.name} --id <id from npm trust list>, then re-run`)
          .join('\n'),
    );
    process.exitCode = 1;
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'npm-cli': { type: 'string' },
      node: { type: 'string' },
      reviewer: { type: 'string' },
      'skip-github': { type: 'boolean', default: false },
      'skip-npm': { type: 'boolean', default: false },
    },
  });
  const names = publicPackages(root)
    .map((project) => project.manifest.name)
    .sort();
  if (!values['skip-npm']) {
    const node = npmNode(values.node);
    if (!node) {
      const message = `npm ${NPM_VERSION} needs Node 22.22.2 or later, and none is installed. Run fnm install 22.22.2 or pass --node <path>`;
      assert.ok(!values.apply, message);
      console.log(message + `; reading with ${process.version}.`);
    } else if (node !== process.execPath) console.log(`Running npm ${NPM_VERSION} with ${node}`);
    const nodeBin = node ?? process.execPath,
      cli = pinnedNpm(values['npm-cli'], nodeBin),
      npm = (args, options = {}) => run(nodeBin, [cli, ...args], options);
    let user = null;
    try {
      user = npm(['whoami'], { stdio: 'pipe' }).trim();
    } catch {}
    const exists = {};
    for (const name of names) exists[name] = await registryExists(name);
    // Reading trust needs 2FA, so only --apply reads it, after one interactive confirmation.
    const plan = npmSetupPlan(
      names,
      Object.fromEntries(names.map((name) => [name, { exists: exists[name], trust: 'read during --apply' }])),
    );
    console.table(
      plan.map(({ name, exists, trust, actions }) => ({ name, exists, trust, needs: actions.join(' + ') || '-' })),
    );
    console.log(
      user
        ? `npm: logged in as ${user}.`
        : 'npm: not logged in. Run `npm login` on an account with 2FA and write access to @inventarch.',
    );
    if (values.apply) {
      assert.ok(user, 'npm login is required to apply');
      applyNpm(npm, names, exists);
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
      console.table(issues.length ? issues : [{ setting: 'all', fix: 'none needed' }]);
      if (values.apply && issues.length) applyGithub(gh, issues, values.reviewer ?? codeOwner());
    }
    if (values.apply) assert.ok(state, 'GitHub settings could not be read; nothing was applied there');
  }
  if (!values.apply) console.log('\nRead-only. Re-run with --apply to make these changes.');
}
