import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { consentFor } from '../../src/registry/consent.js';
import { buildRegistry } from '../../src/registry/index.js';
import type { Location } from '../../src/registry/types.js';

const AUTHORED: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const OPEN: Location = { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' };
const source = (text: string, path: string, location = AUTHORED) => ({ ...parse(text, path), location });

const AGENT_SYSTEM = `#! ia 1.0
@system agent-system
  provider "agent-system"
  version "0.1.0"
  requires
    - taxonomy
  discriminators
    agent lowers to binding
      category capability
      facets [head]
      schema @schema agent
  edges
    cite * using agent
    use agent using *
@schema agent
  lowers to binding
  sections
    must have meaning
    closed
`;

const AGENT_DECLARATION = AGENT_SYSTEM.slice(0, AGENT_SYSTEM.indexOf('\n@schema agent')) + '\n';
const AGENT_SCHEMA = '#! ia 1.0\n@schema agent\n  lowers to binding\n  sections\n    closed\n';
const dependent = (name: string, required: string) =>
  `#! ia 1.0\n@system ${name}\n  provider "p"\n  version "1.0.0"\n  requires\n    - ${required}\n`;

describe('buildRegistry', () => {
  it('joins a system whose schema resolves, with the floor first and the built-ins in the order', () => {
    const { registry, diagnostics } = buildRegistry([source(AGENT_SYSTEM, 'agent.ia')]);
    expect(diagnostics).toEqual([]);
    expect(registry.order).toEqual(['floor', 'taxonomy', 'agent-system']);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema', 'agent']);
    expect(registry.registrations.get('agent')).toEqual({
      keyword: 'agent',
      system: 'agent-system',
      kind: 'binding',
      category: 'capability',
      facets: ['head'],
      schema: 'agent',
      band: 100,
    });
    expect(registry.schemas.get('agent')?.kind).toBe('binding');
    expect(registry.consent.get('agent-system')).toHaveLength(2);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('refuses a registration whose schema no file declares or whose schema lowers to another kind, and keeps the rest', () => {
    const text = AGENT_SYSTEM.replace('    schema @schema agent\n', '    schema @schema ghost\n');
    const missing = buildRegistry([source(text, 'a.ia')]);
    expect(missing.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-SCHEMA-MISSING', 8]]);
    expect(missing.registry.registrations.has('agent')).toBe(false);
    expect(missing.registry.systems.has('agent-system')).toBe(true);
    const mismatch = buildRegistry([
      source(AGENT_SYSTEM.replace('@schema agent\n  lowers to binding', '@schema agent\n  lowers to policy'), 'a.ia'),
    ]);
    expect(mismatch.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-SCHEMA-KIND-MISMATCH', 8]]);
  });

  it('does not report a refused schema as missing', () => {
    const text = AGENT_SYSTEM.replace(
      '  sections\n    must have meaning\n    closed\n',
      '  sections\n    must have meaning\n',
    );
    const r = buildRegistry([source(text, 'a.ia')]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SCHEMA-MALFORMED']);
    expect(r.registry.registrations.has('agent')).toBe(false);
  });

  it('merges across sources and bands and answers two-sided consent', () => {
    const law = `#! ia 1.0
@system governance-system
  provider "g"
  version "1.0.0"
  requires
    - agent-system
  discriminators
    law lowers to governance
      category rule
      facets [head]
      schema @schema law
  edges
    cite law using check
@schema law
  lowers to governance
  sections
    closed
`;
    const { registry, diagnostics } = buildRegistry([source(law, 'law.ia', OPEN), source(AGENT_SYSTEM, 'agent.ia')]);
    expect(diagnostics).toEqual([]);
    expect(registry.order).toEqual(['floor', 'taxonomy', 'agent-system', 'governance-system']);
    expect(registry.registrations.get('law')?.band).toBe(50);
    // agent-system admits `cite * using agent`; governance-system admits `cite law using check` only.
    expect(consentFor(registry, 'cite', 'agent', 'law')).toBe('target');
    expect(consentFor(registry, 'use', 'agent', 'law')).toBe('source');
    expect(consentFor(registry, 'cite', 'law', 'agent')).toBe('source');
    expect(consentFor(registry, 'cite', 'ghost', 'law')).toBeUndefined();
  });

  it('refuses a system that requires one not in force, sorted by path then line', () => {
    const text = AGENT_SYSTEM.replace('    - taxonomy\n', '    - taxonomy\n    - product-system\n');
    const r = buildRegistry([source(text, 'a.ia')]);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-SYSTEM-MISSING', 7]]);
    expect(r.registry.order).toEqual(['floor', 'taxonomy']);
    expect(r.registry.registrations.has('agent')).toBe(false);
  });

  it('builds the floor without sources or authored floor schemas', () => {
    const { registry, diagnostics } = buildRegistry([]);
    expect(diagnostics).toEqual([]);
    expect(registry.order).toEqual(['floor', 'taxonomy']);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema']);
    expect(registry.systems.size).toBe(0);
    expect(registry.schemas.size).toBe(0);
    expect([...registry.consent]).toEqual([
      ['floor', [{ predicate: 'cite', targets: ['schema'], sources: '*', span: { line: 1, endLine: 1 } }]],
    ]);
    expect(registry.blocked.size).toBe(0);
  });

  it('takes the higher-band system and its ledger using normalized identity names', () => {
    const lower = AGENT_DECLARATION.replace('provider "agent-system"', 'provider "old"').replace(
      'cite * using agent',
      'cite law using agent',
    );
    const higher = AGENT_DECLARATION.replace('@system agent-system', '@system AGENT-SYSTEM').replace(
      'schema @schema agent',
      'schema @schema Agent',
    );
    const { registry, diagnostics } = buildRegistry([
      source(lower, 'low.ia', OPEN),
      source(higher, 'high.ia'),
      source(AGENT_SCHEMA, 'schema.ia'),
    ]);
    expect(diagnostics).toEqual([]);
    expect(registry.systems.get('agent-system')?.displayName).toBe('AGENT-SYSTEM');
    expect(registry.systems.get('agent-system')?.provider).toBe('agent-system');
    expect(registry.registrations.get('agent')?.band).toBe(100);
    expect(consentFor(registry, 'cite', 'agent', 'agent')).toBeUndefined();
  });

  it('refuses colliding system declarations without reviving their lower-band declaration', () => {
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_DECLARATION, 'one.ia'),
      source(AGENT_DECLARATION, 'two.ia'),
      source(AGENT_DECLARATION, 'low.ia', OPEN),
      source(AGENT_SCHEMA, 'schema.ia'),
    ]);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 'one.ia'],
      ['IA-LANG-IDENTITY-COLLISION', 'two.ia'],
    ]);
    expect(registry.order).toEqual(['floor', 'taxonomy']);
    expect(registry.systems.size).toBe(0);
    expect([...registry.consent.keys()]).toEqual(['floor']);
    expect(registry.registrations.has('agent')).toBe(false);
    expect(registry.schemas.has('agent')).toBe(true);
  });

  it('blocks a conflicting keyword without resolving its schema or blocking independent words', () => {
    const one = AGENT_DECLARATION.replace('@system agent-system', '@system one').replace(
      'schema @schema agent',
      'schema @schema ghost',
    );
    const two = one.replace('@system one', '@system two');
    const { registry, diagnostics } = buildRegistry([
      source(one, 'one.ia'),
      source(two, 'two.ia'),
      source(AGENT_SYSTEM, 'low.ia', OPEN),
      source(AGENT_SYSTEM.replaceAll('agent', 'worker'), 'worker.ia'),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-DISCRIMINATOR-CONFLICT',
      'IA-LANG-DISCRIMINATOR-CONFLICT',
    ]);
    expect([...registry.blocked]).toEqual(['agent']);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema', 'worker']);
    expect(registry.systems.size).toBe(4);
  });

  it('does not revive a lower provider when the winning registration fails the schema join', () => {
    const higher = AGENT_DECLARATION.replace('schema @schema agent', 'schema @schema ghost');
    const lower = AGENT_SYSTEM.replace('@system agent-system', '@system old');
    const { registry, diagnostics } = buildRegistry([source(higher, 'high.ia'), source(lower, 'low.ia', OPEN)]);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['IA-LANG-SCHEMA-MISSING', 'high.ia']]);
    expect(registry.registrations.has('agent')).toBe(false);
    expect(registry.blocked.size).toBe(0); // Only winning-band keyword conflicts populate this set.
    expect(registry.systems.size).toBe(2);
  });

  it('reports a winning-band schema collision without adding a missing-schema diagnostic', () => {
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_DECLARATION, 'system.ia'),
      source(AGENT_SCHEMA, 'one.ia'),
      source(AGENT_SCHEMA, 'two.ia'),
      source(AGENT_SCHEMA, 'low.ia', OPEN),
    ]);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 'one.ia'],
      ['IA-LANG-IDENTITY-COLLISION', 'two.ia'],
    ]);
    expect(registry.schemas.has('agent')).toBe(false);
    expect(registry.registrations.has('agent')).toBe(false);
    expect(registry.systems.has('agent-system')).toBe(true);
  });

  it('joins against the highest-band schema and silently shadows lower schema collisions', () => {
    const lower = AGENT_SCHEMA.replace('lowers to binding', 'lowers to policy');
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_DECLARATION, 'system.ia'),
      source(lower, 'low-one.ia', OPEN),
      source(lower, 'low-two.ia', OPEN),
      source(AGENT_SCHEMA, 'high.ia'),
    ]);
    expect(diagnostics).toEqual([]);
    expect(registry.schemas.get('agent')?.path).toBe('high.ia');
    expect(registry.registrations.has('agent')).toBe(true);
  });

  it('does not fall back to a lower schema when the winning schema has the wrong kind', () => {
    const higher = AGENT_SCHEMA.replace('lowers to binding', 'lowers to policy');
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_DECLARATION, 'system.ia'),
      source(AGENT_SCHEMA, 'low.ia', OPEN),
      source(higher, 'high.ia'),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SCHEMA-KIND-MISMATCH']);
    expect(registry.schemas.get('agent')?.kind).toBe('policy');
    expect(registry.registrations.has('agent')).toBe(false);
  });

  it('keeps a joined sibling registration and the system ledger when one schema is missing', () => {
    const text = AGENT_SYSTEM.replace('schema @schema agent', 'schema @schema ghost').replace(
      '  edges\n',
      '    worker lowers to binding\n      category capability\n      facets [head]\n      schema @schema agent\n  edges\n',
    );
    const { registry, diagnostics } = buildRegistry([source(text, 'a.ia')]);
    expect(diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SCHEMA-MISSING']);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema', 'worker']);
    expect(registry.systems.has('agent-system')).toBe(true);
    expect(registry.consent.get('agent-system')).toHaveLength(2);
  });

  it.each([
    [AGENT_SYSTEM.replace('provider "agent-system"', 'provider @agent 123'), false, true],
    [AGENT_SYSTEM.replace('schema @schema agent', 'schema @schema 123'), true, true],
    [AGENT_SYSTEM.replace('    closed\n', '    closed "broken\n'), true, false],
  ] as const)(
    'retains parser refusals once without secondary extraction or join diagnostics: %s',
    (text, hasSystem, hasSchema) => {
      const input = source(text, 'a.ia');
      expect(input.diagnostics).toHaveLength(1);
      const { registry, diagnostics } = buildRegistry([input]);
      expect(diagnostics).toEqual(input.diagnostics);
      expect(registry.systems.has('agent-system')).toBe(hasSystem);
      expect(registry.schemas.has('agent')).toBe(hasSchema);
      expect(registry.registrations.has('agent')).toBe(false);
    },
  );

  it('retains file and ordinary-record parser errors once while joining valid declarations', () => {
    const noPragma = source('@agent sample\n  title "broken\n', 'a.ia');
    const input = source(AGENT_SYSTEM + '@agent sample\n  title "broken\n', 'b.ia');
    expect(noPragma.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-PRAGMA-MISSING']);
    expect(input.diagnostics.map((d) => d.code)).toEqual(['IA-LANG-STRING-UNTERMINATED']);
    const { registry, diagnostics } = buildRegistry([input, noPragma]);
    expect(diagnostics).toEqual([...noPragma.diagnostics, ...input.diagnostics]);
    expect(registry.registrations.has('agent')).toBe(true);
  });

  it('uses a valid schema winner even when another declaration of that schema was refused', () => {
    const invalid = AGENT_SCHEMA.replace('    closed\n', '    must have meaning\n');
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_DECLARATION, 'system.ia'),
      source(invalid, 'invalid.ia'),
      source(AGENT_SCHEMA, 'valid.ia'),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SCHEMA-MALFORMED']);
    expect(registry.schemas.get('agent')?.path).toBe('valid.ia');
    expect(registry.registrations.has('agent')).toBe(true);
  });

  it('sorts diagnostics from different stages by path and then line', () => {
    const first = AGENT_SYSTEM.replace('schema @schema agent', 'schema @schema ghost').replace(
      'cite * using agent',
      'invent * using agent',
    );
    const last = AGENT_SYSTEM.replaceAll('agent', 'worker').replace('version "0.1.0"', 'version "01.0.0"');
    const { diagnostics } = buildRegistry([source(last, 'z.ia'), source(first, 'a.ia')]);
    expect(diagnostics.map((d) => [d.path, d.line, d.code])).toEqual([
      ['a.ia', 8, 'IA-LANG-SCHEMA-MISSING'],
      ['a.ia', 13, 'IA-LANG-PREDICATE-UNKNOWN'],
      ['z.ia', 4, 'IA-LANG-REGISTRATION-INCOMPLETE'],
    ]);
  });

  it('joins nested systems and schemas without needing the enclosing discriminator registered', () => {
    const nested = AGENT_SYSTEM.trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => '    ' + line)
      .join('\n');
    const { registry, diagnostics } = buildRegistry([
      source('#! ia 1.0\n@unknown outer\n  children\n' + nested + '\n', 'nested.ia'),
    ]);
    expect(diagnostics).toEqual([]);
    expect([...registry.systems.keys()]).toEqual(['agent-system']);
    expect([...registry.schemas.keys()]).toEqual(['agent']);
    expect(registry.registrations.has('agent')).toBe(true);
  });

  it('removes systems and their ledgers transitively when a requirement is missing', () => {
    const missing = AGENT_SYSTEM.replace('    - taxonomy', '    - ghost');
    const { registry, diagnostics } = buildRegistry([
      source(missing, 'a.ia'),
      source(dependent('dependent', 'AGENT-SYSTEM'), 'b.ia'),
      source(AGENT_SYSTEM.replaceAll('agent', 'worker'), 'worker.ia'),
    ]);
    expect(diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([
      ['IA-LANG-SYSTEM-MISSING', 'a.ia', 6],
      ['IA-LANG-SYSTEM-MISSING', 'b.ia', 6],
    ]);
    expect(registry.order).toEqual(['floor', 'taxonomy', 'worker-system']);
    expect([...registry.systems.keys()]).toEqual(['worker-system']);
    expect([...registry.consent.keys()]).toEqual(['worker-system', 'floor']);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema', 'worker']);
    expect(registry.schemas.has('agent')).toBe(true);
  });

  it('removes cycles before registering their words or consent ledgers', () => {
    const text = AGENT_SYSTEM.replace('    - taxonomy', '    - peer');
    const { registry, diagnostics } = buildRegistry([
      source(text, 'a.ia'),
      source(dependent('peer', 'agent-system'), 'b.ia'),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SYSTEM-CYCLE', 'IA-LANG-SYSTEM-CYCLE']);
    expect(registry.order).toEqual(['floor', 'taxonomy']);
    expect(registry.systems.size).toBe(0);
    expect([...registry.consent.keys()]).toEqual(['floor']);
    expect(registry.registrations.has('agent')).toBe(false);
  });

  it('merges keywords only from systems still in force', () => {
    const higher = AGENT_DECLARATION.replace('    - taxonomy', '    - ghost');
    const lower = AGENT_SYSTEM.replace('@system agent-system', '@system old');
    const { registry, diagnostics } = buildRegistry([source(higher, 'high.ia'), source(lower, 'low.ia', OPEN)]);
    expect(diagnostics.map((d) => d.code)).toEqual(['IA-LANG-SYSTEM-MISSING']);
    expect(registry.registrations.get('agent')).toMatchObject({ system: 'old', band: 50 });
    expect([...registry.consent.keys()]).toEqual(['old', 'floor']);
  });

  it.each(['floor', 'taxonomy'])('includes built-in %s only once when it also has an authored declaration', (name) => {
    const { registry, diagnostics } = buildRegistry([
      source(AGENT_SYSTEM.replace('@system agent-system', '@system ' + name), 'a.ia'),
    ]);
    expect(diagnostics).toEqual([]);
    expect(registry.order).toEqual(['floor', 'taxonomy']);
    expect(registry.systems.has(name)).toBe(true);
    expect(registry.registrations.get('agent')?.system).toBe(name);
  });

  it.each([
    [AGENT_SYSTEM.replace('schema @schema agent', 'schema @schema ghost'), 'IA-LANG-SCHEMA-MISSING'],
    [
      AGENT_SYSTEM.replace('@schema agent\n  lowers to binding', '@schema agent\n  lowers to policy'),
      'IA-LANG-SCHEMA-KIND-MISMATCH',
    ],
  ] as const)('validates minted words owned by a system named floor: %s', (text, code) => {
    const { registry, diagnostics } = buildRegistry([
      source(text.replace('@system agent-system', '@system floor'), 'a.ia'),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual([code]);
    expect([...registry.registrations.keys()]).toEqual(['system', 'schema']);
  });

  it('is repeatable and leaves source ASTs and parser diagnostics unchanged', () => {
    const inputs = [source(AGENT_SYSTEM, 'a.ia')];
    const before = structuredClone(inputs);
    const first = buildRegistry(inputs);
    const second = buildRegistry(inputs);
    expect(inputs).toEqual(before);
    expect(second).toEqual(first);
    expect(second.registry.systems).not.toBe(first.registry.systems);
    expect(second.registry.registrations).not.toBe(first.registry.registrations);
  });
});

describe('consentFor', () => {
  const worker = AGENT_SYSTEM.replaceAll('agent', 'worker').replace('cite * using worker', 'cite worker using agent');

  it('admits a resolved edge only when both owning systems admit it', () => {
    const { registry, diagnostics } = buildRegistry([source(AGENT_SYSTEM, 'agent.ia'), source(worker, 'worker.ia')]);
    expect(diagnostics).toEqual([]);
    expect(consentFor(registry, 'cite', 'agent', 'worker')).toBeUndefined();
    expect(consentFor(registry, 'cite', 'worker', 'agent')).toBe('source');
    expect(consentFor(registry, 'use', 'agent', 'worker')).toBe('source');
  });

  it('requires consent even when both records belong to the same system', () => {
    const { registry } = buildRegistry([source(AGENT_SYSTEM, 'agent.ia')]);
    expect(consentFor(registry, 'cite', 'agent', 'agent')).toBeUndefined();
    expect(consentFor(registry, 'govern', 'agent', 'agent')).toBe('source');
  });

  it('treats an absent ledger as refusal on its side and checks the source first', () => {
    const noLedger = AGENT_SYSTEM.replace('  edges\n    cite * using agent\n    use agent using *\n', '');
    const sourceMissing = buildRegistry([source(noLedger, 'agent.ia'), source(worker, 'worker.ia')]).registry;
    expect(consentFor(sourceMissing, 'cite', 'agent', 'worker')).toBe('source');
    const targetMissing = buildRegistry([
      source(AGENT_SYSTEM, 'agent.ia'),
      source(noLedger.replaceAll('agent', 'worker'), 'worker.ia'),
    ]).registry;
    expect(consentFor(targetMissing, 'cite', 'agent', 'worker')).toBe('target');
    expect(consentFor(targetMissing, 'govern', 'agent', 'worker')).toBe('source');
    expect(consentFor(targetMissing, 'cite', 'agent', 'system')).toBe('target');
  });

  it.each([
    ['ghost', 'agent'],
    ['agent', 'ghost'],
    ['ghost', 'other'],
  ])('leaves an unregistered endpoint to its record diagnostic: %s -> %s', (from, to) => {
    const { registry } = buildRegistry([source(AGENT_SYSTEM, 'agent.ia')]);
    expect(consentFor(registry, 'cite', from, to)).toBeUndefined();
  });
});
