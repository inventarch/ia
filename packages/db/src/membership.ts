import type { Band, CompiledValue, PlacementKind } from '@inventarch/language';
import { canonicalRoot } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { systemMember } from './inputs.js';

/**
 * One admitted record's capture membership (D13). `seat` is the identity of the @workspace or @system the record
 * belongs to, or null when no rule names one (the synthetic workspace closure); `root` is the source root it was
 * captured under; `digest` is the graph per-record source digest (G13).
 */
export interface MembershipRow {
  readonly identity: string;
  readonly seat: string | null;
  readonly root: string;
  readonly placement: PlacementKind;
  readonly band: Band;
  readonly digest: string;
}
interface Declared {
  readonly root: string;
  readonly placement: string;
  readonly seat: string;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const DECLARED = /^(\S+)\s+@([a-z]+)$/;
const contains = (root: string, path: string): boolean => root === '' || path.startsWith(`${root}/`);

/** `composition.sources` entries, spelled `<root> @<placement>`; a malformed or unsafe entry declares nothing. */
function declaredRoots(workspace: Node): Declared[] {
  const texts = (value: CompiledValue | undefined): string[] =>
    value === undefined
      ? []
      : value.kind === 'list'
        ? value.items.flatMap(texts)
        : value.kind === 'string' || value.kind === 'scalar' || value.kind === 'prose'
          ? [value.text]
          : [];
  return workspace.sections
    .filter((section) => section.name === 'composition')
    .flatMap((section) => section.fields)
    .flatMap((child) =>
      'key' in child && child.key === 'sources'
        ? [...texts(child.value), ...(child.fields ?? []).flatMap((item) => ('item' in item ? texts(item.item) : []))]
        : [],
    )
    .flatMap((entry) => {
      const match = DECLARED.exec(entry.trim());
      if (match === null) return [];
      try {
        return [{ root: canonicalRoot(match[1]!), placement: match[2]!, seat: workspace.identity }];
      } catch {
        return [];
      }
    });
}
/** The source root a placement captures a path under when nothing declares one: the nearest `.ia/src` (or its `floor`). */
function placementRoot(node: Node): string {
  const path = node.source.path,
    at = path.startsWith('.ia/src/') ? 0 : path.lastIndexOf('/.ia/src/');
  if (at < 0) return '';
  const base = at === 0 ? '.ia/src' : `${path.slice(0, at)}/.ia/src`;
  return node.placement.kind === 'floor' && path.startsWith(`${base}/floor/`) ? `${base}/floor` : base;
}
/**
 * Membership over a view's admitted winners, one row per node, ordered by identity. Seats come from every admitted
 * @workspace and @system in `admitted`, so a scoped read sees the same seat as an unscoped one. Rules, first match:
 * 1. the longest declared `composition.sources` root containing the path, at the record's placement (ties: workspace
 *    identity ascending) gives that workspace, root = the declared root;
 * 2. an adopted or installed path inside a system folder gives that admitted @system, root = the system folder;
 * 3. an authored record, when exactly one @workspace is admitted, gives that workspace, root = the placement root;
 * 4. otherwise seat null, root = the placement root.
 * Runtime (band 0) records are never members.
 */
export function membershipOf(admitted: Iterable<Node>, members: Iterable<Node>): readonly MembershipRow[] {
  const all = [...admitted],
    workspaces = all
      .filter((node) => node.discriminator === 'workspace')
      .sort((a, b) => compare(a.identity, b.identity)),
    declared = workspaces.flatMap(declaredRoots),
    systems = new Map(all.filter((node) => node.discriminator === 'system').map((node) => [node.name, node.identity]));
  const rows = [...members]
    .filter((node) => node.placement.kind !== 'runtime')
    .map((node): MembershipRow => {
      const path = node.source.path,
        claim = declared
          .filter((entry) => entry.placement === node.placement.kind && contains(entry.root, path))
          .sort((a, b) => b.root.length - a.root.length || compare(a.seat, b.seat))[0];
      const seated = (() => {
        if (claim !== undefined) return { seat: claim.seat, root: claim.root };
        const member = node.placement.kind === 'adopted' ? systemMember(path) : undefined;
        if (member !== undefined) return { seat: systems.get(member.name) ?? null, root: member.root };
        const root = placementRoot(node);
        return node.placement.kind === 'authored' && workspaces.length === 1
          ? { seat: workspaces[0]!.identity, root }
          : { seat: null, root };
      })();
      return Object.freeze({
        identity: node.identity,
        ...seated,
        placement: node.placement.kind,
        band: node.band,
        digest: node.digest,
      });
    })
    .sort((a, b) => compare(a.identity, b.identity));
  return Object.freeze(rows);
}
