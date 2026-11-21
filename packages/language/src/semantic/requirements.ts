import { diag, summarizeOthers } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { sortDiagnostics } from '../registry/index.js';

export function isRequirementId(id: string): boolean {
  return /^REQ-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(id);
}

export interface RequirementOccurrence {
  readonly id: string;
  readonly identity: string;
  readonly path: string;
  readonly line: number;
}

/** All admitted tree occurrences must be supplied before publication; bands do not exempt duplicates. */
export function requirementCollisions<T extends RequirementOccurrence>(
  occurrences: readonly T[],
): { readonly refused: ReadonlySet<T>; readonly diagnostics: readonly Diagnostic[] } {
  const groups = new Map<string, T[]>();
  for (const occurrence of occurrences) {
    const group = groups.get(occurrence.id);
    if (group) group.push(occurrence);
    else groups.set(occurrence.id, [occurrence]);
  }
  const refused = new Set<T>();
  const diagnostics: Diagnostic[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = group
      .map((occurrence) => ({ occurrence, label: `${occurrence.path}:${occurrence.line} (${occurrence.identity})` }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const labels = ordered.map((entry) => entry.label);
    for (let i = 0; i < ordered.length; i++) {
      const { occurrence } = ordered[i]!;
      refused.add(occurrence);
      diagnostics.push(
        diag(
          'IA-LANG-REQUIREMENT-DUPLICATE',
          occurrence.path,
          occurrence.line,
          `Requirement ${occurrence.id} is also declared at ${summarizeOthers(labels, i)}.`,
          { identity: occurrence.identity },
        ),
      );
    }
  }
  return { refused, diagnostics: sortDiagnostics(diagnostics) };
}
