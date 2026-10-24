import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CAPTURE_CURRENT, CAPTURE_FORMAT, open, planCapture, readInputs } from '../src/index.js';
import type { InputSnapshot } from '../src/index.js';
import { OPENED_READ_FLAGS, OPENS_THROUGH_LINKS } from '../src/named.js';
import { otherDevice, outcome, vanishAtRecheck } from './file-races.js';
import { put, workspace } from './workspace.js';

// The corpus source walk and the capture pair reader as a platform with no no-follow open flag runs them (Windows):
// node:fs here defines no O_NOFOLLOW, so the readers load with an open that follows a final link, and find a link put
// at a name after its check by the name's identity once they have read the file. Every other call passes through, as a
// mock a test can replace.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: Object.fromEntries(Object.entries(actual.constants).filter(([name]) => name !== 'O_NOFOLLOW')),
    openSync: vi.fn(actual.openSync),
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
afterEach(() => {
  vi.mocked(openSync).mockReset();
  vi.mocked(lstatSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(closeSync).mockClear();
});

const CORPUS = '.ia/src/a.ia';
const corpusRoot = (): string => {
  const root = workspace(false);
  put(root, CORPUS, '#! ia 1.0\n# a\n');
  return root;
};
const corpus = (root: string): unknown => outcome(() => readInputs(root));
const captureText = (letter: string): string =>
  `${JSON.stringify({ format: CAPTURE_FORMAT, revision: letter.repeat(64), membership: [] })}\n`;
const pairRoot = (): string => {
  const root = workspace(false);
  put(root, CAPTURE_CURRENT, captureText('a'));
  return root;
};
const planned = (root: string): unknown => outcome(() => planCapture(root, captureText('b')));
const seededCapture = (root: string): string | undefined => {
  const db = open(root, { cache: false });
  try {
    return db.capturedRevision;
  } finally {
    db.close();
  }
};
/**
 * Replaces the name `file` with a link of `type` to `target` as a reader opens it, after its own checks, and records the
 * descriptors the opens of `file` return.
 */
const linkedAtOpen = async (file: string, target: string, type?: 'dir' | 'junction'): Promise<readonly number[]> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs'),
    opened: number[] = [];
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    if (String(args[0]) === file && !actual.lstatSync(file).isSymbolicLink()) {
      actual.rmSync(file);
      actual.symlinkSync(target, file, type);
    }
    const fd = actual.openSync(...args);
    if (String(args[0]) === file) opened.push(fd);
    return fd;
  });
  return opened;
};
/** Reports another inode, the device unchanged, at every full-width lstat of `file`: the reader's check of the name. */
const otherInode = async (file: string): Promise<void> => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
    const stat = actual.lstatSync(...args);
    return String(args[0]) === file && typeof stat?.ino === 'bigint'
      ? Object.assign(stat, { ino: stat.ino + 1n })
      : stat;
  });
};

