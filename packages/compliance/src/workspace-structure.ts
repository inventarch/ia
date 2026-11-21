import { canonicalRoot, reaches } from '@inventarch/graph';
import type { Edge, Graph, Node } from '@inventarch/graph';
import { fields } from './graph-checks.js';
import { assess } from './types.js';
import type { Assessment, Finding } from './types.js';

/**
 * The workspace-system's structure checks (REQ-WSSYS-01 to 07, 10, 11, 13), built in the language as dec-020 decided.
 * Each reads one repository's authored `@workspace` records and reports at warning severity only (REQ-WSSYS-13): a
 * finding never refuses a run, and a law enforcing the check does not raise it. What a check cannot see, a parent or a
 * link target in another repository, it reports as `not-checked-here`, never as a pass. Where a trace is named
 * (`second-parent`, `parent-cycle`, `dangling-parent`, `no-second-rule-giver`, `unconfirmed-link`, ...) the message
 * names it right after the location.
 */
export const WORKSPACE_STRUCTURE_CODE = 'IA-COMP-WORKSPACE-STRUCTURE' as const;
export const WORKSPACE_STRUCTURE_CHECKS = Object.freeze({
  /** REQ-WSSYS-01: one governed-by parent, no cycle. */
  parent: 'WORKSPACE-PARENT',
  /** REQ-WSSYS-02: every ancestor's rule roots reach the child. */
  ruleRoots: 'WORKSPACE-RULE-ROOTS',
  /** REQ-WSSYS-03: a shared root is declared by a common ancestor. */
  sharedRoot: 'WORKSPACE-SHARED-ROOT',
  /** REQ-WSSYS-05 and 06: a link counts when declared at both ends, and names a workspace this repository holds. */
  links: 'WORKSPACE-LINKS',
  /** REQ-WSSYS-07: each decides id has one lister. */
  lister: 'WORKSPACE-LISTER',
  /** REQ-WSSYS-10: a source outside a repository is reported unchecked. */
  source: 'WORKSPACE-SOURCE',
  /** REQ-WSSYS-11: the tree is no deeper than the guard. */
  depth: 'WORKSPACE-DEPTH',
});
type CheckId = (typeof WORKSPACE_STRUCTURE_CHECKS)[keyof typeof WORKSPACE_STRUCTURE_CHECKS];

/** The default depth guard of REQ-WSSYS-11, the architect's default; it has no evidence behind it. */
export const DEFAULT_DEPTH_GUARD = 8;
export interface WorkspaceStructureOptions {
  /** The deepest level a tree may reach; `null` turns the guard off. Default {@link DEFAULT_DEPTH_GUARD}. */
  readonly depthGuard?: number | null;
}

const posix = (path: string): string => path.split(String.fromCharCode(92)).join('/');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The repository's own workspace (D02b). */
const OWN_WORKSPACE = '.ia/src/workspace.ia';
const RULE_WORDS: ReadonlySet<string> = new Set(['law', 'principle', 'convention']);
const SOURCE_ENTRY = /^(.+) @([a-z]+)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const DECIDES_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*):\s*\S/;

/** An authored workspace: one of the repository's own `.ia/src`, outside the kit system payloads and the floor. */
const authored = (node: Node): boolean => {
  const path = posix(node.source.path);
  return (
    node.discriminator === 'workspace' &&
    node.placement.kind === 'authored' &&
    path.startsWith('.ia/src/') &&
    !path.startsWith('.ia/src/systems/') &&
    !path.startsWith('.ia/src/floor/')
  );
};

interface Root {
  readonly root: string;
  readonly placement: string;
  readonly line: number;
}
/** The `<root> @<placement>` entries a workspace declares, each root canonical; an entry that reads no root is skipped. */
function declaredRoots(node: Node): readonly Root[] {
  const roots: Root[] = [];
  for (const field of fields(node, 'composition', 'sources'))
    if (field.value.kind === 'list')
      for (const item of field.value.items) {
        if (!('text' in item)) continue;
        const [, root, placement] = SOURCE_ENTRY.exec(item.text) ?? [];
        if (root === undefined || placement === undefined) continue;
        try {
          roots.push({ root: canonicalRoot(root), placement, line: field.span.line });
        } catch {
          // An absolute or escaping root declares nothing; REQ-WSSYS-10 reports it as outside the repository.
        }
      }
  return roots;
}

