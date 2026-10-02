import { describe, expect, it } from 'vitest';
import { HEAD_SPELLINGS, spellingsFor } from '../../src/compile/spellings.js';
import { compiledValue, resolveKey } from '../../src/compile/values.js';
import { parse } from '../../src/parser/index.js';
import { buildRegistry } from '../../src/registry/index.js';
import { FLOOR_REGISTRATIONS } from '../../src/registry/floor.js';
import type { Location, Registration, SchemaDeclaration } from '../../src/registry/types.js';

const field = (body: string) => {
  const lines = body
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  const parsed = parse(`#! ia 1.0\n@law x\n  meaning\n${lines}\n`, 'a.ia');
  expect(parsed.diagnostics).toEqual([]);
  const node = parsed.ast.records[0]!.sections[0]!.children[0];
  if (node?.kind !== 'field') throw new Error('The fixture must produce a field');
  return node;
};

describe('compiledValue', () => {
  it('drops raw and keeps everything else', () => {
    expect(compiledValue(field('says "hi"').value)).toEqual({ kind: 'string', text: 'hi' });
    expect(compiledValue(field('cites @law y#frag').value)).toEqual({
      kind: 'ref',
      discriminator: 'law',
      name: 'y',
      fragment: 'frag',
    });
    expect(compiledValue(field('tags [a, "b c", @law z]').value)).toEqual({
      kind: 'list',
      items: [
        { kind: 'scalar', text: 'a' },
        { kind: 'string', text: 'b c' },
        { kind: 'ref', discriminator: 'law', name: 'z' },
      ],
    });
    expect(compiledValue(field('empty').value)).toEqual({ kind: 'none' });
  });

  it('keeps the parser-normalized scalar without changing its case', () => {
    expect(compiledValue(field('says Mixed   Case\twords').value)).toEqual({
      kind: 'scalar',
      text: 'Mixed Case words',
    });
  });

  it('preserves exact string spacing', () => {
    expect(compiledValue(field('says "  Mixed  Case  "').value)).toEqual({ kind: 'string', text: '  Mixed  Case  ' });
  });

  it('preserves folded prose and paragraph breaks while removing raw', () => {
    const parsed = field('says """First line\n  second line\n\n  Next paragraph\n"""');
    expect(compiledValue(parsed.value)).toEqual({ kind: 'prose', text: 'First line second line\nNext paragraph' });
  });

  it.each([
    ['cites @law Mixed-Name', { kind: 'ref', discriminator: 'law', name: 'Mixed-Name' }],
    ['cites @law Mixed-Name#Meaning', { kind: 'ref', discriminator: 'law', name: 'Mixed-Name', fragment: 'Meaning' }],
  ] as const)('preserves reference names and optional fragments: %s', (text, expected) => {
    expect(compiledValue(field(text).value)).toEqual(expected);
  });

  it('preserves every list member and removes raw from its strings and references', () => {
    const parsed = field('tags [bare  words, "  exact  spacing  ", @law Mixed-Name#Meaning]');
    expect(compiledValue(parsed.value)).toEqual({
      kind: 'list',
      items: [
        { kind: 'scalar', text: 'bare words' },
        { kind: 'string', text: '  exact  spacing  ' },
        { kind: 'ref', discriminator: 'law', name: 'Mixed-Name', fragment: 'Meaning' },
      ],
    });
  });

  it('keeps block and none distinct without lowering children into the value', () => {
    expect(compiledValue(field('details\n  says "child"').value)).toEqual({ kind: 'block' });
    expect(compiledValue(field('details').value)).toEqual({ kind: 'none' });
  });

  it('does not mutate the parsed value or its list members', () => {
    const parsed = field('tags ["text", @law Mixed-Name#fragment]');
    const before = structuredClone(parsed);
    const first = compiledValue(parsed.value);
    expect(compiledValue(parsed.value)).toEqual(first);
    expect(parsed).toEqual(before);
  });
});

