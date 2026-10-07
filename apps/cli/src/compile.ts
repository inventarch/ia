/**
 * `ia compile`: a deprecated alias of `ia capture` for 2.x, removed in 3.0 (apps/cli/SPEC.md, Workspace
 * commands).
 * The verb runs capture (capture.ts); `COMPILE_FLAGS` says what becomes of each of its former options.
 *
 * The `ia.compiled.v1` builder below stays exported through `./internal/compile` for the same major, though no
 * verb writes it any longer. One deterministic document, `ia.compiled.v1`. Determinism is a requirement on this
 * writer, not a hope: records are sorted by canonical identity, diagnostics by (path, line, code, message), object
 * keys are emitted sorted and the document ends in exactly one newline — which is what the distribution's own
 * `json()` serializer does, so it is the function called rather than a second encoder beside it.
 *
 * No product-quality claim. Compilation establishes that records parse, that references resolve and that declared
 * structural obligations are satisfied. Where a semantic evaluator is unavailable the compiler carries
 * IA-COMP-NOT-EVALUATED through into `diagnostics` and `counts.notEvaluated`; that result is never rolled into a
 * pass, never suppressed and never omitted from --json.
 */
import { json, LANGUAGE_IDENTITY, sha256 } from '@inventarch/distribution/services';
import { runCapture } from './capture.js';
import type { Context, Result } from './consumer.js';
import { Refusal } from './consumer.js';
import { openSession } from './session.js';
import type { Session } from './session.js';
import { NOT_EVALUATED } from './validate.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, sectionLabel, truncateDigest, words } from './render.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];

export const DEFAULT_OUT = '.ia/work/compiled.json';
/** One stderr line in text mode only, so `--json` keeps stdout to its one value and stderr empty. */
export const COMPILE_DEPRECATION = 'Deprecated: "ia compile" is an alias of "ia capture" and is removed in 3.0.';
/**
 * The alias's handling of the options `ia compile` had before `ia capture`: `map` where capture has an equivalent,
 * otherwise a usage refusal whose next command is the capture invocation to run instead. Capture always replaces its
 * stored current (rotating it to previous only on a revision change), so `--force` is what it already does; it has
 * one fixed store and prints a report, so neither another path nor the artifact on stdout has an equivalent.
 */
export const COMPILE_FLAGS: Readonly<
  Record<'force' | 'out' | 'stdout', { readonly map: true } | { readonly next: string }>
> = {
  force: { map: true },
  out: {
    next: 'Run "ia capture"; it keeps the snapshot under .ia/work/snapshot/, the one place a later command reads it.',
  },
  stdout: { next: 'Run "ia capture --preview --json" to see what capture would keep without writing anything.' },
};
export const ARTIFACT = 'ia.compiled.v1';

export interface CompileCounts {
  readonly records: number;
  readonly errors: number;
  readonly warnings: number;
  readonly notEvaluated: number;
}
export interface CompiledArtifact {
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
/** The ordering the compliance layer already applies, reused rather than reinvented. */
const orderFindings = (findings: readonly Finding[]): readonly Finding[] =>
  [...findings].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
  );

export function buildArtifact(root: string, session: Session): CompileView {
  const admission = session.admission();
  const records = [...session.reader.records()].sort((a, b) => compare(a.identity, b.identity));
  const diagnostics = orderFindings(admission.findings);
  const artifact: CompiledArtifact = {
    formatVersion: 1,
    artifact: ARTIFACT,
    language: LANGUAGE_IDENTITY.language,
    kernelDigest: LANGUAGE_IDENTITY.kernelDigest,
    root,
    revision: admission.revision,
    records,
    diagnostics,
    counts: {
      records: records.length,
      errors: diagnostics.filter((finding) => finding.severity === 'error').length,
      warnings: diagnostics.filter((finding) => finding.severity === 'warning').length,
      notEvaluated: diagnostics.filter((finding) => NOT_EVALUATED.has(finding.code)).length,
    },
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

/** §2.4: the artifact is written even when the compilation produced errors; the exit class carries the verdict. */
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

export function runCompile(context: Context): Result {
  // Usage first, before the root is read: an option capture cannot honour is refused with the command to run instead.
  for (const [flag, handling] of Object.entries(COMPILE_FLAGS))
    if ('next' in handling && (flag === 'out' ? context.args.value(flag) !== undefined : context.args.flag(flag)))
      throw new Refusal(
        'IA-CLI-USAGE',
        `ia compile is now an alias of ia capture, which has no --${flag}`,
        2,
        null,
        handling.next,
      );
  const result = runCapture(context);
  return context.json ? result : { ...result, stderr: `${COMPILE_DEPRECATION}\n${result.stderr}` };
}
