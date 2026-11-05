/**
 * Planning a batch (console/batch-plan.ts): which offers can be batched and on which rows, the deferred user and
 * machine steps, branch and worktree names, and the rebuilding of every path-bearing argument for the worktree. Every
 * path argument is resolved against the step's destination; one that leaves the worktree refuses the repo. Pure: no
 * filesystem, no git.
 */
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRegistryBase } from '@inventarch/distribution/internal/registry-source';
import { describe, expect, it } from 'vitest';
import type { OptionSpec } from '../src/args.js';
import { COMMANDS } from '../src/commands.js';
import type { Fix } from '../src/fix.js';
import { displayFix, iaFix } from '../src/fix.js';
import type { Offer, Step } from '../src/console/offers.js';
import { batchable } from '../src/console/offers.js';
import {
  batchChoices,
  branchFor,
  pathArguments,
  planBatch,
  rebaseStep,
  selectNeeding,
} from '../src/console/batch-plan.js';
import type { RepoRow } from '../src/console/workspaces-state.js';

const native = (...parts: string[]): string => resolve(sep, ...parts);
const HOME = native('srv', 'home', '.ia');
const offer = (id: string, steps: readonly Step[], extra: Partial<Offer> = {}): Offer => ({
  id,
  answers: [id],
  title: id,
  explain: '',
  steps,
  changes: [],
  group: 'attention',
  area: null,
  writesTo: [...new Set(steps.map((step) => step.writesTo))],
  batchable: batchable(steps),
  ...extra,
});
const ia = (argv: readonly string[], writesTo: Fix['writesTo'] = 'repo'): Step => {
  const fix = iaFix(argv, writesTo).fix;
  if (fix === null) throw new Error(`no flow for ${argv.join(' ')}`);
  return fix;
};
const external = (argv: readonly string[], writesTo: Fix['writesTo'] = 'repo'): Step => ({
  program: 'external',
  argv,
  flow: 'confirm',
  writesTo,
});
const row = (root: string, offers: readonly Offer[], state: RepoRow['state'] = 'ready'): RepoRow => ({
  tracked: { id: root.split(/[\\/]/).at(-1)!, root, added: '2026-01-01T00:00:00.000Z' },
  state,
  console: null,
  offers,
  failure: null,
});
const upgrade = (_root: string): Offer =>
  offer(
    'upgrade',
    [
      external(['npm', 'install', '-D', '@inventarch/cli@3.5.1']),
      { ...ia(['restore', '--apply']), requires: 'repo-copy' },
      { ...ia(['validate'], 'none'), requires: 'repo-copy' },
      ia(['host', 'claude', '--user', '--apply'], 'user'),
    ],
    { title: 'Upgrade CLI to 3.5.1', answers: ['cli-version', 'updates'] },
  );
const relock = (root: string): Offer =>
  offer('fix:generation', [ia(['restore', '--apply', '--root', root])], { title: 'Re-lock' });
const tops = (map: Readonly<Record<string, string>>) => ({ top: (root: string) => map[root] ?? null });

describe('choices and selection', () => {
  const alpha = native('srv', 'repos', 'alpha'),
    beta = native('srv', 'repos', 'beta'),
    gamma = native('srv', 'repos', 'gamma');
  const rows = [
    row(alpha, [upgrade(alpha), relock(alpha)]),
    row(beta, [upgrade(beta)]),
    row(gamma, [
      offer('fix:plugin-claude', [ia(['host', 'claude', '--user', '--apply'], 'user')]),
      offer('add-kit', [ia(['install', '<kit>'])], {
        group: 'more',
        input: { label: 'Kit id', accept: () => null, build: () => [] },
      }),
      offer('diagnostics', [], { group: 'more', view: 'diagnostics' }),
    ]),
  ];
  it('only batchable offers are choices', () => {
    expect(batchChoices(rows, new Set([0, 1, 2]))).toEqual([
      { offerId: 'upgrade', title: 'Upgrade CLI to 3.5.1', repos: 2 },
      { offerId: 'fix:generation', title: 'Re-lock', repos: 1 },
    ]);
    expect(batchChoices(rows, new Set([1]))).toEqual([{ offerId: 'upgrade', title: 'Upgrade CLI to 3.5.1', repos: 1 }]);
    expect(batchChoices(rows, new Set())).toEqual([]);
  });
  it('a selects every row where a batchable offer fires', () => {
    const loading = row(native('srv', 'repos', 'delta'), [], 'loading');
    expect([...selectNeeding([...rows, loading])].sort()).toEqual([0, 1]);
  });
});

