/**
 * `ia capture`: position-and-projection §5's capture effect, design rows 3 and 20.
 *
 * The one verb that records what the workspace admits. It admits the workspace as every workspace verb does and writes
 * the admitted root snapshot to `.ia/work/snapshot/current.json`, an `ia-snapshot-1` document: the language identity,
 * the revision, the admitted records sorted by identity with their graph G13 per-record digests, their db D02a
 * membership rows, the admission findings and their counts. The distribution's `json()` serializer writes it, as it
 * writes `ia.compiled.v1`, so identical sources on one language version capture to identical bytes.
 *
 * The pair is db D08a's, the one retained pair (`writeCapture`): the db writes and rotates it and compares the records
 * with the prior capture by digest, and every db handle seeds its previous snapshot from it, whatever its cache
 * setting, so `previousRevision`, `staleness` and `readiness` answer against what this verb retained.
 *
 * The effect is reported apart from validation. Its counts compare each record's digest with the prior capture's
 * `current.json`, so a capture with no edit since the last one reports nothing changed. The admission findings are
 * written into the snapshot and counted in the report, and an error makes the exit class 1. Two cases refuse before
 * anything is written, as §5 and §11 have it, so both files stay as they were: a root with no `@workspace` of its own,
 * and a floor or seed input (the floor, an installed or an adopted source) that fails to parse. Every other finding there
 * (unresolved references, colliding identities, unconsented rows, a keyword two systems register) stays a finding, as it
 * does in a source the workspace authors.
 *
 * `--preview` (decision capture-preview-placement) admits and refuses as a capture does, then reports what the capture
 * would write through db D08b's `planCapture` (the counts, the rotation and the changed, new and removed identities)
 * and writes nothing, so the retained previous snapshot that readiness compares against is not spent.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import {
  CAPTURE_CURRENT,
  CAPTURE_DIRECTORY,
  CAPTURE_FORMAT,
  CAPTURE_PREVIOUS,
  planCapture,
  writeCapture,
} from '@inventarch/db';
import type { CapturePlan, CaptureWrite, MembershipRow, Snapshot } from '@inventarch/db';
import { json, LANGUAGE_IDENTITY, sha256 } from '@inventarch/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import type { Capabilities, Token } from './render.js';
import {
  atom,
  commandFacts,
  document,
  entry,
  headerLine,
  quote,
  sectionLabel,
  terminalText,
  truncateDigest,
  words,
} from './render.js';
import { codeOf, openSession } from './session.js';
import type { Session } from './session.js';
import { NOT_EVALUATED } from './validate.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];

export const SNAPSHOT_FORMAT = CAPTURE_FORMAT;
export const SNAPSHOT_DIRECTORY = CAPTURE_DIRECTORY;
export const CURRENT = CAPTURE_CURRENT;
export const PREVIOUS = CAPTURE_PREVIOUS;

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
/** A capture written: the document and its bytes, with db D08a's comparison and rotation (`CaptureWrite`). */
export interface CaptureView extends CaptureWrite {
  readonly root: string;
  readonly snapshot: SnapshotDocument;
  readonly status: Admission['status'];
  /** The exact bytes written to `current.json`, so the file and the reported digest cannot disagree. */
  readonly text: string;
  readonly digest: string;
}
/**
 * A capture previewed: the document a capture would write and db D08b's plan of it (`CapturePlan`), the identities its
 * counts count included. `text` and `digest` are the bytes the capture would write; nothing is written.
 */
