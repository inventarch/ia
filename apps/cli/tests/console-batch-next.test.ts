/**
 * After a batch (console/batch-next.ts): the "next" choices, each a separate, explicit step. Committing the repositories
 * that passed (`chore: <offer title>`, nothing else), pushing and opening PRs through `gh` (offered only when it is found
 * and `gh auth status` exits 0), and removing the worktrees while keeping their branches; real git repositories with
 * bare origins and a fake `gh` on a PATH of its own.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { displayFix, iaFix } from '../src/fix.js';
import { resolveRepo } from '../src/console/app.js';
import type { Step } from '../src/console/offers.js';
import { planBatch } from '../src/console/batch-plan.js';
import type { RepoResult } from '../src/console/batch-run.js';
import { defaultRunner, gitTop, runBatch } from '../src/console/batch-run.js';
import { commitPassed, ghReady, nextChoices, pushAndOpenPrs, removeWorktrees } from '../src/console/batch-next.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import type { Fixture } from './batch-fixture.js';
import { fixture, git, offerOf, readLog, repo, rowOf, shim } from './batch-fixture.js';
import { cleanup } from './scratch-fixture.js';

afterAll(cleanup);

const FAKE_GH = resolve(import.meta.dirname, 'fake-gh.mjs');
const ia = (argv: readonly string[], writesTo: Step['writesTo'] = 'repo'): Step => iaFix(argv, writesTo).fix!;
const relock = (root: string) => offerOf('fix:generation', 'Re-lock', [ia(['restore', '--apply', '--root', root])]);
/** A fixture whose PATH also holds a fake `gh`. */
function withGh(prefix: string): Fixture {
  const fx = fixture(prefix);
  shim(fx.shims, 'gh', FAKE_GH);
  return { ...fx, env: { ...fx.env, FAKE_GH_LOG: join(fx.dir, 'gh.log') } };
}
async function batch(fx: Fixture, rows: readonly RepoRow[], offerId = 'fix:generation') {
  const plan = planBatch(
    offerId,
    rows,
    new Set(rows.keys()),
    { iaHome: join(fx.dir, 'home') },
    { top: (root) => gitTop(root, fx.env) },
  );
  const results = await runBatch(
    plan,
    { running: { packageRoot: fx.running, version: '3.5.1' } },
    { run: defaultRunner(fx.env), resolveRepo, progress: () => {}, signal: new AbortController().signal, env: fx.env },
  );
  // What a step would have changed in each worktree.
  for (const result of results) if (result.created) writeFileSync(join(result.worktree, 'changed.txt'), result.branch);
  return { plan, results };
}
const result = (extra: Partial<RepoResult>): RepoResult => ({
  root: '/srv/a',
  top: '/srv/a',
  worktree: '/srv/.ia-worktrees/a-x',
  workspace: '/srv/.ia-worktrees/a-x',
  branch: 'chore/ia-x',
  ok: true,
  last: '1 step passed',
  refused: null,
  created: true,
  ...extra,
});

describe('nextChoices', () => {
  it('PRs are offered only when gh auth status exits 0', async () => {
    const fx = withGh('batch-next-gh');
    const run = defaultRunner(fx.env);
    expect(await ghReady(run, fx.env)).toEqual({ found: true, authed: true });
    expect(await ghReady(run, { ...fx.env, FAKE_GH_AUTH: 'fail' })).toEqual({ found: true, authed: false });
    const bare = fixture('batch-next-nogh');
    const shimsOnly = { ...bare.env, PATH: bare.shims };
    expect(await ghReady(defaultRunner(shimsOnly), shimsOnly)).toEqual({ found: false, authed: false });
    const ids = (gh: { found: boolean; authed: boolean }) =>
      nextChoices([result({})], [], gh).map((choice) => choice.id);
    expect(ids({ found: true, authed: true })).toEqual(['commit', 'pr', 'remove']);
    expect(ids({ found: true, authed: false })).toEqual(['commit', 'remove']);
    expect(ids({ found: false, authed: false })).toEqual(['commit', 'remove']);
    expect(readLog<{ argv: string[] }>(join(fx.dir, 'gh.log')).map((call) => call.argv)).toEqual([
      ['auth', 'status'],
      ['auth', 'status'],
    ]);
  });
  it('a failed repo can be opened; nothing passed offers no commit', () => {
    const failed = result({ ok: false, last: 'npm install exited 1' });
    const refused = result({ ok: false, refused: 'origin has no HEAD, main or master', created: false });
    expect(nextChoices([failed, refused], [], { found: true, authed: true }).map((choice) => choice.id)).toEqual([
      'open',
      'remove',
    ]);
    expect(nextChoices([refused], [], { found: true, authed: true })).toEqual([]);
  });
  it('deferred steps appear once', () => {
    const roots = ['alpha', 'beta', 'gamma'].map((name) => resolve('/srv/repos', name));
    const host = ia(['host', 'claude', '--user', '--apply'], 'user');
    const upgrade = offerOf('upgrade', 'Upgrade CLI to 3.5.1', [
      {
        program: 'external',
        argv: ['npm', 'install', '-D', '@inventarch/cli@3.5.1'],
        flow: 'confirm',
        writesTo: 'repo',
      },
      host,
    ]);
    const plan = planBatch(
      'upgrade',
      roots.map((root) => rowOf(root, [upgrade])),
      new Set([0, 1, 2]),
      { iaHome: resolve('/srv/ia-home') },
      { top: (root) => root },
    );
    const choices = nextChoices(
      plan.repos.map((entry) => result({ root: entry.root })),
      [...plan.deferred, host],
      { found: false, authed: false },
    );
    const deferred = choices.filter((choice) => choice.id === 'deferred');
    expect(deferred).toEqual([{ id: 'deferred', title: `Run once on this machine: ${displayFix(host)}` }]);
  });
});

