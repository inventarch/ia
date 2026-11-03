/**
 * `ia install <collection>` records the collection's identity beside the lock (registry collections reference,
 * "Collection record"), without changing the lock: the record names the collection and its members' exact pins, a
 * member removed or moved removes the row whole, and re-installing the collection replaces its members.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { canonicalDistributionJson, decodeDistributionLock, INSTALL_PATHS } from '@inventarch/db/distribution';
import { KIT_COLLECTIONS } from '@inventarch/distribution/kit-collections';
import { registryAddCollection } from '@inventarch/distribution/registry-build';
import type { Fix } from '../src/fix.js';
import { confirmedArgv } from '../src/fix.js';
import { buildFixtureRegistry } from './registry-fixture.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup, 120_000);

/** Collection `acme/kit`: 1.0.0 is x ^1 and y ^1; 2.0.0 is x ^2 (a changed range), y ^1 and z ^1 (an added member). */
function registry(): string {
  const dir = buildFixtureRegistry([
    { id: 'acme/x', version: '1.0.0' },
    { id: 'acme/x', version: '2.0.0' },
    { id: 'acme/y', version: '1.0.0' },
    { id: 'acme/z', version: '1.0.0' },
    { id: 'acme/w', version: '1.0.0' },
  ]);
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
  return dir;
}
/**
 * A workspace with no authored records: the fixture releases each carry the public language systems, which an
 * initialized workspace's bundled base already installs under other bytes.
 */
