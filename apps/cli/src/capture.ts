/**
 * `ia capture`: position-and-projection §5's capture effect, design rows 3 and 20.
 *
 * The one verb that records what the workspace admits. It admits the workspace as every workspace verb does and writes
 * the admitted root snapshot to `.ia/work/snapshot/current.json`, an `ia-snapshot-1` document: the language identity,
 * the revision, the admitted records sorted by identity with their graph G13 per-record digests, their db D02a
 * membership rows, the admission findings and their counts. The distribution's `json()` serializer writes it, as it
 * wrote `ia.compiled.v1`, so identical sources on one language version capture to identical bytes.
 *
 * `.ia/work/snapshot/previous.json` is db D08's previous snapshot kept as a file: the most recent capture whose
 * revision differs from the current one. A capture at a new revision moves the prior `current.json` there byte for
 * byte, one at an unchanged revision keeps it as it is, and with no prior capture none is retained. Each file is
 * replaced through a temporary file and a rename, previous first, so a capture interrupted between the two leaves the
 * prior `current.json` in place and the next capture rotates it again; as D08 publishes its own files, a
 * `current.json` that already holds the capture's bytes is not rewritten.
 *
 * The effect is reported apart from validation. Its counts compare each record's digest with the prior capture's
 * `current.json`, so a capture with no edit since the last one reports nothing changed. The admission findings are
 * written into the snapshot and counted in the report; as `ia compile` treated them, they never stop the write, and
 * an error makes the exit class 1.
 */
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MembershipRow, Snapshot } from '@inventarch/db';
import { json, LANGUAGE_IDENTITY, readWorkspaceFile, replace, sha256 } from '@inventarch/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import type { Capabilities, Token } from './render.js';
import { atom, document, entry, headerLine, sectionLabel, truncateDigest, words } from './render.js';
import { codeOf, openSession } from './session.js';
import type { Session } from './session.js';
import { NOT_EVALUATED } from './validate.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];

export const SNAPSHOT_FORMAT = 'ia-snapshot-1';
export const SNAPSHOT_DIRECTORY = '.ia/work/snapshot';
export const CURRENT = `${SNAPSHOT_DIRECTORY}/current.json`;
export const PREVIOUS = `${SNAPSHOT_DIRECTORY}/previous.json`;

export interface SnapshotCounts {
  readonly records: number;
  readonly errors: number;
  readonly warnings: number;
  readonly notEvaluated: number;
}
/** The `ia-snapshot-1` document a capture writes to `current.json`. */
export interface SnapshotDocument {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly language: string;
  readonly kernelDigest: string;
  readonly revision: string;
  readonly records: Snapshot['records'];
  readonly membership: readonly MembershipRow[];
  readonly diagnostics: readonly Finding[];
  readonly counts: SnapshotCounts;
}
export interface CaptureView {
  readonly root: string;
  readonly snapshot: SnapshotDocument;
  readonly status: Admission['status'];
  /** The exact bytes written to `current.json`, so the file and the reported digest cannot disagree. */
  readonly text: string;
  readonly digest: string;
  /** The revision of the prior capture the counts compare against; null when there was none. */
  readonly prior: string | null;
  /** Why an existing `current.json` was not taken as the prior capture; null when it was, or when there was none. */
  readonly ignored: string | null;
  /** The revision `previous.json` holds after this capture; null when no previous capture is retained. */
  readonly previous: string | null;
  /** Whether this capture moved the prior `current.json` to `previous.json`. */
  readonly rotated: boolean;
  readonly changed: number;
  readonly unchanged: number;
  readonly added: number;
  readonly removed: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The ordering the compliance layer already applies, reused rather than reinvented. */
export const orderFindings = (findings: readonly Finding[]): readonly Finding[] =>
  [...findings].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
  );
export const findingCounts = (records: number, findings: readonly Finding[]): SnapshotCounts => ({
  records,
  errors: findings.filter((finding) => finding.severity === 'error').length,
  warnings: findings.filter((finding) => finding.severity === 'warning').length,
  notEvaluated: findings.filter((finding) => NOT_EVALUATED.has(finding.code)).length,
});

