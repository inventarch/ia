/**
 * Running a batch (console/batch-run.ts) in real git repositories with bare origins, fake package managers on a PATH
 * of their own and the real default runner: the worktree and branch (no upstream), the base, the install built for the
 * worktree, the steps rebuilt for it, the copy each `ia` step runs (found by the real discovery, before every step),
 * and the run-time containment check. Every spawn is recorded, so the tests assert the argv and cwd themselves, and
 * that the user's own checkout is touched only by the listed git metadata operations.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { iaFix } from '../src/fix.js';
import { installArgv, pinArgv } from '../src/package-manager.js';
import { resolveRepo } from '../src/console/app.js';
import type { Step } from '../src/console/offers.js';
import type { RepoPlan } from '../src/console/batch-plan.js';
import { planBatch } from '../src/console/batch-plan.js';
import type { RepoResult } from '../src/console/batch-run.js';
import { chooseBase, containedStep, defaultRunner, gitTop, METADATA_OPS, runBatch } from '../src/console/batch-run.js';
import type { RepoRow } from '../src/console/workspaces-state.js';
import type { Call, Fixture } from './batch-fixture.js';
import { FAKE_PM, fixture, git, offerOf, readLog, recorder, repo, rowOf } from './batch-fixture.js';
import { cleanup } from './scratch-fixture.js';

afterAll(cleanup);

const ia = (argv: readonly string[], writesTo: Step['writesTo'] = 'repo'): Step => iaFix(argv, writesTo).fix!;
const external = (argv: readonly string[]): Step => ({ program: 'external', argv, flow: 'confirm', writesTo: 'repo' });
const relock = (root: string) => offerOf('fix:generation', 'Re-lock', [ia(['restore', '--apply', '--root', root])]);
const LOCKED = { 'package-lock.json': '{}\n' };
const pinned = (version: string) => JSON.stringify({ devDependencies: { '@inventarch/cli': version } });
const unpinned = JSON.stringify({ name: 'repo' });

/** Plans `offerId` over `rows` and runs it, recording every spawn. */
async function batch(
  fx: Fixture,
  rows: readonly RepoRow[],
  offerId: string,
  plan?: { readonly repos: readonly RepoPlan[]; readonly deferred?: readonly Step[] },
) {
  const made =
    plan ??
    planBatch(
      offerId,
      rows,
      new Set(rows.keys()),
      { iaHome: join(fx.dir, 'home') },
      { top: (root) => gitTop(root, fx.env) },
    );
  const recorded = recorder(defaultRunner(fx.env));
  const progress: string[] = [];
  const results = await runBatch(
    made,
    { running: { packageRoot: fx.running, version: '3.5.1' } },
    {
      run: recorded.run,
      resolveRepo,
      progress: (_index, line) => progress.push(line),
      signal: new AbortController().signal,
      env: fx.env,
    },
  );
  return { plan: made, results, calls: recorded.calls, progress };
}
const pmCalls = (fx: Fixture) => readLog<{ manager: string; argv: string[]; cwd: string }>(fx.pmLog);
const iaCalls = (fx: Fixture) => readLog<{ argv: string[]; cwd: string; version: string }>(fx.iaLog);
const only = (results: readonly RepoResult[]): RepoResult => {
  expect(results).toHaveLength(1);
  return results[0]!;
};
const fold = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
/** `child` (a path, or a token whose value after `=` is one) is `parent` or inside it. */
const inside = (parent: string, child: string): boolean =>
  [child, ...(child.includes('=') ? [child.slice(child.indexOf('=') + 1)] : [])].some((value) => {
    if (!isAbsolute(value)) return false;
    const rel = relative(fold(parent), fold(value));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  });
