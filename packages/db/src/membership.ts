import { PLACEMENT_KINDS, isPlacementKind } from '@inventarch/language';
import type { Band, CompiledValue, PlacementKind } from '@inventarch/language';
import { canonicalRoot, matchesSelection } from '@inventarch/graph';
import type { Claim, Graph, InvalidClaim, Node } from '@inventarch/graph';
import { DbError } from './errors.js';
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
const texts = (value: CompiledValue | undefined): string[] =>
  value === undefined
    ? []
    : value.kind === 'list'
      ? value.items.flatMap(texts)
      : value.kind === 'string' || value.kind === 'scalar' || value.kind === 'prose'
        ? [value.text]
        : [];

/**
 * `composition.sources` entries, spelled `<root> @<placement>` with a workspace-relative root and one of the closed
 * placements. A malformed or unsafe entry refuses with IA-DB-SOURCES-INVALID naming the record, its line and the entry,
 * because silently reading less would seat records and paths in the wrong workspace.
 */
function declaredRoots(workspace: Node): Declared[] {
  return workspace.sections
    .filter((section) => section.name === 'composition')
    .flatMap((section) => section.fields)
    .flatMap((child) =>
      'key' in child && child.key === 'sources'
        ? [
            ...texts(child.value),
            ...(child.fields ?? []).flatMap((item) => ('item' in item ? texts(item.item) : [])),
          ].map((entry) => ({ entry, line: child.span.line }))
        : [],
    )
    .map(({ entry, line }) => {
      const refuse = (reason: string): never => {
        throw new DbError(
          'IA-DB-SOURCES-INVALID',
          `${workspace.identity} at ${workspace.source.path}:${line} declares composition.sources entry ${JSON.stringify(entry)}, which ${reason}; each entry is spelled <root> @<placement>, for example ".ia/src @authored"`,
        );
      };
      const match = DECLARED.exec(entry.trim());
      if (match === null) return refuse('is not <root> @<placement>');
      if (!isPlacementKind(match[2]!))
        return refuse(`names no placement; the placement is one of ${PLACEMENT_KINDS.join(', ')}`);
      let root: string;
      try {
        root = canonicalRoot(match[1]!);
      } catch {
        return refuse('has a root outside the workspace; the root is workspace-relative');
      }
      return { root, placement: match[2]!, seat: workspace.identity };
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

/** Where a location seat sits (D15): a system folder's @system, else a @workspace; identity null when none is admitted. */
export type Seat =
  | { readonly kind: 'system'; readonly name: string; readonly identity: string | null }
  | { readonly kind: 'workspace'; readonly identity: string | null };
/**
 * A path resolved as a location seat (D15): its seat, the records whose source lies at or under it (`declared`), the
 * claims whose selection matches it (`claimants`, band descending then identity), the claims whose selection cannot be
 * read (`invalid`), and `unknown` naming the path when nothing is declared there or claims it.
 */
export interface SeatResolution {
  readonly path: string;
  readonly seat: Seat;
  readonly declared: readonly string[];
  readonly claimants: readonly Claim[];
  readonly invalid: readonly InvalidClaim[];
  readonly unknown?: string;
}
const claimantOrder = (a: Claim, b: Claim): number =>
  b.band - a.band ||
  compare(a.identity, b.identity) ||
  compare(a.field, b.field) ||
  compare(a.selection, b.selection) ||
  a.source.line - b.source.line;
/**
 * D15 over a view's graph. The seat, first match: (1) a path in a system folder (`systemMember`, the folder itself
 * included) is that @system; (2) the longest `composition.sources` root containing the path, at any placement, is its
 * @workspace (ties: identity ascending); (3) exactly one admitted @workspace; (4) the synthetic workspace closure.
 * Seats are view-wide; `declared`, `claimants` and `invalid` hold only identities `allowed` admits.
 */
export function seatOf(graph: Graph, path: string, allowed?: ReadonlySet<string>): SeatResolution {
  const all = [...graph.nodes.values()],
    visible = (identity: string) => allowed === undefined || allowed.has(identity),
    workspaces = all
      .filter((node) => node.discriminator === 'workspace')
      .sort((a, b) => compare(a.identity, b.identity)),
    declaredRootsAll = workspaces.flatMap(declaredRoots);
  const member = systemMember(path) ?? systemMember(`${path}/`);
  const seat: Seat = (() => {
    if (member !== undefined) {
      const system = all.find((node) => node.discriminator === 'system' && node.name === member.name);
      return { kind: 'system', name: member.name, identity: system?.identity ?? null };
    }
    const claim = declaredRootsAll
      .filter((entry) => entry.root === path || contains(entry.root, path))
      .sort((a, b) => b.root.length - a.root.length || compare(a.seat, b.seat))[0];
    if (claim !== undefined) return { kind: 'workspace', identity: claim.seat };
    return { kind: 'workspace', identity: workspaces.length === 1 ? workspaces[0]!.identity : null };
  })();
  const declared = all
    .filter((node) => visible(node.identity) && (node.source.path === path || contains(path, node.source.path)))
    .map((node) => node.identity)
    .sort(compare);
  const claimants = graph.claims
    .filter((claim) => visible(claim.identity) && matchesSelection(path, claim.selection))
    .sort(claimantOrder);
  const invalid = graph.invalidClaims.filter((claim) => visible(claim.identity));
  return Object.freeze({
    path,
    seat: Object.freeze(seat),
    declared: Object.freeze([...new Set(declared)]),
    claimants: Object.freeze(claimants),
    invalid: Object.freeze([...invalid]),
    ...(declared.length === 0 && claimants.length === 0 ? { unknown: `no record claims ${path}` } : {}),
  });
}
