import { describe, expect, it } from 'vitest';
import { buildRegistry, compile, parse } from '@ia/language';
import type { CompiledRecord, FieldType, Location } from '@ia/language';
import { matchesForm, matchesType, validateSchema, verdict } from '../src/index.js';

const location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
function fixture(
  body = '  data\n    title "valid"',
  rules = '  sections\n    must have data\n    closed\n  fields\n    must have data.title as text',
  more = '',
) {
  const source = `#! ia 1.0
@system demo
  provider "test"
  version "1.0.0"
  discriminators
    entry lowers to definition
      category thing
      facets [entry]
      schema @schema entry
  edges
    cite entry using entry
@schema entry
  lowers to definition
${rules}
@entry subject
${body}
${more}
`;
  const parsed = parse(source, 'schema-test.ia');
  const { registry, diagnostics } = buildRegistry([{ ...parsed, location }]);
  expect(diagnostics).toEqual([]);
  const result = compile(parsed.ast, registry, location, []);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const record = result.records.find((r) => r.name === 'subject')!;
  const pool = result.records.filter((r) => r.discriminator === 'entry');
  return { record, registry, pool, check: () => validateSchema(record, registry, pool) };
}
const codes = (result: ReturnType<typeof validateSchema>) => result.findings.map((f) => f.code);

