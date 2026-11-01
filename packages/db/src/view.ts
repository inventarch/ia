import { createHash } from 'node:crypto';
import {
  BudgetExceeded,
  KERNEL_DIGEST,
  LANGUAGE_VERSION,
  WorkBudget,
  buildRegistry,
  compile,
  identityOf,
  parse,
  requirementCollisions,
  scan,
} from '@inventarch/language';
import type {
  Band,
  CompiledRecord,
  Diagnostic,
  FrozenRegistry,
  Phase,
  RecordNode,
  Source,
  Span,
} from '@inventarch/language';
import type { CompileResult } from '@inventarch/language';
import { authoredRevisionOf, canonicalRoot, frozen, load, reaches, stableSerialize } from '@inventarch/graph';
import type { Graph, GraphDiagnostic, RevisionSource } from '@inventarch/graph';
import {
  evaluate,
  validateCheck,
  validateCheckStructure,
  validateConsent,
  validateGraphSchema,
  validateSelectors,
  validateSystems,
  validateVariants,
} from '@inventarch/compliance';
import type { Assessment, Finding, Report, SystemFolder } from '@inventarch/compliance';
import type { InputSnapshot } from './inputs.js';
import {
  EVIDENCE_DIRECTORY,
  SOURCE_BOUNDS,
  WORK_BOUNDS,
  evidenceSource,
  overBound,
  pastBound,
  systemMember,
} from './inputs.js';
import { bindChecks } from './checks.js';
import { conformanceOf } from './conformance.js';
import { reproducesEvidence } from './evidence.js';
import { runnerEvidenceSources } from './runner-evidence.js';
import { declaredRoots, membershipOf } from './membership.js';
import type { DeclaredRoot, MembershipRow } from './membership.js';
import { repositoryWorkspace } from './seat.js';
import { InstallationError } from './distribution/codec.js';

export interface RefusedRecord {
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}
/** The admission finding that refused an unadmitted occurrence: one diagnostic db already holds for it. */
export interface UnadmittedFinding {
  readonly code: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}
/**
 * One record occurrence of a view's sources that the view does not admit (D15), with the band of the placement its
 * source was read at, which is where capture membership and every band test read a record's band from, and its own
 * admission finding:
 * - an occurrence `refused` names (a compliance exclusion, a schema failure, a refused system join or a refused
 *   enclosing record), with the finding that excluded it: the assessment's or system check's own, the enclosing
 *   record's, or for a refused system join the finding that blocked its system;
 * - an occurrence of an identity that another occurrence ties at the same band, with its IA-GRAPH-IDENTITY-TIE;
 * - a record a file declares when the file is refused whole, by a language error or by a requirement id another
 *   occurrence declares too, before any graph is built, with the error inside its lines, else the file's first error,
 *   which refused the file. Each header the view's own parse of the file reads is one, with the identity the compile of
 *   the file gives the record or, where the compile refused it, the identity language `identityOf` gives its header
 *   under its word's registration. The file's captured text, split at every line terminator (CRLF, CR or LF), adds
 *   three readings the parse cannot give: a line that opens with `@<word>` after any whitespace or Unicode format
 *   characters (a no-break space, a form feed, a zero-width space, a byte-order mark) and is no header the parse read
 *   is one, wherever it stands, inside a parsed record too, with the name token after it and no identity; on a line no
 *   parsed record spans, each `@<word>` token anywhere on it is one, with no name, unless the language scanner reads
 *   the whole line as a comment (`#` after ASCII spaces or tabs, in a file with no bare CR), as it reads the
 *   attribution `ia author` writes, so a file whose parse reads no record (no or another pragma) lists every word it
 *   mentions outside such comments; and a line the first reading names no header on is one with no word, a record db
 *   cannot identify, when it holds one of the file's errors and no parsed record spans it, when an at sign opens it
 *   wherever it stands, or, in a file refused at its pragma, when it stands at column 0 and is neither blank nor a
 *   comment (`refusedWhole`). The readings err towards listing: a non-header line so spelled in a file already refused
 *   is listed under its word, an error or at-sign line that declares nothing with no word. An error inside a parsed
 *   record's lines, on a line no at sign opens, is that record's alone;
 * - a source a view refuses alone (D03a), or what stands past `OCCURRENCE_BOUNDS`: one occurrence with no word.
 */
export interface UnadmittedRecord {
  /**
   * The canonical identity, when the view compiled the record or language `identityOf` names its parsed header; absent
   * for a header only the source text shows, or whose word no admitted system registers.
   */
  readonly identity?: string;
  /**
   * The word the header names, lowercased; absent for an error line of a file refused whole that no record db can
   * identify accounts for, which may declare a record of any word.
   */
  readonly word?: string;
  /**
   * The record's name as its header spells it, lowercased (what a typed reference to it is matched by); absent for a
   * header that spells none and for a token read past the start of a line.
   */
  readonly name?: string;
  readonly band: Band;
  readonly path: string;
  /** The header line. */
  readonly line: number;
  readonly endLine: number;
  /** The admission finding that refused it. */
  readonly finding: UnadmittedFinding;
}
/** Internal view; public reads project allowed nodes, never this candidate registry. */
export interface View {
  readonly graph: Graph;
  /**
   * The authored revision of this view (graph `authoredRevisionOf`): `graph.revision` without the sources at runtime
   * placement, the derived revision-only input (D03) kept, so it equals `graph.revision` while no source is placed so.
   */
  readonly authoredRevision: string;
  readonly report: Report;
  /**
   * D10a: the report as a view that does not verify conformance has it, `report` itself when this one does not. D14
   * evidence is admitted from it, so the option never changes which evidence, and so which graph, a view reads.
   */
  readonly unverified: Report;
  /** D03a: the paths of the sources this view holds and refused whole, which no reader may parse in its stead. */
  readonly unparsed: ReadonlySet<string>;
  /** D03a: the units of work its sources spent, which is what holding this view costs (D03b). */
  readonly work: number;
  readonly refused: readonly RefusedRecord[];
  /** Every record occurrence of the view's sources it does not admit, `refused` among them, by path then line. */
  readonly unadmitted: readonly UnadmittedRecord[];
  readonly admittedSystems: readonly string[];
  readonly blockedSystems: readonly string[];
  readonly boundary: readonly string[];
  /** D02a capture membership of every admitted node, in `graph.nodes` order. */
  readonly membership: readonly MembershipRow[];
  /** D02a roots the capture declares, longest first, then by workspace; they seat paths (D02b) as well as records. */
  readonly declared: readonly DeclaredRoot[];
  /** D02b: the repository's own @workspace, decided once per capture; absent when none or several qualify. */
  readonly repository?: string;
}
interface Context {
  readonly sources: readonly Source[];
  readonly registry: FrozenRegistry;
  readonly records: readonly CompiledRecord[];
  /** Every record the compile read, those of a file with a language error included (`records` leaves them out). */
  readonly compiled: readonly CompiledRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly errorPaths: ReadonlySet<string>;
  /** D03a: the entry of each source refused whole in this context, in every stage up to compilation. */
  readonly refused: ReadonlyMap<string, Finding>;
  /** D03a: what this context's parse, registry and compile spent, which each admission pass pays again. */
  readonly work: number;
}
export const occurrenceKey = (record: CompiledRecord): string =>
  JSON.stringify([record.identity, record.source.path, record.source.line]);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/**
 * D15: how many occurrences `unadmitted` lists, of one file and of the whole view. Past them, one occurrence with no word
 * stands for the rest of the file, which a reader that gates on a word counts as possibly that word (`capped`).
 */
