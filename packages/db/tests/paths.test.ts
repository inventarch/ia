/**
 * `within` on a volume that reports no file identity: some network and ReFS volumes on Windows give every directory an
 * inode of 0 or all ones, which never means "the same directory". `node:fs` is wrapped so the bigint `statSync` reports
 * the inode a test assigns to the directories it names; everything else is the real file system.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { within } from '../src/paths.js';

const assigned = vi.hoisted(() => new Map<string, bigint>());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: string, options?: { bigint?: boolean }) => {
    const stat = (fs.statSync as (path: string, options?: object) => unknown)(path, options);
    if (options?.bigint !== true || stat === undefined) return stat;
    const ino = assigned.get(fs.realpathSync.native(path));
    return ino === undefined
      ? stat
      : Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as object, stat, { ino });
  }) as typeof fs.statSync;
  return { ...fs, default: { ...fs, statSync }, statSync };
});

const created: string[] = [];
afterAll(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});
function folder(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-db-paths-'));
  created.push(path);
  return path;
}

for (const [name, ino] of [
  ['0', 0n],
  ['all ones', 2n ** 64n - 1n],
] as const)
  it(`decides containment by exact real path where the volume reports inode ${name}`, () => {
    const root = folder(),
      home = resolve(root, 'a'),
      sibling = resolve(root, 'ab'),
      inside = resolve(home, 'inside');
    for (const path of [home, sibling, inside]) mkdirSync(path, { recursive: true });
    for (const path of [root, home, sibling, inside]) assigned.set(realpathSync.native(path), ino);
    expect(statSync(home, { bigint: true }).ino).toBe(ino);
    // Raw device and inode would make every one of these the home: each reports the same inode on one device.
    expect(within(home, sibling)).toBe(false);
    expect(within(home, resolve(sibling, 'new'))).toBe(false);
    expect(within(home, root)).toBe(false);
    expect(within(sibling, home)).toBe(false);
    // What really lies inside is inside, existing or not, and a directory is within itself.
    expect(within(home, home)).toBe(true);
    expect(within(home, inside)).toBe(true);
    expect(within(home, resolve(inside, 'new', 'child'))).toBe(true);
    expect(within(root, inside)).toBe(true);
    // One side unidentified is enough to compare real paths.
    assigned.delete(realpathSync.native(sibling));
    expect(within(home, sibling)).toBe(false);
    expect(within(sibling, home)).toBe(false);
    expect(within(root, sibling)).toBe(true);
  });

it('keeps device and inode where the volume reports them', () => {
  const root = folder(),
    home = resolve(root, 'a'),
    sibling = resolve(root, 'ab');
  for (const path of [home, sibling]) mkdirSync(path, { recursive: true });
  expect(statSync(home, { bigint: true }).ino).not.toBe(0n);
  expect(within(home, sibling)).toBe(false);
  expect(within(home, resolve(home, 'new'))).toBe(true);
  expect(within(root, home)).toBe(true);
});
