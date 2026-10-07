/**
 * `ia capture [--preview]`: the effect that admits the workspace and keeps its current and previous snapshots
 * (apps/cli/SPEC.md, Workspace commands).
 *
 * The snapshot is the db capture store's (packages/db SPEC D14): the root view's revision and its membership rows,
 * each carrying the per-record source digest, written under `.ia/work/snapshot/` with workspace-relative roots
 * only, so it regenerates per clone. The store moves current to previous only when the revision changes, so a
 * capture without change keeps previous. The effect is reported apart from validation: records changed, unchanged,
 * new and removed against the stored current, and beside it the admission's error, warning and not-evaluated
 * counts. Admission findings (unresolved references, foreign records) are retained, never refused, and carry the
 * exit class (1 on an error); only a root with no @workspace or a floor input that fails to parse is refused,
 * before anything is written.
 */
import { CAPTURE_DIR, captureOf, readCapturedSnapshot, writeCaptured } from '@inventarch/db';
import type { CapturedSnapshot, CapturedStore, SnapshotObservation } from '@inventarch/db';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { openSession } from './session.js';
import type { Session } from './session.js';
import { countsOf } from './validate.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, sectionLabel, truncateDigest, words } from './render.js';

type Finding = ReturnType<Session['admission']>['findings'][number];

/** Where the floor's own records live; a language finding there means the foundation itself did not parse. */
export const FLOOR_ROOT = '.ia/src/floor/';
/**
 * The one finding capture refuses on: an error the language reports in a floor input. Everything else, references
 * that do not resolve included, is retained as a finding of the captured snapshot.
 */
export const blocksCapture = (finding: Finding): boolean =>
  finding.severity === 'error' && finding.code.startsWith('IA-LANG-') && finding.path.startsWith(FLOOR_ROOT);

export interface CaptureEffect {
  readonly records: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly new: number;
  readonly removed: number;
}
export interface CaptureView {
  readonly preview: boolean;
  readonly snapshot: CapturedSnapshot;
  /** The revision kept as previous once this capture is in place (or would be, under --preview). */
  readonly previous: string | null;
  readonly written: boolean;
  readonly rotated: boolean;
  readonly effect: CaptureEffect;
  readonly validation: ReturnType<typeof countsOf>;
  readonly observations: readonly SnapshotObservation[];
}

/** Digest comparison against the stored current: absent from it is new, absent from the capture is removed. */
export function effectOf(next: CapturedSnapshot, current: CapturedSnapshot | undefined): CaptureEffect {
  const before = new Map((current?.membership ?? []).map((row) => [row.identity, row.digest]));
  let changed = 0,
    unchanged = 0,
    fresh = 0;
  for (const row of next.membership) {
    const digest = before.get(row.identity);
    if (digest === undefined) fresh++;
    else if (digest === row.digest) unchanged++;
    else changed++;
    before.delete(row.identity);
  }
  return { records: next.membership.length, changed, unchanged, new: fresh, removed: before.size };
}

function admit(root: string, session: Session): readonly Finding[] {
  const findings = session.admission().findings;
  const floor = findings.find(blocksCapture);
  if (floor !== undefined)
    throw new Refusal(
      'IA-CLI-FLOOR-UNPARSED',
      `A floor input does not parse, so the workspace cannot be admitted: ${floor.message}`,
      3,
      { path: floor.path, line: floor.line },
      'Run "ia validate" for the located findings and fix the floor input; the stored snapshot is kept.',
    );
  if (!session.reader.records().some((node) => node.discriminator === 'workspace'))
    throw new Refusal(
      'IA-CLI-WORKSPACE-UNDECLARED',
      `No @workspace record is admitted at ${root}, so there is nothing to capture`,
      3,
      { path: root },
      'Run "ia init" to see the @workspace record a workspace starts with.',
    );
  return findings;
}

export function collectCapture(root: string, preview: boolean): CaptureView {
  const session = openSession(root);
  let findings: readonly Finding[], snapshot: CapturedSnapshot;
  try {
    findings = admit(root, session);
    snapshot = captureOf(session.reader);
  } finally {
    session.close();
  }
  const stored: CapturedStore = readCapturedSnapshot(root);
  const rotates = stored.current !== undefined && stored.current.revision !== snapshot.revision;
  const write = preview ? { rotated: false, written: false } : writeCaptured(root, CAPTURE_DIR, snapshot);
  return {
    preview,
    snapshot,
    previous: rotates ? stored.current!.revision : (stored.previous?.revision ?? null),
    written: write.written,
    rotated: write.rotated,
    effect: effectOf(snapshot, stored.current),
    validation: countsOf(findings),
    observations: stored.observations,
  };
}

/** The snapshot is kept even when admission found errors; the exit class carries the verdict. */
export const captureExit = (view: CaptureView): 0 | 1 => (view.validation.errors === 0 ? 0 : 1);

export function captureEnvelope(view: CaptureView): unknown {
  return {
    version: 1,
    preview: view.preview,
    store: CAPTURE_DIR,
    revision: view.snapshot.revision,
    previous: view.previous,
    written: view.written,
    rotated: view.rotated,
    ...view.effect,
    validation: view.validation,
    observations: view.observations.map(({ code, path, message }) => ({ code, path, message })),
  };
}

export function renderCapture(view: CaptureView, caps: Capabilities): string {
  const { effect, validation } = view;
  const effectLine = `${effect.records} records: ${effect.changed} changed, ${effect.unchanged} unchanged, ${effect.new} new, ${effect.removed} removed.`;
  const outcome = view.preview
    ? 'Preview: nothing was written.'
    : view.written
      ? `Wrote ${CAPTURE_DIR}/current.json${view.rotated ? ' and moved the earlier snapshot to previous.json' : ''}.`
      : `${CAPTURE_DIR}/current.json already holds this snapshot.`;
  return document(
    [
      headerLine(
        'Capture',
        CAPTURE_DIR,
        [{ text: `revision ${truncateDigest(view.snapshot.revision, caps.ascii)}`, column: 50 }],
        caps,
      ),
      entry([words(effectLine), words(outcome)], { depth: 1, symbol: 'success' }, caps),
      [
        sectionLabel('Previous', caps),
        ...entry(
          [
            view.previous === null
              ? words('none', 'dim')
              : [atom(`revision ${truncateDigest(view.previous, caps.ascii)}`, null, 0)],
          ],
          { depth: 1, symbol: 'info' },
          caps,
        ),
      ],
      entry(
        [
          words(
            `${validation.errors} errors, ${validation.warnings} warnings, ${validation.notEvaluated} not evaluated in admission.`,
          ),
          ...view.observations.map((observation) => words(`${observation.path}: ${observation.message}`)),
        ],
        { depth: 1, symbol: validation.errors === 0 ? 'info' : 'error' },
        caps,
      ),
      entry(
        [
          words(
            validation.errors > 0
              ? 'Run "ia validate" for the located findings, fix them, then capture again.'
              : view.preview
                ? 'Run "ia capture" to keep this snapshot.'
                : 'Capture again after editing records; an unchanged workspace keeps its previous snapshot.',
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
  const root = requireRoot(context);
  const view = collectCapture(root, context.args.flag('preview'));
  const exitCode = captureExit(view);
  return context.json
    ? { exitCode, stdout: JSON.stringify(captureEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderCapture(view, context.caps), stderr: '' };
}
