/**
 * The installed units of a workspace, each with the source that can move it: host-plugin-distribution §7.3 `kits`.
 *
 * A unit is one thing `ia update` or `ia install` moves: an npm package of kits (a lock `package` entry), a registry
 * collection whose identity the collection record keeps intact (kit-collections.ts), or a direct request that neither
 * owns. A release that is only a dependency is not a unit. Never throws: a lock or record that cannot be read is a
 * problem, and its members are never reported under a guessed source.
 */
import { decodeDistributionJson, decodeDistributionLock, INSTALL_PATHS } from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import { sha256, utf8, workspace } from './files.js';
import { intactAgainst, stableCollections } from './kit-collections.js';
import type { CollectionReadHooks, CurrentCollections, UnknownCollection } from './kit-collections.js';

export type KitSource =
  /** An npm package entry in the lock. */
  | { readonly kind: 'package'; readonly name: string; readonly version: string }
  /** A registry collection the record keeps intact. */
  | { readonly kind: 'collection'; readonly id: string; readonly version: string; readonly registry: string }
  /** A direct request that no collection or package owns. */
  | { readonly kind: 'release' };
export interface InstalledUnit {
  /** package: the npm name; collection: the collection id; release: the release id. */
  readonly id: string;
  /** package: its version; collection: its version; release: the locked version. */
  readonly version: string;
  readonly source: KitSource;
  /** The release ids this unit installed: a package's kits, a collection's members, a release itself. */
  readonly members: readonly string[];
}
export interface InstalledUnits {
  readonly units: readonly InstalledUnit[];
  /** Collections whose identity is unknown, with their members still in the lock, which are inventoried as releases. */
  readonly unknownCollections: readonly UnknownCollection[];
  readonly problems: readonly string[];
}

export function installedUnits(rootInput: string, hooks: CollectionReadHooks = {}): InstalledUnits {
  let content: Buffer | null, lock: DistributionLock, current: CurrentCollections;
  try {
    // The lock and the collection record are read together between two probes of the installation state.
    ({ current, lock: content } = stableCollections(workspace(rootInput), hooks));
    if (content === null) return { units: [], unknownCollections: [], problems: [] };
    lock = decodeDistributionLock(decodeDistributionJson(utf8(content)));
  } catch (error) {
    return {
      units: [],
      unknownCollections: [],
      problems: [`${INSTALL_PATHS.lock}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let intact: ReturnType<typeof intactAgainst>;
  try {
    intact = intactAgainst(current, lock, sha256(content));
  } catch (error) {
    intact = {
      collections: [],
      unknown: [],
      named: [],
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
  const units: InstalledUnit[] = [];
  // 1. Each package entry is one unit; its kits are its members.
  for (const entry of lock.entries ?? [])
    if (entry.kind === 'package')
      units.push({
        id: entry.name,
        version: entry.version,
        source: { kind: 'package', name: entry.name, version: entry.version },
        members: entry.kits.map((kit) => kit.id),
      });
  // 2. Each intact collection is one unit.
  for (const row of intact.collections)
    units.push({
      id: row.id,
      version: row.version,
      source: { kind: 'collection', id: row.id, version: row.version, registry: row.registry },
      members: row.members.map((member) => member.id),
    });
  // 3. Every other direct request is a release unit at its locked version.
  const owned = new Set(units.flatMap((unit) => unit.members));
  for (const request of lock.requests) {
    if (owned.has(request.id)) continue;
    const locked = lock.packages.find((row) => row.id === request.id);
    if (locked !== undefined)
      units.push({ id: request.id, version: locked.version, source: { kind: 'release' }, members: [request.id] });
  }
  return { units, unknownCollections: intact.unknown, problems: intact.problems };
}
