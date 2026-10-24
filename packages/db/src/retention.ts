import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isBand } from '@inventarch/language';
import { stableSerialize } from '@inventarch/graph';
import { DbError } from './errors.js';
import { safePath } from './inputs.js';
import { authoredRows } from './membership.js';
import type { MembershipRow } from './membership.js';
import { OPENED_READ_FLAGS, OPENS_THROUGH_LINKS, lstatNamed } from './named.js';

/** D08: an admitted root snapshot (location '', no phase) as retained: its revisions and D02a membership rows. */
export interface RetainedSnapshot {
  readonly revision: string;
  /** Its authored revision (graph `authoredRevisionOf`), which retention rotates by and trusts a capture by. */
  readonly authoredRevision: string;
  readonly membership: readonly MembershipRow[];
}
/** D08: the current root snapshot and the most recent one whose authored revision differs from it, when there is one. */
export interface Retained {
  readonly current: RetainedSnapshot;
  readonly previous?: RetainedSnapshot;
}
/** D08: a record's current membership digest against the previous snapshot's. */
export type Staleness = 'unchanged' | 'changed' | 'new' | 'removed';
/** D08: the retained snapshot whose digest for a record equals an observed one. */
export type Readiness = 'current' | 'previous' | 'unknown';

const HEX = /^[0-9a-f]{64}$/;
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
/**
 * D08 rotation: the prior current becomes previous only when the authored revision changed, so a change to runtime-band
 * sources alone keeps the prior previous, as an unchanged revision does.
 */
export function rotate(prior: Retained | undefined, current: RetainedSnapshot): Retained {
  const previous =
    prior === undefined
      ? undefined
      : prior.current.authoredRevision === current.authoredRevision
        ? prior.previous
        : prior.current;
  return Object.freeze({ current, ...(previous === undefined ? {} : { previous }) });
}

/**
 * D08a: the capture pair, the one retained pair that persists between processes. `ia capture` writes it through
 * `writeCapture`, and every handle reads it, whatever its cache setting, to seed its previous snapshot.
 */
export const CAPTURE_FORMAT = 'ia-snapshot-1';
export const CAPTURE_DIRECTORY = '.ia/work/snapshot';
export const CAPTURE_CURRENT = `${CAPTURE_DIRECTORY}/current.json`;
export const CAPTURE_PREVIOUS = `${CAPTURE_DIRECTORY}/previous.json`;

/** A capture as read back: its exact bytes and the retained part, its revisions and membership rows. */
interface Captured extends RetainedSnapshot {
  readonly bytes: Buffer;
}
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
/**
 * The retained part of an `ia-snapshot-1` document, or why the bytes are none. A document without `authoredRevision`
 * (one written before the authored revision) names its `revision` as its authored revision, which it was while no
 * source sat at runtime placement.
 */
function capturedOf(bytes: Buffer): Captured | string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'is not JSON';
  }
  if (!plain(value) || value['format'] !== CAPTURE_FORMAT) return `is not an ${CAPTURE_FORMAT} document`;
  const revision = value['revision'],
    authoredRevision = Object.hasOwn(value, 'authoredRevision') ? value['authoredRevision'] : revision,
    rows = value['membership'];
  if (typeof revision !== 'string' || !HEX.test(revision) || !Array.isArray(rows))
    return 'has no revision or membership rows';
  if (typeof authoredRevision !== 'string' || !HEX.test(authoredRevision)) return 'has a malformed authored revision';
  const identities = new Set<string>(),
    membership: MembershipRow[] = [];
  for (const row of rows as unknown[]) {
    if (
      !plain(row) ||
      !exactly(row, ['band', 'digest', 'identity', 'root']) ||
      typeof row['identity'] !== 'string' ||
      identities.has(row['identity']) ||
      typeof row['root'] !== 'string' ||
      typeof row['band'] !== 'number' ||
      !isBand(row['band']) ||
      typeof row['digest'] !== 'string' ||
      !HEX.test(row['digest'])
    )
      return 'has a malformed membership row';
    identities.add(row['identity']);
    membership.push(
      Object.freeze({ identity: row['identity'], root: row['root'], band: row['band'], digest: row['digest'] }),
    );
  }
  return Object.freeze({ bytes, revision, authoredRevision, membership: Object.freeze(membership) });
}
/** The refusal of an entry at `path` that is not a regular file. */
const irregular = (path: string): DbError => new DbError('IA-DB-PATH-UNSAFE', `${path} is not a regular file`, path);
/**
 * The entry at `path`, contained the D01 way: undefined when nothing is there, refused as IA-DB-PATH-UNSAFE when the
 * path runs through a link or junction or the entry is not a regular file, so nothing is read or written through one.
 */
