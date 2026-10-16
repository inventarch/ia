import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureWorkspace } from '@inventarch/workspace-runtime';
import {
  captureAuthoringManifest,
  openLocalAuthoringView,
  readAuthoringManifestFile,
} from '@inventarch/workspace-runtime/authoring-manifest';
import { resolveAuthoring } from '@inventarch/workspace-runtime/authoring';
import { runBounded } from '../testing/subprocess.js';
import { authoringResources } from './generate-authoring.js';
import { teachingLinkClasses, teachingLinkFindings } from './teaching-links.js';

const temporary: string[] = [];
it('refuses a guide dependency omitted from the installed resource closure', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-authoring-manifest-'));
  temporary.push(root);
  mkdirSync(resolve(root, '.ia/src/systems/example'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/systems/example/SPEC.md'), '# Support\n');
  const guide = { path: '.ia/src/systems/example/README.md', text: '# Guide\n\n[Support](SPEC.md)\n' };
  expect(teachingLinkFindings(root, [guide], new Set()).join('\n')).toContain('outside installed teaching closure');
  expect(
    teachingLinkFindings(root, [guide, { path: '.ia/src/systems/example/SPEC.md', text: '# Support\n' }], new Set()),
  ).toEqual([]);
});
it('checks installed teaching anchors and treats external references as external', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-authoring-manifest-'));
  temporary.push(root);
  mkdirSync(resolve(root, '.ia/src/systems/example'), { recursive: true });
  writeFileSync(resolve(root, '.ia/src/systems/example/SPEC.md'), '# Support\n\n## Case convention\n');
  const spec = { path: '.ia/src/systems/example/SPEC.md', text: '# Support\n\n## Case convention\n' };
  const guide = (text: string) => ({ path: '.ia/src/systems/example/README.md', text });
  expect(teachingLinkFindings(root, [guide('[Rule](SPEC.md#case-convention)'), spec], new Set())).toEqual([]);
  expect(teachingLinkFindings(root, [guide('[Rule](SPEC.md#removed-section)'), spec], new Set()).join('\n')).toContain(
    'section missing from its installed teaching target',
  );
  expect(teachingLinkFindings(root, [guide('[External](https://example.com/spec)'), spec], new Set())).toEqual([]);
  expect(
    teachingLinkClasses([guide('[Rule](SPEC.md) [External](https://example.com/spec) [Anchor](#section)')]),
  ).toEqual({ required: 1, external: 1 });
});
const temp = (): string => {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-authoring-manifest-'));
  temporary.push(path);
  return path;
};
const emptyIndex = () => ({ systems: [], artifacts: [], profiles: [], documents: [], lifecycles: [] });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = temp();
  mkdirSync(resolve(root, '.ia'), { recursive: true });
  const path = '.ia/src/floor/taxonomy.system.ia';
  const capture = captureWorkspace(root, 'fixture');
  const content = '# Selected notes reference\n',
    resource = 'notes.md';
  writeFileSync(resolve(root, resource), content);
  const manifest = {
    format: 'ia.authoring-resources.v1',
    files: [
      {
        path: resource,
        bytes: Buffer.byteLength(content),
        sha256: sha(content),
        mediaType: 'text/markdown',
        encoding: 'utf8',
      },
    ],
    associations: [
      {
        owner: { source: 'self', path, identity: 'floor/definition/system/taxonomy' },
        resources: [
          { key: { source: 'self', path: resource }, role: 'guide', order: 0, required: true, delivery: 'inline' },
        ],
      },
    ],
    index: emptyIndex(),
  };
  return {
    root,
    capture,
    manifest,
    content,
    request: { sources: [{ source: capture.id, revision: capture.revision, root, imports: [], manifest }] },
  };
}
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const child = relative(tmpdir(), root);
    if (isAbsolute(child) || !child.startsWith('ia-authoring-manifest-') || child.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it('captures only explicit pinned bytes and derives the actual source-qualified occurrence', () => {
  const { root, capture, request, content } = fixture();
  writeFileSync(resolve(root, 'private.md'), 'Never selected');
  const result = captureAuthoringManifest(capture, request);
  expect(result.resources.files).toHaveLength(1);
  expect(result.resources.files[0]?.content).toBe(content);
  expect(result.resources.associations[0]?.owner).toMatchObject({
    source: capture.id,
    revision: capture.revision,
    line: 3,
  });
  expect(result.index).toMatchObject({
    nativeCaptureRevision: capture.revision,
    resourceDigest: result.resources.digest,
  });
});

it('refuses unknown selectors, native line forgery, stale bytes and source bindings before delivery', () => {
  const { root, capture, manifest, request } = fixture();
  for (const owner of [
    { ...manifest.associations[0]!.owner, source: 'unbound' },
    { ...manifest.associations[0]!.owner, line: 2 },
    { ...manifest.associations[0]!.owner, identity: 'floor/definition/system/missing' },
  ]) {
    const changed = { ...manifest, associations: [{ ...manifest.associations[0]!, owner }] };
    expect(() =>
      captureAuthoringManifest(capture, { sources: [{ ...request.sources[0]!, manifest: changed }] }),
    ).toThrow();
  }
  expect(() =>
    captureAuthoringManifest(capture, { sources: [{ ...request.sources[0]!, revision: 'a'.repeat(64) }] }),
  ).toThrow();
  expect(() =>
    captureAuthoringManifest(capture, {
      sources: [
        { ...request.sources[0]!, imports: [{ alias: 'floor', source: capture.id, revision: 'a'.repeat(64) }] },
      ],
    }),
  ).toThrow();
  let accessed = false;
  const invalidManifest = {
    ...manifest,
    index: {
      ...manifest.index,
      get artifacts() {
        accessed = true;
        return [];
      },
    },
  };
  expect(() =>
    captureAuthoringManifest(capture, { sources: [{ ...request.sources[0]!, manifest: invalidManifest }] }),
  ).toThrow();
  expect(accessed).toBe(false);
  writeFileSync(resolve(root, 'notes.md'), '# changed');
  expect(() => captureAuthoringManifest(capture, request)).toThrow();
});

it('loads only bounded regular manifest data and rejects duplicate keys and filesystem aliases', () => {
  const { root, manifest } = fixture(),
    path = resolve(root, '.ia/authoring.resources.json');
  writeFileSync(path, JSON.stringify(manifest));
  expect(readAuthoringManifestFile(root)).toEqual(manifest);
  writeFileSync(path, '{"format":"one","format":"two"}');
  expect(() => readAuthoringManifestFile(root)).toThrow();
  writeFileSync(path, ' '.repeat(2 * 1024 * 1024 + 1));
  expect(() => readAuthoringManifestFile(root)).toThrow();
  const outside = temp(),
    alias = resolve(outside, 'alias');
  symlinkSync(root, alias, 'junction');
  expect(() => readAuthoringManifestFile(alias)).toThrow();
  expect(readFileSync(resolve(root, 'notes.md'), 'utf8')).toBe('# Selected notes reference\n');
});

it('keeps adopted guide resources separate from the host kernel and resolves the same scoped authoring library', () => {
  const root = temp(),
    foundation = resolve(import.meta.dirname, '../..');
  const local = openLocalAuthoringView({
    root,
    id: 'project',
    adopted: [{ id: 'foundation', root: foundation }],
    manifests: [{ source: 'foundation', root: foundation }],
    scope: { root: '', identities: null },
  });
  try {
    const view = resolveAuthoring(local.capture, local.resources, local.index, {
      reader: local.reader,
      within: local.within,
      allowedResources: local.resources.files.map((f) => f.key),
      allowedSystems: local.systems,
      allowedRegistrations: local.registrations,
      allowedArtifacts: local.index.artifacts.map((a) => a.id),
      allowedDocuments: local.index.documents.map((d) => d.id),
    });
    const axis = view.guides.find((g) => g.word === 'axis');
    expect(axis).toMatchObject({
      status: 'resolved',
      schema: { source: 'project' },
      descriptor: { source: 'foundation' },
      document: { key: { source: 'foundation', path: '.ia/src/systems/authoring-system/reference/axis.md' } },
    });
    expect(view.catalogue.complete).toBe(true);
    expect(view.guides.filter((g) => g.status !== 'resolved')).toEqual([]);
    local.assertCurrent();
  } finally {
    local.close();
  }
});

/** A root whose explicit authoring library selects each key of `files`, written with its content unless that is undefined. */
function library(files: Record<string, string | Buffer | undefined>): string {
  const root = temp();
  mkdirSync(resolve(root, '.ia/src/systems/authoring-system'), { recursive: true });
  writeFileSync(
    resolve(root, '.ia/src/systems/authoring-system/library.json'),
    JSON.stringify({
      format: 'ia.authoring-library.v1',
      files: Object.keys(files).map((path) => ({ path })),
      associations: [],
      index: emptyIndex(),
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    if (content !== undefined) writeFileSync(resolve(root, path), content);
  }
  return root;
}
const mebibyte = 'x'.repeat(1024 * 1024);
const unbounded = /^Unbounded or aliased authoring file$/;

it('generates resources from each selected authoring file up to one mebibyte and refuses a byte more', () => {
  const root = library({ '.ia/src/guide/README.md': '# Guide\n', '.ia/src/guide/large.md': mebibyte });
  const { output, files, total } = authoringResources(root);
  expect([files, total]).toEqual([2, 8 + mebibyte.length]);
  expect(JSON.parse(output).files).toEqual([
    {
      path: '.ia/src/guide/README.md',
      bytes: 8,
      sha256: sha('# Guide\n'),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    },
    {
      path: '.ia/src/guide/large.md',
      bytes: mebibyte.length,
      sha256: sha(mebibyte),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    },
  ]);
  writeFileSync(resolve(root, '.ia/src/guide/large.md'), mebibyte + 'x');
  expect(() => authoringResources(root)).toThrow(unbounded);
});

it('admits sixteen mebibytes of selected authoring files in all and refuses a byte more', () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 16; index++) files[`.ia/src/guide/part-${String(index).padStart(2, '0')}.md`] = mebibyte;
  expect(authoringResources(library(files)).total).toBe(16 * mebibyte.length);
  expect(() => authoringResources(library({ ...files, '.ia/src/guide/tail.md': 'x' }))).toThrow(unbounded);
});

it('refuses a directory, hard-linked, missing, undecodable, FIFO, linked or unreadable selection as before', async () => {
  const directory = library({ '.ia/src/guide/folder.md': undefined });
  mkdirSync(resolve(directory, '.ia/src/guide/folder.md'));
  expect(() => authoringResources(directory)).toThrow(unbounded);
  const shared = library({ '.ia/src/guide/README.md': '# Guide\n' });
  linkSync(resolve(shared, '.ia/src/guide/README.md'), resolve(shared, 'other.md'));
  expect(() => authoringResources(shared)).toThrow(unbounded);
  expect(() => authoringResources(library({ '.ia/src/guide/missing.md': undefined }))).toThrow(
    /^ENOENT: no such file or directory, lstat /,
  );
  expect(() => authoringResources(library({ '.ia/src/guide/bytes.md': Buffer.from([0xff, 0xfe]) }))).toThrow(TypeError);
  // Windows has no FIFOs, file links need a privilege there, and root reads a file whatever its mode.
  if (process.platform === 'win32') return;
  const fifo = library({ '.ia/src/guide/fifo.md': undefined });
  expect((await runBounded('mkfifo', [resolve(fifo, '.ia/src/guide/fifo.md')], { timeoutMs: 10_000 })).status).toBe(0);
  expect(() => authoringResources(fifo)).toThrow(unbounded);
  const linked = library({ '.ia/src/guide/README.md': '# Guide\n', '.ia/src/guide/link.md': undefined });
  symlinkSync('README.md', resolve(linked, '.ia/src/guide/link.md'));
  expect(() => authoringResources(linked)).toThrow(/^Authoring selection crosses an alias$/);
  if (process.getuid?.() === 0) return;
  const locked = library({ '.ia/src/guide/README.md': '# Guide\n' });
  chmodSync(resolve(locked, '.ia/src/guide/README.md'), 0o000);
  expect(() => authoringResources(locked)).toThrow(/^EACCES: permission denied, open /);
});
