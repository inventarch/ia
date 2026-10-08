/**
 * `ia compile`: docs/specs/consumer-cli-contract/README.md §2.4, deprecated in favour of `ia capture`.
 *
 * Decision release-bump (operator, 2026-10-07): in 1.x the verb keeps its behaviour exactly — the `ia.compiled.v1`
 * artifact at .ia/work/compiled.json or `--out <file>` under .ia/work/, `--stdout`, the IA-DIST-LOCAL-MODIFICATION
 * refusal without `--force` and its exit classes — and adds one deprecation line on stderr naming `ia capture`. The
 * alias of decision compile-verb-fate, which routes the verb to the capture, waits for 2.0.
 *
 * One deterministic document, `ia.compiled.v1`. Determinism is a requirement on this writer, not a hope: records
 * are sorted by canonical identity, diagnostics by (path, line, code, message), object keys are emitted sorted and
 * the document ends in exactly one newline — which is what the distribution's own `json()` serializer does, so it
 * is the function called rather than a second encoder beside it.
 *
 * No product-quality claim. Compilation establishes that records parse, that references resolve and that declared
 * structural obligations are satisfied. Where a semantic evaluator is unavailable the compiler carries
 * IA-COMP-NOT-EVALUATED through into `diagnostics` and `counts.notEvaluated`; that result is never rolled into a
 * pass, never suppressed and never omitted from --json.
 */
import { resolve } from 'node:path';
import { CAPTURE_CURRENT } from '@inventarch/db';
import {
  createFile,
  json,
  LANGUAGE_IDENTITY,
  replace,
  sha256,
  workOutputPath,
} from '@inventarch/distribution/services';
import { findingCounts, orderFindings } from './capture.js';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import { codeOf, openSession } from './session.js';
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
 * Decision release-bump (operator, 2026-10-07): `ia compile` keeps its 1.x behaviour and prints this one line on
 * stderr whenever it runs to a result, in every output mode, `--json` and `--stdout` included, so stdout stays exactly
 * what 1.x wrote there; a refusal prints only the refusal. The alias of decision compile-verb-fate lands in 2.0.
 */
export const DEPRECATION = `Deprecated: ia compile becomes an alias of "ia capture" in 2.0 and is removed in 3.0; run "ia capture" to write the admitted snapshot to ${CAPTURE_CURRENT}.\n`;

/**
 * §2.4: running `ia compile` twice is the ordinary case, so refusing by default is stated rather than discovered.
 * `createFile` raises IA-DIST-LOCAL-MODIFICATION on an existing entry; the code is carried through unchanged and
 * only the next action is added, because a refusal whose remedy is one flag must name that flag.
 */
function publish(root: string, path: string, content: Buffer, force: boolean, overwrite: string): void {
  if (force) {
    replace(root, path, content);
    return;
  }
  try {
    createFile(root, path, content);
  } catch (error) {
    if (codeOf(error, '') !== 'IA-DIST-LOCAL-MODIFICATION') throw error;
    throw new Refusal(
      'IA-DIST-LOCAL-MODIFICATION',
      `${path} already exists`,
      3,
      { path },
      `Run "${overwrite}" to overwrite it.`,
    );
  }
}
/** The refused invocation again with `--force`, so the one flag the remedy needs is named in a runnable command. */
function forced(context: Context): string {
  const out = context.args.value('out'),
    root = context.args.value('root');
  return [
    'ia compile',
    ...(out === undefined ? [] : ['--out', quote(out)]),
    '--force',
    ...(root === undefined ? [] : ['--root', quote(root)]),
  ].join(' ');
}
/**
 * The artifact's place, decided before the workspace is read so an unsafe `--out` never costs a compilation. The
 * distribution's IA-DIST-PATH-UNSAFE is carried through unchanged (§4.1); only its next action is added, the rerun
 * with the one value the user has to correct.
 */
function placement(context: Context, root: string): string {
  try {
    return workOutputPath({
      root,
      path: context.args.value('out') ?? DEFAULT_OUT,
      refusal: 'A compiled artifact is written under .ia/work/',
    });
  } catch (error) {
    if (error instanceof Refusal || codeOf(error, '') !== 'IA-DIST-PATH-UNSAFE') throw error;
    throw new Refusal(
      'IA-DIST-PATH-UNSAFE',
      error instanceof Error ? error.message : String(error),
      3,
      null,
      `Run "${respell(context, { options: { out: ['<file>'] } })}" naming a file under .ia/work/.`,
    );
  }
}

export function runCompile(context: Context): Result {
  const { args, caps, json: machine } = context;
  const root = requireRoot(context);
  const path = args.flag('stdout') ? null : placement(context, root);
  const view = collectCompile(root);
  const exitCode = compileExit(view);
  // §2.4: with --stdout the artifact is the single value on stdout, so nothing else may be written there.
  if (path === null) return { exitCode, stdout: view.text, stderr: DEPRECATION };
  publish(root, path, Buffer.from(view.text, 'utf8'), args.flag('force'), forced(context));
  return machine
    ? { exitCode, stdout: JSON.stringify(compileEnvelope(view, resolve(root, path))) + '\n', stderr: DEPRECATION }
    : { exitCode, stdout: renderCompile(view, path, caps), stderr: DEPRECATION };
}
