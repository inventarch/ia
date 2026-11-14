import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { verifyArchive } from '../../apps/distribution/src/archive.js';
import type { LanguageBase } from './language-base.js';
import { buildLanguageBase } from './language-base.js';
import {
  BASES_DIRECTORY,
  compareVersions,
  fetchBase,
  LEDGER_PATH,
  ledgerArchive,
  ledgerFindings,
  readBaseLedger,
  SEED,
} from './language-bases.js';

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

/** A gzip of a ustar archive holding `files` as regular members, as `npm pack` writes one. */
function tarball(files: Record<string, Uint8Array | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
/** The npm tarball of a CLI carrying `base` as its own base. */
const cliTarball = (base: LanguageBase): Buffer =>
  tarball({
    'package/assets/base.json': JSON.stringify(base.pin),
    [`package/assets/base/${base.pin.archive}.ia.tgz`]: base.bytes,
  });

describe('fetching a published base', () => {
  const SEEDED = '3.2.1';
  const SEEDED_ARCHIVE = 'ee6e65018df2ebef705913d9da1947f040edf44c2e7ade6c9750c6fa0185985e';
  /**
   * A copy of the ledger without the `SEEDED` row, the rows recorded after it and their archives, in a folder of its own:
   * a fetch appends, so the seeded version must follow the copy's last row.
   */
  function ledgerCopy(): string {
    const scratch = mkdtempSync(resolve(tmpdir(), 'ia-bases-fetch-test-'));
    cpSync(resolve(root, 'releases/native'), resolve(scratch, 'releases/native'), { recursive: true });
    const copy = JSON.parse(readFileSync(resolve(scratch, LEDGER_PATH), 'utf8')) as {
      bases: { version: string; archive: string }[];
    };
    const dropped = copy.bases.filter((base) => compareVersions(base.version, SEEDED) >= 0);
    copy.bases = copy.bases.filter((base) => compareVersions(base.version, SEEDED) < 0);
    writeFileSync(resolve(scratch, LEDGER_PATH), `${JSON.stringify(copy, null, 2)}\n`);
    expect(dropped.map((base) => base.archive)).toContain(SEEDED_ARCHIVE);
    for (const base of dropped) rmSync(resolve(scratch, BASES_DIRECTORY, `${base.archive}.ia.tgz`), { force: true });
    expect(readBaseLedger(scratch).bases.some((base) => base.version === SEEDED)).toBe(false);
    expect(ledgerFindings(scratch)).toEqual([]);
    return scratch;
  }
  const snapshot = (scratch: string) => ({
    ledger: readFileSync(resolve(scratch, LEDGER_PATH), 'utf8'),
    archives: readdirSync(resolve(scratch, BASES_DIRECTORY)).sort(),
  });

  it(`pins ${SEEDED} to the archive @inventarch/cli@3.7.0 carries`, () => {
    expect(SEED[SEEDED]).toEqual({ archive: SEEDED_ARCHIVE, source: '@inventarch/cli@3.7.0' });
  });

  it('refuses a tarball whose archive digest differs from the seed, and writes nothing', () => {
    const scratch = ledgerCopy();
    try {
      const before = snapshot(scratch);
      // A self-consistent 3.2.1 archive that verifies on its own, but is not the one the seed pins.
      const other = buildLanguageBase(root, { version: SEEDED, engine: '>=0.0.1' });
      expect(other.pin.archive).not.toBe(SEEDED_ARCHIVE);
      expect(verifyArchive(other.bytes, other.pin.archive).manifest.version).toBe(SEEDED);
      expect(() => fetchBase(scratch, SEEDED, '@inventarch/cli@3.7.0', () => cliTarball(other))).toThrow(
        SEEDED_ARCHIVE,
      );
      // A tarball naming the seeded digest over other bytes is refused too.
      const swapped = tarball({
        'package/assets/base.json': JSON.stringify({ ...other.pin, archive: SEEDED_ARCHIVE }),
        [`package/assets/base/${SEEDED_ARCHIVE}.ia.tgz`]: other.bytes,
      });
      expect(() => fetchBase(scratch, SEEDED, '@inventarch/cli@3.7.0', () => swapped)).toThrow(
        `does not hash to ${SEEDED_ARCHIVE}`,
      );
      expect(snapshot(scratch)).toEqual(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('records a seeded version from the seeded bytes, under the seed source', (context) => {
    const built = buildLanguageBase(root, { version: SEEDED });
    // While this tree builds the published 3.2.1 base, its bytes are the seeded archive.
    if (built.pin.archive !== SEEDED_ARCHIVE)
      context.skip(`this tree no longer builds the published ${SEEDED} base (${built.pin.archive})`);
    const scratch = ledgerCopy();
    try {
      const entry = fetchBase(scratch, SEEDED, '@inventarch/cli@9.9.9', () => cliTarball(built));
      expect(entry).toEqual({
        version: SEEDED,
        archive: SEEDED_ARCHIVE,
        manifest: built.pin.manifest,
        source: '@inventarch/cli@3.7.0',
      });
      expect(ledgerFindings(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
