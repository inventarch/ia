import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { extractSchemas, fieldTypeText } from '../../src/registry/schemas.js';

const extract = (source: string) => {
  const parsed = parse(source, 'sch.ia');
  const result = extractSchemas(parsed.ast, 100, parsed.diagnostics);
  return { ...result, diagnostics: [...parsed.diagnostics, ...result.diagnostics].sort((a, b) => a.line - b.line) };
};
const codes = (source: string) => extract(source).diagnostics.map((d) => [d.code, d.line]);
const BASE = '#! ia 1.0\n@schema S\n  lowers to definition\n  sections\n    closed\n';

const GOOD = `#! ia 1.0
@schema Playbook
  lowers to definition
  sections
    must have meaning
    must have cognition
    may have activation
    closed
  fields
    must have meaning.says as text "one-line identity"
    must have meaning.answers as text
    may have lifecycle.state as id
    may have meaning.tags as list of id
  edges
    must cite governance one-or-more
    may use playbook optional
`;

describe('extractSchemas', () => {
  it('reads a complete schema', () => {
    const { schemas, diagnostics, refused } = extract(GOOD);
    expect(diagnostics).toEqual([]);
    expect(refused.size).toBe(0);
    const s = schemas[0]!;
    expect(s).toMatchObject({
      name: 'playbook',
      displayName: 'Playbook',
      kind: 'definition',
      closed: true,
      path: 'sch.ia',
      band: 100,
    });
    expect(s.sections.map((x) => [x.name, x.must])).toEqual([
      ['meaning', true],
      ['cognition', true],
      ['activation', false],
    ]);
    expect(s.fields.map((f) => [f.section, f.key, f.type, f.must, f.description])).toEqual([
      ['meaning', 'says', 'text', true, 'one-line identity'],
      ['meaning', 'answers', 'text', true, undefined],
      ['lifecycle', 'state', 'id', false, undefined],
      ['meaning', 'tags', 'list of id', false, undefined],
    ]);
    expect(s.edges.map((e) => [e.predicate, e.direction, e.spelling, e.target, e.must, e.cardinality])).toEqual([
      ['cite', 'out', 'cite', 'governance', true, 'one-or-more'],
      ['use', 'out', 'use', 'playbook', false, 'optional'],
    ]);
  });

  it('accepts open and refuses a sections block that does not end with exactly one of closed or open', () => {
    const head = '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n';
    expect(extract(`${head}    may have meaning\n    open\n`).schemas[0]?.closed).toBe(false);
    expect(codes(`${head}    may have meaning\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 4]]);
    expect(codes(`${head}    closed\n    may have meaning\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 5]]);
    expect(codes(`${head}    closed\n    open\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 6]]);
    expect(codes(`${head}    should have meaning\n    closed\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 5]]);
    expect(codes('#! ia 1.0\n@schema s\n  lowers to definition\n')).toEqual([['IA-LANG-SCHEMA-MALFORMED', 2]]);
  });

  it('refuses a missing or unknown kind', () => {
    expect(codes('#! ia 1.0\n@schema s\n  sections\n    closed\n')).toEqual([['IA-LANG-SCHEMA-MALFORMED', 2]]);
    expect(codes('#! ia 1.0\n@schema s\n  lowers to widget\n  sections\n    closed\n')).toEqual([
      ['IA-LANG-KIND-UNKNOWN', 3],
    ]);
  });

  it('refuses malformed fields and a relationship stated as a field', () => {
    const head = '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n    closed\n  fields\n';
    expect(codes(`${head}    must have meaning.says as string\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
    expect(codes(`${head}    must have says as text\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
    expect(codes(`${head}    must have meaning.says text\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
    expect(codes(`${head}    must have relationships.cites as ref\n`)).toEqual([['IA-LANG-SCHEMA-EDGE-AS-FIELD', 7]]);
    expect(codes(`${head}    must have meaning.says as text [a]\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
  });

  it('refuses malformed edges and reports the refused names', () => {
    const head = '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n    closed\n  edges\n';
    expect(codes(`${head}    must citing governance one\n`)).toEqual([['IA-LANG-PREDICATE-UNKNOWN', 7]]);
    expect(codes(`${head}    must cite governance many\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
    expect(codes(`${head}    cite governance one\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
    const r = extract(`${head}    must cite governance many\n`);
    expect(r.schemas).toEqual([]);
    expect([...r.refused]).toEqual(['s']);
  });

  it('refuses a when clause and any element written twice', () => {
    const head = '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n    must have meaning\n    closed\n';
    expect(codes('#! ia 1.0\n@schema s\n  lowers to definition\n  lowers to policy\n  sections\n    closed\n')).toEqual(
      [['IA-LANG-SCHEMA-MALFORMED', 4]],
    );
    expect(
      codes(
        '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n    must have meaning when phase is act\n    closed\n',
      ),
    ).toEqual([['IA-LANG-SCHEMA-MALFORMED', 5]]);
    expect(
      codes(
        '#! ia 1.0\n@schema s\n  lowers to definition\n  sections\n    must have meaning\n    may have meaning\n    closed\n',
      ),
    ).toEqual([['IA-LANG-SCHEMA-MALFORMED', 6]]);
    expect(codes(`${head}  fields\n    must have meaning.says as text\n    may have meaning.says as id\n`)).toEqual([
      ['IA-LANG-SCHEMA-MALFORMED', 9],
    ]);
    expect(codes(`${head}  edges\n    must cite governance one\n    may cite governance optional\n`)).toEqual([
      ['IA-LANG-SCHEMA-MALFORMED', 9],
    ]);
  });

  it('accepts a minimal schema without fields or edges and preserves source metadata', () => {
    const { schemas, diagnostics } = extract(BASE);
    expect(diagnostics).toEqual([]);
    expect(schemas).toEqual([
      {
        name: 's',
        displayName: 'S',
        kind: 'definition',
        sections: [],
        closed: true,
        fields: [],
        edges: [],
        path: 'sch.ia',
        span: { line: 2, endLine: 5 },
        band: 100,
      },
    ]);
  });

  it.each(['"definition"', '[definition]', '@law definition', 'definition extra'])(
    'refuses a non-bare kind spelling %s with the dialect code',
    (kind) => {
      expect(codes(BASE.replace('lowers to definition', `lowers to ${kind}`))).toEqual([
        ['IA-LANG-SCHEMA-MALFORMED', 3],
      ]);
    },
  );

  it.each([
    'text',
    'id',
    'qname',
    'number',
    'ref',
    'flag',
    'list of text',
    'list of id',
    'list of qname',
    'list of number',
    'list of ref',
    'list of flag',
  ])('reads field type %s and an optional quoted description', (type) => {
    const result = extract(`${BASE}  fields\n    may have meaning.value as ${type} "description"\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.schemas[0]?.fields[0]).toMatchObject({
      section: 'meaning',
      key: 'value',
      type,
      must: false,
      description: 'description',
    });
  });

  it.each(['list', 'list of', 'list of string', 'list of list of text', 'text unquoted-description'])(
    'refuses malformed field type %s',
    (type) => {
      expect(codes(`${BASE}  fields\n    must have meaning.value as ${type}\n`)).toEqual([
        ['IA-LANG-SCHEMA-MALFORMED', 7],
      ]);
    },
  );

  describe('field narrowing (W0)', () => {
    const field = (spelling: string) => {
      const result = extract(`${BASE}  fields\n    may have work.value as ${spelling}\n`);
      expect(result.diagnostics).toEqual([]);
      return result.schemas[0]?.fields[0];
    };
    it('reads a closed id set from `in [...]` for id and list of id, without a description slot', () => {
      expect(field('id in [todo, doing, done]')).toMatchObject({ type: 'id', values: ['todo', 'doing', 'done'] });
      expect(field('list of id in [a, b]')).toMatchObject({ type: 'list of id', values: ['a', 'b'] });
      expect(field('id in [todo]')).not.toHaveProperty('description');
      expect(field('id in [todo]')).not.toHaveProperty('target');
    });
    it('reads a reference target from `ref to <word>` for ref and list of ref, with an optional description', () => {
      expect(field('ref to milestone "the parent"')).toMatchObject({
        type: 'ref',
        target: 'milestone',
        description: 'the parent',
      });
      expect(field('list of ref to task')).toMatchObject({ type: 'list of ref', target: 'task' });
      expect(field('ref to future-word')).toMatchObject({ target: 'future-word' });
    });
    it('reads a text form from `text form <form>` for text and list of text', () => {
      expect(field('text form iso-date "YYYY-MM-DD"')).toMatchObject({
        type: 'text',
        form: 'iso-date',
        description: 'YYYY-MM-DD',
      });
      expect(field('list of text form iso-date')).toMatchObject({ type: 'list of text', form: 'iso-date' });
    });
    it('spells a narrowed type back as authored', () => {
      expect(fieldTypeText(field('id in [todo, done]')!)).toBe('id in [todo, done]');
      expect(fieldTypeText(field('list of ref to task')!)).toBe('list of ref to task');
      expect(fieldTypeText(field('text form iso-date')!)).toBe('text form iso-date');
      expect(fieldTypeText(field('number')!)).toBe('number');
    });
    it.each([
      'text in [a]',
      'ref in [a]',
      'id in',
      'id in []',
      'id in [a, a]',
      'id in ["a"]',
      'id in [1a]',
      'id in [@law a]',
      'id in a b',
      'id to task',
      'text to task',
      'ref to',
      'ref to Task',
      'ref to task extra',
      'list of ref to 1task',
      'id form iso-date',
      'ref form iso-date',
      'text form',
      'text form rfc3339',
      'text form iso-date extra',
      'text form iso-date [a]',
      'ref to task form iso-date',
    ])('refuses a malformed or misapplied narrowing: %s', (spelling) => {
      expect(codes(`${BASE}  fields\n    must have work.value as ${spelling}\n`)).toEqual([
        ['IA-LANG-SCHEMA-MALFORMED', 7],
      ]);
    });
    it.each(['id in [a] extra', 'id in [a] to task', 'id in [a] "description"'])(
      'leaves words after a set to the parser: %s',
      (spelling) => {
        expect(
          codes(`${BASE}  fields
    must have work.value as ${spelling}
`),
        ).toEqual([['IA-LANG-VALUE-TRAILING', 7]]);
      },
    );
    it('refuses an unknown text form by naming the closed table', () => {
      const result = extract(`${BASE}  fields\n    must have work.due as text form rfc3339\n`);
      expect(result.diagnostics[0]?.message).toContain('iso-date');
      expect([...result.refused]).toEqual(['s']);
    });
  });

  it.each(['.says', 'meaning.', 'meaning.says.more', 'Meaning.says'])('refuses malformed field path %s', (path) => {
    expect(codes(`${BASE}  fields\n    must have ${path} as text\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
  });

  it.each(['Meaning', '123', 'meaning.extra'])('refuses invalid section name %s', (name) => {
    expect(codes(BASE.replace('    closed', `    must have ${name}\n    closed`))).toEqual([
      ['IA-LANG-SCHEMA-MALFORMED', 5],
    ]);
  });

  it.each(['Agent', '123', 'agent.one'])('refuses an edge target that cannot be a discriminator: %s', (target) => {
    expect(codes(`${BASE}  edges\n    may cite ${target} optional\n`)).toEqual([['IA-LANG-SCHEMA-MALFORMED', 7]]);
  });

  it.each(['one', 'one-or-more', 'optional'])(
    'accepts cardinality %s without resolving the target registration',
    (cardinality) => {
      const result = extract(`${BASE}  edges\n    must cite future-word ${cardinality}\n`);
      expect(result.diagnostics).toEqual([]);
      expect(result.schemas[0]?.edges[0]).toMatchObject({
        predicate: 'cite',
        target: 'future-word',
        cardinality,
        must: true,
      });
    },
  );

  describe('verb spellings', () => {
    const rule = (row: string) => {
      const result = extract(`${BASE}  edges\n    ${row}\n`);
      expect(result.diagnostics).toEqual([]);
      return result.schemas[0]?.edges[0];
    };
    it('reads the active, inverse and present spellings with their direction and the spelling as authored', () => {
      expect(rule('may govern law optional')).toMatchObject({
        predicate: 'govern',
        direction: 'out',
        spelling: 'govern',
      });
      expect(rule('may governed-by law one')).toMatchObject({
        predicate: 'govern',
        direction: 'in',
        spelling: 'governed-by',
        target: 'law',
        must: false,
        cardinality: 'one',
      });
      expect(rule('must governs law one-or-more')).toMatchObject({
        predicate: 'govern',
        direction: 'out',
        spelling: 'governs',
        must: true,
        cardinality: 'one-or-more',
      });
      expect(rule('may run-after task one')).toMatchObject({
        predicate: 'run-before',
        direction: 'in',
        spelling: 'run-after',
      });
    });
    it('reads a present phrase of several words as one verb', () => {
      expect(rule('may grants access to agent optional')).toMatchObject({
        predicate: 'grant-access-to',
        direction: 'out',
        spelling: 'grants access to',
        target: 'agent',
        cardinality: 'optional',
      });
      expect(rule('must records lineage from run one')).toMatchObject({
        predicate: 'record-lineage-from',
        spelling: 'records lineage from',
        target: 'run',
      });
    });
    it('refuses a second rule in the same direction whatever its spelling, and keeps opposite directions apart', () => {
      expect(codes(`${BASE}  edges\n    may govern law optional\n    may governs law one\n`)).toEqual([
        ['IA-LANG-SCHEMA-MALFORMED', 8],
      ]);
      const both = extract(`${BASE}  edges\n    may govern law optional\n    may governed-by law optional\n`);
      expect(both.diagnostics).toEqual([]);
      expect(both.schemas[0]?.edges.map((e) => [e.predicate, e.direction, e.spelling])).toEqual([
        ['govern', 'out', 'govern'],
        ['govern', 'in', 'governed-by'],
      ]);
    });
    it('names the whole verb text when no spelling admits it', () => {
      const result = extract(`${BASE}  edges\n    may records lineage law one\n`);
      expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-PREDICATE-UNKNOWN', 7]]);
      expect(result.diagnostics[0]?.message).toContain("'records lineage' is not a predicate");
      expect([...result.refused]).toEqual(['s']);
    });
  });

  it.each([
    [BASE.replace('  sections', '  when phase is act\n  sections'), 4],
    [BASE.replace('lowers to definition', 'lowers to definition when phase is act'), 3],
    [BASE.replace('    closed', '    closed when phase is act'), 5],
    [BASE + '    when phase is act\n', 6],
    [BASE + '  fields\n    must have meaning.says as text when phase is act\n', 7],
    [BASE + '  fields\n    must have meaning.says as text\n      details\n        when phase is act\n', 9],
    [BASE + '  edges\n    may cite law one\n      when phase is act\n', 8],
    [BASE + '  metadata\n    details\n      note yes when phase is act\n', 8],
  ] as const)('refuses conditions once, including standalone and deeper clauses: %s', (source, line) => {
    const result = extract(source);
    expect(result.schemas).toEqual([]);
    expect([...result.refused]).toEqual(['s']);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-SCHEMA-MALFORMED', line]]);
  });

  it.each(['closed extra', 'closed "description"', 'open [x]', 'closed\n      unexpected value'])(
    'does not double-report malformed terminator %s',
    (line) => {
      expect(codes(BASE.replace('    closed', `    ${line}`))).toEqual([['IA-LANG-SCHEMA-MALFORMED', 5]]);
    },
  );

  it.each([
    BASE.replace('    closed', '    may have meaning\n      unexpected value\n    closed'),
    BASE + '  fields\n    may have meaning.says as text\n      unexpected value\n',
    BASE + '  edges\n    may cite law one\n      unexpected value\n',
  ])('refuses a child block on a flat dialect row: %s', (source) => {
    const result = extract(source);
    expect(result.schemas).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('IA-LANG-SCHEMA-MALFORMED');
  });

  it('does not hide duplicate paths or edge pairs in later blocks', () => {
    expect(
      codes(`${BASE}  fields\n    must have meaning.says as text\n  fields\n    may have meaning.says as id\n`),
    ).toEqual([['IA-LANG-SCHEMA-MALFORMED', 9]]);
    expect(codes(`${BASE}  edges\n    must cite law one\n  edges\n    may cite law optional\n`)).toEqual([
      ['IA-LANG-SCHEMA-MALFORMED', 9],
    ]);
  });

  it('reports independent dialect faults and refuses only the broken schema', () => {
    const result = extract(
      `${BASE.replace('definition', 'widget')}  fields\n    must have relationships.cites as ref\n  edges\n    may citing law one\n${BASE.replace('#! ia 1.0\n', '').replace('@schema S', '@schema Good')}`,
    );
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['IA-LANG-KIND-UNKNOWN', 3],
      ['IA-LANG-SCHEMA-EDGE-AS-FIELD', 7],
      ['IA-LANG-PREDICATE-UNKNOWN', 9],
    ]);
    expect([...result.refused]).toEqual(['s']);
    expect(result.schemas.map((s) => s.name)).toEqual(['good']);
  });

  it('discovers nested schemas once through other record kinds without a vocabulary', () => {
    const result = extract(
      '#! ia 1.0\n@law outer\n  meaning\n    @schema Nested\n      lowers to definition\n      sections\n        closed\n',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.schemas.map((s) => s.name)).toEqual(['nested']);
  });

  it('keeps nested schema faults separate from an enclosing schema', () => {
    const result = extract(
      `${BASE}  examples\n    @schema Inner\n      lowers to @law 123\n      sections\n        closed\n`,
    );
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([['IA-LANG-REF-MALFORMED', 8]]);
    expect(result.schemas.map((s) => s.name)).toEqual(['s']);
    expect([...result.refused]).toEqual(['inner']);
  });

  it.each([
    [BASE.replace('lowers to definition', 'lowers to @law 123'), 'IA-LANG-REF-MALFORMED', 3],
    [BASE + '  fields\n    must have meaning.says as text "unfinished\n', 'IA-LANG-STRING-UNTERMINATED', 7],
    [BASE + '  fields\n    must have meaning.says as text "one" "two"\n', 'IA-LANG-VALUE-TRAILING', 7],
    [BASE.replace('    closed', '    closed when'), 'IA-LANG-VALUE-TRAILING', 5],
    [BASE + '  edges\n    - []\n', 'IA-LANG-LIST-MALFORMED', 7],
  ] as const)('retains parser refusal once and records the refused schema name: %s', (source, code, line) => {
    const parsed = parse(source, 'sch.ia');
    const result = extractSchemas(parsed.ast, 100, parsed.diagnostics);
    expect(parsed.diagnostics.map((d) => [d.code, d.line])).toEqual([[code, line]]);
    expect(result.diagnostics).toEqual([]);
    expect(result.schemas).toEqual([]);
    expect([...result.refused]).toEqual(['s']);
  });
});
