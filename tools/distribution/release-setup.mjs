import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import {
  ENVIRONMENT,
  NPM_VERSION,
  REGISTRY,
  REPOSITORY,
  REPOSITORY_URL,
  WORKFLOW,
  registryPackage,
} from './npm-release.mjs';
import { compareVersions } from './release-changes.mjs';
import { publicPackages } from './release-packages.mjs';

/**
 * One-time account and repository setup for automated publication. The default run only reads; `--apply` makes the
 * account writes a maintainer would otherwise make by hand. npm requires a package to exist before a trusted
 * publisher can be configured. An owner-confirmed new name can be created by staging a placeholder prerelease
 * that is retained and never approved: the reviewed version is published by the workflow with OIDC and provenance.
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
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !nonempty(config.id) ||
    !nonempty(config.type) ||
    (config.permissions !== undefined && (!Array.isArray(config.permissions) || !config.permissions.every(nonempty))) ||
    (config.type === 'github' &&
      (!nonempty(config.repository) ||
        !nonempty(config.file) ||
        (config.environment !== undefined && typeof config.environment !== 'string')))
  )
    return { state: 'unknown' };
  const matches =
    config?.type === 'github' &&
    Array.isArray(config?.permissions) &&
    config.permissions.includes('createPackage') &&
    config.repository === REPOSITORY &&
    typeof config.file === 'string' &&
    [WORKFLOW, `.github/workflows/${WORKFLOW}`].includes(config.file) &&
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
export function npmSetupPlan(names, state, bootstrapNames = []) {
  for (const name of bootstrapNames) assert.ok(names.includes(name), `Unknown bootstrap package: ${name}`);
  return names.map((name) => {
    const current = state[name];
    const { access, metadata, public: published, stages, trust } = current;
    const existing =
      metadata === 'present' ||
      published === 'present' ||
      stages.items.length > 0 ||
      trust.state === 'configured' ||
      trust.state === 'different';
    const bootstrap =
      !existing &&
      access === 'not-found' &&
      metadata === 'not-found' &&
      published === 'not-found' &&
      stages.state === 'known' &&
      ['missing', 'not-found'].includes(trust.state);
    const blocked = [];
    if (
      access === 'unknown' ||
      metadata === 'unknown' ||
      published === 'unknown' ||
      stages.state === 'unknown' ||
      trust.state === 'unknown'
    )
      blocked.push('inspection failed; resolve authentication, permissions or registry errors before applying');
    if (trust.state === 'different')
      blocked.push('trusted publisher differs or lacks direct-publish permission; owner review required');
    if (access === 'non-public')
      blocked.push(
        existing
          ? 'package exists but is non-public; owner-authorized registry recovery required'
          : 'visibility is non-public; package existence remains unconfirmed',
      );
    if (existing && access === 'not-found')
      blocked.push('package evidence conflicts with authenticated 404; owner investigation required');
    if (existing && trust.state === 'not-found')
      blocked.push('trust returned 404 for an existing package; owner investigation required');
    if (existing && metadata === 'not-found')
      blocked.push('authenticated metadata returned 404 despite package evidence; owner investigation required');
    const candidates = stages.items.filter((stage) => stage.version === BOOTSTRAP_VERSION);
    if (candidates.length > 1 || candidates.some((stage) => stage.status !== 'staged'))
      blocked.push('bootstrap stage identity or status is ambiguous; owner review required');
    if (!existing && !bootstrap) blocked.push('package existence is unresolved');
    if (bootstrap && !bootstrapNames.includes(name))
      blocked.push(`404 does not prove absence; an owner must confirm a new name before --bootstrap-name ${name}`);
    const actions = blocked.length
      ? []
      : bootstrap
        ? ['bootstrap', 'trust']
        : trust.state === 'missing'
          ? ['trust']
          : [];
    return {
      name,
      ...current,
      existence: existing ? 'existing' : 'unconfirmed',
      actions,
      blocked,
      ready: !blocked.length && access === 'public' && published === 'present' && trust.state === 'configured',
    };
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
    issues.push({ setting: 'actions-create-pull-requests', fix: 'allow creation and approval of pull requests' });
  if (everyWorkflowDeclaresPermissions && state.workflow?.default_workflow_permissions !== 'read')
    issues.push({ setting: 'default-token-permissions', fix: 'read' });
  for (const name of rulesets)
    if (!state.rulesets.includes(name)) issues.push({ setting: 'ruleset:' + name, fix: 'create' });
  return issues;
}
/**
 * npm stage publish returns a package-keyed object with a stageId distinct from the package's name@version id.
 * Never select an arbitrary nested id or another package's stage.
 */
