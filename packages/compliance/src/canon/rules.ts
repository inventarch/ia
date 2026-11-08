import type { Node } from '@inventarch/graph';
import type { Severity } from '@inventarch/language';
import type { SystemFolder } from '../systems.js';
import { assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';
import { canonSeverity } from './laws.js';

const WORK_INSTANCES: ReadonlySet<string> = new Set(['plan', 'milestone', 'task', 'decision', 'spec']);

/** A14: work records inside a reusable system payload under `.ia/src/systems/`. The caller sets the severity. */
export function canonWorkPlacement(nodes: readonly Node[]): readonly Finding[] {
  return nodes
    .filter((node) => node.source.path.startsWith('.ia/src/systems/') && WORK_INSTANCES.has(node.discriminator))
    .map(
      (node): Finding => ({
        code: 'IA-COMP-CANON-WORK-PLACEMENT',
        path: node.source.path,
        line: node.source.line,
        severity: 'error',
        message: `${node.source.path}:${node.source.line}: Repository plans, milestones, tasks, decisions and specifications belong in workspace-authored records, outside reusable vocabulary system payloads.`,
      }),
    );
}

const RULES: readonly (readonly [string, (nodes: readonly Node[]) => readonly Finding[]])[] = [
  ['CANON-WORK-PLACEMENT', canonWorkPlacement],
];

/**
 * The built-in canon rules, each active only when a law enforces a check that runs it. The law sets the severity;
 * an inactive rule reports nothing. `_folders` is reserved for rules that read system folders.
 */
export function canonAssessments(
  nodes: readonly Node[],
  _folders: readonly SystemFolder[] | undefined,
): readonly Assessment[] {
  const results: Assessment[] = [];
  for (const [id, rule] of RULES) {
    const severity: Severity | null = canonSeverity(nodes, id);
    if (severity === null) continue;
    results.push(
      assess(
        id,
        'graph',
        rule(nodes).map((finding) => ({ ...finding, severity })),
      ),
    );
  }
  return results;
}
