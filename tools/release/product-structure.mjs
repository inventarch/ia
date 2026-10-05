import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isEntry } from '../entry/is-entry.mjs';
import { distributionSnapshot, packSnapshotWithDependencies } from '../../apps/distribution/src/snapshot.ts';
import { verifyArchive } from '../../apps/distribution/src/archive.ts';
import { resolveReleases } from '../../apps/distribution/src/resolve.ts';
import { languagePackageInputs } from '../native/public-language.ts';
import { buildLanguageBase } from '../native/language-base.ts';
import { DISTRIBUTION_ENGINE_VERSION } from '../../packages/db/src/distribution/index.js';

export function productStructure(root) {
  const base = languagePackageInputs(root),
    language = buildLanguageBase(root);
  const directory = resolve(root, 'distributions/product-structure');
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
    );
  const native = files(resolve(directory, '.ia/src'))
    .filter((file) => file.endsWith('.ia'))
    .map((file) => ({
      path: relative(directory, file).replaceAll('\\', '/'),
      text: readFileSync(file, 'utf8'),
      location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    }));
  const own = '.ia/src/systems/product-system';
  // Reviewed release closure: research and arbitrary future Markdown are never shipped by glob.
  const selectedAssets = [
    'README.md',
    'SPEC.md',
    'consumer.mjs',
    'consumer.d.mts',
    `${own}/README.md`,
    `${own}/SPEC.md`,
    `${own}/schemas/product.SPEC.md`,
  ];
  const assets = new Map(selectedAssets.map((path) => [path, readFileSync(resolve(directory, path))]));
  for (const path of ['LICENSE', 'NOTICE']) assets.set(path, readFileSync(resolve(root, path)));
  const key = (path) => ({ source: 'self', path });
  const system = { ...key(`${own}/system.ia`), identity: 'floor/definition/system/product-system' };
  const resource = (path, role) => ({ key: key(path), role, order: 0, required: true, delivery: 'inline' });
  const selection = {
    format: 'ia.authoring-resources.v1',
    files: [...assets]
      .filter(([path]) => path.startsWith('.ia/'))
      .map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'text/markdown',
        encoding: 'utf8',
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    associations: [
      { owner: system, resources: [resource(`${own}/README.md`, 'guide'), resource(`${own}/SPEC.md`, 'support')] },
      {
        owner: {
          ...key(`${own}/guide.ia`),
          identity: 'authoring-system/definition/authoring-guide/product-system-product',
        },
        resources: [resource(`${own}/schemas/product.SPEC.md`, 'guide')],
      },
    ],
    index: {
      systems: [
        {
          system,
          authoring: [key(`${own}/README.md`)],
          architecture: [key(`${own}/SPEC.md`)],
          extensions: [],
          methods: [],
          steward: { ...key(`${own}/steward.ia`), identity: 'agent-system/binding/agent/product-steward' },
          base: null,
        },
      ],
      artifacts: [],
      profiles: [],
      documents: [],
      lifecycles: [],
    },
  };
  assets.set('.ia/authoring.resources.json', Buffer.from(JSON.stringify(selection)));
  const verified = verifyArchive(language.bytes);
  const descriptor = {
    formatVersion: 1,
    id: 'inventarch/product-structure',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/product-structure',
    engine: `^${DISTRIBUTION_ENGINE_VERSION}`,
    language: ['1.0'],
    dependencies: [{ id: verified.manifest.id, range: verified.manifest.version, systems: [...base.folders].sort() }],
    assets: [...assets.keys()].sort().map((path) => ({
      path,
      role: ['LICENSE', 'NOTICE'].includes(path) ? 'license' : path.endsWith('.md') ? 'documentation' : 'asset',
    })),
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    license: 'Apache-2.0',
    description: 'Explicitly selected public product structural vocabulary; no private methods or grants',
  };
  const selected = resolveReleases(
    [{ id: verified.manifest.id, range: verified.manifest.version }],
    [{ release: verified, location: `sha256:${verified.archiveDigest}`, withdrawn: false }],
    DISTRIBUTION_ENGINE_VERSION,
  );
  const product = packSnapshotWithDependencies(
    distributionSnapshot({
      sources: [...base.inputs, ...native],
      folders: [...base.folders, 'product-system'],
      floorOrigin: 'local',
    }),
    descriptor,
    assets,
    selected.lock,
    new Map([[verified.archiveDigest, language.bytes]]),
  );
  if (product.manifest.systems.length !== 1 || product.manifest.systems[0].name !== 'product-system')
    throw new Error('Product release widened its owned closure');
  return { language, product };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const output = resolve(process.argv[2]);
  mkdirSync(output, { recursive: false });
  const { language, product } = productStructure(root);
  writeFileSync(resolve(output, `${language.pin.archive}.ia.tgz`), language.bytes);
  writeFileSync(resolve(output, `${product.archiveDigest}.ia.tgz`), product.bytes);
  writeFileSync(
    resolve(output, 'product-artifacts.json'),
    JSON.stringify(
      {
        language: language.pin,
        product: {
          id: product.manifest.id,
          archive: product.archiveDigest,
          manifest: product.manifestDigest,
          source: product.manifest.source,
          systems: product.manifest.systems,
          dependencies: product.manifest.dependencies,
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ output, language: language.pin.archive, product: product.archiveDigest }));
}
