import {
  KERNEL_DIGEST,
  LANGUAGE_VERSION,
  buildRegistry,
  compile,
  parse,
  requirementCollisions,
} from '@inventarch/language';
import type { CompiledRecord, Diagnostic, FrozenRegistry, Phase, Source } from '@inventarch/language';
import { canonicalRoot, load, reaches, stableSerialize } from '@inventarch/graph';
import type { Graph, RevisionSource } from '@inventarch/graph';
import {
  evaluate,
  validateCheck,
  validateConsent,
  validateGraphSchema,
  validateSelectors,
  validateSystems,
  validateVariants,
} from '@inventarch/compliance';
import type { Assessment, Report, SystemFolder } from '@inventarch/compliance';
import type { InputSnapshot } from './inputs.js';
import { systemMember } from './inputs.js';
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
/** Internal view; public reads project allowed nodes, never this candidate registry. */
export interface View {
  readonly graph: Graph;
  readonly report: Report;
  readonly refused: readonly RefusedRecord[];
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
  readonly diagnostics: readonly Diagnostic[];
  readonly errorPaths: ReadonlySet<string>;
}
export const occurrenceKey = (record: CompiledRecord): string =>
  JSON.stringify([record.identity, record.source.path, record.source.line]);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function diagnosticsOf(values: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...new Map(values.map((d) => [stableSerialize(d), d])).values()].sort(
    (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code),
  );
}
export function viewBuilder(input: InputSnapshot): (location?: string, phase?: Phase) => View {
  const parsed = input.sources.map((s) => ({ ...parse(s.text, s.path), location: s.location }));
  const contexts = new Map<string, Context>();
  const analyze = (location: string): Context => {
    const known = contexts.get(location);
    if (known !== undefined) return known;
    const sources = parsed.filter((s) => reaches(s.location.placement.reach, location));
    const registered = buildRegistry(sources),
      results = sources.map((s) => compile(s.ast, registered.registry, s.location, []));
    const diagnostics = diagnosticsOf([...registered.diagnostics, ...results.flatMap((r) => r.diagnostics)]);
    const errorPaths = new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.path));
    const context = {
      sources,
      registry: registered.registry,
      records: results.flatMap((r) => r.records).filter((r) => !errorPaths.has(r.source.path)),
      diagnostics,
      errorPaths,
    };
    contexts.set(location, context);
    return context;
  };
  // Registry visibility can change only at a declared reach. Inspect those
  // finite contexts before authority so bands cannot conceal duplicate REQ ids.
  for (const reach of [...new Set(['', ...input.sources.map((s) => s.location.placement.reach)])].sort(compare))
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
  const metadata: RevisionSource = {
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
  const revisionSources = [...input.sources, metadata];
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
      return sources.length === 0 && input.sources.some((s) => systemMember(s.path)?.name === name)
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
        sources: revisionSources,
        languageVersion: LANGUAGE_VERSION,
        kernelDigest: KERNEL_DIGEST,
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
          ...(node.discriminator === 'check' ? [validateCheck(node)] : []),
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
    });
    return Object.freeze({
      graph,
      report,
      boundary,
      refused: Object.freeze(
        [...excluded.values()].sort((a, b) => compare(a.path, b.path) || a.line - b.line).map((r) => Object.freeze(r)),
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
