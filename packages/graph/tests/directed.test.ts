import { describe, expect, it } from 'vitest';
import { INVERSE_OF, KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse, verbOf } from '@inventarch/language';
import type { FrozenRegistry, Location } from '@inventarch/language';
import { directedView, load, serialize, stableSerialize } from '../src/index.js';
import type { DirectedRow, Graph, LoadOptions } from '../src/index.js';
import { inputs, records, registry } from './native.js';

// G06b: the directed view reads every assertion from both of its ends and every field reference from both of its
// ends, labeled declared or derived; it is computed on read and leaves the graph untouched.
const options: LoadOptions = {
  sources: inputs,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
};
const native = load(records, registry, options);
const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
function graphOf(source: string, vocabulary: FrozenRegistry = registry): Graph {
  const path = 'probe.ia',
    text = `#! ia 1.0\n${source}\n`;
  const parsed = parse(text, path);
  expect(parsed.diagnostics).toEqual([]);
  // Compiled against the shipped registry, loaded against `vocabulary`: graph G07 rechecks consent on load.
  const compiled = compile(parsed.ast, registry, location, []);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return load([...records, ...compiled.records], vocabulary, {
    ...options,
    sources: [...inputs, { path, text, location }],
  });
}
const playbook = (name: string): string => `governance-system/definition/procedure/${name}`;
const a = playbook('a'),
  b = playbook('b');
const brief = (row: DirectedRow) =>
  row.kind === 'field-ref'
    ? [row.kind, row.direction, row.field, row.counterpart, row.declaredOn, row.derived]
    : [row.kind, row.direction, row.spelling, row.counterpart, row.declaredOn, row.declaredBy, row.derived];

