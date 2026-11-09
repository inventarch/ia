/**
 * The identity of a registry collection install, kept beside the lock: apps/distribution/references/registry-collections.md
 * "Collection record".
 *
 * `ia install <collection>` expands a registry `kit` collection into its member distributions, and the lock records
 * only the members. The lock is not changed to remember the collection: a new entry kind would make every older CLI
 * refuse the repository. So `.ia/kit-collections.json`, committed with the lock, names the lock bytes it describes and
 * each collection's id, version, registry and exact member pins.
 *
 * While an installation changes it, a journal in the local install state binds the change to the activation it belongs
 * to (`beforeActive`, `afterActive`), so an interrupted operation is never read as the collection version it was
 * installing. The reader fails closed: when it cannot tell which side counts, the collection's identity is unknown and
 * its members are inventoried as plain releases, never under a guessed source.
 */
import {
  decodeDistributionJson,
  decodeDistributionLock,
  DISTRIBUTION_LIMITS,
  INSTALL_PATHS,
  packageId,
} from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { bytes, fail, replace, sha256, utf8, workspace } from './files.js';

export const KIT_COLLECTIONS = '.ia/kit-collections.json';
export const KIT_COLLECTIONS_JOURNAL = '.ia/distributions/kit-collections.journal.json';
export const KIT_COLLECTIONS_FORMAT = 'ia-kit-collections';
export const KIT_COLLECTIONS_FORMAT_VERSION = 1;
/** The literal a record committed before `formatVersion` existed carries; still read, never written. */
const LEGACY_KIT_COLLECTIONS_FORMATS: readonly string[] = ['ia-kit-collections-1'];
const KIT_COLLECTIONS_HEADER = {
  format: KIT_COLLECTIONS_FORMAT,
  formatVersion: KIT_COLLECTIONS_FORMAT_VERSION,
} as const;