describe('after the run', () => {
  it('the commit message is chore: <title> and carries no trailer', async () => {
    const fx = fixture('batch-next-commit');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const committed = await commitPassed(results, 'Re-lock', defaultRunner(fx.env), fx.env);
    expect(committed[0]).toMatchObject({ ok: true, last: expect.stringMatching(/^committed [0-9a-f]{7,}$/) });
    const worktree = results[0]!.worktree;
    expect(git(worktree, ['log', '-1', '--format=%B'], fx.env)).toBe('chore: Re-lock\n\n');
    expect(git(worktree, ['status', '--porcelain'], fx.env)).toBe('');
    // Nothing was pushed: the branch still has no upstream and origin has no such branch.
    expect(() => git(top, ['rev-parse', '--abbrev-ref', `${results[0]!.branch}@{u}`], fx.env)).toThrow();
    expect(git(top, ['ls-remote', 'origin', results[0]!.branch], fx.env)).toBe('');
  });
  it('a push rejected for one repo is reported and the others continue', async () => {
    const fx = withGh('batch-next-push');
    const gone = repo(fx, 'gone');
    const kept = repo(fx, 'kept');
    const { results } = await batch(fx, [rowOf(gone.top, [relock(gone.top)]), rowOf(kept.top, [relock(kept.top)])]);
    const run = defaultRunner(fx.env);
    const committed = await commitPassed(results, 'Re-lock', run, fx.env);
    rmSync(gone.origin, { recursive: true, force: true });
    const opened = await pushAndOpenPrs(committed, run, fx.env);
    expect(opened).toEqual([
      { root: gone.top, url: null, error: expect.stringMatching(/.+/) },
      { root: kept.top, url: 'https://example.test/pull/chore/ia-fix-generation', error: null },
    ]);
    expect(git(kept.top, ['ls-remote', 'origin', 'chore/ia-fix-generation'], fx.env)).not.toBe('');
    const created = readLog<{ argv: string[]; cwd: string }>(join(fx.dir, 'gh.log'));
    expect(created).toEqual([
      { argv: ['pr', 'create', '--fill', '--head', 'chore/ia-fix-generation'], cwd: results[1]!.worktree },
    ]);
  });
  it('a branch that exists on the remote is reported per repo', async () => {
    const fx = withGh('batch-next-remote');
    const { top, origin } = repo(fx, 'taken');
    // Someone else pushed a branch of the same name, from another clone.
    const other = join(fx.dir, 'other');
    git(fx.dir, ['clone', '--quiet', origin, other], fx.env);
    git(other, ['checkout', '--quiet', '-b', 'chore/ia-fix-generation'], fx.env);
    writeFileSync(join(other, 'theirs.txt'), 'theirs');
    git(other, ['add', '-A'], fx.env);
    git(other, ['commit', '--quiet', '-m', 'theirs'], fx.env);
    git(other, ['push', '--quiet', 'origin', 'chore/ia-fix-generation'], fx.env);
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    expect(results[0]).toMatchObject({ ok: true, created: true });
    const run = defaultRunner(fx.env);
    const opened = await pushAndOpenPrs(await commitPassed(results, 'Re-lock', run, fx.env), run, fx.env);
    expect(opened).toEqual([
      { root: top, url: null, error: expect.stringMatching(/rejected|fetch first|non-fast-forward/) },
    ]);
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
  it('remove keeps the branch', async () => {
    const fx = fixture('batch-next-remove');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const run = defaultRunner(fx.env);
    await commitPassed(results, 'Re-lock', run, fx.env);
    const removed = await removeWorktrees(results, run, fx.env);
    expect(removed).toEqual([{ root: top, error: null }]);
    expect(existsSync(results[0]!.worktree)).toBe(false);
    expect(git(top, ['rev-parse', '--verify', 'refs/heads/chore/ia-fix-generation'], fx.env).trim()).not.toBe('');
    // An uncommitted worktree is not removed: its changes would be lost.
    const dirty = repo(fx, 'dirty');
    const second = await batch(fx, [rowOf(dirty.top, [relock(dirty.top)])]);
    mkdirSync(join(second.results[0]!.worktree, 'more'), { recursive: true });
    const kept = await removeWorktrees(second.results, run, fx.env);
    expect(kept).toEqual([{ root: dirty.top, error: expect.stringMatching(/.+/) }]);
    expect(existsSync(second.results[0]!.worktree)).toBe(true);
  });
});
