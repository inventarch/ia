import { canonicalRoot, claimants, reaches } from '@inventarch/graph';
import type { Claimant, Graph } from '@inventarch/graph';
import { systemMember } from './inputs.js';
import type { DeclaredRoot } from './membership.js';
import type { View } from './view.js';

/** D02b: the seat a path is declared at and the records whose selections claim it. */
export interface SeatResolution {
  /** The canonical workspace-relative path, '' for the workspace root, or the supplied text when it lies outside. */
  readonly path: string;
  /** The identity of the admitted @system or @workspace the path is declared at; absent for a `shared` root. */
  readonly seat?: string;
  /**
   * What declares it: a `system` folder (the floor's for `.ia/src/floor`), a `root` one @workspace declares in
   * `composition.sources`, a `shared` root several declare, or, for a path in no `.ia` tree, the `repository`'s own
   * @workspace.
   */
  readonly by?: 'system' | 'root' | 'shared' | 'repository';
  /**
   * Present exactly when `by` is `shared`: every @workspace in the read's scope that declares the root, each once, in
   * identity order. The path is then seated at no one of them.
   */
  readonly declarers?: readonly string[];
  /** Graph G06c claimants of the path, band descending then identity ascending. */
  readonly claimants: readonly Claimant[];
  /**
   * Present exactly when neither `seat` nor `declarers` is: `outside` when the path is absolute or escapes the
   * workspace, so nothing can claim it either; `undeclared` when no admitted seat in the read's scope declares it.
   */
  readonly unknown?: 'outside' | 'undeclared';
}
const FLOOR = '.ia/src/floor';

/**
 * D02b: the repository's own @workspace, decided once per capture from the root view: the sole admitted @workspace at
 * the init entry point `.ia/src/workspace.ia`; when that file declares none, the one in the repository's `.ia/src`
 * tree that declares a root, else the only @workspace there. Several candidates at the chosen tier leave it unset.
 */
export function repositoryWorkspace(graph: Graph, declared: readonly DeclaredRoot[]): string | undefined {
  const own = (graph.byDiscriminator.get('workspace') ?? []).filter((identity) =>
    graph.nodes.get(identity)!.source.path.startsWith('.ia/src/'),
  );
  const entry = own.filter((identity) => graph.nodes.get(identity)!.source.path === '.ia/src/workspace.ia');
  if (entry.length > 0) return entry.length === 1 ? entry[0] : undefined;
  const declaring = own.filter((identity) => declared.some((root) => root.workspace === identity));
  const candidates = declaring.length > 0 ? declaring : own;
  return candidates.length === 1 ? candidates[0] : undefined;
}
/**
 * D02b: resolve `supplied` in `view`, records outside `allowed` treated as absent. The seat is the first that applies:
 * the admitted @system of the system folder holding the path (`systemMember` of the path or of anything below it, so a
 * folder seats itself; the floor's @system for `.ia/src/floor`), found through the graph's indexes; else the longest
 * D02a root that contains the path, at any placement: the @workspace declaring it, or, when several in scope declare
 * that same root, none of them, the root `shared` by all of its declarers; else, for a path with no `.ia` segment, the
 * repository's own @workspace. Claimants come from the graph's G06c index whatever the seat.
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
  // The capture's order is longest root first, then by workspace identity, so the declarers in scope of the longest
  // root holding the path come in identity order.
  const longest = view.declared.find((declared) => reaches(declared.root, path) && visible(declared.workspace))?.root;
  const declarers = [
    ...new Set(
      view.declared
        .filter((declared) => declared.root === longest && visible(declared.workspace))
        .map((declared) => declared.workspace),
    ),
  ];
  const repository = path.split('/').includes('.ia') ? undefined : view.repository;
  const seat: Pick<SeatResolution, 'seat' | 'by' | 'declarers' | 'unknown'> = visible(system)
    ? { seat: system, by: 'system' }
    : declarers.length > 1
      ? { by: 'shared', declarers: Object.freeze(declarers) }
      : declarers.length === 1
        ? { seat: declarers[0]!, by: 'root' }
        : visible(repository)
          ? { seat: repository, by: 'repository' }
          : { unknown: 'undeclared' };
  return Object.freeze({ path, ...seat, claimants: claimants(graph, path, allowed) });
}
