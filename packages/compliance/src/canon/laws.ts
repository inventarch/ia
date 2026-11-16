import type { Graph, Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import { isBuiltinCheck } from '../check-ids.js';
import { checkRunner, textField } from '../graph-checks.js';
import { COMP_CODES } from '../types.js';
import type { Finding, Verdict } from '../types.js';

export type LawState = 'enforced' | 'pending' | 'not-evaluated' | 'suspended';
export type LawSeverity = 'blocking' | 'advisory' | 'informational';
export interface LawStatus {
  readonly identity: string;
  readonly severity: LawSeverity;
  readonly state: LawState;
  /** Identities of the checks enforcing the law. */
  readonly checks: readonly string[];
  /** Identity of the suspending improvement, else null. */
  readonly suspendedBy: string | null;
}

export const SEVERITY_ORDER: Readonly<Record<LawSeverity, number>> = { informational: 0, advisory: 1, blocking: 2 };
export const lawSeverity = (law: Node): LawSeverity => {
  const text = textField(law, 'governance', 'severity');
  return text === 'blocking' || text === 'advisory' ? text : 'informational';
};

/**
 * The identities of the checks enforcing `law`. With the graph, only its resolved `enforce` edges count (from the check
 * to the law); without one, the node edges' own targets, on either side.
 */
function enforcingChecks(nodes: readonly Node[], law: Node, graph?: Graph): readonly string[] {
  const found = new Set<string>();
  if (graph !== undefined) {
    for (const edge of graph.edges)
      if (edge.predicate === 'enforce' && edge.to === law.identity && edge.from !== null) found.add(edge.from);
    return [...found].sort();
  }
  for (const edge of law.edges)
    if (edge.predicate === 'enforce' && edge.direction === 'in' && edge.target !== null) found.add(edge.target);
  for (const node of nodes)
    if (node.discriminator === 'check')
      for (const edge of node.edges)
        if (edge.predicate === 'enforce' && edge.direction === 'out' && edge.target === law.identity)
          found.add(node.identity);
  return [...found].sort();
}

/** The improvement that suspends `law`: its proposal.target is the law's identity and its review.status is suspended. */
function suspension(nodes: readonly Node[], law: Node): Node | undefined {
  return nodes.find(
    (node) =>
      node.discriminator === 'improvement' &&
      textField(node, 'proposal', 'target') === law.identity &&
      textField(node, 'review', 'status') === 'suspended',
  );
}

export function lawStatuses(nodes: readonly Node[], verdicts: readonly Verdict[], graph?: Graph): readonly LawStatus[] {
  const byIdentity = new Map(nodes.map((node) => [node.identity, node]));
  const evaluated = new Set(verdicts.filter((v) => v.outcome !== 'not-evaluated').map((v) => v.check));
  return nodes
    .filter((node) => node.discriminator === 'law')
    .map((law): LawStatus => {
      const checks = enforcingChecks(nodes, law, graph),
        suspendedBy = suspension(nodes, law)?.identity ?? null,
        runners = checks.map((id) => {
          const check = byIdentity.get(id);
          return check === undefined ? undefined : checkRunner(check);
        }),
        state: LawState =
          suspendedBy !== null
            ? 'suspended'
            : checks.length === 0
              ? 'pending'
              : runners.every((runner) => runner !== undefined && isBuiltinCheck(runner) && evaluated.has(runner))
                ? 'enforced'
                : 'not-evaluated';
      return { identity: law.identity, severity: lawSeverity(law), state, checks, suspendedBy };
    })
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
}

/**
 * The severity a built-in canon check reports at: the strongest of the laws enforcing a check that runs `checkId`.
 * Blocking gives error, advisory gives warning, and a suspended law gives warning. A blocking law gives error only when
 * every check enforcing it runs a built-in id; while any of them does not (6c-3: an evaluation this run cannot make
 * does not block), it gives warning. Null leaves the check inactive.
 */
export function canonSeverity(nodes: readonly Node[], checkId: string, graph?: Graph): Severity | null {
  let strongest: LawSeverity = 'informational';
  let suspended = false;
  const runnerOf = (id: string): string | undefined => {
    const check = nodes.find((node) => node.identity === id);
    return check === undefined ? undefined : checkRunner(check);
  };
  for (const law of nodes) {
    if (law.discriminator !== 'law') continue;
    const runners = enforcingChecks(nodes, law, graph).map(runnerOf);
    if (!runners.includes(checkId)) continue;
    let severity = lawSeverity(law);
    if (severity === 'informational') continue;
    if (severity === 'blocking' && !runners.every((runner) => runner !== undefined && isBuiltinCheck(runner)))
      severity = 'advisory';
    if (suspension(nodes, law) !== undefined) suspended = true;
    else if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[strongest]) strongest = severity;
  }
  if (strongest === 'blocking') return 'error';
  if (strongest === 'advisory' || suspended) return 'warning';
  return null;
}

/** The codes the built-in canon checks report, from records (canonAssessments) or the checkout (`canonFiles`). */
export const CANON_CODES: ReadonlySet<string> = new Set(COMP_CODES.filter((code) => code.startsWith('IA-COMP-CANON-')));

/**
 * Whether a finding refuses an installation (`ia install`, `ia update`, `ia restore`, `ia adopt` and the archive and
 * closure checks they run): every error except a canon finding. A canon law stops work through `ia validate` and
 * `ia preview` only (dec-006 6b), so a consumer can always install the release it then fails to validate.
 */
export const refusesInstallation = (finding: Pick<Finding, 'code' | 'severity'>): boolean =>
  finding.severity === 'error' && !CANON_CODES.has(finding.code);
