import { AXES, canonicalValue, clipped, resolveTarget } from '@inventarch/language';
import type { CompiledEdge, CompiledField, Diagnostic } from '@inventarch/language';
import type { Edge, Graph, Node } from '@inventarch/graph';
import { LISTED_FINDINGS, couldMatch, matchesTarget, poolLookup, schemaReporter, schemaStructure } from './schema.js';
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
    message: clipped(`${node.source.path}:${line}: ${node.identity}: ${message}`),
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
/** The edges graph refused, by what a schema rule asks of them, read once however many records ask. */
interface RefusedEdges {
  /** `predicate direction identity` of each author that wrote one. */
  readonly authored: ReadonlySet<string>;
  /** Each refused edge by `predicate direction` and each way its reference can name a record. */
  readonly aimed: ReadonlyMap<string, readonly { readonly author: Node; readonly edge: CompiledEdge }[]>;
}
const refusedEdges = new WeakMap<Graph, RefusedEdges>();
const REFUSED_EDGE: readonly string[] = ['IA-GRAPH-EDGE-UNCONSENTED', 'IA-GRAPH-TARGET-AMBIGUOUS'];
const aimedAt = (predicate: string, direction: string, name: string): string => `${predicate} ${direction} ${name}`;
function refusedIn(graph: Graph): RefusedEdges {
  let refused = refusedEdges.get(graph);
  if (refused === undefined) {
    const lines = new Set<string>();
    for (const d of graph.diagnostics)
      if (d.severity === 'error' && REFUSED_EDGE.includes(d.code)) lines.add(`${d.line} ${d.path}`);
    const authored = new Set<string>(),
      aimed = new Map<string, { readonly author: Node; readonly edge: CompiledEdge }[]>();
    if (lines.size > 0)
      for (const author of graph.nodes.values())
        for (const edge of author.edges) {
          if (!lines.has(`${edge.span.line} ${author.source.path}`)) continue;
          authored.add(aimedAt(edge.predicate, edge.direction, author.identity));
          const name =
            edge.reference.kind === 'identity'
              ? edge.reference.identity
              : `${edge.reference.discriminator} ${edge.reference.name.toLowerCase()}`;
          const key = aimedAt(edge.predicate, edge.direction, name),
            same = aimed.get(key);
          if (same === undefined) aimed.set(key, [{ author, edge }]);
          else same.push({ author, edge });
        }
    refused = { authored, aimed };
    refusedEdges.set(graph, refused);
  }
  return refused;
}
export function validateGraphSchema(record: Node, graph: Graph): Assessment {
  const { findings, schema } = schemaStructure(record, graph.registry, graphLookup(graph)),
    add = schemaReporter(record, findings),
    edgesRefused = refusedIn(graph);
  let unavailable = false;
  for (const rule of schema?.edges ?? []) {
    const opposite = rule.direction === 'out' ? 'in' : 'out';
    // Another record's refused edge reaches this rule only when that record is a target the rule counts.
    const refused =
      edgesRefused.authored.has(aimedAt(rule.predicate, rule.direction, record.identity)) ||
      [record.identity, `${record.discriminator} ${record.name}`].some((name) =>
        (edgesRefused.aimed.get(aimedAt(rule.predicate, opposite, name)) ?? []).some(
          ({ author, edge }) =>
            matchesTarget(author, rule) && resolveTarget(edge.reference, graph.registry, [record]).kind === 'resolved',
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
/**
 * The `ref to` lookup of a graph (C04a): one per graph, built on first use over its admitted nodes and kept for the
 * graph's lifetime.
 */
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
/** The fragments a record holds, read once: a record of many clauses is read for every edge that names one. */
const fragmentsHeld = new WeakMap<Node, ReadonlySet<string>>();
export function fragmentExists(edge: Edge, graph: Graph): boolean {
  const node = fragmentTarget(edge, graph);
  if (node === undefined || edge.fragment === undefined) return false;
  let held = fragmentsHeld.get(node);
  if (held === undefined) {
    held = new Set([...node.requirements.map((r) => r.id), ...node.cells.map((c) => `${c.phase}/${c.primitive}`)]);
    fragmentsHeld.set(node, held);
  }
  return held.has(edge.fragment);
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
  const uncovered = contract.requirements.filter((r) => !coverage.has(r.id)),
    findings = uncovered
      .slice(0, LISTED_FINDINGS)
      .map((r) =>
        finding(
          'IA-COMP-COVERAGE-MISSING',
          contract,
          `Requirement ${r.id} has no unconditional implementing case`,
          r.span.line,
        ),
      );
  if (uncovered.length > LISTED_FINDINGS)
    findings.push(
      finding(
        'IA-COMP-COVERAGE-MISSING',
        contract,
        `${uncovered.length - LISTED_FINDINGS} more requirements have no unconditional implementing case`,
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
/**
 * COMP-CHECK as structural admission reads it (C30): the declaration's own shape only. A check naming both fields with
 * different values is IA-COMP-CHECK-CONFLICT and one naming no evaluator IA-COMP-CHECK-UNKNOWN, as validateCheck has
 * them; any named evaluator passes, because whether a built-in or an installed implementation serves it is decided when
 * the check is bound against a host's catalog, not by admission. validateCheck stays the strict admission every
 * existing reader of the admitted graph uses.
 */
export function validateCheckStructure(node: Node): Assessment {
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
  return assess(
    'COMP-CHECK',
    node.identity,
    checkRunner(node) === undefined
      ? [finding('IA-COMP-CHECK-UNKNOWN', node, `Missing ${runnerField(node)}: the check names no evaluator`)]
      : [],
  );
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
