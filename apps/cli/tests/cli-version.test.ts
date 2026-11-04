import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORE_TOKENS } from '../src/commands.js';
import { collectDoctor } from '../src/doctor.js';
import { cliVersionRow } from '../src/doctor-user.js';
import { handoffTarget } from '../src/handoff.js';
import { resolveWorkspaceCli } from '../src/local-cli.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const ID = { id: 'cli-version', section: 'Environment', title: 'CLI version' } as const;
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
  });
});
it('warn: the installed copy does not satisfy the range', () => {
  const { root, copy } = fixture('cv-unsatisfied', { range: '^3.5.0', installed: '3.4.1' });
  expect(row(root, copy, '3.4.1')).toEqual({
    ...ID,
    status: 'warn',
    detail: 'installed 3.4.1 does not satisfy ^3.5.0',
    remedy: 'npm install',
  });
});
it('info: IA_NO_HANDOFF=1 runs a copy that is not the workspace one', () => {
  const { root } = fixture('cv-off', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, scratch('cv-other'), '3.5.0', { IA_NO_HANDOFF: '1' })).toEqual({
    ...ID,
    status: 'info',
    detail: "running 3.5.0, not this workspace's 3.4.1 (IA_NO_HANDOFF is set)",
    remedy: null,
  });
});
it('info: doctor --host does not hand off', () => {
  const { root } = fixture('cv-host', { range: '^3.4.0', installed: '3.4.1' });
  expect(row(root, scratch('cv-other'), '3.5.0', {}, true)).toEqual({
    ...ID,
    status: 'info',
    detail: "running 3.5.0, not this workspace's 3.4.1 (doctor --host does not hand off)",
    remedy: null,
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
  });
});
it('info: no CLI dependency', () => {
  const { root } = fixture('cv-none', { range: null, installed: null });
  expect(row(root, scratch('cv-other'), '3.5.0')).toEqual({
    ...ID,
    status: 'info',
    detail: 'no @inventarch/cli dependency; running 3.5.0',
    remedy: 'npm install -D @inventarch/cli@3.5.0',
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
  });
});
it('pins at a pnpm workspace root with -w', () => {
  const { root } = fixture('cv-pnpm-root', { range: null, installed: null, manager: 'pnpm@10.0.0' });
  put(resolve(root, 'pnpm-workspace.yaml'), 'packages: []');
  expect(row(root, scratch('cv-other'), '3.5.0').remedy).toBe('pnpm add -D -w @inventarch/cli@3.5.0');
});

