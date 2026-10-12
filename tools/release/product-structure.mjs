import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isEntry } from '../entry/is-entry.mjs';
import { DISTRIBUTION_ENGINE_VERSION } from '../../packages/db/src/distribution/index.js';

import { packOptionalDistribution } from './distribution.mjs';

export function productStructure(root) {
  const directory = resolve(root, 'distributions/product-structure');
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
  const descriptor = {
    formatVersion: 1,
    id: 'inventarch/product-structure',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/product-structure',
    engine: `^${DISTRIBUTION_ENGINE_VERSION}`,
    language: ['1.0'],
    assets: [...assets.keys()].sort().map((path) => ({
      path,
      role: ['LICENSE', 'NOTICE'].includes(path) ? 'license' : path.endsWith('.md') ? 'documentation' : 'asset',
    })),
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    license: 'Apache-2.0',
    description: 'Explicitly selected public product structural vocabulary; no private methods or grants',
  };
  return packOptionalDistribution(root, { directory, systems: ['product-system'], descriptor, assets });
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
