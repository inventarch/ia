/**
 * After a batch (consumer CLI contract §1.2): the "next" list, each entry a separate, explicit choice. Commit the
 * repositories that passed, as `chore: <offer title>` and nothing else, since the console commits in the user's own
 * repositories on their behalf; commit, push and open PRs, offered only when `gh` is found and `gh auth status` exits
 * 0; open a repository that failed; remove the worktrees, keeping their branches; and run, once, the user and machine
 * steps every repository's run left out. Nothing is pushed unless the user picks the PR choice.
 */
import { homedir } from 'node:os';
import { displayFix } from '../fix.js';
import type { Env } from '../program.js';
import type { RepoResult, Runner } from './batch-run.js';
import { batchEnv, checkPinned, programIn } from './batch-run.js';
import type { Step } from './offers.js';

export type NextId = 'commit' | 'pr' | 'open' | 'remove' | 'deferred';
export interface NextChoice {
  readonly id: NextId;
  readonly title: string;
}

/** The choices that apply to these results, in a fixed order; the deferred steps once, by their display text. */
export function nextChoices(
  results: readonly RepoResult[],
  deferred: readonly Step[],
  gh: { readonly found: boolean; readonly authed: boolean },
): readonly NextChoice[] {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.some((result) => !result.ok && result.created);
  const created = results.some((result) => result.created);
  const steps = [...new Set(deferred.map(displayFix))];
  const out: NextChoice[] = [];
  if (passed > 0)
    out.push({ id: 'commit', title: passed === 1 ? 'Commit the one that passed' : `Commit the ${passed} that passed` });
  if (passed > 0 && gh.found && gh.authed) out.push({ id: 'pr', title: 'Commit, push and open PRs' });
  if (failed) out.push({ id: 'open', title: 'Open a failed repo' });
  if (created) out.push({ id: 'remove', title: 'Remove the worktrees (the branches are kept)' });
  if (steps.length > 0) out.push({ id: 'deferred', title: `Run once on this machine: ${steps.join('; ')}` });
  return out;
}

/** The line of a program's output that says what went wrong: git's rejection or error before its hints, else the last. */
const lastLine = (text: string): string => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('hint:'));
  return lines.find((line) => /\[(?:remote )?rejected\]|^(?:error|fatal):/.test(line)) ?? lines.at(-1) ?? '';
};

/**
 * The program each repository's command runs, by the one rule (batch-run.ts `programIn`): found once, never one a
 * user's checkout holds, then run by its absolute path; or why it may not run.
 */
function programFor(name: string, env: Env, results: readonly RepoResult[]): { path: string } | { refused: string } {
  const found = programIn(
    name,
    env,
    results.map((result) => result.top),
  );
  return 'refused' in found ? { refused: found.refused } : { path: found.path };
}

/**
 * `git add -A` and `git commit -m "chore: <title>"` in each worktree that passed. A repository whose commit fails (or
 * has nothing to commit) is no longer ok, with the reason as its last line; one that commits says `committed <sha>`, and
 * one that already did is left as it is. A worktree that is no longer the folder the batch created is never touched.
 */
export async function commitPassed(
  results: readonly RepoResult[],
  title: string,
  run: Runner,
  given: Env = process.env,
): Promise<readonly RepoResult[]> {
  const out: RepoResult[] = [];
  // No git routing variable inherited by the console reaches these children.
  const env = batchEnv(given);
  const program = programFor('git', env, results);
  for (const result of results) {
    if (!result.ok || result.last.startsWith('committed ')) {
      out.push(result);
      continue;
    }
    const refused = 'refused' in program ? program.refused : checkPinned(result.worktree, result.pinned);
    if (refused !== null || 'refused' in program) {
      out.push({ ...result, ok: false, last: refused ?? 'git may not run' });
      continue;
    }
    const git = (args: readonly string[]) =>
      run(program.path, ['-C', result.worktree, ...args], { cwd: result.worktree, env });
    const added = await git(['add', '-A']);
    const replaced = checkPinned(result.worktree, result.pinned);
    const committed =
      replaced !== null
        ? { status: 1, stdout: '', stderr: replaced }
        : added.status === 0
          ? await git(['commit', '--quiet', '-m', `chore: ${title}`])
          : added;
    if (committed.status !== 0) {
      const why = lastLine(committed.stderr) || lastLine(committed.stdout) || 'git commit failed';
      out.push({ ...result, ok: false, last: why });
      continue;
    }
    const sha = await git(['rev-parse', '--short', 'HEAD']);
    out.push({ ...result, last: `committed ${sha.stdout.trim()}` });
  }
  return out;
}

/**
 * Creates the branch on origin, and only creates it: the lease's empty expected value requires the remote ref not to
 * exist, `--atomic` where the remote supports it (one that does not is asked again without it), and `--porcelain` says
 * what happened to the ref. Only a new ref (`*`) is a creation: a ref already up to date (`=`), one rejected (`!`), as
 * a branch already there is even when the push would only fast-forward it, or anything else is a collision.
 */