describe('declared rows and derived inverses (G06b)', () => {
  it('reads an outbound declaration as declared at its author and as the inverse spelling at its target', () => {
    const graph = graphOf('@playbook a\n  relationships\n    cites @playbook b\n@playbook b');
    expect(directedView(graph, a).map(brief)).toEqual([['edge', 'out', 'cites', b, a, 'source', false]]);
    expect(directedView(graph, b).map(brief)).toEqual([['inverse', 'in', 'cited-by', a, a, 'source', true]]);
    expect(directedView(graph, a)[0]).toMatchObject({ predicate: 'cite', source: { path: 'probe.ia', line: 4 } });
  });

  it('reads an inverse declaration as declared at its author and in the active spelling at its source', () => {
    const graph = graphOf('@playbook a\n  relationships\n    cited-by @playbook b\n@playbook b');
    expect(directedView(graph, a).map(brief)).toEqual([['edge', 'in', 'cited-by', b, a, 'target', false]]);
    expect(directedView(graph, b).map(brief)).toEqual([['inverse', 'out', 'cite', a, a, 'target', true]]);
    // The directed form is a view: the edge and its single assertion keep the spelling the author wrote.
    const edge = graph.edges.find((e) => e.to === a)!;
    expect(edge.assertions.map((x) => x.spelling)).toEqual(['cited-by']);
  });

  it('keeps both declarations of an edge asserted from both ends, each declared on its own side', () => {
    const graph = graphOf(
      '@playbook a\n  relationships\n    cites @playbook b\n@playbook b\n  relationships\n    cited-by @playbook a',
    );
    expect(graph.edges.filter((e) => e.from === a && e.to === b)).toHaveLength(1);
    expect(directedView(graph, a).map(brief)).toEqual([
      ['edge', 'out', 'cites', b, a, 'source', false],
      ['inverse', 'out', 'cite', b, b, 'target', true],
    ]);
    expect(directedView(graph, b).map(brief)).toEqual([
      ['edge', 'in', 'cited-by', a, b, 'target', false],
      ['inverse', 'in', 'cited-by', a, a, 'source', true],
    ]);
  });

  it('carries the edge fragment and condition on both sides', () => {
    const fragment = graphOf('@playbook a\n  relationships\n    cited-by @playbook b#act/Memory\n@playbook b');
    // The fragment addresses the record the declaration references: b, the counterpart here and the viewed record there.
    expect(directedView(fragment, a)).toEqual([expect.objectContaining({ kind: 'edge', fragment: 'act/Memory' })]);
    expect(directedView(fragment, b)).toEqual([expect.objectContaining({ kind: 'inverse', fragment: 'act/Memory' })]);
    const conditioned = graphOf('@playbook a\n  relationships\n    cites @playbook b when phase is act\n@playbook b');
    for (const identity of [a, b])
      expect(directedView(conditioned, identity).map((row) => 'condition' in row && row.condition)).toEqual([
        [{ axis: 'phase', value: 'act' }],
      ]);
  });

  it('reads a self-relation from both of its sides', () => {
    const graph = graphOf('@playbook a\n  relationships\n    cites @playbook a');
    expect(directedView(graph, a).map(brief)).toEqual([
      ['edge', 'out', 'cites', a, a, 'source', false],
      ['inverse', 'in', 'cited-by', a, a, 'source', true],
    ]);
  });

  it('derives no row from a dangling or consent-refused assertion, which stay findings', () => {
    const dangling = graphOf('@playbook a\n  relationships\n    cites @playbook missing\n    cited-by @playbook gone');
    expect(directedView(dangling, a)).toEqual([]);
    expect(dangling.dangling.filter((e) => e.author === a)).toHaveLength(2);
    expect(dangling.diagnostics.filter((d) => d.path === 'probe.ia').map((d) => d.code)).toEqual([
      'IA-GRAPH-TARGET-MISSING',
      'IA-GRAPH-TARGET-MISSING',
    ]);
    const consent = new Map(registry.consent);
    consent.set('governance-system', []);
    const refused = graphOf('@playbook a\n  relationships\n    cites @playbook b\n@playbook b', {
      ...registry,
      consent,
    });
    expect(refused.diagnostics.filter((d) => d.path === 'probe.ia').map((d) => d.code)).toEqual([
      'IA-GRAPH-EDGE-UNCONSENTED',
    ]);
    expect(directedView(refused, a)).toEqual([]);
    expect(directedView(refused, b)).toEqual([]);
  });

  it('orders rows of one kind and direction by predicate, then counterpart, not by the order the graph holds them', () => {
    const graph = graphOf(
      '@playbook x\n@playbook a\n  relationships\n    uses @playbook x\n@playbook b\n  relationships\n    cites @playbook x\n@playbook c\n  relationships\n    cites @playbook x',
    );
    // The graph keeps x's inbound edges in source order, a's `use` before b's and c's `cite`.
    const x = playbook('x');
    expect([...graph.in.get(x)!.keys()]).toEqual(['use', 'cite']);
    expect(directedView(graph, x).map(brief)).toEqual([
      ['inverse', 'in', 'cited-by', b, b, 'source', true],
      ['inverse', 'in', 'cited-by', playbook('c'), playbook('c'), 'source', true],
      ['inverse', 'in', 'used-by', a, a, 'source', true],
    ]);
  });

  it('has no rows for an identity that is not an admitted winner', () => {
    expect(directedView(native, 'governance-system/definition/procedure/absent')).toEqual([]);
  });
});

describe('typed field references in the directed view (G06b)', () => {
  it('lists a field reference out of its holder and into its target, derived and labeled by field path', () => {
    const graph = graphOf('@agent-profile probe-profile\n  composition\n    mandate @mandate agent-system-stewardship');
    const holder = [...graph.nodes.values()].find((n) => n.name === 'probe-profile')!.identity;
    const mandate = [...graph.nodes.values()].find(
      (n) => n.discriminator === 'mandate' && n.name === 'agent-system-stewardship',
    )!.identity;
    expect(directedView(graph, holder)).toEqual([
      {
        kind: 'field-ref',
        derived: true,
        direction: 'out',
        field: 'composition.mandate',
        counterpart: mandate,
        declaredOn: holder,
        source: { path: 'probe.ia', line: 4, endLine: 4 },
      },
    ]);
    expect(directedView(graph, mandate).filter((row) => row.counterpart === holder)).toEqual([
      {
        kind: 'field-ref',
        derived: true,
        direction: 'in',
        field: 'composition.mandate',
        counterpart: holder,
        declaredOn: holder,
        source: { path: 'probe.ia', line: 4, endLine: 4 },
      },
    ]);
  });
});

