import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stableSerialize } from '@inventarch/graph';
import { adoptedBindings, open, readInputs, sourceTree } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import {
  blockingOpens,
  descriptors,
  directoryBecomesFile,
  fifo,
  otherDevice,
  outcome,
  shrinkWhileRead,
  socket,
  vanishAtRecheck,
} from './file-races.js';
import { put, workspace } from './workspace.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
  };
});
afterEach(() => {
  vi.mocked(closeSync).mockReset();
  vi.mocked(lstatSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(readSync).mockReset();
});

const path = 'vendor/foundation',
  source = '.ia/src/example.ia';
function binding(root: string) {
  const sources = readInputs(resolve(root, path), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  return { id: 'foundation', path, revision: createHash('sha256').update(stableSerialize(sources)).digest('hex') };
}
function fixture() {
  const root = workspace(false);
  put(root, `${path}/${source}`, '#! ia 1.0\n# pinned source\n');
  const entry = binding(root);
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [entry] }));
  return { root, entry };
}
it('shares declared foundation admission between disk and editor without copied definitions', () => {
  const root = workspace(false);
  cpSync(resolve(import.meta.dirname, '../../../.ia/src'), resolve(root, path, '.ia/src'), {
    recursive: true,
    filter: (p) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(p),
  });
  const author = '.ia/src/systems/agent-system/records/example-reader.ia';
  put(
    root,
    author,
    '#! ia 1.0\n@agent example-reader\n  meaning\n    says "Review the service corpus."\n    answers "Who helps here?"\n  governance\n    applies []\n',
  );
  const before = open(root, { cache: false });
  expect(before.report.findings.some((f) => f.code === 'IA-LANG-DISCRIMINATOR-UNREGISTERED')).toBe(true);
  before.close();
  const entry = binding(root);
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [entry] }));
  const disk = open(root, { cache: false }),
    editor = new EditorDatabase(root);
  try {
    expect(disk.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(editor.current.records()).toEqual(disk.records());
    expect(disk.records().find((r) => r.name === 'example-reader')?.source.path).toBe(author);
    expect(
      editor.current.sources
        .filter((s) => s.origin === 'adopted')
        .every((s) => !s.writable && s.location.placement.band === 90),
    ).toBe(true);
    expect(editor.current.sources.filter((s) => s.location.placement.kind === 'floor')).toHaveLength(17);
    expect(existsSync(resolve(root, '.ia/src/systems/agent-system/system.ia'))).toBe(false);
  } finally {
    disk.close();
    editor.close();
  }
});
it('refuses changed dependencies, retains the old view, then retires it after an explicit repin', () => {
  const { root } = fixture(),
    editor = new EditorDatabase(root),
    previous = editor.current,
    revision = editor.savedRevision;
  put(root, `${path}/${source}`, '#! ia 1.0\n# changed dependency\n');
  expect(() => editor.update([], true)).toThrow('Pinned source revision differs');
  expect(editor.current).toBe(previous);
  expect(editor.savedRevision).toBe(revision);
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [binding(root)] }));
  editor.update([], true);
  expect(editor.savedRevision).not.toBe(revision);
  expect(() => previous.records()).toThrow('IA-DB-CLOSED');
  editor.close();
});
it('gives explicit host captures precedence and does not recursively load mounted manifests', () => {
  const { root } = fixture();
  put(root, `${path}/.ia/workspace.json`, 'not JSON');
  expect(readInputs(root).sources.some((s) => s.path.startsWith('.ia/adopted/foundation/'))).toBe(true);
  put(root, '.ia/workspace.json', 'not JSON');
  expect(() => readInputs(root)).toThrow('Expected UTF-8 JSON');
  expect(readInputs(root, { adopted: [] }).sources.every((s) => s.location.placement.kind === 'floor')).toBe(true);
});
it.each([
  '../outside',
  '/outside',
  'C:/outside',
  '.',
  'vendor/../foundation',
  'vendor\\foundation',
  '.ia',
  '.ia/src',
  'vendor/CON',
  'vendor/trailing.',
  'vendor/trailing ',
  'vendor/e\u0301',
])('refuses an unsafe bound source directory: %s', (unsafe) => {
  const { root, entry } = fixture();
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [{ ...entry, path: unsafe }] }));
  expect(() => readInputs(root)).toThrow();
});
it('refuses manifest and bound-root aliases without following them', () => {
  const { root, entry } = fixture(),
    outside = workspace(false);
  symlinkSync(resolve(root, path), resolve(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [{ ...entry, path: 'alias' }] }));
  expect(() => readInputs(root)).toThrow('Symlink/junction');
  symlinkSync(resolve(root, '.ia'), resolve(outside, '.ia'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => readInputs(outside)).toThrow('Symlink/junction');
});
it('refuses unknown fields, duplicate bindings, invalid revisions and missing trees', () => {
  const { root, entry } = fixture();
  for (const manifest of [
    { version: 2, adopted: [] },
    { version: 1, adopted: [], writableSystems: ['agent-system'] },
    { version: 1, adopted: [{ ...entry, execute: 'script.js' }] },
    { version: 1, adopted: [entry, { ...entry, id: 'second' }] },
    { version: 1, adopted: [entry, { ...entry, path: 'other' }] },
    { version: 1, adopted: [{ ...entry, revision: 'not-a-digest' }] },
    { version: 1, adopted: [{ ...entry, path: 'missing' }] },
  ]) {
    put(root, '.ia/workspace.json', JSON.stringify(manifest));
    expect(() => readInputs(root)).toThrow();
  }
  put(root, '.ia/workspace.json', ' '.repeat(65_537));
  expect(() => readInputs(root)).toThrow('64 KiB');
  put(root, '.ia/workspace.json', new Uint8Array([0xc3, 0x28]));
  expect(() => readInputs(root)).toThrow('UTF-8 JSON');
  const directory = workspace(false);
  mkdirSync(resolve(directory, '.ia/workspace.json'), { recursive: true });
  expect(() => readInputs(directory)).toThrow('regular manifest');
});
it('refuses with the first faulty binding, its read-time fault included, before a later binding is validated', () => {
  // The order 1.x discovery refused in, which the frozen Door routes and `ia scope` report: binding 1 is read before
  // binding 2 is validated, so binding 1's link, pin or missing tree answers before binding 2's syntax fault.
  const { root, entry } = fixture();
  symlinkSync(resolve(root, path), resolve(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const cases: readonly (readonly [readonly unknown[], string, string])[] = [
    [[{ ...entry, path: 'alias' }, entry], 'IA-DB-PATH-UNSAFE', 'Symlink/junction traversal is not admitted'],
    [
      [
        { ...entry, revision: 'f'.repeat(64) },
        { ...entry, id: 'BAD', path: 'other' },
      ],
      'IA-DB-SOURCE-UNAVAILABLE',
      '.ia/workspace.json: Pinned source revision differs for foundation',
    ],
    [
      [{ ...entry, path: 'missing' }, entry],
      'IA-DB-SOURCE-UNAVAILABLE',
      '.ia/workspace.json: Missing source tree for foundation',
    ],
  ];
  for (const [adopted, code, message] of cases) {
    put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted }));
    expect(() => readInputs(root), message).toThrow(expect.objectContaining({ code }));
    expect(() => readInputs(root), message).toThrow(message);
  }
  // adoptedBindings validates every binding and reads none, so the later syntax fault is the one it reports.
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [{ ...entry, path: 'missing' }, entry] }));
  expect(() => adoptedBindings(root)).toThrow('Duplicate source identity or directory');
});
it('names each binding with the tree label its sources carry, and refuses a manifest as discovery does', () => {
  const { root, entry } = fixture();
  const bindings = adoptedBindings(root),
    tree = `.ia/adopted/foundation/${entry.revision}`;
  expect(bindings).toEqual([{ ...entry, tree }]);
  expect(Object.isFrozen(bindings) && Object.isFrozen(bindings[0])).toBe(true);
  // The label is the tree D02a reads for each of the mount's sources, and no directory lives under it.
  const adopted = readInputs(root).sources.filter((s) => s.path.startsWith('.ia/adopted/'));
  expect(adopted.map((s) => s.path)).toEqual([`${tree}/${source}`]);
  expect(adopted.map((s) => sourceTree(s.path))).toEqual([tree]);
  expect(existsSync(resolve(root, '.ia/adopted'))).toBe(false);
  expect([sourceTree(source), sourceTree('packages/a/.ia/src/x.ia'), sourceTree('README.md')]).toEqual([
    '',
    'packages/a',
    '',
  ]);
  // The bound sources are neither read nor verified: a changed source keeps its binding, which discovery refuses.
  put(root, `${path}/${source}`, '#! ia 1.0\n# changed dependency\n');
  expect(adoptedBindings(root)).toEqual(bindings);
  expect(() => readInputs(root)).toThrow('Pinned source revision differs');
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [{ ...entry, revision: 'not-a-digest' }] }));
  expect(() => adoptedBindings(root)).toThrow(expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE' }));
  put(root, '.ia/workspace.json', JSON.stringify({ version: 1, adopted: [{ ...entry, path: '../outside' }] }));
  expect(() => adoptedBindings(root)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
  expect(adoptedBindings(workspace(false))).toEqual([]);
  expect(() => adoptedBindings(resolve(root, 'absent'))).toThrow(
    expect.objectContaining({ code: 'IA-DB-ROOT-INVALID' }),
  );
});