export const OCCURRENCE_BOUNDS = Object.freeze({ file: 1_024, view: 65_536 });
/** The index of the first item at or past `line`, in items in line order. */
function firstAt(items: readonly { readonly line: number }[], line: number): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.line < line) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** Adds `value` to the list at `key`. */
function listAt<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
  const list = lists.get(key);
  if (list === undefined) lists.set(key, [value]);
  else list.push(value);
}
/** Whether a line is in one of `spans`, from their union, which is in line order. */
function spanIndex(spans: readonly Span[]): (line: number) => boolean {
  const union: { line: number; endLine: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.line - b.line)) {
    const last = union[union.length - 1];
    if (last !== undefined && span.line <= last.endLine + 1) last.endLine = Math.max(last.endLine, span.endLine);
    else union.push({ line: span.line, endLine: span.endLine });
  }
  return (line) => {
    const at = firstAt(union, line + 1) - 1;
    return at >= 0 && union[at]!.endLine >= line;
  };
}
/**
 * What one reading in a listing may spend. It reads again what a view has already paid for, once for each view, so it
 * spends nothing of the view's budget: a file's text scans for no more than its parse did, and a header says one line.
 */
const reading = (): WorkBudget => new WorkBudget(WORK_BOUNDS.view);
/** A diagnostic as an unadmitted occurrence carries it. */
const findingOf = (diagnostic: {
  readonly code: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}): UnadmittedFinding =>
  Object.freeze({ code: diagnostic.code, path: diagnostic.path, line: diagnostic.line, message: diagnostic.message });
/**
 * A line that opens with `@<word>` after any whitespace or Unicode format characters, and the name token after it when
 * one is there: the header syntax, read from text the parse could not read.
 */
const HEADER = /^[\s\p{Cf}]*@([A-Za-z][A-Za-z0-9-]*)(?=[\s\p{Cf}]|$)(?:[\s\p{Cf}]+([^\s\p{Cf}]+))?/u;
/** An `@<word>` token anywhere on a line. */
const TOKEN = /@([A-Za-z][A-Za-z0-9-]*)/g;
/** A line of whitespace and Unicode format characters alone, which declares nothing. */
const BLANK = /^[\s\p{Cf}]*$/u;
/** A comment line, `#` first after any whitespace or format characters (the pragma line among them): it declares nothing. */
const COMMENT = /^[\s\p{Cf}]*#/u;
/**
 * A line that opens, after any whitespace or format characters, with an at sign: `@`, the full-width U+FF20 or the small
 * U+FE6B.
 */
const AT = /^[\s\p{Cf}]*[@\uFF20\uFE6B]/u;
/** A line at column 0, which no whitespace opens. */
const TOP = /^\S/u;
/** The codes of a file refused at its pragma, past which its parse reports nothing. */
const PRAGMA = new Set(['IA-LANG-PRAGMA-MISSING', 'IA-LANG-VERSION-UNSUPPORTED']);
/**
 * The occurrences of a file a view refuses whole (`UnadmittedRecord`): every header its parse reads, nested ones
 * included, with the identity its compile gives that header's record or, for one its compile refused, the identity
 * `identityOf` gives it over its word's registration, then every other line of `text` that opens with a header, under
 * its word and name, every `@<word>` token on a line no parsed record spans that is not a proven full-line comment,
 * under its word, and, under no word, every line no header reading names that may declare a record db cannot identify:
 * an error's (for one at a blank or comment line, the first line from there that is neither) that no parsed record
 * spans, one an at sign opens, and in a file refused at its pragma one at column 0 that is neither blank nor a comment.
 * Each carries the error inside its lines, else `errors[0]`, the file's first error. Each of the three lists stops at
 * `limit`: the first `limit` occurrences by line lie within them, and no more is made than a listing can hold.
 */