/** Points a bare origin's HEAD at a branch that does not exist, so a fetch cannot create origin/HEAD. */
const unborn = (fx: Fixture, origin: string, top: string): void => {
  git(fx.dir, ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/unborn'], fx.env);
  try {
    git(top, ['remote', 'set-head', 'origin', '-d'], fx.env);
  } catch {
    // There was none.
  }
};
const iaArgv = (call: Call): readonly string[] => call.args.slice(1);
const iaSpawns = (calls: readonly Call[]) => calls.filter((call) => call.file === process.execPath);

describe('worktree, branch and base', () => {
  it('creates the worktree and branch with no upstream', async () => {
    const fx = fixture('batch-run-new');
    const { top } = repo(fx, 'alpha');
    const { results } = await batch(fx, [rowOf(top, [relock(top)])], 'fix:generation');
    const result = only(results);
    expect(result).toMatchObject({ ok: true, refused: null, branch: 'chore/ia-fix-generation' });
    expect(existsSync(join(result.worktree, '.ia/src/workspace.ia'))).toBe(true);
    expect(git(top, ['rev-parse', '--verify', 'refs/heads/chore/ia-fix-generation'], fx.env).trim()).not.toBe('');
    expect(() => git(top, ['rev-parse', '--abbrev-ref', 'chore/ia-fix-generation@{u}'], fx.env)).toThrow();
  });
  it('base falls back to origin/main then origin/master and refuses otherwise', async () => {
    const fx = fixture('batch-run-base');
    const run = defaultRunner(fx.env);
    // origin/HEAD first: it names trunk, which is ahead of main.
    const headed = repo(fx, 'headed');
    git(headed.top, ['checkout', '--quiet', '-b', 'trunk'], fx.env);
    writeFileSync(join(headed.top, 'trunk.txt'), 'trunk');
    git(headed.top, ['add', '-A'], fx.env);
    git(headed.top, ['commit', '--quiet', '-m', 'trunk'], fx.env);
    git(headed.top, ['push', '--quiet', 'origin', 'trunk'], fx.env);
    git(headed.top, ['remote', 'set-head', 'origin', 'trunk'], fx.env);
    git(headed.top, ['checkout', '--quiet', 'main'], fx.env);
    expect(await chooseBase(headed.top, run, fx.env)).toBe('origin/trunk');
    const plain = repo(fx, 'plain');
    unborn(fx, plain.origin, plain.top);
    expect(await chooseBase(plain.top, run, fx.env)).toBe('origin/main');
    const old = repo(fx, 'old', {}, 'master');
    unborn(fx, old.origin, old.top);
    expect(await chooseBase(old.top, run, fx.env)).toBe('origin/master');
    const odd = repo(fx, 'odd', {}, 'develop');
    unborn(fx, odd.origin, odd.top);
    expect(await chooseBase(odd.top, run, fx.env)).toBeNull();
    const { results } = await batch(fx, [rowOf(odd.top, [relock(odd.top)])], 'fix:generation');
    expect(only(results)).toMatchObject({
      ok: false,
      refused: expect.stringMatching(/origin has no HEAD, main or master/),
    });
    expect(existsSync(only(results).worktree)).toBe(false);
  });
  it('an existing path or branch is refused', async () => {
    const fx = fixture('batch-run-exists');
    const path = repo(fx, 'path');
    const first = await batch(fx, [rowOf(path.top, [relock(path.top)])], 'fix:generation');
    const worktree = only(first.results).worktree;
    rmSync(worktree, { recursive: true, force: true });
    mkdirSync(worktree, { recursive: true });
    git(path.top, ['worktree', 'prune'], fx.env);
    git(path.top, ['branch', '-D', 'chore/ia-fix-generation'], fx.env);
    const again = await batch(fx, [rowOf(path.top, [relock(path.top)])], 'fix:generation');
    expect(only(again.results).refused).toBe(`the worktree path already exists: ${worktree}`);
    const branch = repo(fx, 'branch');
    git(branch.top, ['branch', 'chore/ia-fix-generation'], fx.env);
    const taken = await batch(fx, [rowOf(branch.top, [relock(branch.top)])], 'fix:generation');
    expect(only(taken.results).refused).toBe('the branch already exists: chore/ia-fix-generation');
    expect(existsSync(only(taken.results).worktree)).toBe(false);
  });
});

describe('install first', () => {
  it('install first: ok, conflict, no manager and a failing install each behave as stated', async () => {
    const fx = fixture('batch-run-install');
    const ok = repo(fx, 'ok', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const conflict = repo(fx, 'conflict', { 'package.json': pinned('3.5.0'), ...LOCKED, 'pnpm-lock.yaml': '' });
    const none = repo(fx, 'none', { 'package.json': pinned('3.5.0') });
    const rows = [ok, conflict, none].map(({ top }) => rowOf(top, [relock(top)]));
    const { results } = await batch(fx, rows, 'fix:generation');
    expect(results.map((result) => [result.ok, result.refused])).toEqual([
      [true, null],
      [false, 'package managers disagree: npm, pnpm'],
      [false, expect.stringMatching(/^no package manager is declared or locked in /)],
    ]);
    // One install, in the first repository's worktree; the restore then ran on its installed copy.
    expect(pmCalls(fx)).toEqual([{ manager: 'npm', argv: ['install'], cwd: results[0]!.worktree }]);
    expect(iaCalls(fx).map((call) => call.version)).toEqual(['3.5.0']);
    const failing = repo(fx, 'failing', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const failed = await batch(
      { ...fx, env: { ...fx.env, FAKE_PM_MODE: 'fail' } },
      [rowOf(failing.top, [relock(failing.top)])],
      'fix:generation',
    );
    expect(only(failed.results)).toMatchObject({
      ok: false,
      refused: null,
      last: expect.stringMatching(/^npm install exited 1: install failed/),
    });
    expect(iaCalls(fx)).toHaveLength(1);
  });
  it('the install is built for the worktree: pnpm --dir <worktree manifest dir> for an ancestor manifest, no flag at the manifest\u2019s own directory', async () => {
    const fx = fixture('batch-run-pnpm');
    const files = { 'package.json': pinned('3.5.0'), 'pnpm-lock.yaml': '', 'packages/notes/.ia/src/workspace.ia': '' };
    const mono = repo(fx, 'mono', files);
    const root = join(mono.top, 'packages', 'notes');
    const flat = repo(fx, 'flat', { 'package.json': pinned('3.5.0'), 'pnpm-lock.yaml': '' });
    const { results, calls } = await batch(
      fx,
      [rowOf(root, [relock(root)]), rowOf(flat.top, [relock(flat.top)])],
      'fix:generation',
    );
    const [nested, own] = results;
    expect(pmCalls(fx)).toEqual([
      {
        manager: 'pnpm',
        argv: ['--dir', nested!.worktree, 'install'],
        cwd: join(nested!.worktree, 'packages', 'notes'),
      },
      { manager: 'pnpm', argv: ['install'], cwd: own!.worktree },
    ]);
    // The nested workspace's restore runs in its folder, on the copy installed at the worktree's top.
    const restores = iaSpawns(calls);
    expect(restores[0]!.cwd).toBe(join(nested!.worktree, 'packages', 'notes'));
    expect(restores[0]!.args[0]).toBe(
      realpathSync.native(join(nested!.worktree, 'node_modules/@inventarch/cli/dist/bin.js')),
    );
  });
  it('yarn --cwd <worktree manifest dir> install for Yarn Classic and Yarn 2+ alike', async () => {
    const fx = fixture('batch-run-yarn');
    const classic = repo(fx, 'classic', {
      'package.json': pinned('3.5.0'),
      'yarn.lock': '',
      'app/.ia/src/workspace.ia': '',
    });
    const berry = repo(fx, 'berry', {
      'package.json': pinned('3.5.0'),
      'yarn.lock': '',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
      'app/.ia/src/workspace.ia': '',
    });
    const roots = [join(classic.top, 'app'), join(berry.top, 'app')];
    const { results } = await batch(
      fx,
      roots.map((root) => rowOf(root, [relock(root)])),
      'fix:generation',
    );
    expect(pmCalls(fx).map((call) => call.argv)).toEqual([
      ['--cwd', results[0]!.worktree, 'install'],
      ['--cwd', results[1]!.worktree, 'install'],
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
  });
  it('failure isolates to one repo', async () => {
    const fx = fixture('batch-run-isolate');
    const bad = repo(fx, 'bad', { 'package.json': pinned('3.5.0'), ...LOCKED, 'yarn.lock': '' });
    const good = repo(fx, 'good', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const { results } = await batch(
      fx,
      [rowOf(bad.top, [relock(bad.top)]), rowOf(good.top, [relock(good.top)])],
      'fix:generation',
    );
    expect(results.map((result) => result.ok)).toEqual([false, true]);
    expect(iaCalls(fx).map((call) => call.cwd)).toEqual([results[1]!.worktree]);
  });
});

describe('isolation', () => {
  it('the user\u2019s dirty checkout is untouched', async () => {
    const fx = fixture('batch-run-dirty');
    const { top } = repo(fx, 'dirty', { 'package.json': pinned('3.5.0'), ...LOCKED, 'notes.txt': 'one' });
    writeFileSync(join(top, 'notes.txt'), 'changed');
    writeFileSync(join(top, 'untracked.txt'), 'new');
    const before = git(top, ['status', '--porcelain'], fx.env);
    const offer = offerOf('fix:pending', 'Resume interrupted install', [
      ia(['recover', '--root', top]),
      ia(['restore', '--apply', '--root', top]),
    ]);
    const { results, calls } = await batch(fx, [rowOf(top, [offer])], 'fix:pending');
    expect(only(results).ok).toBe(true);
    expect(git(top, ['status', '--porcelain'], fx.env)).toBe(before);
    expect(readFileSync(join(top, 'notes.txt'), 'utf8')).toBe('changed');
    expect(existsSync(join(top, 'node_modules'))).toBe(false);
    const touching = calls.filter((call) => inside(top, call.cwd) || call.args.some((token) => inside(top, token)));
    expect(touching.length).toBeGreaterThan(0);
    for (const call of touching) {
      expect(call.file).toBe('git');
      expect(call.args.slice(0, 2)).toEqual(['-C', top]);
      const op = call.args.slice(2).join(' ');
      expect(METADATA_OPS.some((allowed) => op === allowed || op.startsWith(`${allowed} `))).toBe(true);
    }
    expect(touching.some((call) => call.args[2] === 'worktree')).toBe(true);
    for (const call of calls.filter((entry) => !touching.includes(entry))) {
      expect(inside(only(results).worktree, call.cwd)).toBe(true);
      for (const token of call.args) expect(inside(top, token)).toBe(false);
    }
  });
  it('a recover step with --root <original> is spawned with --root <worktree workspace>', async () => {
    const fx = fixture('batch-run-recover');
    const { top } = repo(fx, 'recover');
    const offer = offerOf('fix:pending', 'Resume interrupted install', [ia(['recover', '--root', top])]);
    const { results, calls } = await batch(fx, [rowOf(top, [offer])], 'fix:pending');
    const [spawned] = iaSpawns(calls);
    expect(iaArgv(spawned!)).toEqual(['recover', '--root', only(results).worktree]);
    expect(spawned!.args[0]).toBe(join(fx.running, 'dist', 'main.js'));
    expect(spawned!.env['IA_NO_HANDOFF']).toBe('1');
    expect(iaCalls(fx)).toEqual([
      { argv: ['recover', '--root', only(results).worktree], cwd: only(results).worktree, version: 'running' },
    ]);
  });
  it('an ancestor-manifest step is spawned with --prefix <worktree manifest dir>, not the original', async () => {
    const fx = fixture('batch-run-prefix');
    const mono = repo(fx, 'mono', {
      'package.json': pinned('3.5.0'),
      ...LOCKED,
      'apps/notes/.ia/src/workspace.ia': '',
    });
    const root = join(mono.top, 'apps', 'notes');
    const offer = offerOf('upgrade', 'Upgrade CLI to 3.5.1', [external(pinArgv('npm', '3.5.1', mono.top, root))]);
    const { results } = await batch(fx, [rowOf(root, [offer])], 'upgrade');
    const worktree = only(results).worktree;
    expect(pmCalls(fx).at(-1)).toEqual({
      manager: 'npm',
      argv: ['install', '-D', '--prefix', worktree, '@inventarch/cli@3.5.1'],
      cwd: join(worktree, 'apps', 'notes'),
    });
  });
  it('applying forms are spawned with --yes, restore --apply included; recover is spawned as given', async () => {
    const fx = fixture('batch-run-yes');
    const { top } = repo(fx, 'yes');
    const offer = offerOf('fix:pending', 'Resume', [
      ia(['restore', '--apply', '--root', top]),
      ia(['recover', '--root', top]),
      ia(['install', 'acme/kit']),
    ]);
    const { results, calls } = await batch(fx, [rowOf(top, [offer])], 'fix:pending');
    const worktree = only(results).worktree;
    expect(iaSpawns(calls).map(iaArgv)).toEqual([
      ['restore', '--apply', '--root', worktree, '--yes'],
      ['recover', '--root', worktree],
      ['install', 'acme/kit', '--apply', '--yes'],
    ]);
  });
  it('a workspace in a subfolder runs with cwd <worktree>/<relative>', async () => {
    const fx = fixture('batch-run-sub');
    const { top } = repo(fx, 'sub', { 'tools/kb/.ia/src/workspace.ia': '' });
    const root = join(top, 'tools', 'kb');
    const { results, calls } = await batch(fx, [rowOf(root, [relock(root)])], 'fix:generation');
    const workspace = join(only(results).worktree, 'tools', 'kb');
    expect(iaSpawns(calls).map((call) => [call.cwd, ...iaArgv(call)])).toEqual([
      [workspace, 'restore', '--apply', '--root', workspace, '--yes'],
    ]);
  });
});

describe('containment before each step', () => {
  it('a step through a link out of the worktree is refused at that step; a link inside it is accepted', async () => {
    const fx = fixture('batch-run-link');
    const { top } = repo(fx, 'linked', { 'package.json': pinned('3.5.0'), ...LOCKED, 'inside/keep.txt': '' });
    const before = git(top, ['status', '--porcelain'], fx.env);
    const offer = offerOf('fix:out', 'Project', [
      ia(['project', 'claude', '--out', 'in-link/report']),
      ia(['project', 'claude', '--out', 'out-link/report']),
      ia(['validate']),
    ]);
    const plan = planBatch(
      'fix:out',
      [rowOf(top, [offer])],
      new Set([0]),
      { iaHome: join(fx.dir, 'home') },
      { top: (root) => gitTop(root, fx.env) },
    );
    const worktree = plan.repos[0]!.worktree;
    // The install makes both links, so the check before each later step sees them: one leads to the user's checkout.
    const links = JSON.stringify([
      ['out-link', top],
      ['in-link', join(worktree, 'inside')],
    ]);
    const { results, calls } = await batch({ ...fx, env: { ...fx.env, FAKE_PM_LINKS: links } }, [], 'fix:out', plan);
    const result = only(results);
    expect(result.ok).toBe(false);
    expect(result.refused).toBe(
      `step 2: ${join(worktree, 'out-link', 'report')} leads outside the worktree, to ${join(top, 'report')}`,
    );
    expect(iaSpawns(calls).map(iaArgv)).toEqual([
      ['project', 'claude', '--out', join(worktree, 'in-link', 'report'), '--apply', '--yes'],
    ]);
    expect(git(top, ['status', '--porcelain'], fx.env)).toBe(before);
    expect(existsSync(join(top, 'report'))).toBe(false);
  });
  it('a bare --registry name that is a link out of the worktree is refused before execution, and an https registry is spawned unchanged', async () => {
    const fx = fixture('batch-run-registry');
    const { top } = repo(fx, 'registry', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const https = offerOf('fix:https', 'Install', [
      ia(['install', 'acme/kit', '--registry', 'https://example.test/registry']),
    ]);
    const named = offerOf('fix:named', 'Install', [ia(['install', 'acme/kit', '--registry', 'registry-link'])]);
    const env = { ...fx.env, FAKE_PM_LINKS: JSON.stringify([['registry-link', top]]) };
    const first = await batch({ ...fx, env }, [rowOf(top, [https])], 'fix:https');
    expect(iaSpawns(first.calls).map(iaArgv)).toEqual([
      ['install', 'acme/kit', '--registry', 'https://example.test/registry', '--apply', '--yes'],
    ]);
    const other = repo(fx, 'registry2', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const second = await batch(
      { ...fx, env: { ...fx.env, FAKE_PM_LINKS: JSON.stringify([['registry-link', other.top]]) } },
      [rowOf(other.top, [named])],
      'fix:named',
    );
    expect(only(second.results).refused).toMatch(/^step 1: registry-link leads outside the worktree/);
    expect(iaSpawns(second.calls)).toEqual([]);
  });
  it('a relative traversal that survives planning is still caught before execution', async () => {
    const fx = fixture('batch-run-traversal');
    const { top } = repo(fx, 'trav');
    const plan = planBatch(
      'fix:generation',
      [rowOf(top, [relock(top)])],
      new Set([0]),
      { iaHome: join(fx.dir, 'home') },
      { top: (root) => gitTop(root, fx.env) },
    );
    const forged: RepoPlan = { ...plan.repos[0]!, steps: [ia(['recover', '--root', '../../x'])] };
    const { results, calls } = await batch(fx, [], 'fix:generation', { repos: [forged] });
    expect(only(results).refused).toMatch(/^step 1: \.\.\/\.\.\/x leads outside the worktree/);
    expect(iaSpawns(calls)).toEqual([]);
  });
  it('containedStep follows a junction or directory link on the real filesystem', () => {
    const fx = fixture('batch-run-contained');
    const tree = join(fx.dir, 'tree'),
      outside = join(fx.dir, 'outside');
    mkdirSync(join(tree, 'in'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(outside, join(tree, 'out'), kind);
    symlinkSync(join(tree, 'in'), join(tree, 'back'), kind);
    expect(containedStep(ia(['project', 'claude', '--out', 'back/new/file']), tree, tree)).toBeNull();
    expect(containedStep(ia(['project', 'claude', '--out', 'out/new/file']), tree, tree)).toMatch(
      /^out[\\/]new[\\/]file leads outside the worktree, to /,
    );
    // A cwd that is itself a link out of the worktree is refused before anything runs.
    expect(containedStep(ia(['validate']), join(tree, 'out'), tree)).toMatch(/leads outside the worktree/);
  });
});

it.skipIf(process.platform === 'win32')(
  'a workspace subfolder committed as a link out of the worktree refuses the repo before the install',
  async () => {
    const fx = fixture('batch-run-committed-link');
    const { top } = repo(fx, 'committed', {
      'package.json': pinned('3.5.0'),
      ...LOCKED,
      'real/.ia/src/workspace.ia': '',
    });
    symlinkSync(join(top, 'real'), join(top, 'notes'), 'dir');
    git(top, ['add', '-A'], fx.env);
    git(top, ['commit', '--quiet', '-m', 'link'], fx.env);
    git(top, ['push', '--quiet', 'origin', 'main'], fx.env);
    const root = join(top, 'notes');
    const plan = planBatch(
      'fix:generation',
      [rowOf(root, [relock(root)])],
      new Set([0]),
      { iaHome: join(fx.dir, 'home') },
      { top: () => top },
    );
    const { results } = await batch(fx, [], 'fix:generation', plan);
    expect(only(results).refused).toMatch(/leads outside the worktree/);
    expect(pmCalls(fx)).toEqual([]);
  },
);

describe('the copy each ia step runs', () => {
  const upgrade = (manager: 'npm' | 'pnpm', dir: string, at: string) =>
    offerOf('upgrade', 'Upgrade CLI to 3.5.1', [
      external(pinArgv(manager, '3.5.1', dir, at)),
      { ...ia(['restore', '--apply']), requires: 'repo-copy' },
      { ...ia(['validate'], 'none'), requires: 'repo-copy' },
      ia(['host', 'claude', '--user', '--apply'], 'user'),
    ]);
  it('npm pinning by its exact builder form', async () => {
    const fx = fixture('batch-run-npm');
    const pinnedRepo = repo(fx, 'pinned', {
      'package.json': pinned('3.5.0'),
      ...LOCKED,
      'notes/.ia/src/workspace.ia': '',
    });
    const looseRepo = repo(fx, 'loose', { 'package.json': unpinned, ...LOCKED, 'notes/.ia/src/workspace.ia': '' });
    const flatRepo = repo(fx, 'flat repo', { 'package.json': pinned('3.5.0'), ...LOCKED });
    const sub = (top: string) => join(top, 'notes');
    const rows = [
      rowOf(sub(pinnedRepo.top), [upgrade('npm', pinnedRepo.top, sub(pinnedRepo.top))]),
      rowOf(sub(looseRepo.top), [upgrade('npm', looseRepo.top, sub(looseRepo.top))]),
      rowOf(flatRepo.top, [upgrade('npm', flatRepo.top, flatRepo.top)]),
    ];
    const { results, plan } = await batch(fx, rows, 'upgrade');
    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expect(results[2]!.worktree).toMatch(/flat repo-ia-3-5-1$/);
    expect(plan.repos.map((entry) => entry.steps[0]!.argv)).toEqual([
      ['npm', 'install', '-D', '--prefix', results[0]!.worktree, '@inventarch/cli@3.5.1'],
      ['npm', 'install', '-D', '--prefix', results[1]!.worktree, '@inventarch/cli@3.5.1'],
      ['npm', 'install', '-D', '@inventarch/cli@3.5.1'],
    ]);
    expect(plan.deferred?.map((step) => step.argv)).toEqual([['host', 'claude', '--user', '--apply']]);
    for (const result of results) {
      const manifest = JSON.parse(readFileSync(join(result.worktree, 'package.json'), 'utf8'));
      expect(manifest.devDependencies['@inventarch/cli']).toBe('3.5.1');
      const copy = JSON.parse(readFileSync(join(result.worktree, 'node_modules/@inventarch/cli/package.json'), 'utf8'));
      expect(copy.version).toBe('3.5.1');
    }
    // Restore and validate ran on the copy the pin installed, in every repository; the host step was left out.
    expect(iaCalls(fx).map((call) => [call.argv[0], call.version])).toEqual([
      ['restore', '3.5.1'],
      ['validate', '3.5.1'],
      ['restore', '3.5.1'],
      ['validate', '3.5.1'],
      ['restore', '3.5.1'],
      ['validate', '3.5.1'],
    ]);
  });
  it('the entry is resolved before each step in the worktree, by real discovery', async () => {
    const fx = fixture('batch-run-entry');
    const { top } = repo(fx, 'unpinned', { 'package.json': unpinned, 'pnpm-lock.yaml': '' });
    const { results, calls } = await batch(fx, [rowOf(top, [upgrade('pnpm', top, top)])], 'upgrade');
    const worktree = only(results).worktree;
    expect(pmCalls(fx).map((call) => call.argv)).toEqual([['install'], ['add', '-D', '@inventarch/cli@3.5.1']]);
    const entry = realpathSync.native(join(worktree, 'node_modules/@inventarch/cli/dist/bin.js'));
    expect(iaSpawns(calls).map((call) => [call.args[0], call.args[1]])).toEqual([
      [entry, 'restore'],
      [entry, 'validate'],
    ]);
    expect(iaCalls(fx).map((call) => call.version)).toEqual(['3.5.1', '3.5.1']);
  });
  it('a copy findLocalCli rejects is not used', async () => {
    for (const defect of ['name', 'version', 'bin', 'entry']) {
      const fx = fixture(`batch-run-defect-${defect}`);
      const env = { ...fx.env, FAKE_PM_DEFECT: defect };
      const { top } = repo({ ...fx, env }, 'defect', { 'package.json': pinned('3.5.0'), ...LOCKED });
      const offer = offerOf('fix:check', 'Check', [
        ia(['validate'], 'none'),
        { ...ia(['restore', '--apply']), requires: 'repo-copy' },
      ]);
      const { results } = await batch({ ...fx, env }, [rowOf(top, [offer])], 'fix:check');
      expect(iaCalls(fx).map((call) => [call.argv[0], call.version])).toEqual([['validate', 'running']]);
      expect(only(results).refused).toBe('step 2: the repo copy is not installed');
    }
  });
  it('an unpinned repo uses the running copy; a requires-repo-copy step refuses it', async () => {
    const fx = fixture('batch-run-unpinned');
    const { top } = repo(fx, 'plain');
    const offer = offerOf('fix:two', 'Two', [
      ia(['restore', '--apply', '--root', top]),
      { ...ia(['validate'], 'none'), requires: 'repo-copy' },
    ]);
    const { results } = await batch(fx, [rowOf(top, [offer])], 'fix:two');
    expect(iaCalls(fx).map((call) => [call.argv[0], call.version])).toEqual([['restore', 'running']]);
    expect(only(results)).toMatchObject({ ok: false, refused: 'step 2: the repo copy is not installed' });
  });
});

describe('defaultRunner', () => {
  it('through the shims: argv and cwd arrive intact with a space in the path', async () => {
    const fx = fixture('batch-run-runner');
    const spaced = join(fx.dir, 'a folder', 'with space');
    mkdirSync(spaced, { recursive: true });
    const run = defaultRunner(fx.env);
    const result = await run('npm', ['install', '--prefix', spaced, 'name with space', '@scope/pkg@1.0.0'], {
      cwd: spaced,
      env: { ...fx.env, FAKE_PM_MODE: 'other' },
    });
    expect(result.status).toBe(0);
    expect(pmCalls(fx)).toEqual([
      { manager: 'npm', argv: ['install', '--prefix', spaced, 'name with space', '@scope/pkg@1.0.0'], cwd: spaced },
    ]);
    const failed = await run('npm', ['ci'], { cwd: spaced, env: { ...fx.env, FAKE_PM_MODE: 'fail' } });
    expect(failed).toMatchObject({ status: 1, stderr: expect.stringContaining('install failed') });
    const missing = await run('no-such-program', [], { cwd: spaced, env: fx.env });
    expect(missing.status).toBeNull();
  });
});

it.skipIf(process.platform !== 'win32')('the .cmd route passes cmd.exe’s own characters through intact', async () => {
  const fx = fixture('batch-run-cmd');
  const run = defaultRunner(fx.env);
  const args = ['a&b', 'c|d', 'e^f', '(g)', 'h<i>', 'j!k', 'C:\\dir with space\\'];
  expect((await run('npm', args, { cwd: fx.dir, env: fx.env })).status).toBe(0);
  expect(pmCalls(fx)[0]?.argv).toEqual(args);
  const refused = await run('npm', ['100%'], { cwd: fx.dir, env: fx.env });
  expect(refused).toMatchObject({ status: null, stderr: expect.stringMatching(/cmd\.exe cannot pass/) });
});
it.skipIf(process.platform === 'win32')('a POSIX shim passes shell characters through intact', async () => {
  const fx = fixture('batch-run-sh');
  const run = defaultRunner(fx.env);
  const args = ['a&b', '$HOME', '"q"', "it's", 'x;y', '100%'];
  expect((await run('npm', args, { cwd: fx.dir, env: fx.env })).status).toBe(0);
  expect(pmCalls(fx)[0]?.argv).toEqual(args);
});

describe('the fixture grammar', () => {
  it('fake-pm classifies the builders’ install and pin forms, with and without a directory', async () => {
    const { classify } = (await import(pathToFileURL(FAKE_PM).href)) as {
      classify: (args: readonly string[]) => { directory: string | null; kind: string; specs: string[] };
    };
    const dir = resolve('/srv/mono'),
      at = resolve('/srv/mono/apps/notes');
    const spec = ['@inventarch/cli@3.5.1'];
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      expect(classify(installArgv(manager, dir, at).slice(1))).toMatchObject({
        kind: 'install',
        directory: dir,
        specs: [],
      });
      expect(classify(installArgv(manager, dir, dir).slice(1))).toMatchObject({
        kind: 'install',
        directory: null,
        specs: [],
      });
      expect(classify(pinArgv(manager, '3.5.1', dir, at).slice(1))).toMatchObject({
        kind: 'mutation',
        directory: dir,
        specs: spec,
      });
      expect(classify(pinArgv(manager, '3.5.1', dir, dir).slice(1))).toMatchObject({
        kind: 'mutation',
        directory: null,
        specs: spec,
      });
    }
  });
});