async function workspace(): Promise<string> {
  const root = resolve(scratch('collections'), 'demo');
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  return root;
}
const ia = async (root: string, dir: string, ...argv: string[]) => {
  const result = await run([...argv, '--root', root, '--registry', dir, '--apply', '--yes', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return result;
};
const record = (root: string) =>
  existsSync(join(root, KIT_COLLECTIONS))
    ? (JSON.parse(readFileSync(join(root, KIT_COLLECTIONS), 'utf8')) as {
        collections: { id: string; version: string; members: { id: string; version: string; archive: string }[] }[];
      })
    : null;
const lockText = (root: string): string => readFileSync(join(root, INSTALL_PATHS.lock), 'utf8');

it('install records the collection and its exact pins, and leaves the lock as it always was', async () => {
  const dir = registry(),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/kit@1.0.0');
  // The lock holds no collection identity: the same canonical bytes, keys and rows an install always wrote.
  const text = lockText(root),
    lock = decodeDistributionLock(JSON.parse(text));
  expect(text).toBe(canonicalDistributionJson(lock));
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(['engine', 'formatVersion', 'packages', 'requests']);
  expect(lock.requests.filter((request) => request.id.startsWith('acme/'))).toEqual([
    { id: 'acme/x', range: '^1.0.0' },
    { id: 'acme/y', range: '^1.0.0' },
  ]);
  const pin = (id: string) => lock.packages.find((row) => row.id === id)!;
  expect(record(root)!.collections).toEqual([
    {
      id: 'acme/kit',
      version: '1.0.0',
      registry: dir,
      members: [
        { id: 'acme/x', version: '1.0.0', archive: pin('acme/x').archive },
        { id: 'acme/y', version: '1.0.0', archive: pin('acme/y').archive },
      ],
    },
  ]);
  // An older reader still reads the lock, and validate and doctor stay green with the record present.
  expect(() => decodeDistributionLock(JSON.parse(text), '0.1.2')).not.toThrow();
  expect((await run(['validate', '--root', root, '--json'])).exitCode).toBe(0);
  expect((await run(['doctor', '--root', root, '--json'])).exitCode).toBe(0);
});

it('removing a member removes the collection row whole; a plain release keeps other rows and adds none', async () => {
  const dir = registry(),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/kit@1.0.0');
  await ia(root, dir, 'install', 'acme/w');
  expect(record(root)!.collections.map((row) => row.id)).toEqual(['acme/kit']);
  const removed = await run(['remove', 'acme/y', '--root', root, '--apply', '--yes', '--json']);
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(record(root)?.collections ?? []).toEqual([]);
});

it('installing the collection again at 2.0.0 replaces its members', async () => {
  const dir = registry(),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/kit@1.0.0');
  await ia(root, dir, 'install', 'acme/kit@2.0.0');
  const lock = decodeDistributionLock(JSON.parse(lockText(root)));
  const version = (id: string) => lock.packages.find((row) => row.id === id)?.version;
  expect([version('acme/x'), version('acme/y'), version('acme/z')]).toEqual(['2.0.0', '1.0.0', '1.0.0']);
  expect(record(root)!.collections).toEqual([
    expect.objectContaining({ id: 'acme/kit', version: '2.0.0', members: expect.any(Array) }),
  ]);
  expect(record(root)!.collections[0]!.members.map((member) => member.id)).toEqual(['acme/x', 'acme/y', 'acme/z']);
});

it('the collection fix moves every member', async () => {
  const dir = registry(),
    root = await workspace(),
    iaHome = resolve(scratch('collections-home'), '.ia');
  await ia(root, dir, 'install', 'acme/kit@1.0.0');
  const before = decodeDistributionLock(JSON.parse(lockText(root)));
  // The registry the workspace chooses for acme (here from IA_REGISTRY) last reported 2.0.0 for the collection.
  const env = { IA_HOME: iaHome, IA_REGISTRY: dir };
  mkdirSync(join(iaHome, 'state'), { recursive: true });
  writeFileSync(
    join(iaHome, 'state/update-check.json'),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: new Date().toISOString(),
      cli: { channel: 'unknown', current: '0.0.0', latest: null, behind: null, checked: false },
      packages: {
        checked: true,
        entries: [
          { registry: dir, kind: 'collection', id: 'acme/kit', latest: '2.0.0', checkedAt: new Date().toISOString() },
        ],
      },
    }),
  );
  const doctor = JSON.parse((await run(['doctor', '--root', root, '--json'], { env })).stdout) as {
    checks: { id: string; fix: Fix | null }[];
  };
  const fix = doctor.checks.find((check) => check.id === 'kit-update:acme/kit')!.fix!;
  expect(fix).toEqual({ program: 'ia', argv: ['install', 'acme/kit@2.0.0'], flow: 'preview-apply', writesTo: 'repo' });
  const applied = await run([...confirmedArgv(fix)], { cwd: root, env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  const lock = decodeDistributionLock(JSON.parse(lockText(root)));
  const pin = (from: typeof lock, id: string) => from.packages.find((row) => row.id === id);
  expect(pin(lock, 'acme/x')?.version).toBe('2.0.0');
  expect(pin(lock, 'acme/z')?.version).toBe('1.0.0');
  // The member whose range did not change keeps its pin.
  expect(pin(lock, 'acme/y')).toEqual(pin(before, 'acme/y'));
  expect(record(root)!.collections.map((row) => `${row.id}@${row.version}`)).toEqual(['acme/kit@2.0.0']);
});

it("a pinned release's update fix moves the pin to the latest version", async () => {
  const dir = registry(),
    root = await workspace(),
    iaHome = resolve(scratch('collections-home'), '.ia');
  await ia(root, dir, 'install', 'acme/x@1.0.0');
  const env = { IA_HOME: iaHome, IA_REGISTRY: dir };
  mkdirSync(join(iaHome, 'state'), { recursive: true });
  writeFileSync(
    join(iaHome, 'state/update-check.json'),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: new Date().toISOString(),
      cli: { channel: 'unknown', current: '0.0.0', latest: null, behind: null, checked: false },
      packages: {
        checked: true,
        entries: [
          { registry: dir, kind: 'release', id: 'acme/x', latest: '2.0.0', checkedAt: new Date().toISOString() },
        ],
      },
    }),
  );
  const doctor = JSON.parse((await run(['doctor', '--root', root, '--json'], { env })).stdout) as {
    checks: { id: string; fix: Fix | null }[];
  };
  const fix = doctor.checks.find((check) => check.id === 'kit-update:acme/x')!.fix!;
  // The offered command runs as given, through the console's confirmed form, and the pin moves.
  const applied = await run([...confirmedArgv(fix)], { cwd: root, env });
  expect(applied.exitCode, applied.stdout).toBe(0);
  const lock = decodeDistributionLock(JSON.parse(lockText(root)));
  expect(lock.packages.find((row) => row.id === 'acme/x')?.version).toBe('2.0.0');
});
