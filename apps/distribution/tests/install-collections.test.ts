/**
 * A collection install's identity under concurrency and crashes (registry collections reference, "Collection record"):
 * the record and its journal are written inside the installation lock, recovery settles them by whether the
 * activation committed, and a reader never names a collection version that did not commit, except in the one accepted
 * residual case an older CLI can open.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalDistributionJson, INSTALL_PATHS } from '@inventarch/db/distribution';
import type { Dependency, DistributionLock } from '@inventarch/db/distribution';
import { applyInstallation, planInstallation, recoverInstallation } from '../src/install.js';
import type { InstallationPlan } from '../src/install.js';
import type { ExpandedCollection } from '../src/kit-collections.js';
import {
  currentCollections,
  intactCollections,
  KIT_COLLECTIONS,
  KIT_COLLECTIONS_JOURNAL,
} from '../src/kit-collections.js';
import { registryAddCollection } from '../src/registry-build.js';
import { registryChooser } from '../src/registry-config.js';
import { resolveFromRegistries } from '../src/registry-resolve.js';
import { resolveReleases } from '../src/resolve.js';
import { readWorkspaceLock } from '../src/services.js';
import { buildFixtureRegistry } from './registry-fixture.js';

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const ENGINE = '0.1.0';
const workspaceRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ia-install-collections-'));
  made.push(root);
  return root;
};
/**
 * A directory registry with releases x 1 and 2, y 1, z 1 and w 1, and two collections: `acme/kit` (1.0.0 is x ^1 and
 * y ^1; 2.0.0 is x ^2, y ^1 and z ^1) and `acme/same` (1.0.0 and 2.0.0 both x ^1, so both resolve to one lock).
 */
async function registry(): Promise<string> {
  const { dir } = await buildFixtureRegistry([
    { id: 'acme/x', version: '1.0.0' },
    { id: 'acme/x', version: '2.0.0' },
    { id: 'acme/y', version: '1.0.0' },
    { id: 'acme/z', version: '1.0.0' },
    { id: 'acme/w', version: '1.0.0' },
  ]);
  made.push(dir);
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/kit',
    releases: [
      {
        version: '1.0.0',
        withdrawn: false,
        distributions: [
          { id: 'acme/x', range: '^1.0.0' },
          { id: 'acme/y', range: '^1.0.0' },
        ],
      },
      {
        version: '2.0.0',
        withdrawn: false,
        distributions: [
          { id: 'acme/x', range: '^2.0.0' },
          { id: 'acme/y', range: '^1.0.0' },
          { id: 'acme/z', range: '^1.0.0' },
        ],
      },
    ],
  });
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/same',
    releases: ['1.0.0', '2.0.0'].map((version) => ({
      version,
      withdrawn: false,
      distributions: [{ id: 'acme/x', range: '^1.0.0' }],
    })),
  });
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/other',
    releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/w', range: '^1.0.0' }] }],
  });
  return dir;
}
const lockAt = (root: string): DistributionLock | undefined =>
  existsSync(join(root, INSTALL_PATHS.lock)) ? readWorkspaceLock({ root }) : undefined;
