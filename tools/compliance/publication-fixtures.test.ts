import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PUBLICATION_CODES } from '../../packages/runtime/src/index.js';
import { runBounded } from '../testing/subprocess.js';
import { contents, publicationFixtureCodes, runPublicationFixtures } from './publication-fixtures.js';

const base64 = (text: string): string => Buffer.from(text).toString('base64');

it('snapshots each regular file by its bytes and every other entry, a link included, as null', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    writeFileSync(resolve(root, 'file.txt'), 'file bytes');
    mkdirSync(resolve(root, 'dir'));
    writeFileSync(resolve(root, 'dir', 'inner.txt'), 'inner bytes');
    const expected: [string, string | null][] = [
      ['dir', null],
      [join('dir', 'inner.txt'), base64('inner bytes')],
      ['file.txt', base64('file bytes')],
    ];
    // File links need a privilege on Windows, which has no FIFOs either. Listing descends into a linked directory, whose
    // files are regular files under a link, so they keep their bytes; only a link itself is null.
    if (process.platform !== 'win32') {
      symlinkSync('file.txt', resolve(root, 'link'));
      symlinkSync('missing.txt', resolve(root, 'dangling'));
      symlinkSync('dir', resolve(root, 'dirlink'));
      expect((await runBounded('mkfifo', [resolve(root, 'fifo')], { timeoutMs: 10_000 })).status).toBe(0);
      expected.push(
        ['dangling', null],
        ['dirlink', null],
        [join('dirlink', 'inner.txt'), base64('inner bytes')],
        ['fifo', null],
        ['link', null],
      );
      expected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
    expect(JSON.parse(contents(root))).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('throws what opening an unreadable file throws, as reading it by name did', () => {
  // Root reads a file whatever its mode, and Windows has no such mode.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    writeFileSync(resolve(root, 'locked.txt'), 'locked');
    chmodSync(resolve(root, 'locked.txt'), 0o000);
    expect(() => contents(root)).toThrow(/^EACCES: permission denied, open '.*locked\.txt'$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const platform of ['linux', 'darwin'] as const)
  it(`observes unsupported local publication without claiming Windows effects on ${platform}`, () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      const results = runPublicationFixtures();
      expect(results.flatMap((result) => result.assessment.findings)).toEqual([]);
      expect(results.every((result) => result.assessment.outcome === 'pass')).toBe(true);
      expect(results.map((result) => result.assessment.scope)).toContain('publication/local-unavailable');
      expect(results.map((result) => result.assessment.scope)).toContain('publication/existing-unavailable');
      expect([...new Set(results.flatMap((result) => result.observedCodes))].sort()).toEqual([
        'IA-PUBLICATION-INVALID',
        'IA-PUBLICATION-PATH-UNSAFE',
        'IA-PUBLICATION-UNAVAILABLE',
      ]);
      expect(publicationFixtureCodes()).toEqual([
        'IA-PUBLICATION-INVALID',
        'IA-PUBLICATION-PATH-UNSAFE',
        'IA-PUBLICATION-UNAVAILABLE',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

it.skipIf(process.platform !== 'win32')(
  'observes every publication refusal through the actual qualified Windows primitive',
  () => {
    const results = runPublicationFixtures();
    expect(results.flatMap((result) => result.assessment.findings)).toEqual([]);
    expect(results.every((result) => result.assessment.outcome === 'pass')).toBe(true);
    expect(results.flatMap((result) => result.observedCodes).sort()).toEqual([...PUBLICATION_CODES].sort());
    expect(publicationFixtureCodes()).toEqual(PUBLICATION_CODES);
  },
);
