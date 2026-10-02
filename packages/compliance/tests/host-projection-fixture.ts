import { expect } from 'vitest';
import type { Cell, CompiledEdge, CompiledRecord, CompiledValue } from '@ia/language';
import type { HostArtifacts } from '../src/index.js';

// Compiled-record builders shared by the steward rendering cases (host-projection.test.ts, which the public export
// omits with the private renderer body) and the public workspace projection cases.
export type Entry = readonly [key: string, value: CompiledValue | readonly CompiledValue[]];
export const str = (text: string): CompiledValue => ({ kind: 'string', text });
export const id = (text: string): CompiledValue => ({ kind: 'scalar', text });
export const ref = (discriminator: string, name: string): CompiledValue => ({ kind: 'ref', discriminator, name });
export const list = (...items: CompiledValue[]): CompiledValue => ({ kind: 'list', items });
let line = 100;
/** A compiled record as the compiler emits it: an array value becomes a block of `- item` children. */
export function record(
  system: string,
  discriminator: string,
  name: string,
  sections: Readonly<Record<string, readonly Entry[]>>,
  extra: { edges?: readonly CompiledEdge[]; cells?: readonly Cell[] } = {},
): CompiledRecord {
  const compiled = Object.entries(sections).map(([section, entries]) => ({
    name: section,
    span: { line: line++, endLine: line },
    fields: entries.map(([key, value]) => {
      const span = { line: line++, endLine: line };
      return Array.isArray(value)
        ? {
            key,
            value: { kind: 'block' } as CompiledValue,
            span,
            fields: (value as readonly CompiledValue[]).map((item) => ({
              item,
              span: { line: line++, endLine: line },
            })),
          }
        : { key, value: value as CompiledValue, span };
    }),
  }));
  const variants = compiled
    .filter((s) => s.name === 'governance')
    .flatMap((s) => s.fields)
    .map((f) => ({ key: f.key, value: f.value, span: f.span }));
  return {
    identity: `${system}/definition/${discriminator}/${name}`,
    system,
    kind: 'definition',
    facet: discriminator,
    name,
    displayName: name,
    discriminator,
    source: { path: `.ia/src/systems/${system}/probe/${discriminator}-${name}.ia`, line: 3, endLine: 30 },
    head: [],
    sections: compiled,
    edges: extra.edges ?? [],
    cells: extra.cells ?? [],
    selectors: [],
    variants,
    requirements: [],
    schema: discriminator,
    provenance: 'workspace',
    placement: { kind: 'authored', band: 100, reach: '' },
  } as unknown as CompiledRecord;
}
/** Replace agent-steward's governance with the given entries and add edges, keeping its identity and source. */
export function steward(
  pool: readonly CompiledRecord[],
  governance: readonly Entry[],
  edges: readonly CompiledEdge[] = [],
): CompiledRecord[] {
  return pool.map((r) => {
    if (r.discriminator !== 'agent' || r.name !== 'agent-steward') return r;
    const probe = record(
      'agent-system',
      'agent',
      'agent-steward',
      {
        meaning: [['says', str('The designated expert for expert agent identities and bounded mandates.')]],
        governance,
      },
      { edges },
    );
    return { ...r, sections: probe.sections, variants: probe.variants, edges };
  });
}
export const listRequires: Entry = [
  'requires',
  [str('Ground in agent-system schemas.'), str('Return validation evidence.')],
];
export function refusal(result: HostArtifacts): string {
  expect(result.artifacts).toEqual([]);
  expect(result.assessment.findings).toHaveLength(1);
  expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
  return result.assessment.findings[0]!.message;
}
