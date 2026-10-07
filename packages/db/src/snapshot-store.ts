import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { BAND_OF, isPlacementKind } from '@inventarch/language';
import { canonicalRoot } from '@inventarch/graph';
import { DbError } from './errors.js';
import { safePath, workspaceRoot } from './inputs.js';
import type { MembershipRow } from './membership.js';

/**
 * Where capture keeps its snapshots (D14). One constant so the location is a single swap: the store is independent of
 * the disposable D06 cache, so it is written and read with `cache: false`.
 */
export const CAPTURE_DIR = '.ia/work/snapshot';
/** Every store lives strictly under this generated-output directory, never beside authored sources. */
const WORK = '.ia/work/';
/** Written into a store directory that a write created: snapshots regenerate per clone and are not committed. */
export const CAPTURE_IGNORE = '# Written by IA capture: snapshots regenerate per clone.\n*\n';
const FORMAT = 'ia-snapshot-1';
const SLOTS = ['current', 'previous'] as const;
const HEX = /^[0-9a-f]{64}$/;

/** One captured snapshot: the root view's revision and its D13 membership rows (each with its G13 digest). */
export interface CapturedSnapshot {
  readonly format: typeof FORMAT;
  readonly revision: string;
  readonly membership: readonly MembershipRow[];
}
/** Per-record digests of one snapshot, by identity. `OpenOptions.previous` seeds a handle's staleness with one. */
export interface DigestIndex {
  readonly revision: string;
  readonly digests: ReadonlyMap<string, string>;
}
export interface SnapshotObservation {
  readonly code: 'IA-DB-SNAPSHOT-UNAVAILABLE';
  readonly severity: 'warning';
  readonly path: string;
  readonly message: string;
}
/** The retained snapshots. A missing slot was never written; an unreadable one is absent with an observation. */
export interface CapturedStore {
  readonly current?: CapturedSnapshot;
  readonly previous?: CapturedSnapshot;
  readonly observations: readonly SnapshotObservation[];
}
export interface CaptureWrite {
  /** The stored current became previous because the captured revision changed. */
  readonly rotated: boolean;
  /** False when the stored current already held these exact bytes. */
  readonly written: boolean;
}

const unusable = (message: string): DbError => new DbError('IA-DB-SNAPSHOT-UNAVAILABLE', message);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function row(value: unknown): MembershipRow {
  if (!plain(value) || !exactKeys(value, ['identity', 'seat', 'root', 'placement', 'band', 'digest']))
    throw unusable('A membership row must be exactly {identity, seat, root, placement, band, digest}');
  const { identity, seat, root, placement, band, digest } = value;
  if (
    typeof identity !== 'string' ||
    identity === '' ||
    (seat !== null && (typeof seat !== 'string' || seat === '')) ||
    typeof root !== 'string' ||
    typeof placement !== 'string' ||
    !isPlacementKind(placement) ||
    band !== BAND_OF[placement] ||
    typeof digest !== 'string' ||
    !HEX.test(digest)
  )
    throw unusable(`Membership row ${JSON.stringify(identity)} is malformed`);
  return Object.freeze({ identity, seat, root, placement, band: BAND_OF[placement], digest });
}
/** Strict copy: exact keys, a sha256 revision, well-formed rows in strictly ascending identity order. */
function snapshotOf(value: unknown): CapturedSnapshot {
  if (!plain(value) || !exactKeys(value, ['format', 'revision', 'membership']))
    throw unusable('A captured snapshot must be exactly {format, revision, membership}');
  const { format, revision, membership: rows } = value;
  if (format !== FORMAT) throw unusable(`Unknown snapshot format ${JSON.stringify(format)}`);
  if (typeof revision !== 'string' || !HEX.test(revision))
    throw unusable('A captured snapshot revision must be a sha256 hex digest');
  if (!Array.isArray(rows)) throw unusable('A captured snapshot membership must be a list');
  const membership = rows.map(row);
  for (let i = 1; i < membership.length; i++)
    if (compare(membership[i - 1]!.identity, membership[i]!.identity) >= 0)
      throw unusable('Membership rows must be unique and ordered by identity');
  return Object.freeze({ format: FORMAT, revision, membership: Object.freeze(membership) });
}
const encode = (snapshot: CapturedSnapshot): string => JSON.stringify(snapshot) + '\n';

/** The capture of a reader's root view: its revision and its unscoped membership. */
export function captureOf(reader: {
  readonly revision: string;
  membership(): readonly MembershipRow[];
}): CapturedSnapshot {
  return snapshotOf({ format: FORMAT, revision: reader.revision, membership: [...reader.membership()] });
}
export function digestIndex(snapshot: CapturedSnapshot): DigestIndex {
  const checked = snapshotOf(snapshot);
  return Object.freeze({
    revision: checked.revision,
    digests: new Map(checked.membership.map((member) => [member.identity, member.digest])),
  });
}