describe('resolveKey', () => {
  it('applies the longest spelling that starts an all-words line, else the parser key', () => {
    expect(resolveKey(field('lowers to definition'), [['lowers', 'to']])).toEqual({
      key: 'lowers to',
      value: { kind: 'scalar', text: 'definition' },
    });
    expect(resolveKey(field('lowers to definition'), [])).toEqual({
      key: 'lowers',
      value: { kind: 'scalar', text: 'to definition' },
    });
    expect(resolveKey(field('must have meaning'), [['must'], ['must', 'have']])).toEqual({
      key: 'must have',
      value: { kind: 'scalar', text: 'meaning' },
    });
    expect(resolveKey(field('must have'), [['must', 'have']])).toEqual({ key: 'must have', value: { kind: 'none' } });
  });

  it('keeps the parser key for quoted, listed, referenced, empty and assertive lines', () => {
    expect(resolveKey(field('Decision means "commit"'), [['Decision']])).toEqual({
      key: 'Decision means',
      value: { kind: 'string', text: 'commit' },
    });
    expect(resolveKey(field('category is capability'), [['category', 'is']])).toEqual({
      key: 'category',
      value: { kind: 'scalar', text: 'capability' },
    });
    expect(resolveKey(field('closed'), [['closed']])).toEqual({ key: 'closed', value: { kind: 'none' } });
  });

  it('selects the longest match independently of spelling order', () => {
    const parsed = field('must have meaning');
    expect(resolveKey(parsed, [['must', 'have'], ['must']])).toEqual({
      key: 'must have',
      value: { kind: 'scalar', text: 'meaning' },
    });
    expect(resolveKey(parsed, [['must'], ['must', 'have']])).toEqual({
      key: 'must have',
      value: { kind: 'scalar', text: 'meaning' },
    });
  });

  it.each([
    ['must having meaning', [['must', 'have']], 'must', 'having meaning'],
    ['Must have meaning', [['must', 'have']], 'Must', 'have meaning'],
    ['must have meaning', [['have']], 'must', 'have meaning'],
    ['must have', [['must', 'have', 'meaning']], 'must', 'have'],
    ['unknown value', [[]], 'unknown', 'value'],
  ] as const)('keeps the parser reading when no whole-word spelling matches: %s', (line, spellings, key, text) => {
    expect(resolveKey(field(line), spellings)).toEqual({ key, value: { kind: 'scalar', text } });
  });

  it('ignores empty spellings beside a valid match', () => {
    expect(resolveKey(field('must have meaning'), [[], ['must', 'have']])).toEqual({
      key: 'must have',
      value: { kind: 'scalar', text: 'meaning' },
    });
  });

  it.each([
    ['Decision means "commit"', 'Decision means', { kind: 'string', text: 'commit' }],
    ['Decision means """commit now"""', 'Decision means', { kind: 'prose', text: 'commit now' }],
    [
      'Decision uses [a, "b"]',
      'Decision uses',
      {
        kind: 'list',
        items: [
          { kind: 'scalar', text: 'a' },
          { kind: 'string', text: 'b' },
        ],
      },
    ],
    [
      'Decision cites @law Mixed-Name#meaning',
      'Decision cites',
      { kind: 'ref', discriminator: 'law', name: 'Mixed-Name', fragment: 'meaning' },
    ],
    ['Decision\n  says "child"', 'Decision', { kind: 'block' }],
    ['Decision', 'Decision', { kind: 'none' }],
  ] as const)('preserves the parser key for a non-scalar value: %s', (line, key, value) => {
    expect(resolveKey(field(line), [['Decision']])).toEqual({ key, value });
  });

  it('preserves the assertive form even when a spelling would consume the entire line', () => {
    expect(resolveKey(field('category is capability'), [['category', 'is', 'capability']])).toEqual({
      key: 'category',
      value: { kind: 'scalar', text: 'capability' },
    });
    expect(resolveKey(field('says is several words'), [['says']])).toEqual({
      key: 'says',
      value: { kind: 'scalar', text: 'several words' },
    });
  });

  it('keeps a quoted is form as a literal multi-word key', () => {
    expect(resolveKey(field('category is "capability"'), [['category']])).toEqual({
      key: 'category is',
      value: { kind: 'string', text: 'capability' },
    });
  });

  it('excludes when words from the scalar without changing the field or spelling inputs', () => {
    const parsed = field('must have meaning when phase is act');
    const spellings = [['must'], ['must', 'have']];
    const before = structuredClone({ parsed, spellings });
    expect(parsed.when).toEqual(['phase', 'is', 'act']);
    expect(resolveKey(parsed, spellings)).toEqual({ key: 'must have', value: { kind: 'scalar', text: 'meaning' } });
    expect({ parsed, spellings }).toEqual(before);
  });
});