// The manifest reader: `.ia/workspace.json` as `adoptedBindings` and discovery read it.
const MANIFEST = '.ia/workspace.json',
  LINK = process.platform === 'win32' ? 'junction' : 'dir';
/** A manifest refusal with its exact message. */
const refused = (message: string) => ({
  code: 'IA-DB-SOURCE-UNAVAILABLE',
  message: `IA-DB-SOURCE-UNAVAILABLE: ${MANIFEST}: ${message}`,
});
const irregular = refused('Expected a regular manifest of at most 64 KiB'),
  undecodable = refused('Expected UTF-8 JSON');
/** The bindings read that reads no byte: a refusal judged on the opened manifest, before its read. */
const unread = (root: string): unknown => {
  vi.mocked(readSync).mockClear();
  const result = outcome(() => adoptedBindings(root));
  expect(readSync).not.toHaveBeenCalled();
  return result;
};
it('reads the manifest as a regular file of at most 64 KiB whatever its link count, a missing one as none, and refuses links', () => {
  expect(outcome(() => adoptedBindings(workspace(false)))).toEqual([]);
  // A second name does not alias the manifest.
  const { root, entry } = fixture();
  linkSync(resolve(root, MANIFEST), resolve(root, 'second.json'));
  expect(outcome(() => adoptedBindings(root))).toEqual([
    { ...entry, tree: `.ia/adopted/foundation/${entry.revision}` },
  ]);
  // At the bound it is read; one byte past it, or a directory, is refused.
  const sized = workspace(false),
    text = JSON.stringify({ version: 1, adopted: [] });
  put(sized, MANIFEST, text.padEnd(65_536, ' '));
  expect(outcome(() => adoptedBindings(sized))).toEqual([]);
  put(sized, MANIFEST, text.padEnd(65_537, ' '));
  expect(unread(sized)).toMatchObject(irregular);
  expect(outcome(() => readInputs(sized))).toMatchObject(irregular);
  const directory = workspace(false);
  mkdirSync(resolve(directory, MANIFEST), { recursive: true });
  expect(unread(directory)).toMatchObject(irregular);
  expect(outcome(() => readInputs(directory))).toMatchObject(irregular);
  // Bytes that are not UTF-8, or not JSON.
  put(sized, MANIFEST, new Uint8Array([0xc3, 0x28]));
  expect(outcome(() => adoptedBindings(sized))).toMatchObject(undecodable);
  put(sized, MANIFEST, 'not JSON');
  expect(outcome(() => adoptedBindings(sized))).toMatchObject(undecodable);
  expect(outcome(() => readInputs(sized))).toMatchObject(undecodable);
  // A link at the name, or on the way to it, is refused by name and never followed.
  const leaf = workspace(false);
  mkdirSync(resolve(leaf, 'elsewhere'));
  mkdirSync(resolve(leaf, '.ia'));
  symlinkSync(resolve(leaf, 'elsewhere'), resolve(leaf, MANIFEST), LINK);
  expect(outcome(() => adoptedBindings(leaf))).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    path: MANIFEST,
    message: `IA-DB-PATH-UNSAFE: Symlink/junction traversal is not admitted: ${join(realpathSync(leaf), '.ia', 'workspace.json')}`,
  });
  const way = workspace(false);
  put(way, 'elsewhere/workspace.json', text);
  symlinkSync(resolve(way, 'elsewhere'), resolve(way, '.ia'), LINK);
  expect(outcome(() => adoptedBindings(way))).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    path: '.ia',
    message: `IA-DB-PATH-UNSAFE: Symlink/junction traversal is not admitted: ${join(realpathSync(way), '.ia')}`,
  });
});
it.skipIf(process.platform === 'win32')(
  'refuses a FIFO or a socket as the manifest without waiting for a writer',
  async () => {
    const root = workspace(false),
      manifest = resolve(root, MANIFEST),
      blocking = await blockingOpens();
    await fifo(manifest);
    expect(unread(root)).toMatchObject(irregular);
    expect(outcome(() => readInputs(root))).toMatchObject(irregular);
    rmSync(manifest);
    await socket(root, manifest);
    expect(unread(root)).toMatchObject(irregular);
    expect(blocking).toEqual([]);
  },
);
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'refuses an unreadable manifest as undecodable, unless it is past its bound',
  () => {
    const root = workspace(false),
      manifest = resolve(root, MANIFEST);
    put(root, MANIFEST, JSON.stringify({ version: 1, adopted: [] }));
    chmodSync(manifest, 0o000);
    expect(outcome(() => adoptedBindings(root))).toMatchObject(undecodable);
    const large = workspace(false),
      oversized = resolve(large, MANIFEST);
    put(large, MANIFEST, ' '.repeat(65_537));
    chmodSync(oversized, 0o000);
    expect(outcome(() => adoptedBindings(large))).toMatchObject(irregular);
  },
);
it('reads at most one byte past a manifest that grows while it is read, and refuses it as irregular', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const root = workspace(false),
    text = JSON.stringify({ version: 1, adopted: [] });
  put(root, MANIFEST, text);
  let read = 0,
    calls = 0;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = actual.readSync(...args);
    read += count;
    if (++calls === 1) appendFileSync(resolve(root, MANIFEST), ' '.repeat(1_000));
    return count;
  });
  expect(outcome(() => adoptedBindings(root))).toMatchObject(irregular);
  expect(read).toBe(text.length + 1);
});
it('refuses a manifest that shrinks while it is read, before or after its bytes are read', async () => {
  // A trailing space, so the bytes left after the cut are the same JSON.
  const text = `${JSON.stringify({ version: 1, adopted: [] })} `;
  const short = workspace(false);
  put(short, MANIFEST, text);
  await shrinkWhileRead(resolve(short, MANIFEST), 'before');
  expect(outcome(() => adoptedBindings(short))).toMatchObject(irregular);
  const cut = workspace(false);
  put(cut, MANIFEST, text);
  await shrinkWhileRead(resolve(cut, MANIFEST), 'after');
  expect(outcome(() => adoptedBindings(cut))).toMatchObject(irregular);
});
it('refuses a manifest that cannot be read once it is opened as undecodable', () => {
  const root = workspace(false);
  put(root, MANIFEST, JSON.stringify({ version: 1, adopted: [] }));
  vi.mocked(readSync).mockImplementation(() => {
    throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
  });
  expect(outcome(() => adoptedBindings(root))).toMatchObject(undecodable);
});
it.skipIf(process.platform === 'win32')(
  'refuses a manifest a link replaces after its path is checked, reading nothing through the link',
  async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = workspace(false),
      manifest = resolve(root, MANIFEST),
      text = JSON.stringify({ version: 1, adopted: [] });
    put(root, MANIFEST, text);
    put(root, 'outside.json', text);
    vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
      if (String(args[0]) === manifest) {
        actual.rmSync(manifest);
        actual.symlinkSync(resolve(root, 'outside.json'), manifest);
      }
      return actual.openSync(...args);
    });
    expect(unread(root)).toMatchObject(irregular);
  },
);
it('refuses a manifest whose name moves to another file while it is read', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const root = workspace(false),
    manifest = resolve(root, MANIFEST),
    text = JSON.stringify({ version: 1, adopted: [] });
  put(root, MANIFEST, text);
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    const fd = actual.openSync(...args);
    if (String(args[0]) === manifest) {
      actual.renameSync(manifest, resolve(root, 'original.json'));
      actual.writeFileSync(manifest, text);
    }
    return fd;
  });
  expect(outcome(() => adoptedBindings(root))).toMatchObject(irregular);
});
it.skipIf(process.platform === 'win32')(
  'refuses a manifest whose directory becomes a file while it is read, as irregular',
  async () => {
    const root = workspace(false);
    put(root, MANIFEST, JSON.stringify({ version: 1, adopted: [] }));
    await directoryBecomesFile(resolve(root, '.ia'));
    expect(outcome(() => adoptedBindings(root))).toMatchObject(irregular);
  },
);
const pinOf = (sources: readonly { path: string; text: string }[]): string =>
  createHash('sha256').update(stableSerialize(sources)).digest('hex');
