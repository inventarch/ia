import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Node } from '@inventarch/graph';
import type { CheckBinding } from './checks.js';
import { DbError } from './errors.js';
import { EVIDENCE_DIRECTORY, EVIDENCE_FILE, safePath } from './inputs.js';
import { discard, entryAt, staged, syncDirectory } from './retention.js';

/**
 * D14: runtime evidence (milestone generation-binding, plan amendment C14). The validate effect records each bound check
 * whose selected verdicts passed or failed as one `@observation` in `.ia/work/evidence/<authored revision>.ia`, a source
 * at runtime placement band 0 that only a reader opened with `evidence` reads, and that never moves the authored
 * revision. An observation is named `<check name>-<12-hex authored revision>`; pass is verdict `success`, fail is
 * `refusal`, and a not-evaluated check records nothing. The validate request records nothing for a refused admission,
 * and a failing built-in verdict always refuses it, so in this release it never writes a `refusal` (review finding F1).
 * Nothing else writes this directory.
 */
/** The word an evidence record is an instance of; a workspace whose vocabulary lacks it records no evidence. */
export const CHECK_EVIDENCE_WORD = 'observation';
export interface EvidenceObservation {
  /** The observation's name. */
  readonly name: string;
  /** The identity of the `@check` it observed. */
  readonly check: string;
  readonly verdict: 'success' | 'refusal';
}
/** What a validate effect recorded. */
export interface EvidenceWrite {
  /** The evidence file of the authored revision; null when nothing passed or failed, and none is kept. */
  readonly path: string | null;
  readonly observations: readonly EvidenceObservation[];
  /** False when the file already held exactly these bytes, or when there was nothing to write and nothing to remove. */
  readonly written: boolean;
  /** The evidence files of other authored revisions removed, and this revision's when it has nothing to record. */
  readonly pruned: readonly string[];
}
const HEX = /^[0-9a-f]{64}$/,
  /** The writer's own stamp, `Date.prototype.toISOString`'s exact form. */
  STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /** How far ahead of this clock a kept time may be: another writer's clock, never a time not yet reached. */
  SKEW = 5 * 60 * 1000;
/** A text value as a quoted literal, with no character the string syntax would have to escape. */
const quoted = (text: string): string => `"${text.replace(/["\\\u0000-\u001f]/g, ' ').trim()}"`;
const short = (revision: string): string => revision.slice(0, 12);

/**
 * The prior evidence file's observation times, by observation name, with the verdict and subject digest they were taken
 * for: an observation that would be recorded again unchanged keeps the time it was first made, so validating twice at
 * one authored revision writes the same bytes. Read from this writer's own layout; anything else is ignored, and so is a
 * time the writer would not have written: not its exact stamp, observed and captured apart, or later than this clock
 * allows (review finding B4-RC1). Times are carried, not verified: nothing else attests when an observation was made.
 */
function priorTimes(
  text: string | null,
): ReadonlyMap<string, { observedAt: string; capturedAt: string; verdict: string; digest: string }> {
  const times = new Map<string, { observedAt: string; capturedAt: string; verdict: string; digest: string }>();
  if (text === null) return times;
  for (const block of text.split(/^(?=@observation )/m)) {
    const name = /^@observation ([a-z][a-z0-9-]*)\n/.exec(block)?.[1],
      observedAt = /^ {4}observed-at "([^"\n]*)"$/m.exec(block)?.[1],
      capturedAt = /^ {4}captured-at "([^"\n]*)"$/m.exec(block)?.[1],
      verdict = /^ {4}verdict ([a-z]+)$/m.exec(block)?.[1],
      digest = /^ {4}subject-revision "([0-9a-f]{64})"$/m.exec(block)?.[1];
    if (
      name &&
      observedAt &&
      capturedAt &&
      verdict &&
      digest &&
      STAMP.test(observedAt) &&
      observedAt === capturedAt &&
      Date.parse(observedAt) <= Date.now() + SKEW
    )
      times.set(name, { observedAt, capturedAt, verdict, digest });
  }
  return times;
}

