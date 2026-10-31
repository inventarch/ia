import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import { distributionSnapshot, packSnapshotWithDependencies } from '../../apps/distribution/src/snapshot.ts';
import { verifyArchive } from '../../apps/distribution/src/archive.ts';
import { resolveReleases } from '../../apps/distribution/src/resolve.ts';
import { contained, portable } from '../../apps/distribution/src/files.ts';
import { registryAddCollection } from '../../apps/distribution/src/registry-build.ts';
import { languagePackageInputs } from '../native/public-language.ts';
import { buildLanguageBase } from '../native/language-base.ts';
import {
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  RELEASE_ENGINE_VERSION,
} from '../../packages/db/src/distribution/index.js';

const sameFile = (before, after) =>
  after.isFile() &&
  after.nlink === 1n &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

/** Bind a checked selection to the descriptor read, then refuse changed input before admitting its bytes. */
function selectedBytes(directory, file, before) {
  const path = relative(directory, file).replaceAll('\\', '/');
  if (!before.isFile() || before.nlink !== 1n) throw new Error(`Expected unaliased distribution input: ${path}`);
  if (before.size > BigInt(DISTRIBUTION_LIMITS.file)) throw new Error(`Distribution input exceeds file limit: ${path}`);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error(`Distribution input changed: ${path}`);
    const content = Buffer.alloc(Number(before.size));
    let total = 0;
    while (total < content.length) {
      const count = readSync(fd, content, total, content.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (
      total !== content.length ||
      !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, lstatSync(file, { bigint: true }))
    )
      throw new Error(`Distribution input changed: ${path}`);
    contained(directory, path);
    return content;
  } finally {
    closeSync(fd);
  }
}

/** Caller-selected directory, owned systems, exact assets and descriptor. No globs select documentation or code. */
export function packOptionalDistribution(root, options) {
  const directory = contained(resolve(options.directory)),
    base = languagePackageInputs(root),
    language = buildLanguageBase(root);
  const systems = [...options.systems].sort();
  if (
    !systems.length ||
    new Set(systems).size !== systems.length ||
    systems.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))
  )
    throw new Error('Select one or more distinct owned system names');
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = contained(directory, relative(directory, resolve(dir, entry.name)).replaceAll('\\', '/'));
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n))
        throw new Error('Distribution source must be a regular file or directory');
      return stat.isDirectory() ? files(path) : [{ path, stat }];
    });
  const native = files(resolve(directory, '.ia/src'))
    .filter(({ path }) => path.endsWith('.ia'))
    .map(({ path: file, stat }) => ({
      path: relative(directory, file).replaceAll('\\', '/'),
      text: selectedBytes(directory, file, stat).toString('utf8'),
      location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    }));
  const assets =
    options.assets instanceof Map
      ? new Map(options.assets)
      : new Map(
          options.assets.map((path) => {
            portable(path);
            const file = contained(directory, path);
            const stat = lstatSync(file, { bigint: true });
            if (stat.nlink !== 1n) throw new Error('Hard-linked distribution asset');
            return [path, selectedBytes(directory, file, stat)];
          }),
        );
  const verified = verifyArchive(language.bytes);
  const descriptor = {
    ...options.descriptor,
    engine: options.descriptor.engine ?? `^${RELEASE_ENGINE_VERSION}`,
    language: ['1.0'],
    dependencies: [{ id: verified.manifest.id, range: verified.manifest.version, systems: [...base.folders].sort() }],
    assets: [...assets.keys()].sort().map((path) => ({
      path,
      role: ['LICENSE', 'NOTICE'].includes(path) ? 'license' : path.endsWith('.md') ? 'documentation' : 'asset',
    })),
  };
  const selected = resolveReleases(
    [{ id: verified.manifest.id, range: verified.manifest.version }],
    [{ release: verified, location: `sha256:${verified.archiveDigest}`, withdrawn: false }],
    DISTRIBUTION_ENGINE_VERSION,
  );
  const product = packSnapshotWithDependencies(
    distributionSnapshot({
      sources: [...base.inputs, ...native],
      folders: [...base.folders, ...systems],
      floorOrigin: 'local',
    }),
    descriptor,
    assets,
    selected.lock,
    new Map([[verified.archiveDigest, language.bytes]]),
  );
  if (JSON.stringify(product.manifest.systems.map((system) => system.name).sort()) !== JSON.stringify(systems))
    throw new Error('Distribution widened or omitted its selected owned systems');
  return { language, product };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    directory = resolve(process.argv[2]),
    output = resolve(process.argv[3]);
  const manifest = JSON.parse(readFileSync(contained(directory, '.ia/kit.json'), 'utf8'));
  const { language, product } = packOptionalDistribution(root, { ...manifest, directory });
  mkdirSync(output, { recursive: false });
  writeFileSync(resolve(output, `${language.pin.archive}.ia.tgz`), language.bytes);
  writeFileSync(resolve(output, `${product.archiveDigest}.ia.tgz`), product.bytes);
  if (manifest.kit) registryAddCollection(output, 'kit', manifest.kit);
  writeFileSync(
    resolve(output, 'distribution-artifacts.json'),
    JSON.stringify(
      {
        id: product.manifest.id,
        version: product.manifest.version,
        archive: product.archiveDigest,
        manifest: product.manifestDigest,
      },
      null,
      2,
    ) + '\n',
  );
}
