import { describe, expect, it, vi } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import type { CompiledRecord, FrozenRegistry, Location, Placement } from '@inventarch/language';
import { digest, load, recordDigest, resolve, serialize, stableSerialize } from '../src/index.js';
import type { Graph, LoadOptions, RevisionSource } from '../src/index.js';
import { inputs, instance, loop, records, registry } from './native.js';

const options: LoadOptions = {
  sources: inputs,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
};
const native = load(records, registry, options);
const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
function probe(source: string, path = 'probe.ia') {
  const text = `#! ia 1.0\n${source}\n`;
  const parsed = parse(text, path);
  expect(parsed.diagnostics).toEqual([]);
  const compiled = compile(parsed.ast, registry, location, []);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { records: compiled.records, source: { path, text, location } };
}
function graphOf(extra: ReturnType<typeof probe>, vocabulary: FrozenRegistry = registry) {
  return load([...records, ...extra.records], vocabulary, { ...options, sources: [...inputs, extra.source] });
}
function placed(original: CompiledRecord, path: string, placement: Placement) {
  const record = { ...original, source: { ...original.source, path }, placement };
  const source: RevisionSource = {
    path,
    text: `#! ia 1.0\n# supplied compiled overlay ${path}\n`,
    location: { placement, provenance: record.provenance },
  };
  return { record, source };
}
describe('native graph load and ownership', () => {
  it('loads every native node with structural ground edges and typed postings', () => {
    expect(native.diagnostics).toEqual([]);
    expect([...native.nodes.keys()].sort()).toEqual(records.map((record) => record.identity).sort());
    expect(native.dangling).toEqual([]);
    expect(native.shadows).toEqual([]);
    expect(native.ties).toEqual([]);
    const method = records.find((r) => r.name === 'sample-procedure')!;
    expect(native.cells.get('act/Decision')!.map((c) => c.identity)).toContain(method.identity);
    expect(native.byLane.get('definitions')).toContain(method.identity);
    expect(native.byCategory.get('process')).toContain(method.identity);
    expect(native.selectors.get('category')?.get('process')).toContain(method.identity);
    expect(native.conditions.get('primitive=Memory')).toContain(
      records.find((r) => r.name === 'sample-rule')!.identity,
    );
    // Includes the authoring-guide registration introduced with the shipped guide library, the two made work-system
    // decisions (work-validation-host, work-date-representation) that ground author-work-system-records, and the two
    // design vocabulary registrations (design-token, design-specimen) that ground author-design-system-records, and the
    // structural ground edge from work-system to its @spec schema and the public export scope/dependency-policy decisions plus the complete task-capture bound decision and the three reviewed task-declaration groundings.
    expect(native.edges.filter((e) => e.predicate === 'ground')).toHaveLength(42);
  });
  it('is deterministic under source and record permutation and snapshots all exposed state', () => {
    expect(serialize(load([...records].reverse(), registry, { ...options, sources: [...inputs].reverse() }))).toBe(
      serialize(native),
    );
    expect(() => (native.nodes as Map<string, unknown>).clear()).toThrow();
    expect(() => (native.edges as unknown[]).pop()).toThrow();
    expect(() => (native.registry.systems as Map<string, unknown>).delete('taxonomy')).toThrow();
    const node = native.nodes.values().next().value!;
    expect(() => (node.head as unknown[]).pop()).toThrow();
  });
  it('reads classification from the explicit head and category only from registration', () => {
    const g = graphOf(probe('@playbook classified\n  artifact-set evidence\n  meaning\n    category "decision"'));
    const id = 'governance-system/definition/procedure/classified';
    expect(g.byArtifactSet.get('evidence')).toContain(id);
    expect(g.byCategory.get('process')).toContain(id);
    expect(g.byCategory.get('decision') ?? []).not.toContain(id);
  });
  it('refuses a malformed dimension record without indexing its preview', () => {
    const g = graphOf(probe('@law bad\n  governance\n    severity enormous'));
    expect(g.diagnostics.map((d) => d.code)).toEqual(['IA-GRAPH-DIMENSION-UNKNOWN']);
    expect(g.byName.has('bad')).toBe(false);
    expect(g.occurrences.find((o) => o.node.name === 'bad')!.status).toBe('refused');
  });
  it('checks caller occurrence, revision source and placement consistency', () => {
    expect(() => load([records[0]!, records[0]!], registry, options)).toThrow('Duplicate record occurrence');
    expect(() => load([records[0]!], registry, { ...options, sources: [] })).toThrow('absent');
    const changed = { ...records[0]!, provenance: 'runtime' as const };
    expect(() => load([changed], registry, options)).toThrow('disagrees');
  });
});
describe('authority before indexing', () => {
  const original = records.find((r) => r.name === 'sample-procedure')!;
  const floor = placed(original, 'overlay/floor.ia', { kind: 'floor', band: 10, reach: '' });
  const high = placed(original, 'overlay/high.ia', { kind: 'authored', band: 100, reach: 'team' });
  function view(overlays = [floor, high], extra: Partial<LoadOptions> = {}) {
    return load(
      overlays.map((o) => o.record),
      registry,
      { ...options, sources: overlays.map((o) => o.source), ...extra },
    );
  }
  it('keeps occurrences and explicit shadows while indexing only the highest reachable band', () => {
    const graph = view(undefined, { location: 'team/child' });
    expect(graph.nodes.get(original.identity)!.source.path).toBe('overlay/high.ia');
    expect(graph.occurrences.map((o) => o.status)).toEqual(['shadowed', 'winner']);
    expect(graph.shadows).toHaveLength(1);
    expect(graph.cells.get('orient/Memory')).toHaveLength(1);
    expect(view(undefined, { location: 'teammate' }).nodes.get(original.identity)!.band).toBe(10);
  });
  it('refuses equal highest bands across overlapping reaches without selecting a narrower root or lower fallback', () => {
    const rival = placed(original, 'overlay/rival.ia', { kind: 'authored', band: 100, reach: 'team/child' });
    const graph = view([floor, high, rival], { location: 'team/child' });
    expect(graph.nodes.size).toBe(0);
    expect(graph.ties).toHaveLength(1);
    expect(graph.diagnostics.filter((d) => d.code === 'IA-GRAPH-IDENTITY-TIE')).toHaveLength(2);
    expect(graph.occurrences.find((o) => o.node.band === 10)!.status).toBe('blocked');
  });
  it('does not collide disjoint reaches', () => {
    const other = placed(original, 'overlay/other.ia', { kind: 'authored', band: 100, reach: 'another' });
    expect(view([high, other], { location: 'team' }).ties).toEqual([]);
  });
  it('filters phase applicability before band selection and treats groups as alternatives', () => {
    const restricted = { ...high, record: { ...high.record, selectors: [[{ axis: 'phase' as const, value: 'act' }]] } };
    expect(view([floor, restricted], { location: 'team', phase: 'orient' }).nodes.get(original.identity)!.band).toBe(
      10,
    );
    expect(view([floor, restricted], { location: 'team', phase: 'act' }).nodes.get(original.identity)!.band).toBe(100);
    const alternative = {
      ...restricted,
      record: {
        ...restricted.record,
        selectors: [...restricted.record.selectors, [{ axis: 'kind' as const, value: 'definition' }]],
      },
    };
    expect(view([floor, alternative], { location: 'team', phase: 'orient' }).nodes.get(original.identity)!.band).toBe(
      100,
    );
  });
});
describe('active endpoints, dangling references and consent', () => {
  it('normalizes an authored inverse assertion while retaining its author as condition subject', () => {
    // The native corpus no longer authors an inverse edge; the loop fixture law keeps `enforced-by … when …`.
    const graph = load(loop.records, loop.registry, { ...options, sources: loop.inputs });
    expect(graph.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const edge = graph.edges.find((e) => e.predicate === 'enforce' && e.condition !== undefined)!;
    expect(edge.from).toBe('compliance-system/check/gate/instance-schema-check');
    expect(edge.to).toBe('governance-system/governance/law/sample-rule');
    expect(edge.conditionSubject).toBe(edge.to);
    expect(edge.author).toBe(edge.to);
  });
  it('resolves edges that compilation retained as dangling and deduplicates reciprocal assertions with both sources', () => {
    const a = probe('@playbook a\n  relationships\n    cites @playbook b', 'a.ia');
    const b = probe('@playbook b\n  relationships\n    cited-by @playbook a', 'b.ia');
    const graph = load([...a.records, ...b.records], registry, { ...options, sources: [a.source, b.source] });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.assertions).toHaveLength(2);
    // Each assertion keeps the verb its author wrote; the edge's endpoints stay normalized to the active direction.
    expect(graph.edges[0]!.assertions.map((x) => [x.author, x.direction, x.spelling])).toEqual([
      [a.records[0]!.identity, 'out', 'cites'],
      [b.records[0]!.identity, 'in', 'cited-by'],
    ]);
    expect(graph.out.get(a.records[0]!.identity)?.get('cite')).toHaveLength(1);
    expect(graph.in.get(b.records[0]!.identity)?.get('cite')).toHaveLength(1);
  });
  it('retains null on the missing active endpoint for both authored directions', () => {
    const extra = probe('@playbook a\n  relationships\n    cites @playbook missing\n    cited-by @playbook missing');
    const graph = graphOf(extra);
    const edges = graph.byDanglingReference.get('@playbook missing')!;
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => [e.from, e.to])).toContainEqual([null, extra.records[0]!.identity]);
    expect(edges.map((e) => [e.from, e.to])).toContainEqual([extra.records[0]!.identity, null]);
    expect(graph.diagnostics.every((d) => d.code === 'IA-GRAPH-TARGET-MISSING' && d.severity === 'warning')).toBe(true);
  });
  it('checks consent again on a newly resolved edge and reports only one refusing side', () => {
    const extra = probe('@playbook a\n  relationships\n    cites @playbook b\n@playbook b');
    const consent = new Map(registry.consent);
    consent.set('governance-system', []);
    const graph = graphOf(extra, { ...registry, consent });
    const findings = graph.diagnostics.filter((d) => d.path === 'probe.ia');
    expect(findings.map((d) => d.code)).toEqual(['IA-GRAPH-EDGE-UNCONSENTED']);
    expect(findings[0]!.message).toContain('source');
    expect(graph.edges.some((e) => e.author === extra.records[0]!.identity)).toBe(false);
  });
  it('names a target-side refusal when the source owner admits the relation', () => {
    const extra = probe('@agent a\n  relationships\n    cites @playbook b\n@playbook b');
    const consent = new Map(registry.consent);
    consent.set('governance-system', []);
    const graph = graphOf(extra, { ...registry, consent });
    const findings = graph.diagnostics.filter((d) => d.path === 'probe.ia');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('target');
  });
  it('does not exempt an ordinary ground edge that resolves after compilation', () => {
    const a = probe('@playbook a\n  relationships\n    grounds @schema late', 'a.ia');
    const b = probe('@schema late\n  lowers to definition\n  sections\n    open', 'b.ia');
    const graph = load([...a.records, ...b.records], registry, { ...options, sources: [a.source, b.source] });
    expect(graph.edges).toEqual([]);
    expect(graph.diagnostics.map((d) => d.code)).toEqual(['IA-GRAPH-EDGE-UNCONSENTED']);
  });
  it('keeps an inverse fragment on the referenced from endpoint', () => {
    const graph = graphOf(probe('@playbook a\n  relationships\n    cited-by @playbook b#act/Memory\n@playbook b'));
    const edge = graph.edges.find((e) => e.source.path === 'probe.ia')!;
    expect(edge.fragment).toBe('act/Memory');
    expect(edge.fragmentEndpoint).toBe('from');
    expect(edge.from).toBe('governance-system/definition/procedure/b');
  });
  it('does not conflate conditioned assertions authored on different subjects', () => {
    const graph = graphOf(
      probe(
        '@playbook a\n  relationships\n    cites @playbook b when phase is act\n@playbook b\n  relationships\n    cited-by @playbook a when phase is act',
      ),
    );
    expect(graph.edges.filter((e) => e.source.path === 'probe.ia')).toHaveLength(2);
  });
  it('delegates exact-cardinality public resolution without selecting order', () => {
    const record = instance('@playbook sample');
    const reference = { kind: 'ref' as const, discriminator: 'playbook', name: 'SAMPLE', fragment: 'act/Memory' };
    expect(resolve(reference, [record], registry)).toEqual({
      ok: true,
      identity: record.identity,
      fragment: 'act/Memory',
    });
    expect(resolve(reference, [], registry)).toEqual({ ok: false, code: 'IA-GRAPH-TARGET-MISSING' });
    expect(
      resolve(reference, [record, { ...record, source: { ...record.source, path: 'other.ia' } }], registry),
    ).toEqual({ ok: false, code: 'IA-GRAPH-TARGET-AMBIGUOUS' });
  });
});