/**
 * The evidence file for `bindings` at `authoredRevision`, or null when no bound check passed or failed. `records` are the
 * admitted records the checks were read from (for their digests and for whether a check's name refers to it alone);
 * `prior` is the file this revision already has, whose times an unchanged observation keeps; `now` stamps the rest. A
 * check whose observation name an authored `@observation` already holds records nothing, so evidence never shadows,
 * duplicates or overwrites an authored record (a reader would refuse the whole file for it).
 */
export function evidenceText(input: {
  readonly authoredRevision: string;
  readonly bindings: readonly CheckBinding[];
  readonly records: readonly Node[];
  readonly prior: string | null;
  readonly now?: Date;
}): { readonly text: string | null; readonly observations: readonly EvidenceObservation[] } {
  const { authoredRevision, bindings, records } = input;
  if (!HEX.test(authoredRevision)) throw new TypeError('An authored revision is 64 hex digits');
  const stamp = (input.now ?? new Date()).toISOString(),
    times = priorTimes(input.prior),
    checks = records.filter((record) => record.discriminator === 'check'),
    authored = new Set(
      records
        .filter((record) => record.discriminator === CHECK_EVIDENCE_WORD && record.band !== 0)
        .map((record) => record.name),
    );
  const observations: EvidenceObservation[] = [],
    blocks: string[] = [];
  for (const binding of bindings) {
    if (binding.status !== 'bound' || binding.outcome === 'not-evaluated') continue;
    const record = checks.find((check) => check.identity === binding.identity);
    if (record === undefined) continue;
    const name = `${binding.name}-${short(authoredRevision)}`;
    if (authored.has(name)) continue;
    const verdict = binding.outcome === 'pass' ? 'success' : 'refusal',
      prior = times.get(name),
      kept = prior !== undefined && prior.verdict === verdict && prior.digest === record.digest ? prior : undefined;
    // A typed subject only when the check's name refers to it alone; the locator always carries its identity.
    const unique = checks.filter((check) => check.name === binding.name).length === 1;
    observations.push(Object.freeze({ name, check: binding.identity, verdict }));
    blocks.push(
      [
        `@observation ${name}`,
        '  meaning',
        `    says ${quoted(`ia validate observed check ${binding.name} ${binding.outcome === 'pass' ? 'passing' : 'failing'} at authored revision ${short(authoredRevision)}.`)}`,
        `    answers ${quoted(`Did check ${binding.name} pass at authored revision ${short(authoredRevision)}?`)}`,
        '  evidence',
        '    origin check',
        `    actor ${quoted('ia validate')}`,
        `    observed-at ${quoted(kept?.observedAt ?? stamp)}`,
        `    captured-at ${quoted(kept?.capturedAt ?? stamp)}`,
        `    workspace ${quoted('.')}`,
        `    locator ${quoted(binding.identity)}`,
        `    revision ${quoted(authoredRevision)}`,
        `    bundle ${quoted(`${EVIDENCE_DIRECTORY}/${authoredRevision}.ia`)}`,
        `    digest ${quoted(record.digest)}`,
        '    availability available',
        ...(unique ? [`    subject @check ${binding.name}`] : []),
        `    subject-revision ${quoted(record.digest)}`,
        `    snapshot-revision ${quoted(authoredRevision)}`,
        `    evaluator ${quoted(`${binding.implementation ?? 'none'} ${binding.runner ?? ''}`)}`,
        '    move Verification',
        `    verdict ${verdict}`,
        '  interpretation',
        `    applies ${quoted(`The admitted records of authored revision ${short(authoredRevision)} that check.scope ${binding.scope ?? ''} selects.`)}`,
        `    limits ${quoted('The verdicts of a built-in evaluator in admission at one authored revision; no external evaluator ran and nothing was executed.')}`,
        `    reason ${quoted(binding.reason)}`,
        '    basis evaluation',
        '  retention',
        '    status retained',
      ].join('\n'),
    );
  }
  return Object.freeze({
    text: blocks.length === 0 ? null : `#! ia 1.0\n\n${blocks.join('\n\n')}\n`,
    observations: Object.freeze(observations),
  });
}