describe('planBatch', () => {
  const alpha = native('srv', 'repos', 'alpha'),
    beta = native('srv', 'repos', 'beta'),
    gamma = native('srv', 'repos', 'gamma');
  const rows = [row(alpha, [upgrade(alpha)]), row(beta, [upgrade(beta)]), row(gamma, [upgrade(gamma)])];
  const git = tops({ [alpha]: alpha, [beta]: beta, [gamma]: gamma });
  it('user and machine steps are deferred and de-duplicated', () => {
    const plan = planBatch('upgrade', rows, new Set([0, 1, 2]), { iaHome: HOME }, git);
    expect(plan.repos).toHaveLength(3);
    for (const repo of plan.repos) {
      expect(repo.refused).toBeNull();
      expect(repo.steps.map((step) => step.writesTo)).toEqual(['repo', 'repo', 'none']);
      expect(repo.deferred.map(displayFix)).toEqual(['ia host claude --user --apply']);
    }
    expect(plan.deferred.map(displayFix)).toEqual(['ia host claude --user --apply']);
  });
  it('branch names: versioned and plain', () => {
    expect(branchFor(upgrade(alpha))).toBe('chore/ia-3-5-1');
    expect(branchFor(relock(alpha))).toBe('chore/ia-fix-generation');
    expect(branchFor(offer('ia-relock', [ia(['validate'])]))).toBe('chore/ia-relock');
    expect(branchFor(offer('kit-update:acme/kit', [ia(['validate'])]))).toBe('chore/ia-kit-update-acme-kit');
  });
  it('worktree path default and configured', () => {
    const plan = planBatch('upgrade', rows, new Set([0]), { iaHome: HOME }, git);
    expect(plan.repos[0]).toMatchObject({
      root: alpha,
      top: alpha,
      branch: 'chore/ia-3-5-1',
      worktree: native('srv', 'repos', '.ia-worktrees', 'alpha-ia-3-5-1'),
      workspace: native('srv', 'repos', '.ia-worktrees', 'alpha-ia-3-5-1'),
    });
    const configured = planBatch(
      'upgrade',
      rows,
      new Set([0]),
      { iaHome: HOME, worktreeRoot: native('work', 'trees') },
      git,
    );
    expect(configured.repos[0]?.worktree).toBe(native('work', 'trees', 'alpha-ia-3-5-1'));
  });
  it('a worktree root inside the IA home is refused', () => {
    const plan = planBatch('upgrade', rows, new Set([0]), { iaHome: HOME, worktreeRoot: join(HOME, 'trees') }, git);
    expect(plan.repos[0]?.refused).toMatch(/inside the IA home/);
    const relative = planBatch('upgrade', rows, new Set([0]), { iaHome: HOME, worktreeRoot: 'trees' }, git);
    expect(relative.repos[0]?.refused).toMatch(/absolute/);
  });
  it('a worktree path inside the batched repository is refused', () => {
    const plan = planBatch('upgrade', rows, new Set([0]), { iaHome: HOME, worktreeRoot: join(alpha, 'trees') }, git);
    expect(plan.repos[0]?.refused).toMatch(/inside the repository/);
  });
  it('a workspace in a subfolder: the worktree workspace is <worktree>/<relative>', () => {
    const top = native('srv', 'repos', 'mono');
    const root = join(top, 'packages', 'notes');
    const plan = planBatch(
      'fix:generation',
      [row(root, [relock(root)])],
      new Set([0]),
      { iaHome: HOME },
      tops({ [root]: top }),
    );
    const worktree = native('srv', 'repos', '.ia-worktrees', 'mono-ia-fix-generation');
    expect(plan.repos[0]).toMatchObject({
      top,
      worktree,
      workspace: join(worktree, 'packages', 'notes'),
      refused: null,
    });
    expect(plan.repos[0]?.steps[0]?.argv).toEqual([
      'restore',
      '--apply',
      '--root',
      join(worktree, 'packages', 'notes'),
    ]);
  });
  it('a root outside any git repository refuses that repo', () => {
    const plan = planBatch('upgrade', rows, new Set([0, 1]), { iaHome: HOME }, tops({ [beta]: beta }));
    expect(plan.repos[0]?.refused).toMatch(/not inside a git repository/);
    expect(plan.repos[1]?.refused).toBeNull();
  });
  it('rows that do not offer the batch, or are not selected, are left out', () => {
    const plan = planBatch(
      'upgrade',
      [row(alpha, [relock(alpha)]), ...rows.slice(1)],
      new Set([0, 1]),
      { iaHome: HOME },
      git,
    );
    expect(plan.repos.map((repo) => repo.root)).toEqual([beta]);
  });
});

