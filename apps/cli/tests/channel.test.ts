import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { describeChannel, detectChannel, updateInstruction } from '../src/channel.js';
import { cleanup, scratch } from './workspace-fixture.js';

afterAll(cleanup);
const put = (path: string, text = '{}'): void => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

it('reads npm from a node_modules location', () => {
  const pkg = resolve(scratch('chan-npm'), 'lib/node_modules/@inventarch/cli');
  put(resolve(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version: '0.2.0' }));
  const channel = detectChannel(pkg, () => {
    throw new Error('git must not run for npm');
  });
  expect(channel).toEqual({ kind: 'npm', name: '@inventarch/cli', version: '0.2.0' });
  expect(updateInstruction(channel)).toBe('npm i -g @inventarch/cli@latest, then ia host claude --user --apply');
});
it('says unknown when the npm package.json is missing', () => {
  const pkg = resolve(scratch('chan-npm-missing'), 'lib/node_modules/@inventarch/cli');
  mkdirSync(pkg, { recursive: true });
  expect(
    detectChannel(pkg, () => {
      throw new Error('git must not run for npm');
    }),
  ).toMatchObject({ kind: 'unknown' });
});
it('reads a checkout, fork origin included, from local git only', () => {
  const root = scratch('chan-checkout');
  mkdirSync(resolve(root, '.git'));
  put(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  put(resolve(root, 'apps/cli/package.json'));
  const answers: Record<string, string> = {
    'rev-parse HEAD': 'a'.repeat(40),
    'status --porcelain --untracked-files=no': ' M x',
    'config --get remote.origin.url': 'https://github.com/someone/fork.git',
  };
  const channel = detectChannel(resolve(root, 'apps/cli'), (_cwd, args) => answers[args.join(' ')] ?? null);
  expect(channel).toMatchObject({
    kind: 'checkout',
    commit: 'a'.repeat(40),
    dirty: true,
    origin: 'https://github.com/someone/fork.git',
  });
  expect(describeChannel(channel)).toContain('origin https://github.com/someone/fork.git');
});
it('passes the checkout root as cwd to git', () => {
  const root = scratch('chan-cwd');
  mkdirSync(resolve(root, '.git'));
  put(resolve(root, 'pnpm-workspace.yaml'));
  put(resolve(root, 'apps/cli/package.json'));
  const cwds: string[] = [];
  detectChannel(resolve(root, 'apps/cli'), (cwd) => {
    cwds.push(cwd);
    return null;
  });
  expect(cwds.length).toBeGreaterThan(0);
  expect(cwds.every((cwd) => cwd === root)).toBe(true);
});
it('reads a checkout when .git is a worktree file, not a directory', () => {
  const root = scratch('chan-worktree');
  put(resolve(root, '.git'), 'gitdir: elsewhere');
  put(resolve(root, 'pnpm-workspace.yaml'));
  put(resolve(root, 'apps/cli/package.json'));
  const channel = detectChannel(resolve(root, 'apps/cli'), () => null);
  expect(channel).toMatchObject({ kind: 'checkout', root: realpathSync(root) });
});
it('says unknown when apps/cli is not the requested package root', () => {
  const root = scratch('chan-mismatch');
  mkdirSync(resolve(root, '.git'));
  put(resolve(root, 'pnpm-workspace.yaml'));
  put(resolve(root, 'apps/cli/package.json'));
  put(resolve(root, 'apps/other/package.json'));
  const channel = detectChannel(resolve(root, 'apps/other'), () => {
    throw new Error('git must not run when apps/cli does not match');
  });
  expect(channel).toMatchObject({ kind: 'unknown' });
});
it('reports commit, dirty and origin as null when git is unavailable, and says so', () => {
  const root = scratch('chan-nogit');
  mkdirSync(resolve(root, '.git'));
  put(resolve(root, 'pnpm-workspace.yaml'));
  put(resolve(root, 'apps/cli/package.json'));
  const channel = detectChannel(resolve(root, 'apps/cli'), () => null);
  expect(channel).toMatchObject({ kind: 'checkout', commit: null, dirty: null, origin: null });
  expect(describeChannel(channel)).toContain('dirty state unknown');
});
it('says unknown rather than guessing', () => {
  const pkg = resolve(scratch('chan-unknown'), 'cli');
  put(resolve(pkg, 'package.json'));
  expect(detectChannel(pkg, () => null)).toMatchObject({ kind: 'unknown' });
});
