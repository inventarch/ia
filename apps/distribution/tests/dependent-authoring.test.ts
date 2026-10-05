import { beforeAll, expect, it } from 'vitest';
import { canonicalDistributionJson, sha256, type BundleManifest } from '@inventarch/db/distribution';
import { buildLanguageBase } from '../../../tools/native/language-base.js';
import { languagePackageInputs } from '../../../tools/native/public-language.js';
import { buildArchive, verifyArchive, verifySelectedArchiveClosure } from '../src/archive.js';
import {
  distributionSnapshot,
  packSnapshot,
  packSnapshotWithDependencies,
  type PackedDistribution,
} from '../src/snapshot.js';
import { planInstallationSnapshot } from '../src/installation-core.js';
import { resolveReleases } from '../src/resolve.js';
import { repository } from './snapshot-fixture.js';

const own = '.ia/src/systems/qualification-system';
const guidePath = `${own}/guide.ia`,
  metadataPath = '.ia/authoring.resources.json';
let base: ReturnType<typeof buildLanguageBase>, packed: PackedDistribution;
let source: ReturnType<typeof distributionSnapshot>, assets: Map<string, Buffer>, descriptor: unknown;
let dependency: ReturnType<typeof resolveReleases>;
beforeAll(() => {
  base = buildLanguageBase(repository);
  const language = verifyArchive(base.bytes),
    native = languagePackageInputs(repository);
  dependency = resolveReleases(
    [{ id: language.manifest.id, range: language.manifest.version }],
    [{ release: language, location: `sha256:${language.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  const files = new Map([
    [
      `${own}/system.ia`,
      `#! ia 1.0\n@system qualification-system\n  provider "fixture"\n  version "0.1.0"\n  describes "Independent structural guide fixture"\n  steward @agent qualification-steward\n  requires\n    - agent-system\n    - compliance-system\n    - workspace-system\n    - authoring-system\n  discriminators\n    qualification-note lowers to definition\n      category thing\n      facets [qualification-note]\n      schema @schema qualification-note\n  edges\n    cite * using *\n`,
    ],
    [
      `${own}/schema.ia`,
      `#! ia 1.0\n@schema qualification-note\n  lowers to definition\n  sections\n    must have meaning\n    closed\n  fields\n    must have meaning.says as text\n`,
    ],
    [
      `${own}/steward.ia`,
      `#! ia 1.0\n@agent qualification-steward\n  meaning\n    says "Owns the original fixture word"\n    answers "Who maintains the fixture?"\n  governance\n    applies [qualification-note]\n    requires "Keep fixture structural"\n`,
    ],
    [
      guidePath,
      `#! ia 1.0\n@authoring-guide qualification-note-guide\n  meaning\n    says "Original fixture authoring guide"\n    answers "How is this fixture authored?"\n  reference\n    owner qualification-system\n    word qualification-note\n    schema @schema qualification-note\n    document "guide.md"\n  guidance\n    select-when "Testing installed structural guide resolution"\n    avoid-when "Authoring production data"\n    consider "Keep the fixture independent"\n  relationships\n    cites @schema qualification-note\n`,
    ],
    [
      `${own}/release.ia`,
      `#! ia 1.0\n@workspace qualification-workspace\n  meaning\n    says "Fixture structural release"\n    answers "Which fixture system is selected?"\n  composition\n    systems [@system qualification-system]\n@distribution qualification-release\n  meaning\n    says "Separate structural fixture"\n    answers "What is installed?"\n  distribution\n    records [@workspace qualification-workspace]\n`,
    ],
  ]);
  source = distributionSnapshot({
    sources: [
      ...native.inputs,
      ...[...files].map(([path, text]) => ({
        path,
        text,
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      })),
    ],
    folders: [...native.folders, 'qualification-system'],
    floorOrigin: 'local',
  });
  const document = Buffer.from('# Original independent guide\n');
  assets = new Map([
    ['guide.md', document],
    [
      metadataPath,
      Buffer.from(
        JSON.stringify({
          format: 'ia.authoring-resources.v1',
          files: [
            {
              path: 'guide.md',
              bytes: document.length,
              sha256: sha256(document),
              mediaType: 'text/markdown',
              encoding: 'utf8',
            },
          ],
          associations: [
            {
              owner: {
                source: 'self',
                path: guidePath,
                identity: 'authoring-system/definition/authoring-guide/qualification-note-guide',
              },
              resources: [
                {
                  key: { source: 'self', path: 'guide.md' },
                  role: 'guide',
                  order: 0,
                  required: true,
                  delivery: 'inline',
                },
              ],
            },
          ],
          index: { systems: [], artifacts: [], profiles: [], documents: [], lifecycles: [] },
        }),
      ),
    ],
  ]);
  descriptor = {
    formatVersion: 1,
    id: 'fixture/qualified-structure',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/qualification-release',
    engine: '^0.1.0',
    language: ['1.0'],
    dependencies: [{ id: language.manifest.id, range: language.manifest.version, systems: [...native.folders].sort() }],
    assets: [
      { path: metadataPath, role: 'asset' },
      { path: 'guide.md', role: 'documentation' },
    ],
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    license: 'UNLICENSED',
    description: 'Original qualification fixture',
  };
  packed = packSnapshotWithDependencies(
    source,
    descriptor,
    assets,
    dependency.lock,
    new Map([[base.pin.archive, base.bytes]]),
  );
});

