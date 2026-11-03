/**
 * The tracked list (consumer CLI contract §2.16) on a volume that reports no file identity: some network and ReFS
 * volumes on Windows give every directory an inode of 0 (or all ones), which must never make two roots one. `node:fs`
 * is wrapped so the bigint `statSync` reports inode 0 for the directories a test names; everything else is the real
 * file system.
 */
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { readTracked, trackWorkspace, untrackWorkspace } from '../src/tracked.js';
import { cleanup, scratch } from './scratch-fixture.js';

const unavailable = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: string, options?: { bigint?: boolean }) => {
    const stat = (fs.statSync as (path: string, options?: object) => unknown)(path, options);
    if (options?.bigint !== true || stat === undefined || !unavailable.has(fs.realpathSync.native(path))) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as object, stat, { ino: 0n });
  }) as typeof fs.statSync;
  return { ...fs, default: { ...fs, statSync }, statSync };
});

afterAll(cleanup);

const NOW = new Date('2026-11-03T12:00:00.000Z');
function workspaceAt(root: string, name: string): string {
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/workspace.ia'), `@workspace ${name}\n`);
  return root;
}

it('two directories whose volume reports inode 0 are two rows, and remove touches only the one named', () => {
  const at = resolve(scratch('tracked-identity-home'), '.ia'),
    parent = scratch('tracked-identity'),
    alpha = workspaceAt(resolve(parent, 'alpha'), 'alpha'),
    beta = workspaceAt(resolve(parent, 'beta'), 'beta');
  for (const root of [alpha, beta]) unavailable.add(realpathSync.native(root));
  expect(statSync(alpha, { bigint: true }).ino).toBe(0n);
  expect(statSync(beta, { bigint: true }).ino).toBe(0n);
  expect(trackWorkspace(at, { root: alpha }, NOW).status).toBe('added');
  expect(trackWorkspace(at, { root: beta }, NOW).status).toBe('added');
  expect(readTracked(at).map((row) => row.id)).toEqual(['alpha', 'beta']);
  // The same directory is still one row: its real path is compared exactly.
  expect(trackWorkspace(at, { root: beta }, NOW).status).toBe('already');
  expect(untrackWorkspace(at, beta, parent).id).toBe('beta');
  expect(readTracked(at).map((row) => row.id)).toEqual(['alpha']);
});