it('refuses a floor source in an explicit host capture', () => {
  const sources = [{ path: '.ia/src/floor/override.ia', text: '#! ia 1.0\n' }],
    adopted = [{ id: 'host', revision: pinOf(sources), sources }];
  expect(outcome(() => readInputs(workspace(false), { adopted }))).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    message: 'IA-DB-PATH-UNSAFE: Unsafe adopted source path/bytes',
  });
});
it('takes an explicit host capture only at the revision of its exact bytes', () => {
  const root = workspace(false),
    sources = [{ path: source, text: '#! ia 1.0\n' }],
    revision = pinOf(sources);
  expect(readInputs(root, { adopted: [{ id: 'host', revision, sources }] }).sources.map((s) => s.path)).toContain(
    `.ia/adopted/host/${revision}/${source}`,
  );
  expect(
    outcome(() => readInputs(root, { adopted: [{ id: 'host', revision: '0'.repeat(64), sources }] })),
  ).toMatchObject({
    code: 'IA-DB-SOURCE-CHANGED',
    message: 'IA-DB-SOURCE-CHANGED: Adopted source revision does not match exact bytes',
  });
});
it('takes 16 bindings in a manifest and refuses a seventeenth', () => {
  const root = workspace(false),
    entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `b${index}`,
        path: `vendor/b${index}`,
        revision: 'a'.repeat(64),
      }));
  put(root, MANIFEST, JSON.stringify({ version: 1, adopted: entries(16) }));
  expect(adoptedBindings(root)).toHaveLength(16);
  put(root, MANIFEST, JSON.stringify({ version: 1, adopted: entries(17) }));
  expect(outcome(() => adoptedBindings(root))).toMatchObject(
    refused('Expected version 1 and at most 16 adopted bindings'),
  );
});
it('refuses an adopted binding of a tree inside .ia, though it holds the pinned bytes', () => {
  const { root, entry } = fixture(),
    tree = `.ia/open/foundation/${entry.revision}`;
  put(root, `${tree}/${source}`, '#! ia 1.0\n# pinned source\n');
  put(root, MANIFEST, JSON.stringify({ version: 1, adopted: [{ ...entry, path: tree }] }));
  expect(outcome(() => readInputs(root))).toMatchObject(
    refused('Source roots must be canonical workspace-relative directories outside .ia'),
  );
});
/** A workspace with one open binding at its exact `.ia/open/<id>/<revision>` tree, `extra` merged into the entry. */
function openFixture(extra: Record<string, unknown> = {}) {
  const { root, entry } = fixture(),
    tree = `.ia/open/${entry.id}/${entry.revision}`;
  put(root, `${tree}/${source}`, '#! ia 1.0\n# pinned source\n');
  put(root, MANIFEST, JSON.stringify({ version: 1, open: [{ ...entry, path: tree, ...extra }] }));
  return { root, entry, tree };
}
it('refuses an open binding outside its exact .ia/open/<id>/<revision> tree, though it holds the pinned bytes', () => {
  const { root, entry } = fixture();
  put(root, MANIFEST, JSON.stringify({ version: 1, open: [entry] }));
  expect(outcome(() => readInputs(root))).toMatchObject(
    refused('Open sources must use their exact .ia/open/<id>/<revision> tree'),
  );
});
it('places an open binding at open band 50 with its declared reach', () => {
  const { root, tree } = openFixture({ reach: 'area' });
  expect(readInputs(root).sources.find((s) => s.path === `${tree}/${source}`)?.location).toEqual({
    placement: { kind: 'open', band: 50, reach: 'area' },
    provenance: 'methodology',
  });
});
it('refuses an open binding whose reach is not canonical', () => {
  const { root } = openFixture({ reach: './area' });
  expect(outcome(() => readInputs(root))).toMatchObject(refused('Invalid open source reach'));
});
it('names an open binding with its placement, its reach and its tree on disk', () => {
  const { root, entry, tree } = openFixture({ reach: 'area' });
  expect(adoptedBindings(root)).toEqual([{ ...entry, path: tree, placement: 'open', reach: 'area', tree }]);
});
it('refuses a manifest whose name names nothing, or another device, after the read', async () => {
  const text = JSON.stringify({ version: 1, adopted: [] });
  const gone = workspace(false);
  put(gone, MANIFEST, text);
  await vanishAtRecheck(resolve(gone, MANIFEST));
  expect(outcome(() => adoptedBindings(gone))).toMatchObject(irregular);
  const elsewhere = workspace(false);
  put(elsewhere, MANIFEST, text);
  await otherDevice(resolve(elsewhere, MANIFEST));
  expect(outcome(() => adoptedBindings(elsewhere))).toMatchObject(irregular);
});
it('closes the manifest it opens, when it reads it and when it refuses it', async () => {
  const root = workspace(false),
    manifest = resolve(root, MANIFEST);
  put(root, MANIFEST, JSON.stringify({ version: 1, adopted: [] }));
  const opened = await descriptors(manifest);
  vi.mocked(closeSync).mockClear();
  expect(outcome(() => adoptedBindings(root))).toEqual([]);
  expect(closeSync).toHaveBeenCalledWith(opened.at(-1));
  put(root, MANIFEST, ' '.repeat(65_537));
  vi.mocked(closeSync).mockClear();
  expect(outcome(() => adoptedBindings(root))).toMatchObject(irregular);
  expect(closeSync).toHaveBeenCalledWith(opened.at(-1));
  expect(opened).toHaveLength(2);
});
