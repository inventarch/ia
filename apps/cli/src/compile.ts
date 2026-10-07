/**
 * `ia compile`: a deprecated alias of `ia capture` for 2.x, removed in 3.0 (decision compile-verb-fate).
 *
 * The verb runs the capture, so one snapshot format is written rather than two, and prints one deprecation line on
 * stderr, never on stdout. Its three flags are mapped by what each did: `--force` permitted overwriting the artifact,
 * and a capture never refuses to replace its snapshot, so it maps onto `ia capture` unchanged; `--out <file>` and `--stdout`
 * chose where the artifact went, and a capture has one place and never writes its snapshot to stdout, so each refuses,
 * alone or together, and names the `ia capture` to run instead. The `ia.compiled.v1` builders below stay exported for
 * code that imports this module; the verb no longer writes that artifact.
 *
 * docs/specs/consumer-cli-contract/README.md §2.4: one deterministic document, `ia.compiled.v1`. Determinism is a
 * requirement on this writer, not a hope: records are sorted by canonical identity, diagnostics by (path, line, code,
 * message), object keys are emitted sorted and the document ends in exactly one newline — which is what the
 * distribution's own `json()` serializer does, so it is the function called rather than a second encoder beside it.
 *
 * No product-quality claim. Compilation establishes that records parse, that references resolve and that declared
 * structural obligations are satisfied. Where a semantic evaluator is unavailable the compiler carries
 * IA-COMP-NOT-EVALUATED through into `diagnostics` and `counts.notEvaluated`; that result is never rolled into a
 * pass, never suppressed and never omitted from --json.
 */
import { json, LANGUAGE_IDENTITY, sha256 } from '@inventarch/distribution/services';
import { CURRENT, findingCounts, orderFindings, PREVIOUS, runCapture } from './capture.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { Refusal, respell } from './consumer.js';
import { openSession } from './session.js';
import type { Session } from './session.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, sectionLabel, truncateDigest, words } from './render.js';

type Admission = ReturnType<Session['admission']>;
type Finding = Admission['findings'][number];

/** Where `ia compile` wrote the artifact before it became an alias of `ia capture`. */
export const DEFAULT_OUT = '.ia/work/compiled.json';
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

export function buildArtifact(root: string, session: Session): CompileView {
  const admission = session.admission();
  // ia.compiled.v1 records predate graph G13, so the artifact and its digest omit the per-record digest.
  const records = [...session.reader.records()]
    .sort((a, b) => compare(a.identity, b.identity))
    .map(({ digest: _digest, ...record }) => record);
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

/**
 * The one line the alias prints on stderr, in `--json` mode too, whenever it runs the capture; a refusal prints only
 * the refusal. It says where the snapshot is, which holds whether or not this run rewrote it. The snapshot path is
 * spelled out because this module and capture.ts import each other through consumer.ts, so capture's `CURRENT` may
 * not be initialized yet when this constant is.
 */
export const DEPRECATION = `Deprecated: ia compile is an alias of "ia capture" and is removed in 3.0; the snapshot is at .ia/work/snapshot/current.json, not ${DEFAULT_OUT}.\n`;

export function runCompile(context: Context): Result {
  const { args } = context;
  // The capture's own refusals then name `ia capture`, carrying only the options a capture takes.
  const capture: Context = { ...context, command: findCommand('capture')! };
  if (args.flag('stdout'))
    throw new Refusal(
      'IA-CLI-USAGE',
      `ia compile --stdout is retired: ia capture writes its snapshot only to ${CURRENT}, never to stdout`,
      2,
      null,
      `Run "${respell(capture)}", then read ${CURRENT}.`,
    );
  if (args.value('out') !== undefined)
    throw new Refusal(
      'IA-CLI-USAGE',
      `ia compile --out is retired: ia capture writes ${CURRENT} and ${PREVIOUS} and takes no output path`,
      2,
      null,
      `Run "${respell(capture)}" to write the snapshot.`,
    );
  const result = runCapture(capture);
  return { ...result, stderr: DEPRECATION + result.stderr };
}
