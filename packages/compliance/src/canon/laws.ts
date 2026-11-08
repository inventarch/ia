import type { Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import { isBuiltinCheck } from '../check-ids.js';
import { checkRunner, textField } from '../graph-checks.js';
import type { Verdict } from '../types.js';

export type LawState = 'enforced' | 'pending' | 'not-evaluated' | 'suspended';
type LawSeverity = 'blocking' | 'advisory' | 'informational';
export interface LawStatus {
  readonly identity: string;
  readonly severity: LawSeverity;
  readonly state: LawState;
  /** Identities of the checks enforcing the law. */
  readonly checks: readonly string[];
  /** Identity of the suspending improvement, else null. */
  readonly suspendedBy: string | null;
}

const SEVERITY_ORDER: Readonly<Record<LawSeverity, number>> = { informational: 0, advisory: 1, blocking: 2 };
const lawSeverity = (law: Node): LawSeverity => {
  const text = textField(law, 'governance', 'severity');
  return text === 'blocking' || text === 'advisory' ? text : 'informational';
};

/** The identities of the checks enforcing `law`, read from either side of the `enforce` edge. */
function enforcingChecks(nodes: readonly Node[], law: Node): readonly string[] {
  const found = new Set<string>();
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

export function lawStatuses(nodes: readonly Node[], verdicts: readonly Verdict[]): readonly LawStatus[] {
  const byIdentity = new Map(nodes.map((node) => [node.identity, node]));
  const evaluated = new Set(verdicts.filter((v) => v.outcome !== 'not-evaluated').map((v) => v.check));
  return nodes
    .filter((node) => node.discriminator === 'law')
    .map((law): LawStatus => {
      const checks = enforcingChecks(nodes, law),
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
 * Blocking gives error, advisory gives warning, and a suspended law gives warning. Null leaves the check inactive.
 */
export function canonSeverity(nodes: readonly Node[], checkId: string): Severity | null {
  let strongest: LawSeverity = 'informational';
  let suspended = false;
  for (const law of nodes) {
    if (law.discriminator !== 'law') continue;
    const enforces = enforcingChecks(nodes, law).some((id) => {
      const check = nodes.find((node) => node.identity === id);
      return check !== undefined && checkRunner(check) === checkId;
    });
    if (!enforces) continue;
    const severity = lawSeverity(law);
    if (severity === 'informational') continue;
    if (suspension(nodes, law) !== undefined) suspended = true;
    else if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[strongest]) strongest = severity;
  }
  if (strongest === 'blocking') return 'error';
  if (strongest === 'advisory' || suspended) return 'warning';
  return null;
}
