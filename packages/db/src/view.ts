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
/**
 * One record occurrence of a view's sources that the view does not admit (lane D, D1), with the band of the placement
 * its source was read at, which is where capture membership and every band test read a record's band from:
 * - `refused`: an occurrence `refused` names (a compliance exclusion, a schema failure, a refused system join or a refused
 *   enclosing record);
 * - `tied`: an occurrence of an identity that another occurrence ties at the same band (IA-GRAPH-IDENTITY-TIE), so
 *   neither is admitted;
 * - `source`: a record its file declares when the file is refused whole, by a language error or by a requirement id
 *   another occurrence declares too, before any graph is built. Each header the view's own parse of the file reads is
 *   one, with the identity the compile of the file gives the record or, where the compile refused it, the identity spec
 *   3.1 gives its header under its word's registration; each line of the captured text that opens
 *   with `@<word>` (indentation aside) and is no header the parse read is one too, with no identity, so a header the
 *   parse could not read (no or another pragma, a malformed name, an indented header) is still seen. That reading errs
 *   towards listing: a non-header line spelled so in a file already refused is listed under its word.
 */
export interface UnadmittedRecord {
  /**
   * The canonical identity, when the view compiled the record or spec 3.1 names its parsed header; absent for a header
   * only the source text shows, or whose word no admitted system registers.
   */
  readonly identity?: string;
  /** The word the header names, lowercased. */
  readonly word: string;
  /**
   * The record's name as its header spells it, lowercased (lane D, D9: what a typed reference to it is matched by); absent
   * for a header that spells none.
   */
  readonly name?: string;
  readonly band: Band;
  readonly path: string;
  /** The header line. */
  readonly line: number;
  readonly endLine: number;
  readonly cause: 'refused' | 'tied' | 'source';
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
/**
 * A line that opens with `@<word>`, a byte-order mark and indentation aside, and the name token after it when one is
 * there: the header syntax, read from text the parse could not read.
 */
const HEADER = /^\uFEFF?[ \t]*@([A-Za-z][A-Za-z0-9-]*)(?=[ \t\r]|$)(?:[ \t]+([^ \t\r]+))?/;
/**
 * The `source` occurrences of a file a view refuses whole (`UnadmittedRecord`): every header its parse reads, nested
 * ones included, with the identity its compile gives that header's record or, for one its compile refused, the identity
 * spec 3.1 gives it (`identityOf` over its word's registration), then every other line of `text` that opens with a
 * header, under its word.
 */
function refusedWhole(
  source: Source,
  text: string,
  compiled: readonly CompiledRecord[],
  registry: FrozenRegistry,
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
  const parsed = nodes.map((node): UnadmittedRecord => {
    const registration = registry.registrations.get(node.discriminator);
    const identity =
      identities.get(node.span.line) ??
      (registration === undefined ? undefined : identityOf(node, registration, path).identity?.identity);
    return {
      ...(identity === undefined ? {} : { identity }),
      word: node.discriminator.toLowerCase(),
      ...(node.name === '' ? {} : { name: node.name.toLowerCase() }),
      band,
      path,
      line: node.span.line,
      endLine: node.span.endLine,
      cause: 'source',
    };
  });
  const read = new Set(nodes.map((node) => node.span.line));
  const unread = text.split('\n').flatMap((spelled, index): UnadmittedRecord[] => {
    const [, word, name] = HEADER.exec(spelled) ?? [];
    return word === undefined || read.has(index + 1)
      ? []
      : [
          {
            word: word.toLowerCase(),
            ...(name === undefined ? {} : { name: name.toLowerCase() }),
            band,
            path,
            line: index + 1,
            endLine: index + 1,
            cause: 'source',
          },
        ];
  });
  return [...parsed, ...unread];
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
    const blockedFolders = new Set<string>(),
      excluded = new Map<string, RefusedRecord>(),
      /** The occurrence behind each `excluded` entry, by the same key: its band and span are what `unadmitted` lists. */
      excludedRecords = new Map<string, CompiledRecord>(),
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
        for (const system of registry.systems.values())
          if (!blocked.has(system.name) && system.requires.some((r) => blocked.has(r.name))) {
            blocked.add(system.name);
            changed = true;
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
    const exclude = (record: CompiledRecord, reason: string): void => {
      excluded.set(occurrenceKey(record), {
        identity: record.identity,
        path: record.source.path,
        line: record.source.line,
        reason,
      });
      excludedRecords.set(occurrenceKey(record), record);
    };
    const remaining = (): readonly CompiledRecord[] => {
      blockDependents();
      for (const record of candidates)
        if (
          blocked.has(record.system) ||
          (record.discriminator === 'system' && blocked.has(record.name)) ||
          [...blockedFolders].some((path) => systemMember(record.source.path)?.name === path.split('/').at(-1))
        )
          exclude(record, 'system join refused');
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of candidates)
          if (
            !excluded.has(occurrenceKey(record)) &&
            record.parent !== undefined &&
            [...excluded.values()].some((r) => r.path === record.source.path && r.identity === record.parent)
          ) {
            exclude(record, 'enclosing record refused');
            changed = true;
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
              blocked.add(folder.name);
              for (const system of registry.systems.values())
                if (system.path.startsWith(folder.path + '/')) blocked.add(system.name);
            }
          } else {
            const record = nodes.find((r) => r.source.path === finding.path && r.source.line === finding.line);
            if (record !== undefined) exclude(record, finding.code);
            if (finding.code === 'IA-COMP-SCHEMA-MULTIPLE' && record !== undefined)
              for (const registration of registry.registrations.values())
                if (registration.schema === record.name) blocked.add(registration.system);
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
            exclude(node, assessment.findings[0]?.code ?? `${assessment.check} unavailable`);
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
          exclude(occurrence.node, 'invalid graph dimensions');
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
    const occurrence = (record: CompiledRecord, cause: UnadmittedRecord['cause']): UnadmittedRecord => ({
      identity: record.identity,
      word: record.discriminator,
      name: record.name,
      band: record.placement.band,
      path: record.source.path,
      line: record.source.line,
      endLine: record.source.endLine,
      cause,
    });
    const unadmitted: readonly UnadmittedRecord[] = [
      ...[...excludedRecords.values()].map((record) => occurrence(record, 'refused')),
      ...graph.occurrences.filter((o) => o.status === 'tied').map((o) => occurrence(o.node, 'tied')),
      ...context.sources
        .filter((s) => context.errorPaths.has(s.ast.path) || duplicatePaths.has(s.ast.path))
        .flatMap((s) => refusedWhole(s, texts.get(s.ast.path) ?? '', context.compiled, registry)),
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
          .sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.word, b.word))
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
