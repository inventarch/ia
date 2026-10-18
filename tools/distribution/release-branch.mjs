// @ts-check
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';

const branch = 'refs/heads/release/next';
const marker = 'IA-Release-Automation: v1';
const bot = '41898282+github-actions[bot]@users.noreply.github.com';
/** @param {string} root @param {string[]} args */
const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** Inspect the remote itself, then bind the fetched commit before examining its ownership. @param {string} root */
export function inspectReleaseBranch(root) {
  const remote = git(root, 'ls-remote', '--heads', 'origin', branch);
  if (!remote) return '';
  const expected = remote.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error('Invalid release branch commit');
  git(root, 'fetch', '--quiet', '--no-tags', 'origin', branch);
  if (git(root, 'rev-parse', 'FETCH_HEAD') !== expected) throw new Error('release/next changed during inspection');
  const commits = git(root, 'rev-list', `origin/main..${expected}`).split('\n').filter(Boolean);
  // A merged branch can be replaced. Otherwise only one commit generated on main is accepted.
  if (!commits.length) return expected;
  const head = commits[0] ?? '';
  const message = git(root, 'show', '-s', '--format=%B', head);
  const base = message.match(/^IA-Release-Base: ([a-f0-9]{40})$/m)?.[1];
  const parents = git(root, 'show', '-s', '--format=%P', head);
  const recognized =
    commits.length === 1 &&
    head === expected &&
    base === parents &&
    /^Release (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\n\n/.test(message) &&
    message.split('\n').includes(marker) &&
    git(root, 'show', '-s', '--format=%ae%n%ce', head) === `${bot}\n${bot}`;
  if (!recognized || !base)
    throw new Error('Refusing unrecognized release/next commits; preserve and reconcile maintainer amendments');
  git(root, 'merge-base', '--is-ancestor', base, 'origin/main');
  return expected;
}

/** Commit the already staged versioning outputs and replace only the inspected remote head. @param {string} root @param {string} version */
export function updateReleaseBranch(root, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Stable version required');
  const base = git(root, 'rev-parse', 'HEAD');
  if (base !== git(root, 'rev-parse', 'origin/main')) throw new Error('Release update must start at origin/main');
  const previous = inspectReleaseBranch(root);
  git(
    root,
    '-c',
    `user.name=github-actions[bot]`,
    '-c',
    `user.email=${bot}`,
    'commit',
    '--quiet',
    '--author',
    `github-actions[bot] <${bot}>`,
    '-m',
    `Release ${version}`,
    '-m',
    `${marker}\nIA-Release-Base: ${base}`,
  );
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', `--force-with-lease=${branch}:${previous}`, 'origin', `HEAD:${branch}`);
  return { head, previous };
}

/** @param {string} root */
export function deleteReleaseBranch(root) {
  const previous = inspectReleaseBranch(root);
  if (previous) git(root, 'push', `--force-with-lease=${branch}:${previous}`, 'origin', `:${branch}`);
  return { previous };
}

if (isEntry(process.argv[1], import.meta.url)) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { version: { type: 'string' } } });
    if (
      args.positionals.length !== 1 ||
      !['update', 'delete'].includes(args.positionals[0] ?? '') ||
      (args.positionals[0] === 'update' ? !args.values.version : args.values.version !== undefined)
    )
      throw new Error();
  } catch {
    console.error('Usage: release-branch.mjs update --version <stable-version> | delete');
    process.exitCode = 2;
  }
  if (args && !process.exitCode)
    try {
      console.log(
        JSON.stringify(
          args.positionals[0] === 'update'
            ? updateReleaseBranch(process.cwd(), args.values.version ?? '')
            : deleteReleaseBranch(process.cwd()),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