describe('instance field schemas', () => {
  it('passes a native compiled instance and stamps an explicit revision', () => {
    const assessment = fixture().check();
    expect(assessment).toEqual({
      check: 'COMP-SCHEMA',
      scope: 'demo/definition/entry/subject',
      outcome: 'pass',
      findings: [],
    });
    expect(verdict(assessment, 'revision-1')).toEqual({ ...assessment, revision: 'revision-1' });
    expect(() => verdict(assessment, ' ')).toThrow('revision');
  });
  it('reports a missing section once without subordinate field cascades', () => {
    expect(codes(fixture('').check())).toEqual(['IA-COMP-SECTION-MISSING']);
  });
  it('reports a missing field at the containing section', () => {
    const f = fixture(
      '  data\n    extra "fine"',
      '  sections\n    must have data\n    open\n  fields\n    must have data.title as text',
    );
    const result = f.check();
    expect(codes(result)).toEqual(['IA-COMP-FIELD-MISSING']);
    expect(result.findings[0]!.line).toBe(f.record.sections[0]!.span.line);
  });
  it('does not let a good duplicate hide an invalid typed occurrence', () => {
    expect(codes(fixture('  data\n    title "good"\n    title [bad]').check())).toEqual([
      'IA-COMP-FIELD-DUPLICATE',
      'IA-COMP-FIELD-TYPE',
    ]);
  });
  it('merges repeated sections and admits extra keys under open', () => {
    expect(
      fixture(
        '  data\n    extra "fine"\n  data\n    title "yes"',
        '  sections\n    must have data\n    open\n  fields\n    must have data.title as text',
      ).check().outcome,
    ).toBe('pass');
  });
  it('reports each unknown closed section and allows floor cognition/activation', () => {
    expect(
      codes(
        fixture(
          '  data\n    title "yes"\n  other\n    value "no"\n  cognition\n    orient\n      Memory means "remember"\n  activation\n    activate when phase is orient',
        ).check(),
      ),
    ).toEqual(['IA-COMP-SECTION-UNKNOWN']);
  });
  it('allows unlisted sections under open', () => {
    expect(fixture('  unknown\n    value "yes"', '  sections\n    open').check().outcome).toBe('pass');
  });
  it('checks head keys through the virtual head section', () => {
    const rules = '  sections\n    open\n  fields\n    must have head.label as text';
    expect(fixture('  label "name"', rules).check().outcome).toBe('pass');
    expect(codes(fixture('', rules).check())).toEqual(['IA-COMP-FIELD-MISSING']);
  });
  it('does not require fields inside an absent optional section', () => {
    expect(
      fixture('', '  sections\n    may have data\n    closed\n  fields\n    must have data.title as text').check()
        .outcome,
    ).toBe('pass');
  });
  it('validates optional fields when present', () => {
    const rules = '  sections\n    open\n  fields\n    may have data.count as number';
    expect(fixture('', rules).check().outcome).toBe('pass');
    expect(codes(fixture('  data\n    count "wrong"', rules).check())).toEqual(['IA-COMP-FIELD-TYPE']);
  });
  it('does not turn list member failures into multiple diagnostics', () => {
    expect(
      codes(
        fixture(
          '  data\n    values ["bad value", "also bad"]',
          '  sections\n    open\n  fields\n    must have data.values as list of id',
        ).check(),
      ),
    ).toEqual(['IA-COMP-FIELD-TYPE']);
  });
  it('counts a required bare flag as present', () => {
    expect(
      fixture('  data\n    enabled', '  sections\n    open\n  fields\n    must have data.enabled as flag').check()
        .outcome,
    ).toBe('pass');
  });
  describe('duplicated field keys (D3)', () => {
    const open = (rule: string) => `  sections\n    open\n  fields\n    ${rule}`;
    it('refuses a second occurrence of a declared non-list key as IA-COMP-FIELD-DUPLICATE at that occurrence, once per rule', () => {
      const f = fixture('  data\n    title "one"\n    title "two"\n    title "three"');
      const result = f.check();
      expect(result.findings.map((x) => [x.code, x.severity])).toEqual([['IA-COMP-FIELD-DUPLICATE', 'error']]);
      expect(result.outcome).toBe('fail');
      const second = f.record.sections[0]!.fields.filter((x) => 'key' in x && x.key === 'title')[1]!;
      expect(result.findings[0]!.line).toBe(second.span.line);
      expect(result.findings[0]!.message).toContain(
        `'data.title' is declared once by @schema entry; found 3 occurrences`,
      );
    });
    it('admits exactly one occurrence, so a single field is unchanged', () => {
      expect(fixture('  data\n    title "one"').check()).toMatchObject({ outcome: 'pass', findings: [] });
    });
    it.each([
      ['must have data.count as number', '    count 1\n    count 1'],
      ['may have data.count as number', '    count 1\n    count 2'],
      ['must have data.tag as id', '    tag x\n    tag y'],
      ['may have data.link as ref', '    link @entry subject\n    link @entry subject'],
      ['must have data.on as flag', '    on\n    on'],
      ['may have data.name as qname', '    name demo/definition/entry/a\n    name demo/definition/entry/b'],
    ])('applies to %s whether the row is must or may', (rule, body) => {
      expect(codes(fixture(`  data\n${body}`, open(rule)).check())).toEqual(['IA-COMP-FIELD-DUPLICATE']);
    });
    it('does not refuse a repeated list-typed key', () => {
      for (const type of [
        'list of id',
        'list of id in [a, b]',
        'list of ref to entry',
        'list of text form iso-date',
        'list of text',
      ]) {
        const value = type.includes('ref') ? '[@entry subject]' : type.includes('form') ? '[2026-09-25]' : '[a]';
        expect(
          fixture(`  data\n    values ${value}\n    values ${value}`, open(`must have data.values as ${type}`)).check(),
          type,
        ).toMatchObject({ outcome: 'pass', findings: [] });
      }
    });
    it('counts occurrences across repeated sections and in the virtual head section', () => {
      expect(codes(fixture('  data\n    title "one"\n  data\n    title "two"').check())).toEqual([
        'IA-COMP-FIELD-DUPLICATE',
      ]);
      expect(codes(fixture('  label "one"\n  label "two"', open('must have head.label as text')).check())).toEqual([
        'IA-COMP-FIELD-DUPLICATE',
      ]);
    });
    it('never counts undeclared keys: open admits them duplicated, closed refuses each occurrence as unknown, not duplicate', () => {
      expect(
        fixture('  data\n    title "one"\n    extra "a"\n    extra "b"', open('must have data.title as text')).check(),
      ).toMatchObject({ outcome: 'pass', findings: [] });
      expect(codes(fixture('  data\n    title "one"\n    extra "a"\n    extra "b"').check())).toEqual([
        'IA-COMP-FIELD-UNKNOWN',
        'IA-COMP-FIELD-UNKNOWN',
      ]);
    });
    it('still type-checks and narrows every occurrence, so a wrong-typed duplicate reports both faults', () => {
      expect(codes(fixture('  data\n    title "good"\n    title [bad]').check())).toEqual([
        'IA-COMP-FIELD-DUPLICATE',
        'IA-COMP-FIELD-TYPE',
      ]);
      expect(codes(fixture('  data\n    title [bad]\n    title [bad]').check())).toEqual([
        'IA-COMP-FIELD-TYPE',
        'IA-COMP-FIELD-DUPLICATE',
        'IA-COMP-FIELD-TYPE',
      ]);
    });
    it('reports one DUPLICATE for a doubled `ref to` field and still target-checks each reference', () => {
      const rule = open('must have work.parent as ref to entry');
      expect(
        codes(
          fixture(
            '  work\n    parent @entry target\n    parent @entry other',
            rule,
            '@entry target\n@entry other',
          ).check(),
        ),
      ).toEqual(['IA-COMP-FIELD-DUPLICATE']);
      expect(
        codes(fixture('  work\n    parent @entry target\n    parent @entry missing', rule, '@entry target').check()),
      ).toEqual(['IA-COMP-FIELD-DUPLICATE', 'IA-COMP-FIELD-REF-MISSING']);
      expect(codes(fixture('  work\n    parent @schema entry\n    parent @schema entry', rule).check())).toEqual([
        'IA-COMP-FIELD-REF-TARGET',
        'IA-COMP-FIELD-DUPLICATE',
        'IA-COMP-FIELD-REF-TARGET',
      ]);
    });
  });
  describe('undeclared keys in closed-schema sections (D1 / W0-L4)', () => {
    const closed = (rules = '') =>
      `  sections\n    must have data\n    may have governance\n    may have relationships\n    closed\n  fields\n    must have data.title as text${rules}`;
    it('refuses an undeclared ordinary key in a declared section as IA-COMP-FIELD-UNKNOWN at that field', () => {
      const f = fixture('  data\n    title "yes"\n    ready true');
      const result = f.check();
      expect(result.findings.map((x) => [x.code, x.severity])).toEqual([['IA-COMP-FIELD-UNKNOWN', 'error']]);
      expect(result.outcome).toBe('fail');
      const ready = f.record.sections[0]!.fields.find((x) => 'key' in x && x.key === 'ready')!;
      expect(result.findings[0]!.line).toBe(ready.span.line);
      expect(result.findings[0]!.message).toContain(`closed @schema entry does not declare 'data.ready'`);
    });
    it('reports one finding per undeclared field, nested children of an undeclared block included in its one finding', () => {
      expect(
        codes(fixture('  data\n    title "yes"\n    ready true\n    details\n      inner 1\n    other "x"').check()),
      ).toEqual(['IA-COMP-FIELD-UNKNOWN', 'IA-COMP-FIELD-UNKNOWN', 'IA-COMP-FIELD-UNKNOWN']);
    });
    it('does not refuse an undeclared key under an open schema', () => {
      expect(
        fixture(
          '  data\n    title "yes"\n    ready true',
          '  sections\n    must have data\n    open\n  fields\n    must have data.title as text',
        ).check(),
      ).toMatchObject({ outcome: 'pass', findings: [] });
    });
    it('leaves the virtual head section open', () => {
      expect(fixture('  label "free"\n  data\n    title "yes"').check()).toMatchObject({
        outcome: 'pass',
        findings: [],
      });
    });
    it('leaves the floor grammar sections relationships, cognition and activation to the language', () => {
      const body =
        '  data\n    title "yes"\n  relationships\n    cites @entry other\n  cognition\n    orient\n      Memory means "remember"\n  activation\n    activate when phase is orient';
      expect(fixture(body, closed(), '@entry other\n  data\n    title "other"').check()).toMatchObject({
        outcome: 'pass',
        findings: [],
      });
    });
    it('does not refuse a governance variant clause or the governance.severity dimension', () => {
      const f = fixture(
        '  data\n    title "yes"\n  governance\n    requires "an obligation"\n    severity blocking',
        closed(),
      );
      expect(f.record.variants.map((v) => v.key)).toEqual(['requires']);
      expect(f.check()).toMatchObject({ outcome: 'pass', findings: [] });
    });
    it('does not refuse a `- item` line beside the fields of a declared section', () => {
      expect(fixture('  data\n    title "yes"\n    - a note').check()).toMatchObject({ outcome: 'pass', findings: [] });
    });
    it('still narrows declared keys while refusing undeclared ones', () => {
      expect(
        codes(
          fixture(
            '  data\n    title "yes"\n    kind nope\n    ready true',
            closed('\n    may have data.kind as id in [yes]'),
          ).check(),
        ),
      ).toEqual(['IA-COMP-FIELD-VALUE', 'IA-COMP-FIELD-UNKNOWN']);
    });
  });
  it('refuses missing registrations and schemas as a single root failure', () => {
    const f = fixture();
    expect(codes(validateSchema(f.record, { ...f.registry, registrations: new Map() }, []))).toEqual([
      'IA-COMP-SCHEMA-MISSING',
    ]);
    expect(codes(validateSchema(f.record, { ...f.registry, schemas: new Map() }, []))).toEqual([
      'IA-COMP-SCHEMA-MISSING',
    ]);
  });
  it('refuses a schema/instance kind mismatch before checking fields', () => {
    const f = fixture();
    expect(codes(validateSchema({ ...f.record, kind: 'binding' }, f.registry, []))).toEqual([
      'IA-COMP-SCHEMA-KIND-MISMATCH',
    ]);
  });
  it('validates the two floor schemas instead of silently exempting them', () => {
    const f = fixture();
    const parsed = parse('#! ia 1.0\n@schema entry\n  lowers to definition\n  sections\n    open\n', 'floor.ia');
    const record = compile(parsed.ast, f.registry, location, []).records[0]!;
    expect(codes(validateSchema(record, f.registry, []))).toEqual(['IA-COMP-SCHEMA-MISSING']);
  });
});

