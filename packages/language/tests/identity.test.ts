import { describe, expect, it } from 'vitest';
import { collisions, identityOf } from '../src/identity.js';
import { parse } from '../src/parser/index.js';
import { buildRegistry, FLOOR_REGISTRATIONS } from '../src/registry/index.js';
import type { Location, Registration } from '../src/registry/types.js';
import { BANDS } from '../src/taxonomy.js';

const AGENT: Registration = {
  keyword: 'agent',
  system: 'agent-system',
  kind: 'binding',
  category: 'capability',
  facets: ['head', 'steward'],
  schema: 'agent',
  band: 100,
};
const record = (text: string) => {
  const parsed = parse(`#! ia 1.0\n${text}`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  return parsed.ast.records[0]!;
};

describe('identityOf', () => {
  it('uses the first declared facet, lowercases the name and keeps the authored spelling', () => {
    const r = identityOf(record('@agent Steward-One\n'), AGENT, 'a.ia');
    expect(r.diagnostics).toEqual([]);
    expect(r.identity).toEqual({
      identity: 'agent-system/binding/head/steward-one',
      system: 'agent-system',
      kind: 'binding',
      facet: 'head',
      name: 'steward-one',
      displayName: 'Steward-One',
    });
  });

  it('takes a declared facet from the head and refuses an undeclared one', () => {
    expect(identityOf(record('@agent a\n  facet steward\n'), AGENT, 'a.ia').identity?.identity).toBe(
      'agent-system/binding/steward/a',
    );
    const bad = identityOf(record('@agent a\n  facet rule\n'), AGENT, 'a.ia');
    expect(bad.identity).toBeUndefined();
    expect(bad.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-FACET-UNDECLARED', 3]]);
    expect(bad.diagnostics[0]?.message).toContain('head, steward');
  });

  it('uses the first declared facet even when it is not head', () => {
    const registration = { ...AGENT, facets: ['steward', 'head'] };
    const result = identityOf(record('@agent One\n'), registration, 'a.ia');
    expect(result.diagnostics).toEqual([]);
    expect(result.identity?.identity).toBe('agent-system/binding/steward/one');
  });

  it.each(['facet steward', 'facet "steward"', 'facet is steward'])(
    'reads the facet through the key rule: %s',
    (field) => {
      const result = identityOf(record(`@agent One\n  ${field}\n`), AGENT, 'a.ia');
      expect(result.diagnostics).toEqual([]);
      expect(result.identity).toMatchObject({
        facet: 'steward',
        identity: 'agent-system/binding/steward/one',
        displayName: 'One',
      });
    },
  );

  it.each(['Steward', '" steward "', '""', 'steward extra', '[steward]', '@agent steward', '"""steward"""'])(
    'refuses a facet that does not name a declared scalar or string: %s',
    (value) => {
      const result = identityOf(
        record(`@agent One\n  describes "a record"\n  facet ${value}\n`),
        AGENT,
        'Docs/Agent.ia',
      );
      expect(result.identity).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: 'IA-LANG-FACET-UNDECLARED',
        path: 'Docs/Agent.ia',
        line: 4,
        severity: 'error',
      });
      expect(result.diagnostics[0]?.message).toContain("for 'agent'; declared: head, steward");
    },
  );

  it.each(['facet label "steward"', 'facet is "steward"'])(
    'does not mistake a longer quoted key for facet: %s',
    (field) => {
      const result = identityOf(record(`@agent One\n  ${field}\n`), AGENT, 'a.ia');
      expect(result.diagnostics).toEqual([]);
      expect(result.identity?.facet).toBe('head');
    },
  );

  it('ignores facet fields in sections and nested record heads', () => {
    const parsed = record('@agent One\n  meaning\n    facet steward\n    @agent Child\n      facet steward\n');
    expect(identityOf(parsed, AGENT, 'a.ia').identity?.identity).toBe('agent-system/binding/head/one');
    expect(identityOf(parsed.nested[0]!, AGENT, 'a.ia').identity?.identity).toBe('agent-system/binding/steward/child');
  });

  it('uses the floor registrations for structural record identities', () => {
    const system = FLOOR_REGISTRATIONS.find((registration) => registration.keyword === 'system')!;
    const schema = FLOOR_REGISTRATIONS.find((registration) => registration.keyword === 'schema')!;
    expect(identityOf(record('@system Agent-System\n'), system, 'a.ia').identity?.identity).toBe(
      'floor/definition/system/agent-system',
    );
    expect(identityOf(record('@schema Agent\n'), schema, 'a.ia').identity?.identity).toBe('floor/contract/head/agent');
  });

  it('uses registrations from the minting join and collides synonymous discriminators in the same namespace', () => {
    const text = `#! ia 1.0
@system Agent-System
  provider "p"
  version "1.0.0"
  discriminators
    agent lowers to binding
      category capability
      facets [head, steward]
      schema @schema Agent
    worker lowers to binding
      category capability
      facets [head, steward]
      schema @schema Agent
@schema Agent
  lowers to binding
  sections
    closed
`;
    const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    const { registry, diagnostics } = buildRegistry([{ ...parse(text, 'system.ia'), location }]);
    expect(diagnostics).toEqual([]);
    const first = identityOf(record('@agent Same-Name\n'), registry.registrations.get('agent')!, 'one.ia');
    const second = identityOf(record('@worker SAME-NAME\n'), registry.registrations.get('worker')!, 'two.ia');
    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(first.identity?.identity).toBe('agent-system/binding/head/same-name');
    expect(second.identity?.identity).toBe(first.identity?.identity);
    expect(second.identity?.displayName).toBe('SAME-NAME');
    const found = collisions([
      { identity: first.identity!.identity, path: 'one.ia', line: 2, band: 100 },
      { identity: second.identity!.identity, path: 'two.ia', line: 2, band: 100 },
    ]);
    expect(found.refused.size).toBe(2);
    expect(found.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-IDENTITY-COLLISION', 'IA-LANG-IDENTITY-COLLISION']);
  });

  it('leaves the parsed record and registration unchanged', () => {
    const parsed = record('@agent Mixed-Case\n  facet steward\n');
    const before = structuredClone({ parsed, registration: AGENT });
    identityOf(parsed, AGENT, 'a.ia');
    expect({ parsed, registration: AGENT }).toEqual(before);
  });
});

describe('collisions', () => {
  it('refuses both occurrences of one identity at one band and none across bands', () => {
    const a = { identity: 'x/governance/head/law', path: 'a.ia', line: 2, band: 100 as const };
    const b = { identity: 'x/governance/head/law', path: 'b.ia', line: 9, band: 100 as const };
    const c = { identity: 'x/governance/head/law', path: 'c.ia', line: 4, band: 50 as const };
    const d = { identity: 'x/governance/head/other', path: 'a.ia', line: 5, band: 100 as const };
    const r = collisions([a, b, c, d]);
    expect([...r.refused]).toEqual([a, b]);
    expect(r.diagnostics.map((x) => [x.code, x.path, x.line, x.identity])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 'a.ia', 2, 'x/governance/head/law'],
      ['IA-LANG-IDENTITY-COLLISION', 'b.ia', 9, 'x/governance/head/law'],
    ]);
  });

  it('refuses every participant in a group of three, naming each other source', () => {
    const inputs = [
      { identity: 's/binding/head/same', path: 'a.ia', line: 2, band: 100 as const },
      { identity: 's/binding/head/same', path: 'a.ia', line: 8, band: 100 as const },
      { identity: 's/binding/head/same', path: 'b.ia', line: 4, band: 100 as const },
    ];
    const before = structuredClone(inputs);
    const result = collisions(inputs);
    expect([...result.refused]).toEqual(inputs);
    expect(result.diagnostics).toHaveLength(3);
    for (const [index, occurrence] of inputs.entries()) {
      const diagnostic = result.diagnostics[index]!;
      expect(diagnostic).toMatchObject({
        code: 'IA-LANG-IDENTITY-COLLISION',
        path: occurrence.path,
        line: occurrence.line,
        identity: occurrence.identity,
      });
      for (const other of inputs.filter((input) => input !== occurrence))
        expect(diagnostic.message).toContain(`${other.path}:${other.line}`);
    }
    expect(inputs).toEqual(before);
  });

  it('keeps each identity slot distinct', () => {
    const identities = [
      'a/binding/head/name',
      'b/binding/head/name',
      'a/definition/head/name',
      'a/binding/steward/name',
      'a/binding/head/other',
    ];
    const result = collisions(
      identities.map((identity, index) => ({ identity, path: 'a.ia', line: index + 2, band: 100 })),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.refused.size).toBe(0);
  });

  it('does not collide occurrences separated by any of the closed bands', () => {
    const result = collisions(
      BANDS.map((band) => ({ identity: 's/binding/head/same', path: `${band}.ia`, line: 2, band })),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.refused.size).toBe(0);
  });

  it('reports same-band collisions without making a cross-band authority decision', () => {
    const lowerOne = { identity: 's/binding/head/same', path: 'one.ia', line: 2, band: 50 as const };
    const lowerTwo = { ...lowerOne, path: 'two.ia' };
    const higher = { ...lowerOne, path: 'high.ia', band: 100 as const };
    const result = collisions([higher, lowerOne, lowerTwo]);
    expect([...result.refused]).toEqual([lowerOne, lowerTwo]);
    expect(result.diagnostics.map((d) => d.path)).toEqual(['one.ia', 'two.ia']);
  });

  it('handles multiple independent collision groups', () => {
    const inputs = ['one', 'two', 'one', 'two'].map((name, index) => ({
      identity: `s/binding/head/${name}`,
      path: 'a.ia',
      line: index + 2,
      band: 100 as const,
    }));
    const result = collisions(inputs);
    expect(result.refused.size).toBe(4);
    expect(result.diagnostics).toHaveLength(4);
    expect(result.diagnostics.filter((d) => d.identity === 's/binding/head/one').map((d) => d.line)).toEqual([2, 4]);
    expect(result.diagnostics.filter((d) => d.identity === 's/binding/head/two').map((d) => d.line)).toEqual([3, 5]);
  });

  it('accepts empty and singleton occurrence sets', () => {
    expect(collisions([])).toEqual({ refused: new Set(), diagnostics: [] });
    expect(collisions([{ identity: 's/binding/head/one', path: 'a.ia', line: 2, band: 100 }])).toEqual({
      refused: new Set(),
      diagnostics: [],
    });
  });
});