export interface CapturePreview extends CaptureView, CapturePlan {
  readonly preview: true;
  /** The capture that writes what this preview reports, with `--root` as given. */
  readonly capture: string;
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
  // The finding set `ia validate` reports (the distribution's one validation service), inert declarations included.
  const admission = session.validation(),
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

/** The admitted snapshot to write, with what decides whether it may be written. */
interface Admitted extends Pick<CaptureView, 'snapshot' | 'status' | 'text' | 'digest'> {
  /** Whether the root's own `.ia/src` holds a `@workspace`, admitted or refused. */
  readonly declared: boolean;
}
/** Sources the workspace does not author: the floor, an installed package's and an adopted mount's. */
const SEEDED: readonly string[] = ['.ia/src/floor/', '.ia/distributions/', '.ia/adopted/'];
/**
 * The language's syntax diagnostics: the codes its scanner and parser emit, which language SPEC S03 calls parser-owned.
 * A source with one fails to parse. Every other language code is a registration, compilation or resolution result
 * over sources that parsed (a keyword two systems register, a schema or system a registration lacks, an unresolved or
 * unconsented row, a colliding identity), which position-and-projection §5 keeps as a finding, never a refusal.
 * tests/capture.test.ts holds this set to the codes packages/language/src/scanner and parser spell.
 */
export const SYNTAX_CODES: ReadonlySet<string> = new Set([
  'IA-LANG-PRAGMA-MISSING',
  'IA-LANG-VERSION-UNSUPPORTED',
  'IA-LANG-INDENT-TAB',
  'IA-LANG-INDENT-STEP',
  'IA-LANG-STRING-UNTERMINATED',
  'IA-LANG-PROSE-TRAILING',
  'IA-LANG-PROSE-UNTERMINATED',
  'IA-LANG-LIST-UNTERMINATED',
  'IA-LANG-LIST-MALFORMED',
  'IA-LANG-HEADER-MALFORMED',
  'IA-LANG-HEAD-FIELD-AFTER-SECTION',
  'IA-LANG-TOPLEVEL-UNEXPECTED',
  'IA-LANG-VALUE-TRAILING',
  'IA-LANG-REF-MALFORMED',
  'IA-LANG-FIELD-KEY-MISSING',
]);
/** §5: the first error by which a floor or seed input fails to parse, or undefined when every one parsed. */
export const unparsedSeed = (diagnostics: readonly Finding[]): Finding | undefined =>
  diagnostics.find(
    (finding) =>
      finding.severity === 'error' &&
      SYNTAX_CODES.has(finding.code) &&
      SEEDED.some((prefix) => finding.path.startsWith(prefix)),
  );
/** Admits the workspace at `root` and builds its snapshot; the session is closed before anything is written. */
function admit(root: string): Admitted {
  const session = openSession(root);
  try {
    const own = (path: string): boolean => path.startsWith('.ia/src/') && !path.startsWith('.ia/src/floor/');
    const declared =
      session.reader.records().some((record) => record.discriminator === 'workspace' && own(record.source.path)) ||
      session.reader.refused.some((record) => record.identity.split('/')[2] === 'workspace' && own(record.path));
    return { ...buildSnapshot(session), declared };
  } finally {
    session.close();
  }
}
/**
 * Position-and-projection §5 and §11: the two cases a capture refuses, before anything is written, so the previous
 * snapshot is kept. A floor or seed input that fails to parse would drop its records from the snapshot, so it refuses
 * first and names `ia validate`; a root whose own `.ia/src` holds no `@workspace` is not a workspace to capture and
 * names `ia init`, unless its own sources have errors, which may be why none is read. Any other finding in a floor or
 * seed input is written into the snapshot, as one in a source the workspace authors is.
 */
function captureRefusal(root: string, given: string | undefined, admitted: Admitted): Refusal | null {
  const validate = `ia validate${given === undefined ? '' : ` --root ${quote(given)}`}`;
  const failed = unparsedSeed(admitted.snapshot.diagnostics);
  if (failed !== undefined)
    return new Refusal(
      failed.code,
      `${failed.path} is a floor or seed input that fails to parse, so nothing was captured and the previous snapshot is kept: ${failed.message}`,
      3,
      { path: failed.path, line: failed.line },
      `Run "${validate}" for the located findings, repair the input, then capture again.`,
    );
  if (admitted.declared) return null;
  const errors = admitted.snapshot.diagnostics.some(
    (finding) => finding.severity === 'error' && finding.path.startsWith('.ia/src/'),
  );
  return new Refusal(
    'IA-DB-ROOT-INVALID',
    `No @workspace record is declared in ${resolve(root, '.ia/src')}, so ${root} is not a workspace to capture; nothing was written`,
    3,
    { path: root },
    errors
      ? `Run "${validate}" for the findings that may keep its @workspace from being read.`
      : existsSync(resolve(root, '.ia/release.json'))
        ? `Restore the authored @workspace source under .ia/src from source control, then run "ia position --root ${quote(root)}" to inspect this initialized workspace.`
        : `Run "ia init ${quote(root)}" to see what a new workspace there would contain.`,
  );
}
/** Admits the workspace at `root` and builds the snapshot to write, unless one of §5's two refusals answers first. */
function capturable(root: string, given: string | undefined): Omit<Admitted, 'declared'> {
  const admitted = admit(root);
  const refused = captureRefusal(root, given, admitted);
  if (refused !== null) throw refused;
  const { declared: _declared, ...built } = admitted;
  return built;
}
/**
 * Admits the workspace at `root` and writes its snapshot pair through db D08a, unless one of §5's two refusals answers
 * first. `given` is the `--root` the invocation typed, which the `ia validate` a refusal names carries.
 */
export function collectCapture(root: string, given?: string): CaptureView {
  const built = capturable(root, given);
  return { root, ...built, ...writeCapture(root, built.text) };
}
/**
 * `ia capture --preview`: admits and refuses exactly as `collectCapture` does, then plans the write through db D08b's
 * `planCapture` instead of making it, so nothing is created or written and the pair stays as it was.
 */
export function previewCapture(root: string, given?: string): CapturePreview {
  const built = capturable(root, given);
  return {
    root,
    ...built,
    ...planCapture(root, built.text),
    preview: true,
    capture: `ia capture${given === undefined ? '' : ` --root ${quote(given)}`}`,
  };
}

/** As `ia compile` does: the snapshot is written even when admission has errors; the exit class carries the verdict. */
export const captureExit = (view: CaptureView): 0 | 1 => (view.snapshot.counts.errors === 0 ? 0 : 1);

/** A preview adds `preview: true` and the identities its counts count; a capture's keys are the 1.x ones. */
export function captureEnvelope(view: CaptureView | CapturePreview): unknown {
  const { counts, revision } = view.snapshot;
  return {
    version: 1,
    ...('preview' in view ? { preview: true } : {}),
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
    ...('preview' in view
      ? {
          identities: {
            changed: view.identities.changed,
            new: view.identities.added,
            removed: view.identities.removed,
          },
        }
      : {}),
    admission: {
      status: view.status,
      errors: counts.errors,
      warnings: counts.warnings,
      notEvaluated: counts.notEvaluated,
    },
  };
}

/**
 * A capture's report, or a preview's: the same counts and snapshot rows. A preview says it wrote nothing, states the
 * rotation as the one the capture would make, and names every changed, new and removed identity, each list sorted.
 */
export function renderCapture(view: CaptureView | CapturePreview, caps: Capabilities): string {
  const { counts, revision } = view.snapshot;
  const preview = 'preview' in view ? view : null;
  const digest = (value: string): string => truncateDigest(value, caps.ascii);
  const effect: (readonly Token[])[] = [
    words(`${preview === null ? 'Captured' : 'Would capture'} ${counts.records} records.`),
    words(
      view.prior === null
        ? `No prior capture to compare with${view.ignored === null ? '' : ` (the existing current.json ${view.ignored})`}, so every record is new.`
        : `Since the capture at revision ${digest(view.prior)}: ${view.changed} changed, ${view.unchanged} unchanged, ${view.added} new, ${view.removed} removed.`,
    ),
  ];
  const previous: (readonly Token[])[] =
    view.previous === null
      ? [words(`No earlier capture at another revision ${preview === null ? 'is' : 'would be'} retained.`, 'dim')]
      : [
          [atom(PREVIOUS, 'cyan', 0)],
          words(
            preview === null
              ? `revision ${digest(view.previous)}, ${view.rotated ? 'moved from current.json because the revision changed' : 'kept because the revision did not change'}`
              : `revision ${digest(view.previous)}, ${view.rotated ? 'would move from current.json because the revision changed' : 'would be kept because the revision did not change'}`,
            'dim',
          ),
        ];
  const admission: (readonly Token[])[] = [
    words(`${counts.errors} errors, ${counts.warnings} warnings, ${counts.notEvaluated} not evaluated.`),
  ];
  if (counts.notEvaluated > 0)
    admission.push(
      words(
        `${counts.notEvaluated} checks had no evaluator, so the snapshot ${preview === null ? 'records' : 'would record'} a not-evaluated result rather than a pass.`,
      ),
    );
  // A preview names every identity its counts count, which the counts already bound. A removed one is read from the
  // current.json on disk, which only its shape is checked against, so each is escaped as source-derived text is.
  const identities: (readonly string[])[] =
    preview === null
      ? []
      : (
          [
            ['Changed', 'updated', preview.identities.changed],
            ['New', 'added', preview.identities.added],
            ['Removed', 'removed', preview.identities.removed],
          ] as const
        ).map(([label, symbol, named]) =>
          named.length === 0
            ? []
            : [
                sectionLabel(label, caps),
                ...named.flatMap((identity) =>
                  entry([[atom(terminalText(identity), null, 0)]], { depth: 1, symbol }, caps),
                ),
              ],
        );
  const footer: readonly (readonly Token[])[] =
    preview === null
      ? [
          words(
            counts.errors > 0
              ? 'The snapshot records these findings. Run "ia validate" for their locations, fix them, then capture again.'
              : 'Identical sources on one language version capture identically, so a capture after no edit reports 0 changed.',
          ),
        ]
      : counts.errors > 0
        ? [
            words(
              'The snapshot would record these findings. Run "ia validate" for their locations, fix them, then capture.',
            ),
          ]
        : commandFacts('Write this snapshot with "', preview.capture, '".', 3, caps);
  return document(
    [
      preview === null
        ? headerLine('Capture', SNAPSHOT_FORMAT, [{ text: `revision ${digest(revision)}`, column: 50 }], caps)
        : headerLine(
            'Plan',
            `capture ${SNAPSHOT_FORMAT}`,
            [{ text: `revision ${digest(revision)}`, column: 50 }],
            caps,
          ),
      ...(preview === null ? [] : [entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps)]),
      // The write succeeded either way; an admission error marks what it holds. A preview wrote nothing to mark.
      entry(
        effect,
        { depth: 1, symbol: preview !== null ? 'info' : counts.errors === 0 ? 'success' : 'warning' },
        caps,
      ),
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
      ...identities,
      [
        sectionLabel('Admission', caps),
        ...entry(admission, { depth: 1, symbol: counts.errors === 0 ? 'success' : 'error' }, caps),
      ],
      entry(footer, { depth: 0, symbol: 'step' }, caps),
    ],
    { leadingBlank: true },
  );
}

