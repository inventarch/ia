import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cliVersionRow } from '../src/doctor-user.js';
import { displayFix } from '../src/fix.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const ID = { id: 'cli-version', section: 'Environment', title: 'CLI version' } as const;
/** The structured fix beside the `npm install` remedy, run where the manifest is. */
const NPM_INSTALL = { program: 'external', argv: ['npm', 'install'], flow: 'confirm', writesTo: 'repo' } as const;
/** A workspace whose manifest pins `range` (none when null), declares `manager`, and installs `installed` (none when null). */
function fixture(
  prefix: string,
  options: { range: string | null; installed: string | null; manager?: string | null },
): { readonly root: string; readonly copy: string } {
  const root = scratch(prefix);
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  const manifest: Record<string, unknown> = {};
  if (options.range !== null) manifest['devDependencies'] = { '@inventarch/cli': options.range };
  if (options.manager !== null) manifest['packageManager'] = options.manager ?? 'npm@10.0.0';
  put(resolve(root, 'package.json'), JSON.stringify(manifest));
  const copy = resolve(root, 'node_modules/@inventarch/cli');
  if (options.installed !== null) {
    put(
      resolve(copy, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: options.installed, bin: { ia: 'dist/main.js' } }),
    );
    put(resolve(copy, 'dist/main.js'), '');
  }
  return { root, copy: options.installed === null ? copy : realpathSync(copy) };
}
const row = (
  root: string,
  packageRoot: string,
  version: string,
  env: Record<string, string | undefined> = {},
  host = false,
) => cliVersionRow({ root, packageRoot, version, env, host });

it('ok: the installed copy is the running copy and satisfies the range', () => {
  const { root, copy } = fixture('cv-ok', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, copy, '3.4.1')).toEqual({
    ...ID,
    status: 'ok',
    detail: "this workspace's copy 3.4.1, CLI dependency ^3.4.0",
    remedy: null,
    fix: null,
  });
});
it('ok: names the global copy that handed off', () => {
  const { root, copy } = fixture('cv-ok-from', { range: '^3.4.0', installed: '3.4.1' });
  const from = scratch('cv-global');
  put(resolve(from, 'package.json'), JSON.stringify({ version: '3.5.0' }));
  expect(row(root, copy, '3.4.1', { IA_HANDOFF_FROM: from })).toMatchObject({
    status: 'ok',
    detail: "this workspace's copy 3.4.1, CLI dependency ^3.4.0; global 3.5.0 handed off",
  });
  expect(row(root, copy, '3.4.1', { IA_HANDOFF_FROM: resolve(from, 'missing') })).toMatchObject({
    detail: "this workspace's copy 3.4.1, CLI dependency ^3.4.0",
  });
});
it('ok: says when the range is not evaluated', () => {
  const { root, copy } = fixture('cv-ok-range', { range: 'workspace:*', installed: '3.4.1' });
  expect(row(root, copy, '3.4.1')).toEqual({
    ...ID,
    status: 'ok',
    detail: "this workspace's copy 3.4.1, CLI dependency workspace:* (range not evaluated)",
    remedy: null,
    fix: null,
  });
});
it('warn: the installed copy does not satisfy the range', () => {
  const { root, copy } = fixture('cv-unsatisfied', { range: '^3.5.0', installed: '3.4.1' });
  expect(row(root, copy, '3.4.1')).toEqual({
    ...ID,
    status: 'warn',
    detail: 'installed 3.4.1 does not satisfy ^3.5.0',
    remedy: 'npm install',
    fix: NPM_INSTALL,
  });
});
it('info: IA_NO_HANDOFF=1 runs a copy that is not the workspace one', () => {
  const { root } = fixture('cv-off', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, scratch('cv-other'), '3.5.0', { IA_NO_HANDOFF: '1' })).toEqual({
    ...ID,
    status: 'info',
    detail: "running 3.5.0, not this workspace's 3.4.1 (IA_NO_HANDOFF is set)",
    remedy: null,
    fix: null,
  });
});
it('info: doctor --host does not hand off', () => {
  const { root } = fixture('cv-host', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, scratch('cv-other'), '3.5.0', {}, true)).toEqual({
    ...ID,
    status: 'info',
    detail: "running 3.5.0, not this workspace's 3.4.1 (doctor --host does not hand off)",
    remedy: null,
    fix: null,
  });
});
it('info: a committed copy is never handed to', () => {
  const { root, copy } = fixture('cv-committed', { range: '^3.4.0', installed: '3.4.1' });
  const asked: string[] = [];
  const committed = (packageRoot: string) => (asked.push(packageRoot), true);
  expect(
    cliVersionRow({ root, packageRoot: scratch('cv-other'), version: '3.5.0', env: {}, host: false, committed }),
  ).toEqual({
    ...ID,
    status: 'info',
    detail:
      "running 3.5.0, not this workspace's 3.4.1 (the repository commits that copy, so it never runs on a typed command)",
    remedy: null,
    fix: null,
  });
  expect(asked).toEqual([copy]);
});
it('warn: the copy differs and no hand-off was set aside', () => {
  const { root } = fixture('cv-differs', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'warn',
    detail: "running 3.5.0; this workspace's copy is 3.4.1",
    remedy: null,
    fix: null,
  });
});
it('warn: the dependency is listed but not installed', () => {
  const { root } = fixture('cv-missing', { range: '3.5.0', installed: null });
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'warn',
    detail:
      'package.json lists @inventarch/cli 3.5.0, which is not installed between the workspace and it; running 3.5.0',
    remedy: 'npm install',
    fix: NPM_INSTALL,
  });
});
it('info: no CLI dependency', () => {
  const { root } = fixture('cv-none', { range: null, installed: null });
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'info',
    detail: 'no @inventarch/cli dependency; running 3.5.0',
    remedy: 'npm install -D @inventarch/cli@3.5.0',
    fix: {
      program: 'external',
      argv: ['npm', 'install', '-D', '@inventarch/cli@3.5.0'],
      flow: 'confirm',
      writesTo: 'repo',
    },
  });
});
it('names a package-manager conflict and gives no remedy', () => {
  const { root } = fixture('cv-conflict', { range: '3.5.0', installed: null });
  put(resolve(root, 'pnpm-lock.yaml'), '');
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'warn',
    detail:
      'package.json lists @inventarch/cli 3.5.0, which is not installed between the workspace and it; running 3.5.0; package managers disagree: npm, pnpm',
    remedy: null,
    fix: null,
  });
});
it('names an absent package manager and gives no remedy', () => {
  const { root } = fixture('cv-no-manager', { range: '3.5.0', installed: null, manager: null });
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'warn',
    detail:
      'package.json lists @inventarch/cli 3.5.0, which is not installed between the workspace and it; running 3.5.0; no package manager declared or locked',
    remedy: null,
    fix: null,
  });
});
it('pins at a pnpm workspace root with -w', () => {
  const { root } = fixture('cv-pnpm-root', { range: null, installed: null, manager: 'pnpm@10.0.0' });
  put(resolve(root, 'pnpm-workspace.yaml'), 'packages: []');
  expect(row(root, scratch('cv-other'), '3.5.0').remedy).toBe('pnpm add -D -w @inventarch/cli@3.5.0');
});