/** `ia install <ids>` as distribute.ts plans it: the recorded members of each collection passed for replacement. */
async function plan(
  root: string,
  dir: string,
  ids: readonly string[],
): Promise<{ readonly plan: InstallationPlan; readonly collections: readonly ExpandedCollection[] }> {
  const previous = lockAt(root);
  const requests = new Map((previous?.requests ?? []).map((request) => [request.id, request.range]));
  for (const id of ids) requests.set(id.split('@')[0]!, id.split('@')[1] ?? '*');
  const merged: Dependency[] = [...requests]
    .map(([id, range]) => ({ id, range }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const intact = intactCollections(root);
  const resolution = await resolveFromRegistries({
    allowKits: true,
    root,
    requests: merged,
    engine: ENGINE,
    previous,
    named: ids.map((id) => id.split('@')[0]!),
    choose: registryChooser({ root, env: {}, flag: dir, cwd: root }),
    collectionMembers: new Map([
      ...intact.collections.map((row) => [row.id, row.members.map((member) => member.id)] as const),
      ...intact.unknown.map((row) => [row.id, row.members] as const),
    ]),
  });
  const lock = resolveReleases(resolution.expandedRequests ?? merged, resolution.candidates, ENGINE, previous).lock;
  return { plan: planInstallation(root, lock, 'install'), collections: resolution.expandedCollections ?? [] };
}
async function install(root: string, dir: string, ids: readonly string[], checkpoint?: (name: string) => void) {
  const planned = await plan(root, dir, ids);
  return applyInstallation(planned.plan, {
    collections: planned.collections,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  });
}
const versions = (root: string): readonly string[] =>
  intactCollections(root).collections.map((row) => `${row.id}@${row.version}`);
const read = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
const stopAt = (stage: string) => (name: string) => {
  if (name === stage) throw new Error(`stopped at ${name}`);
};
/** An older CLI's recovery, which ignores the collections journal: the pending journal's own rule, nothing more. */
function olderRecovery(root: string, forward: boolean): void {
  const pending = JSON.parse(read(root, INSTALL_PATHS.pending)!) as {
    beforeActive: string | null;
    beforeLock: string | null;
    afterLock: string;
  };
  if (!forward) {
    writeFileSync(join(root, INSTALL_PATHS.lock), pending.beforeLock ?? '');
    if (pending.beforeActive === null) rmSync(join(root, INSTALL_PATHS.active));
    else writeFileSync(join(root, INSTALL_PATHS.active), pending.beforeActive);
  } else writeFileSync(join(root, INSTALL_PATHS.lock), pending.afterLock);
  rmSync(join(root, INSTALL_PATHS.pending));
}
/**
 * An older CLI's `ia restore` of the unchanged lock: what it commits is the activation pointer this engine plans for
 * that restore (the generation of the same lock, counter one past the current pointer). An older CLI writes no
 * collections journal and reads none, so only the pointer moves.
 */
function olderRestore(root: string): string {
  const pointer = canonicalDistributionJson(planInstallation(root, lockAt(root)!, 'restore').pointer);
  writeFileSync(join(root, INSTALL_PATHS.active), pointer);
  return pointer;
}

it('interleaved writers: a second install refuses while the first holds the lock, and both rows survive in turn', async () => {
  const dir = await registry(),
    root = workspaceRoot();
  const other = await plan(root, dir, ['acme/other']);
  let refused: unknown;
  await install(root, dir, ['acme/kit@^1.0.0'], (name) => {
    if (name !== 'collections') return;
    const before = read(root, KIT_COLLECTIONS);
    try {
      applyInstallation(other.plan, { collections: other.collections });
    } catch (error) {
      refused = error;
    }
    expect(read(root, KIT_COLLECTIONS)).toBe(before);
  });
  expect(refused).toMatchObject({ code: 'IA-DIST-INSTALL-BUSY' });
  expect(versions(root)).toEqual(['acme/kit@1.0.0']);
  await install(root, dir, ['acme/other']);
  expect(versions(root)).toEqual(['acme/kit@1.0.0', 'acme/other@1.0.0']);
});

it.each([
  ['pending', false],
  ['collections-journal', false],
  ['collections', false],
  ['portable-lock', false],
  ['active', true],
  ['collections-journal-removed', true],
] as const)(
  'interruption at %s, then recovery, names exactly what the recovered state holds',
  async (stage, forward) => {
    const dir = await registry(),
      root = workspaceRoot();
    await install(root, dir, ['acme/kit@^1.0.0']);
    await expect(install(root, dir, ['acme/kit@^2.0.0'], stopAt(stage))).rejects.toThrow(`stopped at ${stage}`);
    // While the journal binds the change to an activation not yet settled, no identity counts. Before it is written the
    // record still describes the unchanged lock; after it is removed the activation has committed.
    if (stage !== 'pending' && stage !== 'collections-journal-removed')
      expect(intactCollections(root).collections).toEqual([]);
    expect(recoverInstallation(root)).toMatchObject({ status: 'recovered', committed: forward });
    expect(versions(root)).toEqual([forward ? 'acme/kit@2.0.0' : 'acme/kit@1.0.0']);
    const lock = lockAt(root)!;
    for (const row of intactCollections(root).collections)
      for (const member of row.members)
        expect(lock.packages).toContainEqual(expect.objectContaining({ id: member.id, version: member.version }));
    expect(existsSync(join(root, KIT_COLLECTIONS_JOURNAL))).toBe(false);
  },
);

it('an identical-lock collection upgrade survives a crash', async () => {
  const dir = await registry(),
    root = workspaceRoot();
  await install(root, dir, ['acme/same@1.0.0']);
  const record = read(root, KIT_COLLECTIONS),
    lock = read(root, INSTALL_PATHS.lock);
  // Staged, not activated: interrupted, never 2.0.0; rolled back, 1.0.0 with the record's bytes as they were.
  const upgrade = await plan(root, dir, ['acme/same@2.0.0']);
  expect(canonicalDistributionJson(upgrade.plan.lock)).toBe(lock);
  expect(() =>
    applyInstallation(upgrade.plan, { collections: upgrade.collections, checkpoint: stopAt('collections') }),
  ).toThrow('stopped at collections');
  expect(currentCollections(root).source).toBe('interrupted');
  expect(versions(root)).toEqual([]);
  recoverInstallation(root);
  expect(versions(root)).toEqual(['acme/same@1.0.0']);
  expect(read(root, KIT_COLLECTIONS)).toBe(record);
  // Activated, journal still present: rolled forward, 2.0.0.
  await expect(install(root, dir, ['acme/same@2.0.0'], stopAt('active'))).rejects.toThrow('stopped at active');
  recoverInstallation(root);
  expect(versions(root)).toEqual(['acme/same@2.0.0']);
});

it("an older CLI's immediate recovery is settled by the exact pointer", async () => {
  const dir = await registry(),
    root = workspaceRoot();
  await install(root, dir, ['acme/same@1.0.0']);
  await expect(install(root, dir, ['acme/same@2.0.0'], stopAt('collections'))).rejects.toThrow();
  olderRecovery(root, false);
  expect(currentCollections(root).source).toBe('before');
  expect(versions(root)).toEqual(['acme/same@1.0.0']);
  // The next locked operation of this CLI settles the files and removes the journal.
  await install(root, dir, ['acme/w']);
  expect(existsSync(join(root, KIT_COLLECTIONS_JOURNAL))).toBe(false);
  expect(versions(root)).toEqual(['acme/same@1.0.0']);
});

it('a later older-CLI restore after a committed upgrade makes identity unknown, not 1.0.0', async () => {
  const dir = await registry(),
    root = workspaceRoot();
  await install(root, dir, ['acme/same@1.0.0']);
  await expect(install(root, dir, ['acme/same@2.0.0'], stopAt('active'))).rejects.toThrow();
  olderRecovery(root, true);
  olderRestore(root);
  expect(currentCollections(root).source).toBe('undecided');
  expect(intactCollections(root)).toEqual({
    collections: [],
    unknown: [{ id: 'acme/same', members: ['acme/x'] }],
    problems: [],
  });
  // The reinstall doctor names (`install acme/same`) takes the registry's latest and clears the unknown entry.
  await install(root, dir, ['acme/same']);
  expect(versions(root)).toEqual(['acme/same@2.0.0']);
  expect(intactCollections(root).unknown).toEqual([]);
  expect(existsSync(join(root, KIT_COLLECTIONS_JOURNAL))).toBe(false);
});

/*
 * The accepted residual (registry collections reference, "Collection record"): the activation pointer cannot carry a nonce,
 * since older readers refuse an extra key. So when an older CLI rolls back a staged, identical-lock collection upgrade
 * and then restores the unchanged lock, it recreates the journal's exact `afterActive`, and the reader names the
 * upgraded version. Pins and archives are the same either way. A change that closes the hole updates this test.
 */
it('the accepted residual: an older-CLI restore after a rolled-back upgrade recreates afterActive', async () => {
  const dir = await registry(),
    root = workspaceRoot();
  await install(root, dir, ['acme/same@1.0.0']);
  await expect(install(root, dir, ['acme/same@2.0.0'], stopAt('collections'))).rejects.toThrow();
  const journal = JSON.parse(read(root, KIT_COLLECTIONS_JOURNAL)!) as { afterActive: string };
  olderRecovery(root, false);
  expect(olderRestore(root)).toBe(journal.afterActive);
  expect(versions(root)).toEqual(['acme/same@2.0.0']);
});

it('a restore of an unchanged lock does not rewrite the record', async () => {
  const dir = await registry(),
    root = workspaceRoot();
  await install(root, dir, ['acme/kit@^1.0.0']);
  const before = read(root, KIT_COLLECTIONS),
    stamp = statSync(join(root, KIT_COLLECTIONS)).mtimeMs;
  const stages: string[] = [];
  applyInstallation(planInstallation(root, lockAt(root)!, 'restore'), { checkpoint: (name) => stages.push(name) });
  expect(read(root, KIT_COLLECTIONS)).toBe(before);
  expect(statSync(join(root, KIT_COLLECTIONS)).mtimeMs).toBe(stamp);
  expect(stages).not.toContain('collections-journal');
  expect(existsSync(join(root, KIT_COLLECTIONS_JOURNAL))).toBe(false);
});