/** One governed-by row naming a parent, as the child or the parent wrote it. */
interface ParentRow {
  /** The parent's identity when it is an authored workspace of this repository, else null. */
  readonly parent: string | null;
  /** The parent as named. */
  readonly named: string;
  readonly path: string;
  readonly line: number;
}
export interface CountedLink {
  readonly taker: string;
  readonly supplier: string;
}
interface LinkRow extends CountedLink {
  readonly path: string;
  readonly line: number;
  readonly counted: boolean;
  /** Where each end wrote its row. */
  readonly takerWrote: boolean;
  readonly supplierWrote: boolean;
}
interface OpenLink {
  readonly author: string;
  readonly named: string;
  readonly path: string;
  readonly line: number;
}

/** The authored workspaces of a repository and the parent and link rows read from the graph's edges. */
export interface WorkspaceTree {
  readonly workspaces: ReadonlyMap<string, Node>;
  readonly parents: ReadonlyMap<string, readonly ParentRow[]>;
  readonly links: readonly LinkRow[];
  readonly openLinks: readonly OpenLink[];
}
const nameOf = (edge: Edge, nodes: ReadonlyMap<string, Node>, end: 'from' | 'to'): string => {
  const identity = end === 'from' ? edge.from : edge.to;
  if (identity !== null) return nodes.get(identity)?.name ?? identity;
  return edge.reference.kind === 'ref' ? edge.reference.name : edge.reference.identity;
};
const isWorkspaceRef = (edge: Edge): boolean =>
  edge.reference.kind !== 'ref' || edge.reference.discriminator === 'workspace';

export function workspaceTree(nodes: readonly Node[], graph: Graph): WorkspaceTree {
  const workspaces = new Map(nodes.filter(authored).map((node) => [node.identity, node] as const));
  const parents = new Map<string, ParentRow[]>();
  const links: LinkRow[] = [];
  const openLinks: OpenLink[] = [];
  for (const edge of graph.edges) {
    if (edge.predicate === 'govern') {
      const child = edge.to === null ? undefined : workspaces.get(edge.to);
      if (child === undefined) continue;
      const parentNode = edge.from === null ? undefined : graph.nodes.get(edge.from);
      // Only rows whose two ends are workspaces count: a contract's or a policy's govern row is not a parent.
      if (edge.from === null ? !isWorkspaceRef(edge) : parentNode?.discriminator !== 'workspace') continue;
      const assertion = edge.assertions.find((a) => a.author === child.identity) ?? edge.assertions[0] ?? edge;
      const row: ParentRow = {
        parent: edge.from !== null && workspaces.has(edge.from) ? edge.from : null,
        named: nameOf(edge, graph.nodes, 'from'),
        path: assertion.source.path,
        line: assertion.source.line,
      };
      parents.set(child.identity, [...(parents.get(child.identity) ?? []), row]);
    } else if (edge.predicate === 'implement') {
      const takerNode = edge.from === null ? undefined : graph.nodes.get(edge.from);
      const supplierNode = edge.to === null ? undefined : graph.nodes.get(edge.to);
      if (edge.from !== null && edge.to !== null) {
        if (!workspaces.has(edge.from) || !workspaces.has(edge.to) || edge.from === edge.to) continue;
        const takerWrote = edge.assertions.some((a) => a.author === edge.from && a.direction === 'out');
        const supplierWrote = edge.assertions.some((a) => a.author === edge.to && a.direction === 'in');
        const assertion = edge.assertions[0] ?? edge;
        links.push({
          taker: edge.from,
          supplier: edge.to,
          path: assertion.source.path,
          line: assertion.source.line,
          counted: takerWrote && supplierWrote,
          takerWrote,
          supplierWrote,
        });
      } else {
        // One end this repository does not hold (or hold as a workspace): the row cannot be confirmed from here.
        const held = edge.from === null ? supplierNode : takerNode;
        if (held === undefined || !workspaces.has(held.identity) || !isWorkspaceRef(edge)) continue;
        const assertion = edge.assertions[0] ?? edge;
        openLinks.push({
          author: held.identity,
          named: nameOf(edge, graph.nodes, edge.from === null ? 'from' : 'to'),
          path: assertion.source.path,
          line: assertion.source.line,
        });
      }
    }
  }
  return { workspaces, parents, links, openLinks };
}