/** The admitted root snapshot as `ia-snapshot-1`: records and membership rows sorted by identity, findings ordered. */
export function buildSnapshot(session: Session): Pick<CaptureView, 'snapshot' | 'status' | 'text' | 'digest'> {
  const admission = session.admission(),
    admitted = session.reader.snapshot();
  const records = [...admitted.records].sort((a, b) => compare(a.identity, b.identity));
  const membership = [...admitted.membership].sort((a, b) => compare(a.identity, b.identity));
  const diagnostics = orderFindings(admission.findings);
  const snapshot: SnapshotDocument = {
    format: SNAPSHOT_FORMAT,
    language: LANGUAGE_IDENTITY.language,
    kernelDigest: LANGUAGE_IDENTITY.kernelDigest,
    revision: admitted.revision,
    records,
    membership,
    diagnostics,
    counts: findingCounts(records.length, diagnostics),
  };
  const text = json(snapshot);
  return { snapshot, status: admission.status, text, digest: sha256(text) };
}

/** A capture as the next one compares and rotates it: its exact bytes, its revision and its per-record digests. */
interface Captured {
  readonly bytes: Buffer;
  readonly revision: string;
  readonly digests: ReadonlyMap<string, string>;
}
const HEX = /^[0-9a-f]{64}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * The capture at `path`; null when nothing is there, or why the file there is no `ia-snapshot-1` capture. A link
 * on the path, or an entry there that is not a regular file, refuses as IA-DIST-PATH-UNSAFE from the distribution's
 * reader before anything is written, as a write through a link would. The file is the capture's own output, so it is read unbounded, as db D08 reads its pair.
 */
function readCaptured(root: string, path: string): Captured | string | null {
  if (lstatSync(resolve(root, path), { throwIfNoEntry: false }) === undefined) return null;
  const bytes = readWorkspaceFile({ root, path, limit: Number.POSITIVE_INFINITY });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'is not JSON';
  }
  if (!plain(value) || value['format'] !== SNAPSHOT_FORMAT) return `is not an ${SNAPSHOT_FORMAT} document`;
  const revision = value['revision'],
    rows = value['membership'];
  if (typeof revision !== 'string' || !HEX.test(revision) || !Array.isArray(rows))
    return 'has no revision or membership rows';
  const digests = new Map<string, string>();
  for (const row of rows as unknown[]) {
    if (
      !plain(row) ||
      typeof row['identity'] !== 'string' ||
      digests.has(row['identity']) ||
      typeof row['digest'] !== 'string' ||
      !HEX.test(row['digest'])
    )
      return 'has a malformed membership row';
    digests.set(row['identity'], row['digest']);
  }
  return { bytes, revision, digests };
}

/**
 * The write and its report. Counts follow db D08's staleness by digest against the prior capture's `current.json`: a
 * row with an equal digest is unchanged, a different one changed, one the prior lacks new, and a prior row with none
 * now removed. Rotation is D08's too, with the files as the retained pair: previous first, then current.
 */
function commit(root: string, built: ReturnType<typeof buildSnapshot>): CaptureView {
  const read = readCaptured(root, CURRENT),
    prior = read !== null && typeof read === 'object' ? read : null,
    { revision, membership } = built.snapshot;
  let changed = 0,
    unchanged = 0,
    added = 0;
  for (const row of membership) {
    const before = prior?.digests.get(row.identity);
    if (before === undefined) added += 1;
    else if (before === row.digest) unchanged += 1;
    else changed += 1;
  }
  const current = new Set(membership.map((row) => row.identity));
  const removed = prior === null ? 0 : [...prior.digests.keys()].filter((identity) => !current.has(identity)).length;
  let previous: string | null = null;
  const rotated = prior !== null && prior.revision !== revision;
  if (rotated) {
    replace(root, PREVIOUS, prior.bytes);
    previous = prior.revision;
  } else {
    // An unchanged revision keeps previous.json while it holds a capture at another revision. With no prior capture,
    // or a previous.json that holds no such capture, no previous capture is retained.
    const kept = prior === null ? null : readCaptured(root, PREVIOUS);
    if (kept !== null && typeof kept === 'object' && kept.revision !== revision) previous = kept.revision;
    else replace(root, PREVIOUS, null);
  }
  const text = Buffer.from(built.text, 'utf8');
  if (prior === null || !prior.bytes.equals(text)) replace(root, CURRENT, text);
  return {
    root,
    ...built,
    prior: prior?.revision ?? null,
    ignored: typeof read === 'string' ? read : null,
    previous,
    rotated,
    changed,
    unchanged,
    added,
    removed,
  };
}

/** Admits the workspace at `root` and writes its snapshot pair; the session is closed before anything is written. */
export function collectCapture(root: string): CaptureView {
  const session = openSession(root);
  let built: ReturnType<typeof buildSnapshot>;
  try {
    built = buildSnapshot(session);
  } finally {
    session.close();
  }
  return commit(root, built);
}