function selected(bytes = packed.bytes, manifest = packed.manifest) {
  const archive = sha256(bytes);
  const lock = {
    ...dependency.lock,
    requests: [{ id: manifest.id, range: manifest.version }],
    packages: [
      ...dependency.lock.packages,
      {
        id: manifest.id,
        version: manifest.version,
        archive,
        manifest: sha256(canonicalDistributionJson(manifest)),
        location: `sha256:${archive}`,
        dependencies: manifest.dependencies.map((row) => row.id),
      },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  return {
    lock,
    archives: new Map([
      [base.pin.archive, base.bytes],
      [archive, bytes],
    ]),
  };
}
function rewritten(path: string, content: Buffer) {
  const files = new Map(packed.files);
  files.set(path, content);
  const manifest: BundleManifest = {
    ...packed.manifest,
    files: packed.manifest.files.map((pin) =>
      pin.path === path ? { ...pin, bytes: content.length, sha256: sha256(content) } : pin,
    ),
  };
  return selected(buildArchive(manifest, files), manifest);
}

it('preserves standalone refusal while explicitly verifying and installing exact selected guide closure', () => {
  expect(() => verifyArchive(packed.bytes)).toThrow(/authoring/i);
  expect(() => packSnapshot(source, descriptor, assets)).toThrow(/authoring/i);
  const input = selected();
  expect(verifySelectedArchiveClosure(input.lock, input.archives).get(packed.manifest.id)?.archiveDigest).toBe(
    packed.archiveDigest,
  );
  const installed = planInstallationSnapshot({
    base: distributionSnapshot({
      sources: source.sources.filter((row) => row.location.placement.kind === 'floor'),
      folders: [],
      floorOrigin: 'local',
    }),
    current: null,
    ...input,
    operation: 'install',
  });
  expect(installed.inputs.systems.some((system) => system.name === 'qualification-system')).toBe(true);
  expect(() => verifyArchive(packed.bytes)).toThrow(/authoring/i); // no selected-closure cache pollution
});

it('refuses missing/skewed dependency and complete but substituted resource/owner metadata', () => {
  const valid = selected();
  expect(() => verifySelectedArchiveClosure(valid.lock, new Map([[packed.archiveDigest, packed.bytes]]))).toThrow();
  expect(() =>
    verifySelectedArchiveClosure(valid.lock, new Map([...valid.archives, ['f'.repeat(64), base.bytes]])),
  ).toThrow();
  expect(() =>
    verifySelectedArchiveClosure(
      {
        ...valid.lock,
        packages: valid.lock.packages.map((pkg) =>
          pkg.id === base.pin.id ? { ...pkg, manifest: '0'.repeat(64) } : pkg,
        ),
      },
      valid.archives,
    ),
  ).toThrow();
  expect(() =>
    verifySelectedArchiveClosure(
      {
        ...valid.lock,
        packages: valid.lock.packages.map((pkg) => (pkg.id === base.pin.id ? { ...pkg, version: '0.2.0' } : pkg)),
      },
      valid.archives,
    ),
  ).toThrow();
  for (const candidate of [
    rewritten('guide.md', Buffer.from('substituted')),
    rewritten(metadataPath, Buffer.from('{}')),
    rewritten(
      guidePath,
      Buffer.from(
        packed.files.get(guidePath)!.toString().replace('owner qualification-system', 'owner workspace-system'),
      ),
    ),
  ]) {
    expect(() => verifySelectedArchiveClosure(candidate.lock, candidate.archives)).toThrow(/authoring/i);
  }
  expect(verifySelectedArchiveClosure(valid.lock, valid.archives).size).toBe(2);
});

it('authenticates every selected byte and pin again after the same exact closure verified', () => {
  const valid = selected();
  expect(verifySelectedArchiveClosure(valid.lock, valid.archives).size).toBe(2);
  // The remembered structural join is keyed by the exact lock; substituted bytes under a pinned digest still refuse.
  expect(() =>
    verifySelectedArchiveClosure(
      valid.lock,
      new Map(
        [...valid.archives].map(([archive, bytes]) => [
          archive,
          archive === base.pin.archive ? Buffer.from('substituted') : bytes,
        ]),
      ),
    ),
  ).toThrow();
  expect(() =>
    verifySelectedArchiveClosure(
      valid.lock,
      new Map(
        [...valid.archives].map(([archive, bytes]) => [archive, archive === packed.archiveDigest ? base.bytes : bytes]),
      ),
    ),
  ).toThrow();
  expect(verifySelectedArchiveClosure(valid.lock, valid.archives).get(packed.manifest.id)?.archiveDigest).toBe(
    packed.archiveDigest,
  );
  expect(() => verifyArchive(packed.bytes)).toThrow(/authoring/i);
});

it('cannot borrow undeclared dependencies or external asset-owner aliases from another selected root', () => {
  const manifest = { ...packed.manifest, dependencies: [] };
  const unrelated = selected(buildArchive(manifest, packed.files), manifest);
  unrelated.lock.requests.push({ id: base.pin.id, range: base.pin.version });
  unrelated.lock.requests.sort((a, b) => (a.id < b.id ? -1 : 1));
  expect(() => verifySelectedArchiveClosure(unrelated.lock, unrelated.archives)).toThrow();
  const metadata = packed.files.get(metadataPath)!.toString();
  const outside = rewritten(metadataPath, Buffer.from(metadata.replaceAll('"source":"self"', '"source":"dependency"')));
  expect(() => verifySelectedArchiveClosure(outside.lock, outside.archives)).toThrow(/authoring/i);
});
