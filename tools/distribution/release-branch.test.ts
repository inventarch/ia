import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inRepository, git } from './release-fixtures.js';

const race = vi.hoisted(() => ({ beforePush: undefined as (() => void) | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      // Advance the remote before push starts, including before its advertisement.
      // A pre-push hook runs too late to distinguish --force from an expected-head lease.
      if (args[0] === 'git' && Array.isArray(args[1]) && args[1][0] === 'push' && race.beforePush) {
        const advance = race.beforePush;
        race.beforePush = undefined;
        advance();
      }
      return actual.execFileSync(...args);
    },
  };
});

it('requires guarded release-branch updates in the workflow', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/release-pr.yml'), 'utf8');
  expect(workflow).not.toContain('git push --force origin');
  expect(workflow).toContain('release-branch.mjs update');
  expect(workflow).not.toContain('--delete-branch');
});

it('preserves foreign branch commits and updates only an identified automation commit', async () => {
  const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
  await inRepository(async (root) => {
    const remote = resolve(root, '.git/test-remote.git');
    await git(root, 'init', '--bare', '--quiet', remote);
    writeFileSync(resolve(root, 'version.txt'), '1.0.0\n');
    await git(root, 'add', 'version.txt');
    await git(root, 'commit', '--quiet', '-m', 'Initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '--quiet', 'origin', 'main');
    await git(root, 'fetch', '--quiet', 'origin');
    const base = await git(root, 'rev-parse', 'HEAD');
    const stage = async (version: string) => {
      writeFileSync(resolve(root, 'version.txt'), version + '\n');
      await git(root, 'add', 'version.txt');
    };
    await stage('1.1.0');
    const first = updateReleaseBranch(root, '1.1.0');
    expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(first.head);
    await git(root, 'switch', '--detach', base);
    await stage('1.2.0');
    const second = updateReleaseBranch(root, '1.2.0');
    expect(second.previous).toBe(first.head);
    // A maintainer's generated amendment is a distinct commit and must survive the next update attempt.
    await stage('human amendment');
    await git(root, 'commit', '--quiet', '-m', 'Maintain generated assets');
    await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/release/next');
    const human = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', '--detach', base);
    await stage('1.3.0');
    expect(() => updateReleaseBranch(root, '1.3.0')).toThrow('unrecognized release/next commits');
    expect(() => deleteReleaseBranch(root)).toThrow('unrecognized release/next commits');
    expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(human);
  });
}, 60_000);

it.each(['update', 'delete'] as const)(
  'preserves a concurrent remote amendment before %s push advertisement',
  async (operation) => {
    const { execFileSync } = await import('node:child_process');
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const remote = resolve(root, '.git/remote.git');
      await git(root, 'init', '--bare', '--quiet', remote);
      writeFileSync(resolve(root, 'version.txt'), 'base\n');
      await git(root, 'add', 'version.txt');
      await git(root, 'commit', '--quiet', '-m', 'Base');
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '--quiet', 'origin', 'main');
      await git(root, 'fetch', '--quiet', 'origin');
      const base = await git(root, 'rev-parse', 'HEAD');
      writeFileSync(resolve(root, 'version.txt'), 'release\n');
      await git(root, 'add', 'version.txt');
      const first = updateReleaseBranch(root, '1.0.1');
      const human = await git(
        root,
        'commit-tree',
        `${first.head}^{tree}`,
        '-p',
        first.head,
        '-m',
        'Concurrent maintainer amendment',
      );
      await git(root, 'push', '--quiet', 'origin', `${human}:refs/heads/human-object`);
      await git(root, 'switch', '--quiet', '--detach', base);
      writeFileSync(resolve(root, 'version.txt'), 'next\n');
      await git(root, 'add', 'version.txt');
      race.beforePush = () => {
        execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/release/next', human, first.head], {
          timeout: 10000,
        });
      };
      try {
        expect(() =>
          operation === 'update' ? updateReleaseBranch(root, '1.0.2') : deleteReleaseBranch(root),
        ).toThrow();
        expect(race.beforePush).toBeUndefined();
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(human);
        // The race is gone; a recognized branch can be deleted and repeated deletion is harmless.
        await git(root, '--git-dir', remote, 'update-ref', 'refs/heads/release/next', first.head, human);
        expect(deleteReleaseBranch(root).previous).toBe(first.head);
        expect(deleteReleaseBranch(root).previous).toBe('');
      } finally {
        race.beforePush = undefined;
      }
    });
  },
  60000,
);
