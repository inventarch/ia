import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogueWord } from '../../packages/db/src/distribution/index.js';
import { distributionSnapshot, packSnapshot } from '../../apps/distribution/src/snapshot.js';
import { buildLanguageBase, languageBaseDescriptor } from './language-base.js';
import { compareVersions, ledgerArchive, readBaseLedger } from './language-bases.js';
import {
  baseCatalogue,
  compatIndex,
  compatIndexOf,
  languageCompatOutputs,
  settleLanguageCompat,
} from './language-compat.js';
import { languagePackageInputs } from './public-language.js';

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
    fields: { path: string; type: string; required: boolean; values?: string[]; target?: string; form?: string }[];
    edges: { predicate: string; direction: 'out' | 'in'; target: string; required: boolean; cardinality: string }[];
  };
}

describe('language compatibility index', () => {
  it('catalogue of 3.2.0 and 3.2.1 have identical words', () => {
    const previous = ledgerCatalogue('3.2.0'),
      next = ledgerCatalogue('3.2.1');
    expect(next.version).toBe('3.2.1');
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
          fields: schema.fields.map(({ path, type, required, values, target, form }) => ({
            path,
            type,
            required,
            ...(values ? { values } : {}),
            ...(target ? { target } : {}),
            ...(form ? { form } : {}),
          })),
          edges: schema.edges.map(({ predicate, direction, target, required, cardinality }) => ({
            predicate,
            direction,
            target,
            required,
            cardinality,
          })),
        },
      ]),
    );
    expect(baseCatalogue(built.bytes, built.pin.archive).words).toEqual(projected);
  });

  it('refuses archive bytes that do not hash to the digest', () => {
    expect(() => baseCatalogue(built.bytes, '0'.repeat(64))).toThrow();
  });

  it('refuses an archive of another package', () => {
    const { inputs, folders } = languagePackageInputs(root);
    const packed = packSnapshot(
      distributionSnapshot({ sources: inputs, folders, floorOrigin: 'local' }),
      { ...languageBaseDescriptor('3.2.1'), id: 'inventarch/other' },
      new Map(['LICENSE', 'NOTICE'].map((path) => [path, readFileSync(resolve(root, path))])),
    );
    expect(packed.manifest.id).toBe('inventarch/other');
    expect(() => baseCatalogue(packed.bytes, packed.archiveDigest)).toThrow(
      `Archive ${packed.archiveDigest} carries inventarch/other, not inventarch/language`,
    );
  });

  it('refuses a base of another major', () => {
    const four = buildLanguageBase(root, { version: '4.0.0' });
    const catalogue = baseCatalogue(four.bytes, four.pin.archive);
    expect(catalogue.version).toBe('4.0.0');
    expect(() => compatIndexOf(3, [{ version: '4.0.0', catalogue }])).toThrow('Base 4.0.0 is not of major 3');
  });

  it('refuses a ledger row whose archive carries another version', () => {
    const catalogue = baseCatalogue(built.bytes, built.pin.archive);
    expect(() => compatIndexOf(3, [{ version: '3.2.0', catalogue }])).toThrow(
      `Base 3.2.0 names archive ${built.pin.archive}, which carries ${built.pin.version}`,
    );
    expect(compatIndexOf(3, [{ version: built.pin.version, catalogue }]).bases).toEqual([catalogue]);
  });

  it('covers every ledger base, then the built base when it is newer', () => {
    const index = compatIndex(root);
    expect([index.format, index.id, index.major]).toEqual(['ia.language-compat.v1', 'inventarch/language', 3]);
    const rows = ledger.bases.map((base) => [base.version, base.archive]);
    const newest = ledger.bases.at(-1);
    expect(index.bases.map((base) => [base.version, base.archive])).toEqual(
      newest !== undefined && compareVersions(built.pin.version, newest.version) <= 0
        ? rows
        : [...rows, [built.pin.version, built.pin.archive]],
    );
  });

  it('generation is deterministic', () => {
    const first = languageCompatOutputs(root),
      second = languageCompatOutputs(root);
    expect([...first.keys()]).toEqual(['releases/native/language-compat.json', 'apps/cli/assets/language-compat.json']);
    expect([...second]).toEqual([...first]);
    const [releases, shipped] = [...first.values()] as [string, string];
    // Pretty in releases/ for readable diffs; compact in the CLI's shipped asset; the same index in both.
    expect(releases).toBe(JSON.stringify(JSON.parse(releases), null, 2) + '\n');
    expect(shipped).toBe(JSON.stringify(JSON.parse(releases)) + '\n');
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
      writeFileSync(resolve(target, 'apps/cli/assets/language-compat.json'), JSON.stringify(stale) + '\n');
      expect(() => settleLanguageCompat(target, outputs, 'check')).toThrow(
        'Language compatibility index drift: apps/cli/assets/language-compat.json',
      );
      expect(settleLanguageCompat(target, outputs, 'write')).toEqual(['apps/cli/assets/language-compat.json']);
      expect(settleLanguageCompat(target, outputs, 'check')).toEqual([]);
      // The same index pretty-printed is still drift for the compact asset; a stale pretty copy is drift in releases/.
      writeFileSync(
        resolve(target, 'apps/cli/assets/language-compat.json'),
        outputs.get('releases/native/language-compat.json')!,
      );
      writeFileSync(resolve(target, 'releases/native/language-compat.json'), JSON.stringify(stale, null, 2) + '\n');
      expect(() => settleLanguageCompat(target, outputs, 'check')).toThrow(
        'Language compatibility index drift: releases/native/language-compat.json, apps/cli/assets/language-compat.json',
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('the committed index is current', () => {
    expect(settleLanguageCompat(root, languageCompatOutputs(root), 'check')).toEqual([]);
  });
});
