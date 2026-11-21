import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import { load } from '@inventarch/graph';
import {
  CHECK_IDS,
  COMP_CODES,
  WORKSPACE_STRUCTURE_CHECKS,
  WORKSPACE_STRUCTURE_CODE,
  countedLinks,
  evaluate,
  parentChain,
  workspaceStructureAssessments,
  workspaceTree,
} from '../src/index.js';
import { inputs, records, registry } from './native.js';

// REQ-WSSYS-01 to 03, 05 to 07, 10, 11 and 13 of workspace-system-contract: each case runs its fixture through the
// built-in structure checks. Every finding is a warning.
const location = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
const ADOPTED = {
  placement: { kind: 'adopted' as const, band: 90 as const, reach: '' },
  provenance: 'workspace' as const,
};

type Source = readonly [path: string, text: string, location?: typeof location | typeof ADOPTED | undefined];
function graphOf(...texts: readonly Source[]) {
  const sources = texts.map(([path, text, at]) => ({ path, text: `#! ia 1.0\n${text}`, location: at ?? location }));
  const pass = (pool: typeof records) =>
    sources.flatMap(
      (s) =>
        compile(
          parse(s.text, s.path).ast,
          registry,
          s.location,
          pool.filter((r) => r.source.path !== s.path),
        ).records,
    );
  const compiled = pass([...records, ...pass(records)]);
  return load([...records, ...compiled], registry, {
    sources: [...inputs, ...sources],
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
}
type TestGraph = ReturnType<typeof graphOf>;
const nodesOf = (graph: TestGraph) => [...graph.nodes.values()];

interface Ws {
  readonly name: string;
  readonly path: string;
  readonly sources?: readonly string[];
  readonly relationships?: readonly string[];
  readonly decides?: readonly string[];
}
const list = (items: readonly string[]) => items.map((item) => JSON.stringify(item)).join(', ');
const ws = ({ name, path, sources = [], relationships = [], decides }: Ws): Source => [
  path,
  `@workspace ${name}\n  meaning\n    says "Workspace ${name}."\n    answers "What does ${name} hold?"\n  composition\n    systems [@system workspace-system]\n${
    sources.length > 0 ? `    sources [${list(sources)}]\n` : ''
  }${decides === undefined ? '' : `    decides [${list(decides)}]\n`}${
    relationships.length > 0 ? `  relationships\n${relationships.map((row) => `    ${row}\n`).join('')}` : ''
  }`,
];
const OWN = '.ia/src/workspace.ia';
const at = (name: string) => `.ia/src/scopes/${name}/workspace.ia`;
const rule = (
  kind: 'law' | 'principle' | 'convention',
  name: string,
  path: string,
  at?: typeof location | typeof ADOPTED,
): Source => [
  path,
  `@${kind} ${name}\n  meaning\n    says "Rule ${name}."\n    answers "What does ${name} require?"\n  governance\n    severity advisory\n`,
  at,
];
const mandate = (name: string, path: string, at: typeof location | typeof ADOPTED = location): Source => [
  path,
  `@mandate ${name}\n  meaning\n    says "Mandate ${name}."\n    answers "What may ${name} do?"\n  governance\n    requires "Stay in bounds."\n  authority\n    moves [Observation]\n`,
  at,
];

const found = (graph: TestGraph, check?: string) =>
  workspaceStructureAssessments(nodesOf(graph), graph)
    .filter((a) => check === undefined || a.check === check)
    .flatMap((a) => a.findings);
const traces = (graph: TestGraph, check: string) =>
  found(graph, check).map((f) => /: ([a-z-]+): /.exec(f.message)?.[1]);
const P = WORKSPACE_STRUCTURE_CHECKS.parent;

describe('REQ-WSSYS-01 one governed-by parent, no cycle', () => {
  const chain = graphOf(
    ws({ name: 'organisation', path: OWN }),
    ws({ name: 'engineering', path: at('engineering'), relationships: ['governed-by @workspace organisation'] }),
    ws({ name: 'team', path: at('team'), relationships: ['governed-by @workspace engineering'] }),
  );
  it('wssys-01-chain-ok: no finding, and the chain is named team, engineering, organisation', () => {
    expect(found(chain, P)).toEqual([]);
    const tree = workspaceTree(nodesOf(chain), chain);
    const team = [...tree.workspaces.values()].find((n) => n.name === 'team')!;
    expect(parentChain(tree, team.identity).map((id) => tree.workspaces.get(id)!.name)).toEqual([
      'engineering',
      'organisation',
    ]);
  });
  it('wssys-01-two-parents: second-parent names both rows', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'engineering', path: at('engineering'), relationships: ['governed-by @workspace organisation'] }),
      ws({ name: 'product', path: at('product'), relationships: ['governed-by @workspace organisation'] }),
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'governed-by @workspace product'],
      }),
    );
    const second = found(graph, P);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ code: WORKSPACE_STRUCTURE_CODE, severity: 'warning', path: at('app') });
    expect(second[0]!.message).toMatch(/second-parent: .*engineering.*product/);
  });
  it('wssys-01-cycle: parent-cycle names both workspaces, once', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'a', path: at('a'), relationships: ['governed-by @workspace b'] }),
      ws({ name: 'b', path: at('b'), relationships: ['governed-by @workspace a'] }),
    );
    const cycle = found(graph, P);
    expect(cycle.filter((f) => f.message.includes('parent-cycle'))).toHaveLength(1);
    expect(cycle.find((f) => f.message.includes('parent-cycle'))!.message).toMatch(/a and b/);
  });
  it('wssys-01-parentless: each department of a repository like ia-kb is a dangling-parent, the organisation is not', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'engineering', path: at('engineering') }),
      ws({ name: 'product', path: at('product') }),
      ws({ name: 'upkeep', path: at('upkeep') }),
    );
    const parentless = found(graph, P);
    expect(parentless.map((f) => f.path).sort()).toEqual([at('engineering'), at('product'), at('upkeep')]);
    expect(traces(graph, P)).toEqual(['dangling-parent', 'dangling-parent', 'dangling-parent']);
    expect(parentless.every((f) => f.severity === 'warning')).toBe(true);
  });
  it('wssys-01-generated: a generated or installed workspace is outside the tree', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'installed-distributions', path: '.ia/distributions/installation/workspace.ia' }),
      ws({ name: 'kit-seat', path: '.ia/src/systems/kit-a/records/workspace.ia' }),
    );
    expect(found(graph, P)).toEqual([]);
  });
  it('wssys-01-other-repository and wssys-01-typo: a parent this repository does not hold is not checked here, never a pass', () => {
    const graph = graphOf(
      ws({ name: 'app', path: OWN, relationships: ['governed-by @workspace inventarch-engineering'] }),
    );
    const open = found(graph, P);
    expect(traces(graph, P)).toEqual(['not-checked-here']);
    expect(open[0]!.message).toContain('inventarch-engineering');
    expect(open[0]!.message).not.toContain('dangling-parent');
  });
  it('accepts a parent the parent asserts from its own side (governs), as the grammar allows', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN, relationships: ['governs @workspace engineering'] }),
      ws({ name: 'engineering', path: at('engineering') }),
    );
    expect(found(graph, P)).toEqual([]);
  });
  it("a contract's govern row on a workspace is not a parent", () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'engineering', path: at('engineering'), relationships: ['governed-by @workspace organisation'] }),
      [
        '.ia/src/contract.ia',
        '@contract some-contract\n  meaning\n    says "A contract."\n    answers "What?"\n  relationships\n    governs @workspace engineering\n',
      ],
    );
    expect(found(graph, P)).toEqual([]);
  });
});

