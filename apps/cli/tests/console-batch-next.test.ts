/**
 * After a batch (console/batch-next.ts): the "next" choices, each a separate, explicit step. Committing the repositories
 * that passed (`chore: <offer title>`, nothing else), pushing and opening PRs through `gh` (offered only when it is found
 * and `gh auth status` exits 0), and removing the worktrees while keeping their branches; real git repositories with
 * bare origins and a fake `gh` on a PATH of its own.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { displayFix, iaFix } from '../src/fix.js';
import { resolveRepo } from '../src/console/app.js';
import type { Step } from '../src/console/offers.js';
import { planBatch } from '../src/console/batch-plan.js';
import type { RepoResult, Runner } from '../src/console/batch-run.js';
import { defaultRunner, gitTop, METADATA_OPS, runBatch } from '../src/console/batch-run.js';
import { commitPassed, ghReady, nextChoices, pushAndOpenPrs, removeWorktrees } from '../src/console/batch-next.js';
import { batchScreen, previewLines } from '../src/console/batch-screen.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import type { Fixture } from './batch-fixture.js';
import { fixture, git, offerOf, plant, readLog, recorder, repo, rowOf, shim } from './batch-fixture.js';
import { cleanup } from './scratch-fixture.js';

// Every case here drives real git repositories, worktrees and installs; on a loaded machine one takes far over the default.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
    {
      run: defaultRunner(fx.env),
      resolveRepo: (root: string) => resolveRepo(root, fx.env, fx.running),
      progress: () => {},
      signal: new AbortController().signal,
      env: fx.env,
    },
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

describe('the preview', () => {
  const preview = () => {
    const root = resolve('/srv/repos/alpha');
    const plan = planBatch(
      'fix:generation',
      [rowOf(root, [relock(root)]), rowOf(resolve('/srv/repos/beta'), [relock(resolve('/srv/repos/beta'))])],
      new Set([0, 1]),
      { iaHome: resolve('/srv/ia-home') },
      { top: (path) => (path.endsWith('beta') ? null : path) },
    );
    return previewLines({ choice: { offerId: 'fix:generation', title: 'Re-lock', repos: 2 }, ...plan });
  };
  it('lists the install before the steps, with its flags, since what it writes is committed with them', () => {
    const lines = preview();
    const install = lines.indexOf(
      "  install  the package manager's install, first, where the worktree holds a package.json",
    );
    expect(install).toBeGreaterThan(lines.indexOf('  branch   chore/ia-fix-generation'));
    expect(lines[install + 1]).toMatch(/^ {2}1\. ia restore --apply/);
    // Once, for every repository: no lifecycle script, frozen to a tracked lockfile.
    expect(lines.filter((line) => line.startsWith('  install  '))).toHaveLength(1);
    // The base is named, before the install, and the preview says the offers came from the local checkout instead.
    const base = lines.indexOf(
      "  base     origin's default branch after git fetch origin (origin/HEAD, else origin/main, else origin/master)",
    );
    expect(base).toBe(install - 1);
    expect(lines).toContain(
      'The offers were read from each local checkout, but each worktree starts from that base: a change the checkout has and the base lacks is not in it, and a repository whose workspace the base does not hold is refused.',
    );
    expect(lines).toContain(
      'The install runs no lifecycle script and, for pnpm, no pnpmfile hook (Yarn 2 and later yarnPath and plugins, and .npmrc settings, still apply) and, where git tracks the lockfile, is frozen to it: npm ci --ignore-scripts, pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile, yarn install --frozen-lockfile --ignore-scripts (Yarn 2 and later: --immutable --mode=skip-build) or bun install --frozen-lockfile --ignore-scripts. A step listed under it may still run scripts: a package-manager step such as npm install -D runs as shown. A commit afterwards holds what it and the steps write.',
    );
  });
});

describe('the preview of an offer whose first step is the install', () => {
  it('says the first step installs, and lists no batch install', () => {
    const root = resolve('/srv/repos/alpha');
    const offer = offerOf('fix:cli-version', 'Install', [
      { program: 'external', argv: ['npm', 'install'], flow: 'confirm', writesTo: 'repo' },
    ]);
    const plan = planBatch(
      'fix:cli-version',
      [rowOf(root, [offer])],
      new Set([0]),
      { iaHome: resolve('/srv/ia-home') },
      { top: (path) => path },
    );
    const lines = previewLines({ choice: { offerId: 'fix:cli-version', title: 'Install', repos: 1 }, ...plan });
    expect(lines).toContain("  install  by the first step, the package manager's own install");
    expect(lines.filter((line) => line.startsWith('  install  '))).toHaveLength(1);
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
      {
        argv: ['pr', 'create', '--fill', '--head', 'chore/ia-fix-generation', '--base', 'main'],
        cwd: results[1]!.worktree,
      },
    ]);
  });
  it('the PR is opened against the branch the worktree was made from, origin/master included', async () => {
    const fx = withGh('batch-next-base');
    const { top } = repo(fx, 'old', {}, 'master');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    expect(results[0]).toMatchObject({ ok: true, base: 'origin/master' });
    const run = defaultRunner(fx.env);
    const opened = await pushAndOpenPrs(await commitPassed(results, 'Re-lock', run, fx.env), run, fx.env);
    expect(opened).toEqual([{ root: top, url: 'https://example.test/pull/chore/ia-fix-generation', error: null }]);
    expect(readLog<{ argv: string[] }>(join(fx.dir, 'gh.log')).map((call) => call.argv)).toEqual([
      ['pr', 'create', '--fill', '--head', 'chore/ia-fix-generation', '--base', 'master'],
    ]);
    // A result that does not say its base gets no PR, and nothing is pushed for it.
    const { base: _base, ...rest } = results[0]!;
    const unknown = { ...rest, branch: 'chore/ia-other' };
    expect(await pushAndOpenPrs([unknown], run, fx.env)).toEqual([
      { root: top, url: null, error: 'the branch the worktree was made from is not known, so no PR is opened' },
    ]);
    expect(git(top, ['ls-remote', 'origin', 'chore/ia-other'], fx.env)).toBe('');
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
      { root: top, url: null, error: 'the branch chore/ia-fix-generation already exists on origin' },
    ]);
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
  it('a remote branch at the base commit is a collision too, and stays where it was', async () => {
    const fx = withGh('batch-next-ancestor');
    const { top } = repo(fx, 'behind');
    // The remote already has the batch's branch, at the commit the batch will start from: a plain push would fast-forward it.
    git(top, ['push', '--quiet', 'origin', 'main:refs/heads/chore/ia-fix-generation'], fx.env);
    const before = git(top, ['ls-remote', 'origin', 'refs/heads/chore/ia-fix-generation'], fx.env);
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const run = defaultRunner(fx.env);
    const opened = await pushAndOpenPrs(await commitPassed(results, 'Re-lock', run, fx.env), run, fx.env);
    expect(opened).toEqual([
      { root: top, url: null, error: 'the branch chore/ia-fix-generation already exists on origin' },
    ]);
    expect(git(top, ['ls-remote', 'origin', 'refs/heads/chore/ia-fix-generation'], fx.env)).toBe(before);
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
  it('remove keeps the branch', async () => {
    const fx = fixture('batch-next-remove');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const run = defaultRunner(fx.env);
    await commitPassed(results, 'Re-lock', run, fx.env);
    const recorded = recorder(run);
    const removed = await removeWorktrees(results, recorded.run, fx.env);
    expect(removed).toEqual([{ root: top, error: null }]);
    // The removal names the checkout, so it is one of the listed metadata operations.
    for (const call of recorded.calls) {
      expect(call.args.slice(0, 2)).toEqual(['-C', top]);
      const op = call.args.slice(2).join(' ');
      expect(METADATA_OPS.some((allowed) => op.startsWith(`${allowed} `))).toBe(true);
    }
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

describe('after the run, guarded', () => {
  it('a remote branch already at the batch commit is a collision, and no PR opens', async () => {
    const fx = withGh('batch-next-same-tip');
    const { top } = repo(fx, 'same');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const run = defaultRunner(fx.env);
    const committed = await commitPassed(results, 'Re-lock', run, fx.env);
    // Someone already pushed this very commit under the batch's branch name.
    git(committed[0]!.worktree, ['push', '--quiet', 'origin', 'HEAD:refs/heads/chore/ia-fix-generation'], fx.env);
    const before = git(top, ['ls-remote', 'origin', 'refs/heads/chore/ia-fix-generation'], fx.env);
    const opened = await pushAndOpenPrs(committed, run, fx.env);
    expect(opened).toEqual([
      { root: top, url: null, error: 'the branch chore/ia-fix-generation already exists on origin' },
    ]);
    expect(git(top, ['ls-remote', 'origin', 'refs/heads/chore/ia-fix-generation'], fx.env)).toBe(before);
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
  it('a worktree replaced by a link to the checkout after the run is never committed in', async () => {
    const fx = withGh('batch-next-replaced');
    const { top } = repo(fx, 'swapped');
    const head = git(top, ['rev-parse', 'HEAD'], fx.env);
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const worktree = results[0]!.worktree;
    renameSync(worktree, `${worktree}-moved`);
    symlinkSync(top, worktree, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(top, 'bait.txt'), 'bait');
    const run = defaultRunner(fx.env);
    const committed = await commitPassed(results, 'Re-lock', run, fx.env);
    expect(committed[0]).toMatchObject({
      ok: false,
      last: expect.stringMatching(/^the worktree .* was replaced or moved/),
    });
    expect(git(top, ['rev-parse', 'HEAD'], fx.env)).toBe(head);
    expect(git(top, ['status', '--porcelain'], fx.env)).toBe('?? bait.txt\n');
    expect(await pushAndOpenPrs(results, run, fx.env)).toEqual([
      { root: top, url: null, error: expect.stringMatching(/^the worktree .* was replaced or moved/) },
    ]);
    expect(await removeWorktrees(results, run, fx.env)).toEqual([
      { root: top, error: expect.stringMatching(/^the worktree .* was replaced or moved/) },
    ]);
    expect(existsSync(join(top, 'bait.txt'))).toBe(true);
  });
  it('a git or gh planted inside the checkout, first on PATH, is never run', async () => {
    const fx = withGh('batch-next-planted');
    const { top } = repo(fx, 'planted');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const planted = join(top, 'tools-bin');
    mkdirSync(planted, { recursive: true });
    plant(planted, 'git');
    plant(planted, 'gh');
    const log = join(fx.dir, 'planted.log');
    const env = { ...fx.env, PATH: [planted, fx.env['PATH']].join(delimiter), FAKE_GIT_LOG: log };
    const run = defaultRunner(env);
    expect(await ghReady(run, env, [top])).toEqual({ found: false, authed: false });
    const committed = await commitPassed(results, 'Re-lock', run, env);
    expect(committed[0]).toMatchObject({
      ok: false,
      last: expect.stringMatching(/^git resolves to .*, inside the repository$/),
    });
    expect(await pushAndOpenPrs(results, run, env)).toEqual([
      { root: top, url: null, error: expect.stringMatching(/^git resolves to .*, inside the repository$/) },
    ]);
    expect(await removeWorktrees(results, run, env)).toEqual([
      { root: top, error: expect.stringMatching(/^git resolves to .*, inside the repository$/) },
    ]);
    // With git clean again, a gh planted in the checkout still never runs.
    const ghEnv = {
      ...fx.env,
      PATH: [planted.replace('tools-bin', 'tools-gh'), fx.env['PATH']].join(delimiter),
      FAKE_GIT_LOG: log,
    };
    mkdirSync(join(top, 'tools-gh'), { recursive: true });
    plant(join(top, 'tools-gh'), 'gh');
    const pushed = await pushAndOpenPrs(
      await commitPassed(results, 'Re-lock', defaultRunner(ghEnv), ghEnv),
      defaultRunner(ghEnv),
      ghEnv,
    );
    expect(pushed).toEqual([
      { root: top, url: null, error: expect.stringMatching(/^gh resolves to .*, inside the repository$/) },
    ]);
    expect(readLog(log)).toEqual([]);
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
});

describe('Ctrl-C after the run', () => {
  const stopped = (): AbortSignal => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };
  it('an aborted controller before the commit runs no git at all, and nothing is committed', async () => {
    const fx = fixture('batch-next-stop-commit');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const head = git(results[0]!.worktree, ['rev-parse', 'HEAD'], fx.env);
    const recorded = recorder(defaultRunner(fx.env));
    const committed = await commitPassed(results, 'Re-lock', recorded.run, fx.env, stopped());
    expect(recorded.calls).toEqual([]);
    expect(committed[0]).toMatchObject({ ok: true, last: 'not committed: stopped' });
    expect(git(results[0]!.worktree, ['rev-parse', 'HEAD'], fx.env)).toBe(head);
    // Not committed, so a later choice commits it.
    const again = await commitPassed(committed, 'Re-lock', defaultRunner(fx.env), fx.env);
    expect(again[0]!.last).toMatch(/^committed [0-9a-f]{7,}$/);
  });
  it('aborted between the commit and the push: nothing is pushed, no PR opens, and no git or gh runs', async () => {
    const fx = withGh('batch-next-stop-push');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const committed = await commitPassed(results, 'Re-lock', defaultRunner(fx.env), fx.env);
    const recorded = recorder(defaultRunner(fx.env));
    expect(await pushAndOpenPrs(committed, recorded.run, fx.env, stopped())).toEqual([
      { root: top, url: null, error: 'not pushed: stopped' },
    ]);
    expect(recorded.calls).toEqual([]);
    expect(git(top, ['ls-remote', 'origin', 'chore/ia-fix-generation'], fx.env)).toBe('');
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
  it('aborted during the first push: that one opens no PR, and no later repository is pushed or opened', async () => {
    const fx = withGh('batch-next-stop-mid');
    const tops = ['alpha', 'beta', 'gamma'].map((name) => repo(fx, name).top);
    const { results } = await batch(
      fx,
      tops.map((top) => rowOf(top, [relock(top)])),
    );
    const committed = await commitPassed(results, 'Re-lock', defaultRunner(fx.env), fx.env);
    const controller = new AbortController();
    const real = defaultRunner(fx.env);
    // Ctrl-C while the first push runs: the push itself finishes, then the controller is aborted.
    const recorded = recorder(async (file, args, options) => {
      const settled = await real(file, args, options);
      if (args.includes('push')) controller.abort();
      return settled;
    });
    const opened = await pushAndOpenPrs(committed, recorded.run, fx.env, controller.signal);
    expect(opened).toEqual([
      { root: tops[0], url: null, error: 'pushed, but stopped before the PR was opened' },
      { root: tops[1], url: null, error: 'not pushed: stopped' },
      { root: tops[2], url: null, error: 'not pushed: stopped' },
    ]);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]!.args).toContain('push');
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
    for (const top of tops.slice(1))
      expect(git(top, ['ls-remote', 'origin', 'chore/ia-fix-generation'], fx.env)).toBe('');
  });
  it('an aborted controller before the removal removes nothing', async () => {
    const fx = fixture('batch-next-stop-remove');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])]);
    const recorded = recorder(defaultRunner(fx.env));
    expect(await removeWorktrees(results, recorded.run, fx.env, stopped())).toEqual([
      { root: top, error: 'not removed: stopped' },
    ]);
    expect(recorded.calls).toEqual([]);
    expect(existsSync(results[0]!.worktree)).toBe(true);
  });
  it('the repositories a stopped batch never ran are listed, and offer no commit or PR', () => {
    const ran = result({ ok: false, last: 'stopped: the batch was stopped', stopped: true });
    const unrun = result({ ok: false, last: 'not run: batch stopped', created: false, stopped: true });
    expect(nextChoices([ran, unrun], [], { found: true, authed: true }).map((choice) => choice.id)).toEqual([
      'open',
      'remove',
    ]);
  });
});

describe('a worktree replaced while an action runs', () => {
  /** Moves the worktree away and puts a link to `decoy` (another repository) in its place. */
  const swap = (worktree: string, decoy: string): void => {
    renameSync(worktree, `${worktree}-moved`);
    symlinkSync(decoy, worktree, process.platform === 'win32' ? 'junction' : 'dir');
  };
  /** A runner that swaps the worktree once `when` matches a finished call, or answers it itself when `answer` says. */
  const swapping =
    (
      inner: Runner,
      act: () => void,
      when: (args: readonly string[]) => boolean,
      answer?: (args: readonly string[]) => Awaited<ReturnType<Runner>> | null,
    ): Runner =>
    async (file, args, options) => {
      const own = answer?.(args) ?? null;
      if (own !== null) {
        act();
        return own;
      }
      const result = await inner(file, args, options);
      if (when(args)) act();
      return result;
    };
  it('the next invocation of a commit, a push or a PR create is refused, and nothing runs in the replacement', async () => {
    const fx = withGh('batch-next-midway');
    const decoy = repo(fx, 'decoy');
    const decoyHead = git(decoy.top, ['rev-parse', 'HEAD'], fx.env);
    const decoyShort = decoyHead.trim().slice(0, 7);
    const real = defaultRunner(fx.env);
    const replaced = /was replaced or moved/;

    // During the commit: after `git add`, the commit itself is refused.
    const a = repo(fx, 'during-add');
    const first = (await batch(fx, [rowOf(a.top, [relock(a.top)])])).results;
    const afterAdd = await commitPassed(
      first,
      'Re-lock',
      swapping(
        real,
        () => swap(first[0]!.worktree, decoy.top),
        (args) => args.includes('add'),
      ),
      fx.env,
    );
    expect(afterAdd[0]).toMatchObject({ ok: false, last: expect.stringMatching(replaced) });

    // After the commit: the SHA probe is refused, so no SHA of the replacement is ever reported.
    const b = repo(fx, 'during-commit');
    const second = (await batch(fx, [rowOf(b.top, [relock(b.top)])])).results;
    const afterCommit = await commitPassed(
      second,
      'Re-lock',
      swapping(
        real,
        () => swap(second[0]!.worktree, decoy.top),
        (args) => args.includes('commit'),
      ),
      fx.env,
    );
    expect(afterCommit[0]).toMatchObject({ ok: false, last: expect.stringMatching(replaced) });
    expect(afterCommit[0]!.last).not.toContain(decoyShort);

    // During the push: the retry the remote asks for is refused.
    const c = repo(fx, 'during-push');
    const third = await commitPassed(
      (await batch(fx, [rowOf(c.top, [relock(c.top)])])).results,
      'Re-lock',
      real,
      fx.env,
    );
    const retried = await pushAndOpenPrs(
      third,
      swapping(
        real,
        () => swap(third[0]!.worktree, decoy.top),
        () => false,
        (args) =>
          args.includes('--atomic')
            ? { status: 1, stdout: '', stderr: 'error: the receiving end does not support --atomic push' }
            : null,
      ),
      fx.env,
    );
    expect(retried).toEqual([{ root: c.top, url: null, error: expect.stringMatching(replaced) }]);
    expect(git(c.top, ['ls-remote', 'origin', 'refs/heads/chore/ia-fix-generation'], fx.env)).toBe('');

    // After the push: the PR create is refused.
    const d = repo(fx, 'during-pr');
    const fourth = await commitPassed(
      (await batch(fx, [rowOf(d.top, [relock(d.top)])])).results,
      'Re-lock',
      real,
      fx.env,
    );
    const opened = await pushAndOpenPrs(
      fourth,
      swapping(
        real,
        () => swap(fourth[0]!.worktree, decoy.top),
        (args) => args.includes('push'),
      ),
      fx.env,
    );
    expect(opened).toEqual([{ root: d.top, url: null, error: expect.stringMatching(replaced) }]);

    // The replacement was never touched, and gh never ran.
    expect(git(decoy.top, ['rev-parse', 'HEAD'], fx.env)).toBe(decoyHead);
    expect(git(decoy.top, ['status', '--porcelain'], fx.env)).toBe('');
    expect(readLog(join(fx.dir, 'gh.log'))).toEqual([]);
  });
});

