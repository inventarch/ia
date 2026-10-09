import { AXES, canonicalValue, resolveTarget } from '@inventarch/language';
import type { CompiledField, Diagnostic } from '@inventarch/language';
import type { Edge, Graph, Node } from '@inventarch/graph';
import { couldMatch, matchesTarget, poolLookup, schemaReporter, schemaStructure } from './schema.js';
import type { ReferenceLookup } from './schema.js';
import { assess } from './types.js';
import type { Assessment, CompCode, EvidenceCode, Finding } from './types.js';
import { CHECK_IDS, isBuiltinCheck } from './check-ids.js';
import { assertCatalog, selectEvaluator } from './catalog.js';
import type { EvaluatorCatalog } from './catalog.js';

export { CHECK_IDS } from './check-ids.js';
export function finding(
  code: CompCode | EvidenceCode,
  node: Node,
  message: string,
  line = node.source.line,
  warning = false,
): Finding {
  return {
    code,
    severity: warning ? 'warning' : 'error',
    path: node.source.path,
    line,
    identity: node.identity,
    message: `${node.source.path}:${line}: ${node.identity}: ${message}`,
  };
}
export function fields(node: Node, section: string, key: string): readonly CompiledField[] {
  return node.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.key === key);
}
export function textField(node: Node, section: string, key: string): string | undefined {
  const matches = fields(node, section, key);
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.value;
  return value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose' ? value.text : undefined;
}
export function validateGraphSchema(record: Node, graph: Graph): Assessment {
  const { findings, schema } = schemaStructure(record, graph.registry, graphLookup(graph)),
    add = schemaReporter(record, findings);
  let unavailable = false;
  for (const rule of schema?.edges ?? []) {
    const refused =
      graph.diagnostics.some(
        (d) => d.severity === 'error' && ['IA-GRAPH-EDGE-UNCONSENTED', 'IA-GRAPH-TARGET-AMBIGUOUS'].includes(d.code),
      ) &&
      [...graph.nodes.values()].some((author) =>
        author.edges.some(
          (edge) =>
            edge.predicate === rule.predicate &&
            (edge.direction === rule.direction
              ? author.identity === record.identity
              : resolveTarget(edge.reference, graph.registry, [record]).kind === 'resolved') &&
            graph.diagnostics.some(
              (d) =>
                d.severity === 'error' &&
                ['IA-GRAPH-EDGE-UNCONSENTED', 'IA-GRAPH-TARGET-AMBIGUOUS'].includes(d.code) &&
                d.path === author.source.path &&
                d.line === edge.span.line,
            ),
        ),
      );
    // Admission already owns the fault. Its refused edge is neither a target nor
    // evidence of absence: leave this dependent obligation unavailable.
    if (refused) {
      unavailable = true;
      continue;
    }
    const targets = new Set<string>();
    let uncertain = false;
    // An `out` rule reads the record's active edges and their `to` endpoint; an `in` rule the edges whose active target
    // is the record and their `from` endpoint. A fragment counts only when it sits on that endpoint.
    const [adjacent, endpoint] = rule.direction === 'out' ? [graph.out, 'to' as const] : [graph.in, 'from' as const];
    for (const edge of adjacent.get(record.identity)?.get(rule.predicate) ?? []) {
      const other = edge[endpoint];
      const target = other === null ? undefined : graph.nodes.get(other);
      if (target !== undefined) {
        if (!matchesTarget(target, rule)) continue;
        if (edge.condition !== undefined) uncertain = true;
        else targets.add(`${target.identity}#${edge.fragmentEndpoint === endpoint ? (edge.fragment ?? '') : ''}`);
      } else if (
        couldMatch(
          { ...edge, direction: rule.direction, spelling: edge.predicate, target: null, span: edge.source },
          rule,
          graph.registry,
        )
      )
        uncertain = true;
    }
    const minimum = rule.must && rule.cardinality !== 'optional' ? 1 : 0,
      maximum = rule.cardinality === 'one-or-more' ? Infinity : 1;
    if (targets.size > maximum || (targets.size < minimum && !uncertain))
      add(
        'IA-COMP-EDGE-CARDINALITY',
        record.source,
        `${rule.spelling} ${rule.target} requires ${rule.must ? 'must' : 'may'} ${rule.cardinality}; found ${targets.size} definite targets`,
      );
    else if (uncertain && (targets.size < minimum || maximum !== Infinity))
      add(
        'IA-COMP-EDGE-UNRESOLVED',
        record.source,
        `${rule.spelling} ${rule.target} ${rule.cardinality} cannot be decided with unresolved targets or conditions`,
        true,
      );
  }
  return assess('COMP-SCHEMA', record.identity, findings, unavailable);
}
/** The `ref to` lookup of a graph (W0-L2): one per graph, built on first use over its admitted nodes and kept for the graph's lifetime. */
export function graphLookup(graph: Graph): ReferenceLookup {
  let lookup = graphLookups.get(graph);
  if (lookup === undefined) {
    lookup = poolLookup(graph.registry, [...graph.nodes.values()]);
    graphLookups.set(graph, lookup);
  }
  return lookup;
}
const graphLookups = new WeakMap<Graph, ReferenceLookup>();
export function fragmentTarget(edge: Edge, graph: Graph): Node | undefined {
  const identity = edge.fragmentEndpoint === 'from' ? edge.from : edge.to;
  return identity === null ? undefined : graph.nodes.get(identity);
}
export function fragmentExists(edge: Edge, graph: Graph): boolean {
  const node = fragmentTarget(edge, graph);
  return (
    node !== undefined &&
    (node.requirements.some((r) => r.id === edge.fragment) ||
      node.cells.some((c) => `${c.phase}/${c.primitive}` === edge.fragment))
  );
}
export function validateFragments(graph: Graph): Assessment {
  const findings: Finding[] = [];
  for (const edge of graph.edges) {
    if (edge.fragment === undefined || fragmentTarget(edge, graph) === undefined || fragmentExists(edge, graph))
      continue;
    findings.push(
      finding(
        'IA-COMP-FRAGMENT-MISSING',
        graph.nodes.get(edge.author)!,
        `Fragment #${edge.fragment} is absent on ${fragmentTarget(edge, graph)!.identity}`,
        edge.source.line,
      ),
    );
  }
  return assess('COMP-FRAGMENT', 'graph', findings);
}
export function validateCoverage(contract: Node, graph: Graph): Assessment {
  const coverage = new Map<string, Set<string>>(),
    kinds = new Set<string>();
  for (const edge of graph.in.get(contract.identity)?.get('implement') ?? []) {
    if (
      edge.condition !== undefined ||
      edge.from === null ||
      edge.fragmentEndpoint !== 'to' ||
      !fragmentExists(edge, graph)
    )
      continue;
    const scenario = graph.nodes.get(edge.from)!;
    if (scenario.discriminator !== 'case') continue;
    const cases = coverage.get(edge.fragment!) ?? new Set<string>();
    cases.add(scenario.identity);
    coverage.set(edge.fragment!, cases);
    const kind = textField(scenario, 'scenario', 'kind');
    if (kind !== undefined) kinds.add(kind);
  }
  const findings = contract.requirements
    .filter((r) => !coverage.has(r.id))
    .map((r) =>
      finding(
        'IA-COMP-COVERAGE-MISSING',
        contract,
        `Requirement ${r.id} has no unconditional implementing case`,
        r.span.line,
      ),
    );
  if (findings.length === 0 && (!kinds.has('success') || (!kinds.has('failure') && !kinds.has('refusal'))))
    findings.push(
      finding('IA-COMP-COVERAGE-KIND', contract, 'Coverage requires a success case and a failure or refusal case'),
    );
  return assess('COMP-COVERAGE', contract.identity, findings);
}
export function validateSelectors(node: Node): Assessment {
  const findings: Finding[] = [];
  for (const group of node.selectors)
    if (
      group.length === 0 ||
      new Set(group.map((t) => t.axis)).size !== group.length ||
      group.some((t) => !(AXES as readonly string[]).includes(t.axis) || canonicalValue(t.axis, t.value) !== t.value)
    )
      findings.push(
        finding(
          'IA-COMP-SELECTOR-INVALID',
          node,
          'Selector group must contain unique closed routing axes and canonical values',
        ),
      );
  return assess('COMP-SELECTOR', node.identity, findings);
}
/**
 * The evaluator id a check declares: `check.implementation` when present, else `check.runs`. Every reader of a
 * check's evaluator resolves it here so they agree; a check naming both with different values is refused by
 * validateCheck (IA-COMP-CHECK-CONFLICT). Undefined when neither field is present exactly once.
 */