/** What a failed snapshot write names to repair: a file the system would not let it replace, or a directory. */
export interface WriteRepair {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}
const property = (error: unknown, key: string): string | undefined => {
  const value = error !== null && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};
/**
 * The system errors a write repair answers: permission, a busy or read-only entry, and an entry of the wrong kind. Any
 * other (a full disk, an I/O error, too many open files) is not the path's to fix, so it takes the generic next.
 */
export const WRITE_REPAIRABLE: ReadonlySet<string> = new Set([
  'EACCES',
  'EPERM',
  'EBUSY',
  'EROFS',
  'ENOTDIR',
  'EEXIST',
]);
/**
 * The repair a write failure names. Creating an entry (staging the new bytes, creating the snapshot directory) needs the
 * directory it is created in to be writable, and on POSIX so do renaming and removing one, whatever the file's own mode,
 * so those name that directory. On Windows a rename onto, or a removal of, a read-only or open file fails on the file,
 * so that one names the file, without a staged file's temporary suffix. A path outside the root names the snapshot
 * directory.
 */
export function writeRepair(root: string, error: unknown, platform: NodeJS.Platform = process.platform): WriteRepair {
  const path = property(error, 'path');
  const local = path === undefined ? '' : relative(root, path).replaceAll('\\', '/');
  if (local === '' || local.startsWith('..') || isAbsolute(local))
    return { path: SNAPSHOT_DIRECTORY, kind: 'directory' };
  const syscall = property(error, 'syscall'),
    code = property(error, 'code');
  if (syscall === 'open' || syscall === 'mkdir' || code === 'EEXIST' || code === 'ENOTDIR' || platform !== 'win32')
    return { path: posix.dirname(local), kind: 'directory' };
  return { path: local.replace(/\.[0-9a-f-]{36}\.tmp$/, ''), kind: 'file' };
}