describe('git routing variables', () => {
  it('GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE aimed at the checkout reach no batch child', async () => {
    const fx = withGh('batch-next-gitenv');
    const { top } = repo(fx, 'routed', {
      'package.json': JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }),
      'package-lock.json': '{}',
    });
    const head = git(top, ['rev-parse', 'HEAD'], fx.env);
    const branch = git(top, ['symbolic-ref', 'HEAD'], fx.env);
    const index = readFileSync(join(top, '.git', 'index'));
    const porcelain = git(top, ['status', '--porcelain'], fx.env);
    // The console was started from a shell (a git hook, say) that routes git to the user's own checkout.
    const routed = {
      ...fx.env,
      GIT_DIR: join(top, '.git'),
      GIT_WORK_TREE: top,
      GIT_INDEX_FILE: join(top, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: join(top, 'hooks'),
    };
    const rows = [rowOf(top, [relock(top)])];
    const plan = planBatch(
      'fix:generation',
      rows,
      new Set([0]),
      { iaHome: join(fx.dir, 'home') },
      { top: (root) => gitTop(root, routed) },
    );
    expect(plan.repos[0]?.refused).toBeNull();
    const recorded = recorder(defaultRunner(routed));
    const results = await runBatch(
      plan,
      { running: { packageRoot: fx.running, version: '3.5.1' } },
      {
        run: recorded.run,
        resolveRepo: (root: string) => resolveRepo(root, routed, fx.running),
        progress: () => {},
        signal: new AbortController().signal,
        env: routed,
      },
    );
    expect(results[0]).toMatchObject({ ok: true });
    const committed = await commitPassed(results, 'Re-lock', recorded.run, routed);
    expect(committed[0]).toMatchObject({ ok: true });
    await ghReady(recorded.run, routed);
    const worktree = results[0]!.worktree;
    // The commit is on the batch branch, in the worktree; the checkout's HEAD, branch, index and status are as they were.
    expect(git(worktree, ['log', '-1', '--format=%s'], fx.env).trim()).toBe('chore: Re-lock');
    expect(git(worktree, ['symbolic-ref', 'HEAD'], fx.env).trim()).toBe('refs/heads/chore/ia-fix-generation');
    expect(git(top, ['rev-parse', 'HEAD'], fx.env)).toBe(head);
    expect(git(top, ['symbolic-ref', 'HEAD'], fx.env)).toBe(branch);
    expect(readFileSync(join(top, '.git', 'index')).equals(index)).toBe(true);
    expect(git(top, ['status', '--porcelain'], fx.env)).toBe(porcelain);
    // No recorded child (git on either side, the install, the steps, gh) was handed a routing variable.
    expect(recorded.calls.length).toBeGreaterThan(5);
    for (const call of recorded.calls)
      expect(
        Object.keys(call.env).filter((name) =>
          /^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_(COUNT|KEY_\d+|VALUE_\d+))$/i.test(name),
        ),
      ).toEqual([]);
  });
});

