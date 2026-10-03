import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readInputs } from '@inventarch/db';
import { sha256 } from '@inventarch/db/distribution';
import { distributionSnapshot, packSnapshot } from '@inventarch/distribution/snapshot';
import { resolveReleases } from '@inventarch/distribution/resolve';

export function mintingFixture() {
  const root = resolve(import.meta.dirname, '../../..'),
    manifestPath = '.ia/authoring.resources.json';
  const native = readInputs(root),
    floor = native.sources.filter((source) => source.location.placement.kind === 'floor');
  const original = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as {
    files: { path: string; bytes: number; sha256: string; mediaType: string; encoding: string }[];
    associations: unknown[];
  };
  const originalAssets = new Map<string, Buffer>(
    original.files.map((file) => [file.path, readFileSync(resolve(root, file.path))]),
  );
  originalAssets.set('LICENSE', readFileSync(resolve(root, 'LICENSE')));
  const make = (kind: 'baseline' | 'missing' | 'guided' | 'ordinary' | 'legacy') => {
    const manifest = structuredClone(original),
      assets = new Map(originalAssets),
      sources = native.sources.map((source) => ({ ...source }));
    if (kind === 'missing' || kind === 'guided') {
      const system = sources.find((source) => source.path === '.ia/src/systems/authoring-system/system.ia')!;
      system.text = system.text.replace(
        '  discriminators',
        '  discriminators\n    criterion-note lowers to definition\n      category representation\n      facets [criterion-note]\n      schema @schema criterion-note',
      );
      const steward = sources.find((source) => source.path === '.ia/src/systems/authoring-system/system.ia')!;
      steward.text = steward.text.replace(
        'applies [authoring-guide, operation]',
        'applies [authoring-guide, operation, criterion-note]',
      );
      sources.push({
        path: '.ia/src/systems/authoring-system/schemas/criterion-note.schema.ia',
        text: '#! ia 1.0\n@schema criterion-note\n  lowers to definition\n  sections\n    open\n',
        location: system.location,
      });
      if (kind === 'guided') {
        const path = '.ia/src/systems/authoring-system/references/criterion-note.md',
          content = Buffer.from(
            '# Criterion note\nRecord an explicit review criterion. This fixture asserts mechanical lookup only.\n',
          );
        assets.set(path, content);
        manifest.files.push({
          path,
          bytes: content.length,
          sha256: sha256(content),
          mediaType: 'text/markdown',
          encoding: 'utf8',
        });
        const nativePath = '.ia/src/systems/authoring-system/records/criterion-note-guide.ia';
        sources.push({
          path: nativePath,
          location: system.location,
          text: `#! ia 1.0\n@authoring-guide criterion-note-guide\n  meaning\n    says "An explicit criterion note."\n    answers "What criterion should be reviewed?"\n  reference\n    owner authoring-system\n    word criterion-note\n    schema @schema criterion-note\n    document "${path}"\n  guidance\n    select-when "A review criterion needs an explicit note."\n    avoid-when "A new grant is needed."\n    consider "Identify the owning review."\n  relationships\n    cites @schema criterion-note\n`,
        });
        manifest.associations.push({
          owner: {
            source: 'self',
            path: nativePath,
            identity: 'authoring-system/definition/authoring-guide/criterion-note-guide',
          },
          resources: [{ key: { source: 'self', path }, role: 'guide', order: 0, required: true, delivery: 'inline' }],
        });
      }
    }
    if (kind === 'ordinary')
      sources.push({
        path: '.ia/src/systems/authoring-system/records/ordinary.ia',
        text: '#! ia 1.0\n# Ordinary authored content; no registration change.\n',
        location: sources.find((source) => source.location.placement.kind === 'authored')!.location,
      });
    if (kind === 'legacy') {
      sources.splice(
        sources.findIndex((source) => source.path === '.ia/src/systems/authoring-system/records/public-guides.ia'),
        1,
      );
      assets.clear();
      assets.set('LICENSE', readFileSync(resolve(root, 'LICENSE')));
    } else assets.set(manifestPath, Buffer.from(JSON.stringify(manifest)));
    const snapshot = distributionSnapshot({ sources, folders: native.folders, floorOrigin: native.floorOrigin });
    const descriptor = {
      formatVersion: 1,
      id: 'fixture/minting-foundation',
      version: kind === 'baseline' ? '1.0.0' : '1.1.0',
      distribution: 'workspace-system/definition/distribution/public-language',
      engine: '^0.1.0',
      language: ['1.0'],
      dependencies: [],
      assets: [...assets.keys()]
        .map((path) => ({
          path,
          role: path === 'LICENSE' ? 'license' : path === manifestPath ? 'asset' : 'documentation',
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      source: {
        repository: 'https://fixture.example/minting',
        commit: 'a'.repeat(64),
        recipe: 'ustar-v1',
        epoch: 1700000000,
      },
      license: 'MIT',
      description: 'Explicit production minting fixture',
    };
    const packed = packSnapshot(snapshot, descriptor, assets);
    const { lock } = resolveReleases(
      [{ id: packed.manifest.id, range: packed.manifest.version }],
      [{ release: packed, location: `sha256:${packed.archiveDigest}`, withdrawn: false }],
      '0.1.0',
    );
    return { packed, lock, archives: new Map([[packed.archiveDigest, packed.bytes]]), snapshot, descriptor, assets };
  };
  return { floor, make };
}
