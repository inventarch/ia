import { describe, expect, it } from 'vitest';
import { gapsOn, languageFloor, rangeFloor, usageOf } from '../src/distribution/index.js';
import type { BaseCatalogue, CatalogueWord, CompatIndex } from '../src/distribution/index.js';

const observation = (extra: CatalogueWord['fields'] = [], origin: string[] = ['check', 'manual']): CatalogueWord => ({
  closed: true,
  sections: [
    { name: 'meaning', required: true },
    { name: 'evidence', required: true },
    { name: 'relationships', required: false },
  ],
  fields: [
    { path: 'meaning.says', type: 'text', required: true },
    { path: 'evidence.origin', type: 'id', required: true, values: origin },
    { path: 'evidence.subject', type: 'ref', required: false, target: 'contract' },
    ...extra,
  ],
  edges: [],
});
const contract: CatalogueWord = {
  closed: true,
  sections: [{ name: 'meaning', required: true }],
  fields: [
    { path: 'head.version', type: 'text', required: true },
    { path: 'meaning.says', type: 'text', required: true },
  ],
  edges: [],
};
const base = (version: string, words: Record<string, CatalogueWord>): BaseCatalogue => ({
  version,
  archive: version.replaceAll('.', '').padStart(64, '0'),
  engine: '^0.1.1',
  language: ['1.0'],
  languageRecord: '0'.repeat(64),
  words,
});
const label = { path: 'evidence.label', type: 'text', required: false };
/** 3.0.0; 3.1.0 adds the optional `evidence.label`; 3.2.0 changes only labels, so its words equal 3.1.0's. */
const index: CompatIndex = {
  format: 'ia.language-compat.v1',
  id: 'inventarch/language',
  major: 3,
  bases: [
    base('3.0.0', { observation: observation(), contract }),
    base('3.1.0', { observation: observation([label]), contract }),
    base('3.2.0', { observation: observation([label]), contract }),
  ],
};
const record = (evidence: string[], name = 'sample'): string =>
  ['#! ia 1.0', '', `@observation ${name}`, '  meaning', '    says "x"', '  evidence', ...evidence, ''].join('\n');
const source = (text: string, path = 'kit/records/sample.ia') => [{ path, text }];