describe('rebaseStep', () => {
  const from = '/srv/repos/alpha',
    to = '/srv/repos/.ia-worktrees/alpha-ia-relock';
  const map = { from, to, cwd: to };
  const rebased = (step: Step, at = map) => {
    const result = rebaseStep(step, at, 'linux');
    if ('refused' in result) throw new Error(result.refused);
    return result.step.argv;
  };
  const refused = (step: Step, at = map): string => {
    const result = rebaseStep(step, at, 'linux');
    if (!('refused' in result)) throw new Error(`not refused: ${result.step.argv.join(' ')}`);
    return result.refused;
  };
  it('recover --root <original> becomes --root <worktree workspace>', () => {
    expect(rebased(ia(['recover', '--root', from]))).toEqual(['recover', '--root', to]);
  });
  it('--root=<original> form, mixed slashes and drive-letter case on win32 all match', () => {
    const win = {
      from: 'C:\\Repos\\Alpha',
      to: 'C:\\Repos\\.ia-worktrees\\alpha-x',
      cwd: 'C:\\Repos\\.ia-worktrees\\alpha-x',
    };
    for (const spelled of ['--root=C:\\Repos\\Alpha', '--root=c:/repos/alpha', '--root=C:/Repos\\Alpha\\']) {
      const result = rebaseStep(ia(['recover', spelled]), win, 'win32');
      expect('step' in result && result.step.argv).toEqual(['recover', '--root=C:\\Repos\\.ia-worktrees\\alpha-x']);
    }
    const nested = rebaseStep(ia(['recover', '--root', 'c:\\REPOS\\alpha\\Sub']), win, 'win32');
    expect('step' in nested && nested.step.argv).toEqual([
      'recover',
      '--root',
      'C:\\Repos\\.ia-worktrees\\alpha-x\\Sub',
    ]);
  });
  it('an ancestor manifest --prefix inside the repository maps; one above the repository refuses the repo', () => {
    const at = { from, to, cwd: `${to}/packages/notes` };
    expect(rebased(external(['npm', 'install', '-D', '--prefix', from, '@inventarch/cli@3.5.1']), at)).toEqual([
      'npm',
      'install',
      '-D',
      '--prefix',
      to,
      '@inventarch/cli@3.5.1',
    ]);
    expect(refused(external(['npm', 'install', '--prefix', '/srv/repos']), at)).toBe(
      'step names a path outside the worktree: /srv/repos',
    );
    expect(rebased(external(['pnpm', `--dir=${from}/packages`, 'install']), at)).toEqual([
      'pnpm',
      `--dir=${to}/packages`,
      'install',
    ]);
    expect(rebased(external(['yarn', '--cwd', from, 'add', '-D', '@inventarch/cli@3.5.1']), at)[2]).toBe(to);
  });
  it('a path outside the repo refuses, for each path-bearing option and for a positional', () => {
    const options = [
      ['install', 'acme/kit', '--plan-out', '/srv/elsewhere/plan.json'],
      ['install', 'acme/kit', '--catalog', '/srv/elsewhere/catalog.json'],
      ['restore', '--apply', '--catalog', '/srv/elsewhere/c.json'],
      ['project', 'claude', '--out', '/srv/elsewhere'],
      ['recover', '--root', '/srv/elsewhere'],
      ['init', '/srv/elsewhere'],
    ];
    for (const argv of options)
      expect(refused(ia(argv))).toMatch(/^step names a path outside the worktree: \/srv\/elsewhere/);
  });
  it('relative traversal refuses from a workspace at the top level and from a subfolder', () => {
    const cases: readonly Step[] = [
      ia(['recover', '--root', '../../other']),
      ia(['project', 'claude', '--out', '../x']),
      ia(['install', 'acme/kit', '--plan-out', '../../x.json']),
      external(['pnpm', '--dir', '../..', 'install']),
    ];
    for (const step of cases) expect(refused(step)).toMatch(/outside the worktree/);
    const sub = { from, to, cwd: `${to}/a/b` };
    expect(refused(ia(['recover', '--root', '../../../other']), sub)).toMatch(/outside the worktree/);
    expect(rebased(ia(['project', 'claude', '--out', '../x']), sub)).toEqual([
      'project',
      'claude',
      '--out',
      `${to}/a/x`,
    ]);
    expect(rebased(ia(['install', 'acme/kit', '--plan-out', '../../x.json']), sub)).toEqual([
      'install',
      'acme/kit',
      '--plan-out',
      `${to}/x.json`,
    ]);
    expect(refused(external(['pnpm', '--dir', '../../..', 'install']), sub)).toMatch(/outside the worktree/);
    expect(rebased(external(['pnpm', '--dir', '../..', 'install']), sub)).toEqual(['pnpm', '--dir', to, 'install']);
  });
  it('a relative path inside the destination is resolved against the worktree workspace, not the original checkout', () => {
    expect(rebased(ia(['install', 'acme/kit', '--plan-out', 'reports/x.json']))).toEqual([
      'install',
      'acme/kit',
      '--plan-out',
      `${to}/reports/x.json`,
    ]);
  });
  it('an unmarked absolute token or a token with a .. segment is examined too, but a scheme URL that holds .. is not', () => {
    expect(pathArguments(ia(['install', '/srv/elsewhere/kit'])).map((entry) => entry.value)).toEqual([
      '/srv/elsewhere/kit',
    ]);
    expect(refused(ia(['install', '/srv/elsewhere/kit']))).toMatch(/outside the worktree/);
    expect(refused(ia(['install', 'acme/../../../kit']))).toMatch(/outside the worktree/);
    expect(rebased(ia(['install', `${from}/kits/a`]))).toEqual(['install', `${to}/kits/a`]);
    expect(rebased(external(['npm', 'install', 'https://example.test/a/../b.tgz']))).toEqual([
      'npm',
      'install',
      'https://example.test/a/../b.tgz',
    ]);
    expect(pathArguments(external(['npm', 'install', 'https://example.test/a/../b.tgz']))).toEqual([]);
  });
  it('mixed-domain values: a URL or an identifier is unchanged, a path spelling is rebased', () => {
    const https = 'https://example.test/registry';
    expect(rebased(ia(['install', 'acme/kit', '--registry', https]))).toEqual([
      'install',
      'acme/kit',
      '--registry',
      https,
    ]);
    expect(rebased(ia(['install', 'acme/kit', `--registry=${https}`]))).toEqual([
      'install',
      'acme/kit',
      `--registry=${https}`,
    ]);
    const seat = 'floor/definition/system/agent-system';
    expect(rebased(ia(['position', '--seat', seat]))).toEqual(['position', '--seat', seat]);
    expect(pathArguments(ia(['position', '--seat', seat]))).toEqual([
      { index: 2, value: seat, form: 'separate', kind: 'name' },
    ]);
    expect(rebased(ia(['install', 'acme/kit', '--registry', './registry']))).toEqual([
      'install',
      'acme/kit',
      '--registry',
      `${to}/registry`,
    ]);
    expect(rebased(ia(['install', 'acme/kit', '--registry', `${from}/registry`]))).toEqual([
      'install',
      'acme/kit',
      '--registry',
      `${to}/registry`,
    ]);
    expect(rebased(ia(['install', 'acme/kit', '--registry', `file://${from}/registry`]))).toEqual([
      'install',
      'acme/kit',
      '--registry',
      `${to}/registry`,
    ]);
    expect(refused(ia(['install', 'acme/kit', '--registry', '../../elsewhere']))).toMatch(/outside the worktree/);
    expect(refused(ia(['position', '--seat', '../../x.ia']))).toMatch(/outside the worktree/);
  });
  it('the rewritten registry value is one the real registry parser accepts', () => {
    const top = native('srv', 'repos', 'alpha'),
      worktree = native('srv', 'repos', '.ia-worktrees', 'alpha-x');
    const at = { from: top, to: worktree, cwd: worktree };
    const values = ['./registry', join(top, 'registry'), pathToFileURL(join(top, 'registry')).href];
    for (const value of values) {
      const result = rebaseStep(ia(['install', 'acme/kit', '--registry', value]), at);
      if ('refused' in result) throw new Error(result.refused);
      const rewritten = result.step.argv[3]!;
      expect(rewritten.startsWith('file:')).toBe(false);
      expect(parseRegistryBase(rewritten, worktree)).toEqual({ kind: 'dir', path: join(worktree, 'registry') });
      expect(result.step.argv.some((token) => token.startsWith('file:'))).toBe(false);
    }
    const https = rebaseStep(ia(['install', 'acme/kit', '--registry', 'https://example.test/registry']), at);
    expect('step' in https && parseRegistryBase(https.step.argv[3]!, worktree).kind).toBe('https');
  });
  it('no returned token is inside the original, and every path-bearing value is inside the worktree', () => {
    const steps: readonly Step[] = [
      ia(['recover', '--root', from]),
      ia(['restore', '--apply', `--root=${from}`, '--catalog', `${from}/c.json`]),
      external(['npm', 'install', '-D', '--prefix', from, '@inventarch/cli@3.5.1']),
      ia(['install', 'acme/kit', '--registry', `file://${from}/r`, '--plan-out', 'p.json']),
    ];
    for (const step of steps) {
      const result = rebaseStep(step, map, 'linux');
      if ('refused' in result) throw new Error(result.refused);
      for (const token of result.step.argv) expect(token.includes(from)).toBe(false);
      for (const entry of pathArguments(result.step))
        if (entry.kind !== 'name') expect(entry.value.startsWith(to)).toBe(true);
    }
  });
});

