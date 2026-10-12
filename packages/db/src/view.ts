import {
  KERNEL_DIGEST,
  LANGUAGE_VERSION,
  buildRegistry,
  compile,
  identityOf,
  parse,
  requirementCollisions,
} from '@inventarch/language';
import type { Band, CompiledRecord, Diagnostic, FrozenRegistry, Phase, RecordNode, Source } from '@inventarch/language';
import { authoredRevisionOf, canonicalRoot, load, reaches, stableSerialize } from '@inventarch/graph';
import type { Graph, RevisionSource } from '@inventarch/graph';
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
import type { Assessment, Report, SystemFolder } from '@inventarch/compliance';
import type { InputSnapshot } from './inputs.js';
import { EVIDENCE_DIRECTORY, evidenceSource, systemMember } from './inputs.js';
import { bindChecks } from './checks.js';
import { reproducesEvidence } from './evidence.js';
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
 * One record occurrence of a view's sources that the view does not admit (lane D, D1), with the band of the placement
 * its source was read at, which is where capture membership and every band test read a record's band from, and its own
 * admission finding:
 * - an occurrence `refused` names (a compliance exclusion, a schema failure, a refused system join or a refused
 *   enclosing record), with the finding that excluded it: the assessment's or system check's own, the enclosing
 *   record's, or for a refused system join the finding that blocked its system;
 * - an occurrence of an identity that another occurrence ties at the same band, with its IA-GRAPH-IDENTITY-TIE;
 * - a record a file declares when the file is refused whole, by a language error or by a requirement id another
 *   occurrence declares too, before any graph is built, with the error inside its lines, else the file's first error,
 *   which refused the file. Each header the view's own parse of the file reads is one, with the identity the compile of
 *   the file gives the record or, where the compile refused it, the identity spec 3.1 gives its header under its word's
 *   registration. The file's captured text, split at every line terminator (CRLF, CR or LF), adds three readings the
 *   parse cannot give (review findings D-R3, D2-R2 and D2-N2): a line that opens with `@<word>` after any whitespace or
 *   Unicode format characters (a no-break space, a form feed, a zero-width space, a byte-order mark) and is no header
 *   the parse read is one, wherever it stands, inside a parsed record too, with the name token after it and no
 *   identity; on a line no parsed record spans, each `@<word>` token anywhere on it is one, with no name, so a file
 *   whose parse reads no record (no or another pragma) lists every word it mentions; and a line the first reading
 *   names no header on is one with no word, a record db cannot identify, when it holds one of the file's errors and no
 *   parsed record spans it, when an at sign opens it wherever it stands, or, in a file refused at its pragma, when it
 *   stands at column 0 and is neither blank nor a comment (`refusedWhole`; review D2-R2 and its recheck F1, F2). The
 *   readings err towards listing: a non-header line so spelled in a file already refused is listed under its word, an
 *   error or at-sign line that declares nothing with no word. An error inside a parsed record's lines, on a line no at
 *   sign opens, is that record's alone.
 */
export interface UnadmittedRecord {
  /**
   * The canonical identity, when the view compiled the record or spec 3.1 names its parsed header; absent for a header
   * only the source text shows, or whose word no admitted system registers.
   */
  readonly identity?: string;
  /**
   * The word the header names, lowercased; absent for an error line of a file refused whole that no record db can
   * identify accounts for (review D2-R2), which may declare a record of any word.
   */
  readonly word?: string;
  /**
   * The record's name as its header spells it, lowercased (lane D, D9: what a typed reference to it is matched by); absent
   * for a header that spells none and for a token read past the start of a line.
   */
  readonly name?: string;
  readonly band: Band;
  readonly path: string;
  /** The header line. */
  readonly line: number;
  readonly endLine: number;
  /** The admission finding that refused it (review finding D-N5). */
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
}
export const occurrenceKey = (record: CompiledRecord): string =>
  JSON.stringify([record.identity, record.source.path, record.source.line]);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
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
 * one is there: the header syntax, read from text the parse could not read (review finding D-R3).
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
 * U+FE6B (review D2 recheck F1).
 */
