import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogueWord } from '../../packages/db/src/distribution/index.js';
import { buildLanguageBase } from './language-base.js';
import { ledgerArchive, readBaseLedger } from './language-bases.js';
import { baseCatalogue, compatIndex, languageCompatOutputs, settleLanguageCompat } from './language-compat.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ledger = readBaseLedger(root);
const built = buildLanguageBase(root);
const ledgerCatalogue = (version: string) => {
  const base = ledger.bases.find((entry) => entry.version === version);
  if (!base) throw new Error(`No ledger base ${version}`);
  return baseCatalogue(ledgerArchive(root, base), base.archive);
};

interface VocabularyWord {
  word: string;
  schema: {
    closed: boolean;
    sections: { name: string; required: boolean }[];
    fields: { path: string; type: string; required: boolean; values?: string[]; target?: string }[];
    edges: { predicate: string; direction: 'out' | 'in'; required: boolean }[];
  };
}

describe('language compatibility index', () => {
  it('catalogue of 3.2.0 and 3.2.1 have identical words', () => {
    expect(built.pin.version).toBe('3.2.1');
    const previous = ledgerCatalogue('3.2.0'),
      next = baseCatalogue(built.bytes, built.pin.archive);
    expect(next.version).toBe('3.2.1');
    expect(next.archive).toBe(built.pin.archive);
    expect(Object.keys(next.words).length).toBe(44);
    expect(next.words).toEqual(previous.words);
    expect(next.languageRecord).toBe(previous.languageRecord);
    expect([next.engine, next.language]).toEqual([previous.engine, previous.language]);
  });

  it('catalogue of the built base matches apps/cli/assets/vocabulary.json schemas', () => {
    const vocabulary = JSON.parse(readFileSync(resolve(root, 'apps/cli/assets/vocabulary.json'), 'utf8')) as {
      words: VocabularyWord[];
    };
    const projected = Object.fromEntries(
      vocabulary.words.map(({ word, schema }): [string, CatalogueWord] => [
        word,
        {
          closed: schema.closed,
          sections: schema.sections.map(({ name, required }) => ({ name, required })),
          fields: schema.fields.map(({ path, type, required, values, target }) => ({
            path,
            type,
            required,
            ...(values ? { values } : {}),
            ...(target ? { target } : {}),
          })),
          edges: schema.edges.map(({ predicate, direction, required }) => ({ predicate, direction, required })),
        },
      ]),
    );
    expect(baseCatalogue(built.bytes, built.pin.archive).words).toEqual(projected);
  });

  it('refuses archive bytes that do not hash to the digest', () => {
    expect(() => baseCatalogue(built.bytes, '0'.repeat(64))).toThrow();
  });

  it('covers every ledger base, then the built base when it is newer', () => {
    const index = compatIndex(root);
    expect([index.format, index.id, index.major]).toEqual(['ia.language-compat.v1', 'inventarch/language', 3]);
    expect(index.bases.map((base) => [base.version, base.archive])).toEqual([
      ...ledger.bases.map((base) => [base.version, base.archive]),
      [built.pin.version, built.pin.archive],
    ]);
  });

  it('generation is deterministic', () => {
    const first = languageCompatOutputs(root),
      second = languageCompatOutputs(root);
    expect([...first.keys()]).toEqual(['releases/native/language-compat.json', 'apps/cli/assets/language-compat.json']);
    expect([...second]).toEqual([...first]);
    const [releases, shipped] = [...first.values()];
    expect(shipped).toBe(releases);
  });

  it('check mode fails on a stale committed index', () => {
    const outputs = languageCompatOutputs(root);
    const target = mkdtempSync(resolve(tmpdir(), 'ia-language-compat-'));
    try {
      for (const [path, text] of outputs) {
        mkdirSync(dirname(resolve(target, path)), { recursive: true });
        writeFileSync(resolve(target, path), text.replaceAll('\n', '\r\n'));
      }
      expect(settleLanguageCompat(target, outputs, 'check')).toEqual([]);
      const stale = JSON.parse(outputs.get('apps/cli/assets/language-compat.json')!);
      stale.bases.pop();
      writeFileSync(resolve(target, 'apps/cli/assets/language-compat.json'), JSON.stringify(stale, null, 2) + '\n');
      expect(() => settleLanguageCompat(target, outputs, 'check')).toThrow(
        'Language compatibility index drift: apps/cli/assets/language-compat.json',
      );
      expect(settleLanguageCompat(target, outputs, 'write')).toEqual(['apps/cli/assets/language-compat.json']);
      expect(settleLanguageCompat(target, outputs, 'check')).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('the committed index is current', () => {
    expect(settleLanguageCompat(root, languageCompatOutputs(root), 'check')).toEqual([]);
  });
});