/** The resolved parents of a workspace, in identity order. */
const parentsOf = (tree: WorkspaceTree, id: string): readonly string[] =>
  [...new Set((tree.parents.get(id) ?? []).flatMap((row) => (row.parent === null ? [] : [row.parent])))].sort(compare);
/** Every ancestor of a workspace the tree holds, nearest first, each once, never the workspace itself. */
export function ancestorsOf(tree: WorkspaceTree, id: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>([id]);
  let level = parentsOf(tree, id);
  while (level.length > 0) {
    const next: string[] = [];
    for (const parent of level) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      found.push(parent);
      next.push(...parentsOf(tree, parent));
    }
    level = next;
  }
  return found;
}
/** Whether the chain above a workspace leaves what this repository holds: a parent row that names no workspace here. */
const leavesRepository = (tree: WorkspaceTree, id: string): boolean =>
  [id, ...ancestorsOf(tree, id)].some((ws) => (tree.parents.get(ws) ?? []).some((row) => row.parent === null));
/** The levels of the longest chain from a workspace to a root, itself counted; a cycle is cut where it closes. */
function depthOf(tree: WorkspaceTree, id: string, visiting: ReadonlySet<string> = new Set()): number {
  const above = parentsOf(tree, id).filter((parent) => !visiting.has(parent));
  const next = new Set([...visiting, id]);
  return 1 + Math.max(0, ...above.map((parent) => depthOf(tree, parent, next)));
}

/** The parent chain of a workspace, nearest first: what the position packet names (REQ-WSSYS-12). */
export function parentChain(tree: WorkspaceTree, id: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let current = parentsOf(tree, id)[0];
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parentsOf(tree, current)[0];
  }
  return chain;
}
/** The links counted at one workspace, either end: declared by the taker and the supplier alike (REQ-WSSYS-05). */
export const countedLinks = (tree: WorkspaceTree, id: string): readonly CountedLink[] =>
  tree.links
    .filter((link) => link.counted && (link.taker === id || link.supplier === id))
    .map(({ taker, supplier }) => ({ taker, supplier }))
    .sort((a, b) => compare(a.taker, b.taker) || compare(a.supplier, b.supplier));

type Report = (check: CheckId, path: string, line: number, identity: string, trace: string, text: string) => void;

/** REQ-WSSYS-01. */
function checkParents(tree: WorkspaceTree, report: Report): void {
  const ids = [...tree.workspaces.keys()].sort(compare);
  for (const id of ids) {
    const node = tree.workspaces.get(id)!;
    const rows = tree.parents.get(id) ?? [];
    const named = new Map(rows.map((row) => [row.named, row] as const));
    if (named.size > 1) {
      const all = [...named.values()];
      report(
        WORKSPACE_STRUCTURE_CHECKS.parent,
        all[1]!.path,
        all[1]!.line,
        id,
        'second-parent',
        `${node.name} has more than one governed-by row: ${all.map((row) => `${row.named} (${row.path}:${row.line})`).join(' and ')}; a workspace has one parent.`,
      );
    }
    for (const row of named.values())
      if (row.parent === null)
        report(
          WORKSPACE_STRUCTURE_CHECKS.parent,
          row.path,
          row.line,
          id,
          'not-checked-here',
          `${node.name} is governed-by ${row.named}, which this repository does not hold as a workspace; its chain above is not checked here, and no pass is claimed for it.`,
        );
    if (rows.length === 0 && posix(node.source.path) !== OWN_WORKSPACE)
      report(
        WORKSPACE_STRUCTURE_CHECKS.parent,
        node.source.path,
        node.source.line,
        id,
        'dangling-parent',
        `${node.name} has no governed-by row and is not the repository's own workspace; name its parent, or the directory must say it is a root.`,
      );
  }
  // A cycle is the workspaces that reach each other through parent rows: reported once, at its first member.
  const reachable = (from: string): ReadonlySet<string> => {
    const seen = new Set<string>();
    const queue = [...parentsOf(tree, from)];
    for (let next = queue.shift(); next !== undefined; next = queue.shift())
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(...parentsOf(tree, next));
      }
    return seen;
  };
  const reach = new Map(ids.map((id) => [id, reachable(id)] as const));
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id) || !reach.get(id)!.has(id)) continue;
    const members = ids.filter((other) => other === id || (reach.get(id)!.has(other) && reach.get(other)!.has(id)));
    for (const member of members) done.add(member);
    const first = tree.workspaces.get(members[0]!)!;
    const row = (tree.parents.get(members[0]!) ?? []).find((r) => r.parent !== null && members.includes(r.parent));
    report(
      WORKSPACE_STRUCTURE_CHECKS.parent,
      row?.path ?? first.source.path,
      row?.line ?? first.source.line,
      members[0]!,
      'parent-cycle',
      `${members.map((member) => tree.workspaces.get(member)!.name).join(' and ')} are each other's ancestors; the parent chain has no root.`,
    );
  }
}