export function entryAt(root: string, path: string): string | undefined {
  const target = safePath(root, path),
    stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw irregular(path);
  return target;
}
/**
 * The directories the pair lives in, contained the D01 way and in order from the root, so nothing is read below an
 * entry that is not a directory: refused as IA-DB-PATH-UNSAFE when one is a link or junction or another kind of entry,
 * which a write could only fail on; a missing one ends the walk, as a capture creates it.
 */
function directories(root: string): void {
  for (const path of ['.ia', '.ia/work', CAPTURE_DIRECTORY]) {
    const stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (!stat.isDirectory()) throw new DbError('IA-DB-PATH-UNSAFE', `${path} is not a directory`, path);
  }
}
/**
 * The capture at `path`: null when there is none, or why the file there is no capture. The name `entryAt` admits is
 * opened before what it names is judged, with `OPENED_READ_FLAGS`, and read through that descriptor as `readFileSync`
 * reads a file, so the bytes are of the file judged: a FIFO put at the name since is not waited on, a terminal there does
 * not become the process's controlling terminal, and a final link is not followed where the platform has the no-follow
 * flag. What opens is read only if it is a regular file, refused as `entryAt` refuses one that is not; when the open
 * fails, `entryAt` judges the name again, and a name that is gone, or a regular file that does not open, answers with
 * the open's error, as a failed read does. Where the open follows a final link (`OPENS_THROUGH_LINKS`, Windows), the
 * name must still name the file read once it is read: otherwise `entryAt` judges it, refusing a link or an entry that
 * is not a regular file as it does, and a name that names nothing or another file is IA-DB-PATH-UNSAFE. There, what
 * opens that is not a regular file is judged by `entryAt` first too, so a link to one is refused as a link.
 */
function readCaptured(root: string, path: string): Captured | string | null {
  const target = entryAt(root, path);
  if (target === undefined) return null;
  // `entryAt`'s judgment of what the name names now: only its own refusals replace the error at hand.
  const judgeName = (): void => {
    try {
      entryAt(root, path);
    } catch (refusal) {
      if (refusal instanceof DbError) throw refusal;
    }
  };
  let fd: number;
  try {
    fd = openSync(target, OPENED_READ_FLAGS);
  } catch (error) {
    judgeName();
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) {
      if (OPENS_THROUGH_LINKS) judgeName();
      throw irregular(path);
    }
    const bytes = readFileSync(fd);
    if (OPENS_THROUGH_LINKS) {
      const named = lstatNamed(target);
      if (named?.isFile() !== true || named.dev !== opened.dev || named.ino !== opened.ino) {
        judgeName();
        throw new DbError('IA-DB-PATH-UNSAFE', `${path} changed while it was read`, path);
      }
    }
    return capturedOf(bytes);
  } finally {
    closeSync(fd);
  }
}

/** D08a: what the capture pair seeds a handle with. */
export interface CaptureSeed {
  /**
   * The pair as `rotate` takes it: the capture at current.json and, at another authored revision, the one at
   * previous.json.
   */
  readonly prior?: Retained;
  /** The revision and authored revision of the capture at current.json, when that file holds one. */
  readonly captured?: Pick<RetainedSnapshot, 'revision' | 'authoredRevision'>;
}
/**
 * D08a: the capture pair as a handle reads it, never written. A link or junction on the way, an entry that is not a
 * regular file, or a file that is no capture is ignored, never followed, so a read stays usable. With no readable
 * current.json a capture at previous.json still seeds, as the most recent capture there is. A capture is trusted by its
 * authored revision and the membership rows of its records not at runtime placement, by identity, band and digest
 * (`authoredRows`): a current.json that names the fresh authored revision with other such rows is not this workspace's
 * capture at that revision, so the pair seeds nothing, while one that differs from the fresh snapshot only in its
 * runtime-band rows (and so in its revision) or in the roots a runtime-band @workspace declares is this workspace's; a
 * capture at another authored revision cannot be rebuilt from the fresh inputs, so it is trusted as written.
 */