const AT = /^[\s\p{Cf}]*[@\uFF20\uFE6B]/u;
/** A line at column 0, which no whitespace opens. */
const TOP = /^\S/u;
/** The codes of a file refused at its pragma, past which its parse reports nothing (review D2 recheck F1). */
const PRAGMA = new Set(['IA-LANG-PRAGMA-MISSING', 'IA-LANG-VERSION-UNSUPPORTED']);
/**
 * The occurrences of a file a view refuses whole (`UnadmittedRecord`): every header its parse reads, nested ones
 * included, with the identity its compile gives that header's record or, for one its compile refused, the identity spec
 * 3.1 gives it (`identityOf` over its word's registration), then every other line of `text` that opens with a header,
 * under its word and name, every `@<word>` token on a line no parsed record spans, under its word, and, under no word,
 * every line no header reading names that may declare a record db cannot identify (review D2-R2 and its recheck F1, F2):
 * an error's (for one at a blank or comment line, the first line from there that is neither) that no parsed record
 * spans, one an at sign opens, and in a file refused at its pragma one at column 0 that is neither blank nor a comment.
 * Each carries the error inside its lines, else `errors[0]`, the file's first error.
 */
function refusedWhole(
  source: Source,
  text: string,
  compiled: readonly CompiledRecord[],
  registry: FrozenRegistry,
  errors: readonly Diagnostic[],
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
  const identities = new Map(
    compiled.filter((record) => record.source.path === path).map((record) => [record.source.line, record.identity]),
  );
  const finding = (line: number, endLine: number): UnadmittedFinding =>
    findingOf(errors.find((error) => error.line >= line && error.line <= endLine) ?? errors[0]!);
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
  const parsed = nodes.map((node): UnadmittedRecord => {
    const registration = registry.registrations.get(node.discriminator);
    const identity =
      identities.get(node.span.line) ??
      (registration === undefined ? undefined : identityOf(node, registration, path).identity?.identity);
    return {
      ...(identity === undefined ? {} : { identity }),
      ...occurrence(node.discriminator, node.name, node.span.line, node.span.endLine),
    };
  });
  const headers = new Set(nodes.map((node) => node.span.line)),
    // A record's lines are those of a header the parse read, to the end of its structure (its syntax span, refused
    // trailing lines included); the span of a header the parse refused identifies no record, so it spans nothing.
    spans = [
      ...nodes.map((node) => node.span),
      ...(source.ast.syntaxRecordSpans ?? []).filter((span) => headers.has(span.line)),
    ];
  const spanned = (line: number): boolean => spans.some((span) => line >= span.line && line <= span.endLine);
  const lines = text.split(/\r\n|\r|\n/),
    named = new Set<number>();
  const unread = lines.flatMap((spelled, index): UnadmittedRecord[] => {
    const line = index + 1,
      header = HEADER.exec(spelled);
    if (header !== null) {
      named.add(line);
      return headers.has(line) ? [] : [occurrence(header[1]!, header[2], line, line)];
    }
    return spanned(line)
      ? []
      : [...spelled.matchAll(TOKEN)].map((token) => occurrence(token[1]!, undefined, line, line));
  });
  // Review D2-R2: a line no header reading names that may declare a record db cannot identify, of any word, is listed
  // with none. (1) An error at a line no parsed record spans; an error inside an identified record is that record's.
  // An error at a blank or comment line, or past the text, as a missing pragma in an empty or comment-only file is, is
  // taken at the first line from there that is neither (review D2 recheck F2), and at none when there is none. (2) A
  // line opening with an at sign, wherever it stands, inside a parsed record's lines too (F1 b). (3) In a file refused at
  // its pragma, whose parse reports nothing past it, every top-level line that is neither blank nor a comment (F1 a).
  const declares = (spelled: string): boolean => !BLANK.test(spelled) && !COMMENT.test(spelled);
  const declaring = (line: number): number | undefined => {
    for (let at = Math.max(line, 1); at <= lines.length; at++) if (declares(lines[at - 1]!)) return at;
    return undefined;
  };
  const atPragma = errors.some((error) => PRAGMA.has(error.code));
  const suspect = new Set<number>();
  for (const error of errors) {
    const line = declaring(error.line);
    if (line !== undefined && !spanned(line)) suspect.add(line);
  }
  lines.forEach((spelled, index) => {
    if (AT.test(spelled) || (atPragma && TOP.test(spelled) && declares(spelled))) suspect.add(index + 1);
  });
  const unknown = [...suspect]
    .filter((line) => !named.has(line))
    .map((line) => occurrence(undefined, undefined, line, line));
  return [...parsed, ...unread, ...unknown];
}
function diagnosticsOf(values: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...new Map(values.map((d) => [stableSerialize(d), d])).values()].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code),
  );
}
/** How a view admits: every existing reader takes the defaults. */
export interface ViewOptions {
  /**
   * D13 (plan amendments C15 and C21): `strict`, the default, admits a `@check` only when its runner is a built-in id
   * (compliance validateCheck), so an unknown runner is IA-COMP-CHECK-UNKNOWN and the record is not admitted, as every
   * released reader has it; `structural` admits any check that names one evaluator (validateCheckStructure), for the
   * validate path that binds checks against a host's catalog.
   */
  readonly checks?: 'strict' | 'structural';
}
/**
 * D14, review findings B3-R4 and B4-RC1: the evidence file at `source` when it is exactly what the writer makes for the
 * checks `root` admits (`reproducesEvidence`): their bindings derived again from `root`'s own records and report, the
 * times taken from the file itself. A forged verdict, reason or record, an observation for a check not evaluated, a
 * relationship, another locator or revision, any byte the writer would not write, and anything written for another view,
 * is not evidence. Only built-in evaluators produce evidence, so no catalog takes part.
 */
