/**
 * Legacy programmatic helpers retained at `@inventarch/cli/internal/compile`.
 * The `ia compile` command was removed in 3.0. `runCompile` remains a deprecated capture adapter
 * for existing imports; it is no longer registered as a CLI command. Its legacy options and exported
 * signatures remain available to programmatic callers.
 *
 * The `ia.compiled.v1` writer below stays exported, so `@inventarch/cli/internal/compile` keeps its
 * published signatures, but no command writes the artifact any more. One deterministic document, `ia.compiled.v1`. Determinism is a requirement on this writer, not a hope: records
 * are sorted by canonical identity, diagnostics by (path, line, code, message), object keys are emitted sorted and
 * the document ends in exactly one newline — which is what the distribution's own `json()` serializer does, so it
 * is the function called rather than a second encoder beside it.
 *
 * No product-quality claim. Compilation establishes that records parse, that references resolve and that declared
 * structural obligations are satisfied. Where a semantic evaluator is unavailable the compiler carries
 * IA-COMP-NOT-EVALUATED through into `diagnostics` and `counts.notEvaluated`; that result is never rolled into a
 * pass, never suppressed and never omitted from --json.
 */
import { CAPTURE_CURRENT, identityOf } from '@inventarch/db';
import { WRITE_PLAIN_NAMES } from './written-names.js';
import { json, LANGUAGE_IDENTITY, sha256 } from '@inventarch/distribution/services';
import { findingCounts, orderFindings, runCapture } from './capture.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { Refusal } from './consumer.js';
import { openSession } from './session.js';
import type { Session } from './session.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, quote, sectionLabel, truncateDigest, words } from './render.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];

export const DEFAULT_OUT = '.ia/work/compiled.json';
export const ARTIFACT = 'ia.compiled.v1';

export interface CompileCounts {
  readonly records: number;
  readonly errors: number;
  readonly warnings: number;
  readonly notEvaluated: number;
}
export interface CompiledArtifact {
  /** `compiled` once the switch flips (decision dec-008); the released artifact carries `formatVersion` alone. */
  readonly format?: 'compiled';
  readonly formatVersion: 1;
  readonly artifact: typeof ARTIFACT;
  readonly language: string;
  readonly kernelDigest: string;
  readonly root: string;
  readonly revision: string;
  readonly records: readonly unknown[];
  readonly diagnostics: readonly Finding[];
  readonly counts: CompileCounts;
}
export interface CompileView {
  readonly artifact: CompiledArtifact;
  /** The exact bytes the artifact serializes to, so the file and the reported digest cannot disagree. */
  readonly text: string;
  readonly digest: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildArtifact(root: string, session: Session): CompileView {
  const admission = session.admission();
  // ia.compiled.v1 records predate graph G13, so the artifact and its digest omit the per-record digest.
  const records = [...session.reader.records()]
    .sort((a, b) => compare(a.identity, b.identity))
    .map(({ digest: _digest, ...record }) => record);
  const diagnostics = orderFindings(admission.findings);
  const artifact: CompiledArtifact = {
    ...identityOf(WRITE_PLAIN_NAMES, 'compiled', 1, { formatVersion: 1 } as const),
    artifact: ARTIFACT,
    language: LANGUAGE_IDENTITY.language,
    kernelDigest: LANGUAGE_IDENTITY.kernelDigest,
    root,
    revision: admission.revision,
    records,
    diagnostics,
    counts: findingCounts(records.length, diagnostics),
  };
  const text = json(artifact);
  return { artifact, text, digest: sha256(text) };
}

export function collectCompile(root: string): CompileView {
  const session = openSession(root);
  try {
    return buildArtifact(root, session);
  } finally {
    session.close();
  }
}

/** The artifact is built even when the compilation produced errors; the exit class carries the verdict. */
export const compileExit = (view: CompileView): 0 | 1 => (view.artifact.counts.errors === 0 ? 0 : 1);

export function compileEnvelope(view: CompileView, path: string): unknown {
  return {
    version: 1,
    artifact: path,
    revision: view.artifact.revision,
    digest: view.digest,
    counts: view.artifact.counts,
  };
}

export function renderCompile(view: CompileView, path: string, caps: Capabilities): string {
  const counts = view.artifact.counts;
  const facts = [
    words(
      `${counts.records} records, ${counts.errors} errors, ${counts.warnings} warnings, ${counts.notEvaluated} not evaluated.`,
    ),
  ];
  if (counts.notEvaluated > 0)
    facts.push(
      words(
        `${counts.notEvaluated} checks had no evaluator, so this artifact records a not-evaluated result rather than a pass.`,
      ),
    );
  facts.push(
    words(
      'Compilation establishes that records parse, that references resolve and that declared structural obligations are satisfied. It is not a claim that a design is good.',
    ),
  );
  return document(
    [
      headerLine(
        'Compile',
        ARTIFACT,
        [{ text: `revision ${truncateDigest(view.artifact.revision, caps.ascii)}`, column: 50 }],
        caps,
      ),
      entry(facts, { depth: 1, symbol: counts.errors === 0 ? 'success' : 'error' }, caps),
      [
        sectionLabel('Artifact', caps),
        ...entry(
          [
            [atom(path, 'cyan', 0)],
            [
              atom(`sha256 ${truncateDigest(view.digest, caps.ascii)}`, null, 0),
              ...words(`${Buffer.byteLength(view.text)} bytes`, 'dim', 2),
            ],
          ],
          { depth: 1, symbol: 'info' },
          caps,
        ),
      ],
      entry(
        [
          words(
            counts.errors > 0
              ? 'Run "ia validate" for the located findings, fix them, then compile again.'
              : 'Compare two artifacts byte for byte: identical sources on one language version compile identically.',
          ),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}

/**
 * The legacy programmatic adapter adds this line whenever it returns a capture result; a refusal prints only
 * the refusal. The removed CLI command does not call this adapter.
 */
export const DEPRECATION = `Deprecated: runCompile is a compatibility helper; the ia compile command was removed in 3.0. Use "ia capture", which writes the admitted snapshot to ${CAPTURE_CURRENT}.\n`;

/**
 * The 1.x options the capture has no place for, refused as usage before the workspace is read. The remedy names the
 * capture to run instead, with `--root` as given, which the decision's constraint requires of an unmapped option.
 */
function unmapped(context: Context): void {
  const option = context.args.value('out') !== undefined ? 'out' : context.args.flag('stdout') ? 'stdout' : null;
  if (option === null) return;
  const root = context.args.value('root'),
    capture = `ia capture${root === undefined ? '' : ` --root ${quote(root)}`}`;
  throw new Refusal(
    'IA-CLI-USAGE',
    `The legacy runCompile helper delegates to ia capture, which writes the admitted snapshot only to ${CAPTURE_CURRENT}, so --${option} has no equivalent`,
    2,
    null,
    `Run "${capture}" to write the admitted snapshot.`,
  );
}

export function runCompile(context: Context): Result {
  unmapped(context);
  const capture = findCommand('capture');
  if (capture === undefined) throw new Error('The command table has no capture row.');
  // The capture runs as itself, so a refusal it raises names `ia capture` reruns rather than `ia compile` ones.
  const result = runCapture({ ...context, command: capture });
  return { ...result, stderr: result.stderr + DEPRECATION };
}