// G06a: typed ref values held in record fields form a derived index beside the edges, never inside them.
const inbound = (graph: Graph, identity: string): number =>
  [...(graph.in.get(identity)?.values() ?? [])].reduce((n, list) => n + list.length, 0);

describe('typed field references (G06a)', () => {
  const identityOf = (discriminator: string, name: string): string =>
    records.find((r) => r.discriminator === discriminator && r.name === name)!.identity;
  const mandate = identityOf('mandate', 'agent-system-stewardship');
  const capability = identityOf('capability', 'agent-system-stewardship');
  const profile = identityOf('agent-profile', 'agent-steward-profile');
  const steward = identityOf('agent', 'agent-steward');

  it('indexes a composition mandate ref in referencedBy and not in edges', () => {
    const graph = graphOf(
      probe(
        '@agent-profile probe-profile\n  composition\n    mandate @mandate agent-system-stewardship\n    capabilities [@capability agent-system-stewardship, @capability absent-capability]',
      ),
    );
    const author = [...graph.nodes.values()].find((n) => n.name === 'probe-profile')!.identity;
    expect(graph.referencedBy.get(mandate)).toContainEqual({
      from: author,
      to: mandate,
      field: 'composition.mandate',
      reference: { kind: 'ref', discriminator: 'mandate', name: 'agent-system-stewardship' },
      source: { path: 'probe.ia', line: 4, endLine: 4 },
    });
    expect(
      graph.referencedBy
        .get(capability)
        ?.filter((r) => r.from === author)
        .map((r) => r.field),
    ).toEqual(['composition.capabilities']);
    // No edge, no adjacency, no diagnostic: the unresolved ref is compliance's to report, not the graph's.
    expect(graph.edges.filter((e) => e.from === author || e.to === author)).toEqual([]);
    expect(graph.in.get(author)).toBeUndefined();
    expect(inbound(graph, mandate)).toBe(inbound(native, mandate));
    expect(graph.edges).toHaveLength(native.edges.length);
    expect(graph.diagnostics).toEqual(native.diagnostics);
    expect(graph.references.filter((r) => r.from === author)).toHaveLength(2);
  });

  it('labels head, nested and section-item refs by their compiler field path', () => {
    const graph = graphOf(
      probe(
        '@agent-profile probe-profile\n  composition\n    voice @voice steward-voice\n    systems\n      inner @system agent-system\n    - @agent agent-steward',
      ),
    );
    const author = [...graph.nodes.values()].find((n) => n.name === 'probe-profile')!.identity;
    expect(graph.references.filter((r) => r.from === author).map((r) => [r.field, r.to])).toEqual([
      ['composition', steward],
      ['composition.systems.inner', identityOf('system', 'agent-system')],
      ['composition.voice', identityOf('voice', 'steward-voice')],
    ]);
  });

  it('never re-reads a relationships ref, so a consent-refused relationship does not reappear', () => {
    const consent = new Map(registry.consent);
    consent.set('governance-system', []);
    const graph = graphOf(probe('@playbook a\n  relationships\n    cites @playbook b\n@playbook b'), {
      ...registry,
      consent,
    });
    expect(graph.diagnostics.map((d) => d.code)).toContain('IA-GRAPH-EDGE-UNCONSENTED');
    expect(graph.references.filter((r) => r.from.endsWith('/a') || r.to.endsWith('/b'))).toEqual([]);
  });

  it('shares no authored line with an edge over the native corpus', () => {
    const edgeLines = new Set(
      native.edges.flatMap((e) => e.assertions.map((a) => `${a.author}|${a.source.path}|${a.source.line}`)),
    );
    expect(native.references.filter((r) => edgeLines.has(`${r.from}|${r.source.path}|${r.source.line}`))).toEqual([]);
    expect(
      native.references.some((r) => r.field.startsWith('discriminators.') || r.field.startsWith('relationships')),
    ).toBe(false);
  });

  it('connects stewardship records the edges leave without inbound references', () => {
    expect(native.referencedBy.get(mandate)?.map((r) => [r.from, r.field])).toEqual([[profile, 'composition.mandate']]);
    expect(native.referencedBy.get(steward)?.map((r) => [r.from, r.field])).toEqual(
      expect.arrayContaining([
        [identityOf('system', 'agent-system'), 'head.steward'],
        [profile, 'composition.agent'],
      ]),
    );
    expect(inbound(native, mandate)).toBe(0);
    expect([...native.referencedBy.values()].reduce((n, list) => n + list.length, 0)).toBe(native.references.length);
  });

  it('is deterministic, snapshotted and leaves the revision to its sources', () => {
    const reversed = load([...records].reverse(), registry, { ...options, sources: [...inputs].reverse() });
    expect(stableSerialize(reversed.references)).toBe(stableSerialize(native.references));
    expect(stableSerialize(reversed.referencedBy)).toBe(stableSerialize(native.referencedBy));
    expect(reversed.revision).toBe(native.revision);
    expect(() => (native.references as unknown[]).pop()).toThrow();
    expect(() => (native.referencedBy as Map<string, unknown>).clear()).toThrow();
  });
});

