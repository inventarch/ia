import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findLocalCli, installRoot, ownsMember, pnpmPackages, readCliDependency } from '../src/local-cli.js';
import { detectPackageManager, installCommand, pinCommand, satisfies } from '../src/package-manager.js';
import type { PackageManager } from '../src/package-manager.js';
import { cleanup, scratch } from './scratch-fixture.js';

afterAll(cleanup);
const put = (path: string, text: string): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const putJson = (path: string, value: unknown): void => put(path, JSON.stringify(value));
const cliCopy = (base: string, manifest: Record<string, unknown> = {}): string => {
  const dir = resolve(base, 'node_modules/@inventarch/cli');
  putJson(resolve(dir, 'package.json'), {
    name: '@inventarch/cli',
    version: '3.5.0',
    bin: { ia: 'dist/main.js' },
    ...manifest,
  });
  put(resolve(dir, 'dist/main.js'), '');
  return dir;
};
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
};

describe('findLocalCli', () => {
  it('finds the copy two directories up', () => {
    const base = scratch('local-up');
    const dir = cliCopy(base);
    const found = findLocalCli(resolve(base, 'a/b'), base);
    expect(found).toMatchObject({ version: '3.5.0' });
    expect(found?.entry).toBe(resolve(found?.packageRoot ?? '', 'dist/main.js'));
    expect(found?.packageRoot.toLowerCase()).toBe(dir.toLowerCase());
  });
  it('accepts a string bin', () => {
    const base = scratch('local-string-bin');
    const dir = cliCopy(base);
    putJson(resolve(dir, 'package.json'), { name: '@inventarch/cli', version: '3.5.0', bin: 'dist/main.js' });
    expect(findLocalCli(base, base)).toMatchObject({ version: '3.5.0' });
  });
  it('null when absent', () => {
    expect(findLocalCli(scratch('local-absent'), scratch('local-absent-stop'))).toBeNull();
  });
  it('null when entry missing', () => {
    const base = scratch('local-no-entry');
    const dir = cliCopy(base);
    putJson(resolve(dir, 'package.json'), { name: '@inventarch/cli', version: '3.5.0', bin: { ia: 'dist/gone.js' } });
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('null when name differs', () => {
    const base = scratch('local-name');
    cliCopy(base, { name: 'not-the-cli' });
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('null for malformed JSON', () => {
    const base = scratch('local-malformed');
    put(resolve(base, 'node_modules/@inventarch/cli/package.json'), '{');
    expect(findLocalCli(base, base)).toBeNull();
  });
  it('stops at the first node_modules/@inventarch/cli', () => {
    const base = scratch('local-first');
    cliCopy(base);
    cliCopy(resolve(base, 'pkg'), { name: 'wrong' });
    expect(findLocalCli(resolve(base, 'pkg'), base)).toBeNull();
  });
  it('stops the walk at the pinning manifest', () => {
    const base = scratch('local-stop');
    cliCopy(base);
    expect(findLocalCli(resolve(base, 'pkg'), resolve(base, 'pkg'))).toBeNull();
  });
});

describe('installRoot', () => {
  /** `repo/packages/x` pins the CLI; `repo/node_modules` holds the copy; `repo` declares `workspaces`. */
  const layout = (name: string, workspaces: unknown): { repo: string; member: string } => {
    const repo = scratch(name);
    putJson(resolve(repo, 'package.json'), { workspaces });
    cliCopy(repo);
    const member = resolve(repo, 'packages/x');
    putJson(resolve(member, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    mkdirSync(resolve(member, '.ia/src'), { recursive: true });
    return { repo, member };
  };
  it('an npm workspaces root that lists the member owns its hoisted copy', () => {
    const { repo, member } = layout('root-npm', ['packages/*']);
    expect(installRoot(member)).toBe(repo);
    expect(findLocalCli(member, installRoot(member))).toMatchObject({ version: '3.5.0' });
  });
  it('a parent workspaces root that does not list the member does not own it', () => {
    const { member } = layout('root-unrelated', ['apps/*']);
    expect(installRoot(member)).toBe(member);
    expect(findLocalCli(member, installRoot(member))).toBeNull();
  });
  it('a manifest above the IA root still finds its copy', () => {
    const base = scratch('root-above');
    putJson(resolve(base, 'packages/x/package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    cliCopy(resolve(base, 'packages/x'));
    const project = resolve(base, 'packages/x/project');
    mkdirSync(resolve(project, '.ia/src'), { recursive: true });
    const manifest = resolve(base, 'packages/x');
    expect(installRoot(manifest)).toBe(manifest);
    expect(findLocalCli(project, installRoot(manifest))).toMatchObject({ version: '3.5.0' });
  });
  it('yarn object form and pnpm-workspace.yaml own their members', () => {
    const yarn = layout('root-yarn', { packages: ['packages/*'], nohoist: [] });
    expect(installRoot(yarn.member)).toBe(yarn.repo);
    const pnpm = layout('root-pnpm', undefined);
    put(
      resolve(pnpm.repo, 'pnpm-workspace.yaml'),
      'onlyBuiltDependencies:\n  - esbuild\npackages:\n  - \'apps/*\'\n  # a comment\n  - "packages/*"\n  - tools\nother:\n  - nope\n',
    );
    expect(installRoot(pnpm.member)).toBe(pnpm.repo);
    const outside = layout('root-pnpm-out', undefined);
    put(resolve(outside.repo, 'pnpm-workspace.yaml'), 'other:\n  - packages/*\npackages:\n  - apps/*\n');
    expect(installRoot(outside.member)).toBe(outside.member);
  });
  it('a pinning directory that is itself a workspace root keeps its own boundary', () => {
    const outer = scratch('root-self');
    putJson(resolve(outer, 'package.json'), { workspaces: ['repos/*'] });
    cliCopy(outer);
    const inner = resolve(outer, 'repos/inner');
    putJson(resolve(inner, 'package.json'), {
      workspaces: ['packages/*'],
      devDependencies: { '@inventarch/cli': '3.5.0' },
    });
    expect(installRoot(inner)).toBe(inner);
    expect(findLocalCli(inner, installRoot(inner))).toBeNull();
  });
  it('an unreadable pnpm-workspace.yaml keeps the boundary instead of letting discovery continue', () => {
    const { repo, member } = layout('root-pnpm-unreadable', ['**']);
    const nested = resolve(repo, 'repo');
    // a directory named pnpm-workspace.yaml exists but cannot be read as a file
    mkdirSync(resolve(nested, 'pnpm-workspace.yaml'), { recursive: true });
    const deep = resolve(nested, 'packages/x');
    putJson(resolve(deep, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    expect(installRoot(deep)).toBe(deep);
    expect(installRoot(member)).toBe(repo);
  });
  it('a plain pnpm scalar keeps its whole text, so a copy or an archive suffix is another path', () => {
    for (const [name, line] of [
      ['copy', '  - packages/x copy'],
      ['hash', '  - packages/x#archive'],
    ] as const) {
      const { repo, member } = layout(`root-pnpm-scalar-${name}`, undefined);
      put(resolve(repo, 'pnpm-workspace.yaml'), `packages:\n${line}\n`);
      expect(installRoot(member)).toBe(member);
    }
    const { repo, member } = layout('root-pnpm-comment', undefined);
    put(resolve(repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/x   # the one\n');
    expect(installRoot(member)).toBe(repo);
  });
  it('a single-quoted pnpm scalar decodes doubled quotes and never truncates to a prefix', () => {
    const quoted = layout('root-pnpm-sq', undefined);
    const apostrophe = resolve(quoted.repo, "packages/x's");
    putJson(resolve(apostrophe, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    put(resolve(quoted.repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/x''s'\n");
    expect(installRoot(apostrophe)).toBe(quoted.repo);
    expect(installRoot(quoted.member)).toBe(quoted.member);
  });
  it('a double-quoted pnpm scalar decodes its escaped quote and backslash; other escapes are unsupported', () => {
    const { repo, member } = layout('root-pnpm-dq', undefined);
    if (process.platform !== 'win32') {
      // a quote cannot be a directory name on Windows, so the decoded form is only checked elsewhere
      const quote = resolve(repo, 'packages/q"x');
      putJson(resolve(quote, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
      put(resolve(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/q\\"x"\n');
      expect(installRoot(quote)).toBe(repo);
    }
    // an escaped closing quote leaves the scalar open, so it must not truncate to packages/x
    put(resolve(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/x\\"\n');
    expect(installRoot(member)).toBe(member);
    put(resolve(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/\\x78"\n');
    expect(installRoot(member)).toBe(member);
  });
  it('an unsupported pnpm entry owns nothing: continuation lines, block scalars, open quotes, trailing text', () => {
    const cases: [string, string][] = [
      ['continuation', 'packages:\n  - packages/x\n    copy\n'],
      ['block', 'packages:\n  - |\n    packages/x\n'],
      ['unterminated', "packages:\n  - 'packages/x\n"],
      ['trailing', "packages:\n  - 'packages/x' tail\n"],
    ];
    for (const [name, yaml] of cases) {
      const { repo, member } = layout(`root-pnpm-bad-${name}`, undefined);
      const copy = resolve(repo, 'packages/x copy');
      putJson(resolve(copy, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
      put(resolve(repo, 'pnpm-workspace.yaml'), yaml);
      expect(installRoot(member)).toBe(member);
      expect(installRoot(copy)).toBe(copy);
    }
  });
  it('an unindented pnpm list parses', () => {
    const { repo, member } = layout('root-pnpm-flush', undefined);
    put(resolve(repo, 'pnpm-workspace.yaml'), "packages:\n- 'packages/*'\n- apps/*\nother:\n- nope\n");
    expect(installRoot(member)).toBe(repo);
  });
  it('a root that lists the member only through braces does not own it, so the walk stays at the member', () => {
    const { member } = layout('root-braces', ['packages/{x,y}']);
    expect(installRoot(member)).toBe(member);
    expect(findLocalCli(member, installRoot(member))).toBeNull();
  });
  it('only the nearest workspace root is consulted', () => {
    const { repo, member } = layout('root-nearest', ['packages/*']);
    const inner = resolve(repo, 'packages');
    putJson(resolve(inner, 'package.json'), { workspaces: ['other/*'] });
    expect(installRoot(member)).toBe(member);
  });
});

describe('pnpmPackages', () => {
  const list = (...lines: string[]): string[] => pnpmPackages(`packages:\n${lines.map((l) => `  ${l}\n`).join('')}`);
  it('decodes quoted scalars', () => {
    expect(list("- 'packages/x''s'")).toEqual(["packages/x's"]);
    expect(list('- "packages/q\\"x"')).toEqual(['packages/q"x']);
    expect(list('- "packages/a\\\\b"')).toEqual(['packages/a\\b']);
    expect(list("- 'a' # note", '- plain # note', '- "b"')).toEqual(['a', 'plain', 'b']);
  });
  it('drops unsupported entries whole, keeping the supported ones', () => {
    expect(list("- 'packages/x", '- ok')).toEqual(['ok']);
    expect(list('- "packages/x\\"', '- ok')).toEqual(['ok']);
    expect(list('- "packages/\\x78"', '- ok')).toEqual(['ok']);
    expect(list("- 'packages/x' tail", '- ok')).toEqual(['ok']);
    expect(list('- packages/x', '    copy', '- ok')).toEqual(['ok']);
    expect(list('- |', '    packages/x', '- ok')).toEqual(['ok']);
    expect(list('- >', '    packages/x', '- ok')).toEqual(['ok']);
    expect(list('- [packages/x]', '- ok')).toEqual(['ok']);
  });
});

describe('ownsMember', () => {
  it('matches one segment for *, any depth for **, and normalises ./', () => {
    expect(ownsMember(['packages/*'], 'packages/x')).toBe(true);
    expect(ownsMember(['packages/*'], 'packages/x/y')).toBe(false);
    expect(ownsMember(['packages/**'], 'packages/x')).toBe(true);
    expect(ownsMember(['packages/**'], 'packages/x/y')).toBe(true);
    expect(ownsMember(['./packages/*'], 'packages/x')).toBe(true);
    expect(ownsMember(['packages/x/'], 'packages/x')).toBe(true);
    expect(ownsMember(['apps/*'], 'packages/x')).toBe(false);
  });
  it('answers a pathological glob promptly', () => {
    const glob = [...Array(8).fill('**'), 'missing'].join('/');
    const member = Array.from({ length: 20 }, (_, i) => `s${i}`).join('/');
    const started = Date.now();
    expect(ownsMember([glob], member)).toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
  });
  it('answers interleaved globstars promptly, so memoisation is what bounds them', () => {
    const glob = [...Array(9).fill('**/s'), 'missing'].join('/');
    const member = Array(30).fill('s').join('/');
    const started = Date.now();
    expect(ownsMember([glob], member)).toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
  });
  it('answers a run of stars inside one segment promptly', () => {
    const started = Date.now();
    expect(ownsMember([`${'*'.repeat(30)}z`], 'my-repo-project')).toBe(false);
    expect(ownsMember([`packages/${'*'.repeat(30)}z`], 'packages/my-repo-project')).toBe(false);
    expect(ownsMember([`${'*'.repeat(30)}t`], 'my-repo-project')).toBe(true);
    expect(Date.now() - started).toBeLessThan(300);
  });
  it('answers stars between literals promptly, so matching one segment is linear', () => {
    const started = Date.now();
    expect(ownsMember([`${'*a'.repeat(15)}b`], 'a'.repeat(40))).toBe(false);
    expect(ownsMember([`${'*a'.repeat(15)}*`], 'a'.repeat(40))).toBe(true);
    expect(ownsMember([`**/${'*'.repeat(30)}z/**/${'*a'.repeat(15)}b`], Array(20).fill('a'.repeat(30)).join('/'))).toBe(
      false,
    );
    expect(Date.now() - started).toBeLessThan(300);
  });
  it('matches * within a segment as any run of characters', () => {
    expect(ownsMember(['packages/x*'], 'packages/x')).toBe(true);
    expect(ownsMember(['packages/*-cli'], 'packages/ia-cli')).toBe(true);
    expect(ownsMember(['packages/*-cli'], 'packages/ia-cli2')).toBe(false);
    expect(ownsMember(['packages/a*b*c'], 'packages/abbc')).toBe(true);
    expect(ownsMember(['packages/a*b*c'], 'packages/acb')).toBe(false);
    expect(ownsMember(['packages/x.y'], 'packages/xzy')).toBe(false);
  });
  it('drops an entry that uses {, }, ?, [ or ], so it owns nothing, even a member spelled like it', () => {
    for (const glob of ['packages/{x,y}', 'packages/?', 'packages/[x]', 'packages/x}', 'packages/x]']) {
      expect(ownsMember([glob], glob)).toBe(false);
      expect(ownsMember([glob], 'packages/x')).toBe(false);
      expect(ownsMember([glob, 'packages/*'], 'packages/x')).toBe(true);
    }
  });
  it('an excluding entry in an unsupported form may exclude any member, so it owns none', () => {
    expect(ownsMember(['packages/*', '!packages/{y,z}'], 'packages/x')).toBe(false);
    expect(ownsMember(['packages/*', '!packages/[yz]'], 'packages/x')).toBe(false);
    expect(ownsMember(['!packages/{y,z}', 'packages/*'], 'packages/x')).toBe(true);
  });
  it('lets the last matching glob decide, so ! excludes', () => {
    const globs = ['packages/**', '!packages/private'];
    expect(ownsMember(globs, 'packages/x')).toBe(true);
    expect(ownsMember(globs, 'packages/private')).toBe(false);
    expect(ownsMember(['!packages/private', 'packages/**'], 'packages/private')).toBe(true);
  });
});

describe('readCliDependency', () => {
  it('reads a devDependencies CLI dependency', () => {
    const base = scratch('dep-dev');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    expect(readCliDependency(base)).toEqual({
      field: 'devDependencies',
      range: '3.5.0',
      manifest: resolve(base, 'package.json'),
    });
  });
  it('reads a dependencies CLI dependency', () => {
    const base = scratch('dep-prod');
    putJson(resolve(base, 'package.json'), { dependencies: { '@inventarch/cli': '^3.5.0' } });
    expect(readCliDependency(base)).toMatchObject({ field: 'dependencies', range: '^3.5.0' });
  });
  it('null when the nearest package.json has none', () => {
    const base = scratch('dep-none');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    putJson(resolve(base, 'sub/package.json'), { name: 'sub' });
    expect(readCliDependency(resolve(base, 'sub/deeper'))).toBeNull();
  });
  it('null for a malformed nearest package.json', () => {
    const base = scratch('dep-bad');
    put(resolve(base, 'package.json'), '{');
    expect(readCliDependency(base)).toBeNull();
  });
  it('ignores a nested CLI dependency below the root', () => {
    const base = scratch('dep-nested');
    putJson(resolve(base, 'package.json'), { devDependencies: { '@inventarch/cli': '3.5.0' } });
    putJson(resolve(base, 'app/kits/_tools/package.json'), { devDependencies: { '@inventarch/cli': '3.4.1' } });
    expect(readCliDependency(base)).toMatchObject({ range: '3.5.0', manifest: resolve(base, 'package.json') });
  });
});

describe('detectPackageManager', () => {
  const cases: [string, { packageManager?: string; tracked?: string[] }, PackageManager | null][] = [
    ['packageManager field', { packageManager: 'pnpm@11.25.0' }, 'pnpm'],
    ['tracked pnpm-lock.yaml', { tracked: ['pnpm-lock.yaml'] }, 'pnpm'],
    ['tracked yarn.lock', { tracked: ['yarn.lock'] }, 'yarn'],
    ['tracked bun.lockb', { tracked: ['bun.lockb'] }, 'bun'],
    ['tracked package-lock.json', { tracked: ['package-lock.json'] }, 'npm'],
    ['nothing', {}, null],
  ];
  it.each(cases)('detects the package manager: %s', (_name, { packageManager, tracked = [] }, expected) => {
    const base = scratch('pm-table');
    git(base, 'init', '-q');
    putJson(resolve(base, 'package.json'), packageManager ? { packageManager } : {});
    for (const file of tracked) put(resolve(base, file), '');
    if (tracked.length > 0) git(base, 'add', ...tracked);
    expect(detectPackageManager(base)).toEqual({ manager: expected, conflict: [] });
  });
  it('ignores an untracked pnpm-lock.yaml beside a tracked package-lock.json', () => {
    const base = scratch('pm-untracked');
    git(base, 'init', '-q');
    put(resolve(base, 'package-lock.json'), '');
    put(resolve(base, 'pnpm-lock.yaml'), '');
    git(base, 'add', 'package-lock.json');
    expect(detectPackageManager(base)).toEqual({ manager: 'npm', conflict: [] });
  });
  it('reports packageManager pnpm with a tracked package-lock.json as a conflict', () => {
    const base = scratch('pm-conflict');
    git(base, 'init', '-q');
    putJson(resolve(base, 'package.json'), { packageManager: 'pnpm@11.25.0' });
    put(resolve(base, 'package-lock.json'), '');
    git(base, 'add', 'package-lock.json');
    expect(detectPackageManager(base)).toEqual({ manager: null, conflict: ['npm', 'pnpm'] });
  });
  it('counts the lockfiles on disk outside git', () => {
    const base = scratch('pm-no-git');
    put(resolve(base, 'yarn.lock'), '');
    expect(detectPackageManager(base)).toEqual({ manager: 'yarn', conflict: [] });
  });
  it('ignores an unknown packageManager name', () => {
    const base = scratch('pm-unknown');
    putJson(resolve(base, 'package.json'), { packageManager: 'deno@2.0.0' });
    expect(detectPackageManager(base)).toEqual({ manager: null, conflict: [] });
  });
});

it('satisfies: exact true and false, caret, and null for an unevaluated range', () => {
  expect(satisfies('3.5.0', '3.5.0')).toBe(true);
  expect(satisfies('3.5.1', '3.5.0')).toBe(false);
  expect(satisfies('3.5.1', '^3.5.0')).toBe(true);
  expect(satisfies('4.0.0', '^3.5.0')).toBe(false);
  expect(satisfies('3.5.0', 'workspace:*')).toBeNull();
  expect(satisfies('3.5.0', 'latest')).toBeNull();
  expect(satisfies('not a version', '3.5.0')).toBeNull();
});
it('spells install and pin commands', () => {
  // Plain installs: the row asks for one when the lockfile is missing or behind the manifest, which a frozen one refuses.
  expect(installCommand('npm')).toBe('npm install');
  expect(installCommand('pnpm')).toBe('pnpm install');
  expect(installCommand('yarn')).toBe('yarn install');
  expect(installCommand('bun')).toBe('bun install');
  const plain = scratch('pin-plain');
  expect(pinCommand('npm', '3.5.1', plain)).toBe('npm install -D @inventarch/cli@3.5.1');
  expect(pinCommand('pnpm', '3.5.1', plain)).toBe('pnpm add -D @inventarch/cli@3.5.1');
  expect(pinCommand('yarn', '3.5.1', plain)).toBe('yarn add -D @inventarch/cli@3.5.1');
  expect(pinCommand('bun', '3.5.1', plain)).toBe('bun add -d @inventarch/cli@3.5.1');
});
it('adds the workspace-root flag only where the manager refuses without it', () => {
  const pnpmRoot = scratch('pin-pnpm-root');
  writeFileSync(resolve(pnpmRoot, 'pnpm-workspace.yaml'), 'packages: []');
  expect(pinCommand('pnpm', '3.5.1', pnpmRoot)).toBe('pnpm add -D -w @inventarch/cli@3.5.1');
  const classic = scratch('pin-yarn-classic');
  writeFileSync(resolve(classic, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  expect(pinCommand('yarn', '3.5.1', classic)).toBe('yarn add -D -W @inventarch/cli@3.5.1');
  const berry = scratch('pin-yarn-berry');
  writeFileSync(
    resolve(berry, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@4.5.0' }),
  );
  expect(pinCommand('yarn', '3.5.1', berry)).toBe('yarn add -D @inventarch/cli@3.5.1');
  const rc = scratch('pin-yarn-rc');
  writeFileSync(resolve(rc, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(resolve(rc, '.yarnrc.yml'), '');
  expect(pinCommand('yarn', '3.5.1', rc)).toBe('yarn add -D @inventarch/cli@3.5.1');
});
it('takes Yarn 1 -W exactly where installRoot sees a workspaces root', () => {
  const forms: [string, unknown, boolean][] = [
    ['list', ['packages/*'], true],
    ['packages object', { packages: ['packages/*'] }, true],
    ['empty object', {}, false],
    ['nohoist only', { nohoist: ['**'] }, false],
    ['string', 'packages/*', false],
  ];
  for (const [name, workspaces, root] of forms) {
    const repo = scratch(`pin-yarn-${name.replaceAll(' ', '-')}`);
    putJson(resolve(repo, 'package.json'), { workspaces });
    const member = resolve(repo, 'packages/x');
    putJson(resolve(member, 'package.json'), {});
    expect(installRoot(member) === repo, name).toBe(root);
    expect(pinCommand('yarn', '3.5.1', repo), name).toBe(`yarn add -D${root ? ' -W' : ''} @inventarch/cli@3.5.1`);
  }
});