describe('REQ-WSSYS-02 every ancestor rule root reaches the child', () => {
  const R = '.ia/src/rules';
  const E = '.ia/src/eng';
  const T = '.ia/src/team';
  const tree = (teamSources: readonly string[], extra: readonly Source[] = []) =>
    graphOf(
      ws({ name: 'organisation', path: OWN, sources: [`${R} @authored`] }),
      ws({
        name: 'engineering',
        path: at('engineering'),
        sources: [`${R} @authored`, `${E} @authored`],
        relationships: ['governed-by @workspace organisation'],
      }),
      ws({
        name: 'team',
        path: at('team'),
        sources: teamSources,
        relationships: ['governed-by @workspace engineering'],
      }),
      rule('law', 'org-law', `${R}/org-law.ia`),
      rule('principle', 'eng-principle', `${E}/eng-principle.ia`),
      rule('convention', 'team-convention', `${T}/team-convention.ia`),
      ...extra,
    );
  const reach = (graph: TestGraph) => found(graph, WORKSPACE_STRUCTURE_CHECKS.ruleRoots);
  it('wssys-02-chain: a team declaring R, E and its own root has no finding', () => {
    expect(reach(tree([`${R} @authored`, `${E} @authored`, `${T} @authored`]))).toEqual([]);
  });
  it("wssys-02-parent-root-missed: the team shares the organisation's root but not engineering's", () => {
    const missed = reach(tree([`${R} @authored`, `${T} @authored`]));
    expect(missed).toHaveLength(1);
    expect(missed[0]!.message).toMatch(/rules-reach-child: team does not declare \.ia\/src\/eng.*engineering/);
  });
  it("wssys-02-grandparent-missed: the team shares engineering's root but not the organisation's", () => {
    const missed = reach(tree([`${E} @authored`, `${T} @authored`]));
    expect(missed).toHaveLength(1);
    expect(missed[0]!.message).toMatch(
      /rules-reach-child: team does not declare \.ia\/src\/rules.*ancestor engineering and organisation/,
    );
  });
  it('wssys-02-mandate-root: a root holding only mandates is not a rule root', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN, sources: ['.ia/src/mandates @authored'] }),
      ws({
        name: 'engineering',
        path: at('engineering'),
        sources: ['.ia/src/eng @authored'],
        relationships: ['governed-by @workspace organisation'],
      }),
      mandate('org-mandate', '.ia/src/mandates/m.ia'),
    );
    expect(reach(graph)).toEqual([]);
  });
  it('wssys-02-adopted: a law that arrived by an adopted mount is not a rule root', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN, sources: ['.ia/src/mandates @authored', 'mount @adopted'] }),
      ws({
        name: 'engineering',
        path: at('engineering'),
        sources: ['.ia/src/eng @authored'],
        relationships: ['governed-by @workspace organisation'],
      }),
      rule('law', 'adopted-law', '.ia/adopted/mount/rev/law.ia', ADOPTED),
    );
    expect(reach(graph)).toEqual([]);
  });
  it('wssys-02-other-repository: an ancestor outside the repository is not checked here and no rule is reported met', () => {
    const graph = graphOf(
      ws({ name: 'app', path: OWN, relationships: ['governed-by @workspace engineering'] }),
      rule('law', 'synced-law', '.ia/adopted/engineering/rev/law.ia', ADOPTED),
    );
    const open = reach(graph);
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toMatch(
      /not-checked-here: .*engineering.*delivered here by ia read and ia context.*none is reported as met/,
    );
    expect(open[0]!.message).not.toMatch(/\bmet\b.*\bis met\b/);
  });
});