/** A rule a workspace authors itself: not a vocabulary system's payload, nor the floor's. */
const authoredRule = (node: Node): boolean => {
  const path = posix(node.source.path);
  return (
    node.placement.kind === 'authored' && !path.startsWith('.ia/src/systems/') && !path.startsWith('.ia/src/floor/')
  );
};

/**
 * The rule roots of every workspace (the architect's definition in the contract): an `@authored` root a workspace
 * declares that is the longest declared root of at least one authored `@law`, `@principle` or `@convention`. A record
 * belongs to the longest authored root any workspace declares (D02a), so a root that holds only mandates, or laws that
 * another workspace's deeper root holds, is not a rule root of the workspace that declares the shorter one.
 */
function ruleRootsOf(tree: WorkspaceTree, nodes: readonly Node[]): ReadonlyMap<string, readonly string[]> {
  const declared = new Map(
    [...tree.workspaces].map(([id, node]) => [
      id,
      new Set(
        declaredRoots(node)
          .filter((r) => r.placement === 'authored')
          .map((r) => r.root),
      ),
    ]),
  );
  const all = [...new Set([...declared.values()].flatMap((roots) => [...roots]))];
  const held = new Set<string>();
  for (const record of nodes) {
    if (!RULE_WORDS.has(record.discriminator) || !authoredRule(record)) continue;
    const reaching = all.filter((root) => reaches(root, posix(record.source.path)));
    if (reaching.length > 0) held.add(reaching.reduce((best, root) => (root.length > best.length ? root : best)));
  }
  return new Map(
    [...declared].map(([id, roots]) => [id, [...roots].filter((root) => held.has(root)).sort(compare)] as const),
  );
}

/** REQ-WSSYS-02. */
function checkRuleRoots(tree: WorkspaceTree, nodes: readonly Node[], report: Report): void {
  const adoptedRules = nodes.filter((n) => RULE_WORDS.has(n.discriminator) && n.placement.kind === 'adopted').length;
  const roots = ruleRootsOf(tree, nodes);
  for (const [id, node] of [...tree.workspaces].sort(([a], [b]) => compare(a, b))) {
    const declared = new Set(
      declaredRoots(node)
        .filter((root) => root.placement === 'authored')
        .map((root) => root.root),
    );
    const line = fields(node, 'composition', 'sources')[0]?.span.line ?? node.source.line;
    const missing = new Map<string, string[]>();
    for (const ancestor of ancestorsOf(tree, id))
      for (const root of roots.get(ancestor) ?? [])
        if (!declared.has(root)) missing.set(root, [...(missing.get(root) ?? []), tree.workspaces.get(ancestor)!.name]);
    for (const [root, givers] of [...missing].sort(([x], [y]) => compare(x, y)))
      report(
        WORKSPACE_STRUCTURE_CHECKS.ruleRoots,
        node.source.path,
        line,
        id,
        'rules-reach-child',
        `${node.name} does not declare ${root || '.'}, a rule root of its ancestor ${givers.join(' and ')}, so that ancestor's rules do not reach it.`,
      );
    for (const row of (tree.parents.get(id) ?? []).filter((r) => r.parent === null))
      report(
        WORKSPACE_STRUCTURE_CHECKS.ruleRoots,
        row.path,
        row.line,
        id,
        'not-checked-here',
        `The rule roots of ${row.named}, the parent of ${node.name}, and of everything above it, are not read here, and no pass is claimed${
          adoptedRules > 0
            ? `; ${adoptedRules} mounted rule(s) are delivered here by ia read and ia context, listed as pending, and none is reported as met`
            : ''
        }.`,
      );
  }
}