describe('narrowed fields (W0)', () => {
  const open = (rule: string) => `  sections\n    open\n  fields\n    ${rule}`;
  const severities = (result: ReturnType<typeof validateSchema>) => result.findings.map((f) => [f.code, f.severity]);
  describe('id in [...] (W0-L1)', () => {
    const rule = open('must have work.status as id in [todo, doing, done]');
    it('admits a member and refuses a non-member as IA-COMP-FIELD-VALUE naming the set', () => {
      expect(fixture('  work\n    status doing', rule).check().outcome).toBe('pass');
      const result = fixture('  work\n    status blocked', rule).check();
      expect(severities(result)).toEqual([['IA-COMP-FIELD-VALUE', 'error']]);
      expect(result.findings[0]!.message).toContain('todo, doing, done');
      expect(result.findings[0]!.message).toContain('blocked');
    });
    it('checks every list item once per field and reports a type fault instead when the value is not an id', () => {
      const list = open('must have work.tags as list of id in [a, b]');
      expect(fixture('  work\n    tags [a, b, a]', list).check().outcome).toBe('pass');
      expect(codes(fixture('  work\n    tags [a, c, d]', list).check())).toEqual(['IA-COMP-FIELD-VALUE']);
      expect(codes(fixture('  work\n    status "not an id"', rule).check())).toEqual(['IA-COMP-FIELD-TYPE']);
      expect(codes(fixture('  work\n    status [todo]', rule).check())).toEqual(['IA-COMP-FIELD-TYPE']);
    });
    it('compares exactly, so case and quoting do not widen the set', () => {
      expect(codes(fixture('  work\n    status Doing', rule).check())).toEqual(['IA-COMP-FIELD-VALUE']);
      expect(fixture('  work\n    status "doing"', rule).check().outcome).toBe('pass');
    });
  });
  describe('ref to <word> (W0-L2)', () => {
    const rule = open('must have work.parent as ref to entry');
    it('admits a resolved reference of the named word', () => {
      expect(fixture('  work\n    parent @entry target', rule, '@entry target').check()).toMatchObject({
        outcome: 'pass',
        findings: [],
      });
    });
    it('refuses another discriminator as IA-COMP-FIELD-REF-TARGET even when the target resolves', () => {
      const result = fixture('  work\n    parent @schema entry', rule).check();
      expect(severities(result)).toEqual([['IA-COMP-FIELD-REF-TARGET', 'error']]);
      expect(result.findings[0]!.message).toContain('ref to entry');
      expect(result.findings[0]!.message).toContain('@schema entry');
    });
    it('warns IA-COMP-FIELD-REF-MISSING on an unresolved target and still passes', () => {
      const result = fixture('  work\n    parent @entry nobody', rule).check();
      expect(severities(result)).toEqual([['IA-COMP-FIELD-REF-MISSING', 'warning']]);
      expect(result.outcome).toBe('pass');
      expect(result.findings[0]!.message).toContain('@entry nobody');
    });
    it('resolves against the supplied pool, so an empty pool warns and the subject itself resolves', () => {
      const f = fixture('  work\n    parent @entry target', rule, '@entry target');
      expect(codes(validateSchema(f.record, f.registry, []))).toEqual(['IA-COMP-FIELD-REF-MISSING']);
      expect(fixture('  work\n    parent @entry subject', rule).check().outcome).toBe('pass');
    });
    it('checks list items and reports the wrong word before the missing one', () => {
      const list = open('may have work.children as list of ref to entry');
      expect(fixture('  work\n    children [@entry a, @entry b]', list, '@entry a\n@entry b').check().findings).toEqual(
        [],
      );
      expect(codes(fixture('  work\n    children [@entry a, @schema entry]', list, '@entry a').check())).toEqual([
        'IA-COMP-FIELD-REF-TARGET',
      ]);
      expect(codes(fixture('  work\n    children [@entry a, @entry missing]', list, '@entry a').check())).toEqual([
        'IA-COMP-FIELD-REF-MISSING',
      ]);
      expect(codes(fixture('  work\n    children [@entry a, "@entry b"]', list, '@entry a').check())).toEqual([
        'IA-COMP-FIELD-TYPE',
      ]);
    });
    it('indexes the pool once per pool and registry, so resolution cost does not grow with the records validated', () => {
      const f = fixture('  work\n    parent @entry target\n    parent @entry missing', rule, '@entry target');
      let walks = 0;
      const counted = new Proxy(f.pool, {
        get: (target, key, receiver) => {
          if (key === Symbol.iterator) walks += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const first = validateSchema(f.record, f.registry, counted);
      expect(codes(first)).toEqual(['IA-COMP-FIELD-DUPLICATE', 'IA-COMP-FIELD-REF-MISSING']);
      const after = walks;
      expect(after).toBeGreaterThan(0);
      for (const record of [f.record, ...f.pool, f.record]) validateSchema(record, f.registry, counted);
      expect(walks).toBe(after);
      expect(codes(validateSchema(f.record, f.registry, [...f.pool]))).toEqual([
        'IA-COMP-FIELD-DUPLICATE',
        'IA-COMP-FIELD-REF-MISSING',
      ]);
    });
    it('does not narrow a plain ref field', () => {
      expect(fixture('  work\n    parent @schema entry', open('must have work.parent as ref')).check().outcome).toBe(
        'pass',
      );
    });
  });
  describe('text form iso-date (W0-L5)', () => {
    const rule = open('must have work.due as text form iso-date');
    it.each(['2026-09-25', '2024-02-29', '0001-01-01', '9999-12-31'])(
      'admits the calendar date %s bare or quoted',
      (date) => {
        expect(fixture(`  work\n    due ${date}`, rule).check().outcome).toBe('pass');
        expect(fixture(`  work\n    due "${date}"`, rule).check().outcome).toBe('pass');
      },
    );
    it.each([
      'next week',
      '2026-9-5',
      '2026-13-01',
      '2026-02-30',
      '2023-02-29',
      '2026-04-31',
      '2026-00-10',
      '2026-01-00',
      '20260925',
      '2026-09-25T00:00:00Z',
      '',
    ])('refuses %s as IA-COMP-FIELD-FORM', (text) => {
      const result = fixture(`  work\n    due "${text}"`, rule).check();
      expect(severities(result)).toEqual([['IA-COMP-FIELD-FORM', 'error']]);
      expect(result.findings[0]!.message).toContain('iso-date');
    });
    it('checks every list item once per field', () => {
      const list = open('may have work.dates as list of text form iso-date');
      expect(fixture('  work\n    dates [2026-01-01, "2026-12-31"]', list).check().outcome).toBe('pass');
      expect(codes(fixture('  work\n    dates [2026-01-01, soon, later]', list).check())).toEqual([
        'IA-COMP-FIELD-FORM',
      ]);
    });
  });
  it('reports one finding per field for each violated narrowing without hiding a good duplicate', () => {
    const rule = open('must have work.status as id in [todo]');
    expect(codes(fixture('  work\n    status todo\n    status nope', rule).check())).toEqual([
      'IA-COMP-FIELD-DUPLICATE',
      'IA-COMP-FIELD-VALUE',
    ]);
  });
});

describe('schema value domains', () => {
  it.each([
    ['text', 'plain words', true],
    ['id', 'Memory', true],
    ['id', 'bad value', false],
    ['id', '1first', false],
    ['qname', 'demo/definition/head/name', true],
    ['qname', 'demo/nope/head/name', false],
    ['qname', 'Demo/definition/head/name', false],
    ['qname', 'demo/definition/head/name#fragment', false],
    ['qname', 'demo/definition/head', false],
    ['number', '-2.5e+3', true],
    ['number', '.5', true],
    ['number', '', false],
    ['number', 'Infinity', false],
    ['number', '0x12', false],
    ['number', '1e999', false],
    ['flag', 'true', true],
    ['flag', 'false', true],
    ['flag', 'yes', false],
  ] as const)('%s accepts %s = %s', (type, text, valid) =>
    expect(matchesType({ kind: 'scalar', text }, type)).toBe(valid),
  );
  it('distinguishes references, quoted text, flags, blocks and absent values', () => {
    expect(matchesType({ kind: 'ref', discriminator: 'entry', name: 'x' }, 'ref')).toBe(true);
    expect(matchesType({ kind: 'string', text: '@entry x' }, 'ref')).toBe(false);
    expect(matchesType({ kind: 'string', text: '' }, 'text')).toBe(true);
    expect(matchesType({ kind: 'prose', text: 'words' }, 'text')).toBe(true);
    expect(matchesType({ kind: 'none' }, 'flag')).toBe(true);
    expect(matchesType({ kind: 'block' }, 'flag')).toBe(false);
    expect(matchesType({ kind: 'string', text: 'true' }, 'flag')).toBe(false);
    expect(matchesType({ kind: 'none' }, 'text')).toBe(false);
  });
  it.each(['text', 'id', 'qname', 'number', 'ref', 'flag'] as const)(
    'admits empty lists of %s only as lists',
    (type) => {
      expect(matchesType({ kind: 'list', items: [] }, `list of ${type}` as FieldType)).toBe(true);
      expect(matchesType({ kind: 'scalar', text: 'anything' }, `list of ${type}` as FieldType)).toBe(false);
    },
  );
  it.each([
    ['iso-date', '2026-02-28', true],
    ['iso-date', '2026-02-29', false],
    ['iso-date', '2000-02-29', true],
    ['iso-date', '1900-02-29', false],
    ['iso-date', '2026-6-1', false],
  ] as const)('%s form accepts %s = %s', (form, text, valid) => expect(matchesForm(text, form)).toBe(valid));
  it('validates list element types without converting quoted references', () => {
    expect(
      matchesType({ kind: 'list', items: [{ kind: 'ref', discriminator: 'entry', name: 'x' }] }, 'list of ref'),
    ).toBe(true);
    expect(matchesType({ kind: 'list', items: [{ kind: 'string', text: '@entry x' }] }, 'list of ref')).toBe(false);
    expect(matchesType({ kind: 'list', items: [{ kind: 'scalar', text: 'true' }] }, 'list of flag')).toBe(true);
  });
});

function edges(rows: string, relationship: string, more = '') {
  return fixture(`  relationships\n${relationship}`, `  sections\n    open\n  edges\n${rows}`, more);
}
describe('schema edge obligations', () => {
  it.each(['entry', 'definition'])('counts real %s targets', (target) => {
    expect(edges(`    must cite ${target} one`, '    cites @entry target', '@entry target').check().outcome).toBe(
      'pass',
    );
  });
  it('counts a reciprocal inbound assertion only once', () => {
    expect(
      edges(
        '    must cite entry one',
        '    cites @entry target',
        '@entry target\n  relationships\n    cited-by @entry subject',
      ).check().outcome,
    ).toBe('pass');
  });
  it('counts an inbound assertion on the target, but not on the subject', () => {
    expect(
      edges('    must cite entry one', '', '@entry target\n  relationships\n    cited-by @entry subject').check()
        .outcome,
    ).toBe('pass');
    expect(codes(edges('    must cite entry one', '    cited-by @entry target', '@entry target').check())).toEqual([
      'IA-COMP-EDGE-CARDINALITY',
    ]);
  });
  it.each(['must cite entry one', 'must cite entry one-or-more'])('enforces minimum for %s', (rule) => {
    expect(codes(edges(`    ${rule}`, '').check())).toEqual(['IA-COMP-EDGE-CARDINALITY']);
  });
  it.each(['may cite entry one', 'may cite entry one-or-more', 'may cite entry optional', 'must cite entry optional'])(
    'admits absence for %s',
    (rule) => {
      expect(edges(`    ${rule}`, '').check().outcome).toBe('pass');
    },
  );
  it.each(['must cite entry one', 'may cite entry one', 'may cite entry optional'])(
    'enforces upper bound for %s',
    (rule) => {
      expect(
        codes(edges(`    ${rule}`, '    cites @entry a\n    cites @entry b', '@entry a\n@entry b').check()),
      ).toEqual(['IA-COMP-EDGE-CARDINALITY']);
    },
  );
  it('reports dangling or conditional obligations as not-evaluated', () => {
    for (const f of [
      edges('    must cite entry one', '    cites @entry missing'),
      edges('    must cite entry one', '    cites @entry target when phase is act', '@entry target'),
    ]) {
      const result = f.check();
      expect(result.outcome).toBe('not-evaluated');
      expect(codes(result)).toEqual(['IA-COMP-EDGE-UNRESOLVED']);
      expect(result.findings[0]!.severity).toBe('warning');
    }
  });
  it('does not need uncertain additional targets after a minimum-only obligation is established', () => {
    expect(
      edges(
        '    must cite entry one-or-more',
        '    cites @entry target\n    cites @entry missing',
        '@entry target',
      ).check().outcome,
    ).toBe('pass');
  });
  it('distinguishes fragments and ignores other predicates or target kinds', () => {
    expect(
      codes(
        edges(
          '    must cite entry one',
          '    cites @entry target#a\n    cites @entry target#b',
          '@entry target',
        ).check(),
      ),
    ).toEqual(['IA-COMP-EDGE-CARDINALITY']);
    expect(edges('    may cite binding optional', '    cites @entry missing').check().outcome).toBe('pass');
    expect(edges('    may use entry optional', '    cites @entry target', '@entry target').check().outcome).toBe(
      'pass',
    );
  });
  it.each(['entry', 'definition'])('recognizes unresolved qualified targets for %s', (target) => {
    expect(edges(`    must cite ${target} one`, '    cites demo/definition/entry/missing').check().outcome).toBe(
      'not-evaluated',
    );
  });
  it('does not count a conditioned reciprocal assertion as a static guarantee', () => {
    expect(
      edges(
        '    must cite entry one',
        '',
        '@entry target\n  relationships\n    cited-by @entry subject when phase is act',
      ).check().outcome,
    ).toBe('not-evaluated');
  });
  it('does not count a resolved identity with absent or ambiguous pool evidence', () => {
    const f = edges('    must cite entry one', '    cites @entry target', '@entry target');
    expect(validateSchema(f.record, f.registry, []).outcome).toBe('not-evaluated');
    const target = f.pool.find((r) => r.name === 'target')!;
    const duplicate: CompiledRecord = { ...target, source: { ...target.source, path: 'other.ia' } };
    expect(validateSchema(f.record, f.registry, [...f.pool, duplicate]).outcome).toBe('not-evaluated');
  });
  it('fails independently certain errors even when another check is undecidable', () => {
    const result = fixture(
      '  relationships\n    cites @entry missing',
      '  sections\n    open\n  fields\n    must have head.label as text\n  edges\n    must cite entry one',
    ).check();
    expect(result.outcome).toBe('fail');
    expect(codes(result)).toEqual(['IA-COMP-EDGE-UNRESOLVED', 'IA-COMP-FIELD-MISSING']);
  });
});