// The per-record digest is taken over the record's own source lines, so it moves with that record's text and with
// nothing else: compiled spans, placement and resolved targets shift when other text moves, the slice does not.
describe('per-record source digest', () => {
  const pair = (above: string, b: string, newline = '\n') => {
    const extra = probe(
      `${above}@playbook a\n  relationships\n    cites @playbook b\n\n${b}`.replaceAll('\n', newline),
    );
    const graph = load(extra.records, registry, { ...options, sources: [extra.source] });
    expect(graph.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const node = (name: string) => [...graph.nodes.values()].find((n) => n.name === name)!;
    return { a: node('a'), b: node('b') };
  };
  const plain = '@playbook b';
  const edited = '@playbook b\n  relationships\n    cites @playbook a';

  it('keeps a record digest when only the lines above it move', () => {
    const before = pair('', plain);
    const shifted = pair('# a note above every record\n\n# and another\n', plain);
    expect(shifted.b.source.line).toBe(before.b.source.line + 3);
    expect(shifted.a.digest).toBe(before.a.digest);
    expect(shifted.b.digest).toBe(before.b.digest);
  });
  it('moves only the edited record digest when its own text changes', () => {
    const before = pair('', plain);
    const after = pair('', edited);
    expect(after.b.digest).not.toBe(before.b.digest);
    expect(after.a.digest).toBe(before.a.digest);
  });
  it('is a tagged sha256 over the CRLF-normalised source slice', () => {
    const lf = pair('', edited);
    const crlf = pair('', edited, '\r\n');
    expect(crlf.b.digest).toBe(lf.b.digest);
    expect(crlf.a.digest).toBe(lf.a.digest);
    expect(lf.b.digest).toMatch(/^[0-9a-f]{64}$/);
    const text = '#! ia 1.0\r\n@playbook b\r\n  relationships\r\n    cites @playbook a\r\n';
    expect(recordDigest(text, { line: 2, endLine: 4 })).toBe(
      digest({ format: 'ia-record-1', text: '@playbook b\n  relationships\n    cites @playbook a' }),
    );
    expect(recordDigest(`\uFEFF${text}`, { line: 2, endLine: 4 })).toBe(recordDigest(text, { line: 2, endLine: 4 }));
  });
  it('covers nested records inside their parent: a child edit moves the parent digest too', () => {
    const nested = (says: string) => {
      const extra = probe(
        `@agent lead\n  team\n    @agent member\n      meaning\n        says "${says}"\n    size 2\n@agent other`,
      );
      const graph = load(extra.records, registry, { ...options, sources: [extra.source] });
      const node = (name: string) => [...graph.nodes.values()].find((n) => n.name === name)!;
      return { lead: node('lead'), member: node('member'), other: node('other') };
    };
    const before = nested('m'),
      after = nested('changed');
    expect(before.member.parent).toBe(before.lead.identity);
    expect(after.member.digest).not.toBe(before.member.digest);
    expect(after.lead.digest).not.toBe(before.lead.digest);
    expect(after.other.digest).toBe(before.other.digest);
  });
  it('cuts each revision source into lines once, however many records it holds', () => {
    const many = probe(Array.from({ length: 40 }, (_, i) => `@playbook p${i}`).join('\n\n'));
    const split = vi.spyOn(String.prototype, 'split');
    try {
      const graph = load(many.records, registry, { ...options, sources: [many.source] });
      expect(graph.nodes.size).toBe(40);
      expect(split.mock.contexts.filter((context) => String(context) === many.source.text)).toHaveLength(1);
    } finally {
      split.mockRestore();
    }
  });
  it('puts a digest on every native node without changing the corpus revision', () => {
    expect([...native.nodes.values()].every((n) => /^[0-9a-f]{64}$/.test(n.digest))).toBe(true);
    expect(native.revision).toBe(load(records, registry, options).revision);
  });
});