describe('spellingsFor', () => {
  const schema: SchemaDeclaration = {
    name: 'agent',
    displayName: 'agent',
    kind: 'binding',
    sections: [],
    closed: true,
    path: 's.ia',
    span: { line: 1, endLine: 1 },
    band: 100,
    edges: [],
    fields: [
      { section: 'meaning', key: 'says', type: 'text', must: true, span: { line: 1, endLine: 1 } },
      { section: 'head', key: 'owner', type: 'id', must: false, span: { line: 1, endLine: 1 } },
    ],
  };
  const agent: Registration = {
    keyword: 'agent',
    system: 'agent-system',
    kind: 'binding',
    category: 'capability',
    facets: ['head'],
    schema: 'agent',
    band: 100,
  };

  it('spells the head keys of spec 2.2 plus a schema head field, and a section by its schema fields', () => {
    expect(spellingsFor(agent, schema, 'head')).toEqual([...HEAD_SPELLINGS, ['owner']]);
    expect(spellingsFor(agent, schema, 'meaning')).toEqual([['says']]);
    expect(spellingsFor(agent, undefined, 'meaning')).toEqual([]);
  });

  it('spells the floor records by their fixed shapes', () => {
    const system = FLOOR_REGISTRATIONS[0]!;
    const schemaWord = FLOOR_REGISTRATIONS[1]!;
    expect(spellingsFor(system, undefined, 'head')).toEqual(HEAD_SPELLINGS);
    expect(spellingsFor(system, undefined, 'discriminators')).toEqual([]);
    expect(spellingsFor(schemaWord, undefined, 'sections')).toEqual([
      ['must', 'have'],
      ['may', 'have'],
      ['closed'],
      ['open'],
    ]);
    expect(spellingsFor(schemaWord, undefined, 'edges')).toEqual([['must'], ['may']]);
  });

  it('provides standard head spellings without a schema and no keys for an unknown section', () => {
    expect(spellingsFor(agent, undefined, 'head')).toEqual(HEAD_SPELLINGS);
    expect(spellingsFor(agent, schema, 'unknown')).toEqual([]);
  });

  it('resolves the standard multi-word head key ahead of a shorter schema key', () => {
    const extended = {
      ...schema,
      fields: [
        ...schema.fields,
        { section: 'head', key: 'lowers', type: 'text' as const, must: false, span: { line: 1, endLine: 1 } },
      ],
    };
    expect(resolveKey(field('lowers to definition'), spellingsFor(agent, extended, 'head'))).toEqual({
      key: 'lowers to',
      value: { kind: 'scalar', text: 'definition' },
    });
  });

  it('keeps schema keys confined to their declared section', () => {
    const extended = {
      ...schema,
      fields: [
        ...schema.fields,
        { section: 'governance', key: 'severity', type: 'text' as const, must: true, span: { line: 1, endLine: 1 } },
      ],
    };
    const before = structuredClone(extended);
    expect(spellingsFor(agent, extended, 'meaning')).toEqual([['says']]);
    expect(spellingsFor(agent, extended, 'governance')).toEqual([['severity']]);
    expect(spellingsFor(agent, extended, 'head')).toEqual([...HEAD_SPELLINGS, ['owner']]);
    expect(extended).toEqual(before);
  });

  it('uses fixed schema-field spellings regardless of an authored floor schema', () => {
    const schemaWord = FLOOR_REGISTRATIONS[1]!;
    expect(spellingsFor(schemaWord, schema, 'fields')).toEqual([
      ['must', 'have'],
      ['may', 'have'],
    ]);
    expect(spellingsFor(schemaWord, schema, 'head')).toEqual(HEAD_SPELLINGS);
    expect(spellingsFor(schemaWord, schema, 'meaning')).toEqual([]);
  });

  it.each(['requires', 'discriminators', 'edges', 'relationships'])(
    'leaves the system %s section to the parser key rule',
    (section) => {
      expect(spellingsFor(FLOOR_REGISTRATIONS[0]!, schema, section)).toEqual([]);
    },
  );

  it.each(['system', 'schema'])('returns no inherited spellings for the constructor section of @%s', (keyword) => {
    const registration = FLOOR_REGISTRATIONS.find((entry) => entry.keyword === keyword)!;
    const spellings = spellingsFor(registration, undefined, 'constructor');
    expect(spellings).toEqual([]);
    expect(resolveKey(field('says value'), spellings)).toEqual({
      key: 'says',
      value: { kind: 'scalar', text: 'value' },
    });
  });

  it('uses the schema for a minted constructor word owned by floor', () => {
    const parsed = parse(
      `#! ia 1.0
@system floor
  provider "p"
  version "1.0.0"
  discriminators
    constructor lowers to binding
      category capability
      facets [head]
      schema @schema custom
@schema custom
  lowers to binding
  sections
    must have meaning
    closed
  fields
    may have head.owner as id
    must have meaning.says as text
`,
      'floor.ia',
    );
    const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    const { registry, diagnostics } = buildRegistry([{ ...parsed, location }]);
    expect(diagnostics).toEqual([]);
    const registration = registry.registrations.get('constructor')!;
    const joinedSchema = registry.schemas.get(registration.schema)!;
    expect(spellingsFor(registration, joinedSchema, 'meaning')).toEqual([['says']]);
    expect(spellingsFor(registration, joinedSchema, 'head')).toEqual([...HEAD_SPELLINGS, ['owner']]);
    expect(spellingsFor(registration, joinedSchema, 'constructor')).toEqual([]);
  });
});
