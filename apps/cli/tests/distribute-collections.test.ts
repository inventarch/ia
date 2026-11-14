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

/** Collections `acme/a` and `acme/b` share `acme/x`; `acme/a` 2.0.0 moves x to ^2, and 3.0.0 lists w instead of x. */
function sharedRegistry(): string {
  const dir = buildFixtureRegistry([
    { id: 'acme/w', version: '1.0.0' },
    { id: 'acme/x', version: '1.0.0' },
    { id: 'acme/x', version: '2.0.0' },
    { id: 'acme/y', version: '1.0.0' },
  ]);
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/a',
    releases: [
      { version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^1.0.0' }] },
      { version: '2.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^2.0.0' }] },
      { version: '3.0.0', withdrawn: false, distributions: [{ id: 'acme/w', range: '^1.0.0' }] },
    ],
  });
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/b',
    releases: [
      {
        version: '1.0.0',
        withdrawn: false,
        distributions: [
          { id: 'acme/x', range: '^1.0.0' },
          { id: 'acme/y', range: '^1.0.0' },
        ],
      },
    ],
  });
  return dir;
}
const shared = async (): Promise<{ dir: string; root: string }> => {
  const dir = sharedRegistry(),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/a@1.0.0');
  await ia(root, dir, 'install', 'acme/b@1.0.0');
  expect(record(root)!.collections.map((row) => row.id)).toEqual(['acme/a', 'acme/b']);
  return { dir, root };
};
type Planned = { plan: { changes: { removed: string[] }; lock: { packages: { id: string }[] } } };

it('re-installing a collection that drops a shared member keeps the member and the other collection', async () => {
  const { dir, root } = await shared();
  const before = decodeDistributionLock(JSON.parse(lockText(root)));
  const preview = await run(['install', 'acme/a@3.0.0', '--root', root, '--registry', dir, '--json']);
  expect(preview.exitCode, preview.stdout).toBe(0);
  const planned = (JSON.parse(preview.stdout) as Planned).plan;
  expect(planned.changes.removed).not.toContain('acme/x');
  expect(planned.lock.packages.map((row) => row.id)).toContain('acme/x');
  await ia(root, dir, 'install', 'acme/a@3.0.0');
  const lock = decodeDistributionLock(JSON.parse(lockText(root)));
  const pin = (from: typeof lock, id: string) => from.packages.find((row) => row.id === id);
  expect(pin(lock, 'acme/x')).toEqual(pin(before, 'acme/x'));
  expect(record(root)!.collections.map((row) => `${row.id}@${row.version}`)).toEqual(['acme/a@3.0.0', 'acme/b@1.0.0']);
});

it("re-installing a collection that moves a shared member's range refuses, at preview and at apply", async () => {
  const { dir, root } = await shared();
  const recorded = readFileSync(join(root, KIT_COLLECTIONS), 'utf8');
  for (const apply of [[], ['--apply', '--yes']]) {
    const result = await run(['install', 'acme/a@2.0.0', '--root', root, '--registry', dir, ...apply, '--json']);
    expect(result.exitCode, result.stdout).toBe(3);
    // The refusal names the collection that holds the member, and the one command that re-expands both together.
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: 'IA-DIST-CONFLICT',
      message: 'Kit acme/a 2.0.0 lists acme/x ^2.0.0, but installed collection acme/b lists it at ^1.0.0',
      // The root is spelled as the CLI's advice spells every root (forward slashes on Windows).
      next: expect.stringMatching(/^Install them together with "ia install acme\/a@2\.0\.0 acme\/b --registry /),
    });
    expect(JSON.parse(result.stdout).next).toContain(
      ` --root ${root.replaceAll('\\', '/')}"; that succeeds only when one release of acme/x satisfies every range their releases list.`,
    );
  }
  expect(readFileSync(join(root, KIT_COLLECTIONS), 'utf8')).toBe(recorded);
});

/** `acme/a` and `acme/b` share `acme/x`: a 1.0.0 and b at ^1.2.0, a 2.0.0 at ^1.4.0, a 3.0.0 at the disjoint ^2.0.0. */
function overlapRegistry(versions: readonly string[]): string {
  const dir = buildFixtureRegistry(versions.map((version) => ({ id: 'acme/x', version })));
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/a',
    releases: [
      { version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^1.2.0' }] },
      { version: '2.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^1.4.0' }] },
      { version: '3.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^2.0.0' }] },
    ],
  });
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/b',
    releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^1.2.0' }] }],
  });
  return dir;
}