describe('REQ-WSSYS-03 a shared root is declared by a common ancestor', () => {
  const S = '.ia/src/shared';
  it('wssys-03-ancestor-declares: the organisation, engineering and product all declare the shared root', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN, sources: [`${S} @authored`] }),
      ws({
        name: 'engineering',
        path: at('engineering'),
        sources: [`${S} @authored`],
        relationships: ['governed-by @workspace organisation'],
      }),
      ws({
        name: 'product',
        path: at('product'),
        sources: [`${S} @authored`],
        relationships: ['governed-by @workspace organisation'],
      }),
    );
    expect(found(graph, WORKSPACE_STRUCTURE_CHECKS.sharedRoot)).toEqual([]);
  });
  it('wssys-03-sibling-root: siblings both declaring a root no ancestor declares are no-second-rule-giver', () => {
    const graph = graphOf(
      ws({ name: 'organisation', path: OWN }),
      ws({
        name: 'engineering',
        path: at('engineering'),
        sources: ['.ia/src/x @authored'],
        relationships: ['governed-by @workspace organisation'],
      }),
      ws({
        name: 'product',
        path: at('product'),
        sources: ['.ia/src/x @authored'],
        relationships: ['governed-by @workspace organisation'],
      }),
    );
    const second = found(graph, WORKSPACE_STRUCTURE_CHECKS.sharedRoot);
    expect(second).toHaveLength(1);
    expect(second[0]!.message).toMatch(/no-second-rule-giver: engineering, product all declare \.ia\/src\/x/);
  });
});