/**
 * Review findings B4-RC1 and B4-RC2: whether `text` is exactly the evidence file `evidenceText` writes for `bindings`
 * over `records` at `authoredRevision`, its times taken from `text` itself: every observation the writer would make
 * and nothing else, with the writer's verdicts, reasons and wording, byte for byte. A reader admits only such a file,
 * and the writer keeps prior times only from one, so a planted or edited file can neither be read as evidence nor lend
 * the writer its times.
 */
export function reproducesEvidence(input: {
  readonly authoredRevision: string;
  readonly bindings: readonly CheckBinding[];
  readonly records: readonly Node[];
  readonly text: string;
}): boolean {
  const { text } = input;
  return evidenceText({ ...input, prior: text, now: new Date(0) }).text === text;
}

/**
 * The directories evidence lives in, contained the D01 way from the root: a link or junction refuses as
 * IA-DB-PATH-UNSAFE (safePath), as does an entry at `.ia`, `.ia/work` or the evidence directory that is not a directory.
 */
function directories(root: string): void {
  for (const path of ['.ia', '.ia/work', EVIDENCE_DIRECTORY]) {
    const stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (!stat.isDirectory()) throw new DbError('IA-DB-PATH-UNSAFE', `${path} is not a directory`, path);
  }
}
/** Whether `error` is D01's refusal of a link, junction or entry of the wrong kind. */
const unsafe = (error: unknown): boolean => error instanceof DbError && error.code === 'IA-DB-PATH-UNSAFE';
/** Whether the evidence directories are plain directories as far as they exist (`directories` without refusing). */
function plain(root: string): boolean {
  try {
    directories(root);
    return true;
  } catch (error) {
    if (unsafe(error)) return false;
    throw error;
  }
}
/**
 * The bytes of the evidence file at `path`, or null when there is none, including when a link, junction, hard link or
 * entry of the wrong kind stands on the way (review finding B3-N9): nothing is read through one, and the writer refuses
 * only where it must write.
 */
export function readEvidence(root: string, path: string): string | null {
  if (!plain(root)) return null;
  try {
    const target = entryAt(root, path);
    if (target === undefined) return null;
    // Open before judging the link count, so the check and the read are of one file (CodeQL js/file-system-race), and
    // read nothing whose name moved to another file meanwhile.
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) return null;
      const text = readFileSync(fd, 'utf8'),
        named = lstatSync(target, { bigint: true, throwIfNoEntry: false });
      return named?.isFile() && named.nlink === 1n && named.dev === opened.dev && named.ino === opened.ino
        ? text
        : null;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (unsafe(error)) return null;
    throw error;
  }
}
/** The errors a win32 replacing rename returns while another handle holds the target (review finding D2-N3). */
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** How long the writer waits for a held target, in all; a reader holds the file for the moment one read takes. */
const HELD_MS = 2000;
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
/**
 * Review finding D2-N3: rename the staged `temporary` over `path`, true once it is in place. On win32 a replacing rename
 * fails (EPERM, EACCES or EBUSY) while any other handle holds the target, as a concurrent validate does while it reads the
 * evidence it found, or while a concurrent writer's rename is in flight; there the writer retries, backing off from 10 to
 * 100 milliseconds, for up to two seconds. Between attempts it reads the target, and stops early only when it already
 * holds exactly these bytes, byte for byte: then a concurrent writer of the same revision put them there and there is
 * nothing left to write, so the answer is false and the caller discards its copy. That is rare: writers that each
 * record an observation for the first time stamp their own times, so their bytes differ, and the retry then runs until
 * its own rename lands, the last rename leaving one whole file. Any other platform, any other error, or a target still
 * held at the end is the error itself.
 */
function publish(root: string, temporary: string, path: string, bytes: Buffer): boolean {
  const deadline = Date.now() + HELD_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(safePath(root, temporary), safePath(root, path));
      return true;
    } catch (error) {
      if (process.platform !== 'win32' || !HELD.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const current = readEvidence(root, path);
      if (current !== null && Buffer.from(current, 'utf8').equals(bytes)) return false;
      if (Date.now() >= deadline) throw error;
      pause(Math.min(10 * 2 ** attempt, 100));
    }
  }
}
/** The errors a prune skips rather than refuse for (review finding B3-R1): a file it may not or cannot remove. */
const SKIPPED = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EROFS']);

