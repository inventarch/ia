import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stableSerialize } from '@ia/graph';
import { open, readInputs } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { put, workspace } from './workspace.js';

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