describe('REQ-WSSYS-05 and 06 a link counts only when declared at both ends', () => {
  const L = WORKSPACE_STRUCTURE_CHECKS.links;
  const base = [
    ws({ name: 'organisation', path: OWN }),
    ws({ name: 'engineering', path: at('engineering'), relationships: ['governed-by @workspace organisation'] }),
  ];
  const countedOf = (graph: TestGraph) => {
    const tree = workspaceTree(nodesOf(graph), graph);
    return [...tree.workspaces.keys()].flatMap((id) =>
      countedLinks(tree, id).map(
        (l) => `${tree.workspaces.get(l.taker)!.name}->${tree.workspaces.get(l.supplier)!.name}`,
      ),
    );
  };
  it('wssys-05-both-ends: the link is counted', () => {
    const graph = graphOf(
      ...base,
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'implements @workspace design'],
      }),
      ws({
        name: 'design',
        path: at('design'),
        relationships: ['governed-by @workspace organisation', 'implemented-by @workspace app'],
      }),
    );
    expect(found(graph, L)).toEqual([]);
    expect([...new Set(countedOf(graph))]).toEqual(['app->design']);
  });
  it('wssys-05-taker-only: unconfirmed-link, not counted', () => {
    const graph = graphOf(
      ...base,
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'implements @workspace design'],
      }),
      ws({ name: 'design', path: at('design'), relationships: ['governed-by @workspace organisation'] }),
    );
    expect(traces(graph, L)).toEqual(['unconfirmed-link']);
    expect(countedOf(graph)).toEqual([]);
  });
  it('wssys-05-supplier-only: unconfirmed-link, not counted', () => {
    const graph = graphOf(
      ...base,
      ws({ name: 'app', path: at('app'), relationships: ['governed-by @workspace engineering'] }),
      ws({
        name: 'design',
        path: at('design'),
        relationships: ['governed-by @workspace organisation', 'implemented-by @workspace app'],
      }),
    );
    expect(traces(graph, L)).toEqual(['unconfirmed-link']);
    expect(countedOf(graph)).toEqual([]);
  });
  it('wssys-06-cousin: a link to a cousin, and a parent linking to its descendant, are no finding', () => {
    const graph = graphOf(
      ...base,
      ws({
        name: 'product',
        path: at('product'),
        relationships: ['governed-by @workspace organisation', 'implemented-by @workspace app'],
      }),
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'implements @workspace product'],
      }),
      ws({
        name: 'team',
        path: at('team'),
        relationships: ['governed-by @workspace engineering', 'implemented-by @workspace engineering'],
      }),
      ws({ name: 'engineering2', path: at('engineering2'), relationships: ['governed-by @workspace organisation'] }),
    );
    expect(traces(graph, L).filter((t) => t === 'no-ancestor-link')).toEqual([]);
  });
  it('wssys-06-ancestor: no-ancestor-link when a workspace links to its own ancestor', () => {
    const graph = graphOf(
      ...base,
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'implements @workspace organisation'],
      }),
    );
    expect(traces(graph, L)).toContain('no-ancestor-link');
  });
  it('wssys-06-other-repository: a link naming a workspace this repository does not hold is not checked here', () => {
    const graph = graphOf(
      ...base,
      ws({
        name: 'app',
        path: at('app'),
        relationships: ['governed-by @workspace engineering', 'implements @workspace design'],
      }),
    );
    const open = found(graph, L);
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toMatch(/not-checked-here: app has a link naming design/);
    expect(countedOf(graph)).toEqual([]);
  });
});

describe('REQ-WSSYS-07 each decides id has one lister', () => {
  const Lister = WORKSPACE_STRUCTURE_CHECKS.lister;
  it('wssys-07-one-each: no finding', () => {
    const graph = graphOf(
      ws({ name: 'product', path: OWN, decides: ['what-is-built: Product decides what is built.'] }),
      ws({ name: 'design', path: at('design'), decides: ['how-it-looks: Design decides how it looks.'] }),
    );
    expect(found(graph, Lister)).toEqual([]);
  });
  it('wssys-07-two-listers: both workspaces are reported', () => {
    const graph = graphOf(
      ws({ name: 'product', path: OWN, decides: ['what-is-built: Product decides what is built.'] }),
      ws({ name: 'design', path: at('design'), decides: ['what-is-built: Design thinks it decides this too.'] }),
    );
    const two = found(graph, Lister);
    expect(two.map((f) => f.path).sort()).toEqual([at('design'), OWN]);
    expect(traces(graph, Lister)).toEqual(['two-listers', 'two-listers']);
    expect(two[0]!.message).toContain('design and product');
  });
  it('wssys-07-no-id: an entry written as a sentence with no id is unreadable and not counted', () => {
    const graph = graphOf(
      ws({ name: 'product', path: OWN, decides: ["What gets created is product's call"] }),
      ws({ name: 'design', path: at('design'), decides: ["What gets created is product's call"] }),
    );
    expect(traces(graph, Lister)).toEqual(['unreadable', 'unreadable']);
  });
});

describe('REQ-WSSYS-10 a source outside a repository is unchecked', () => {
  it('wssys-10-offline and wssys-10-no-reader: a source named by a scheme is unchecked-source, the repository records are checked', () => {
    const graph = graphOf(
      ws({
        name: 'design',
        path: OWN,
        sources: ['.ia/src @authored', 'figma://file/abc @open', '../outside @authored'],
      }),
    );
    const outside = found(graph, WORKSPACE_STRUCTURE_CHECKS.source);
    expect(outside).toHaveLength(2);
    expect(outside.every((f) => f.message.includes('unchecked-source'))).toBe(true);
  });
  it('an ordinary source root is not reported', () => {
    const graph = graphOf(ws({ name: 'design', path: OWN, sources: ['.ia/src @authored', '. @authored'] }));
    expect(found(graph, WORKSPACE_STRUCTURE_CHECKS.source)).toEqual([]);
  });
});