/**
 * Write `text` as the evidence of `authoredRevision` (D14), or, for null, keep none for it, and prune the evidence files
 * of other authored revisions. The writer refuses only when this revision's file must be written (review finding B3-R1):
 * a link or junction on the way, or an entry of the wrong kind at a directory's or the file's path, refuses as
 * IA-DB-PATH-UNSAFE, and a file it cannot write fails with the filesystem's code, before anything is pruned. With nothing
 * to record (null, or a file that already holds exactly `text`) it never refuses, whatever stands at those paths (B3-N6).
 * The bytes are staged in the evidence directory, flushed, and renamed into place, so a reader sees the whole old file or
 * the whole new one; on win32, where a rename over a file another handle holds fails, the rename waits for it a bounded
 * time, and stops once a concurrent writer of the same revision has put exactly these bytes there (`publish`). Pruning
 * is best effort and comes last: only regular files named `<64 hex>.ia`, never temporary
 * files or anything else; a file it may not remove is skipped; and with `pruneBefore` a file modified at or after that
 * time, which a validation of a newer revision may have written meanwhile, is kept (B3-N2); a current file left
 * unchanged is touched, so it counts as modified now (B4-RC3).
 */
export function writeEvidence(
  root: string,
  authoredRevision: string,
  text: string | null,
  options: { readonly pruneBefore?: number } = {},
): Omit<EvidenceWrite, 'observations'> {
  if (!HEX.test(authoredRevision)) throw new TypeError('An authored revision is 64 hex digits');
  const name = `${authoredRevision}.ia`,
    path = `${EVIDENCE_DIRECTORY}/${name}`,
    bytes = text === null ? null : Buffer.from(text, 'utf8'),
    current = bytes === null ? null : readEvidence(root, path);
  let written = false;
  if (bytes !== null && (current === null || !Buffer.from(current, 'utf8').equals(bytes))) {
    // Only here may the writer refuse: this revision's file must be written.
    directories(root);
    entryAt(root, path);
    mkdirSync(safePath(root, EVIDENCE_DIRECTORY), { recursive: true });
    directories(root);
    let temporary: string | undefined = staged(root, path, bytes);
    try {
      if (publish(root, temporary, path, bytes)) {
        temporary = undefined;
        syncDirectory(dirname(safePath(root, path)));
        written = true;
      }
    } finally {
      discard(root, temporary);
    }
  } else if (bytes !== null) {
    // Review finding B4-RC3: the file is current again, so a validation of an older revision that began before now, and
    // prunes only what was modified before it began, leaves it. Best effort: an untouchable file is still current.
    try {
      const now = new Date();
      utimesSync(safePath(root, path), now, now);
    } catch {
      // Nothing to record differs; the file stays as it is.
    }
  }
  const pruned = prune(root, bytes === null ? null : name, options.pruneBefore);
  return Object.freeze({
    path: bytes === null ? null : path,
    written: written || (bytes === null && pruned.includes(path)),
    pruned: Object.freeze(pruned),
  });
}
/** Best-effort removal of the evidence files other than `keep` (see `writeEvidence`); the paths removed. */
function prune(root: string, keep: string | null, before: number | undefined): string[] {
  if (!plain(root)) return [];
  const directory = safePath(root, EVIDENCE_DIRECTORY);
  let entries: string[];
  try {
    entries =
      lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true ? readdirSync(directory).sort() : [];
  } catch {
    return [];
  }
  const pruned: string[] = [];
  for (const entry of entries) {
    if (!EVIDENCE_FILE.test(entry) || entry === keep) continue;
    const other = `${EVIDENCE_DIRECTORY}/${entry}`,
      target = safePath(root, other),
      stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isFile() !== true || (before !== undefined && stat.mtimeMs >= before)) continue;
    try {
      unlinkSync(target);
      pruned.push(other);
    } catch (error) {
      if (!SKIPPED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  if (pruned.length > 0) syncDirectory(directory);
  return pruned;
}