/** As `ia compile` did: the snapshot is written even when admission has errors; the exit class carries the verdict. */
export const captureExit = (view: CaptureView): 0 | 1 => (view.snapshot.counts.errors === 0 ? 0 : 1);

export function captureEnvelope(view: CaptureView): unknown {
  const { counts, revision } = view.snapshot;
  return {
    version: 1,
    snapshot: resolve(view.root, CURRENT),
    format: SNAPSHOT_FORMAT,
    revision,
    digest: view.digest,
    records: counts.records,
    changed: view.changed,
    unchanged: view.unchanged,
    new: view.added,
    removed: view.removed,
    prior: view.prior,
    ignored: view.ignored,
    previous: view.previous === null ? null : { path: resolve(view.root, PREVIOUS), revision: view.previous },
    rotated: view.rotated,
    admission: {
      status: view.status,
      errors: counts.errors,
      warnings: counts.warnings,
      notEvaluated: counts.notEvaluated,
    },
  };
}

export function renderCapture(view: CaptureView, caps: Capabilities): string {
  const { counts, revision } = view.snapshot;
  const digest = (value: string): string => truncateDigest(value, caps.ascii);
  const effect: (readonly Token[])[] = [
    words(`Captured ${counts.records} records.`),
    words(
      view.prior === null
        ? `No prior capture to compare with${view.ignored === null ? '' : ` (the existing current.json ${view.ignored})`}, so every record is new.`
        : `Since the capture at revision ${digest(view.prior)}: ${view.changed} changed, ${view.unchanged} unchanged, ${view.added} new, ${view.removed} removed.`,
    ),
  ];
  const previous: (readonly Token[])[] =
    view.previous === null
      ? [words('No earlier capture at another revision is retained.', 'dim')]
      : [
          [atom(PREVIOUS, 'cyan', 0)],
          words(
            `revision ${digest(view.previous)}, ${view.rotated ? 'moved from current.json because the revision changed' : 'kept because the revision did not change'}`,
            'dim',
          ),
        ];
  const admission: (readonly Token[])[] = [
    words(`${counts.errors} errors, ${counts.warnings} warnings, ${counts.notEvaluated} not evaluated.`),
  ];
  if (counts.notEvaluated > 0)
    admission.push(
      words(
        `${counts.notEvaluated} checks had no evaluator, so the snapshot records a not-evaluated result rather than a pass.`,
      ),
    );
  return document(
    [
      headerLine('Capture', SNAPSHOT_FORMAT, [{ text: `revision ${digest(revision)}`, column: 50 }], caps),
      entry(effect, { depth: 1, symbol: 'success' }, caps),
      [
        sectionLabel('Snapshot', caps),
        ...entry(
          [
            [atom(CURRENT, 'cyan', 0)],
            [
              atom(`sha256 ${digest(view.digest)}`, null, 0),
              ...words(`${Buffer.byteLength(view.text)} bytes`, 'dim', 2),
            ],
          ],
          { depth: 1, symbol: 'info' },
          caps,
        ),
        ...entry(previous, { depth: 1, symbol: 'info' }, caps),
      ],
      [
        sectionLabel('Admission', caps),
        ...entry(admission, { depth: 1, symbol: counts.errors === 0 ? 'success' : 'error' }, caps),
      ],
      entry(
        [
          words(
            counts.errors > 0
              ? 'The snapshot records these findings. Run "ia validate" for their locations, fix them, then capture again.'
              : 'Identical sources on one language version capture identically, so a capture after no edit reports 0 changed.',
          ),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}

export function runCapture(context: Context): Result {
  const { caps, json: machine } = context;
  const root = requireRoot(context);
  let view: CaptureView;
  try {
    view = collectCapture(root);
  } catch (error) {
    // A refusal from opening the workspace already names its own repair; a snapshot path the writer does not admit
    // is this verb's to name.
    if (error instanceof Refusal || codeOf(error, '') !== 'IA-DIST-PATH-UNSAFE') throw error;
    throw new Refusal(
      'IA-DIST-PATH-UNSAFE',
      error instanceof Error ? error.message : String(error),
      3,
      { path: SNAPSHOT_DIRECTORY },
      `Replace or remove the path named above, so ${SNAPSHOT_DIRECTORY} holds plain files, then run "${respell(context)}".`,
    );
  }
  const exitCode = captureExit(view);
  return machine
    ? { exitCode, stdout: JSON.stringify(captureEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderCapture(view, caps), stderr: '' };
}