export function readCapture(root: string, fresh: RetainedSnapshot): CaptureSeed {
  const read = (path: string): Captured | undefined => {
    try {
      const captured = readCaptured(root, path);
      return captured === null || typeof captured === 'string' ? undefined : captured;
    } catch {
      return undefined;
    }
  };
  const current = read(CAPTURE_CURRENT),
    previous = read(CAPTURE_PREVIOUS);
  const snapshot = (captured: Captured): RetainedSnapshot =>
    Object.freeze({
      revision: captured.revision,
      authoredRevision: captured.authoredRevision,
      membership: captured.membership,
    });
  if (current === undefined)
    return previous === undefined ? {} : { prior: Object.freeze({ current: snapshot(previous) }) };
  const sameRows = (a: readonly Omit<MembershipRow, 'root'>[], b: readonly Omit<MembershipRow, 'root'>[]): boolean => {
    const order = (rows: readonly Omit<MembershipRow, 'root'>[]) =>
      [...rows].sort((x, y) => (x.identity < y.identity ? -1 : x.identity > y.identity ? 1 : 0));
    return stableSerialize(order(a)) === stableSerialize(order(b));
  };
  if (
    current.authoredRevision === fresh.authoredRevision &&
    !sameRows(authoredRows(current.membership), authoredRows(fresh.membership))
  )
    return {};
  return {
    captured: Object.freeze({ revision: current.revision, authoredRevision: current.authoredRevision }),
    prior: Object.freeze({
      current: snapshot(current),
      ...(previous === undefined || previous.authoredRevision === current.authoredRevision
        ? {}
        : { previous: snapshot(previous) }),
    }),
  };
}