async function createBranch(
  git: string,
  worktree: string,
  branch: string,
  run: Runner,
  options: { readonly cwd: string; readonly env: Env },
): Promise<{ readonly created: boolean; readonly why: string }> {
  const ref = `refs/heads/${branch}`;
  const push = (atomic: boolean) =>
    run(
      git,
      [
        '-C',
        worktree,
        'push',
        '--porcelain',
        ...(atomic ? ['--atomic'] : []),
        `--force-with-lease=${ref}:`,
        '-u',
        'origin',
        `${branch}:${ref}`,
      ],
      options,
    );
  const first = await push(true);
  const pushed = first.status !== 0 && /does not support --atomic/.test(first.stderr) ? await push(false) : first;
  const line = pushed.stdout
    .split(/\r?\n/)
    .map((entry) => entry.split('\t'))
    .find((fields) => fields.length >= 3 && fields[1] === `${ref}:${ref}`);
  const flag = line?.[0] ?? '';
  if (pushed.status === 0 && flag === '*') return { created: true, why: '' };
  if (flag === '=' || flag === '!' || /\(stale info\)|already exists/.test(pushed.stderr))
    return { created: false, why: `the branch ${branch} already exists on origin` };
  return {
    created: false,
    why:
      line !== undefined
        ? `the branch ${branch} already exists on origin`
        : lastLine(pushed.stderr) || `git push exited ${pushed.status}`,
  };
}

/**
 * For each repository that passed (and committed): a create-only `git push -u origin <branch>:refs/heads/<branch>`,
 * then `gh pr create --fill --head <branch>`. A branch already on origin, at any commit, is reported as a collision and
 * no PR is opened; any failure is reported for that repository and the others continue. git and gh are both checked
 * before anything is pushed.
 */
export async function pushAndOpenPrs(
  results: readonly RepoResult[],
  run: Runner,
  given: Env = process.env,
): Promise<readonly { readonly root: string; readonly url: string | null; readonly error: string | null }[]> {
  const out: { root: string; url: string | null; error: string | null }[] = [];
  // No git routing variable inherited by the console reaches these children.
  const env = batchEnv(given);
  const git = programFor('git', env, results);
  const gh = programFor('gh', env, results);
  for (const result of results) {
    if (!result.ok) continue;
    const refused =
      'refused' in git ? git.refused : 'refused' in gh ? gh.refused : checkPinned(result.worktree, result.pinned);
    if (refused !== null || 'refused' in git || 'refused' in gh) {
      out.push({ root: result.root, url: null, error: refused ?? 'git or gh may not run' });
      continue;
    }
    const options = { cwd: result.worktree, env };
    const pushed = await createBranch(git.path, result.worktree, result.branch, run, options);
    if (!pushed.created) {
      out.push({ root: result.root, url: null, error: pushed.why });
      continue;
    }
    const opened = await run(gh.path, ['pr', 'create', '--fill', '--head', result.branch], options);
    if (opened.status !== 0) {
      out.push({
        root: result.root,
        url: null,
        error: lastLine(opened.stderr) || `gh pr create exited ${opened.status}`,
      });
      continue;
    }
    out.push({ root: result.root, url: lastLine(opened.stdout), error: null });
  }
  return out;
}

/**
 * `git worktree remove <path>` for each worktree the batch made; the branch is kept. Git refuses a worktree with
 * changes not committed, which is reported for that repository rather than forced; so is a worktree that is no longer
 * the folder the batch created.
 */
export async function removeWorktrees(
  results: readonly RepoResult[],
  run: Runner,
  given: Env = process.env,
): Promise<readonly { readonly root: string; readonly error: string | null }[]> {
  const out: { root: string; error: string | null }[] = [];
  // No git routing variable inherited by the console reaches these children.
  const env = batchEnv(given);
  const git = programFor('git', env, results);
  for (const result of results) {
    if (!result.created) continue;
    const refused = 'refused' in git ? git.refused : checkPinned(result.worktree, result.pinned);
    if (refused !== null || 'refused' in git) {
      out.push({ root: result.root, error: refused ?? 'git may not run' });
      continue;
    }
    const removed = await run(git.path, ['-C', result.top, 'worktree', 'remove', result.worktree], {
      cwd: result.top,
      env,
    });
    out.push({
      root: result.root,
      error: removed.status === 0 ? null : lastLine(removed.stderr) || `git worktree remove exited ${removed.status}`,
    });
  }
  return out;
}

/**
 * Whether `gh` may be used: found on a qualified PATH entry, not inside any of `checkouts`, and `gh auth status`
 * exits 0. A `gh` a checkout holds counts as not found, and never runs.
 */
export async function ghReady(
  run: Runner,
  given: Env,
  checkouts: readonly string[] = [],
): Promise<{ readonly found: boolean; readonly authed: boolean }> {
  const env = batchEnv(given);
  const found = programIn('gh', env, checkouts);
  if ('refused' in found) return { found: false, authed: false };
  const status = await run(found.path, ['auth', 'status'], { cwd: homedir(), env });
  return { found: true, authed: status.status === 0 };
}
