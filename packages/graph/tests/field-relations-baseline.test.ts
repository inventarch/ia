import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, PREDICATES } from '@inventarch/language';
import type { CompiledChild, CompiledRecord, CompiledValue } from '@inventarch/language';
import { load, stableSerialize } from '../src/index.js';
import type { LoadOptions } from '../src/index.js';
import { inputs, records, registry } from './native.js';

// The @spec composition-field-relations baseline guard (§4.1). It records what the
// corpus graph derives its edges from, before a second relation channel exists to
// blur it. Every assertion is recomputed from the compiled records: none is an
// observed count, so none of them survives a change that moves what it describes.
const options: LoadOptions = {
  sources: inputs,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
};
const native = load(records, registry, options);
const byIdentity = new Map(records.map((record) => [record.identity, record]));

/** The authored section a line sits in, or undefined when the line is outside every section. */
function sectionAt(record: CompiledRecord, line: number): string | undefined {
  return record.sections.find((section) => section.span.line <= line && line <= section.span.endLine)?.name;
}

function refsIn(value: CompiledValue): number {
  return value.kind === 'ref'
    ? 1
    : value.kind === 'list'
      ? value.items.filter((item) => item.kind === 'ref').length
      : 0;
}

function refsUnder(children: readonly CompiledChild[]): number {
  return children.reduce(
    (total, child) =>
      total + ('item' in child ? refsIn(child.item) : refsIn(child.value) + refsUnder(child.fields ?? [])),
    0,
  );
}

function refsInSection(name: string): number {
  return records.reduce(
    (total, record) =>
      total +
      record.sections
        .filter((section) => section.name === name)
        .reduce((n, section) => n + refsUnder(section.fields), 0),
    0,
  );
}

describe('composition-field-relations baseline (@spec composition-field-relations §4.1)', () => {
  it('derives every edge from a relationships or discriminators section, never from composition', () => {
    const origins = new Map<string, number>();
    for (const edge of native.edges) {
      const author = byIdentity.get(edge.author);
      expect(author, `edge author ${edge.author} is not a compiled record`).toBeDefined();
      expect(edge.source.path).toBe(author!.source.path);
      const section = sectionAt(author!, edge.source.line) ?? '(head)';
      origins.set(section, (origins.get(section) ?? 0) + 1);
    }
    // Two channels produce edges today and no others. If a composition ref ever
    // becomes an Edge, it lands here as a third key and this fails by name.
    expect([...origins.keys()].sort()).toEqual(['discriminators', 'relationships']);
  });

  it('accounts for every edge by the refs in those two sections', () => {
    // §1's reconciliation, recomputed. Equality also asserts that no two assertions
    // merged in the edge map, which is what makes a silent duplication visible.
    expect(native.edges.length).toBe(refsInSection('relationships') + refsInSection('discriminators'));
  });

  it('holds no edge whose predicate is outside the closed kernel set', () => {
    const histogram = new Map<string, number>();
    for (const edge of native.edges) histogram.set(edge.predicate, (histogram.get(edge.predicate) ?? 0) + 1);
    expect([...histogram.keys()].filter((predicate) => !(PREDICATES as readonly string[]).includes(predicate))).toEqual(
      [],
    );
    expect([...histogram.values()].reduce((a, b) => a + b, 0)).toBe(native.edges.length);
  });

  it('resolves every edge, leaving both dangling registers empty', () => {
    expect(native.dangling).toEqual([]);
    expect(native.byDanglingReference.size).toBe(0);
  });

  it('carries no error diagnostic and no diagnostic outside the codes the loader can raise', () => {
    expect(native.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(native.diagnostics).toEqual([]);
  });

  it('serialises its diagnostics, dangling and edges independently of input order', () => {
    const reversed = load([...records].reverse(), registry, { ...options, sources: [...inputs].reverse() });
    for (const member of ['diagnostics', 'dangling', 'edges'] as const) {
      expect(stableSerialize(reversed[member])).toBe(stableSerialize(native[member]));
    }
    expect(stableSerialize(reversed.byDanglingReference)).toBe(stableSerialize(native.byDanglingReference));
  });

  it('keeps the recorded revision independent of anything the graph derives', () => {
    expect(load(records, registry, options).revision).toBe(native.revision);
    expect(load([...records].reverse(), registry, { ...options, sources: [...inputs].reverse() }).revision).toBe(
      native.revision,
    );
  });
});