describe('the batch screen', () => {
  const screen = async (fx: Fixture, top: string, answers: readonly (string | null)[]) => {
    const rows = [rowOf(top, [relock(top)])];
    const plan = planBatch(
      'fix:generation',
      rows,
      new Set([0]),
      { iaHome: join(fx.dir, 'home') },
      { top: (root) => gitTop(root, fx.env) },
    );
    const printed: string[] = [];
    const asked: string[] = [];
    const left = [...answers];
    const outcome = await batchScreen(
      { choice: { offerId: 'fix:generation', title: 'Re-lock', repos: 1 }, ...plan },
      { packageRoot: fx.running, version: '3.5.1' },
      {
        print: (text) => printed.push(text),
        line: async (question) => {
          asked.push(question);
          return left.shift() ?? null;
        },
        run: defaultRunner(fx.env),
        resolveRepo: (root: string) => resolveRepo(root, fx.env, fx.running),
        env: fx.env,
        signal: new AbortController().signal,
      },
    );
    return { plan, printed, asked, outcome };
  };
  it('a decline runs nothing; a yes runs the batch, shows the results and runs the chosen next step', async () => {
    const fx = fixture('batch-next-screen');
    // The install writes node_modules into the worktree, which gives the commit something to hold.
    const { top } = repo(fx, 'alpha', {
      'package.json': JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }),
      'package-lock.json': '{}',
    });
    const declined = await screen(fx, top, ['n']);
    expect(declined.outcome).toEqual({ next: 'return' });
    expect(declined.printed).toContain('Declined; nothing ran.');
    expect(declined.printed).toContain(`  worktree ${declined.plan.repos[0]!.worktree}`);
    expect(existsSync(declined.plan.repos[0]!.worktree)).toBe(false);
    const ran = await screen(fx, top, ['y', '1', '']);
    const worktree = ran.plan.repos[0]!.worktree;
    expect(ran.outcome).toEqual({ next: 'return' });
    expect(ran.printed.some((line) => line.startsWith('ok     chore/ia-fix-generation'))).toBe(true);
    // The commit was the first choice; it then leaves the list.
    expect(ran.printed.some((line) => /^ok {5}chore\/ia-fix-generation .* committed [0-9a-f]+$/.test(line))).toBe(true);
    expect(git(worktree, ['log', '-1', '--format=%s'], fx.env).trim()).toBe('chore: Re-lock');
    expect(ran.asked).toEqual([
      'Run this batch? [y/N] ',
      'Choose a number, or press enter to return: ',
      'Choose a number, or press enter to return: ',
    ]);
  });
});
