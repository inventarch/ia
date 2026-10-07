import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, compile, parse } from '@inventarch/language';
import type { CompiledChild, CompiledRecord, Location } from '@inventarch/language';
import { digest, load, recordDigest, revisionOf } from '../src/index.js';
import type { LoadOptions } from '../src/index.js';
import { corpus, inputs, records, registry } from './native.js';

const options: LoadOptions = {
  sources: inputs,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
};
const authored: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const methodology: Location = { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' };
const PLAYBOOK = `@playbook probe-procedure
  artifact-set execution
  meaning
    says "A probe method."
    answers "Which content does its digest cover?"
  cognition
    act
      primary Decision
      Decision means "Decide with the probe."
      Memory means "Recall the probe."
  activation
    activate when category is process
  relationships
    cites @law sample-rule
    uses @check instance-schema-check when phase is act`;
const LAW = `@law probe-rule
  meaning
    says "An earlier record in the same file."
    answers "Does it move the later digest?"
  governance
    severity advisory
    requires "Hold the probe."
      when primitive is Memory`;
const CONTRACT = `@contract probe-contract
  version "0.1.0"
  meaning
    says "A probe contract."
    answers "Which requirement does it carry?"
  invariants
    REQ-PROBE-HOLDS "The probe holds."
  relationships
    governs @check instance-schema-check`;
const PROBE = 'governance-system/definition/procedure/probe-procedure';
/** Compile one probe file; the native pool resolves its edge targets unless `pool` says otherwise. */
function file(text: string, path = 'probe.ia', location = authored, pool: readonly CompiledRecord[] = records) {
  const source = `#! ia 1.0\n\n${text}\n`;
  const parsed = parse(source, path);
  expect(parsed.diagnostics).toEqual([]);
  const compiled = compile(parsed.ast, registry, location, pool);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { records: compiled.records, source: { path, text: source, location } };
}
const named = (compiled: ReturnType<typeof file>, name: string) => compiled.records.find((r) => r.name === name)!;
const graphOf = (compiled: ReturnType<typeof file>) =>
  load([...records, ...compiled.records], registry, { ...options, sources: [...inputs, compiled.source] });

describe('graph G13 per-record digest', () => {
  it('is the codec digest of the record with its source, spans, placement, provenance and edge targets left out', () => {
    const span = { line: 3, endLine: 3 };
    const leaf = { key: 'category', value: { kind: 'scalar', text: 'kind' }, span } as const;
    const record: CompiledRecord = {
      identity: 'governance-system/definition/procedure/vector',
      system: 'governance-system',
      kind: 'definition',
      facet: 'procedure',
      name: 'vector',
      displayName: 'vector',
      discriminator: 'playbook',
      source: { path: '.ia/src/systems/governance-system/records/vector.ia', line: 3, endLine: 12 },
      head: [{ key: 'artifact-set', value: { kind: 'scalar', text: 'execution' }, span }],
      sections: [
        {
          name: 'meaning',
          span,
          fields: [
            { key: 'says', value: { kind: 'string', text: 'A vector.' }, when: ['phase', 'act'], span },
            { item: { kind: 'scalar', text: 'loose' }, span },
            {
              key: 'notes',
              value: { kind: 'block' },
              span,
              fields: [{ ...leaf, fields: [{ item: leaf.value, span }] }],
            },
          ],
        },
      ],
      edges: [
        {
          predicate: 'cite',
          direction: 'out',
          spelling: 'cites',
          reference: { kind: 'ref', discriminator: 'law', name: 'sample-rule' },
          target: 'governance-system/governance/law/sample-rule',
          condition: [{ axis: 'phase', value: 'act' }],
          span,
        },
      ],
      cells: [{ phase: 'act', primitive: 'Decision', primary: true, text: 'Decide.', span }],
      selectors: [[{ axis: 'category', value: 'process' }]],
      variants: [{ key: 'requires', value: { kind: 'string', text: 'One.' }, span }],
      requirements: [{ id: 'REQ-VECTOR', kind: 'invariants', text: 'Holds.', span }],
      schema: 'floor/contract/head/playbook',
      provenance: 'workspace',
      placement: { kind: 'authored', band: 100, reach: '' },
    };
    const form = {
      identity: record.identity,
      system: 'governance-system',
      kind: 'definition',
      facet: 'procedure',
      name: 'vector',
      displayName: 'vector',
      discriminator: 'playbook',
      parent: null,
      head: [{ path: [0], key: 'artifact-set', value: { kind: 'scalar', text: 'execution' } }],
      sections: [
        {
          name: 'meaning',
          fields: [
            { path: [0], key: 'says', value: { kind: 'string', text: 'A vector.' }, when: ['phase', 'act'] },
            { path: [1], item: { kind: 'scalar', text: 'loose' } },
            { path: [2], key: 'notes', value: { kind: 'block' } },
            { path: [2, 0], key: 'category', value: { kind: 'scalar', text: 'kind' } },
            { path: [2, 0, 0], item: { kind: 'scalar', text: 'kind' } },
          ],
        },
      ],
      edges: [
        {
          predicate: 'cite',
          direction: 'out',
          spelling: 'cites',
          reference: { kind: 'ref', discriminator: 'law', name: 'sample-rule' },
          condition: [{ axis: 'phase', value: 'act' }],
        },
      ],
      cells: [{ phase: 'act', primitive: 'Decision', primary: true, text: 'Decide.' }],
      selectors: [[{ axis: 'category', value: 'process' }]],
      variants: [{ key: 'requires', value: { kind: 'string', text: 'One.' } }],
      requirements: [{ id: 'REQ-VECTOR', kind: 'invariants', text: 'Holds.' }],
      schema: 'floor/contract/head/playbook',
    };
    expect(recordDigest(record)).toBe(digest(form));
    // A vector: a change to the covered form is a deliberate, visible break of every retained digest.
    expect(recordDigest(record)).toBe('c71c7570dcd43a3faef0fe9823e3ece3ef67179183b1996f4e983be6c230a0ee');
    const moved: CompiledRecord = {
      ...record,
      source: { path: 'elsewhere/vector.ia', line: 40, endLine: 49 },
      head: record.head.map((f) => ({ ...f, span: { line: 41, endLine: 41 } })),
      edges: record.edges.map((e) => ({ ...e, target: null, span: { line: 48, endLine: 49 } })),
      placement: { kind: 'adopted', band: 90, reach: 'elsewhere' },
      provenance: 'methodology',
    };
    expect(recordDigest(moved)).toBe(recordDigest(record));
    // Nesting is covered by position: the same two children as siblings or one inside the other differ.
    const nested = (fields: readonly CompiledChild[]): CompiledRecord => ({
      ...record,
      head: [{ ...record.head[0]!, fields }],
    });
    const shapes = [record, nested([leaf, leaf]), nested([{ ...leaf, fields: [leaf] }])].map(recordDigest);
    expect(new Set(shapes).size).toBe(shapes.length);
    // Rows keep the form within the codec's nesting limit however deeply blocks nest.
    const deep = Array.from({ length: 200 }).reduce<readonly CompiledChild[]>((fields) => [{ ...leaf, fields }], []);
    expect(recordDigest(nested(deep))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a record digest when its lines shift, an earlier record changes or it moves to another file or mount', () => {
    const alone = file(PLAYBOOK),
      after = file(`${LAW}\n\n${PLAYBOOK}`),
      edited = file(
        `${LAW.replace('advisory', 'advisory\n    requires "A second clause."')}\n\n# A note.\n\n${PLAYBOOK}`,
      ),
      commented = file(PLAYBOOK.replace('  meaning\n', '  # A note inside the record.\n  meaning\n')),
      moved = file(
        PLAYBOOK,
        'elsewhere/moved.ia',
        { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'workspace' },
        [],
      ),
      adopted = file(PLAYBOOK, 'probe.ia', methodology);
    const probes = [alone, after, edited, commented, moved, adopted].map((compiled) =>
      named(compiled, 'probe-procedure'),
    );
    expect(new Set(probes.map((r) => r.source.line)).size).toBeGreaterThan(2);
    expect(named(commented, 'probe-procedure').cells[0]!.span).not.toEqual(
      named(alone, 'probe-procedure').cells[0]!.span,
    );
    // The compile-time target resolves against the pool; with none it is unresolved, and the digest ignores it.
    expect(named(moved, 'probe-procedure').edges.map((e) => e.target)).toEqual([null, null]);
    expect(named(alone, 'probe-procedure').edges.every((e) => e.target !== null)).toBe(true);
    expect(new Set(probes.map(recordDigest))).toEqual(new Set([recordDigest(probes[0]!)]));
    const nodes = [alone, after, edited, moved, adopted].map((compiled) => graphOf(compiled).nodes.get(PROBE)!);
    expect(new Set(nodes.map((node) => node.source.path))).toEqual(new Set(['probe.ia', 'elsewhere/moved.ia']));
    // Read from an adopted mount, the same text gets the loader's other placement and provenance, not another digest.
    expect(new Set(nodes.map((node) => node.provenance))).toEqual(new Set(['workspace', 'methodology']));
    expect(new Set(nodes.map((node) => node.digest))).toEqual(new Set([recordDigest(probes[0]!)]));
  });

  it('changes with every authored part of the record', () => {
    const base = recordDigest(named(file(PLAYBOOK), 'probe-procedure'));
    const playbook = (from: string, to: string) => {
      expect(PLAYBOOK).toContain(from);
      return recordDigest(file(PLAYBOOK.replace(from, to)).records[0]!);
    };
    const changed = [
      playbook('probe-procedure', 'probe-renamed'),
      playbook('artifact-set execution', 'artifact-set evidence'),
      playbook('A probe method.', 'Another probe method.'),
      playbook('Decide with the probe.', 'Decide otherwise.'),
      playbook('primary Decision', 'primary Memory'),
      playbook('category is process', 'category is decision'),
      playbook('cites @law sample-rule', 'cite @law sample-rule'),
      playbook('cites @law sample-rule', 'cites @law other-rule'),
      playbook(' when phase is act', ''),
      playbook(' when phase is act', ' when phase is plan'),
    ];
    const record = named(file(PLAYBOOK), 'probe-procedure');
    changed.push(
      recordDigest({ ...record, schema: 'floor/contract/head/other' }),
      recordDigest({ ...record, parent: 'governance-system/definition/procedure/sample-procedure' }),
      recordDigest({ ...record, displayName: 'Probe-Procedure' }),
    );
    expect(changed).not.toContain(base);
    expect(new Set(changed).size).toBe(changed.length);
    const law = recordDigest(file(LAW).records[0]!);
    const variants = [
      recordDigest(file(LAW.replace('Hold the probe.', 'Hold it.')).records[0]!),
      recordDigest(file(LAW.replace('primitive is Memory', 'primitive is Attention')).records[0]!),
    ];
    expect(variants).not.toContain(law);
    const contract = recordDigest(file(CONTRACT).records[0]!);
    const requirements = [
      recordDigest(file(CONTRACT.replace('The probe holds.', 'The probe still holds.')).records[0]!),
      recordDigest(file(CONTRACT.replace('REQ-PROBE-HOLDS', 'REQ-PROBE-KEEPS')).records[0]!),
      recordDigest(file(CONTRACT.replace('invariants', 'outputs')).records[0]!),
    ];
    expect(requirements).not.toContain(contract);
    expect(new Set(requirements).size).toBe(requirements.length);
    // A registration's nested blocks carry content that no product mirrors: an edit there alone changes the digest.
    const system = '.ia/src/systems/session-system/system.ia';
    const registration = (edit: (text: string) => string) =>
      corpus(resolve(import.meta.dirname, '../../..'), (path, text) =>
        path === system ? edit(text) : text,
      ).records.find((r) => r.source.path === system)!;
    const before = registration((text) => text),
      after = registration((text) => text.replace('facets [run]', 'facets [run, attempt]'));
    const { head: _beforeHead, sections: _beforeSections, ...products } = before,
      { head: _afterHead, sections: _afterSections, ...unchanged } = after;
    expect(unchanged).toEqual(products);
    expect(recordDigest(after)).not.toBe(recordDigest(before));
  });

  it('is computed at load for every occurrence and is not a revision input', () => {
    const graph = load(records, registry, options);
    expect(graph.occurrences.length).toBe(records.length);
    for (const occurrence of graph.occurrences) expect(occurrence.node.digest).toBe(recordDigest(occurrence.node));
    expect(new Set([...graph.nodes.values()].map((node) => node.digest)).size).toBe(graph.nodes.size);
    expect(graph.revision).toBe(revisionOf(registry, options));
  });
});