/** `repo` is a workspaces root listing `packages/*`; `packages/x` pins the CLI and holds the IA root. */
function hoisted(prefix: string, options: { installed: string | null; lock?: string; workspaces?: string[] }) {
  const repo = scratch(prefix);
  put(resolve(repo, 'package.json'), JSON.stringify({ workspaces: options.workspaces ?? ['packages/*'] }));
  if (options.lock !== undefined) put(resolve(repo, options.lock), '');
  const member = resolve(repo, 'packages/x');
  put(resolve(member, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
  mkdirSync(resolve(member, '.ia/src'), { recursive: true });
  const copy = resolve(repo, 'node_modules/@inventarch/cli');
  if (options.installed !== null) {
    put(
      resolve(copy, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: options.installed, bin: { ia: 'dist/main.js' } }),
    );
    put(resolve(copy, 'dist/main.js'), '');
  }
  return { repo, member, copy: options.installed === null ? copy : realpathSync(copy) };
}
it("a hoisted copy is reported as this workspace's copy", () => {
  const { member, copy } = hoisted('cv-hoisted', { installed: '3.5.0' });
  expect(row(member, copy, '3.5.0')).toMatchObject({
    status: 'ok',
    detail: "this workspace's copy 3.5.0, CLI dependency 3.5.0; no package manager declared or locked",
  });
});
it('the manager is detected at the workspaces root', () => {
  const { repo, member } = hoisted('cv-hoisted-pm', { installed: null, lock: 'package-lock.json' });
  const check = row(member, scratch('cv-other'), '3.5.0');
  expect(check.status).toBe('warn');
  expect(check.remedy).toBe(`In ${repo}: npm install`);
  expect(check.detail).toContain(`between the workspace and ${repo.replaceAll('\\', '/')}`);
});
describe('doctor names the copy hand-off runs', () => {
  const running = scratch('cv-tie-running');
  const iaHome = resolve(scratch('cv-tie-home'), '.ia');
  const copyAt = (dir: string): string => {
    const copy = resolve(dir, 'node_modules/@inventarch/cli');
    put(
      resolve(copy, 'package.json'),
      JSON.stringify({ name: '@inventarch/cli', version: '3.5.0', bin: { ia: 'dist/main.js' } }),
    );
    put(resolve(copy, 'dist/main.js'), '');
    return realpathSync(copy);
  };
  /** Each layout gives the IA root and the copy both must name, or null when neither may name one. */
  const layouts: [string, () => { root: string; expected: string | null }][] = [
    [
      'the workspace pins and installs it',
      () => {
        const { root, copy } = fixture('cv-tie-own', { range: '3.5.0', installed: '3.5.0' });
        return { root, expected: copy };
      },
    ],
    [
      'a workspaces root hoists it',
      () => {
        const { member, copy } = hoisted('cv-tie-hoisted', { installed: '3.5.0' });
        return { root: member, expected: copy };
      },
    ],
    [
      'the member installs its own beside a hoisted one',
      () => {
        const { member } = hoisted('cv-tie-nested', { installed: '3.5.0' });
        return { root: member, expected: copyAt(member) };
      },
    ],
    [
      'a parent root that does not list the member',
      () => {
        const { member } = hoisted('cv-tie-unrelated', { installed: '3.5.0', workspaces: ['apps/*'] });
        return { root: member, expected: null };
      },
    ],
    [
      'a parent root that lists the member only through braces',
      () => {
        const { member } = hoisted('cv-tie-braces', { installed: '3.5.0', workspaces: ['packages/{x,y}'] });
        return { root: member, expected: null };
      },
    ],
  ];
  it('through a linked --root, doctor reads the workspace at its real path, as hand-off does', () => {
    // The pin and the copy sit above the link's real target, not above the link. A junction needs no privilege on
    // Windows; elsewhere the type is ignored and a directory symlink is made.
    const repo = scratch('cv-tie-link');
    put(resolve(repo, 'package.json'), JSON.stringify({ devDependencies: { '@inventarch/cli': '3.5.0' } }));
    const copy = copyAt(repo);
    const real = resolve(repo, 'ws');
    mkdirSync(resolve(real, '.ia/src'), { recursive: true });
    const link = resolve(scratch('cv-tie-link-alias'), 'ws');
    symlinkSync(real, link, 'junction');
    const handedTo = handoffTarget({
      argv: ['validate', '--root', link],
      cwd: scratch('cv-tie-link-cwd'),
      env: {},
      packageRoot: running,
      iaHome,
      extensions: [],
      coreTokens: CORE_TOKENS,
      committed: () => false,
    });
    expect(handedTo?.packageRoot).toBe(copy);
    const view = collectDoctor({
      cwd: scratch('cv-tie-link-cwd'),
      root: link,
      packageRoot: running,
      version: '3.6.0',
      runtime: { version: '22.22.0', platform: process.platform, arch: process.arch },
      env: { IA_HOME: iaHome },
      home: scratch('cv-tie-link-home'),
    });
    expect(view.checks.find((check) => check.id === 'cli-version')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining("running 3.6.0; this workspace's copy is 3.5.0"),
    });
  });
  it.each(layouts)('%s', (_name, layout) => {
    const { root, expected } = layout();
    expect(resolveWorkspaceCli(root).local?.packageRoot ?? null).toBe(expected);
    const handedTo = handoffTarget({
      argv: ['validate'],
      cwd: root,
      env: {},
      packageRoot: running,
      iaHome,
      extensions: [],
      coreTokens: CORE_TOKENS,
      committed: () => false,
    });
    expect(handedTo?.packageRoot ?? null).toBe(expected);
    const asked: string[] = [];
    const committed = (packageRoot: string) => (asked.push(packageRoot), true);
    const check = cliVersionRow({ root, packageRoot: running, version: '3.5.0', env: {}, host: false, committed });
    expect(asked).toEqual(expected === null ? [] : [expected]);
    expect(check.status).toBe(expected === null ? 'warn' : 'info');
  });
});
it('an unrelated parent root does not lend its manager', () => {
  const { member } = hoisted('cv-unrelated', { installed: null, lock: 'package-lock.json', workspaces: ['apps/*'] });
  const check = row(member, scratch('cv-other'), '3.5.0');
  expect(check.remedy).toBeNull();
  expect(check.detail).toContain('no package manager declared or locked');
  expect(check.detail).toContain('package.json lists @inventarch/cli 3.5.0');
});