export interface CollectionMember {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
}
export interface CollectionRow {
  readonly id: string;
  readonly version: string;
  /** The registry the collection index was read from: an HTTPS URL or a directory (`registryLocation`). */
  readonly registry: string;
  readonly members: readonly CollectionMember[];
}
/** A collection whose identity could not be established after an interrupted change: its id and both sides' members. */
export interface UnknownCollection {
  readonly id: string;
  readonly members: readonly string[];
}
export interface KitCollections {
  readonly format: typeof KIT_COLLECTIONS_FORMAT;
  readonly formatVersion: typeof KIT_COLLECTIONS_FORMAT_VERSION;
  /** The sha256 of the portable lock bytes this record describes. */
  readonly lock: string;
  readonly collections: readonly CollectionRow[];
  readonly unknown: readonly UnknownCollection[];
  /**
   * The lock requests the user named directly that a recorded collection also lists. The lock cannot say who asked for
   * a request, so this is where it is kept: a later install compares such a request as a string and never narrows it
   * to a range a collection shares. Absent or empty, the key is not written.
   */
  readonly named?: readonly string[];
}
/** One collection an operation expanded: `registry-resolve`'s `expandedCollections`. Members are ids, not pins. */
export interface ExpandedCollection {
  readonly id: string;
  readonly version: string;
  readonly registry: string;
  readonly members: readonly string[];
}
export interface CollectionsJournal {
  readonly formatVersion: 1;
  /** The exact activation pointer bytes before the operation, or null when nothing was active. */
  readonly beforeActive: string | null;
  /** The exact activation pointer bytes the operation commits. */
  readonly afterActive: string;
  /** The record's bytes before, or null when there was none. */
  readonly before: string | null;
  /** The record's bytes after, or null when the operation leaves none. */
  readonly after: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
/**
 * A distribution id (`provider/name`, the lock's own rule). The record is committed, and its ids reach the argument
 * vectors doctor offers as fixes, so an id such as `--root=/other` must never decode.
 */
const distributionId = (value: unknown): value is string => {
  try {
    packageId(value);
    return true;
  } catch {
    return false;
  }
};
const HEX = /^[a-f0-9]{64}$/;
const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function decodeMember(value: unknown): CollectionMember {
  if (
    !isRecord(value) ||
    !distributionId(value['id']) ||
    !text(value['version']) ||
    !HEX.test(String(value['archive']))
  )
    fail('INPUT-INVALID', 'A collection member needs its id, version and archive digest');
  return { id: value['id'] as string, version: value['version'] as string, archive: value['archive'] as string };
}
/** The record in `text`; a malformed one refuses (INPUT-INVALID), and so does another format (`unknownFormat`). */
export function decodeKitCollections(input: string): KitCollections {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return fail('INPUT-INVALID', `${KIT_COLLECTIONS} is not valid JSON`);
  }
  if (!isRecord(value)) return fail('INPUT-INVALID', `${KIT_COLLECTIONS} is not an object`);
  const current =
      value['format'] === KIT_COLLECTIONS_FORMAT && value['formatVersion'] === KIT_COLLECTIONS_FORMAT_VERSION,
    legacy =
      LEGACY_KIT_COLLECTIONS_FORMATS.includes(value['format'] as string) && !Object.hasOwn(value, 'formatVersion');
  if (!current && !legacy)
    return fail('UNSUPPORTED-FORMAT', `${KIT_COLLECTIONS} has format ${String(value['format'])}`);
  const collections = value['collections'],
    unknown = value['unknown'] ?? [],
    named = value['named'] ?? [];
  if (!HEX.test(String(value['lock'])) || !Array.isArray(collections) || !Array.isArray(unknown))
    return fail('INPUT-INVALID', `${KIT_COLLECTIONS} needs a lock digest, collections and unknown`);
  if (!Array.isArray(named) || !named.every(distributionId))
    return fail('INPUT-INVALID', `${KIT_COLLECTIONS} names a direct request that is not a distribution id`);
  return {
    ...KIT_COLLECTIONS_HEADER,
    lock: value['lock'] as string,
    collections: collections.map((row): CollectionRow => {
      if (!isRecord(row) || !distributionId(row['id']) || !text(row['version']) || !text(row['registry']))
        return fail('INPUT-INVALID', 'A collection needs its id, version and registry');
      if (!Array.isArray(row['members'])) return fail('INPUT-INVALID', 'A collection needs its members');
      return {
        id: row['id'] as string,
        version: row['version'] as string,
        registry: row['registry'] as string,
        members: (row['members'] as unknown[]).map(decodeMember),
      };
    }),
    unknown: unknown.map((row): UnknownCollection => {
      if (
        !isRecord(row) ||
        !distributionId(row['id']) ||
        !Array.isArray(row['members']) ||
        !row['members'].every(distributionId)
      )
        return fail('INPUT-INVALID', 'An unknown collection needs its id and member ids');
      return { id: row['id'] as string, members: row['members'] as string[] };
    }),
    ...(named.length > 0 ? { named: [...new Set(named as string[])].sort() } : {}),
  };
}
/** The committed bytes: keys in one order, rows and members sorted by id, two-space indent, one trailing newline. */
export function serializeKitCollections(record: KitCollections): string {
  const ordered = {
    format: record.format,
    formatVersion: record.formatVersion,
    lock: record.lock,
    collections: [...record.collections].sort(byId).map((row) => ({
      id: row.id,
      version: row.version,
      registry: row.registry,
      members: [...row.members].sort(byId).map((member) => ({
        id: member.id,
        version: member.version,
        archive: member.archive,
      })),
    })),
    unknown: [...record.unknown].sort(byId).map((row) => ({ id: row.id, members: [...row.members].sort() })),
    ...(record.named !== undefined && record.named.length > 0 ? { named: [...new Set(record.named)].sort() } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export type RecordRead =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly record: KitCollections; readonly bytes: string }
  | { readonly state: 'invalid'; readonly problem: string };
/** The record file as it is on disk. Never throws: a malformed or foreign record is `invalid` with the reason. */
export function readKitCollections(rootInput: string): RecordRead {
  try {
    const content = bytes(workspace(rootInput), KIT_COLLECTIONS, DISTRIBUTION_LIMITS.metadata);
    if (content === null) return { state: 'absent' };
    const value = utf8(content);
    return { state: 'present', record: decodeKitCollections(value), bytes: value };
  } catch (error) {
    return {
      state: 'invalid',
      problem: `${KIT_COLLECTIONS}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function decodeJournal(input: string): CollectionsJournal {
  const value: unknown = JSON.parse(input);
  const nullable = (key: string): string | null => {
    const v = isRecord(value) ? value[key] : undefined;
    if (v !== null && typeof v !== 'string') fail('INPUT-INVALID', `The collections journal's ${key} is invalid`);
    return v;
  };
  if (!isRecord(value) || value['formatVersion'] !== 1 || typeof value['afterActive'] !== 'string')
    fail('INPUT-INVALID', 'The collections journal is invalid');
  return {
    formatVersion: 1,
    beforeActive: nullable('beforeActive'),
    afterActive: value['afterActive'] as string,
    before: nullable('before'),
    after: nullable('after'),
  };
}
export type JournalRead =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly journal: CollectionsJournal }
  | { readonly state: 'invalid'; readonly problem: string };
export function readCollectionsJournal(root: string): JournalRead {
  try {
    const content = bytes(root, KIT_COLLECTIONS_JOURNAL, 4 * DISTRIBUTION_LIMITS.metadata);
    if (content === null) return { state: 'absent' };
    return { state: 'present', journal: decodeJournal(utf8(content)) };
  } catch (error) {
    return {
      state: 'invalid',
      problem: `${KIT_COLLECTIONS_JOURNAL}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
export const journalKitCollections = (root: string, journal: CollectionsJournal): void =>
  replace(root, KIT_COLLECTIONS_JOURNAL, Buffer.from(`${JSON.stringify(journal)}\n`));
export const removeCollectionsJournal = (root: string): void => replace(root, KIT_COLLECTIONS_JOURNAL, null);
const writeRecord = (root: string, content: string | null): void =>
  replace(root, KIT_COLLECTIONS, content === null ? null : Buffer.from(content));

const decodeOrNull = (content: string | null): KitCollections | null => {
  if (content === null) return null;
  try {
    return decodeKitCollections(content);
  } catch {
    return null;
  }
};
const sameRow = (a: CollectionRow, b: CollectionRow): boolean =>
  serializeKitCollections({ ...KIT_COLLECTIONS_HEADER, lock: '0'.repeat(64), collections: [a], unknown: [] }) ===
  serializeKitCollections({ ...KIT_COLLECTIONS_HEADER, lock: '0'.repeat(64), collections: [b], unknown: [] });
/**
 * The record a journal leaves when the activation pointer is neither side's: the collections both sides agree on byte
 * for byte, and every other collection unknown, with the member ids either side recorded. `lock` is the side whose
 * lock the workspace now holds, so the agreed collections still count.
 */
export function undecidedRecord(journal: CollectionsJournal, currentLock: string | null): KitCollections | null {
  const before = decodeOrNull(journal.before),
    after = decodeOrNull(journal.after);
  if (before === null && after === null) return null;
  const sides = [before, after].filter((side): side is KitCollections => side !== null);
  const ids = new Set(sides.flatMap((side) => [...side.collections, ...side.unknown].map((row) => row.id)));
  const collections: CollectionRow[] = [],
    unknown: UnknownCollection[] = [];
  for (const id of ids) {
    const rows = [before, after].map((side) => side?.collections.find((row) => row.id === id));
    const agreed = rows[0] !== undefined && rows[1] !== undefined && sameRow(rows[0], rows[1]);
    if (agreed) collections.push(rows[0]!);
    else
      unknown.push({
        id,
        members: [
          ...new Set(
            sides.flatMap((side) => [
              ...(side.collections.find((row) => row.id === id)?.members.map((member) => member.id) ?? []),
              ...(side.unknown.find((row) => row.id === id)?.members ?? []),
            ]),
          ),
        ],
      });
  }
  const locks = sides.map((side) => side.lock);
  // Either side's direct requests stay direct: one compared as a string refuses where it might have narrowed.
  const named = [...new Set(sides.flatMap((side) => side.named ?? []))].sort();
  return {
    ...KIT_COLLECTIONS_HEADER,
    lock: currentLock !== null && locks.includes(currentLock) ? currentLock : locks[locks.length - 1]!,
    collections,
    unknown,
    ...(named.length > 0 ? { named } : {}),
  };
}

const activeBytes = (root: string): string | null => bytes(root, INSTALL_PATHS.active)?.toString('utf8') ?? null;
const lockDigest = (root: string): string | null => {
  const content = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata);
  return content === null ? null : sha256(content);
};

export interface CurrentCollections {
  /** The record that counts, or null: none, unreadable, or an interrupted operation. */
  readonly record: KitCollections | null;
  /**
   * Where it came from: the file, a journal's side, a journal undecided between them, nothing, or, when the
   * installation state kept changing while it was read, a record of unknown identities (`unstable`).
   */
  readonly source: 'none' | 'file' | 'before' | 'after' | 'undecided' | 'interrupted' | 'unstable';
  readonly problems: readonly string[];
}
/**
 * Test seams: `afterJournal` runs between reading the journal and reading the record it decides on, `afterRecord` after
 * the record file is read, and `stat` stands in for the file identity the probes read (a volume that reports no
 * inode, or timestamps too coarse to move).
 */
export interface CollectionReadHooks {
  readonly afterJournal?: () => void;
  readonly afterRecord?: () => void;
  readonly stat?: (path: string) => FileIdentity | undefined;
}
export interface FileIdentity {
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}
/**
 * Which record counts, read only:
 * 1. a journal beside `pending.json`: an operation was interrupted and is not recovered, so no identity counts;
 * 2. a journal without `pending.json`: its `after` while the activation pointer is exactly `afterActive`, its `before`
 *    while exactly `beforeActive`, and otherwise the collections both sides agree on, the rest unknown;
 * 3. no journal: the record file.
 */
export function currentCollections(rootInput: string, hooks: CollectionReadHooks = {}): CurrentCollections {
  const root = workspace(rootInput);
  const journal = readCollectionsJournal(root);
  hooks.afterJournal?.();
  if (journal.state === 'invalid') return { record: null, source: 'none', problems: [journal.problem] };
  if (journal.state === 'present') {
    if (bytes(root, INSTALL_PATHS.pending, 4 * DISTRIBUTION_LIMITS.metadata) !== null)
      return { record: null, source: 'interrupted', problems: ['installation interrupted; run ia recover'] };
    const { journal: entry } = journal,
      active = activeBytes(root);
    if (active === entry.afterActive) return { record: decodeOrNull(entry.after), source: 'after', problems: [] };
    if (active === entry.beforeActive) return { record: decodeOrNull(entry.before), source: 'before', problems: [] };
    return { record: undecidedRecord(entry, lockDigest(root)), source: 'undecided', problems: [] };
  }
  const read = readKitCollections(root);
  hooks.afterRecord?.();
  if (read.state === 'absent') return { record: null, source: 'none', problems: [] };
  if (read.state === 'invalid') return { record: null, source: 'none', problems: [read.problem] };
  return { record: read.record, source: 'file', problems: [] };
}

export interface IntactCollections {
  /** The collections whose every recorded member is the lock's exact pin. */
  readonly collections: readonly CollectionRow[];
  /** Collections whose identity is unknown, with the member ids still in the lock. */
  readonly unknown: readonly UnknownCollection[];
  /** The record's direct requests (`KitCollections.named`) that are still lock requests. */
  readonly named: readonly string[];
  readonly problems: readonly string[];
}
const pinned = (lock: DistributionLock, member: CollectionMember): boolean =>
  lock.packages.some(
    (locked) => locked.id === member.id && locked.version === member.version && locked.archive === member.archive,
  );
/**
 * The collections that count against `lock`, the portable lock now on disk: none unless the chosen record names those
 * exact bytes (their sha256, `lockSha`), and within it only a collection whose every member equals the lock's row of that id.
 */
export function intactAgainst(
  current: CurrentCollections,
  lock: DistributionLock | null,
  lockSha: string | null,
): IntactCollections {
  const problems = [...current.problems];
  if (current.record === null || lock === null) return { collections: [], unknown: [], named: [], problems };
  if (lockSha === null || current.record.lock !== lockSha) {
    problems.push(`${KIT_COLLECTIONS} describes another lock; collection sources are unknown`);
    return { collections: [], unknown: [], named: [], problems };
  }
  const ids = new Set(lock.packages.map((locked) => locked.id));
  return {
    collections: current.record.collections.filter((row) => row.members.every((member) => pinned(lock, member))),
    unknown: current.record.unknown
      .map((row) => ({ id: row.id, members: row.members.filter((member) => ids.has(member)) }))
      .filter((row) => row.members.length > 0),
    named: (current.record.named ?? []).filter((id) => lock.requests.some((request) => request.id === id)),
    problems,
  };
}

/**
 * Builds the rows an operation expanded from the resolved plan lock: each member id joined to the lock's `packages`
 * row of that id, for its exact version and archive. A member the lock lacks is a defect, refused before anything
 * commits.
 */
export function expandedRows(expanded: readonly ExpandedCollection[], lock: DistributionLock): CollectionRow[] {
  return expanded.map((collection) => ({
    id: collection.id,
    version: collection.version,
    registry: collection.registry,
    members: collection.members.map((id) => {
      const locked = lock.packages.find((row) => row.id === id);
      if (locked === undefined)
        return fail(
          'INSTALL-COLLECTION-MISMATCH',
          `Collection ${collection.id}@${collection.version} lists ${id}, which the resolved lock does not hold`,
        );
      return { id, version: locked.version, archive: locked.archive };
    }),
  }));
}

/**
 * The record after an operation, pure:
 * 1. `current` is the record that counted before it, already matched against the lock before the operation (null
 *    otherwise);
 * 2. every row of a collection this operation expanded is dropped, to be rewritten;
 * 3. every other row is kept only while all its recorded members are `afterLock`'s exact pins; a row with any member
 *    removed, re-pinned or re-archived is removed whole, so its other members can never make it intact again;
 * 4. the expanded rows are added, built from `afterLock`.
 * An unknown entry is kept until its collection is installed again or none of its members is left in the lock.
 * `named` adds the requests this operation counts as named by the user; with the record's own, each is kept while it is
 * still an `afterLock` request that a row or unknown entry of the result lists.
 */
export function mergeKitCollections(
  current: KitCollections | null,
  expanded: readonly ExpandedCollection[],
  afterLock: DistributionLock,
  afterLockBytes: string,
  named: readonly string[] = [],
): KitCollections {
  const rewritten = new Set(expanded.map((collection) => collection.id)),
    ids = new Set(afterLock.packages.map((locked) => locked.id));
  const kept = (current?.collections ?? []).filter(
    (row) => !rewritten.has(row.id) && row.members.every((member) => pinned(afterLock, member)),
  );
  const collections = [...kept, ...expandedRows(expanded, afterLock)].sort(byId),
    unknown = (current?.unknown ?? [])
      .filter((row) => !rewritten.has(row.id) && row.members.some((member) => ids.has(member)))
      .sort(byId);
  const listed = new Set([
    ...collections.flatMap((row) => row.members.map((member) => member.id)),
    ...unknown.flatMap((row) => row.members),
  ]);
  const direct = [...new Set([...(current?.named ?? []), ...named])]
    .filter((id) => listed.has(id) && afterLock.requests.some((request) => request.id === id))
    .sort();
  return {
    ...KIT_COLLECTIONS_HEADER,
    lock: sha256(afterLockBytes),
    collections,
    unknown,
    ...(direct.length > 0 ? { named: direct } : {}),
  };
}
/** Whether a record carries nothing worth committing: an empty record is never written, and a record left empty is removed. */
export const emptyRecord = (record: KitCollections): boolean =>
  record.collections.length === 0 && record.unknown.length === 0;

/**
 * Settles a journal no `pending.json` stands beside (an older CLI recovered the operation without reading it), under the
 * installation lock: the record is written as the side the activation pointer exactly names, or, when it names
 * neither, as the collections both sides agree on with the rest unknown; the journal is then removed. Returns whether
 * a journal was settled.
 */
export function settleOrphanJournal(root: string): boolean {
  const journal = readCollectionsJournal(root);
  if (journal.state === 'absent') return false;
  if (journal.state === 'present') {
    const { journal: entry } = journal,
      active = activeBytes(root);
    const content =
      active === entry.afterActive
        ? entry.after
        : active === entry.beforeActive
          ? entry.before
          : (() => {
              const undecided = undecidedRecord(entry, lockDigest(root));
              return undecided === null || emptyRecord(undecided) ? null : serializeKitCollections(undecided);
            })();
    writeRecord(root, content);
  }
  // An unreadable journal names no side, so it is dropped and the record file stands as it is.
  removeCollectionsJournal(root);
  return true;
}
/** Recovery's side of the journal: the record as the operation left it when it committed, as before when it did not. */
export function settleKitCollections(root: string, committed: boolean): void {
  const journal = readCollectionsJournal(root);
  if (journal.state === 'absent') return;
  if (journal.state === 'present') writeRecord(root, committed ? journal.journal.after : journal.journal.before);
  removeCollectionsJournal(root);
}
export { writeRecord as writeKitCollections };

/**
 * `currentCollections` matched against the portable lock now on disk. Never throws: a lock that cannot be read leaves
 * no collection intact, with the reason.
 */
export function intactCollections(rootInput: string, hooks: CollectionReadHooks = {}): IntactCollections {
  const root = workspace(rootInput);
  const { current, lock: content } = stableCollections(root, hooks);
  let lock: DistributionLock | null;
  try {
    lock = content === null ? null : decodeDistributionLock(decodeDistributionJson(utf8(content)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { collections: [], unknown: [], named: [], problems: [`${INSTALL_PATHS.lock}: ${reason}`] };
  }
  return intactAgainst(current, lock, content === null ? null : sha256(content));
}

/** An inode the platform could not report: Node gives 0, and some file systems all ones. */
const NO_INODE = new Set([0n, 2n ** 64n - 1n, 2n ** 32n - 1n]);
/**
 * One file's identity: its content hash with its inode, modification time in nanoseconds and size. Every writer here
 * replaces a file by renaming a new one into place, so a file put back with identical bytes still reads as another
 * file. Where no inode is reported, the modification time, size and hash stand alone.
 */
function identity(root: string, path: string, limit: number, read: (path: string) => FileIdentity | undefined): string {
  const content = bytes(root, path, limit);
  if (content === null) return '-';
  const stat = read(join(root, path));
  const inode = stat === undefined || NO_INODE.has(stat.ino) ? '-' : String(stat.ino);
  return `${sha256(content)}/${inode}/${stat?.mtimeNs ?? '-'}/${stat?.size ?? '-'}`;
}
/**
 * The files a collection read depends on: pending marker, journal, activation pointer, lock and record, each by
 * content and file identity.
 */
const lstatIdentity = (path: string): FileIdentity | undefined =>
  lstatSync(path, { bigint: true, throwIfNoEntry: false });
function probe(root: string, read: (path: string) => FileIdentity | undefined = lstatIdentity): string {
  return [
    identity(root, INSTALL_PATHS.pending, 4 * DISTRIBUTION_LIMITS.metadata, read),
    identity(root, KIT_COLLECTIONS_JOURNAL, 4 * DISTRIBUTION_LIMITS.metadata, read),
    identity(root, INSTALL_PATHS.active, 1024 * 1024, read),
    identity(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata, read),
    identity(root, KIT_COLLECTIONS, DISTRIBUTION_LIMITS.metadata, read),
  ].join(':');
}
/**
 * The record that counts and the lock bytes it is judged against, read between two probes of the installation state:
 * a reader never sees a record from before an operation began beside a pointer from after (or the reverse), because
 * another process changing the files in between makes the probes differ. The read is tried once more, and when the
 * state changes again it fails closed: every collection the record or journal names is reported with an unknown
 * identity, never as intact.
 */
export function stableCollections(
  rootInput: string,
  hooks: CollectionReadHooks = {},
): { readonly current: CurrentCollections; readonly lock: Buffer | null } {
  const root = workspace(rootInput);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = probe(root, hooks.stat);
    const current = currentCollections(root, hooks);
    const lock = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata);
    if (probe(root, hooks.stat) === before) return { current, lock };
  }
  const lock = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata);
  return { current: unstableCollections(root, lock === null ? null : sha256(lock)), lock };
}
/** Every collection the record file or a journal side names, as unknown, with the member ids any of them recorded. */
function unstableCollections(root: string, lockSha: string | null): CurrentCollections {
  const journal = readCollectionsJournal(root),
    file = readKitCollections(root);
  const sides = [
    file.state === 'present' ? file.record : null,
    journal.state === 'present' ? decodeOrNull(journal.journal.before) : null,
    journal.state === 'present' ? decodeOrNull(journal.journal.after) : null,
  ].filter((side): side is KitCollections => side !== null);
  const members = new Map<string, Set<string>>();
  for (const side of sides) {
    for (const row of side.collections)
      for (const member of row.members) members.set(row.id, (members.get(row.id) ?? new Set()).add(member.id));
    for (const row of side.unknown)
      for (const member of row.members) members.set(row.id, (members.get(row.id) ?? new Set()).add(member));
  }
  const problems = ['the installation changed while it was read; collection identity unknown'];
  if (members.size === 0 || lockSha === null) return { record: null, source: 'unstable', problems };
  return {
    record: {
      ...KIT_COLLECTIONS_HEADER,
      lock: lockSha,
      collections: [],
      unknown: [...members].map(([id, ids]) => ({ id, members: [...ids].sort() })).sort(byId),
    },
    source: 'unstable',
    problems,
  };
}
