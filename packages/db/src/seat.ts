import { canonicalRoot, claimants, reaches } from '@inventarch/graph';
import type { Claimant, Graph } from '@inventarch/graph';
import { systemMember } from './inputs.js';
import type { DeclaredRoot } from './membership.js';
import type { View } from './view.js';

/** D02b (position-and-projection row 17): the seat a path is declared at and the records whose selections claim it. */
export interface SeatResolution {
  /** The canonical workspace-relative path, '' for the workspace root, or the supplied text when it lies outside. */
  readonly path: string;
  /** The identity of the admitted @system or @workspace the path is declared at. */
  readonly seat?: string;
  /**
   * What declares it: a `system` folder (the floor's for `.ia/src/floor`), a `root` the @workspace declares in
   * `composition.sources`, or, for a path in no `.ia` tree, the `repository`'s own @workspace.
   */
  readonly by?: 'system' | 'root' | 'repository';
  /** Graph G06c claimants of the path, band descending then identity ascending. */
  readonly claimants: readonly Claimant[];
  /**
   * Present exactly when `seat` is absent: `outside` when the path is absolute or escapes the workspace, so nothing can
   * claim it either; `undeclared` when no admitted seat in the read's scope declares it.
   */
  readonly unknown?: 'outside' | 'undeclared';
}
const FLOOR = '.ia/src/floor';

/**
 * D02b: the repository's own @workspace, decided once per capture from the root view: the one admitted @workspace in
 * the repository's `.ia/src` tree that declares a root, else the only @workspace there. None or several leave it unset.
 */
export function repositoryWorkspace(graph: Graph, declared: readonly DeclaredRoot[]): string | undefined {
  const own = (graph.byDiscriminator.get('workspace') ?? []).filter((identity) =>
    graph.nodes.get(identity)!.source.path.startsWith('.ia/src/'),
  );
  const declaring = own.filter((identity) => declared.some((root) => root.workspace === identity));
  const candidates = declaring.length > 0 ? declaring : own;
  return candidates.length === 1 ? candidates[0] : undefined;
}
/**
 * D02b: resolve `supplied` in `view`, records outside `allowed` treated as absent. The seat is the first that applies:
 * the admitted @system of the system folder holding the path (`systemMember` of the path or of anything below it, so a
 * folder seats itself; the floor's @system for `.ia/src/floor`), found through the graph's indexes; else the @workspace
 * declaring the first D02a root that contains the path, at any placement, in the capture's order (longest first, then
 * by workspace identity); else, for a path with no `.ia` segment, the repository's own @workspace. Claimants come from
 * the graph's G06c index whatever the seat.
 */
export function seatOf(
  view: Pick<View, 'graph' | 'declared' | 'repository'>,
  supplied: string,
  allowed?: ReadonlySet<string>,
): SeatResolution {
  let path: string;
  try {
    path = canonicalRoot(supplied);
  } catch {
    return Object.freeze({ path: supplied, unknown: 'outside' as const, claimants: Object.freeze([]) });
  }
  const graph = view.graph,
    visible = (identity: string | undefined): identity is string =>
      identity !== undefined && graph.nodes.has(identity) && (allowed === undefined || allowed.has(identity));
  const folder = systemMember(`${path}/`)?.name;
  const system =
    folder !== undefined
      ? graph.byName.get(folder)?.find((identity) => graph.nodes.get(identity)!.discriminator === 'system')
      : reaches(FLOOR, path)
        ? graph.byDiscriminator.get('system')?.find((identity) => {
            const source = graph.nodes.get(identity)!.source.path;
            return source.slice(0, source.lastIndexOf('/')) === FLOOR;
          })
        : undefined;
  const root = view.declared.find((declared) => reaches(declared.root, path) && visible(declared.workspace))?.workspace;
  const repository = path.split('/').includes('.ia') ? undefined : view.repository;
  const seat: Pick<SeatResolution, 'seat' | 'by' | 'unknown'> = visible(system)
    ? { seat: system, by: 'system' }
    : root !== undefined
      ? { seat: root, by: 'root' }
      : visible(repository)
        ? { seat: repository, by: 'repository' }
        : { unknown: 'undeclared' };
  return Object.freeze({ path, ...seat, claimants: claimants(graph, path, allowed) });
}