describe('the grammar marks', () => {
  const PATHS = ['<file>', '<path>', '<directory>', '<dir>', '<plugin-directory>'];
  const MIXED = ['<url|dir>', '<id|path>'];
  it('every option with a path placeholder is marked path, mixed-domain ones as maybe', () => {
    const options: OptionSpec[] = COMMANDS.flatMap((command) => [...command.grammar.options]);
    expect(options.some((entry) => entry.name === 'registry')).toBe(true);
    for (const entry of options) {
      const expected = PATHS.includes(entry.placeholder ?? '')
        ? 'always'
        : MIXED.includes(entry.placeholder ?? '')
          ? 'maybe'
          : undefined;
      expect([entry.name, entry.path]).toEqual([entry.name, expected]);
    }
  });
  it('init, validate and format take paths from their first positional, workspaces from its second', () => {
    const from = (name: string) => COMMANDS.find((command) => command.name === name)?.grammar.positionals.path;
    expect(from('init')).toEqual({ from: 0 });
    expect(from('validate')).toEqual({ from: 0 });
    expect(from('format')).toEqual({ from: 0 });
    expect(from('workspaces')).toEqual({ from: 1 });
    expect(from('install')).toBeUndefined();
    expect(pathArguments(ia(['workspaces', 'add', '/srv/x'], 'user'))).toEqual([
      { index: 2, value: '/srv/x', form: 'separate', kind: 'path' },
    ]);
  });
});