// npm 12.2.0 stage-list fixtures distinguish validating from staged (ready for owner review):
// https://github.com/npm/cli/blob/v12.2.0/test/lib/commands/stage/list.js
const STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function bootstrapStageId(listing, name) {
  try {
    const stage = JSON.parse(listing)?.[name];
    return stage?.name === name &&
      stage.id === `${name}@${BOOTSTRAP_VERSION}` &&
      stage.version === BOOTSTRAP_VERSION &&
      STAGE_ID.test(stage.stageId ?? '')
      ? stage.stageId
      : null;
  } catch {
    return null;
  }
}
export function stageState(listing, name) {
  try {
    const items = JSON.parse(listing);
    assert.ok(Array.isArray(items));
    for (const item of items) {
      assert.equal(item.packageName, name);
      assert.match(item.id, STAGE_ID);
      assert.equal(typeof item.version, 'string');
      assert.equal(typeof item.status, 'string');
    }
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    return { state: 'known', items };
  } catch {
    return { state: 'unknown', items: [] };
  }
}
export function accessState(listing, name) {
  try {
    const value = JSON.parse(listing);
    if (Object.keys(value).length !== 1 || !['public', 'private'].includes(value[name])) return 'unknown';
    return value[name] === 'private' ? 'non-public' : 'public';
  } catch {
    return 'unknown';
  }
}
// Keep diagnostics to error codes: npm errors can include credentials or sensitive response bodies.
const errorCode = (error) =>
  failure(error).match(
    /\bE(?:404|401|403|429|500|502|503|504|OTP|NOTTY|AUTHFAILED|AUTHRESULT|CANCELED|NPMVERSION|NPMCLI|NOTFOUND|CONNRESET|CONNREFUSED|TIMEDOUT|USAGE|METADATARESULT|METADATAFAILED)\b/,
  )?.[0] ?? 'read failed';
const AUTH_RECOVERY =
  'Run pnpm npm:setup --interactive-auth --skip-github in a terminal with stdin and stdout attached. ' +
  `It uses pinned npm ${NPM_VERSION}; PATH npm may not support trust. Do not pipe or redirect the run, pass OTPs as arguments, or repeat --apply.`;

/** Accept only a completed helper result from its dedicated channel, never terminal output or an exit code alone. */
export function interactiveTrustResult(result) {
  let response;
  try {
    response = JSON.parse(String(result.output?.[3] ?? ''));
  } catch {}
  if (result.error || result.signal || result.status !== 0 || response?.ok !== true) {
    const code = ['EOTP', 'E401', 'E403', 'E404', 'ENOTTY', 'ECANCELED', 'ENPMVERSION'].includes(response?.code)
      ? response.code
      : 'EAUTHFAILED';
    throw new Error(code + ': interactive trust inspection did not complete; readiness remains unverified');
  }
  if (typeof response.listing !== 'string') throw new Error('EAUTHRESULT: no structured trust result');
  return response.listing;
}

