import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BaseCatalogue, CatalogueWord } from '../../packages/db/src/distribution/index.js';
import { buildLanguageBase } from '../native/language-base.js';
import { ledgerArchive, readBaseLedger } from '../native/language-bases.js';
import { baseCatalogue } from '../native/language-compat.js';
import { checkLanguageCompat, classifyBaseChange, fixtureKits, minimumBump } from './language-compat-gate.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

const word = (patch: Partial<CatalogueWord> = {}): CatalogueWord => ({
  closed: false,
  sections: [{ name: 'meaning', required: true }],
  fields: [
    { path: 'meaning.says', type: 'text', required: true },
    { path: 'meaning.kind', type: 'enum', required: false, values: ['a', 'b'] },
  ],
  edges: [{ predicate: 'cite', direction: 'out', target: 'definition', required: false, cardinality: 'one-or-more' }],
  ...patch,
});
const base = (words: Record<string, CatalogueWord>, patch: Partial<BaseCatalogue> = {}): BaseCatalogue => ({
  version: '3.0.0',
  archive: 'a'.repeat(64),
  engine: '^0.1.0',
  language: ['1.0'],
  languageRecord: 'r'.repeat(64),
  words,
  ...patch,
});
const before = base({ note: word() });
const kindOf = (next: BaseCatalogue) => classifyBaseChange(before, next).kind;
const withWord = (patch: Partial<CatalogueWord>) => base({ note: word(patch) });
const mapField = (path: string, patch: Record<string, unknown>) =>
  word().fields.map((field) => (field.path === path ? { ...field, ...patch } : field));