export function refusedWhole(
  source: Source,
  text: string,
  identities: ReadonlyMap<number, string>,
  registry: FrozenRegistry,
  errors: readonly Diagnostic[],
  limit: number,
): readonly UnadmittedRecord[] {
  const path = source.ast.path,
    band = source.location.placement.band,
    nodes: RecordNode[] = [];
  const walk = (records: readonly RecordNode[]): void => {
    for (const record of records) {
      nodes.push(record);
      walk(record.nested);
    }
  };
  walk(source.ast.records);
  // `errors` is in line order, so the first inside a line range is found by its start; occurrences of one error share it.
  const findings = new Map<Diagnostic, UnadmittedFinding>();
  const finding = (line: number, endLine: number): UnadmittedFinding => {
    const inside = errors[firstAt(errors, line)],
      error = inside !== undefined && inside.line <= endLine ? inside : errors[0]!;
    const known = findings.get(error);
    if (known !== undefined) return known;
    const made = findingOf(error);
    findings.set(error, made);
    return made;
  };
  const occurrence = (
    word: string | undefined,
    name: string | undefined,
    line: number,
    endLine: number,
  ): UnadmittedRecord => ({
    ...(word === undefined ? {} : { word: word.toLowerCase() }),
    ...(name === undefined || name === '' ? {} : { name: name.toLowerCase() }),
    band,
    path,
    line,
    endLine,
    finding: finding(line, endLine),
  });
  const parsed = nodes.slice(0, limit).map((node): UnadmittedRecord => {
    const registration = registry.registrations.get(node.discriminator);
    const identity =
      identities.get(node.span.line) ??
      (registration === undefined ? undefined : identityOf(node, registration, path, reading()).identity?.identity);
    return {
      ...(identity === undefined ? {} : { identity }),
      ...occurrence(node.discriminator, node.name, node.span.line, node.span.endLine),
    };
  });
  const headers = new Set(nodes.map((node) => node.span.line));
  // A record's lines are those of a header the parse read, to the end of its structure (its syntax span, refused
  // trailing lines included); the span of a header the parse refused identifies no record, so it spans nothing.
  const spanned = spanIndex([
    ...nodes.map((node) => node.span),
    ...(source.ast.syntaxRecordSpans ?? []).filter((span) => headers.has(span.line)),
  ]);
  const lines = text.split(/\r\n|\r|\n/),
    // An attribution's references are not declarations. Require actual language trivia and the complete physical
    // line: a trailing comment, comment-like prose or malformed prefix must keep the conservative token scan.
    // Scan the same captured text, never a filesystem reread: the parse of a file refused at its pragma holds no
    // trivia, and any other parse adds only trailing comments to the scanner's, which the two checks below refuse.
    // The language scanner does not split bare CR; do not use its line numbers against our broader line splitting.
    comments = new Set(
      (/\r(?!\n)/.test(text) ? [] : scan(text, path, reading()).trivia)
        .filter(
          (trivia) =>
            trivia.kind === 'comment' &&
            /^[ \t]*#/.test(lines[trivia.line - 1] ?? '') &&
            lines[trivia.line - 1]!.trim() === trivia.text,
        )
        .map((trivia) => trivia.line),
    ),
    named = new Set<number>();
  const unread: UnadmittedRecord[] = [];
  // The line the reading stopped at: past `limit` of them, nothing further can be listed.
  let read = 0;
  for (; read < lines.length && unread.length < limit; read++) {
    const spelled = lines[read]!,
      line = read + 1,
      header = HEADER.exec(spelled);
    if (header !== null) {
      named.add(line);
      if (!headers.has(line)) unread.push(occurrence(header[1]!, header[2], line, line));
    } else if (!spanned(line) && !comments.has(line))
      for (const token of spelled.matchAll(TOKEN)) {
        if (unread.length === limit) break;
        unread.push(occurrence(token[1]!, undefined, line, line));
      }
  }
  // A line no header reading names that may declare a record db cannot identify, of any word, is listed with none.
  // (1) An error at a line no parsed record spans; an error inside an identified record is that record's. An error at a
  // blank or comment line, or past the text, as a missing pragma in an empty or comment-only file is, is taken at the
  // first line from there that is neither, and at none when there is none. (2) A line opening with an at sign, wherever
  // it stands, inside a parsed record's lines too. (3) In a file refused at its pragma, whose parse reports nothing
  // past it, every top-level line that is neither blank nor a comment.
  const declares = (spelled: string): boolean => !BLANK.test(spelled) && !COMMENT.test(spelled);
  // The first line from each line that may declare one, walked once from the end.
  const nextDeclaring = new Array<number | undefined>(lines.length + 2);
  for (let at = lines.length; at >= 1; at--) nextDeclaring[at] = declares(lines[at - 1]!) ? at : nextDeclaring[at + 1];
  const declaring = (line: number): number | undefined => nextDeclaring[Math.max(line, 1)];
  const atPragma = errors.some((error) => PRAGMA.has(error.code));
  const suspect = new Set<number>();
  for (const error of errors) {
    const line = declaring(error.line);
    if (line !== undefined && !spanned(line)) suspect.add(line);
  }
  for (let index = 0; index < read; index++) {
    const spelled = lines[index]!;
    if (AT.test(spelled) || (atPragma && TOP.test(spelled) && declares(spelled))) suspect.add(index + 1);
  }
  const unknown = [...suspect]
    .filter((line) => line <= read && !named.has(line))
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((line) => occurrence(undefined, undefined, line, line));
  return [...parsed, ...unread, ...unknown];
}
/**
 * D15: `entries`, in listing order, held to `OCCURRENCE_BOUNDS`. The first entry past a bound becomes one occurrence with
 * no word, no name and no identity: db cannot say what the rest of that file declares, so a reader that gates on a word
 * counts it as possibly that word, and runtime R23 still fails closed for an authored file. Each file past a bound has one.
 */
function capped(entries: readonly UnadmittedRecord[]): readonly UnadmittedRecord[] {
  const kept: UnadmittedRecord[] = [];
  let listed = 0,
    path: string | undefined,
    inFile = 0,
    closed = false;
  for (const entry of entries) {
    if (entry.path !== path) {
      path = entry.path;
      inFile = 0;
      closed = false;
    }
    if (closed) continue;
    if (inFile < OCCURRENCE_BOUNDS.file && listed < OCCURRENCE_BOUNDS.view) {
      kept.push(entry);
      inFile += 1;
      listed += 1;
      continue;
    }
    closed = true;
    const bound =
      inFile < OCCURRENCE_BOUNDS.file
        ? `the first ${OCCURRENCE_BOUNDS.view} of this workspace`
        : `the first ${OCCURRENCE_BOUNDS.file} of this file`;
    kept.push({
      band: entry.band,
      path: entry.path,
      line: entry.line,
      endLine: entry.line,
      finding: Object.freeze({
        code: 'IA-DB-SOURCE-UNAVAILABLE',
        path: entry.path,
        line: entry.line,
        message: `${entry.path}: occurrences past ${bound} are not listed`,
      }),
    });
  }
  return kept;
}
function diagnosticsOf(values: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...new Map(values.map((d) => [stableSerialize(d), d])).values()].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code),
  );
}
/** A compiled source without its tree, but for the @system records in it. */
function declarationsOf(source: Source): Source {
  const declarations: RecordNode[] = [];
  const visit = (records: readonly RecordNode[]): void => {
    for (const record of records)
      if (record.discriminator === 'system') declarations.push(record);
      else visit(record.nested);
  };
  visit(source.ast.records);
  return {
    ...source,
    ast: { kind: 'file', path: source.ast.path, version: source.ast.version, records: declarations, trivia: [] },
  };
}
/** How a view admits: every existing reader takes the defaults. */
export interface ViewOptions {
  /**
   * D13: `strict`, the default, admits a `@check` only when its runner is a built-in id (compliance validateCheck), so
   * an unknown runner is IA-COMP-CHECK-UNKNOWN and the record is not admitted, as every released reader has it;
   * `structural` admits any check that names one evaluator (validateCheckStructure), for the validate path that binds
   * checks against a host's catalog.
   */
  readonly checks?: 'strict' | 'structural';
  /**
   * D10: `verify` runs compliance's `package-v1` conformance profile in-process (C31) and binds its COMP-KERNEL and
   * COMP-FIXTURES evidence to each view's graph, so their verdicts are verified instead of not-evaluated; without it,
   * as for every existing reader, nothing runs. Only the report differs: D14 evidence is admitted from the unverified
   * report (`View.unverified`), so admission, the evidence read and the graph are the same.
   */
  readonly conformance?: 'verify';
}
/**
 * D14: the evidence file at `source` when it is exactly what the writer makes for the checks `root` admits
 * (`reproducesEvidence`): their bindings derived again from `root`'s own records and report, the times taken from the
 * file itself. A forged verdict, reason or record, an observation for a check not evaluated, a relationship, another
 * locator or revision, any byte the writer would not write, and anything written for another view, is not evidence.
 * Only built-in evaluators produce evidence, so no catalog takes part. The checks are bound from the unverified report
 * (D10a), as the validate request binds them.
 */
function writerEvidence(source: RevisionSource, root: View): RevisionSource | undefined {
  // The validate request records nothing for a refused admission, so no file is evidence for one.
  if (root.unverified.findings.some((finding) => finding.severity === 'error')) return undefined;
  const records = [...root.graph.nodes.values()];
  return reproducesEvidence({
    authoredRevision: root.authoredRevision,
    bindings: bindChecks(records, root.unverified, { status: 'unavailable', reason: 'no catalog takes part' }),
    records,
    text: source.text,
  })
    ? source
    : undefined;
}
/**
 * What `view` admits of everything but the evidence at `path`: its unverified findings, verdicts and refusals,
 * revisions aside.
 */
