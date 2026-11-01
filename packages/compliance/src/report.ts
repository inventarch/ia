import type { Diagnostic } from '@inventarch/language';
import type { Coordinate, Graph, Node, Shadow } from '@inventarch/graph';
import { stableSerialize } from '@inventarch/graph';
import { validateAdoption } from './adoption.js';
import type { AdoptionEvaluators } from './adoption.js';
import { assertCatalog } from './catalog.js';
import type { EvaluatorCatalog } from './catalog.js';
import { bindConformance } from './conformance/bind.js';
import type { ConformanceOptions, ConformanceSummary } from './conformance/bind.js';
import {
  validateCheck,
  validateCheckStructure,
  validateConsent,
  validateCoverage,
  validateFragments,
  validateGraphSchema,
  validateIdentity,
  validateParse,
  validateSelectors,
} from './graph-checks.js';
import { validateSystems } from './systems.js';
import type { SystemFolder } from './systems.js';
import { validateVariants } from './variants.js';
import { assess, verdict } from './types.js';
import type { Assessment, Finding, Verdict } from './types.js';

export interface ReportOptions {
  readonly admission?: readonly Assessment[];
  readonly sourceDiagnostics?: readonly Diagnostic[];
  readonly folders?: readonly SystemFolder[];
  /** Caller-asserted COMP-KERNEL and COMP-FIXTURES verdicts (C19); a result taken from it is labelled `caller-asserted`. */
  readonly evidence?: ReadonlyMap<'COMP-KERNEL' | 'COMP-FIXTURES', Verdict>;
  /** Verified conformance evidence bound to this graph (C31). Not with `evidence`. */
  readonly conformance?: ConformanceOptions;
  readonly adoptionEvaluators?: AdoptionEvaluators;
  readonly coordinate?: Coordinate;
  /** Trusted evaluator catalog (C26). Absent: built-in-only COMP-CHECK, unchanged. */
  readonly catalog?: EvaluatorCatalog;
  /**
   * Which COMP-CHECK a check record gets (C30): `strict`, the default, is validateCheck with `catalog`; `structural` is
   * validateCheckStructure, for the admitted graph of a structural admission, whose checks are bound separately.
   */
  readonly checks?: 'strict' | 'structural';
}
export interface Report {
  readonly revision: string;
  readonly outcome: Assessment['outcome'];
  readonly verdicts: readonly Verdict[];
  readonly findings: readonly Finding[];
  readonly shadows: readonly Shadow[];
  /** Present only when both COMP-KERNEL and COMP-FIXTURES are verified evidence bound to this graph (C31). */
  readonly conformance?: ConformanceSummary;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function unavailable(check: string, message: string): Assessment {
  return assess(check, 'graph', [{ code: 'IA-COMP-NOT-EVALUATED', severity: 'warning', path: '', line: 1, message }]);
}
/** Each folder with the nodes under its roots, in node order, each node's path read once however many folders there are. */
function withRecords(folders: readonly SystemFolder[], nodes: readonly Node[]): readonly SystemFolder[] {
  const atRoot = new Map<string, number[]>();
  for (const [index, folder] of folders.entries())
    for (const root of folder.roots ?? [folder.path]) {
      const held = atRoot.get(root);
      if (held === undefined) atRoot.set(root, [index]);
      else if (held[held.length - 1] !== index) held.push(index);
    }
  const records = folders.map((): Node[] => []);
  for (const node of nodes) {
    const path = node.source.path;
    for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1))
      for (const index of atRoot.get(path.slice(0, at)) ?? []) {
        const held = records[index]!;
        if (held[held.length - 1] !== node) held.push(node);
      }
  }
  return folders.map((folder, index) => ({ ...folder, records: records[index]! }));
}
export function evaluate(graph: Graph, options: ReportOptions = {}): Report {
  if (options.catalog !== undefined) assertCatalog(options.catalog);
  if (options.evidence !== undefined && options.conformance !== undefined)
    throw new TypeError('Pass caller-asserted evidence or verified conformance, not both');
  const bound = options.conformance === undefined ? undefined : bindConformance(graph, options.conformance);
  const nodes = [...graph.nodes.values()];
  let asserted: ReadonlySet<string> | undefined;
  const assertedAt = (path: string, line: number): boolean => {
    asserted ??= new Set(
      graph.edges.flatMap((edge) => edge.assertions.map((a) => `${a.source.line} ${a.source.path}`)),
    );
    return asserted.has(`${line} ${path}`);
  };
  const sourceDiagnostics = options.sourceDiagnostics?.filter(
    (d) => d.code !== 'IA-LANG-EDGE-TARGET-MISSING' || !assertedAt(d.path, d.line),
  );
  const assessments: Assessment[] = [
    validateParse(sourceDiagnostics),
    validateConsent(graph),
    validateIdentity(graph),
    validateFragments(graph),
    ...validateSystems(withRecords(options.folders ?? [], nodes), graph.registry, nodes),
    ...validateAdoption(graph, options.adoptionEvaluators, options.coordinate),
  ];
  for (const observation of options.admission ?? []) if (observation.outcome !== 'pass') assessments.push(observation);
  if (options.folders === undefined)
    for (const check of ['COMP-SYSTEM', 'COMP-STEWARD'])
      assessments.push(unavailable(check, 'System folder discovery observations were not supplied'));
  for (const node of nodes) {
    assessments.push(validateGraphSchema(node, graph), validateSelectors(node), validateVariants(node));
    if (node.discriminator === 'contract') assessments.push(validateCoverage(node, graph));
    if (node.discriminator === 'check')
      assessments.push(
        options.checks === 'structural' ? validateCheckStructure(node) : validateCheck(node, options.catalog),
      );
  }
  for (const diagnostic of graph.diagnostics)
    if (diagnostic.code === 'IA-GRAPH-DIMENSION-UNKNOWN')
      assessments.push(assess('COMP-SCHEMA', `${diagnostic.path}:${diagnostic.line}`, [diagnostic]));
  const basis = new WeakMap<Assessment, NonNullable<Verdict['basis']>>();
  if (bound !== undefined)
    for (const result of bound.results) {
      assessments.push(result.assessment);
      if (result.verified) basis.set(result.assessment, 'verified');
    }
  else
    for (const check of ['COMP-KERNEL', 'COMP-FIXTURES'] as const) {
      const evidence = options.evidence?.get(check);
      if (evidence === undefined || evidence.revision !== graph.revision || evidence.check !== check)
        assessments.push(unavailable(check, `${check}: matching-revision verification evidence was not supplied`));
      else {
        const { scope, outcome, findings } = evidence,
          asserted: Assessment = { check, scope, outcome, findings };
        basis.set(asserted, 'caller-asserted');
        assessments.push(asserted);
      }
    }
  const groups = new Map<string, Assessment[]>();
  const rank = { pass: 0, 'not-evaluated': 1, fail: 2 } as const;
  for (const assessment of assessments) {
    const key = stableSerialize([assessment.check, assessment.scope]),
      group = groups.get(key);
    if (group === undefined) groups.set(key, [assessment]);
    else group.push(assessment);
  }
  const grouped = [...groups.values()].map((group): Assessment => {
    const [first] = group as [Assessment, ...Assessment[]];
    if (group.length === 1) return first;
    const findings = new Map(group.flatMap((a) => a.findings).map((f) => [stableSerialize(f), f]));
    const outcome = group.reduce((worst, a) => (rank[a.outcome] > rank[worst] ? a.outcome : worst), first.outcome);
    return { ...assess(first.check, first.scope, [...findings.values()]), outcome };
  });
  const verdicts = Object.freeze(
    grouped
      .map((a): Verdict => {
        // Only this assembler labels a result's basis; a `basis` an input carried is dropped.
        const { basis: _carried, ...result } = verdict(a, graph.revision),
          label = basis.get(a);
        return Object.freeze(label === undefined ? result : { ...result, basis: label });
      })
      .sort((a, b) => compare(a.check, b.check) || compare(a.scope, b.scope)),
  );
  const findings = new Map<string, Finding>();
  for (const result of verdicts) for (const item of result.findings) findings.set(stableSerialize(item), item);
  return Object.freeze({
    revision: graph.revision,
    outcome: verdicts.some((v) => v.outcome === 'fail')
      ? 'fail'
      : verdicts.some((v) => v.outcome === 'not-evaluated')
        ? 'not-evaluated'
        : 'pass',
    verdicts,
    findings: Object.freeze(
      [...findings.values()].sort(
        (a, b) =>
          compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
      ),
    ),
    shadows: graph.shadows,
    ...(bound?.summary === undefined ? {} : { conformance: bound.summary }),
  });
}
