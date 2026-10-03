import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { EditorSnapshot } from '@inventarch/db/editor';
import { adoptWorkspace, captureWorkspace } from '../src/corpus.js';
import { captureAuthoringManifest } from '../src/authoring-manifest.js';
import { resourceOccurrences } from '../src/resources.js';
import { authoringFixture } from './authoring-fixture.js';

it('refuses duplicate local/adopted system declarations instead of inventing a native override from base metadata', () => {
  const f = authoringFixture(),
    temporary = mkdtempSync(join(tmpdir(), 'ia-authoring-base-'));
  const root = join(temporary, 'local'),
    baseRoot = join(temporary, 'base');
  const put = (root: string, path: string, bytes: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  try {
    for (const source of f.capture.sources.filter((s) => s.location.placement.kind !== 'floor'))
      put(root, source.path, source.text);
    for (const source of f.capture.sources.filter((s) => s.path.includes('/authoring-system/')))
      put(baseRoot, source.path, source.text);
    for (const file of f.resources.files) put(root, file.key.path, file.content);
    const capture = captureWorkspace(root, 'fixture', { adopted: [adoptWorkspace(baseRoot, 'base')] });
    const inventory = resourceOccurrences(capture),
      imported = inventory.sourceRevisions.find((s) => s.source === 'base')!;
    const reader = new EditorSnapshot({
      root,
      sources: capture.sources,
      folders: capture.folders,
      floorOrigin: capture.floorOrigin,
      fingerprint: capture.revision,
    });
    const findings = reader.report.findings;
    reader.close();
    expect(findings.some((f) => f.code === 'IA-COMP-SYSTEM-MALFORMED')).toBe(true);
    expect(inventory.occurrences.find((o) => o.identity === f.system.identity)).toBeUndefined();
    expect(inventory.occurrences.some((o) => o.identity === f.system.identity && o.source === 'base')).toBe(false);
    const select = (o: { path: string; identity: string }) => ({ source: 'self', path: o.path, identity: o.identity });
    const key = { source: 'self', path: 'references/system.md' };
    const manifest = {
      format: 'ia.authoring-resources.v1',
      files: f.resources.files
        .filter((file) => file.key.path === key.path)
        .map(({ key: _key, content: _content, ...file }) => ({ ...file, path: key.path })),
      associations: [
        { owner: select(f.system), resources: [{ key, role: 'guide', required: true, order: 0, delivery: 'inline' }] },
      ],
      index: {
        systems: [
          {
            system: select(f.system),
            authoring: [key],
            architecture: [key],
            extensions: [],
            methods: [],
            steward: select(f.find('/head/fixture-steward')),
            base: { source: 'base', path: f.system.path, identity: f.system.identity },
          },
        ],
        artifacts: [],
        profiles: [],
        documents: [],
        lifecycles: [],
      },
    };
    expect(() =>
      captureAuthoringManifest(capture, {
        sources: [
          { source: capture.id, revision: capture.revision, root, imports: [{ alias: 'base', ...imported }], manifest },
        ],
      }),
    ).toThrow(/missing or ambiguous/);
  } finally {
    f.reader.close();
    if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-authoring-base-'))
      throw new Error('Unsafe fixture cleanup');
    rmSync(temporary, { recursive: true, force: true });
  }
});