/** Recover only the failed read itself. npm's request-scoped OTP cannot authenticate a later piped process. */
export function npmWithInteractiveAuth(
  npm,
  recoverTrust,
  {
    enabled = false,
    stdinIsTTY = Boolean(process.stdin.isTTY),
    stdoutIsTTY = Boolean(process.stdout.isTTY),
    log = console.error,
  } = {},
) {
  assert.ok(!enabled || (stdinIsTTY && stdoutIsTTY), 'ENOTTY: ' + AUTH_RECOVERY);
  let recoveryFailed = false;
  return (args, options) => {
    try {
      return npm(args, options);
    } catch (error) {
      const trustRead = args.length === 4 && args[0] === 'trust' && args[1] === 'list' && args[3] === '--json';
      if (!enabled || !trustRead || errorCode(error) !== 'EOTP') throw error;
      if (recoveryFailed) throw new Error('EAUTHFAILED: earlier interactive inspection failed; no further prompts');
      assert.match(args[2], NAME, 'Unexpected package name');
      log(args[2] + ': npm requires 2FA for this read; complete or cancel the terminal challenge.');
      try {
        return recoverTrust(args[2]);
      } catch (error) {
        recoveryFailed = true;
        throw new Error(errorCode(error) + ': interactive trust inspection failed; no further prompts this run');
      }
    }
  };
}
export async function inspectNpm(npm, names, readPublic = registryPackage, readMetadata = () => '') {
  const state = {};
  for (const name of names) {
    const errors = [];
    const read = (args, parse, absent) => {
      try {
        return parse(npm(args, { stdio: 'pipe' }));
      } catch (error) {
        const code = errorCode(error);
        errors.push(`${args.slice(0, 2).join(' ')}: ${code}${code === 'EOTP' ? '; ' + AUTH_RECOVERY : ''}`);
        return code === 'E404' && absent !== undefined ? absent : undefined;
      }
    };
    const access =
      read(['access', 'get', 'status', name, '--json'], (text) => accessState(text, name), 'not-found') ?? 'unknown';
    let metadata = 'unknown';
    try {
      const result = JSON.parse(await readMetadata(name));
      if (result?.ok === true && result.name === name) metadata = 'present';
      else if (result?.ok === false && typeof result.code === 'string') {
        const code = errorCode(new Error(result.code));
        if (code === result.code) {
          if (code === 'E404') metadata = 'not-found';
          errors.push('authenticated metadata: ' + code);
        } else errors.push('authenticated metadata: malformed response');
      } else errors.push('authenticated metadata: malformed response');
    } catch (error) {
      errors.push('authenticated metadata: ' + errorCode(error));
    }
    const stages = read(['stage', 'list', name, '--json'], (text) => stageState(text, name)) ?? {
      state: 'unknown',
      items: [],
    };
    const trust = read(['trust', 'list', name, '--json'], trustState, { state: 'not-found' }) ?? { state: 'unknown' };
    let published = 'unknown';
    try {
      const remote = await readPublic(name);
      if (remote === null) published = 'not-found';
      else if (
        remote?.name === name &&
        remote.versions &&
        typeof remote.versions === 'object' &&
        !Array.isArray(remote.versions)
      )
        published = 'present';
    } catch (error) {
      errors.push(`public metadata: ${error.status ?? errorCode(error)}`);
    }
    state[name] = { access, metadata, stages, trust, public: published, errors };
  }
  return state;
}

// ---- I/O -------------------------------------------------------------------------------------------------------