describe('classifyBaseChange', () => {
  it('is a label when only the version or archive differs', () => {
    expect(classifyBaseChange(before, base({ note: word() }, { version: '3.0.1', archive: 'b'.repeat(64) }))).toEqual({
      kind: 'label',
      changes: [],
    });
  });
  it('is breaking when a word is removed', () => {
    expect(classifyBaseChange(before, base({}))).toEqual({
      kind: 'breaking',
      changes: [{ kind: 'word-removed', key: 'note' }],
    });
  });
  it('is breaking when a section is removed', () => {
    expect(kindOf(withWord({ sections: [] }))).toBe('breaking');
  });
  it('is breaking when a field is removed', () => {
    expect(kindOf(withWord({ fields: [word().fields[0]!] }))).toBe('breaking');
  });
  it('is breaking when a field type changes', () => {
    expect(kindOf(withWord({ fields: mapField('meaning.says', { type: 'ref' }) }))).toBe('breaking');
  });
  it('is breaking when values narrow', () => {
    expect(
      classifyBaseChange(before, withWord({ fields: mapField('meaning.kind', { values: ['a'] }) })).changes,
    ).toEqual([{ kind: 'values-narrowed', key: 'note.meaning.kind' }]);
  });
  it('is breaking when an open field gains values', () => {
    expect(kindOf(withWord({ fields: mapField('meaning.says', { values: ['x'] }) }))).toBe('breaking');
  });
  it('is breaking when a field becomes required', () => {
    expect(kindOf(withWord({ fields: mapField('meaning.kind', { required: true }) }))).toBe('breaking');
  });
  it('is breaking when a new required section or field appears', () => {
    expect(kindOf(withWord({ sections: [...word().sections, { name: 'extra', required: true }] }))).toBe('breaking');
    expect(
      kindOf(withWord({ fields: [...word().fields, { path: 'meaning.more', type: 'text', required: true }] })),
    ).toBe('breaking');
  });
  it('is breaking when a word closes', () => {
    expect(kindOf(withWord({ closed: true }))).toBe('breaking');
  });
  it('is breaking when a new required edge appears', () => {
    const edges = [
      ...word().edges,
      { predicate: 'ground', direction: 'out' as const, target: 'system', required: true, cardinality: 'one' },
    ];
    expect(kindOf(withWord({ edges }))).toBe('breaking');
  });
  it('is breaking when a text field gains or changes its form, additive when it loses it', () => {
    const dated = withWord({ fields: mapField('meaning.says', { form: 'iso-date' }) });
    expect(classifyBaseChange(before, dated)).toEqual({
      kind: 'breaking',
      changes: [{ kind: 'form-added', key: 'note.meaning.says' }],
    });
    expect(classifyBaseChange(dated, withWord({ fields: mapField('meaning.says', { form: 'iso-time' }) }))).toEqual({
      kind: 'breaking',
      changes: [{ kind: 'form-changed', key: 'note.meaning.says' }],
    });
    expect(classifyBaseChange(dated, before)).toEqual({
      kind: 'additive',
      changes: [{ kind: 'form-removed', key: 'note.meaning.says' }],
    });
  });
  it('is breaking when an edge cardinality narrows, additive when it widens', () => {
    const one = withWord({ edges: [{ ...word().edges[0]!, cardinality: 'one' }] });
    expect(classifyBaseChange(before, one)).toEqual({
      kind: 'breaking',
      changes: [{ kind: 'cardinality-narrowed', key: 'note.cite/out/definition' }],
    });
    expect(classifyBaseChange(one, before)).toEqual({
      kind: 'additive',
      changes: [{ kind: 'cardinality-widened', key: 'note.cite/out/definition' }],
    });
    // A required rule's minimum rises from `optional` to `one`: narrowed, though both admit at most one.
    const must = (cardinality: string) => withWord({ edges: [{ ...word().edges[0]!, required: true, cardinality }] });
    expect(classifyBaseChange(must('optional'), must('one')).kind).toBe('breaking');
  });
  it('is breaking when an edge rule is retargeted', () => {
    expect(
      classifyBaseChange(before, withWord({ edges: [{ ...word().edges[0]!, target: 'contract' }] })).changes,
    ).toEqual([
      { kind: 'edge-removed', key: 'note.cite/out/definition' },
      { kind: 'edge-added', key: 'note.cite/out/contract' },
    ]);
  });
  it('is additive for a new word, optional section, optional field, optional edge or widened values', () => {
    expect(kindOf(base({ note: word(), other: word() }))).toBe('additive');
    expect(kindOf(withWord({ sections: [...word().sections, { name: 'extra', required: false }] }))).toBe('additive');
    expect(
      kindOf(withWord({ fields: [...word().fields, { path: 'meaning.more', type: 'text', required: false }] })),
    ).toBe('additive');
    const edges = [
      ...word().edges,
      { predicate: 'ground', direction: 'out' as const, target: 'system', required: false, cardinality: 'optional' },
    ];
    expect(kindOf(withWord({ edges }))).toBe('additive');
    expect(
      classifyBaseChange(before, withWord({ fields: mapField('meaning.kind', { values: ['a', 'b', 'c'] }) })).changes,
    ).toEqual([{ kind: 'values-widened', key: 'note.meaning.kind' }]);
  });
  it('is additive when a requirement is relaxed', () => {
    expect(kindOf(withWord({ fields: mapField('meaning.says', { required: false }) }))).toBe('additive');
  });
  it('is unclassified when the language record or engine changes', () => {
    expect(kindOf(base({ note: word() }, { languageRecord: 'x'.repeat(64) }))).toBe('unclassified');
    expect(kindOf(base({ note: word() }, { engine: '^0.2.0' }))).toBe('unclassified');
  });
  it('lets breaking outrank unclassified and additive', () => {
    expect(kindOf(base({ other: word() }, { languageRecord: 'x'.repeat(64) }))).toBe('breaking');
  });
  it('classifies the published 3.2.0 to the built 3.2.1 as a label', () => {
    const published = readBaseLedger(root).bases.find((entry) => entry.version === '3.2.0')!;
    const previous = baseCatalogue(ledgerArchive(root, published), published.archive);
    const built = buildLanguageBase(root);
    expect(classifyBaseChange(previous, baseCatalogue(built.bytes, built.pin.archive))).toEqual({
      kind: 'label',
      changes: [],
    });
  });
});

