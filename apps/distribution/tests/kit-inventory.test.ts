/**
 * The installed units of a workspace and their sources (host-plugin-distribution §7.3 `kits`): an npm package entry, an
 * intact registry collection, or a direct request.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalDistributionJson } from '@inventarch/db/distribution';
import { sha256 } from '../src/files.js';
import { installedUnits } from '../src/kit-inventory.js';
import { KIT_COLLECTIONS, serializeKitCollections } from '../src/kit-collections.js';

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'ia-kit-inventory-'));
  made.push(root);
  return root;
};
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const hex = (c: string): string => c.repeat(64);
const pkg = (id: string, version: string, archive: string, dependencies: string[] = []) => ({
  id,
  version,
  archive: hex(archive),
  manifest: hex('f'),
  location: `sha256:${hex(archive)}`,
  dependencies,
});
const LIB = pkg('acme/lib', '1.0.0', 'a'),
  APP = pkg('acme/app', '2.0.0', 'b', ['acme/lib']),
  X = pkg('acme/x', '1.0.0', 'c'),
  Y = pkg('acme/y', '1.1.0', 'd');
const PACKAGE_ENTRY = {
  kind: 'package',
  name: '@acme/kits',
  version: '1.4.0',
  integrity: `sha512-${'A'.repeat(86)}==`,
  kits: [{ id: 'acme/kit-one', version: '1.0.0', archive: hex('e'), manifest: hex('f'), dependencies: [] }],
};
function lock(root: string, packages: ReturnType<typeof pkg>[], requests: string[], entries = false): string {
  const text = canonicalDistributionJson({
    formatVersion: 1,
    engine: entries ? '^0.1.2' : '^0.1.0',
    requests: [...requests].sort().map((id) => ({ id, range: packages.find((p) => p.id === id)!.version })),
    packages: [...packages].sort((a, b) => (a.id < b.id ? -1 : 1)),
    ...(entries ? { entries: [PACKAGE_ENTRY] } : {}),
  });
  put(root, '.ia/distributions.lock.json', text);
  return text;
}
const COLLECTION = (lockText: string) =>
  serializeKitCollections({
    format: 'ia-kit-collections-1',
    lock: sha256(lockText),
    collections: [
      {
        id: 'acme/kit',
        version: '3.0.0',
        registry: '/registry',
        members: [
          { id: 'acme/x', version: '1.0.0', archive: hex('c') },
          { id: 'acme/y', version: '1.1.0', archive: hex('d') },
        ],
      },
    ],
    unknown: [],
  });

it('an npm package entry is one package unit with its kits as members', () => {
  const root = workspace();
  lock(root, [], [], true);
  expect(installedUnits(root)).toEqual({
    units: [
      {
        id: '@acme/kits',
        version: '1.4.0',
        source: { kind: 'package', name: '@acme/kits', version: '1.4.0' },
        members: ['acme/kit-one'],
      },
    ],
    unknownCollections: [],
    problems: [],
  });
});
it('an intact collection is one collection unit and its members are not also release units', () => {
  const root = workspace();
  put(root, KIT_COLLECTIONS, COLLECTION(lock(root, [X, Y, APP, LIB], ['acme/x', 'acme/y', 'acme/app'])));
  expect(installedUnits(root).units).toEqual([
    {
      id: 'acme/kit',
      version: '3.0.0',
      source: { kind: 'collection', id: 'acme/kit', version: '3.0.0', registry: '/registry' },
      members: ['acme/x', 'acme/y'],
    },
    { id: 'acme/app', version: '2.0.0', source: { kind: 'release' }, members: ['acme/app'] },
  ]);
});
it('a direct request outside both is a release unit, and a dependency-only release is not a unit', () => {
  const root = workspace();
  lock(root, [APP, LIB], ['acme/app']);
  expect(installedUnits(root).units).toEqual([
    { id: 'acme/app', version: '2.0.0', source: { kind: 'release' }, members: ['acme/app'] },
  ]);
});
it('no lock gives no units', () => {
  expect(installedUnits(workspace())).toEqual({ units: [], unknownCollections: [], problems: [] });
});
it('a record describing another lock gives release units and one problem', () => {
  const root = workspace();
  const before = lock(root, [X, Y], ['acme/x', 'acme/y']);
  put(root, KIT_COLLECTIONS, COLLECTION(before));
  // An older CLI changed the lock; the record no longer names its bytes.
  lock(root, [X, Y, LIB], ['acme/x', 'acme/y', 'acme/lib']);
  const read = installedUnits(root);
  expect(read.units.map((unit) => [unit.id, unit.source.kind])).toEqual([
    ['acme/lib', 'release'],
    ['acme/x', 'release'],
    ['acme/y', 'release'],
  ]);
  expect(read.problems).toHaveLength(1);
});
it('a lock the decoder refuses is a problem, not a throw', () => {
  const root = workspace();
  put(root, '.ia/distributions.lock.json', '{"formatVersion":1}');
  const read = installedUnits(root);
  expect(read.units).toEqual([]);
  expect(read.problems).toEqual([expect.stringContaining('.ia/distributions.lock.json')]);
  put(root, '.ia/distributions.lock.json', 'not json');
  expect(() => installedUnits(root)).not.toThrow();
  expect(installedUnits(root).problems).toHaveLength(1);
});
