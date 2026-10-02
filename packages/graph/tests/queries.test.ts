import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@ia/language';
import type { Location } from '@ia/language';
import {
  cell,
  conditionHolds,
  effectiveSeverity,
  load,
  selectors,
  serialize,
  traverse,
  variants,
} from '../src/index.js';
import type { Coordinate } from '../src/index.js';
import { corpus, inputs, loop, loopRoot, records, registry } from './native.js';

const options = { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const native = load(records, registry, options);
const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
function fixture(body: string) {
  const source = { path: 'query.ia', text: `#! ia 1.0\n${body}\n`, location };
  const parsed = parse(source.text, source.path);
  expect(parsed.diagnostics).toEqual([]);
  const compiled = compile(parsed.ast, registry, location, []);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const graph = load([...records, ...compiled.records], registry, { ...options, sources: [...inputs, source] });
  expect(graph.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return graph;
}
const id = (name: string) => `governance-system/definition/procedure/${name}`;
describe('conditions and subject dimensions', () => {
  const subject = { severity: 'advisory' as const, provenance: 'workspace' as const, artifactSet: 'evidence' as const };
  it('uses a conjunction and requires each routing value', () => {
    const terms = [
      { axis: 'phase' as const, value: 'act' },
      { axis: 'primitive' as const, value: 'Memory' },
    ];
    expect(conditionHolds(terms, subject, { phase: 'ACT', primitive: 'memory' })).toBe(true);
    expect(conditionHolds(terms, subject, { phase: 'act' })).toBe(false);
    expect(conditionHolds(terms, subject, { phase: 'learn', primitive: 'Memory' })).toBe(false);
    expect(conditionHolds(undefined, subject, {})).toBe(true);
  });
  it('uses subject provenance and classification despite contrary request values', () => {
    expect(
      conditionHolds(
        [
          { axis: 'provenance', value: 'workspace' },
          { axis: 'artifact-set', value: 'evidence' },
        ],
        subject,
        { provenance: 'runtime', 'artifact-set': 'decision' },
      ),
    ).toBe(true);
    expect(
      conditionHolds(
        [{ axis: 'artifact-set', value: 'evidence' }],
        { provenance: 'workspace' },
        { 'artifact-set': 'evidence' },
      ),
    ).toBe(false);
  });
  it('lets either severity source raise stakes and does not invent an absent severity', () => {
    expect(effectiveSeverity(subject, {})).toBe('advisory');
    expect(effectiveSeverity(subject, { severity: 'blocking' })).toBe('blocking');
    expect(effectiveSeverity(subject, { severity: 'informational' })).toBe('advisory');
    expect(effectiveSeverity({ provenance: 'workspace' }, {})).toBeUndefined();
    expect(effectiveSeverity({ provenance: 'workspace' }, { severity: 'blocking' })).toBe('blocking');
  });
});
describe('selector alternatives and specificity', () => {
  const graph = fixture(
    '@playbook selected\n  activation\n    activate when phase is act and primitive is Memory\n    activate when category is decision\n@playbook gloss\n  meaning\n    category "decision"',
  );
  const selected = graph.nodes.get(id('selected'))!;
  it('matches any fully supplied group and takes maximum matching specificity', () => {
    expect(selectors(selected, { category: 'decision' })).toEqual({ status: 'matched', specificity: 1 });
    expect(selectors(selected, { category: 'decision', phase: 'act', primitive: 'Memory' })).toEqual({
      status: 'matched',
      specificity: 2,
    });
  });
  it('keeps an uncontradicted partial alternative neutral', () => {
    expect(selectors(selected, {})).toEqual({ status: 'neutral', specificity: 0 });
    expect(selectors(selected, { phase: 'orient' }).status).toBe('neutral');
    expect(selectors(selected, { phase: 'act', category: 'process' }).status).toBe('neutral');
  });
  it('disqualifies only when every alternative is contradicted', () => {
    expect(selectors(selected, { phase: 'orient', category: 'process' }).status).toBe('disqualified');
    expect(selectors(graph.nodes.get(id('gloss'))!, { category: 'process' }).status).toBe('neutral');
  });
  it('matches classification selectors against the request, unlike conditions', () => {
    const graph = fixture(
      '@playbook classified\n  artifact-set evidence\n  activation\n    activate when artifact-set is decision',
    );
    expect(selectors(graph.nodes.get(id('classified'))!, { 'artifact-set': 'decision' }).status).toBe('matched');
  });
});
describe('variant and cell choice', () => {
  const graph = fixture(
    '@law raised\n  governance\n    severity advisory\n    requires "plain"\n    requires "corroborate" when primitive is Memory and severity is blocking\n    recommends "review"\n@law ambiguous\n  governance\n    requires "phase" when phase is act\n    requires "primitive" when primitive is Memory\n    requires "dominant" when phase is act and primitive is Memory and move is Verification\n@playbook fallback\n  cognition\n    orient\n      primary Memory\n      Memory means "fallback"\n      Decision means "exact" when severity is blocking',
  );
  const law = graph.nodes.get('governance-system/governance/law/raised')!;
  it('selects maximum specificity per family, retaining unrelated families', () => {
    expect(variants(law, { phase: 'orient', primitive: 'Memory' }).selected.get('requires')!.value).toEqual({
      kind: 'string',
      text: 'plain',
    });
    const chosen = variants(law, { phase: 'act', primitive: 'Memory', severity: 'blocking' });
    expect(chosen.selected.get('requires')!.value).toEqual({ kind: 'string', text: 'corroborate' });
    expect(chosen.selected.has('recommends')).toBe(true);
    expect(() => (chosen.selected as Map<string, unknown>).clear()).toThrow();
  });
  it('refuses equal maxima with one diagnostic per family, but not lower ties', () => {
    const law = graph.nodes.get('governance-system/governance/law/ambiguous')!;
    const ambiguous = variants(law, { phase: 'act', primitive: 'Memory' });
    expect(ambiguous.selected.size).toBe(0);
    expect(ambiguous.diagnostics.map((d) => d.code)).toEqual(['IA-GRAPH-VARIANT-AMBIGUOUS']);
    const dominant = variants(law, { phase: 'act', primitive: 'Memory', move: 'Verification' });
    expect(dominant.diagnostics).toEqual([]);
    expect(dominant.selected.get('requires')!.value).toEqual({ kind: 'string', text: 'dominant' });
  });
  it('selects the exact native cell once, without also delivering its primary', () => {
    const method = native.nodes.get(id('sample-procedure'))!;
    expect(cell(method, { phase: 'orient', primitive: 'Decision' })?.kind).toBe('exact');
    expect(cell(method, { phase: 'orient', primitive: 'Memory' })?.kind).toBe('exact');
  });
  it('falls back when the exact condition fails and returns absent if no cell can apply', () => {
    const method = graph.nodes.get(id('fallback'))!;
    expect(cell(method, { phase: 'orient', primitive: 'Decision' })?.cell.text).toBe('fallback');
    expect(cell(method, { phase: 'orient', primitive: 'Decision', severity: 'blocking' })?.cell.text).toBe('exact');
    expect(cell(method, { phase: 'act', primitive: 'Decision' })).toBeUndefined();
    expect(cell(method, { phase: 'orient' })).toBeUndefined();
  });
  it.each(['condition', 'selectors', 'variants', 'cell', 'traverse'])(
    'rejects invalid coordinates in %s even if no match needs the bad axis',
    (query) => {
      const bad = { phase: 'bogus' } as Coordinate;
      const invoke = {
        condition: () => conditionHolds(undefined, law.dimensions, bad),
        selectors: () => selectors(law, bad),
        variants: () => variants(law, bad),
        cell: () => cell(law, bad),
        traverse: () => traverse(graph, { start: [], coordinate: bad }),
      };
      expect(invoke[query as keyof typeof invoke]).toThrow(
        expect.objectContaining({ code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN' }),
      );
    },
  );
});
describe('bounded breadth-first traversal', () => {
  const graph = fixture(
    '@playbook a\n  relationships\n    cites @playbook b\n    cites @playbook c\n@playbook b\n  relationships\n    cites @playbook d\n@playbook c\n  relationships\n    cites @playbook d\n@playbook d\n  relationships\n    cites @playbook a\n    cites @playbook missing\n    cited-by @playbook missing',
  );
  it('bounds UI work without changing unrestricted traversal or leaking excluded endpoints', () => {
    const bounded = traverse(graph, { start: [id('a')], depth: 8, maxNodes: 2, maxEdges: 2 });
    expect(bounded.nodes.length).toBeLessThanOrEqual(2);
    expect(bounded.edges.length + bounded.gated.length + bounded.dangling.length).toBeLessThanOrEqual(2);
    expect(bounded.truncated).toBe(true);
    expect(traverse(graph, { start: [id('a')], depth: 8 }).truncated).toBeUndefined();
    const scoped = traverse(graph, { start: [id('a')], maxNodes: 2, maxEdges: 2, scope: new Set([id('a')]) });
    expect(scoped.edges).toEqual([]);
    expect(() => traverse(graph, { start: [], maxNodes: 0 })).toThrow('positive integers');
  });
  it('orders breadth first, records both shortest paths, and terminates cycles', () => {
    const walk = traverse(graph, { start: [id('a'), id('a'), 'missing'], follow: ['cites'], depth: 8 });
    expect(walk.nodes).toEqual([
      { identity: id('a'), depth: 0 },
      { identity: id('b'), depth: 1 },
      { identity: id('c'), depth: 1 },
      { identity: id('d'), depth: 2 },
    ]);
    expect(walk.via.filter((v) => v.target === id('d')).map((v) => v.from)).toEqual([id('b'), id('c')]);
    expect(walk.edges).toHaveLength(5);
    expect(walk.dangling).toHaveLength(1);
  });
  it('honors exact verbs and their direction over a direction option', () => {
    const inverse = traverse(graph, { start: [id('d')], follow: ['cited-by'], direction: 'out' });
    expect(inverse.nodes.map((n) => n.identity)).toEqual([id('d'), id('b'), id('c')]);
    expect(inverse.dangling).toHaveLength(1);
    expect(traverse(graph, { start: [id('a')], follow: [] }).nodes).toHaveLength(1);
    expect(traverse(graph, { start: [id('a')], direction: 'in' }).nodes.map((n) => n.identity)).toEqual([
      id('a'),
      id('d'),
    ]);
  });
  it('prunes excluded intermediaries, starts, edges and descendants', () => {
    const walk = traverse(graph, { start: [id('a')], depth: 8, follow: ['cites'], scope: new Set([id('a'), id('d')]) });
    expect(walk.nodes).toEqual([{ identity: id('a'), depth: 0 }]);
    expect(walk.edges).toEqual([]);
    expect(walk.dangling).toEqual([]);
    expect(traverse(graph, { start: [id('a')], scope: new Set() }).nodes).toEqual([]);
  });
  it('prunes typed filters without reading meaning glosses', () => {
    expect(traverse(graph, { start: [id('a')], filter: { kind: 'governance' } }).nodes).toEqual([]);
    expect(
      traverse(graph, { start: [id('a')], filter: { system: 'governance-system', discriminator: 'playbook' } }).nodes,
    ).toHaveLength(4);
  });
  it('allows depth zero, ignores missing starts and freezes every result', () => {
    const walk = traverse(graph, { start: [id('a')], depth: 0 });
    expect(walk.nodes).toHaveLength(1);
    expect(walk.edges).toEqual([]);
    expect(traverse(graph, { start: ['missing'] }).nodes).toEqual([]);
    expect(() => (walk.nodes as unknown[]).pop()).toThrow();
  });
  it.each([-1, 9, 1.5, NaN, Infinity])('refuses invalid depth %s', (depth) => {
    expect(() => traverse(graph, { start: [], depth })).toThrow(
      expect.objectContaining({ code: 'IA-GRAPH-TRAVERSAL-INVALID' }),
    );
  });
  it('refuses unknown verbs before starting even with an empty scope', () => {
    expect(() => traverse(graph, { start: [], follow: ['CITES'] })).toThrow(
      expect.objectContaining({ code: 'IA-GRAPH-VERB-UNKNOWN' }),
    );
  });
  it('gates an authored inverse edge using its law author dimensions', () => {
    // The native corpus no longer authors an inverse edge; the loop fixture law keeps
    // `enforced-by @check instance-schema-check when phase is act and severity is blocking` at severity advisory.
    const law = 'governance-system/governance/law/sample-rule';
    const graphOf = (source: ReturnType<typeof corpus>) =>
      load(source.records, source.registry, { ...options, sources: source.inputs });
    const advisory = graphOf(loop);
    const blocking = graphOf(
      corpus(loopRoot, (path, text) =>
        path.endsWith('/sample-rule.ia') ? text.replace('severity advisory', 'severity blocking') : text,
      ),
    );
    expect(advisory.nodes.get(law)!.dimensions.severity).toBe('advisory');
    expect(blocking.nodes.get(law)!.dimensions.severity).toBe('blocking');
    const act = traverse(blocking, { start: [law], follow: ['enforced-by'], coordinate: { phase: 'act' } });
    expect(act.edges).toHaveLength(1);
    expect(act.gated).toEqual([]);
    const orient = traverse(blocking, { start: [law], follow: ['enforced-by'], coordinate: { phase: 'orient' } });
    expect(orient.edges).toEqual([]);
    expect(orient.gated).toHaveLength(1);
    expect(orient.nodes).toHaveLength(1);
    expect(traverse(blocking, { start: [law], follow: ['enforced-by'] }).edges[0]!.condition).toBeDefined();
    expect(
      traverse(blocking, {
        start: [law],
        follow: ['enforced-by'],
        coordinate: { phase: 'orient' },
        scope: new Set([law]),
      }).gated,
    ).toEqual([]);
    // The same edge on an advisory author is gated in act unless the request raises severity.
    const plain = traverse(advisory, { start: [law], follow: ['enforced-by'], coordinate: { phase: 'act' } });
    expect(plain.edges).toEqual([]);
    expect(plain.gated).toHaveLength(1);
    const raised = traverse(advisory, {
      start: [law],
      follow: ['enforced-by'],
      coordinate: { phase: 'act', severity: 'blocking' },
    });
    expect(raised.edges).toHaveLength(1);
    expect(raised.gated).toEqual([]);
  });
  it('does not mutate the graph and is invariant to start order', () => {
    const before = serialize(graph);
    const left = traverse(graph, { start: [id('a'), id('b')], depth: 8 });
    const right = traverse(graph, { start: [id('b'), id('a')], depth: 8 });
    expect(left).toEqual(right);
    expect(serialize(graph)).toBe(before);
  });
});
