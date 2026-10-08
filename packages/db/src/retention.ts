import { randomUUID } from 'node:crypto';
import {
  closeSync,
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
/** D08 rotation: the prior current becomes previous only when the revision changed; otherwise the prior previous stays. */
export function rotate(prior: Retained | undefined, current: RetainedSnapshot): Retained {
  const previous =
    prior === undefined ? undefined : prior.current.revision === current.revision ? prior.previous : prior.current;
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

/** A capture as read back: its exact bytes and the retained part, its revision and membership rows. */
interface Captured extends RetainedSnapshot {
  readonly bytes: Buffer;
}
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
/** The retained part of an `ia-snapshot-1` document, or why the bytes are none. */
function capturedOf(bytes: Buffer): Captured | string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'is not JSON';
  }
  if (!plain(value) || value['format'] !== CAPTURE_FORMAT) return `is not an ${CAPTURE_FORMAT} document`;
  const revision = value['revision'],
    rows = value['membership'];
  if (typeof revision !== 'string' || !HEX.test(revision) || !Array.isArray(rows))
    return 'has no revision or membership rows';
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
  return Object.freeze({ bytes, revision, membership: Object.freeze(membership) });
}
/**
 * The entry at `path`, contained the D01 way: undefined when nothing is there, refused as IA-DB-PATH-UNSAFE when the
 * path runs through a link or junction or the entry is not a regular file, so nothing is read or written through one.
 */
function entryAt(root: string, path: string): string | undefined {
  const target = safePath(root, path),
    stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new DbError('IA-DB-PATH-UNSAFE', `${path} is not a regular file`, path);
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
/** The capture at `path`: null when there is none, or why the file there is no capture. */
function readCaptured(root: string, path: string): Captured | string | null {
  const target = entryAt(root, path);
  return target === undefined ? null : capturedOf(readFileSync(target));
}

/** D08a: what the capture pair seeds a handle with. */
export interface CaptureSeed {
  /** The pair as `rotate` takes it: the capture at current.json and, at another revision, the one at previous.json. */
  readonly prior?: Retained;
  /** The revision of the capture at current.json, when that file holds one. */
  readonly captured?: string;
}
/**
 * D08a: the capture pair as a handle reads it, never written. A link or junction on the way, an entry that is not a
 * regular file, or a file that is no capture is ignored, never followed, so a read stays usable. With no readable
 * current.json a capture at previous.json still seeds, as the most recent capture there is. A current.json that names
 * the fresh revision with other membership rows is not this workspace's capture at that revision, so the pair seeds
 * nothing; a capture at another revision cannot be rebuilt from the fresh inputs, so it is trusted as written.
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
    Object.freeze({ revision: captured.revision, membership: captured.membership });
  if (current === undefined)
    return previous === undefined ? {} : { prior: Object.freeze({ current: snapshot(previous) }) };
  const sameRows = (a: readonly MembershipRow[], b: readonly MembershipRow[]): boolean => {
    const order = (rows: readonly MembershipRow[]) =>
      [...rows].sort((x, y) => (x.identity < y.identity ? -1 : x.identity > y.identity ? 1 : 0));
    return stableSerialize(order(a)) === stableSerialize(order(b));
  };
  if (current.revision === fresh.revision && !sameRows(current.membership, fresh.membership)) return {};
  return {
    captured: current.revision,
    prior: Object.freeze({
      current: snapshot(current),
      ...(previous === undefined || previous.revision === current.revision ? {} : { previous: snapshot(previous) }),
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
const syncDirectory = (path: string): void => {
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
function staged(root: string, path: string, bytes: Buffer): string {
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
const discard = (root: string, path: string | undefined): void => {
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
 * the prior lacks new, a prior row with none now removed. Its rotation is `rotate`'s: a capture at a new revision makes
 * the prior current.json previous.json, renamed, so byte for byte; one at an unchanged revision keeps previous.json while
 * it holds a capture at another revision; and with no readable prior capture a previous.json at another revision is
 * kept as the most recent capture there is. A previous.json at the new revision, or one that is no capture, is removed
 * once the current one is written.
 *
 * Nothing is written before every check passes: a link or junction on the way, an entry at `.ia`, `.ia/work` or the
 * snapshot directory that is not a directory, or an entry at either path that is not a regular file, refuses as
 * IA-DB-PATH-UNSAFE. The new bytes are staged first; a rotation then moves previous.json aside,
 * renames current.json to previous.json and the staged file to current.json, and a failed step renames each file back,
 * so a capture that fails leaves the pair it found, and only the error escapes. A current.json that already holds `text`
 * is not rewritten.
 */
export function writeCapture(root: string, text: string): CaptureWrite {
  const bytes = Buffer.from(text, 'utf8'),
    built = capturedOf(bytes);
  if (typeof built === 'string') throw new TypeError(`The capture to write ${built}`);
  directories(root);
  const read = readCaptured(root, CAPTURE_CURRENT),
    kept = readCaptured(root, CAPTURE_PREVIOUS),
    prior = read !== null && typeof read === 'object' ? read : undefined,
    held = kept !== null && typeof kept === 'object' ? kept : undefined;
  let changed = 0,
    unchanged = 0,
    added = 0;
  for (const row of built.membership) {
    const staleness = stalenessOf(row.digest, digestIn(prior, row.identity));
    if (staleness === 'new') added += 1;
    else if (staleness === 'unchanged') unchanged += 1;
    else changed += 1;
  }
  const now = new Set(built.membership.map((row) => row.identity));
  const removed = prior === undefined ? 0 : prior.membership.filter((row) => !now.has(row.identity)).length;
  const moving = prior !== undefined && prior.revision !== built.revision ? prior : undefined,
    keeping = moving === undefined && held !== undefined && held.revision !== built.revision ? held : undefined;
  const result: CaptureWrite = Object.freeze({
    prior: prior?.revision ?? null,
    ignored: typeof read === 'string' ? read : null,
    previous: (moving ?? keeping)?.revision ?? null,
    rotated: moving !== undefined,
    changed,
    unchanged,
    added,
    removed,
  });
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
    // revision being written, is dropped. It is moved aside before current.json is published and removed only after,
    // so a failure at either step restores it and leaves the pair this capture found.
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