describe('REQ-WSSYS-11 a tree deeper than the guard is too-deep', () => {
  const levels = (count: number) =>
    graphOf(
      ...Array.from({ length: count }, (_, i) =>
        ws({
          name: `level-${i + 1}`,
          path: i === 0 ? OWN : at(`level-${i + 1}`),
          relationships: i === 0 ? [] : [`governed-by @workspace level-${i}`],
        }),
      ),
    );
  const depth = (graph: TestGraph, depthGuard?: number | null) =>
    workspaceStructureAssessments(nodesOf(graph), graph, depthGuard === undefined ? {} : { depthGuard })
      .filter((a) => a.check === WORKSPACE_STRUCTURE_CHECKS.depth)
      .flatMap((a) => a.findings);
  it('wssys-11-within: a five-level tree and the default guard of 8 give no finding', () => {
    expect(depth(levels(5))).toEqual([]);
    expect(depth(levels(8))).toEqual([]);
  });
  it('wssys-11-too-deep: a nine-level tree is reported once', () => {
    const deep = depth(levels(9));
    expect(deep).toHaveLength(1);
    expect(deep[0]!.message).toMatch(/too-deep: level-9 is at level 9 of its tree, deeper than the guard of 8/);
  });
  it('a configured guard replaces the default, and null turns it off', () => {
    expect(depth(levels(5), 3)).toHaveLength(2);
    expect(depth(levels(9), null)).toEqual([]);
  });
  it('reads the guard from the report options', () => {
    const graph = levels(5);
    expect(
      evaluate(graph, { workspaceDepthGuard: 3 }).findings.filter((f) => f.message.includes('too-deep')),
    ).toHaveLength(2);
  });
});

describe('REQ-WSSYS-13 a new structure check warns first', () => {
  const broken = graphOf(
    ws({ name: 'organisation', path: OWN, decides: ['x: One.'] }),
    ws({ name: 'engineering', path: at('engineering'), decides: ['x: Two.'] }),
    ws({ name: 'product', path: at('product'), relationships: ['implements @workspace engineering'] }),
  );
  it('wssys-13-warns: findings are warnings, the report does not fail on them', () => {
    const report = evaluate(broken);
    const own = report.findings.filter((f) => f.code === WORKSPACE_STRUCTURE_CODE);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((f) => f.severity === 'warning')).toBe(true);
    expect(report.verdicts.filter((v) => v.check.startsWith('WORKSPACE-')).every((v) => v.outcome === 'pass')).toBe(
      true,
    );
  });
  it('wssys-13-warns: a blocking law that enforces a structure check does not raise it to an error', () => {
    const law =
      '@law structure-law\n  meaning\n    says "Structure."\n    answers "What?"\n  governance\n    severity blocking\n  relationships\n    enforced-by @check structure-check\n';
    const check = `@check structure-check\n  meaning\n    says "Runs."\n    answers "What?"\n  check\n    runs ${P}\n    scope "fixture"\n`;
    const graph = graphOf(
      ['.ia/src/law.ia', law],
      ['.ia/src/check.ia', check],
      ws({ name: 'organisation', path: OWN }),
      ws({ name: 'engineering', path: at('engineering') }),
    );
    expect(
      evaluate(graph)
        .findings.filter((f) => f.code === WORKSPACE_STRUCTURE_CODE)
        .map((f) => f.severity),
    ).toEqual(['warning']);
  });
  it('wssys-13-ships-refusing: no structure check ships as a refusal, and each id is a built-in', () => {
    const found = workspaceStructureAssessments(nodesOf(broken), broken).flatMap((a) => a.findings);
    expect(found.filter((f) => f.severity !== 'warning')).toEqual([]);
    for (const id of Object.values(WORKSPACE_STRUCTURE_CHECKS)) expect(CHECK_IDS).toContain(id);
    expect(COMP_CODES).toContain(WORKSPACE_STRUCTURE_CODE);
  });
  it('a repository with no workspace structure to report keeps its report unchanged', () => {
    expect(evaluate(graphOf()).verdicts.filter((v) => v.check.startsWith('WORKSPACE-'))).toEqual([]);
  });
});