function writerEvidence(source: RevisionSource, root: View): RevisionSource | undefined {
  // Review finding F1: the validate request records nothing for a refused admission, so no file is evidence for one.
  if (root.report.findings.some((finding) => finding.severity === 'error')) return undefined;
  const records = [...root.graph.nodes.values()];
  return reproducesEvidence({
    authoredRevision: root.authoredRevision,
    bindings: bindChecks(records, root.report, { status: 'unavailable', reason: 'no catalog takes part' }),
    records,
    text: source.text,
  })
    ? source
    : undefined;
}
/** What `view` admits of everything but the evidence at `path`: its findings, verdicts and refusals, revisions aside. */
function authoredAdmission(view: View, path: string): string {
  const evidence = new Set(
    [...view.graph.nodes.values()].filter((node) => node.source.path === path).map((node) => node.identity),
  );
  return stableSerialize({
    findings: view.report.findings.filter((finding) => finding.path !== path),
    verdicts: view.report.verdicts
      .filter((verdict) => !evidence.has(verdict.scope))
      .map((verdict) => ({
        check: verdict.check,
        scope: verdict.scope,
        outcome: verdict.outcome,
        findings: verdict.findings.filter((finding) => finding.path !== path),
      })),
    refused: view.refused.filter((record) => record.path !== path),
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
 * one file named after its authored revision, and no other, is then read (review finding B3-N10) and admitted only when
 * it is exactly the file the writer makes for that view's checks (`writerEvidence`, B3-R4, B4-RC1) and adding it changes
 * nothing the authored records admit: their findings, verdicts, refusals and records stay as they were.
 * Otherwise the authored view stands, as for a file that is not evidence. Evidence moves `revision`, never
 * `authoredRevision`, and is never what a validation binds or reports admission from.
 */
export function viewBuilder(
  input: InputSnapshot,
  options: ViewOptions = {},
): (location?: string, phase?: Phase) => View {
  const metadata = metadataOf(input),
    authored = views(input, options, metadata, undefined);
  if (input.evidence === undefined || input.evidence.length === 0) return authored;
  const root = authored(),
    rooted =
      (build: typeof authored, view: View): typeof authored =>
      (location, phase) =>
        location === undefined && phase === undefined ? view : build(location, phase);
  const wanted = `${EVIDENCE_DIRECTORY}/${root.authoredRevision}.ia`;
  const listed = input.evidence.find((candidate) => candidate.path === wanted),
    read = listed === undefined ? undefined : evidenceSource(input.root, listed.path),
    source = read === undefined ? undefined : writerEvidence(read, root);
  if (source === undefined) return rooted(authored, root);
  const build = views(input, options, metadata, source),
    evidenced = build();
  return authoredAdmission(evidenced, source.path) === authoredAdmission(root, source.path)
    ? rooted(build, evidenced)
    : rooted(authored, root);
}
function views(
  input: InputSnapshot,
  options: ViewOptions,
  metadata: RevisionSource,
  evidence: RevisionSource | undefined,
): (location?: string, phase?: Phase) => View {
  const inputSources = evidence === undefined ? input.sources : [...input.sources, evidence];
  const parsed = inputSources.map((s) => ({ ...parse(s.text, s.path), location: s.location }));
  /** The captured text of each source by path, which `source` occurrences read their unparsed headers from. */
  const texts = new Map(inputSources.map((s) => [s.path, s.text]));
  const contexts = new Map<string, Context>();
  const analyze = (location: string): Context => {
    const known = contexts.get(location);
    if (known !== undefined) return known;
    const sources = parsed.filter((s) => reaches(s.location.placement.reach, location));
    const registered = buildRegistry(sources),
      results = sources.map((s) => compile(s.ast, registered.registry, s.location, []));
    const diagnostics = diagnosticsOf([...registered.diagnostics, ...results.flatMap((r) => r.diagnostics)]);
    const errorPaths = new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.path));
    const compiled = results.flatMap((r) => r.records);
    const context = {
      sources,
      registry: registered.registry,
      records: compiled.filter((r) => !errorPaths.has(r.source.path)),
      compiled,
      diagnostics,
      errorPaths,
    };
    contexts.set(location, context);
    return context;
  };
  // Registry visibility can change only at a declared reach. Inspect those
  // finite contexts before authority so bands cannot conceal duplicate REQ ids.
  for (const reach of [...new Set(['', ...inputSources.map((s) => s.location.placement.reach)])].sort(compare))
    analyze(reach);
  const requirements = new Map<string, { id: string; identity: string; path: string; line: number }>();
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
  const duplicates = requirementCollisions([...requirements.values()]);
  const duplicatePaths = new Set(duplicates.diagnostics.map((d) => d.path));
  const revisionSources = [...inputSources, metadata],
    revisionInputs = { sources: revisionSources, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST };
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
    /** Every error diagnostic of a source file, in line order: what refuses a file whole. */
    const fileErrors = (path: string): readonly Diagnostic[] =>
      [...context.diagnostics, ...duplicates.diagnostics]
        .filter((d) => d.severity === 'error' && d.path === path)
        .sort((a, b) => a.line - b.line || compare(a.code, b.code));
    /** Review D-N5: the finding that blocked each blocked system, the first one recorded, which its records carry. */
    const blockedBy = new Map<string, UnadmittedFinding>();
    for (const system of registry.systems.values()) {
      const error = blocked.has(system.name) ? fileErrors(system.path)[0] : undefined;
      if (error !== undefined) blockedBy.set(system.name, findingOf(error));
    }
    const block = (name: string, finding: UnadmittedFinding | undefined): void => {
      blocked.add(name);
      if (finding !== undefined && !blockedBy.has(name)) blockedBy.set(name, finding);
    };
    const blockedFolders = new Set<string>(),
      excluded = new Map<string, RefusedRecord>(),
      /** The occurrence behind each `excluded` entry, by the same key, and the finding that excluded it. */
      excludedRecords = new Map<string, { readonly record: CompiledRecord; readonly finding: UnadmittedFinding }>(),
      observations: Assessment[] = [];
    const folders: SystemFolder[] = input.folders.flatMap((name) => {
      let sources = context.sources.filter((s) => systemMember(s.ast.path)?.name === name);
      const authored = candidates.find(
        (r) => r.discriminator === 'system' && r.name === name && r.source.path === `.ia/src/systems/${name}/system.ia`,
      );
      const installed = candidates.find(
        (r) => r.discriminator === 'system' && r.name === name && r.source.path.startsWith('.ia/distributions/store/'),
      );
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
      return sources.length === 0 && inputSources.some((s) => systemMember(s.path)?.name === name)
        ? []
        : [{ name, path, roots, sources, records: [] }];
    });
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
      for (const folder of folders)
        if (
          [...blocked].some(
            (name) => name === folder.name || registry.systems.get(name)?.path.startsWith(folder.path + '/'),
          )
        )
          blockedFolders.add(folder.path);
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
        [...blocked]
          .filter((name) => {
            const path = folders.find((f) => f.name === folder)?.path;
            return name === folder || (path !== undefined && registry.systems.get(name)?.path.startsWith(path + '/'));
          })
          .map((name) => blockedBy.get(name))
          .find((finding) => finding !== undefined);
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
    const exclude = (record: CompiledRecord, reason: string, finding: UnadmittedFinding): void => {
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
      for (const record of candidates)
        if (
          blocked.has(record.system) ||
          (record.discriminator === 'system' && blocked.has(record.name)) ||
          [...blockedFolders].some((path) => systemMember(record.source.path)?.name === path.split('/').at(-1))
        )
          exclude(record, 'system join refused', joinFinding(record));
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of candidates) {
          if (excluded.has(occurrenceKey(record)) || record.parent === undefined) continue;
          const enclosing = [...excludedRecords.values()].find(
            (entry) => entry.record.source.path === record.source.path && entry.record.identity === record.parent,
          );
          if (enclosing !== undefined) {
            exclude(record, 'enclosing record refused', enclosing.finding);
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
    let graph: Graph;
    for (;;) {
      graph = graphOf(remaining());
      const before = excluded.size + blocked.size + blockedFolders.size,
        nodes = [...graph.nodes.values()];
      const currentFolders = folders
        .filter((f) => !blockedFolders.has(f.path))
        .map((f) => ({ ...f, records: nodes.filter((r) => systemMember(r.source.path)?.name === f.name) }));
      const systems = validateSystems(currentFolders, registry, nodes);
      for (const assessment of systems) {
        if (assessment.outcome !== 'pass') observations.push(assessment);
        for (const finding of assessment.findings.filter((f) => f.severity === 'error')) {
          if (finding.code === 'IA-COMP-SYSTEM-MALFORMED' || finding.code === 'IA-COMP-STEWARD-MISSING') {
            const folder = folders.find((f) => f.path === assessment.scope);
            if (folder !== undefined) {
              blockedFolders.add(folder.path);
              block(folder.name, findingOf(finding));
              for (const system of registry.systems.values())
                if (system.path.startsWith(folder.path + '/')) block(system.name, findingOf(finding));
            }
          } else {
            const record = nodes.find((r) => r.source.path === finding.path && r.source.line === finding.line);
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
      for (const occurrence of graph.occurrences)
        if (occurrence.status === 'refused') {
          const findings = graph.diagnostics.filter(
            (d) =>
              d.path === occurrence.node.source.path &&
              d.line >= occurrence.node.source.line &&
              d.line <= occurrence.node.source.endLine,
          );
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
    }
    if (location === '' && phase === undefined) {
      if (declared === undefined) {
        declared = declaredRoots(graph);
        repository = repositoryWorkspace(graph, declared);
      }
    } else if (declared === undefined) build();
    const report = evaluate(graph, {
      sourceDiagnostics,
      folders: folders.filter((f) => !blockedFolders.has(f.path)),
      admission: observations,
      ...(options.checks === 'structural' ? { checks: 'structural' as const } : {}),
    });
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
    /** An occurrence's own IA-GRAPH-IDENTITY-TIE, which graph reports at each tied occurrence's header. */
    const tie = (node: CompiledRecord): UnadmittedFinding =>
      findingOf(
        graph.diagnostics.find(
          (d) => d.code === 'IA-GRAPH-IDENTITY-TIE' && d.path === node.source.path && d.line === node.source.line,
        ) ?? { code: 'IA-GRAPH-IDENTITY-TIE', ...node.source, message: `${node.identity} ties` },
      );
    const unadmitted: readonly UnadmittedRecord[] = [
      ...[...excludedRecords.values()].map(({ record, finding }) => occurrence(record, finding)),
      ...graph.occurrences.filter((o) => o.status === 'tied').map((o) => occurrence(o.node, tie(o.node))),
      ...context.sources
        .filter((s) => context.errorPaths.has(s.ast.path) || duplicatePaths.has(s.ast.path))
        .flatMap((s) =>
          refusedWhole(s, texts.get(s.ast.path) ?? '', context.compiled, registry, fileErrors(s.ast.path)),
        ),
    ];
    return Object.freeze({
      graph,
      // Over the inputs and registry the graph's revision hashes, so the two differ only by runtime-placed sources.
      authoredRevision: authoredRevisionOf(registry, revisionInputs, [metadata.path]),
      report,
      boundary,
      refused: Object.freeze(
        [...excluded.values()].sort((a, b) => compare(a.path, b.path) || a.line - b.line).map((r) => Object.freeze(r)),
      ),
      unadmitted: Object.freeze(
        [...unadmitted]
          .sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.word ?? '', b.word ?? ''))
          .map((entry) => Object.freeze(entry)),
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