const root = resolve(import.meta.dirname, '../..');
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
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
export function pinnedNpm(
  override,
  node,
  {
    install = (prefix) =>
      run(
        process.execPath,
        [
          bundledNpm(),
          'install',
          '--prefix',
          prefix,
          '--no-save',
          '--package-lock=false',
          '--ignore-scripts',
          '--registry',
          REGISTRY,
          `npm@${NPM_VERSION}`,
        ],
        { timeout: 5 * 60_000 },
      ),
  } = {},
) {
  const parent = realpathSync(tmpdir());
  // Fresh mkdtemp directories are private on POSIX. Never execute a pre-existing shared cache.
  const prefix = override ? null : mkdtempSync(resolve(parent, `ia-npm-cli-${NPM_VERSION}-`));
  const cli = override ? realpathSync(resolve(override)) : resolve(prefix, 'node_modules/npm/bin/npm-cli.js');
  const dispose = () => {
    if (prefix) {
      assert.equal(dirname(prefix), parent, 'Unsafe npm installation cleanup');
      rmSync(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
  try {
    if (prefix) install(prefix);
    const inspect = (path, recursive = true) => {
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Aliased npm installation refused');
      assert.ok(stat.isFile() || stat.isDirectory(), 'Unexpected npm installation entry');
      if (prefix && process.platform !== 'win32') {
        assert.equal(stat.uid, process.getuid(), 'Foreign npm installation owner');
        assert.equal(stat.mode & 0o022, 0, 'Writable npm installation refused');
      }
      if (recursive && stat.isDirectory()) for (const name of readdirSync(path)) inspect(resolve(path, name));
    };
    if (prefix) {
      inspect(prefix, false);
      inspect(resolve(prefix, 'node_modules'), false);
    }
    inspect(resolve(cli, '../..'));
    const manifest = JSON.parse(readFileSync(resolve(cli, '../../package.json'), 'utf8'));
    assert.equal(manifest.name, 'npm', 'Expected an npm installation');
    assert.equal(manifest.version, NPM_VERSION, 'Pinned npm package version differs');
    assert.equal(realpathSync(cli), cli, 'Aliased npm entry refused');
    const version = run(node, [cli, '--version'], { timeout: 30_000 }).trim();
    assert.equal(version, NPM_VERSION, `Expected npm ${NPM_VERSION}, found ${version}`);
    return { cli, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
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
      console.log(
        `Actions may create and approve pull requests; default workflow token: ${next.default_workflow_permissions}`,
      );
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

/** Setup writes are explicit, preserve stages, and succeed only after a fresh complete inspection. */
export async function applyNpm(
  npm,
  names,
  { bootstrapNames = [], readPublic = registryPackage, readMetadata, log = console.log } = {},
) {
  const plan = npmSetupPlan(names, await inspectNpm(npm, names, readPublic, readMetadata), bootstrapNames);
  const blockers = plan.flatMap((row) => row.blocked.map((reason) => row.name + ': ' + reason));
  assert.equal(blockers.length, 0, blockers.join('\n'));
  const retained = new Map();
  for (const row of plan) {
    for (const stage of row.stages.items.filter((stage) => stage.version === BOOTSTRAP_VERSION)) {
      retained.set(row.name, stage.id);
      log(row.name + '@' + BOOTSTRAP_VERSION + ': retaining bootstrap stage ' + stage.id + '; never approve it');
    }
    if (row.actions.includes('bootstrap')) {
      const scratch = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
      try {
        writeFileSync(resolve(scratch, 'package.json'), JSON.stringify(bootstrapManifest(row.name), null, 2) + '\n');
        writeFileSync(resolve(scratch, 'README.md'), '# ' + row.name + '\n\nNever approve this setup placeholder.\n');
        let listing;
        try {
          listing = npm(
            ['stage', 'publish', scratch, '--access', 'public', '--tag', BOOTSTRAP_TAG, '--ignore-scripts', '--json'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
        } catch (error) {
          throw new Error(
            row.name + ': staging outcome is uncertain (' + errorCode(error) + '); inspect stages before retrying',
          );
        }
        const id = bootstrapStageId(listing, row.name);
        assert.ok(id, row.name + ': staging returned no exact bootstrap identity; inspect stages before retrying');
        retained.set(row.name, id);
        log(row.name + '@' + BOOTSTRAP_VERSION + ': retaining bootstrap stage ' + id + '; never approve it');
        const confirmed = await inspectNpm(npm, [row.name], readPublic, readMetadata);
        const stage = confirmed[row.name].stages.items.find((item) => item.id === id);
        assert.ok(
          stage?.version === BOOTSTRAP_VERSION && stage.status === 'staged',
          row.name + ': stage ' + id + ' was not confirmed staged; retained for owner investigation',
        );
        const checked = npmSetupPlan([row.name], confirmed)[0];
        assert.equal(checked.blocked.length, 0, row.name + ': ' + checked.blocked.join('; '));
        row.actions = checked.actions;
      } finally {
        assert.ok(scratch.startsWith(resolve(realpathSync(tmpdir()), 'ia-npm-bootstrap-')));
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (row.actions.includes('trust')) {
      try {
        npm(trustArgs(row.name), { stdio: 'pipe' });
      } catch (error) {
        throw new Error(
          row.name +
            ': trust write was not confirmed (' +
            errorCode(error) +
            '); inspect before retrying; stages retained',
        );
      }
    }
  }
  const final = npmSetupPlan(names, await inspectNpm(npm, names, readPublic, readMetadata));
  for (const row of final) {
    const id = retained.get(row.name);
    if (
      id &&
      !row.stages.items.some(
        (stage) => stage.id === id && stage.version === BOOTSTRAP_VERSION && stage.status === 'staged',
      )
    )
      row.blocked.push('retained bootstrap stage ' + id + ' changed or disappeared; owner investigation required');
  }
  reportNpm(final);
  assert.ok(
    final.every((row) => row.ready && !row.blocked.length),
    'npm setup is not ready: public metadata, public visibility, direct-publish trust and retained stages must all be confirmed. ' +
      'No bootstrap stage was approved or rejected. See tools/distribution/NPM-PUBLISHING.md for owner recovery.',
  );
  log('npm setup readiness verified; publication still requires its independent preflight and OIDC authorization.');
  return final;
}
function reportNpm(plan) {
  console.table(
    plan.map((row) => ({
      name: row.name,
      existence: row.existence,
      access: row.access,
      metadata: row.metadata,
      public: row.public,
      trust: row.trust.state,
      stages:
        row.stages.items.map((stage) => `${stage.version}: ${stage.id} (${stage.status})`).join(', ') ||
        row.stages.state,
      ready: row.ready && !row.blocked.length,
      needs: row.actions.join(' + ') || '-',
    })),
  );
  for (const row of plan) {
    for (const reason of [...row.blocked, ...row.errors]) console.error(row.name + ': ' + reason);
    if (!row.ready && !row.blocked.length)
      console.error(
        row.name + ': public readiness not verified; inspect again after propagation or request owner recovery',
      );
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'interactive-auth': { type: 'boolean', default: false },
      'bootstrap-name': { type: 'string', multiple: true, default: [] },
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
    const nodeBin = node ?? process.execPath;
    const prepared = pinnedNpm(values['npm-cli'], nodeBin);
    try {
      const cli = prepared.cli,
        npm = npmWithInteractiveAuth(
          (args, options = {}) => run(nodeBin, [cli, ...args, '--registry', REGISTRY], options),
          (name) =>
            interactiveTrustResult(
              spawnSync(nodeBin, [resolve(import.meta.dirname, 'release-setup-auth.mjs'), cli, name], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
                windowsHide: true,
                timeout: 5 * 60 * 1000,
                maxBuffer: 1024 * 1024,
              }),
            ),
          { enabled: values['interactive-auth'] },
        );
      const readMetadata = (name) =>
        run(nodeBin, [resolve(import.meta.dirname, 'release-setup-metadata.mjs'), cli, name], {
          stdio: 'pipe',
          timeout: 40_000,
          maxBuffer: 1024 * 1024,
        });
      let user = null;
      try {
        user = npm(['whoami'], { stdio: 'pipe' }).trim();
      } catch {}
      const state = await inspectNpm(npm, names, registryPackage, readMetadata);
      const plan = npmSetupPlan(names, state, values['bootstrap-name']);
      reportNpm(plan);
      console.log(
        user
          ? 'npm: logged in as ' + user + '.'
          : 'npm: authentication unavailable; owner login required before setup.',
      );
      if (values.apply) {
        assert.ok(user, 'npm login is required to apply');
        await applyNpm(npm, names, { bootstrapNames: values['bootstrap-name'], readMetadata });
      } else if (!user || !plan.every((row) => row.ready)) process.exitCode = 1;
    } finally {
      prepared.dispose();
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
  if (!values.apply) console.log('\nRead-only. Resolve inspection blockers before any owner-authorized --apply.');
}