export function checkRunner(node: Node): string | undefined {
  return textField(node, 'check', 'implementation') ?? textField(node, 'check', 'runs');
}
/** The field checkRunner read, for messages; both names when neither is present. */
function runnerField(node: Node): string {
  if (textField(node, 'check', 'implementation') !== undefined) return 'check.implementation';
  return textField(node, 'check', 'runs') !== undefined ? 'check.runs' : 'check.implementation or check.runs';
}
/**
 * COMP-CHECK (C16, C26). The evaluator is checkRunner(node). Without a catalog only CHECK_IDS are implemented,
 * exactly as before. With a trusted catalog from createEvaluatorCatalog, a supported catalog id also passes; a
 * revoked one fails and an unavailable one is not-evaluated (D5). Host-reserved ids never pass (D4). A check that
 * names both check.implementation and check.runs with different values is IA-COMP-CHECK-CONFLICT. The declaration
 * still schedules nothing.
 */
export function validateCheck(node: Node, catalog?: EvaluatorCatalog): Assessment {
  if (catalog !== undefined) assertCatalog(catalog);
  const implementation = textField(node, 'check', 'implementation'),
    runs = textField(node, 'check', 'runs');
  if (implementation !== undefined && runs !== undefined && implementation !== runs)
    return assess('COMP-CHECK', node.identity, [
      finding(
        'IA-COMP-CHECK-CONFLICT',
        node,
        `check.implementation '${implementation}' and check.runs '${runs}' name different evaluators; declare one or make them agree`,
      ),
    ]);
  const runner = checkRunner(node),
    field = runnerField(node);
  if (catalog === undefined)
    return assess(
      'COMP-CHECK',
      node.identity,
      runner !== undefined && (CHECK_IDS as readonly string[]).includes(runner)
        ? []
        : [
            finding(
              'IA-COMP-CHECK-UNKNOWN',
              node,
              `Unknown or missing ${field} '${runner ?? ''}'; implemented: ${CHECK_IDS.join(', ')}`,
            ),
          ],
    );
  // D4: only CHECK_IDS are built in; host-reserved ids never pass and are never catalog entries.
  if (runner !== undefined && isBuiltinCheck(runner)) return assess('COMP-CHECK', node.identity, []);
  const entry = runner === undefined ? undefined : selectEvaluator(catalog, runner);
  if (entry?.availability.status === 'supported') return assess('COMP-CHECK', node.identity, []);
  if (entry !== undefined) {
    const message = `${field} '${entry.id}' names catalog evaluator ${entry.id}@${entry.implementationVersion}, which is ${entry.availability.status}: ${entry.availability.reason}`;
    // D5: revoked is a blocking error; unavailable stays visibly not-evaluated (admission blocks required obligations).
    return entry.availability.status === 'revoked'
      ? assess('COMP-CHECK', node.identity, [finding('IA-COMP-EVALUATOR-REVOKED', node, message)])
      : assess(
          'COMP-CHECK',
          node.identity,
          [finding('IA-COMP-EVALUATOR-UNAVAILABLE', node, message, node.source.line, true)],
          true,
        );
  }
  return assess('COMP-CHECK', node.identity, [
    finding(
      'IA-COMP-CHECK-UNKNOWN',
      node,
      `Unknown or missing ${field} '${runner ?? ''}'; implemented: ${CHECK_IDS.join(', ')}; catalog ${catalog.digest}: ${[...new Set(catalog.entries.map((e) => e.id))].join(', ') || 'no entries'}`,
    ),
  ]);
}
export function validateParse(diagnostics: readonly Diagnostic[] | undefined): Assessment {
  return assess(
    'COMP-PARSE',
    'sources',
    diagnostics ?? [
      {
        code: 'IA-COMP-NOT-EVALUATED',
        severity: 'warning',
        path: '',
        line: 1,
        message: 'Language source diagnostics were not supplied',
      },
    ],
  );
}
export function validateConsent(graph: Graph): Assessment {
  const findings = graph.diagnostics.filter((d) =>
    ['IA-GRAPH-EDGE-UNCONSENTED', 'IA-GRAPH-TARGET-MISSING', 'IA-GRAPH-TARGET-AMBIGUOUS'].includes(d.code),
  );
  return assess('COMP-CONSENT', 'graph', findings, graph.dangling.length > 0);
}
export function validateIdentity(graph: Graph): Assessment {
  return assess(
    'COMP-IDENTITY',
    'graph',
    graph.diagnostics.filter((d) => d.code === 'IA-GRAPH-IDENTITY-TIE'),
  );
}
