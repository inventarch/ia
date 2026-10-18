import type { ReadHandle } from '@inventarch/db';
import type { DirectedEdgeRow } from '@inventarch/graph';
import { digest, frozen } from './format.js';
export interface KnowledgeEdge {
  readonly from: string;
  readonly predicate: string;
  readonly to: string;
  readonly declaredOn: string;
  readonly fragment?: string;
  readonly fragmentOn?: string;
  readonly condition?: DirectedEdgeRow['condition'];
}
/** Preserve native resolved direction and declaration semantics, pruning both endpoints before projection. */
export function selectedEdges(reader: ReadHandle, identities: readonly string[]): readonly KnowledgeEdge[] {
  const scope = reader.resolveScope({ identities }).token,
    rows = new Map<string, KnowledgeEdge>();
  for (const from of [...identities].sort())
    for (const row of reader.directedView(from, { within: scope })) {
      if (row.kind === 'field-ref' || row.direction !== 'out') continue;
      const edge = {
        from,
        predicate: row.predicate,
        to: row.counterpart,
        declaredOn: row.declaredOn,
        ...(row.fragment === undefined
          ? {}
          : { fragment: row.fragment, fragmentOn: row.declaredOn === from ? row.counterpart : from }),
        ...(row.condition === undefined ? {} : { condition: row.condition }),
      };
      rows.set(digest(edge), edge);
    }
  return frozen([...rows.values()]);
}
