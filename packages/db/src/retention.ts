import { readFileSync } from 'node:fs';
import { isBand } from '@inventarch/language';
import { stableSerialize } from '@inventarch/graph';
import { cacheObservation, derivedPath, publishDerived } from './cache.js';
import type { CacheObservation, CacheStatus } from './cache.js';
import { safePath } from './inputs.js';
import type { MembershipRow } from './membership.js';

/** D08: an admitted root snapshot (location '', no phase) as retained: its revision and D02a membership rows. */
export interface RetainedSnapshot {
  readonly revision: string;
  readonly membership: readonly MembershipRow[];
}
/** D08: the current root snapshot and the most recent one whose revision differs from it, when there is one. */
export interface Retained {
  readonly current: RetainedSnapshot;
  readonly previous?: RetainedSnapshot;
}
/** D08: a record's current membership digest against the previous snapshot's. */
export type Staleness = 'unchanged' | 'changed' | 'new' | 'removed';
/** D08 (position-and-projection row 20): the retained snapshot whose digest for a record equals an observed one. */
export type Readiness = 'current' | 'previous' | 'unknown';

const NAME = 'snapshots',
  PATH = derivedPath(NAME),
  FORMAT = 'ia-snapshots-1',
  HEX = /^[0-9a-f]{64}$/;
const digests = new WeakMap<readonly MembershipRow[], ReadonlyMap<string, string>>();
/** D08: the identity's digest in a retained snapshot, from an identity -> digest index built once per frozen row list. */
export function digestIn(snapshot: RetainedSnapshot | undefined, identity: string): string | undefined {
  if (snapshot === undefined) return undefined;
  const rows = snapshot.membership;
  let index = digests.get(rows);
  if (index === undefined) digests.set(rows, (index = new Map(rows.map((row) => [row.identity, row.digest]))));
  return index.get(identity);
}
/** D08: equal digests are unchanged; a digest only on the current side is new, only on the previous side removed. */
export function stalenessOf(now: string | undefined, before: string | undefined): Staleness | undefined {
  if (now === undefined) return before === undefined ? undefined : 'removed';
  return before === undefined ? 'new' : now === before ? 'unchanged' : 'changed';
}
/** D08: equality only, never an order; the current side answers first. */
export function readinessOf(now: string | undefined, before: string | undefined, digest: string): Readiness {
  return digest === now ? 'current' : digest === before ? 'previous' : 'unknown';
}
/** D08 rotation: the prior current becomes previous only when the revision changed; otherwise the prior previous stays. */
export function rotate(prior: Retained | undefined, current: RetainedSnapshot): Retained {
  const previous =
    prior === undefined ? undefined : prior.current.revision === current.revision ? prior.previous : prior.current;
  return Object.freeze({ current, ...(previous === undefined ? {} : { previous }) });
}

const plain = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
function snapshotOf(value: unknown): RetainedSnapshot | undefined {
  if (
    !plain(value, ['membership', 'revision']) ||
    typeof value['revision'] !== 'string' ||
    !HEX.test(value['revision']) ||
    !Array.isArray(value['membership'])
  )
    return undefined;
  const identities = new Set<string>(),
    rows: MembershipRow[] = [];
  for (const row of value['membership'] as unknown[]) {
    if (
      !plain(row, ['band', 'digest', 'identity', 'root']) ||
      typeof row['identity'] !== 'string' ||
      identities.has(row['identity']) ||
      typeof row['root'] !== 'string' ||
      typeof row['band'] !== 'number' ||
      !isBand(row['band']) ||
      typeof row['digest'] !== 'string' ||
      !HEX.test(row['digest'])
    )
      return undefined;
    identities.add(row['identity']);
    rows.push(
      Object.freeze({ identity: row['identity'], root: row['root'], band: row['band'], digest: row['digest'] }),
    );
  }
  return Object.freeze({ revision: value['revision'], membership: Object.freeze(rows) });
}
/**
 * D08: the pair a cache-enabled handle last published, read to seed a new handle's previous snapshot. A missing file
 * seeds nothing. An unreadable, non-JSON, foreign-format or malformed file, or one whose current snapshot names the
 * fresh revision with other rows, is never trusted: it seeds nothing and yields a warning. A well-formed pair at
 * another revision cannot be rebuilt from the fresh inputs, so it is trusted as written.
 */
export function readRetained(
  root: string,
  current: RetainedSnapshot,
): { readonly prior?: Retained; readonly observations: readonly CacheObservation[] } {
  const ignored = (reason: string) =>
    Object.freeze({ observations: Object.freeze([cacheObservation(PATH, `Retained snapshots ignored: ${reason}`)]) });
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(safePath(root, PATH), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ observations: Object.freeze([]) });
    return ignored(error instanceof Error ? error.message : String(error));
  }
  if (!plain(value, ['current', 'format', 'previous']) || value['format'] !== FORMAT) return ignored('foreign format');
  const stored = snapshotOf(value['current']),
    previous = value['previous'] === null ? undefined : snapshotOf(value['previous']);
  if (stored === undefined || (value['previous'] !== null && previous === undefined))
    return ignored('malformed snapshot');
  if (previous?.revision === stored.revision) return ignored('previous snapshot repeats the current revision');
  if (
    stored.revision === current.revision &&
    stableSerialize(stored.membership) !== stableSerialize(current.membership)
  )
    return ignored('current snapshot differs from the fresh capture at its revision');
  return Object.freeze({
    prior: Object.freeze({ current: stored, ...(previous === undefined ? {} : { previous }) }),
    observations: Object.freeze([]),
  });
}
/** D08: publish the pair the D06 way beside the graph cache; `previous` is null when none is retained. */
export function publishRetained(root: string, retained: Retained, enabled: boolean): CacheStatus {
  return publishDerived(
    root,
    NAME,
    () => JSON.stringify({ format: FORMAT, current: retained.current, previous: retained.previous ?? null }) + '\n',
    enabled,
  );
}