describe('the directed view over the native corpus (G06b)', () => {
  const views = new Map([...native.nodes.keys()].map((identity) => [identity, directedView(native, identity)]));
  const all = [...views].flatMap(([identity, rows]) => rows.map((row) => ({ identity, row })));

  it('uses the kernel inverse spelling of each of the eighteen closed predicates', () => {
    expect([...INVERSE_OF.values()]).toEqual([
      'governed-by',
      'enforced-by',
      'grounded-by',
      'constrained-by',
      'implemented-by',
      'produced-by',
      'consumed-by',
      'lineage-recorded-by',
      'access-granted-by',
      'run-after',
      'triggered-by',
      'cited-by',
      'superseded-by',
      'required-by',
      'used-by',
      'forbidden-by',
      'routed-by',
      'landed-by',
    ]);
    for (const { row } of all)
      if (row.kind === 'inverse')
        expect(row.spelling).toBe(row.direction === 'out' ? row.predicate : INVERSE_OF.get(row.predicate));
  });

  it('labels every row consistently with its side, its declaring record and its spelling', () => {
    expect(all.some(({ row }) => row.kind === 'edge')).toBe(true);
    expect(all.some(({ row }) => row.kind === 'inverse')).toBe(true);
    expect(all.some(({ row }) => row.kind === 'field-ref')).toBe(true);
    for (const { identity, row } of all) {
      expect(row.derived).toBe(row.kind !== 'edge');
      expect(native.nodes.has(row.counterpart)).toBe(true);
      expect(row.declaredOn).toBe(
        row.kind === 'edge' || (row.kind === 'field-ref' && row.direction === 'out') ? identity : row.counterpart,
      );
      if (row.kind === 'field-ref') continue;
      // The spelling read from this side parses back to this side's predicate and direction, in either spelling.
      expect(verbOf(row.spelling)).toEqual({ predicate: row.predicate, direction: row.direction });
      expect(row.declaredBy).toBe((row.direction === 'out') === (row.kind === 'edge') ? 'source' : 'target');
    }
  });

  it('reads each resolved assertion once from each end and each field reference once from each end', () => {
    const assertions = native.edges
      .filter((e) => e.from !== null && e.to !== null)
      .reduce((n, e) => n + e.assertions.length, 0);
    const count = (kind: DirectedRow['kind'], direction?: DirectedRow['direction']) =>
      all.filter(({ row }) => row.kind === kind && (direction === undefined || row.direction === direction)).length;
    expect(count('edge')).toBe(assertions);
    expect(count('inverse')).toBe(assertions);
    expect(count('field-ref', 'out')).toBe(native.references.length);
    expect(count('field-ref', 'in')).toBe(native.references.length);
  });

  it('orders rows totally, independent of input order, and leaves the graph unchanged', () => {
    const before = serialize(native);
    const reversed = load([...records].reverse(), registry, { ...options, sources: [...inputs].reverse() });
    for (const [identity, rows] of views) {
      // Recomputed on the native graph between its two serializations, so a view that changed the graph shows below.
      expect(stableSerialize(directedView(native, identity))).toBe(stableSerialize(rows));
      expect(stableSerialize(directedView(reversed, identity))).toBe(stableSerialize(rows));
      expect(rows.map((row) => row.kind)).toEqual(
        [...rows.map((row) => row.kind)].sort(
          (x, y) => ['edge', 'inverse', 'field-ref'].indexOf(x) - ['edge', 'inverse', 'field-ref'].indexOf(y),
        ),
      );
      expect(new Set(rows.map((row) => stableSerialize(row))).size).toBe(rows.length);
    }
    // `referencedBy` keeps agent-steward's holders in holder order; the view orders its field rows by field path.
    const steward = 'agent-system/binding/agent/agent-steward';
    expect(native.referencedBy.get(steward)!.map((reference) => reference.field)).not.toEqual([
      'authority.participant',
      'composition.agent',
      'head.steward',
    ]);
    expect(
      views
        .get(steward)!
        .filter((row) => row.kind === 'field-ref' && row.direction === 'in')
        .map((row) => row.kind === 'field-ref' && row.field),
    ).toEqual(['authority.participant', 'composition.agent', 'head.steward']);
    expect(serialize(native)).toBe(before);
    const rows = [...views.values()].find((list) => list.length > 0)!;
    expect(() => (rows as DirectedRow[]).pop()).toThrow();
    expect(() => {
      (rows[0] as { counterpart: string }).counterpart = 'changed';
    }).toThrow();
  });
});