describe('one worktree for each planned repository', () => {
  const repoTop = native('srv', 'repos', 'mono');
  const first = join(repoTop, 'one');
  const second = join(repoTop, 'two');
  it('a second workspace in one repository is refused when planning, naming the first', () => {
    const plan = planBatch(
      'fix:generation',
      [row(first, [relock(first)]), row(second, [relock(second)])],
      new Set([0, 1]),
      { iaHome: HOME },
      tops({ [first]: repoTop, [second]: repoTop }),
    );
    expect(plan.repos[0]).toMatchObject({
      root: first,
      refused: null,
      worktree: native('srv', 'repos', '.ia-worktrees', 'mono-ia-fix-generation'),
    });
    expect(plan.repos[1]).toMatchObject({ root: second, worktree: '', workspace: '' });
    expect(plan.repos[1]!.refused).toContain('already planned for');
    expect(plan.repos[1]!.refused).toContain(first);
  });
  it('a first workspace that was refused leaves the worktree free for the next one', () => {
    const outsider = offer('fix:generation', [ia(['restore', '--apply', '--root', native('elsewhere')])]);
    const plan = planBatch(
      'fix:generation',
      [row(first, [outsider]), row(second, [relock(second)])],
      new Set([0, 1]),
      { iaHome: HOME },
      tops({ [first]: repoTop, [second]: repoTop }),
    );
    expect(plan.repos[0]!.refused).toContain('outside the worktree');
    expect(plan.repos[1]!.refused).toBeNull();
  });
  it('two repositories that would share a worktree under one root are refused the same way', () => {
    const left = native('srv', 'left', 'same');
    const right = native('srv', 'right', 'same');
    const plan = planBatch(
      'fix:generation',
      [row(left, [relock(left)]), row(right, [relock(right)])],
      new Set([0, 1]),
      { iaHome: HOME, worktreeRoot: native('work', 'trees') },
      tops({ [left]: left, [right]: right }),
    );
    expect(plan.repos[0]!.refused).toBeNull();
    expect(plan.repos[1]!.refused).toContain('already planned for');
  });
});