describe('minimumBump', () => {
  it('maps each kind to its least bump', () => {
    expect(minimumBump('label')).toBe('patch');
    expect(minimumBump('additive')).toBe('minor');
    expect(minimumBump('breaking')).toBe('major');
    expect(minimumBump('unclassified')).toBe('major');
    expect(minimumBump('unclassified', 'reviewed-additive')).toBe('minor');
  });
});

describe('checkLanguageCompat', () => {
  const changed = { archive: 'b'.repeat(64) };
  const pair = (next: BaseCatalogue, bump?: string, compatibility?: string) => ({
    previous: before,
    next,
    notes: bump === undefined ? undefined : { bump, ...(compatibility ? { compatibility } : {}) },
    verify: () => ({ ok: true, detail: '' }),
  });
  it('passes a label under a patch', () => {
    expect(checkLanguageCompat(pair(base({ note: word() }, changed), 'patch')).failures).toEqual([]);
  });
  it('passes with nothing to classify when the archive is the published one', () => {
    expect(checkLanguageCompat(pair(before)).failures).toEqual([]);
  });
  it('fails an additive change under a patch, passes it under a minor', () => {
    const next = base({ note: word(), other: word() }, changed);
    expect(checkLanguageCompat(pair(next, 'patch')).failures).toHaveLength(1);
    expect(checkLanguageCompat(pair(next, 'minor')).failures).toEqual([]);
  });
  it('fails a breaking change under a minor, passes it under a major', () => {
    const next = base({}, changed);
    expect(checkLanguageCompat(pair(next, 'minor')).failures[0]).toContain('word-removed');
    expect(checkLanguageCompat(pair(next, 'major')).failures).toEqual([]);
  });
  it('requires a note when the base changed', () => {
    expect(checkLanguageCompat(pair(base({}, changed))).failures).toHaveLength(1);
  });
  it('wants a major for an unclassified change unless it is reviewed-additive', () => {
    const next = base({ note: word() }, { ...changed, languageRecord: 'x'.repeat(64) });
    expect(checkLanguageCompat(pair(next, 'minor')).failures).toHaveLength(1);
    expect(checkLanguageCompat(pair(next, 'major')).failures).toEqual([]);
    expect(checkLanguageCompat(pair(next, 'minor', 'reviewed-additive')).failures).toEqual([]);
    expect(checkLanguageCompat(pair(next, 'patch', 'reviewed-additive')).failures).toHaveLength(1);
  });
  it('fails when a fixture kit does not verify on the candidate', () => {
    const next = base({ note: word() }, changed);
    const result = checkLanguageCompat({ ...pair(next, 'patch'), verify: () => ({ ok: false, detail: 'boom' }) });
    expect(result.failures).toEqual([expect.stringContaining('boom')]);
  });
});

describe('fixtureKits', () => {
  it('proves the method fixture kit and the three published public kits, each with its release, lock and records', () => {
    const kits = fixtureKits(root);
    expect(
      kits.map(({ name, files }) => [
        name,
        (JSON.parse(files['.ia/release.json']!) as { id: string; version: string }).id,
      ]),
    ).toEqual([
      ['ia-kb (method fixture)', 'inventarch/ia-kb-kit'],
      ['ia-authoring', 'inventarch/ia-authoring-kit'],
      ['ia-kb', 'inventarch/ia-kb-kit'],
      ['ia-method', 'inventarch/ia-method-kit'],
    ]);
    for (const { files } of kits) {
      expect(Object.keys(files)).toContain('.ia/distributions.lock.json');
      expect(Object.keys(files).some((path) => path.startsWith('.ia/src/') && path.endsWith('.ia'))).toBe(true);
    }
  });
});