/** A workspace at `repo/kb` whose CLI dependency is listed, not installed, in the ancestor manifest `repo/package.json`. */
function ancestor(
  prefix: string,
  manager: string,
  ...markers: string[]
): { readonly root: string; readonly repo: string } {
  const repo = scratch(prefix),
    root = resolve(repo, 'kb');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  put(
    resolve(repo, 'package.json'),
    JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' }, packageManager: manager }),
  );
  for (const marker of markers) put(resolve(repo, marker), '');
  return { root, repo };
}
it('an ancestor manifest keeps its remedy and gets a fix that names its directory', () => {
  const cases = [
    ['npm@10.0.0', [], 'npm install', (repo: string) => ['npm', 'install', '--prefix', repo]],
    ['pnpm@10.0.0', [], 'pnpm install', (repo: string) => ['pnpm', '--dir', repo, 'install']],
    ['yarn@1.22.22', [], 'yarn install', (repo: string) => ['yarn', '--cwd', repo, 'install']],
    ['yarn@4.1.0', ['.yarnrc.yml'], 'yarn install', (repo: string) => ['yarn', '--cwd', repo, 'install']],
  ] as const;
  for (const [manager, markers, remedy, argv] of cases) {
    const { root, repo } = ancestor('cv-ancestor', manager, ...markers);
    const check = row(root, scratch('cv-other'), '3.5.0');
    expect(check.status).toBe('warn');
    expect(check.remedy).toBe(remedy);
    expect(check.fix).toEqual({ program: 'external', argv: argv(repo), flow: 'confirm', writesTo: 'repo' });
    expect(displayFix(check.fix!)).not.toBe(check.remedy);
  }
});
it("at the manifest's own directory remedy === displayFix(fix)", () => {
  const { root } = fixture('cv-own', { range: '3.5.0', installed: null });
  const missing = row(root, scratch('cv-other'), '3.5.0');
  expect(displayFix(missing.fix!)).toBe(missing.remedy);
  const none = fixture('cv-own-pin', { range: null, installed: null, manager: 'pnpm@10.0.0' });
  put(resolve(none.root, 'pnpm-workspace.yaml'), 'packages: []');
  const pin = row(none.root, scratch('cv-other'), '3.5.0');
  expect(pin.fix?.argv).toEqual(['pnpm', 'add', '-D', '-w', '@inventarch/cli@3.5.0']);
  expect(displayFix(pin.fix!)).toBe(pin.remedy);
});
