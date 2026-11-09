import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import { buildLanguageBase } from './language-base.js';
import { ledgerArchive, ledgerFindings, readBaseLedger } from './language-bases.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ledger = readBaseLedger(root);

const compare = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!;
};

describe('language base ledger', () => {
  it('verifies every ledger archive against its digest and manifest', () => {
    expect(ledger.bases.length).toBeGreaterThanOrEqual(5);
    for (const base of ledger.bases) {
      const verified = verifyArchive(ledgerArchive(root, base), base.archive);
      expect(verified.manifest.id).toBe('inventarch/language');
      expect(verified.manifest.version).toBe(base.version);
      expect(verified.manifestDigest).toBe(base.manifest);
    }
    expect(ledgerFindings(root)).toEqual([]);
  });

  it('orders the ledger ascending within one major', () => {
    expect(ledger.format).toBe('ia.language-bases.v1');
    expect(ledger.id).toBe('inventarch/language');
    expect(ledger.major).toBe(3);
    const versions = ledger.bases.map((b) => b.version);
    expect(versions[0]).toBe('3.0.0');
    for (const v of versions) expect(v.startsWith('3.')).toBe(true);
    for (let i = 1; i < versions.length; i++) expect(compare(versions[i - 1]!, versions[i]!)).toBeLessThan(0);
  });

  it('reports a tampered archive', () => {
    const scratch = mkdtempSync(resolve(tmpdir(), 'ia-bases-tamper-'));
    try {
      cpSync(resolve(root, 'releases/native'), resolve(scratch, 'releases/native'), { recursive: true });
      const target = ledger.bases[0]!;
      const file = resolve(scratch, 'releases/native/bases', `${target.archive}.ia.tgz`);
      const bytes = readFileSync(file);
      bytes[bytes.length >> 1]! ^= 0xff;
      writeFileSync(file, bytes);
      const findings = ledgerFindings(scratch);
      expect(findings.some((f) => f.includes(target.archive))).toBe(true);
      expect(() => ledgerArchive(scratch, target)).toThrow(target.archive);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('ends with the base the repository builds, or the build is newer and unreleased', () => {
    const built = buildLanguageBase(root).pin;
    const last = ledger.bases[ledger.bases.length - 1]!;
    if (built.version === last.version) {
      expect(built.archive).toBe(last.archive);
      expect(built.manifest).toBe(last.manifest);
    } else expect(compare(last.version, built.version)).toBeLessThan(0);
  });

  it('holds exactly the archives the ledger names', () => {
    const names = readdirSync(resolve(root, 'releases/native/bases')).sort();
    expect(names).toEqual(ledger.bases.map((b) => `${b.archive}.ia.tgz`).sort());
  });
});