/** REQ-WSSYS-03. */
function checkSharedRoots(tree: WorkspaceTree, report: Report): void {
  const declarers = new Map<string, { root: string; placement: string; ids: Set<string> }>();
  for (const [id, node] of tree.workspaces)
    for (const { root, placement } of declaredRoots(node)) {
      const key = `${root}\0${placement}`;
      const entry = declarers.get(key) ?? { root, placement, ids: new Set<string>() };
      entry.ids.add(id);
      declarers.set(key, entry);
    }
  for (const { root, placement, ids } of [...declarers.values()].sort((a, b) => compare(a.root, b.root))) {
    if (ids.size < 2) continue;
    const all = [...ids].sort(compare);
    const giver = all.some((candidate) =>
      all.every((other) => other === candidate || ancestorsOf(tree, other).includes(candidate)),
    );
    if (giver) continue;
    const first = tree.workspaces.get(all[0]!)!;
    const names = all.map((id) => tree.workspaces.get(id)!.name).join(', ');
    const line = fields(first, 'composition', 'sources')[0]?.span.line ?? first.source.line;
    if (all.some((id) => leavesRepository(tree, id)))
      report(
        WORKSPACE_STRUCTURE_CHECKS.sharedRoot,
        first.source.path,
        line,
        all[0]!,
        'not-checked-here',
        `${names} all declare ${root || '.'} @${placement}; whether one ancestor declares it is not checked here, a parent is in another repository.`,
      );
    else
      report(
        WORKSPACE_STRUCTURE_CHECKS.sharedRoot,
        first.source.path,
        line,
        all[0]!,
        'no-second-rule-giver',
        `${names} all declare ${root || '.'} @${placement}, and none is an ancestor of all the others, so the records in it reach them with no common ancestor to give them.`,
      );
  }
}

/** REQ-WSSYS-05 and 06. */
function checkLinks(tree: WorkspaceTree, report: Report): void {
  const name = (id: string): string => tree.workspaces.get(id)!.name;
  for (const link of [...tree.links].sort((a, b) => compare(a.taker, b.taker) || compare(a.supplier, b.supplier))) {
    if (!link.counted)
      report(
        WORKSPACE_STRUCTURE_CHECKS.links,
        link.path,
        link.line,
        link.takerWrote ? link.taker : link.supplier,
        'unconfirmed-link',
        `${link.takerWrote ? `${name(link.taker)} writes implements ${name(link.supplier)} and ${name(link.supplier)} writes no implemented-by` : `${name(link.supplier)} writes implemented-by ${name(link.taker)} and ${name(link.taker)} writes no implements`}; the link is not counted.`,
      );
    if (ancestorsOf(tree, link.taker).includes(link.supplier))
      report(
        WORKSPACE_STRUCTURE_CHECKS.links,
        link.path,
        link.line,
        link.taker,
        'no-ancestor-link',
        `${name(link.taker)} links to ${name(link.supplier)}, its own ancestor; the parent chain already brings it.`,
      );
  }
  for (const open of [...tree.openLinks].sort((a, b) => compare(a.author, b.author) || compare(a.named, b.named)))
    report(
      WORKSPACE_STRUCTURE_CHECKS.links,
      open.path,
      open.line,
      open.author,
      'not-checked-here',
      `${name(open.author)} has a link naming ${open.named}, which this repository does not hold; a link counts only when both ends are read, which this repository alone cannot do.`,
    );
}

