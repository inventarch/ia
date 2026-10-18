import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureWorkspace } from '@inventarch/workspace-runtime';
import {
  captureAuthoringManifest,
  openLocalAuthoringView,
  readAuthoringManifestFile,
} from '@inventarch/workspace-runtime/authoring-manifest';
import { resolveAuthoring } from '@inventarch/workspace-runtime/authoring';
import { teachingLinkClasses, teachingLinkFindings } from '../docs/teaching-links.mjs';

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