it('re-installing a collection at a range that intersects a holder moves the pin, and both rows follow it', async () => {
  // Installed while 1.3.0 was the newest; 1.5.0 is the only release both ranges accept once a moves to ^1.4.0.
  const before = overlapRegistry(['1.3.0']),
    after = overlapRegistry(['1.3.0', '1.5.0', '2.0.0']),
    root = await workspace();
  await ia(root, before, 'install', 'acme/a@1.0.0');
  await ia(root, before, 'install', 'acme/b@1.0.0');
  const row = (id: string) => record(root)!.collections.find((collection) => collection.id === id);
  expect(row('acme/b')!.members[0]!.version).toBe('1.3.0');

  await ia(root, after, 'install', 'acme/a@2.0.0');
  const text = lockText(root),
    lock = decodeDistributionLock(JSON.parse(text)),
    pin = lock.packages.find((locked) => locked.id === 'acme/x')!;
  expect(pin.version).toBe('1.5.0');
  expect(lock.requests.filter((request) => request.id === 'acme/x')).toEqual([{ id: 'acme/x', range: '^1.4.0' }]);
  const member = [{ id: 'acme/x', version: '1.5.0', archive: pin.archive }];
  expect(row('acme/a')).toMatchObject({ version: '2.0.0', registry: after, members: member });
  // The holder keeps its identity and its own version and registry, at the pin that moved under it.
  expect(row('acme/b')).toMatchObject({ version: '1.0.0', registry: before, members: member });

  // Later commands stay where this one left them: no refusal, no drift.
  await ia(root, after, 'install', 'acme/a@2.0.0');
  await ia(root, after, 'install', 'acme/b@1.0.0');
  await ia(root, after, 'install', 'acme/a@2.0.0', 'acme/b@1.0.0');
  expect(lockText(root)).toBe(text);
  expect(row('acme/b')).toMatchObject({ version: '1.0.0', members: member });
  expect((await run(['restore', '--root', root, '--registry', after, '--apply', '--yes', '--json'])).exitCode).toBe(0);
  expect(lockText(root)).toBe(text);
  expect((await run(['doctor', '--root', root, '--json'])).exitCode).toBe(0);

  // The holder still constrains: a release outside it refuses, and nothing moves.
  const refused = await run(['install', 'acme/a@3.0.0', '--root', root, '--registry', after, '--json']);
  expect(refused.exitCode, refused.stdout).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-CONFLICT',
    message: 'Kit acme/a 3.0.0 lists acme/x ^2.0.0, but installed collection acme/b lists it at ^1.4.0',
  });
  expect(lockText(root)).toBe(text);
});

it('a range the user named in an earlier command is never narrowed by a collection that shares it', async () => {
  const dir = overlapRegistry(['1.3.0', '1.5.0']),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/b@1.0.0');
  // The user names the member b already lists, at the same range: the lock is unchanged, the record keeps who asked.
  const lock = lockText(root);
  await ia(root, dir, 'install', 'acme/x@^1.2.0');
  expect(lockText(root)).toBe(lock);
  expect(JSON.parse(readFileSync(join(root, KIT_COLLECTIONS), 'utf8'))).toMatchObject({ named: ['acme/x'] });
  const recorded = readFileSync(join(root, KIT_COLLECTIONS), 'utf8');

  // A collection listing x at ^1.4.0 refuses, as for any direct request, and nothing is written.
  const refused = await run(['install', 'acme/a@2.0.0', '--root', root, '--registry', dir, '--json']);
  expect(refused.exitCode, refused.stdout).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-CONFLICT',
    message: 'Kit conflicts with direct request acme/x',
  });
  expect(lockText(root)).toBe(lock);
  expect(readFileSync(join(root, KIT_COLLECTIONS), 'utf8')).toBe(recorded);

  // Re-installing the holder keeps the request the user named, and its mark.
  await ia(root, dir, 'install', 'acme/b@1.0.0');
  expect(lockText(root)).toBe(lock);
  expect(readFileSync(join(root, KIT_COLLECTIONS), 'utf8')).toBe(recorded);
});

it("a request named before any collection listed it stays the user's once one does", async () => {
  const dir = overlapRegistry(['1.3.0', '1.5.0']),
    root = await workspace();
  await ia(root, dir, 'install', 'acme/x@^1.2.0');
  await ia(root, dir, 'install', 'acme/b@1.0.0');
  expect(JSON.parse(readFileSync(join(root, KIT_COLLECTIONS), 'utf8'))).toMatchObject({ named: ['acme/x'] });
  const refused = await run(['install', 'acme/a@2.0.0', '--root', root, '--registry', dir, '--json']);
  expect(refused.exitCode, refused.stdout).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    message: 'Kit conflicts with direct request acme/x',
  });
});

it('a kit whose member is a kit previews and applies, recording the members it expanded to', async () => {
  const dir = buildFixtureRegistry([{ id: 'acme/x', version: '1.0.0' }]),
    root = await workspace();
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/outer',
    releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/inner', range: '^1.0.0' }] }],
  });
  registryAddCollection(dir, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'acme/inner',
    releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'acme/x', range: '^1.0.0' }] }],
  });
  const preview = await run(['install', 'acme/outer', '--root', root, '--registry', dir, '--json']);
  expect(preview.exitCode, preview.stdout).toBe(0);
  await ia(root, dir, 'install', 'acme/outer');
  const lock = decodeDistributionLock(JSON.parse(lockText(root)));
  expect(record(root)!.collections).toEqual([
    {
      id: 'acme/outer',
      version: '1.0.0',
      registry: dir,
      members: [{ id: 'acme/x', version: '1.0.0', archive: lock.packages.find((row) => row.id === 'acme/x')!.archive }],
    },
  ]);
});

it("the preview's Would write names the collection record exactly when the apply writes it", async () => {
  const dir = registry(),
    root = await workspace();
  const recordBytes = () =>
    existsSync(join(root, KIT_COLLECTIONS)) ? readFileSync(join(root, KIT_COLLECTIONS), 'utf8') : null;
  // Each step previews, then applies, and the preview names the record exactly when the apply changed it.
  const step = async (argv: string[], registered = true): Promise<boolean> => {
    const source = registered ? ['--registry', dir] : [];
    const preview = await run([...argv, '--root', root, ...source]);
    expect(preview.exitCode, preview.stdout).toBe(0);
    const named = preview.stdout.slice(preview.stdout.indexOf('Would write')).includes(KIT_COLLECTIONS),
      before = recordBytes();
    const applied = await run([...argv, '--root', root, ...source, '--apply', '--yes', '--json']);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(named).toBe(recordBytes() !== before);
    return named;
  };
  expect(await step(['install', 'acme/w'])).toBe(false);
  expect(await step(['install', 'acme/kit@1.0.0'])).toBe(true);
  expect(await step(['remove', 'acme/y'], false)).toBe(true);
  expect(await step(['install', 'acme/x@^1.0.0'])).toBe(false);
});
