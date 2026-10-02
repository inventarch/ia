import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compile/compile.js';
import type { CompiledChild } from '../../src/compile/compile.js';
import { parse } from '../../src/parser/index.js';
import { buildRegistry } from '../../src/registry/index.js';
import { compile as exportedCompile } from '../../src/compile/index.js';
import type { Location } from '../../src/registry/types.js';

const AUTHORED: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
const FLOOR_TEXT = `#! ia 1.0
@system agent-system
  provider "agent-system"
  version "0.1.0"
  requires
    - taxonomy
  discriminators
    agent lowers to binding
      category capability
      facets [head, steward]
      schema @schema agent
  edges
    cite * using agent
@schema agent
  lowers to binding
  sections
    must have meaning
    closed
`;
const floorParsed = parse(FLOOR_TEXT, 'systems\\agent-system\\system.ia');
const { registry } = buildRegistry([{ ...floorParsed, location: AUTHORED }]);
const run = (text: string, path = 'records/a.ia') => compile(parse(text, path).ast, registry, AUTHORED, []);
const keys = (fields: readonly CompiledChild[]) => fields.map((f) => ('key' in f ? f.key : undefined));

describe('compile', () => {
  it('compiles the floor file: a system with ground edges and a schema, paths canonical, keys spelled', () => {
    const r = compile(floorParsed.ast, registry, AUTHORED, []);
    expect(r.diagnostics).toEqual([]);
    expect(r.records.map((x) => x.identity)).toEqual([
      'floor/definition/system/agent-system',
      'floor/contract/head/agent',
    ]);
    const [system, schema] = r.records;
    expect(system).toMatchObject({
      discriminator: 'system',
      kind: 'definition',
      facet: 'system',
      name: 'agent-system',
      displayName: 'agent-system',
      schema: 'floor/contract/head/system',
      provenance: 'workspace',
      placement: AUTHORED.placement,
      source: { path: 'systems/agent-system/system.ia', line: 2, endLine: 13 },
    });
    expect(system?.edges).toEqual([
      {
        predicate: 'ground',
        direction: 'out',
        reference: { kind: 'ref', discriminator: 'schema', name: 'agent' },
        target: 'floor/contract/head/agent',
        span: { line: 8, endLine: 11 },
      },
    ]);
    expect(keys(system?.head ?? [])).toEqual(['provider', 'version']);
    expect(system?.sections.map((s) => s.name)).toEqual(['requires', 'discriminators', 'edges']);
    expect(system?.sections[0]?.fields).toEqual([
      { item: { kind: 'scalar', text: 'taxonomy' }, span: { line: 6, endLine: 6 } },
    ]);
    const entry = system?.sections[1]?.fields[0];
    expect(entry).toMatchObject({ key: 'agent', value: { kind: 'scalar', text: 'lowers to binding' } });
    expect(entry !== undefined && 'key' in entry ? keys(entry.fields ?? []) : undefined).toEqual([
      'category',
      'facets',
      'schema',
    ]);
    expect(schema?.head).toEqual([
      { key: 'lowers to', value: { kind: 'scalar', text: 'binding' }, span: { line: 15, endLine: 15 } },
    ]);
    expect(keys(schema?.sections[0]?.fields ?? [])).toEqual(['must have', 'closed']);
    expect(schema?.schema).toBe('floor/contract/head/schema');
    expect(r.sourceMap.map((m) => m.identity)).toEqual(r.records.map((x) => x.identity));
    expect(r.sourceMap[0]?.fields.map((f) => f.path)).toEqual([
      'head.provider',
      'head.version',
      'discriminators.agent',
      'discriminators.agent.category',
      'discriminators.agent.facets',
      'discriminators.agent.schema',
      'edges.cite',
    ]);
    expect(r.sourceMap[0]?.header).toEqual({ line: 2, endLine: 2 });
    expect(r.sourceMap[0]?.edges).toEqual(system?.edges.map((edge) => edge.span));
  });

  it('compiles an instance, consumes its facet, and refuses an unregistered word naming the visible systems', () => {
    const r = run(
      '#! ia 1.0\n@agent Steward-One\n  facet steward\n  meaning\n    says "I steward agent-system"\n@workspace w\n',
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      identity: 'agent-system/binding/steward/steward-one',
      displayName: 'Steward-One',
      head: [],
      schema: 'floor/contract/head/agent',
    });
    expect(r.records[0]?.parent).toBeUndefined();
    expect(r.records[0]?.sections[0]?.fields).toEqual([
      { key: 'says', value: { kind: 'string', text: 'I steward agent-system' }, span: { line: 5, endLine: 5 } },
    ]);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-DISCRIMINATOR-UNREGISTERED', 6]]);
    expect(r.diagnostics[0]?.message).toContain('floor, taxonomy, agent-system');
    expect(r.sourceMap[0]?.fields[0]).toEqual({ path: 'head.facet', span: { line: 3, endLine: 3 } });
  });

  it('compiles a nested record with parent, in document order, and keeps it out of the fields', () => {
    const r = run('#! ia 1.0\n@agent a\n  team\n    @agent b\n      meaning\n        says "b"\n    lead "x"\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.records.map((x) => [x.identity, x.parent])).toEqual([
      ['agent-system/binding/head/a', undefined],
      ['agent-system/binding/head/b', 'agent-system/binding/head/a'],
    ]);
    expect(r.records[0]?.sections[0]?.fields).toEqual([
      { key: 'lead', value: { kind: 'string', text: 'x' }, span: { line: 7, endLine: 7 } },
    ]);
    expect(r.sourceMap[1]).toEqual({
      identity: 'agent-system/binding/head/b',
      header: { line: 4, endLine: 4 },
      sections: [{ name: 'meaning', span: { line: 5, endLine: 6 } }],
      fields: [{ path: 'meaning.says', span: { line: 6, endLine: 6 } }],
      edges: [],
      cells: [],
      selectors: [],
      variants: [],
      requirements: [],
    });
  });

  it('preserves item/block previews and diagnoses an ordinary field condition', () => {
    const r = run(
      '#! ia 1.0\n@agent a\n  notes\n    - one\n    - "two words"\n    state active when phase is act\n    holds\n      inner "i"\n',
    );
    expect(r.records[0]?.sections[0]?.fields).toEqual([
      { item: { kind: 'scalar', text: 'one' }, span: { line: 4, endLine: 4 } },
      { item: { kind: 'string', text: 'two words' }, span: { line: 5, endLine: 5 } },
      {
        key: 'state',
        value: { kind: 'scalar', text: 'active' },
        when: ['phase', 'is', 'act'],
        span: { line: 6, endLine: 6 },
      },
      {
        key: 'holds',
        value: { kind: 'block' },
        span: { line: 7, endLine: 8 },
        fields: [{ key: 'inner', value: { kind: 'string', text: 'i' }, span: { line: 8, endLine: 8 } }],
      },
    ]);
    expect(r.sourceMap[0]?.fields.map((f) => f.path)).toEqual(['notes.state', 'notes.holds', 'notes.holds.inner']);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-CONDITION-MISPLACED', 6]]);
  });

  it('refuses both records of one identity in a file and keeps the rest', () => {
    const r = run('#! ia 1.0\n@agent same\n@agent Same\n@agent other\n');
    expect(r.records.map((x) => x.identity)).toEqual(['agent-system/binding/head/other']);
    expect(r.diagnostics.map((d) => [d.code, d.line, d.identity])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 2, 'agent-system/binding/head/same'],
      ['IA-LANG-IDENTITY-COLLISION', 3, 'agent-system/binding/head/same'],
    ]);
  });

  it('refuses an undeclared facet and compiles nothing beneath a refused record', () => {
    const r = run('#! ia 1.0\n@agent a\n  facet rule\n  team\n    @agent b\n');
    expect(r.records).toEqual([]);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-FACET-UNDECLARED', 3]]);
  });

  it('names a blocked keyword as blocked', () => {
    const conflict = `#! ia 1.0
@system a
  provider "a"
  version "1.0.0"
  discriminators
    law lowers to governance
      category rule
      facets [head]
      schema @schema law
@system b
  provider "b"
  version "1.0.0"
  discriminators
    law lowers to governance
      category rule
      facets [head]
      schema @schema law
@schema law
  lowers to governance
  sections
    closed
`;
    const built = buildRegistry([{ ...parse(conflict, 'c.ia'), location: AUTHORED }]);
    expect(built.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-DISCRIMINATOR-CONFLICT', 6],
      ['IA-LANG-DISCRIMINATOR-CONFLICT', 14],
    ]);
    const r = compile(parse('#! ia 1.0\n@law x\n', 'l.ia').ast, built.registry, AUTHORED, []);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-DISCRIMINATOR-UNREGISTERED', 2]]);
    expect(r.diagnostics[0]?.message).toContain('blocked');
  });

  it('drops children and grandchildren of collided parents without extra refusal diagnostics', () => {
    const r = run(
      '#! ia 1.0\n@agent Same\n  team\n    @agent child\n      team\n        @agent grandchild\n@agent same\n  team\n    @agent second-child\n@agent other\n',
    );
    expect(r.records.map((record) => record.name)).toEqual(['other']);
    expect(r.sourceMap.map((map) => map.identity)).toEqual(r.records.map((record) => record.identity));
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 2],
      ['IA-LANG-IDENTITY-COLLISION', 7],
    ]);
  });

  it('refuses a collision between top-level and nested records while keeping their other relatives', () => {
    const r = run(
      '#! ia 1.0\n@agent root\n  team\n    @agent same\n      team\n        @agent child\n    @agent sibling\n@agent Same\n',
    );
    expect(r.records.map((record) => [record.name, record.parent])).toEqual([
      ['root', undefined],
      ['sibling', 'agent-system/binding/head/root'],
    ]);
    expect(r.diagnostics.map((d) => d.line)).toEqual([4, 8]);
  });

  it('visits nested records under head fields and deep blocks exactly once, with the nearest parent', () => {
    const r = run(
      '#! ia 1.0\n@agent root\n  describes "root"\n    @agent head-child\n  team\n    group\n      @agent child\n        team\n          @agent grandchild\n',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.records.map((record) => [record.name, record.parent?.split('/').at(-1)])).toEqual([
      ['root', undefined],
      ['head-child', 'root'],
      ['child', 'root'],
      ['grandchild', 'child'],
    ]);
    expect(r.records[0]?.head[0]?.fields).toEqual([]);
    expect(r.records[0]?.sections[0]?.fields).toEqual([
      { key: 'group', value: { kind: 'block' }, span: { line: 6, endLine: 9 }, fields: [] },
    ]);
  });

  it('does not inspect anything beneath an unregistered record', () => {
    const r = run('#! ia 1.0\n@unknown root\n  team\n    @unknown bad\n    @agent a\n      facet invalid\n@agent a\n');
    expect(r.records.map((record) => record.name)).toEqual(['a']);
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-DISCRIMINATOR-UNREGISTERED', 2]]);
  });

  it('retains nested records under a consumed facet field and maps the facet span', () => {
    const r = run('#! ia 1.0\n@agent root\n  facet steward\n    @agent child\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.records.map((record) => [record.identity, record.parent])).toEqual([
      ['agent-system/binding/steward/root', undefined],
      ['agent-system/binding/head/child', 'agent-system/binding/steward/root'],
    ]);
    expect(r.records[0]?.head).toEqual([]);
    expect(r.sourceMap[0]?.fields).toEqual([{ path: 'head.facet', span: { line: 3, endLine: 4 } }]);
  });

  it('sorts mixed-stage diagnostics by source line and canonicalizes their paths', () => {
    const r = run(
      '#! ia 1.0\n@agent same\n@unknown x\n@agent bad\n  facet invalid\n@agent Same\n',
      '.\\Records\\tmp\\..\\a.ia',
    );
    expect(r.records).toEqual([]);
    expect(r.sourceMap).toEqual([]);
    expect(r.diagnostics.map((d) => [d.code, d.line, d.path])).toEqual([
      ['IA-LANG-IDENTITY-COLLISION', 2, 'Records/a.ia'],
      ['IA-LANG-DISCRIMINATOR-UNREGISTERED', 3, 'Records/a.ia'],
      ['IA-LANG-FACET-UNDECLARED', 5, 'Records/a.ia'],
      ['IA-LANG-IDENTITY-COLLISION', 6, 'Records/a.ia'],
    ]);
  });

  it('uses schema spellings in head and section fields, keeping assertive and quoted keys', () => {
    // The compiler consumes resolved spellings; the floor also supplies multi-word keys.
    const schema = registry.schemas.get('agent')!;
    const withSpellings = {
      ...registry,
      schemas: new Map(registry.schemas).set('agent', {
        ...schema,
        fields: [
          { section: 'head', key: 'display title', type: 'text' as const, must: false, span: schema.span },
          { section: 'meaning', key: 'long key', type: 'text' as const, must: false, span: schema.span },
          { section: 'meaning', key: 'long', type: 'text' as const, must: false, span: schema.span },
        ],
      }),
    };
    const ast = parse(
      '#! ia 1.0\n@agent a\n  display title The Agent\n  meaning\n    long key some words\n    long is asserted\n    long key "quoted"\n    long key\n  notes\n    long key fallback\n',
      'a.ia',
    ).ast;
    const r = compile(ast, withSpellings, AUTHORED, []);
    expect(r.diagnostics).toEqual([]);
    expect(r.records[0]?.head[0]).toMatchObject({ key: 'display title', value: { kind: 'scalar', text: 'The Agent' } });
    expect(r.records[0]?.sections[0]?.fields).toMatchObject([
      { key: 'long key', value: { kind: 'scalar', text: 'some words' } },
      { key: 'long', value: { kind: 'scalar', text: 'asserted' } },
      { key: 'long key', value: { kind: 'string', text: 'quoted' } },
      { key: 'long key', value: { kind: 'none' } },
    ]);
    expect(r.records[0]?.sections[1]?.fields[0]).toMatchObject({
      key: 'long',
      value: { kind: 'scalar', text: 'key fallback' },
    });
    expect(r.sourceMap[0]?.fields.map((field) => field.path)).toEqual([
      'head.display title',
      'meaning.long key',
      'meaning.long',
      'meaning.long key',
      'meaning.long key',
      'notes.long',
    ]);
  });

  it('preserves references, lists, folded prose, bare fields and items inside blocks', () => {
    const r = run(
      '#! ia 1.0\n@agent a\n  notes\n    cites @agent Mixed#frag\n    tags [one, "two words", @agent Mixed#frag]\n    says """First\n      second\n    """\n    empty\n    block\n      - @agent Mixed#frag\n',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.records[0]?.sections[0]?.fields).toMatchObject([
      { key: 'cites', value: { kind: 'ref', discriminator: 'agent', name: 'Mixed', fragment: 'frag' } },
      {
        key: 'tags',
        value: {
          kind: 'list',
          items: [
            { kind: 'scalar', text: 'one' },
            { kind: 'string', text: 'two words' },
            { kind: 'ref', discriminator: 'agent', name: 'Mixed', fragment: 'frag' },
          ],
        },
      },
      { key: 'says', value: { kind: 'prose', text: 'First second' }, span: { line: 6, endLine: 8 } },
      { key: 'empty', value: { kind: 'none' } },
      {
        key: 'block',
        value: { kind: 'block' },
        fields: [
          {
            item: { kind: 'ref', discriminator: 'agent', name: 'Mixed', fragment: 'frag' },
            span: { line: 11, endLine: 11 },
          },
        ],
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('"raw"');
  });

  it('keeps parser preview values but refuses the owning compiled record without duplicate diagnostics', () => {
    const parsed = parse('#! ia 1.0\n@agent a\n  notes\n    -\n    says @agent 123\n', 'a.ia');
    expect(parsed.diagnostics).toHaveLength(2);
    const r = compile(parsed.ast, registry, AUTHORED, []);
    expect(r.diagnostics).toEqual([]);
    expect(
      parsed.ast.records[0]?.sections[0]?.children.map((child) => ('value' in child ? child.value : undefined)),
    ).toEqual([{ kind: 'none' }, { kind: 'none' }]);
    expect(r.records).toEqual([]);
    expect(r.sourceMap).toEqual([]);
  });

  it('copies location metadata and leaves later semantic products empty', () => {
    const location: Location = { placement: { kind: 'open', band: 50, reach: 'scope' }, provenance: 'methodology' };
    const r = compile(parse('#! ia 1.0\n@agent A\n', '.\\scope\\a.ia').ast, registry, location, []);
    expect(r.records[0]).toMatchObject({
      identity: 'agent-system/binding/head/a',
      displayName: 'A',
      source: { path: 'scope/a.ia', line: 2, endLine: 2 },
      placement: location.placement,
      provenance: location.provenance,
      edges: [],
      cells: [],
      selectors: [],
      variants: [],
      requirements: [],
    });
  });

  it('compiles deterministically without mutating its explicit inputs', () => {
    const parsed = parse('#! ia 1.0\n@agent a\n  notes\n    holds ["one", @agent Mixed#frag]\n', 'a.ia');
    const before = structuredClone({ ast: parsed.ast, registry, location: AUTHORED });
    const pool = Object.freeze([]);
    const result = compile(parsed.ast, registry, AUTHORED, pool);
    expect(compile(parsed.ast, registry, AUTHORED, pool)).toEqual(result);
    expect({ ast: parsed.ast, registry, location: AUTHORED }).toEqual(before);
    expect(exportedCompile).toBe(compile);
  });

  it('compiles an empty file with an empty registry and has no default instance vocabulary', () => {
    const built = buildRegistry([]);
    expect(compile(parse('#! ia 1.0\n', 'empty.ia').ast, built.registry, AUTHORED, [])).toEqual({
      records: [],
      diagnostics: [],
      sourceMap: [],
    });
    const result = compile(parse('#! ia 1.0\n@agent a\n', 'a.ia').ast, built.registry, AUTHORED, []);
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain('visible systems: floor, taxonomy');
  });
});

const entry = (keyword: string, schema = 'agent') =>
  `    ${keyword} lowers to binding\n      category capability\n      facets [head]\n      schema @schema ${schema}\n`;
const withEntries = (entries: string) => FLOOR_TEXT.replace('  edges\n', entries + '  edges\n');
const compileSource = (text: string) => {
  const parsed = parse(text, 'floor.ia');
  expect(parsed.diagnostics).toEqual([]);
  const built = buildRegistry([{ ...parsed, location: AUTHORED }]);
  return { ...compile(parsed.ast, built.registry, AUTHORED, []), registryDiagnostics: built.diagnostics };
};

describe('generated ground edges', () => {
  it('emits one edge per schema from the earliest accepted entry, ignoring duplicate entries', () => {
    const r = compileSource(withEntries(entry('agent') + entry('helper')));
    expect(r.registryDiagnostics.map((d) => d.code)).toEqual(['IA-LANG-REGISTRATION-INCOMPLETE']);
    expect(r.diagnostics).toEqual([]);
    expect(r.records[0]?.edges).toEqual([
      {
        predicate: 'ground',
        direction: 'out',
        reference: { kind: 'ref', discriminator: 'schema', name: 'agent' },
        target: 'floor/contract/head/agent',
        span: { line: 8, endLine: 11 },
      },
    ]);
  });

  it('does not attach a later valid registration to an earlier malformed entry', () => {
    const text = FLOOR_TEXT.replace('      category capability\n', '').replace(
      '  edges\n',
      entry('agent') + '  edges\n',
    );
    const r = compileSource(text);
    expect(r.registryDiagnostics.map((d) => d.code)).toEqual(['IA-LANG-REGISTRATION-INCOMPLETE']);
    expect(r.records[0]?.edges).toEqual([
      {
        predicate: 'ground',
        direction: 'out',
        reference: { kind: 'ref', discriminator: 'schema', name: 'agent' },
        target: 'floor/contract/head/agent',
        span: { line: 11, endLine: 14 },
      },
    ]);
  });

  it('includes accepted entries in repeated discriminator sections', () => {
    const r = compileSource(
      withEntries('  discriminators\n' + entry('helper', 'helper')) +
        '@schema helper\n  lowers to binding\n  sections\n    open\n',
    );
    expect(r.registryDiagnostics).toEqual([]);
    expect(r.records[0]?.edges.map((edge) => edge.target)).toEqual([
      'floor/contract/head/agent',
      'floor/contract/head/helper',
    ]);
    expect(r.sourceMap[0]?.edges).toEqual([
      { line: 8, endLine: 11 },
      { line: 13, endLine: 16 },
    ]);
  });

  it('omits missing-schema and wrong-kind entries from the generated edges', () => {
    const r = compileSource(
      withEntries(entry('missing', 'missing') + entry('wrong', 'wrong')) +
        '@schema wrong\n  lowers to governance\n  sections\n    open\n',
    );
    expect(r.registryDiagnostics.map((d) => d.code)).toEqual([
      'IA-LANG-SCHEMA-MISSING',
      'IA-LANG-SCHEMA-KIND-MISMATCH',
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.records[0]?.edges.map((edge) => edge.target)).toEqual(['floor/contract/head/agent']);
  });

  it('does not borrow registrations from another system or a shadowed system declaration', () => {
    const low: Location = { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' };
    const lower = parse(FLOOR_TEXT, 'lower.ia');
    const higher = parse(FLOOR_TEXT.replaceAll('agent-system', 'AGENT-SYSTEM'), 'higher.ia');
    const other = parse(FLOOR_TEXT.replaceAll('agent-system', 'other-system').split('\n@schema agent')[0]!, 'other.ia');
    const built = buildRegistry([
      { ...lower, location: low },
      { ...higher, location: AUTHORED },
      { ...other, location: low },
    ]);
    expect(built.diagnostics).toEqual([]);
    expect(compile(lower.ast, built.registry, low, []).records[0]?.edges).toEqual([]);
    expect(compile(other.ast, built.registry, low, []).records[0]?.edges).toEqual([]);
    expect(compile(higher.ast, built.registry, AUTHORED, []).records[0]?.edges).toHaveLength(1);
  });

  it('matches declaration paths canonically and still distinguishes the same path at different bands', () => {
    const low: Location = { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' };
    const lower = parse(FLOOR_TEXT, 'systems/agent-system/system.ia');
    const built = buildRegistry([
      { ...floorParsed, location: AUTHORED },
      { ...lower, location: low },
    ]);
    expect(built.diagnostics).toEqual([]);
    expect(compile(lower.ast, built.registry, AUTHORED, []).records[0]?.edges).toHaveLength(1);
    expect(compile(lower.ast, built.registry, low, []).records[0]?.edges).toEqual([]);
  });
});