/** REQ-WSSYS-07. */
function checkListers(tree: WorkspaceTree, report: Report): void {
  const listed = new Map<string, { id: string; line: number }[]>();
  for (const [id, node] of tree.workspaces)
    for (const field of fields(node, 'composition', 'decides')) {
      if (field.value.kind !== 'list') continue;
      for (const item of field.value.items) {
        if (!('text' in item)) continue;
        const match = DECIDES_ID.exec(item.text);
        if (match === null)
          report(
            WORKSPACE_STRUCTURE_CHECKS.lister,
            node.source.path,
            field.span.line,
            id,
            'unreadable',
            `${node.name} lists a decides entry with no id ("${item.text}"); one-lister cannot read it, so it is not counted.`,
          );
        else listed.set(match[1]!, [...(listed.get(match[1]!) ?? []), { id, line: field.span.line }]);
      }
    }
  for (const [decides, listers] of [...listed].sort(([a], [b]) => compare(a, b))) {
    const distinct = [...new Set(listers.map((lister) => lister.id))].sort(compare);
    if (distinct.length < 2) continue;
    const names = distinct.map((id) => tree.workspaces.get(id)!.name).join(' and ');
    for (const lister of listers.filter((l, i) => listers.findIndex((o) => o.id === l.id) === i))
      report(
        WORKSPACE_STRUCTURE_CHECKS.lister,
        tree.workspaces.get(lister.id)!.source.path,
        lister.line,
        lister.id,
        'two-listers',
        `${tree.workspaces.get(lister.id)!.name} lists ${decides}, which ${names} both list; each thing decided has one lister.`,
      );
  }
}

/** REQ-WSSYS-10: a source held outside the repository cannot be read here, so it is unchecked, never a pass. */
function checkSources(tree: WorkspaceTree, report: Report): void {
  for (const [id, node] of tree.workspaces)
    for (const field of fields(node, 'composition', 'sources'))
      if (field.value.kind === 'list')
        for (const item of field.value.items) {
          if (!('text' in item)) continue;
          const [, root] = SOURCE_ENTRY.exec(item.text) ?? [];
          let outside = SCHEME.test(item.text);
          if (!outside && root !== undefined)
            try {
              canonicalRoot(root);
            } catch {
              outside = true;
            }
          if (outside)
            report(
              WORKSPACE_STRUCTURE_CHECKS.source,
              node.source.path,
              field.span.line,
              id,
              'unchecked-source',
              `${node.name} names a source outside this repository ("${item.text}"); no reader here reads it, so it is unchecked, and no pass is claimed for it.`,
            );
        }
}

/** REQ-WSSYS-11. */
function checkDepth(tree: WorkspaceTree, guard: number | null, report: Report): void {
  if (guard === null) return;
  for (const [id, node] of [...tree.workspaces].sort(([a], [b]) => compare(a, b))) {
    const depth = depthOf(tree, id);
    if (depth > guard)
      report(
        WORKSPACE_STRUCTURE_CHECKS.depth,
        node.source.path,
        node.source.line,
        id,
        'too-deep',
        `${node.name} is at level ${depth} of its tree, deeper than the guard of ${guard}; levels held in another repository are not counted.`,
      );
  }
}

/**
 * The workspace structure checks as assessments, one per check that has something to say (an assessment with no finding
 * is not added, so a repository with no structure to report keeps its report unchanged). Every finding is a warning.
 */
export function workspaceStructureAssessments(
  nodes: readonly Node[],
  graph: Graph,
  options: WorkspaceStructureOptions = {},
): readonly Assessment[] {
  const tree = workspaceTree(nodes, graph);
  if (tree.workspaces.size === 0) return [];
  const found = new Map<CheckId, Finding[]>();
  const report: Report = (check, path, line, identity, trace, text) => {
    found.set(check, [
      ...(found.get(check) ?? []),
      {
        code: WORKSPACE_STRUCTURE_CODE,
        severity: 'warning',
        path,
        line,
        identity,
        message: `${path}:${line}: ${trace}: ${text}`,
      },
    ]);
  };
  checkParents(tree, report);
  checkRuleRoots(tree, nodes, report);
  checkSharedRoots(tree, report);
  checkLinks(tree, report);
  checkListers(tree, report);
  checkSources(tree, report);
  checkDepth(tree, options.depthGuard === undefined ? DEFAULT_DEPTH_GUARD : options.depthGuard, report);
  return [...found].sort(([a], [b]) => compare(a, b)).map(([check, findings]) => assess(check, 'graph', findings));
}
