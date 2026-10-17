import fs, {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PUBLICATION_CODES } from '../../packages/runtime/src/index.js';
import { runBounded } from '../testing/subprocess.js';
import { contents, publicationFixtureCodes, runPublicationFixtures } from './publication-fixtures.js';

const base64 = (text: string): string => Buffer.from(text).toString('base64');
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

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

it('records a link as null even where the open follows links, as it does on Windows', () => {
  // File links need a privilege on Windows, so the POSIX open is made to follow a final link as Windows opens one.
  if (process.platform === 'win32') return;
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    writeFileSync(resolve(root, 'file.txt'), 'file bytes');
    symlinkSync('file.txt', resolve(root, 'link'));
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

it('refuses an entry over 2147483647 bytes before allocating a buffer for it', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    // A sparse file: its size is 2147483648 bytes without that much being written.
    writeFileSync(resolve(root, 'big.bin'), '');
    truncateSync(resolve(root, 'big.bin'), 2147483648);
    // A buffer past the bound is never allocated here: the guard refuses first, and without it this spy refuses instead.
    const alloc = Buffer.alloc;
    vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      if (args[0] > 0x7fffffff) throw new Error('A buffer past 2147483647 bytes was allocated');
      return Reflect.apply(alloc, Buffer, args) as ReturnType<typeof Buffer.alloc>;
    });
    expect(() => contents(root)).toThrow(/^Publication fixture entry exceeds 2147483647 bytes: .*big\.bin$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('admits an entry of exactly 2147483647 bytes and reads at most that many bytes at a time', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-snapshot-'));
  try {
    // A sparse file of the most the read by name admitted.
    writeFileSync(resolve(root, 'edge.bin'), '');
    truncateSync(resolve(root, 'edge.bin'), 0x7fffffff);
    // Its buffer, one byte longer, is 2 ** 31 bytes. None is allocated here: a stand-in of that length is handed back and
    // the reads are recorded instead of made. The first returns no bytes, so the entry refuses as changed.
    const alloc = Buffer.alloc,
      allocated: number[] = [],
      asked: number[] = [];
    vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      if (args[0] <= 0x7fffffff) return Reflect.apply(alloc, Buffer, args) as ReturnType<typeof Buffer.alloc>;
      allocated.push(args[0]);
      const standIn = Reflect.apply(alloc, Buffer, [1]) as ReturnType<typeof Buffer.alloc>;
      return Object.defineProperty(standIn, 'length', { value: args[0] });
    });
    // Parameters<typeof fs.readSync> is the three-argument overload, so the mock takes its arguments untyped: it is called
    // as readSync(fd, buffer, offset, length, position), and only the length is recorded.
    vi.spyOn(fs, 'readSync').mockImplementation((...args: unknown[]) => {
      asked.push(args[3] as number);
      return 0;
    });
    syncBuiltinESMExports();
    expect(() => contents(root)).toThrow(/^Publication fixture entry changed while it was read: .*edge\.bin$/);
    // The guard let it through to its buffer, and the read asked for 2147483647 bytes, not 2147483648, which Node refuses.
    expect(allocated).toEqual([2147483648]);
    expect(asked).toEqual([0x7fffffff]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
