import fs, { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PUBLICATION_CODES } from '../../packages/runtime/src/index.js';
import { runBounded } from '../testing/subprocess.js';
import { contents, publicationFixtureCodes, runPublicationFixtures } from './publication-fixtures.js';

const base64 = (text: string): string => Buffer.from(text).toString('base64');
/** A denied Windows file-link fixture is an explicit skip; all other setup failures still fail the test. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

/** Writes a file and a directory holding a file in `root`, and returns the snapshot's entries for them. */
function regularEntries(root: string): [string, string | null][] {
  writeFileSync(resolve(root, 'file.txt'), 'file bytes');
  mkdirSync(resolve(root, 'dir'));
  writeFileSync(resolve(root, 'dir', 'inner.txt'), 'inner bytes');
  return [
    ['dir', null],
    [join('dir', 'inner.txt'), base64('inner bytes')],
    ['file.txt', base64('file bytes')],
  ];
}
it('snapshots each regular file by its bytes and every other entry, a link included, as null', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    const expected = regularEntries(root);
    expect(JSON.parse(contents(root))).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// File links need a privilege on Windows, which has no FIFOs either. Listing descends into a linked directory, whose
// files are regular files under a link, so they keep their bytes; only a link itself is null.
it.skipIf(process.platform === 'win32')(
  'snapshots a link, a dangling link, a linked directory and a FIFO as null, and the files under the linked directory by their bytes',
  async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
    try {
      const expected = regularEntries(root);
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
      expect(JSON.parse(contents(root))).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'throws what opening an unreadable file throws, as reading it by name did',
  () => {
    // Root reads a file whatever its mode; the gate has no skip condition for root, so the case returns early instead.
    if (process.getuid?.() === 0) return;
    const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
    try {
      writeFileSync(resolve(root, 'locked.txt'), 'locked');
      chmodSync(resolve(root, 'locked.txt'), 0o000);
      expect(() => contents(root)).toThrow(/^EACCES: permission denied, open '.*locked\.txt'$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

it('records a link as null even where the open follows links, as it does on Windows', (context) => {
  // The POSIX open is made to follow a final link as Windows opens one. Where Windows grants file links, it runs the
  // case itself.
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    writeFileSync(resolve(root, 'file.txt'), 'file bytes');
    if (!fileLink('file.txt', resolve(root, 'link')))
      return context.skip('Windows denied file symlink creation (EPERM)');
    const open = fs.openSync;
    const following = vi
      .spyOn(fs, 'openSync')
      .mockImplementation((path, flags, mode) =>
        open(path, typeof flags === 'number' ? flags & ~fs.constants.O_NOFOLLOW : flags, mode),
      );
    syncBuiltinESMExports();
    expect(JSON.parse(contents(root))).toEqual([
      ['file.txt', base64('file bytes')],
      ['link', null],
    ]);
    expect(following).toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses a snapshot entry that grows while it is read instead of recording the larger bytes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    const file = resolve(root, 'growing.txt');
    writeFileSync(file, 'first bytes');
    const read = fs.readSync;
    let grown = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!grown) {
        grown = true;
        appendFileSync(file, ' and more');
      }
      return Reflect.apply(read, fs, args) as number;
    });
    syncBuiltinESMExports();
    expect(() => contents(root)).toThrow(/^Publication fixture entry changed while it was read: .*growing\.txt$/);
    expect(grown).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