describe('languageFloor', () => {
  it('floor uses the highest base introducing a used field', () => {
    const result = languageFloor(usageOf(source(record(['    origin check', '    label "a label"']))), index);
    expect(result.floor).toBe('3.1.0');
    expect(result.newest).toBe('3.2.0');
    expect(result.gaps).toEqual([
      {
        base: '3.0.0',
        source: 'kit/records/sample.ia',
        record: 'sample',
        word: 'observation',
        kind: 'field',
        key: 'observation.evidence.label',
      },
    ]);
  });

  it('a record using nothing new gets the lowest base', () => {
    const result = languageFloor(usageOf(source(record(['    origin check']))), index);
    expect(result).toEqual({ floor: '3.0.0', newest: '3.2.0', gaps: [] });
  });

  it("an id value outside a base's values is a gap", () => {
    const widened: CompatIndex = {
      ...index,
      bases: [
        base('3.0.0', { observation: observation([], ['check']) }),
        base('3.1.0', { observation: observation([], ['check', 'manual']) }),
      ],
    };
    const usage = usageOf(source(record(['    origin manual'])));
    const result = languageFloor(usage, widened);
    expect(result.floor).toBe('3.1.0');
    expect(result.gaps).toEqual([
      expect.objectContaining({ base: '3.0.0', kind: 'value', key: 'observation.evidence.origin=manual' }),
    ]);
    expect(gapsOn(usage, widened.bases[1]!, widened)).toEqual([]);
  });

  it("a text value outside a base's form is a form gap", () => {
    const when = (form?: string): CatalogueWord['fields'] => [
      { path: 'evidence.when', type: 'text', required: false, ...(form ? { form } : {}) },
    ];
    // 3.0.0 requires an ISO date; 3.1.0 drops the form.
    const relaxed: CompatIndex = {
      ...index,
      bases: [
        base('3.0.0', { observation: observation(when('iso-date')) }),
        base('3.1.0', { observation: observation(when()) }),
      ],
    };
    const loose = usageOf(source(record(['    origin check', '    when "next week"'])));
    const result = languageFloor(loose, relaxed);
    expect(result.floor).toBe('3.1.0');
    expect(result.gaps).toEqual([
      expect.objectContaining({ base: '3.0.0', kind: 'form', key: 'observation.evidence.when=next week' }),
    ]);
    const dated = usageOf(source(record(['    origin check', '    when "2026-11-10"'])));
    expect(languageFloor(dated, relaxed)).toEqual({ floor: '3.0.0', newest: '3.1.0', gaps: [] });
  });

  it('a value of the wrong type or reference target is a type gap', () => {
    const usage = usageOf(source(record(['    origin check', '    subject @observation other'])));
    expect(gapsOn(usage, index.bases[0]!, index)).toEqual([
      expect.objectContaining({ kind: 'type', key: 'observation.evidence.subject' }),
    ]);
    const quoted = usageOf(source(record(['    origin check', '    subject "not a reference"'])));
    expect(gapsOn(quoted, index.bases[0]!, index)).toEqual([
      expect.objectContaining({ kind: 'type', key: 'observation.evidence.subject' }),
    ]);
  });

  it('a field newly required in a base is a gap for records that lack it', () => {
    const required: CompatIndex = {
      ...index,
      bases: [
        base('3.0.0', { observation: observation() }),
        base('3.1.0', { observation: observation([{ ...label, required: true }]) }),
      ],
    };
    const result = languageFloor(usageOf(source(record(['    origin check']))), required);
    expect(result.floor).toBeNull();
    expect(result.newest).toBe('3.1.0');
    expect(result.gaps).toEqual([
      expect.objectContaining({ base: '3.1.0', kind: 'required-field', key: 'observation.evidence.label' }),
    ]);
  });

  it('a section unknown to a closed schema, and a missing required section, are gaps', () => {
    const sectioned: CompatIndex = {
      ...index,
      bases: [
        base('3.0.0', { observation: observation() }),
        base('3.1.0', {
          observation: {
            ...observation(),
            sections: [...observation().sections, { name: 'retention', required: false }],
          },
        }),
      ],
    };
    const usage = usageOf(source(record(['    origin check', '  retention'])));
    expect(languageFloor(usage, sectioned)).toEqual({
      floor: '3.1.0',
      newest: '3.1.0',
      gaps: [expect.objectContaining({ base: '3.0.0', kind: 'section', key: 'observation.retention' })],
    });
    const bare = usageOf(source(['#! ia 1.0', '', '@observation bare', '  meaning', '    says "x"', ''].join('\n')));
    expect(gapsOn(bare, index.bases[0]!, index)).toEqual([
      expect.objectContaining({ kind: 'required-section', key: 'observation.evidence' }),
    ]);
  });

  it('head fields are read under head.<key>; the head stays open', () => {
    const text = [
      '#! ia 1.0',
      '',
      '@contract sample',
      '  version "1.0"',
      '  owner "someone"',
      '  meaning',
      '    says "x"',
      '',
    ];
    expect(gapsOn(usageOf(source(text.join('\n'))), index.bases[0]!, index)).toEqual([]);
    const missing = text.filter((line) => !line.includes('version'));
    expect(gapsOn(usageOf(source(missing.join('\n'))), index.bases[0]!, index)).toEqual([
      expect.objectContaining({ kind: 'required-field', key: 'contract.head.version' }),
    ]);
  });

  it('a word missing from a base that another base has is a word gap', () => {
    const late: CompatIndex = {
      ...index,
      bases: [base('3.0.0', { observation: observation() }), base('3.1.0', { observation: observation(), contract })],
    };
    const text = ['#! ia 1.0', '', '@contract sample', '  version "1.0"', '  meaning', '    says "x"', ''].join('\n');
    expect(languageFloor(usageOf(source(text)), late)).toEqual({
      floor: '3.1.0',
      newest: '3.1.0',
      gaps: [
        {
          base: '3.0.0',
          source: 'kit/records/sample.ia',
          record: 'sample',
          word: 'contract',
          kind: 'word',
          key: 'contract',
        },
      ],
    });
  });

  it("words in no base are the kit's own and ignored", () => {
    const text = ['#! ia 1.0', '', '@recipe soup', '  ingredients', '    salt "a pinch"', ''].join('\n');
    expect(languageFloor(usageOf(source(text)), index)).toEqual({ floor: '3.0.0', newest: '3.2.0', gaps: [] });
  });

  it('CRLF sources give the same result as LF', () => {
    const lf = record(['    origin check', '    label "a label"']);
    const crlf = lf.replaceAll('\n', '\r\n');
    expect(languageFloor(usageOf(source(crlf)), index)).toEqual(languageFloor(usageOf(source(lf)), index));
    expect(languageFloor(usageOf(source(crlf)), index).floor).toBe('3.1.0');
  });

  it('a record with a parse error is a gap, never silently skipped', () => {
    const broken = record(['    origin check', '    label "unterminated']);
    const result = languageFloor(usageOf(source(broken)), index);
    expect(result.floor).toBeNull();
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps[0]).toEqual(
      expect.objectContaining({
        base: '3.2.0',
        source: 'kit/records/sample.ia',
        record: 'sample',
        word: 'observation',
        kind: 'parse',
      }),
    );
    expect(result.gaps[0]!.key).toMatch(/^IA-LANG-[A-Z-]+ at line \d+$/);
    const unowned = languageFloor(usageOf(source('@observation sample\n')), index);
    expect(unowned).toEqual({
      floor: null,
      newest: '3.2.0',
      gaps: [
        {
          base: '3.2.0',
          source: 'kit/records/sample.ia',
          record: '',
          word: '',
          kind: 'parse',
          key: 'IA-LANG-PRAGMA-MISSING at line 1',
        },
      ],
    });
  });

  it('usage is independent of source order', () => {
    const a = { path: 'kit/a.ia', text: record(['    origin check', '    label "a"'], 'a') };
    const b = { path: 'kit/b.ia', text: record(['    origin check'], 'b') };
    expect(languageFloor(usageOf([a, b]), index)).toEqual(languageFloor(usageOf([b, a]), index));
  });
});

describe('rangeFloor', () => {
  it('is the lowest version a range admits', () => {
    expect(rangeFloor('^3.2.0')).toBe('3.2.0');
    expect(rangeFloor('>=3.1.0 <4.0.0')).toBe('3.1.0');
    expect(rangeFloor('3.x')).toBe('3.0.0');
    expect(() => rangeFloor('not a range')).toThrow();
  });
});
