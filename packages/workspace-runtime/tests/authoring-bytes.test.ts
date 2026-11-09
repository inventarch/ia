import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { captureAuthoringManifest, captureAuthoringManifestBytes } from '../src/authoring-manifest.js';
import { createAuthoringIndex } from '../src/authoring.js';
import { authoringFixture } from './authoring-fixture.js';

function fixture() {
  const f = authoringFixture();
  const select = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(select);
    if (!input || typeof input !== 'object') return input;
    const value = input as Record<string, unknown>;
    if (typeof value['source'] === 'string' && value['revision'] && value['path'])
      return { source: 'self', path: value['path'], ...(value['identity'] ? { identity: value['identity'] } : {}) };
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, select(v)]));
  };
  const manifest = {
    format: 'ia.authoring-resources.v1',
    files: f.resources.files.map(({ key, content: _content, ...file }) => ({ ...file, path: key.path })),
    associations: select(f.resources.associations),
    index: select(f.input),
  };
  const source = {
    source: f.capture.id,
    revision: f.capture.revision,
    imports: [],
    manifest,
    files: f.resources.files.map((file) => ({ path: file.key.path, content: file.content })),
  };
  return { ...f, manifest, source };
}
it('produces identical pinned authoring data from retained bytes and explicit physical files', () => {
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), 'ia-authoring-bytes-'));
  try {
    const put = (path: string, text: string) => {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    for (const source of f.capture.sources.filter((s) => s.location.placement.kind !== 'floor'))
      put(source.path, source.text);
    for (const file of f.source.files) put(file.path, file.content);
    const expected = { resources: f.resources, index: createAuthoringIndex(f.capture, f.resources, f.input) };
    const retained = captureAuthoringManifestBytes(f.capture, { sources: [f.source] });
    const { files: _files, ...binding } = f.source;
    expect(retained).toEqual(expected);
    expect(captureAuthoringManifest(f.capture, { sources: [{ ...binding, root }] })).toEqual(retained);
    f.source.files[0]!.content = 'changed after capture';
    expect(retained).toEqual(expected);
  } finally {
    f.reader.close();
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('ia-authoring-bytes-'))
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses missing/extra/duplicate resources, forged content and accessor data before admitting retained authoring', () => {
  const f = fixture();
  try {
    const run = (source: unknown) => captureAuthoringManifestBytes(f.capture, { sources: [source] } as never);
    for (const files of [
      [],
      f.source.files.slice(1),
      [...f.source.files, { path: 'private.md', content: 'unselected' }],
      [...f.source.files, f.source.files[0]!],
      f.source.files.map((file, i) => (i ? file : { ...file, content: 'forged' })),
    ])
      expect(() => run({ ...f.source, files })).toThrow();
    expect(() => run({ ...f.source, revision: 'a'.repeat(64) })).toThrow();
    expect(() =>
      run({ ...f.source, imports: [{ alias: 'foreign', source: 'foreign', revision: 'a'.repeat(64) }] }),
    ).toThrow();
    let accessed = 0;
    const first = {
      path: f.source.files[0]!.path,
      get content() {
        accessed++;
        return f.source.files[0]!.content;
      },
    };
    expect(() => run({ ...f.source, files: [first, ...f.source.files.slice(1)] })).toThrow();
    expect(accessed).toBe(0);
    const indexed = [...f.source.files];
    Object.defineProperty(indexed, '0', {
      enumerable: true,
      get() {
        accessed++;
        return f.source.files[0];
      },
    });
    expect(() => run({ ...f.source, files: indexed })).toThrow();
    expect(accessed).toBe(0);
  } finally {
    f.reader.close();
  }
});