function storeDir(dir: string): string {
  // A NUL byte never names a file; refused here, it never reaches the filesystem as a write failure.
  if (dir.includes('\0'))
    throw new DbError('IA-DB-PATH-UNSAFE', `The snapshot store path holds a NUL byte: ${JSON.stringify(dir)}`);
  let canonical: string;
  try {
    canonical = canonicalRoot(dir);
  } catch (error) {
    throw new DbError('IA-DB-PATH-UNSAFE', `Unsafe snapshot store '${dir}': ${String(error)}`);
  }
  if (canonical === '' || canonical !== dir)
    throw new DbError('IA-DB-PATH-UNSAFE', `The snapshot store must be a canonical workspace subdirectory: '${dir}'`);
  if (!canonical.startsWith(WORK))
    throw new DbError('IA-DB-PATH-UNSAFE', `The snapshot store must be a directory under ${WORK}: '${dir}'`);
  // Windows drops trailing dots and spaces from every segment, so `x.`, `x ` or `...` would name another directory
  // there (a last segment of only dots names its parent); they are refused on every platform so a store path means
  // the same directory everywhere.
  if (canonical.split('/').some((segment) => /[. ]$/.test(segment)))
    throw new DbError(
      'IA-DB-PATH-UNSAFE',
      `The snapshot store's path segments must not end in a dot or a space: '${dir}'`,
    );
  return canonical;
}
function readSlot(root: string, path: string): { bytes?: string; snapshot?: CapturedSnapshot; error?: string } {
  let bytes: string;
  try {
    bytes = readFileSync(safePath(root, path), 'utf8');
  } catch (error) {
    if (error instanceof DbError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: String(error) };
  }
  try {
    return { bytes, snapshot: snapshotOf(JSON.parse(bytes)) };
  } catch (error) {
    return { bytes, error: error instanceof Error ? error.message : String(error) };
  }
}
/** Atomic replacement through a unique same-directory temporary file; containment is rechecked at each access. */
function publish(root: string, dir: string, name: string, bytes: string): void {
  const temporary = `${dir}/${name}.${randomUUID()}.tmp`;
  try {
    writeFileSync(safePath(root, temporary), bytes, { encoding: 'utf8', flag: 'wx' });
    renameSync(safePath(root, temporary), safePath(root, `${dir}/${name}`));
  } catch (error) {
    try {
      unlinkSync(safePath(root, temporary));
    } catch {
      /* an unpublished temporary file is never read */
    }
    if (error instanceof DbError) throw error;
    throw unusable(`Cannot write ${dir}/${name}: ${String(error)}`);
  }
}

/** Reads the retained snapshots under `dir` (default CAPTURE_DIR, always under `.ia/work/`). Reads no sources and needs no cache. */
export function readCaptured(root: string, dir: string = CAPTURE_DIR): CapturedStore {
  const base = workspaceRoot(root),
    store = storeDir(dir),
    observations: SnapshotObservation[] = [],
    slots: { current?: CapturedSnapshot; previous?: CapturedSnapshot } = {};
  for (const slot of SLOTS) {
    const path = `${store}/${slot}.json`,
      read = readSlot(base, path);
    if (read.snapshot !== undefined) slots[slot] = read.snapshot;
    else if (read.error !== undefined)
      observations.push(
        Object.freeze({
          code: 'IA-DB-SNAPSHOT-UNAVAILABLE' as const,
          severity: 'warning' as const,
          path,
          message: `Snapshot unavailable: ${read.error}`,
        }),
      );
  }
  return Object.freeze({ ...slots, observations: Object.freeze(observations) });
}
/** The capture store at its fixed location: what a later process (any door, `cache: false`) compares against. */
export function readCapturedSnapshot(root: string): CapturedStore {
  return readCaptured(root, CAPTURE_DIR);
}
/**
 * Publishes `next` as current under `dir`, a directory strictly under `.ia/work/`. The stored current becomes previous
 * only when its revision differs from `next`'s, so a capture without change keeps previous; an unreadable current is
 * replaced, never rotated. Only two are retained. There is no lock: concurrent writers are last-writer-wins (D14).
 */
export function writeCaptured(root: string, dir: string, next: CapturedSnapshot): CaptureWrite {
  const base = workspaceRoot(root),
    store = storeDir(dir),
    bytes = encode(snapshotOf(next)),
    stored = readSlot(base, `${store}/current.json`);
  if (stored.bytes === bytes) return Object.freeze({ rotated: false, written: false });
  let created: string | undefined;
  try {
    created = mkdirSync(safePath(base, store), { recursive: true });
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw unusable(`Cannot create ${store}: ${String(error)}`);
  }
  // Only a directory this write created is ignored: an existing one, and any .gitignore in it, is the consumer's.
  if (created !== undefined) publish(base, store, '.gitignore', CAPTURE_IGNORE);
  const rotated = stored.snapshot !== undefined && stored.snapshot.revision !== next.revision;
  if (rotated) publish(base, store, 'previous.json', encode(stored.snapshot!));
  publish(base, store, 'current.json', bytes);
  return Object.freeze({ rotated, written: true });
}