/**
 * A capture's failure as this verb refuses it, each repair followed by `rerun`. A refusal from opening the workspace, or
 * one of the capture's own, already names its own repair and is returned as it is. A snapshot path the db does not
 * write through is located and named, and so is a file or directory the system would not let a capture write, which a
 * preview (`writes` false) never writes. Any other failure is returned as it is. `ia init`'s capture effect refuses
 * through this too, so it locates and repairs what `ia capture` would.
 */
export function captureFailure(error: unknown, root: string, rerun: string, writes = true): unknown {
  if (error instanceof Refusal) return error;
  const code = codeOf(error, '');
  if (code === 'IA-DB-PATH-UNSAFE')
    return new Refusal(
      code,
      error instanceof Error ? error.message : String(error),
      3,
      { path: property(error, 'path') ?? SNAPSHOT_DIRECTORY },
      `Replace or remove the path named above, so ${SNAPSHOT_DIRECTORY} is a plain directory holding plain files, then run "${rerun}".`,
    );
  if (!writes || !WRITE_REPAIRABLE.has(code)) return error;
  const repair = writeRepair(root, error);
  return new Refusal(
    'IA-CLI-FAILED',
    error instanceof Error ? error.message : String(error),
    3,
    { path: repair.path },
    repair.kind === 'file'
      ? `Make ${repair.path} writable, or close what holds it open, then run "${rerun}"; the snapshot pair is as it was.`
      : `Make the directory ${repair.path} writable, then run "${rerun}"; the snapshot pair is as it was.`,
  );
}

export function runCapture(context: Context): Result {
  const { caps, json: machine } = context;
  const root = requireRoot(context),
    preview = context.args.flag('preview');
  let view: CaptureView | CapturePreview;
  try {
    view = (preview ? previewCapture : collectCapture)(root, context.args.value('root'));
  } catch (error) {
    throw captureFailure(error, root, respell(context), !preview);
  }
  const exitCode = captureExit(view);
  return machine
    ? { exitCode, stdout: JSON.stringify(captureEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderCapture(view, caps), stderr: '' };
}
