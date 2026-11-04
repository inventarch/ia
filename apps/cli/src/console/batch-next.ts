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
import { findProgram } from '../program.js';
import type { RepoResult, Runner } from './batch-run.js';
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
 * `git add -A` and `git commit -m "chore: <title>"` in each worktree that passed. A repository whose commit fails (or
 * has nothing to commit) is no longer ok, with the reason as its last line; one that commits says `committed <sha>`.
 */
export async function commitPassed(
  results: readonly RepoResult[],
  title: string,
  run: Runner,
  env: Env = process.env,
): Promise<readonly RepoResult[]> {
  const out: RepoResult[] = [];
  for (const result of results) {
    if (!result.ok) {
      out.push(result);
      continue;
    }
    const git = (args: readonly string[]) =>
      run('git', ['-C', result.worktree, ...args], { cwd: result.worktree, env });
    const added = await git(['add', '-A']);
    const committed = added.status === 0 ? await git(['commit', '--quiet', '-m', `chore: ${title}`]) : added;
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
 * For each repository that passed (and committed): `git push -u origin <branch>`, then `gh pr create --fill --head
 * <branch>`. A failure is reported for that repository and the others continue.
 */
export async function pushAndOpenPrs(
  results: readonly RepoResult[],
  run: Runner,
  env: Env = process.env,
): Promise<readonly { readonly root: string; readonly url: string | null; readonly error: string | null }[]> {
  const out: { root: string; url: string | null; error: string | null }[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    const options = { cwd: result.worktree, env };
    const pushed = await run('git', ['-C', result.worktree, 'push', '-u', 'origin', result.branch], options);
    if (pushed.status !== 0) {
      out.push({ root: result.root, url: null, error: lastLine(pushed.stderr) || `git push exited ${pushed.status}` });
      continue;
    }
    const opened = await run('gh', ['pr', 'create', '--fill', '--head', result.branch], options);
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
 * changes not committed, which is reported for that repository rather than forced.
 */
export async function removeWorktrees(
  results: readonly RepoResult[],
  run: Runner,
  env: Env = process.env,
): Promise<readonly { readonly root: string; readonly error: string | null }[]> {
  const out: { root: string; error: string | null }[] = [];
  for (const result of results) {
    if (!result.created) continue;
    const removed = await run('git', ['-C', result.top, 'worktree', 'remove', result.worktree], {
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

/** Whether `gh` is on a qualified PATH entry, and whether `gh auth status` exits 0. */
export async function ghReady(run: Runner, env: Env): Promise<{ readonly found: boolean; readonly authed: boolean }> {
  const found = findProgram('gh', env, 'program') ?? findProgram('gh', env, 'script');
  if (found === null) return { found: false, authed: false };
  const status = await run('gh', ['auth', 'status'], { cwd: homedir(), env });
  return { found: true, authed: status.status === 0 };
}