describe('a worktree inside an enclosing repository', () => {
  const outer = native('srv', 'outer');
  const inner = join(outer, 'vendor', 'inner');
  const nested = { ...tops({ [inner]: inner }), enclosing: (path: string) => (path.startsWith(outer) ? outer : null) };
  it('the default place is refused, naming the enclosing repository and the way out', () => {
    const plan = planBatch('fix:generation', [row(inner, [relock(inner)])], new Set([0]), { iaHome: HOME }, nested);
    expect(plan.repos[0]!.refused).toContain(`inside the enclosing repository ${outer}`);
    expect(plan.repos[0]!.refused).toContain('worktreeRoot');
  });
  it('a configured worktreeRoot is the user’s own choice and is not judged', () => {
    const plan = planBatch(
      'fix:generation',
      [row(inner, [relock(inner)])],
      new Set([0]),
      { iaHome: HOME, worktreeRoot: join(outer, 'trees') },
      nested,
    );
    expect(plan.repos[0]).toMatchObject({ refused: null, worktree: join(outer, 'trees', 'inner-ia-fix-generation') });
  });
  it('a repository with nothing around it plans as before', () => {
    const lone = native('srv', 'lone');
    const plan = planBatch(
      'fix:generation',
      [row(lone, [relock(lone)])],
      new Set([0]),
      { iaHome: HOME },
      { ...tops({ [lone]: lone }), enclosing: () => null },
    );
    expect(plan.repos[0]!.refused).toBeNull();
  });
});