function authoredAdmission(view: View, paths: ReadonlySet<string>): string {
  const evidence = new Set(
    [...view.graph.nodes.values()].filter((node) => paths.has(node.source.path)).map((node) => node.identity),
  );
  return stableSerialize({
    findings: view.unverified.findings.filter((finding) => !paths.has(finding.path)),
    verdicts: view.unverified.verdicts
      .filter((verdict) => !evidence.has(verdict.scope))
      .map((verdict) => ({
        check: verdict.check,
        scope: verdict.scope,
        outcome: verdict.outcome,
        findings: verdict.findings.filter((finding) => !paths.has(finding.path)),
      })),
    refused: view.refused.filter((record) => !paths.has(record.path)),
    records: [...view.graph.nodes.values()]
      .filter((node) => !evidence.has(node.identity))
      .map((node) => node.identity)
      .sort(compare),
  });
}
/** The runtime metadata source every view's revision hashes: the inputs' layout, which no authored file states. */
function metadataOf(input: InputSnapshot): RevisionSource {
  return {
    path: '.ia/.db-inputs.json',
    text: stableSerialize({
      folders: input.folders,
      floorOrigin: input.floorOrigin,
      admissionVersion: 1,
      ...(input.authoredRoots ? { authoredRoots: input.authoredRoots } : {}),
      ...(input.activation ? { activation: input.activation } : {}),
    }),
    location: { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' },
  };
}
/**
 * The views of `input`, admitted as `options` says. With evidence listed (D14), the authored view is built first; the
 * one file named after its authored revision, and no other, is then read and admitted only when it is exactly the
 * file the writer makes for that view's checks (`writerEvidence`) and adding it changes nothing the authored records
 * admit: their findings, verdicts, refusals and records stay as they were.
 * Otherwise the authored view stands, as for a file that is not evidence. Evidence moves `revision`, never
 * `authoredRevision`, and is never what a validation binds or reports admission from.
 */
export function viewBuilder(
  input: InputSnapshot,
  options: ViewOptions = {},
): (location?: string, phase?: Phase) => View {
  const metadata = metadataOf(input),
    authored = views(input, options, metadata, []);
  if (!input.evidence?.length && !input.runnerEvidence?.length) return authored;
  const root = authored(),
    rooted =
      (build: typeof authored, view: View): typeof authored =>
      (location, phase) =>
        location === undefined && phase === undefined ? view : build(location, phase);
  const wanted = `${EVIDENCE_DIRECTORY}/${root.authoredRevision}.ia`;
  const listed = input.evidence?.find((candidate) => candidate.path === wanted),
    read = listed === undefined ? undefined : evidenceSource(input.root, listed.path),
    source = read === undefined ? undefined : writerEvidence(read, root);
  let sources: readonly RevisionSource[] = [],
    build = authored,
    evidenced = root;
  if (source !== undefined) {
    const candidate = views(input, options, metadata, [source]),
      result = candidate(),
      paths = new Set([source.path]);
    if (authoredAdmission(result, paths) === authoredAdmission(root, paths)) {
      sources = [source];
      build = candidate;
      evidenced = result;
    }
  }
  // Runner evidence adds only generated journal claims. D14 validation reproduction above is unchanged and stands
  // independently. Like it, it is decided from the unverified reports (D10a).
  if (!root.unverified.findings.some((finding) => finding.severity === 'error')) {
    const runner = runnerEvidenceSources(input, root.authoredRevision, evidenced.graph);
    if (runner.length > 0) {
      const candidate = views(input, options, metadata, [...sources, ...runner]),
        result = candidate(),
        paths = new Set(runner.map((entry) => entry.path));
      if (
        authoredAdmission(result, paths) === authoredAdmission(evidenced, paths) &&
        !result.unadmitted.some((entry) => paths.has(entry.path)) &&
        !result.unverified.findings.some((finding) => paths.has(finding.path) && finding.severity === 'error')
      ) {
        build = candidate;
        evidenced = result;
      }
    }
  }
  return rooted(build, evidenced);
}
function views(
  input: InputSnapshot,
  options: ViewOptions,
  metadata: RevisionSource,
  evidence: readonly RevisionSource[],
  /** D03a: the sources a join ran out of budget on, which an attempt before this one named (`withoutSources`). */
  past: ReadonlySet<string> = new Set(),
): (location?: string, phase?: Phase) => View {
  const inputSources = evidence.length === 0 ? input.sources : [...input.sources, ...evidence];
  /**
   * D03a: the entry of a source refused whole, for a bound, a budget or a throw. Whatever stage refused it, it stands in
   * the view as an empty file, so nothing it holds is admitted and every other source stays independent (D03), and its
   * bytes stay revision inputs. Its entry is the one the report names and D15 lists.
   */
  const refusal = (path: string, message: string): Finding => ({
    code: 'IA-DB-SOURCE-UNAVAILABLE',
    severity: 'error',
    path,
    line: 1,
    message,
  });
  const emptySource = (path: string, location: Source['location']): Source => ({
    ast: { kind: 'file', path, version: '', records: [], trivia: [] },
    diagnostics: [],
    location,
  });
  const pastBudget = (path: string): string => pastBound(path, `is past ${WORK_BOUNDS.view} units of work in all`);
  /** The sources refused before any context reads them, at parse: one past a bound, the budget, or whose parse throws. */
  const unparsed = new Map<string, Finding>();
  const budget = new WorkBudget(WORK_BOUNDS.view);
  /** What each source's parse spent, which it gives back if a later stage refuses it. */
  const parseSpend = new Map<string, number>();
  const parsedSource = (s: RevisionSource): Source => {
    // Sources at runtime placement are db's own, bounded where they are read; every other source spends the budget. A
    // walked source cannot be past `fileBytes`, but a draft, an editor buffer, a host's capture or an installed file can.
    const runtime = s.location.placement.band === 0;
    const refused = (message: string): Source => {
      unparsed.set(s.path, refusal(s.path, message));
      return emptySource(s.path, s.location);
    };
    if (!runtime && Buffer.byteLength(s.text) > SOURCE_BOUNDS.fileBytes)
      return refused(pastBound(s.path, `is over ${SOURCE_BOUNDS.fileBytes} bytes`));
    if (past.has(s.path)) return refused(pastBudget(s.path));
    const spent = budget.spent();
    try {
      const source = { ...parse(s.text, s.path, runtime ? undefined : budget), location: s.location };
      parseSpend.set(s.path, budget.spent() - spent);
      return source;
    } catch (error) {
      budget.restore(spent);
      return refused(
        error instanceof BudgetExceeded ? pastBudget(s.path) : `Cannot parse source ${s.path}: ${String(error)}`,
      );
    }
  };
  // What a workspace builds on is charged first, so that its own sources cannot refuse the floor beneath them, and
  // within a band the smallest, so that an exhausted budget refuses the largest sources, not a declaration behind them.
  const charging = [...inputSources.keys()].sort((a, b) => {
    const [first, second] = [inputSources[a]!, inputSources[b]!];
    return (
      first.location.placement.band - second.location.placement.band ||
      first.text.length - second.text.length ||
      compare(first.path, second.path)
    );
  });
  const parsed = new Array<Source>(inputSources.length);
  for (const index of charging) parsed[index] = parsedSource(inputSources[index]!);
  const chargeRank = new Map(charging.map((index, rank) => [inputSources[index]!.path, rank])),
    parsedAt = new Map(inputSources.map((s, index) => [s.path, index]));
  /** The captured text of each source by path, which `source` occurrences read their unparsed headers from. */
  const texts = new Map(inputSources.map((s) => [s.path, s.text]));
  const compiledNothing = { records: [], diagnostics: [], sourceMap: [] };
  /**
   * One registry for each vocabulary, shared by the contexts whose registries say the same, with the compile of each
   * source that read it: what they build of it again is let go.
   */
  const vocabularies = new Map<string, { registry: FrozenRegistry; compiled: Map<string, CompileResult> }>(),
    compiledOnce = new Set<string>();
  /**
   * D03a: the registry and compile of the sources a context sees. Contexts spend one budget, the root's first, so they
   * hold no more between them than one view may. A source that exhausts it while it is extracted or compiled, or whose
   * compile throws, is refused alone, as any other file refused whole: it gives back all it spent and no later context
   * reads it. What a context before this one compiled of it stays held, and stays spent. What compilation charged pays
   * for what the graph and the checks do with it (D03b).
   */
  const analyzed = (sources: readonly Source[]): Context => {
    const refused = new Map(unparsed);
    let given = 0;
    const refuse = (source: Source, message: string): void => {
      const path = source.ast.path,
        finding = refusal(path, message);
      refused.set(path, finding);
      unparsed.set(path, finding);
      parsed[parsedAt.get(path)!] = emptySource(path, source.location);
      if (compiledOnce.has(path)) return;
      const spend = parseSpend.get(path) ?? 0;
      budget.refund(spend);
      given += spend;
    };
    const rank = (index: number): number => chargeRank.get(sources[index]!.ast.path) ?? 0;
    // Extraction spends in the order parsing did, so that which source it refuses follows from the sources alone.
    const charged = [...sources.keys()].sort((a, b) => rank(a) - rank(b));
    const registered = buildRegistry(
      charged.map((index) => sources[index]!),
      budget,
      (source) => refuse(source, pastBudget(source.ast.path)),
    );
    const vocabulary =
      declaredReaches.length > 1 ? createHash('sha256').update(stableSerialize(registered.registry)).digest('hex') : '';
    const same = vocabularies.get(vocabulary) ?? { registry: frozen(registered.registry), compiled: new Map() };
    vocabularies.set(vocabulary, same);
    const results = new Array<CompileResult>(sources.length).fill(compiledNothing);
    const spendOf = (index: number): number => parseSpend.get(sources[index]!.ast.path) ?? 0;
    // Parsing spent on every source before any compiled. What runs out here is what they hold, so the sources of the
    // highest band that spent most go first, whichever stage they spent it in, as a workspace's own sources cannot refuse
    // what it builds on, and what is being compiled is refused only when none is left.
    const bandOf = (index: number): number => sources[index]!.location.placement.band,
      settled = new Set<number>(),
      spenders = [...sources.keys()].sort(
        (a, b) => bandOf(a) - bandOf(b) || spendOf(a) - spendOf(b) || rank(a) - rank(b),
      );
    budget.reclaiming(() => {
      for (let index = spenders.pop(); index !== undefined; index = spenders.pop()) {
        const source = sources[index]!,
          path = source.ast.path;
        if (settled.has(index) || refused.has(path) || compiledOnce.has(path) || source.location.placement.band === 0)
          continue;
        refuse(source, pastBudget(path));
        return true;
      }
      return false;
    });
    for (const index of charged) {
      const source = sources[index]!,
        path = source.ast.path;
      if (refused.has(path)) continue;
      settled.add(index);
      const known = same.compiled.get(path);
      if (known !== undefined) {
        results[index] = known;
        continue;
      }
      const spent = budget.spent(),
        givenBefore = given;
      try {
        const result = compile(
          source.ast,
          registered.registry,
          source.location,
          [],
          source.location.placement.band === 0 ? undefined : budget,
        );
        // Frozen, so that a graph can keep what it makes of each, however many passes and views load it.
        results[index] = { ...result, records: result.records.map(frozen) };
        same.compiled.set(path, results[index]!);
        compiledOnce.add(path);
      } catch (error) {
        budget.restore(spent - (given - givenBefore));
        refuse(
          source,
          error instanceof BudgetExceeded ? pastBudget(path) : `Cannot compile source ${path}: ${String(error)}`,
        );
      }
    }
    budget.reclaiming(undefined);
    const diagnostics = diagnosticsOf([
      ...registered.diagnostics.filter((d) => !refused.has(d.path)),
      ...results.flatMap((r) => r.diagnostics),
    ]);
    const errorPaths = new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.path));
    for (const path of refused.keys()) errorPaths.add(path);
    const compiled = results.flatMap((r) => r.records);
    return {
      sources: sources.map((s) => (refused.has(s.ast.path) ? emptySource(s.ast.path, s.location) : s)),
      registry: same.registry,
      records: compiled.filter((r) => !errorPaths.has(r.source.path)),
      compiled,
      diagnostics,
      errorPaths,
      refused,
      work: budget.spent(),
    };
  };
  /** Locations that see the same sources share one context: a reader cannot grow them by asking for more roots. */
  const contexts = new Map<string, Context>(),
    bySources = new Map<string, Context>();
  const analyze = (location: string): Context => {
    const known = contexts.get(location);
    if (known !== undefined) return known;
    const seen = parsed.map((s) => reaches(s.location.placement.reach, location));
    const key = seen.map((visible) => (visible ? '1' : '0')).join('');
    const context = bySources.get(key) ?? analyzed(parsed.filter((_, index) => seen[index]));
    bySources.set(key, context);
    contexts.set(location, context);
    return context;
  };
  const declaredReaches = [...new Set(['', ...inputSources.map((s) => s.location.placement.reach)])].sort(compare);
  if (declaredReaches.length > SOURCE_BOUNDS.reaches) {
    const past = declaredReaches[SOURCE_BOUNDS.reaches]!;
    throw overBound(
      inputSources.find((s) => s.location.placement.reach === past)!.path,
      `is past ${SOURCE_BOUNDS.reaches} reaches`,
    );
  }
  const requirements = new Map<string, { id: string; identity: string; path: string; line: number }>();
  /**
   * D03a: what to go without when a stage that reads every source together exhausts the budget, as none of them did alone:
   * sources that collide, which are refused whole either way, else those of the highest band that spent most, twice as
   * many as the attempt before, as a workspace's own sources cannot refuse what it builds on. Every attempt goes without more, so they end: 20,000 sources are doubled through in about sixteen.
   */
  const withoutSources = (): readonly string[] => {
    const first = new Map<string, string>(),
      colliding = new Set<string>();
    for (const { id, path } of requirements.values()) {
      const other = first.get(id);
      if (other === undefined) first.set(id, path);
      else colliding.add(other).add(path);
    }
    if (colliding.size > 0) return [...colliding];
    const spend = (path: string): number => parseSpend.get(path)!,
      band = (path: string): number => inputSources[parsedAt.get(path)!]!.location.placement.band;
    return [...parseSpend.keys()]
      .filter((path) => spend(path) > 0 && !unparsed.has(path))
      .sort((a, b) => band(a) - band(b) || spend(a) - spend(b) || chargeRank.get(a)! - chargeRank.get(b)!)
      .slice(-Math.max(past.size, 1));
  };
  let duplicates: ReturnType<typeof requirementCollisions>;
  try {
    // Registry visibility can change only at a declared reach. Inspect those
    // finite contexts before authority so bands cannot conceal duplicate REQ ids.
    for (const reach of declaredReaches) analyze(reach);
    for (const context of contexts.values())
      for (const record of context.records)
        for (const requirement of record.requirements) {
          const occurrence = {
            id: requirement.id,
            identity: record.identity,
            path: record.source.path,
            line: requirement.span.line,
          };
          requirements.set(JSON.stringify([occurrence.path, occurrence.line, occurrence.id]), occurrence);
        }
    duplicates = requirementCollisions([...requirements.values()], budget);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    const gone = new Set([...past, ...withoutSources()]);
    if (gone.size === past.size) throw error;
    return views(input, options, metadata, evidence, gone);
  }
  const duplicatePaths = new Set(duplicates.diagnostics.map((d) => d.path));
  // D03b: once every context is compiled a clean source keeps of its tree what admission reads again, the @system
  // records of its folder; a file refused whole keeps all of it for D15. Trees are most of what a capture holds.
  for (const context of bySources.values()) {
    const sources = context.sources as Source[];
    for (const [index, source] of sources.entries())
      if (!context.errorPaths.has(source.ast.path) && !duplicatePaths.has(source.ast.path))
        sources[index] = declarationsOf(source);
  }
  parsed.forEach((source, index) => {
    parsed[index] = emptySource(source.ast.path, source.location);
  });
  const revisionSources = frozen([...inputSources, metadata]),
    revisionInputs = { sources: revisionSources, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST },
    // D10: the graph's own revision inputs and the process's evidence, which compliance binds to each view's graph.
    conformance = options.conformance === 'verify' ? conformanceOf(revisionInputs) : undefined;
  // D02a: the capture declares roots once, by the @workspace records the root view admits, and every view seats its
  // records by them, so a narrower root or phase never re-roots an occurrence. D02b decides the repository's own
  // @workspace at the same moment, for every view's path seats.
  let declared: readonly DeclaredRoot[] | undefined, repository: string | undefined;
  const build = (requested = '', phase?: Phase): View => {
    const location = canonicalRoot(requested),
      context = analyze(location),
      registry = context.registry;
    // Independent-file compilation cannot decide external targets. Graph owns
    // those final findings; refused owners retain their primary source fault.
    const sourceDiagnostics = diagnosticsOf([
      ...context.diagnostics.filter((d) => d.code !== 'IA-LANG-EDGE-TARGET-MISSING'),
      ...duplicates.diagnostics,
    ]);
    const candidates = context.records.filter((r) => !duplicatePaths.has(r.source.path));
    const boundary = Object.freeze(candidates.map(occurrenceKey).sort(compare));
    const blocked = new Set(
      [...registry.systems.values()]
        .filter((s) => context.errorPaths.has(s.path) || duplicatePaths.has(s.path))
        .map((s) => s.name),
    );
    /** Every error diagnostic of each source file, in line order: what refuses a file whole. */
    const errorsOf = new Map<string, Diagnostic[]>();
    for (const list of [context.diagnostics, duplicates.diagnostics])
      for (const diagnostic of list) if (diagnostic.severity === 'error') listAt(errorsOf, diagnostic.path, diagnostic);
    for (const errors of errorsOf.values()) errors.sort((a, b) => a.line - b.line || compare(a.code, b.code));
    const fileErrors = (path: string): readonly Diagnostic[] => errorsOf.get(path) ?? [];
    /** The identity each header line of a source compiled to, by source. */
    const identitiesOf = new Map<string, Map<number, string>>();
    for (const record of context.compiled) {
      const identities = identitiesOf.get(record.source.path);
      if (identities === undefined)
        identitiesOf.set(record.source.path, new Map([[record.source.line, record.identity]]));
      else identities.set(record.source.line, record.identity);
    }
    /** The finding that blocked each blocked system, the first one recorded, which its records carry. */
    const blockedBy = new Map<string, UnadmittedFinding>();
    for (const system of registry.systems.values()) {
      const error = blocked.has(system.name) ? fileErrors(system.path)[0] : undefined;
      if (error !== undefined) blockedBy.set(system.name, findingOf(error));
    }
    /** Each blocked system's place in the order they were blocked, which is the order their causes are read in. */
    const blockOrder = new Map([...blocked].map((name, index) => [name, index]));
    /** The source of the last refusal admission made, which a stop past its bound names. */
    let lastRefused: string | undefined;
    const block = (name: string, finding: UnadmittedFinding | undefined): void => {
      if (!blockOrder.has(name)) blockOrder.set(name, blockOrder.size);
      blocked.add(name);
      if (finding !== undefined) lastRefused = finding.path;
      if (finding !== undefined && !blockedBy.has(name)) blockedBy.set(name, finding);
    };
    const blockedFolders = new Set<string>(),
      excluded = new Map<string, RefusedRecord>(),
      /** The occurrence behind each `excluded` entry, by the same key, and the finding that excluded it. */
      excludedRecords = new Map<string, { readonly record: CompiledRecord; readonly finding: UnadmittedFinding }>(),
      observations: Assessment[] = [];
    for (const source of context.sources) {
      const finding = context.refused.get(source.ast.path);
      if (finding !== undefined)
        observations.push({ check: 'COMP-PARSE', scope: source.ast.path, outcome: 'fail', findings: [finding] });
    }
    const members = new Map<string, Source[]>();
    for (const source of context.sources) {
      const name = systemMember(source.ast.path)?.name;
      if (name !== undefined) listAt(members, name, source);
    }
    const inputMembers = new Set(inputSources.flatMap((s) => systemMember(s.path)?.name ?? []));
    const declarations = new Map<string, CompiledRecord[]>();
    for (const record of candidates) if (record.discriminator === 'system') listAt(declarations, record.name, record);
    const folders: SystemFolder[] = input.folders.flatMap((name) => {
      let sources: readonly Source[] = members.get(name) ?? [];
      const declaring = declarations.get(name) ?? [];
      const authored = declaring.find((r) => r.source.path === `.ia/src/systems/${name}/system.ia`);
      const installed = declaring.find((r) => r.source.path.startsWith('.ia/distributions/store/'));
      if (authored && installed) {
        const value = (r: CompiledRecord, key: string): string | undefined => {
          const field = r.head.find((f) => f.key === key);
          return field && 'text' in field.value ? field.value.text : undefined;
        };
        if (['provider', 'version'].some((key) => value(authored, key) !== value(installed, key)))
          throw new InstallationError('conflict', `Authored ${name} differs from its locked provider/version`);
        // The authored declaration is intentional band-100 authority. Installed
        // records still participate in admission and whole-tree requirement checks.
        sources = sources.filter((s) => s.ast.path !== installed.source.path);
      }
      const path = systemMember(registry.systems.get(name)?.path ?? '')?.root ?? `.ia/src/systems/${name}`;
      const roots = [...new Set(sources.map((s) => systemMember(s.ast.path)!.root))];
      return sources.length === 0 && inputMembers.has(name) ? [] : [{ name, path, roots, sources, records: [] }];
    });
    /** The systems declared under each system folder, in registry order. */
    const systemsAt = new Map<string, string[]>();
    for (const system of registry.systems.values()) {
      const root = systemMember(system.path)?.root;
      if (root !== undefined) listAt(systemsAt, root, system.name);
    }
    const folderAt = new Map<string, SystemFolder>(),
      folderRoots = new Map<string, string>();
    for (const folder of folders) {
      if (!folderAt.has(folder.path)) folderAt.set(folder.path, folder);
      folderRoots.set(folder.name, folder.path);
    }
    /** What first blocked a folder: the folder's own system or one declared under it, whichever was blocked first. */
    const folderFinding = (folder: string | undefined): UnadmittedFinding | undefined => {
      if (folder === undefined) return undefined;
      const root = folderRoots.get(folder);
      let first: UnadmittedFinding | undefined,
        order = Number.POSITIVE_INFINITY;
      for (const name of [folder, ...(root === undefined ? [] : (systemsAt.get(root) ?? []))]) {
        const finding = blockedBy.get(name),
          place = blockOrder.get(name);
        if (finding !== undefined && place !== undefined && place < order) {
          first = finding;
          order = place;
        }
      }
      return first;
    };
    const blockDependents = (): void => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const system of registry.systems.values()) {
          const requirement = system.requires.find((r) => blocked.has(r.name));
          if (!blocked.has(system.name) && requirement !== undefined) {
            block(system.name, blockedBy.get(requirement.name));
            changed = true;
          }
        }
      }
      const blockedRoots = new Set<string>();
      for (const name of blocked) {
        const root = systemMember(registry.systems.get(name)?.path ?? '')?.root;
        if (root !== undefined) blockedRoots.add(root);
      }
      for (const folder of folders)
        if (blocked.has(folder.name) || blockedRoots.has(folder.path)) blockedFolders.add(folder.path);
    };
    /**
     * The finding that blocked a record's system join: its system's, a system it declares, or one of its blocked folder.
     * Every block records the finding that caused it (a file error, a system check, a dependency's), so one is found;
     * the unreachable remainder falls back to its system file's first error, then to any error admission recorded.
     */
    const joinFinding = (record: CompiledRecord): UnadmittedFinding => {
      const folder = systemMember(record.source.path)?.name;
      const found =
        blockedBy.get(record.system) ??
        (record.discriminator === 'system' ? blockedBy.get(record.name) : undefined) ??
        folderFinding(folder);
      if (found !== undefined) return found;
      const error =
        fileErrors(registry.systems.get(record.system)?.path ?? record.source.path)[0] ??
        [...sourceDiagnostics, ...observations.flatMap((o) => o.findings)].find((d) => d.severity === 'error');
      return error === undefined
        ? findingOf({
            code: 'IA-COMP-SYSTEM-MALFORMED',
            ...record.source,
            message: `${record.identity}: system join refused`,
          })
        : findingOf(error);
    };
    /** What excluded the first occurrence of each identity of a source, which encloses its nested records. */
    const enclosingFindings = new Map<string, UnadmittedFinding>();
    const enclosingKey = (path: string, identity: string): string => JSON.stringify([path, identity]);
    const exclude = (record: CompiledRecord, reason: string, finding: UnadmittedFinding): void => {
      lastRefused = record.source.path;
      const enclosing = enclosingKey(record.source.path, record.identity);
      if (!enclosingFindings.has(enclosing)) enclosingFindings.set(enclosing, finding);
      excluded.set(occurrenceKey(record), {
        identity: record.identity,
        path: record.source.path,
        line: record.source.line,
        reason,
      });
      if (!excludedRecords.has(occurrenceKey(record))) excludedRecords.set(occurrenceKey(record), { record, finding });
    };
    const remaining = (): readonly CompiledRecord[] => {
      blockDependents();
      const blockedNames = new Set([...blockedFolders].map((path) => path.split('/').at(-1)));
      for (const record of candidates)
        if (
          blocked.has(record.system) ||
          (record.discriminator === 'system' && blocked.has(record.name)) ||
          blockedNames.has(systemMember(record.source.path)?.name)
        )
          exclude(
            record,
            'system join refused',
            excludedRecords.get(occurrenceKey(record))?.finding ?? joinFinding(record),
          );
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of candidates) {
          if (excluded.has(occurrenceKey(record)) || record.parent === undefined) continue;
          const enclosing = enclosingFindings.get(enclosingKey(record.source.path, record.parent));
          if (enclosing !== undefined) {
            exclude(record, 'enclosing record refused', enclosing);
            changed = true;
          }
        }
      }
      return candidates.filter((r) => !excluded.has(occurrenceKey(r)));
    };
    const graphOf = (records: readonly CompiledRecord[]) =>
      load(records, registry, {
        ...revisionInputs,
        location,
        ...(phase === undefined ? {} : { phase }),
      });
    let graph: Graph,
      admissionWork = 0,
      unsettled: Finding | undefined;
    for (;;) {
      graph = graphOf(remaining());
      const before = excluded.size + blocked.size + blockedFolders.size,
        nodes = [...graph.nodes.values()];
      const nodesOf = new Map<string, typeof nodes>(),
        nodeAt = new Map<string, (typeof nodes)[number]>();
      for (const node of nodes) {
        const name = systemMember(node.source.path)?.name,
          at = JSON.stringify([node.source.path, node.source.line]);
        if (!nodeAt.has(at)) nodeAt.set(at, node);
        if (name !== undefined) listAt(nodesOf, name, node);
      }
      const currentFolders = folders
        .filter((f) => !blockedFolders.has(f.path))
        .map((f) => ({ ...f, records: nodesOf.get(f.name) ?? [] }));
      const systems = validateSystems(currentFolders, registry, nodes);
      for (const assessment of systems) {
        if (assessment.outcome !== 'pass') observations.push(assessment);
        for (const finding of assessment.findings.filter((f) => f.severity === 'error')) {
          if (finding.code === 'IA-COMP-SYSTEM-MALFORMED' || finding.code === 'IA-COMP-STEWARD-MISSING') {
            const folder = folderAt.get(assessment.scope);
            if (folder !== undefined) {
              blockedFolders.add(folder.path);
              block(folder.name, findingOf(finding));
              for (const name of systemsAt.get(folder.path) ?? []) block(name, findingOf(finding));
            }
          } else {
            const record = nodeAt.get(JSON.stringify([finding.path, finding.line]));
            if (record !== undefined) exclude(record, finding.code, findingOf(finding));
            if (finding.code === 'IA-COMP-SCHEMA-MULTIPLE' && record !== undefined)
              for (const registration of registry.registrations.values())
                if (registration.schema === record.name) block(registration.system, findingOf(finding));
          }
        }
      }
      const consent = validateConsent(graph);
      if (consent.outcome === 'fail') observations.push(consent);
      for (const node of nodes) {
        const assessments = [
          validateGraphSchema(node, graph),
          validateSelectors(node),
          validateVariants(node),
          ...(node.discriminator === 'check'
            ? [options.checks === 'structural' ? validateCheckStructure(node) : validateCheck(node)]
            : []),
        ];
        for (const assessment of assessments)
          if (assessment.outcome !== 'pass') {
            observations.push(assessment);
            // The record's own finding is the assessment's first error, else its first finding; an assessment left
            // not-evaluated with none (compliance `assess` with `unavailable`) is IA-COMP-NOT-EVALUATED, as it reads.
            const [first] = assessment.findings,
              own = assessment.findings.find((f) => f.severity === 'error') ?? first;
            exclude(
              node,
              first?.code ?? `${assessment.check} unavailable`,
              findingOf(
                own ?? {
                  code: 'IA-COMP-NOT-EVALUATED',
                  ...node.source,
                  message: `${node.identity}: ${assessment.check} unavailable`,
                },
              ),
            );
          }
      }
      const diagnosticsAt = new Map<string, GraphDiagnostic[]>();
      for (const diagnostic of graph.diagnostics) listAt(diagnosticsAt, diagnostic.path, diagnostic);
      for (const occurrence of graph.occurrences)
        if (occurrence.status === 'refused') {
          const { path, line, endLine } = occurrence.node.source,
            atPath = diagnosticsAt.get(path) ?? [],
            findings: GraphDiagnostic[] = [];
          for (let at = firstAt(atPath, line); at < atPath.length && atPath[at]!.line <= endLine; at++)
            findings.push(atPath[at]!);
          observations.push({ check: 'COMP-SCHEMA', scope: occurrence.node.identity, outcome: 'fail', findings });
          // Graph refuses an occurrence for the dimension diagnostics of its own head, so the first is in its lines.
          const [first] = findings;
          exclude(
            occurrence.node,
            'invalid graph dimensions',
            findingOf(
              first ?? {
                code: 'IA-GRAPH-DIMENSION-UNKNOWN',
                ...occurrence.node.source,
                message: 'invalid graph dimensions',
              },
            ),
          );
        }
      if (before === excluded.size + blocked.size + blockedFolders.size) break;
      // D03b: each pass rebuilds the graph, so a chain of refusals costs its length times the view. Past what admission
      // may spend it stops where it stands: what depends on the last refusals stays unjudged, and is not called judged.
      admissionWork += context.work;
      if (admissionWork > WORK_BOUNDS.admission) {
        // A pass that changed anything refused a record or blocked a system for a named cause.
        const path = lastRefused ?? '.ia/src';
        unsettled = refusal(path, pastBound(path, `is past ${WORK_BOUNDS.admission} units of admission in all`));
        observations.push({ check: 'COMP-PARSE', scope: path, outcome: 'fail', findings: [unsettled] });
        graph = graphOf(remaining());
        break;
      }
    }
    if (location === '' && phase === undefined) {
      if (declared === undefined) {
        declared = declaredRoots(graph);
        repository = repositoryWorkspace(graph, declared);
      }
    } else if (declared === undefined) build();
    const evaluated = {
        sourceDiagnostics,
        folders: folders.filter((f) => !blockedFolders.has(f.path)),
        admission: observations,
        ...(options.checks === 'structural' ? { checks: 'structural' as const } : {}),
      },
      unverified = evaluate(graph, evaluated),
      // D10a: the verified report is evaluated beside the unverified one, which D14 evidence is admitted from.
      report = conformance === undefined ? unverified : evaluate(graph, { ...evaluated, conformance });
    const occurrence = (record: CompiledRecord, finding: UnadmittedFinding): UnadmittedRecord => ({
      identity: record.identity,
      word: record.discriminator,
      name: record.name,
      band: record.placement.band,
      path: record.source.path,
      line: record.source.line,
      endLine: record.source.endLine,
      finding,
    });
    /** Each IA-GRAPH-IDENTITY-TIE by the header it is reported at. */
    const ties = new Map<string, GraphDiagnostic>();
    for (const diagnostic of graph.diagnostics) {
      const key = `${diagnostic.line} ${diagnostic.path}`;
      if (diagnostic.code === 'IA-GRAPH-IDENTITY-TIE' && !ties.has(key)) ties.set(key, diagnostic);
    }
    /** An occurrence's own IA-GRAPH-IDENTITY-TIE, which graph reports at each tied occurrence's header. */
    const tie = (node: CompiledRecord): UnadmittedFinding =>
      findingOf(
        ties.get(`${node.source.line} ${node.source.path}`) ?? {
          code: 'IA-GRAPH-IDENTITY-TIE',
          ...node.source,
          message: `${node.identity} ties`,
        },
      );
    const unadmitted: readonly UnadmittedRecord[] = [
      ...[...excludedRecords.values()].map(({ record, finding }) => occurrence(record, finding)),
      ...graph.occurrences.filter((o) => o.status === 'tied').map((o) => occurrence(o.node, tie(o.node))),
      // Whatever the path declares, a reader that gates on a word counts this as possibly that word (D15).
      ...(unsettled === undefined
        ? []
        : [{ band: 100 as const, path: unsettled.path, line: 1, endLine: 1, finding: findingOf(unsettled) }]),
      ...context.sources
        .filter((s) => context.errorPaths.has(s.ast.path) || duplicatePaths.has(s.ast.path))
        .flatMap((s): readonly UnadmittedRecord[] => {
          const path = s.ast.path,
            finding = context.refused.get(path);
          // D03a: nothing of it was read as source, so db cannot say what it declares.
          if (finding !== undefined)
            return [{ band: s.location.placement.band, path, line: 1, endLine: 1, finding: findingOf(finding) }];
          // One past what the listing holds of a file, which is what tells `capped` there is more.
          const limit = OCCURRENCE_BOUNDS.file + 1;
          return refusedWhole(
            s,
            texts.get(path) ?? '',
            identitiesOf.get(path) ?? new Map(),
            registry,
            fileErrors(path),
            limit,
          );
        }),
    ];
    return Object.freeze({
      graph,
      // Over the inputs and registry the graph's revision hashes, so the two differ only by runtime-placed sources.
      authoredRevision: authoredRevisionOf(registry, revisionInputs, [metadata.path]),
      report,
      unverified,
      boundary,
      unparsed: new Set(context.refused.keys()),
      work: context.work,
      refused: Object.freeze(
        [...excluded.values()].sort((a, b) => compare(a.path, b.path) || a.line - b.line).map((r) => Object.freeze(r)),
      ),
      unadmitted: Object.freeze(
        capped(
          [...unadmitted].sort(
            (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.word ?? '', b.word ?? ''),
          ),
        ).map((entry) => Object.freeze(entry)),
      ),
      admittedSystems: Object.freeze(registry.order.filter((name) => !blocked.has(name))),
      blockedSystems: Object.freeze([...blocked].sort(compare)),
      membership: membershipOf([...graph.nodes.values()], declared!),
      declared: declared!,
      ...(repository === undefined ? {} : { repository }),
    });
  };
  return build;
}