/** D08a: what a capture wrote and how its records compare with the prior capture. */
export interface CaptureWrite {
  /** The revision of the prior capture at current.json, which the counts compare with; null when there was none. */
  readonly prior: string | null;
  /** Why an existing current.json was not taken as the prior capture; null when it was, or when there was none. */
  readonly ignored: string | null;
  /** The revision previous.json holds after the write; null when no previous capture is retained. */
  readonly previous: string | null;
  /** Whether the prior current.json became previous.json. */
  readonly rotated: boolean;
  readonly changed: number;
  readonly unchanged: number;
  readonly added: number;
  readonly removed: number;
}
/** D08b: what a capture would write, decided before its first write: its result and the identities it counts. */
export interface CapturePlan extends CaptureWrite {
  /** The identities `changed`, `added` and `removed` count, each list sorted. */
  readonly identities: {
    readonly changed: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
}
/** The write's result and what its writes act on: the new bytes and the pair as read. */
interface Planned {
  readonly result: CaptureWrite;
  /** The identities the result's `changed`, `added` and `removed` count, in membership order. */
  readonly identities: { readonly changed: string[]; readonly added: string[]; readonly removed: string[] };
  readonly bytes: Buffer;
  /** previous.json as read: null when nothing is there. */
  readonly kept: Captured | string | null;
  readonly prior: Captured | undefined;
  /** The prior capture a new authored revision rotates into previous.json. */
  readonly moving: Captured | undefined;
  /** The previous.json kept when nothing rotates. */
  readonly keeping: Captured | undefined;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Every check and read `writeCapture` makes before its first write; nothing is created or written. */
function planned(root: string, text: string): Planned {
  const bytes = Buffer.from(text, 'utf8'),
    built = capturedOf(bytes);
  if (typeof built === 'string') throw new TypeError(`The capture to write ${built}`);
  directories(root);
  const read = readCaptured(root, CAPTURE_CURRENT),
    kept = readCaptured(root, CAPTURE_PREVIOUS),
    prior = read !== null && typeof read === 'object' ? read : undefined,
    held = kept !== null && typeof kept === 'object' ? kept : undefined;
  const changed: string[] = [],
    added: string[] = [];
  let unchanged = 0;
  for (const row of built.membership) {
    const staleness = stalenessOf(row.digest, digestIn(prior, row.identity));
    if (staleness === 'new') added.push(row.identity);
    else if (staleness === 'unchanged') unchanged += 1;
    else changed.push(row.identity);
  }
  const now = new Set(built.membership.map((row) => row.identity));
  const removed =
    prior === undefined ? [] : prior.membership.filter((row) => !now.has(row.identity)).map((row) => row.identity);
  const moving = prior !== undefined && prior.authoredRevision !== built.authoredRevision ? prior : undefined,
    keeping =
      moving === undefined && held !== undefined && held.authoredRevision !== built.authoredRevision ? held : undefined;
  const result: CaptureWrite = Object.freeze({
    prior: prior?.revision ?? null,
    ignored: typeof read === 'string' ? read : null,
    previous: (moving ?? keeping)?.revision ?? null,
    rotated: moving !== undefined,
    changed: changed.length,
    unchanged,
    added: added.length,
    removed: removed.length,
  });
  return { result, identities: { changed, added, removed }, bytes, kept, prior, moving, keeping };
}
/**
 * D08b: what `writeCapture(root, text)` would write and report, without writing: the same checks and reads, so it
 * refuses and throws as the capture would before its first write, and the same counts and rotation, with the
 * identities they count, each list sorted. It creates no directory and writes nothing, so the pair it reads stays as
 * it was.
 */
export function planCapture(root: string, text: string): CapturePlan {
  const { result, identities } = planned(root, text);
  const sorted = (named: string[]): readonly string[] => Object.freeze(named.sort(compare));
  return Object.freeze({
    ...result,
    identities: Object.freeze({
      changed: sorted(identities.changed),
      added: sorted(identities.added),
      removed: sorted(identities.removed),
    }),
  });
}
export const syncDirectory = (path: string): void => {
  // Windows exposes no fsync on a directory handle; a flushed file and a same-volume rename are what it offers.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
/** A new same-directory temporary file holding `bytes`, flushed, owner-only; its workspace-relative path. */
export function staged(root: string, path: string, bytes: Buffer): string {
  const temporary = `${path}.${randomUUID()}.tmp`,
    fd = openSync(safePath(root, temporary), 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temporary;
}
export const discard = (root: string, path: string | undefined): void => {
  if (path === undefined) return;
  try {
    unlinkSync(safePath(root, path));
  } catch {
    /* an unpublished temporary file is never read */
  }
};
/**
 * D08a: write `text`, an `ia-snapshot-1` document, as the current capture and keep the pair D08 retains. Its counts
 * follow `stalenessOf` against the prior capture at current.json: an equal digest is unchanged, another changed, a row
 * the prior lacks new, a prior row with none now removed. Its rotation is `rotate`'s, by authored revision: a capture at
 * a new authored revision makes the prior current.json previous.json, renamed, so byte for byte; one at an unchanged
 * authored revision (one that changes runtime-band sources alone among them) keeps previous.json while it holds a
 * capture at another authored revision; and with no readable prior capture a previous.json at another authored revision
 * is kept as the most recent capture there is. A previous.json at the new authored revision, or one that is no capture,
 * is removed once the current one is written.
 *
 * Nothing is written before every check passes: a link or junction on the way, an entry at `.ia`, `.ia/work` or the
 * snapshot directory that is not a directory, or an entry at either path that is not a regular file, refuses as
 * IA-DB-PATH-UNSAFE. The new bytes are staged first; a rotation then moves previous.json aside,
 * renames current.json to previous.json and the staged file to current.json, and a failed step renames each file back,
 * so a capture that fails leaves the pair it found, and only the error escapes. A current.json that already holds `text`
 * is not rewritten. Everything before the first write is `planCapture`'s.
 */
export function writeCapture(root: string, text: string): CaptureWrite {
  const { result, bytes, kept, prior, moving, keeping } = planned(root, text);
  mkdirSync(safePath(root, CAPTURE_DIRECTORY), { recursive: true });
  const current = safePath(root, CAPTURE_CURRENT),
    previous = safePath(root, CAPTURE_PREVIOUS);
  if (moving !== undefined) {
    let temporary: string | undefined = staged(root, CAPTURE_CURRENT, bytes),
      aside: string | undefined,
      moved = false;
    try {
      if (kept !== null) {
        const target = `${CAPTURE_PREVIOUS}.${randomUUID()}.tmp`;
        renameSync(previous, safePath(root, target));
        aside = target;
      }
      renameSync(current, previous);
      moved = true;
      renameSync(safePath(root, temporary), current);
      temporary = undefined;
    } catch (error) {
      // Each step is undone in reverse, so the pair this capture found is the pair it leaves.
      try {
        if (moved) renameSync(previous, current);
        if (aside !== undefined) renameSync(safePath(root, aside), previous);
        aside = undefined;
      } catch {
        // The moved-aside previous.json is kept rather than discarded; the original error is the one reported.
        aside = undefined;
      }
      throw error;
    } finally {
      discard(root, temporary);
      discard(root, aside);
    }
  } else {
    // No rotation: current.json is replaced when its bytes differ, and a previous.json that is no capture, or one at the
    // authored revision being written, is dropped. It is moved aside before current.json is published and removed only
    // after, so a failure at either step restores it and leaves the pair this capture found.
    let temporary: string | undefined =
        prior === undefined || !prior.bytes.equals(bytes) ? staged(root, CAPTURE_CURRENT, bytes) : undefined,
      aside: string | undefined;
    try {
      if (keeping === undefined && kept !== null) {
        const target = `${CAPTURE_PREVIOUS}.${randomUUID()}.tmp`;
        renameSync(previous, safePath(root, target));
        aside = target;
      }
      if (temporary !== undefined) renameSync(safePath(root, temporary), current);
      temporary = undefined;
    } catch (error) {
      try {
        if (aside !== undefined) renameSync(safePath(root, aside), previous);
      } catch {
        // The moved-aside previous.json is kept rather than discarded; the original error is the one reported.
      }
      aside = undefined;
      throw error;
    } finally {
      discard(root, temporary);
      discard(root, aside);
    }
  }
  syncDirectory(dirname(current));
  return result;
}
