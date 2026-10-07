import { isPlacementKind } from '@inventarch/language';
import type { Band, PlacementKind } from '@inventarch/language';
import { canonicalRoot, reaches } from '@inventarch/graph';
import type { Graph, Node } from '@inventarch/graph';
import { systemMember } from './inputs.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** D02a capture membership: one admitted record, the root it was captured under, its band and graph G13 digest. */
export interface MembershipRow {
  readonly identity: string;
  readonly root: string;
  readonly band: Band;
  readonly digest: string;
}
/** A root an admitted @workspace declares in `composition.sources`, at the placement the entry names. */
export interface DeclaredRoot {
  readonly root: string;
  readonly placement: PlacementKind;
  /** The identity of the declaring @workspace: the seat of a path under the root (D02b). */
  readonly workspace: string;
}
/**
 * D02a: the directory above the `.ia/src` tree a source was captured from, '' for the repository's own tree. An
 * installed package's is its store directory; an adopted mount's is the `.ia/adopted/<id>/<revision>` label its sources
 * carry, which is no directory (`adoptedBindings` names the directory bound to it).
 */
export function sourceTree(path: string): string {
  const at = path.indexOf('/.ia/src/');
  return path.startsWith('.ia/src/') || at < 0 ? '' : path.slice(0, at);
}
/**
 * D02a: each `<root> @<placement>` entry of the @workspace records `graph` admits, read relative to the tree that holds
 * the declaring record, so an adopted or installed workspace speaks only for its own mount, longest root first, then
 * by declaring workspace identity. Other text, an absolute root or one escaping that tree declares nothing.
 */
export function declaredRoots(graph: Graph): readonly DeclaredRoot[] {
  return Object.freeze(
    (graph.byDiscriminator.get('workspace') ?? [])
      .map((identity) => graph.nodes.get(identity)!)
      .flatMap((node) =>
        node.sections
          .filter((section) => section.name === 'composition')
          .flatMap((section) => section.fields)
          .flatMap((field) =>
            'key' in field && field.key === 'sources' && field.value.kind === 'list' ? field.value.items : [],
          )
          .flatMap((item) => {
            const [, root, placement] = ('text' in item ? /^(.+) @([a-z]+)$/.exec(item.text) : null) ?? [];
            if (root === undefined || placement === undefined || !isPlacementKind(placement)) return [];
            let relative: string;
            try {
              relative = canonicalRoot(root);
            } catch {
              return [];
            }
            return [
              {
                root: [sourceTree(node.source.path), relative].filter(Boolean).join('/'),
                placement,
                workspace: node.identity,
              },
            ];
          }),
      )
      .sort((a, b) => b.root.length - a.root.length || compare(a.workspace, b.workspace)),
  );
}
/**
 * D02a: a record's root is the longest `declared` root that contains its source path at the record's own placement,
 * which makes it a member of each @workspace declaring that root. Otherwise it keeps its system seat, the system folder
 * `systemMember` reads from the path (local, package, adopted or installed); a floor source is rooted at
 * `.ia/src/floor`, and any other source outside every system folder (the generated installation workspace) at its
 * directory. Rows follow `nodes`.
 */
export function membershipOf(nodes: readonly Node[], declared: readonly DeclaredRoot[]): readonly MembershipRow[] {
  return Object.freeze(
    nodes.map((node) => {
      const path = node.source.path;
      return Object.freeze({
        identity: node.identity,
        root:
          declared.find((d) => d.placement === node.placement.kind && reaches(d.root, path))?.root ??
          systemMember(path)?.root ??
          (path.startsWith('.ia/src/floor/') ? '.ia/src/floor' : path.slice(0, Math.max(0, path.lastIndexOf('/')))),
        band: node.band,
        digest: node.digest,
      });
    }),
  );
}
