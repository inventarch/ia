import { VERB_PHRASES, verbOf } from '@ia/language';
import type { Kind, Predicate } from '@ia/language';
import { validateCoordinate } from './coordinate.js';
import type { Coordinate } from './coordinate.js';
import { GraphUsageError } from './diagnostics.js';
import { snapshot } from './immutable.js';
import { edgeOrder } from './load.js';
import { conditionHolds } from './queries.js';
import { compare, stableSerialize } from './revision.js';
import type { Edge, Graph } from './types.js';

export interface TraverseOptions {
  readonly start: readonly string[];
  readonly follow?: readonly string[];
  readonly direction?: 'out' | 'in' | 'both';
  readonly depth?: number;
  readonly filter?: { readonly kind?: Kind; readonly discriminator?: string; readonly system?: string };
  readonly coordinate?: Coordinate;
  readonly scope?: ReadonlySet<string>;
  /** Optional work bounds; omission preserves the complete traversal contract. */
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}
export interface Via {
  readonly from: string;
  readonly predicate: Predicate;
  readonly direction: 'out' | 'in';
  readonly target: string;
}
export interface WalkNode {
  readonly identity: string;
  readonly depth: number;
}
export interface Traversal {
  readonly nodes: readonly WalkNode[];
  readonly via: readonly Via[];
  readonly edges: readonly Edge[];
  readonly gated: readonly Edge[];
  readonly dangling: readonly Edge[];
  readonly truncated?: boolean;
}

export function traverse(graph: Graph, options: TraverseOptions): Traversal {
  for (const limit of [options.maxNodes, options.maxEdges])
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new GraphUsageError('IA-GRAPH-TRAVERSAL-INVALID', 'Traversal limits must be positive integers');
  let truncated = false,
    examined = 0;
  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 0 || depth > 8)
    throw new GraphUsageError('IA-GRAPH-TRAVERSAL-INVALID', 'Traversal depth must be an integer from 0 to 8');
  const direction = options.direction ?? 'both';
  if (options.follow === undefined && !['out', 'in', 'both'].includes(direction))
    throw new GraphUsageError('IA-GRAPH-TRAVERSAL-INVALID', `Unknown direction '${direction}'`);
  const followed = options.follow?.map((phrase) => {
    const verb = verbOf(phrase);
    if (verb === undefined)
      throw new GraphUsageError(
        'IA-GRAPH-VERB-UNKNOWN',
        `Unknown verb '${phrase}'; admitted: ${VERB_PHRASES.join(', ')}`,
      );
    return verb;
  });
  const coordinate = options.coordinate === undefined ? undefined : validateCoordinate(options.coordinate);
  const admitted = (id: string): boolean => {
    const node = graph.nodes.get(id),
      filter = options.filter;
    return (
      node !== undefined &&
      (options.scope === undefined || options.scope.has(id)) &&
      (filter?.kind === undefined || node.kind === filter.kind) &&
      (filter?.discriminator === undefined || node.discriminator === filter.discriminator) &&
      (filter?.system === undefined || node.system === filter.system)
    );
  };
  const depths = new Map<string, number>();
  let frontier = [...new Set(options.start)].filter(admitted).sort(compare);
  if (options.maxNodes !== undefined && frontier.length > options.maxNodes) {
    frontier = frontier.slice(0, options.maxNodes);
    truncated = true;
  }
  for (const id of frontier) depths.set(id, 0);
  const edges = new Map<string, Edge>(),
    gated = new Map<string, Edge>(),
    dangling = new Map<string, Edge>(),
    via = new Map<string, Via>();
  walk: for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next = new Set<string>();
    for (const id of frontier)
      for (const dir of ['out', 'in'] as const) {
        if (followed === undefined && direction !== 'both' && direction !== dir) continue;
        for (const [predicate, adjacent] of (dir === 'out' ? graph.out : graph.in).get(id) ?? []) {
          if (followed !== undefined && !followed.some((v) => v.direction === dir && v.predicate === predicate))
            continue;
          for (const edge of adjacent) {
            if (
              options.maxEdges !== undefined &&
              (edges.size + gated.size + dangling.size >= options.maxEdges || ++examined > options.maxEdges * 4)
            ) {
              truncated = true;
              break walk;
            }
            const target = dir === 'out' ? edge.to : edge.from;
            // Prune before emitting even a gated edge: it must not reveal an excluded endpoint.
            if (target !== null && !admitted(target)) continue;
            if (
              target !== null &&
              !depths.has(target) &&
              options.maxNodes !== undefined &&
              depths.size >= options.maxNodes
            ) {
              truncated = true;
              continue;
            }
            const key = stableSerialize(edge);
            if (
              coordinate !== undefined &&
              !conditionHolds(edge.condition, graph.nodes.get(edge.conditionSubject)!.dimensions, coordinate)
            ) {
              gated.set(key, edge);
              continue;
            }
            if (target === null) {
              dangling.set(key, edge);
              continue;
            }
            edges.set(key, edge);
            if (depths.has(target) && depths.get(target) !== level) continue;
            const hop: Via = { from: id, predicate, direction: dir, target };
            via.set(stableSerialize(hop), hop);
            if (!depths.has(target)) {
              depths.set(target, level);
              next.add(target);
            }
          }
        }
      }
    frontier = [...next].sort(compare);
  }
  return snapshot({
    nodes: [...depths]
      .map(([identity, depth]) => ({ identity, depth }))
      .sort((a, b) => a.depth - b.depth || compare(a.identity, b.identity)),
    via: [...via.values()].sort(
      (a, b) =>
        compare(a.from, b.from) ||
        compare(a.predicate, b.predicate) ||
        compare(a.direction, b.direction) ||
        compare(a.target, b.target),
    ),
    edges: [...edges.values()].sort(edgeOrder),
    gated: [...gated.values()].sort(edgeOrder),
    dangling: [...dangling.values()].sort(edgeOrder),
    ...(options.maxNodes === undefined && options.maxEdges === undefined ? {} : { truncated }),
  });
}