it('loads the readers with an open that follows a final link, and reads a name that keeps naming its file', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  expect(constants.O_NOFOLLOW).toBeUndefined();
  expect(OPENS_THROUGH_LINKS).toBe(true);
  expect(OPENED_READ_FLAGS & (actual.constants.O_NOFOLLOW ?? 0)).toBe(0);
  const root = corpusRoot();
  expect((corpus(root) as InputSnapshot).sources.find((source) => source.path === CORPUS)?.text).toBe(
    '#! ia 1.0\n# a\n',
  );
  expect(planned(pairRoot())).toMatchObject({ prior: 'a'.repeat(64), ignored: null });
  expect(seededCapture(pairRoot())).toBe('a'.repeat(64));
});
it.skipIf(process.platform === 'win32')(
  'refuses a corpus source a link replaces after it is listed, once it has read through it',
  async () => {
    const root = corpusRoot(),
      file = resolve(root, CORPUS);
    put(root, 'outside.ia', '#! ia 1.0\n# outside\n');
    const opened = await linkedAtOpen(file, resolve(root, 'outside.ia'));
    expect(corpus(root)).toMatchObject({
      code: 'IA-DB-PATH-UNSAFE',
      message: `IA-DB-PATH-UNSAFE: Source alias is not admitted: ${CORPUS}`,
    });
    // The open followed the link and read the file it names; the name's identity refused it, and the descriptor closed.
    expect(opened).toHaveLength(1);
    expect(readFileSync).toHaveBeenCalledWith(opened[0]);
    expect(closeSync).toHaveBeenCalledWith(opened[0]);
  },
);
it('refuses a corpus source or a capture a link to a directory replaces after its check, as the link it is', async () => {
  // A directory link or junction: Windows makes a junction without a privilege.
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  const root = corpusRoot(),
    file = resolve(root, CORPUS);
  put(root, 'elsewhere/b.ia', '#! ia 1.0\n');
  let opened = await linkedAtOpen(file, resolve(root, 'elsewhere'), kind);
  vi.mocked(closeSync).mockClear();
  // The open follows the link to the directory, which the opened descriptor alone would refuse as irregular.
  expect(corpus(root)).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    message: `IA-DB-PATH-UNSAFE: Source alias is not admitted: ${CORPUS}`,
  });
  expect(opened).toHaveLength(1);
  expect(closeSync).toHaveBeenCalledWith(opened[0]);
  const planning = pairRoot(),
    seeding = pairRoot(),
    capture = resolve(planning, CAPTURE_CURRENT);
  put(planning, 'elsewhere/x', '');
  put(seeding, 'elsewhere/x', '');
  opened = await linkedAtOpen(capture, resolve(planning, 'elsewhere'), kind);
  vi.mocked(closeSync).mockClear();
  expect(planned(planning)).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    message: `IA-DB-PATH-UNSAFE: Symlink/junction traversal is not admitted: ${capture}`,
    path: CAPTURE_CURRENT,
  });
  expect(opened).toHaveLength(1);
  expect(closeSync).toHaveBeenCalledWith(opened[0]);
  await linkedAtOpen(resolve(seeding, CAPTURE_CURRENT), resolve(seeding, 'elsewhere'), kind);
  expect(seededCapture(seeding)).toBeUndefined();
});
it('refuses a corpus source whose name names another file, nothing, or another device once it is read', async () => {
  const replaced = {
    code: 'IA-DB-SOURCE-CHANGED',
    message: `IA-DB-SOURCE-CHANGED: Source replaced during read: ${CORPUS}`,
  };
  const elsewhere = corpusRoot();
  await otherInode(resolve(elsewhere, CORPUS));
  expect(corpus(elsewhere)).toMatchObject(replaced);
  const gone = corpusRoot();
  await vanishAtRecheck(resolve(gone, CORPUS));
  expect(corpus(gone)).toMatchObject(replaced);
  const device = corpusRoot();
  await otherDevice(resolve(device, CORPUS));
  expect(corpus(device)).toMatchObject(replaced);
});
it.skipIf(process.platform === 'win32')(
  'refuses a capture a link replaces after it is checked, once it has read through it, and seeds nothing from it',
  async () => {
    const planning = pairRoot(),
      seeding = pairRoot(),
      file = resolve(planning, CAPTURE_CURRENT);
    put(planning, 'outside.json', captureText('c'));
    put(seeding, 'outside.json', captureText('c'));
    const opened = await linkedAtOpen(file, resolve(planning, 'outside.json'));
    expect(planned(planning)).toMatchObject({
      code: 'IA-DB-PATH-UNSAFE',
      message: `IA-DB-PATH-UNSAFE: Symlink/junction traversal is not admitted: ${file}`,
      path: CAPTURE_CURRENT,
    });
    expect(opened).toHaveLength(1);
    expect(readFileSync).toHaveBeenCalledWith(opened[0]);
    expect(closeSync).toHaveBeenCalledWith(opened[0]);
    // A capture at another revision behind the link would be trusted as written; a handle seeds nothing from it.
    await linkedAtOpen(resolve(seeding, CAPTURE_CURRENT), resolve(seeding, 'outside.json'));
    expect(seededCapture(seeding)).toBeUndefined();
  },
);
it('refuses a capture whose name names another file, nothing, or another device once it is read, and seeds nothing from it', async () => {
  const changed = {
    code: 'IA-DB-PATH-UNSAFE',
    message: `IA-DB-PATH-UNSAFE: ${CAPTURE_CURRENT} changed while it was read`,
    path: CAPTURE_CURRENT,
  };
  const elsewhere = pairRoot();
  await otherInode(resolve(elsewhere, CAPTURE_CURRENT));
  expect(planned(elsewhere)).toMatchObject(changed);
  expect(seededCapture(elsewhere)).toBeUndefined();
  const gone = pairRoot();
  await vanishAtRecheck(resolve(gone, CAPTURE_CURRENT));
  expect(planned(gone)).toMatchObject(changed);
  const device = pairRoot();
  await otherDevice(resolve(device, CAPTURE_CURRENT));
  expect(planned(device)).toMatchObject(changed);
});
