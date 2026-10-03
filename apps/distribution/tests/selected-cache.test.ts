import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open } from '@inventarch/db';
import { canonicalDistributionJson as json, readInstalledGeneration, sha256 } from '@inventarch/db/distribution';
import { productStructure } from '../../../tools/release/product-structure.mjs';
import { buildArchive, verifyArchive } from '../src/archive.js';
import {
  applyInstallation,
  cacheArchive,
  cachePath,
  cacheSelectedArchiveClosure,
  cachedReleases,
  collectInstallationGarbage,
  planInstallation,
  recoverInstallation,
} from '../src/install.js';
import { resolveReleases } from '../src/resolve.js';
import { repository } from './snapshot-fixture.js';

const temporary = mkdtempSync(join(tmpdir(), 'ia-selected-cache-'));
let releases: ReturnType<typeof productStructure>,
  selected: ReturnType<typeof resolveReleases>,
  archives: Map<string, Uint8Array>,
  sequence = 0;
const fresh = () => {
  const root = join(temporary, `consumer-${sequence++}`);
  mkdirSync(root);
  return root;
};
function put(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
beforeAll(() => {
  releases = productStructure(repository);
  selected = resolveReleases(
    [{ id: releases.product.manifest.id, range: '0.1.0' }],
    [verifyArchive(releases.language.bytes), releases.product].map((release) => ({
      release,
      location: `sha256:${release.archiveDigest}`,
      withdrawn: false,
    })),
    '0.1.0',
  );
  archives = new Map([
    [releases.language.pin.archive, releases.language.bytes],
    [releases.product.archiveDigest, releases.product.bytes],
  ]);
});
afterAll(() => {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-selected-cache-'))
    throw Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it('physically caches, installs, reads and restores exact selected dependent archives offline', () => {
  const root = fresh();
  expect(() => cacheArchive(root, releases.product.bytes)).toThrow(/authoring/i);
  expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
  expect(cacheSelectedArchiveClosure(root, selected.lock, archives).size).toBe(2);
  expect(cacheSelectedArchiveClosure(root, selected.lock, archives).size).toBe(2);
  expect(cachedReleases(root, selected.lock).get(releases.product.manifest.id)?.archiveDigest).toBe(
    releases.product.archiveDigest,
  );
  const plan = planInstallation(root, selected.lock, 'install');
  expect(applyInstallation(plan)).toMatchObject({ status: 'installed', host: 'pending' });
  expect(readInstalledGeneration(root)?.lock).toEqual(selected.lock);
  const reader = open(root, { cache: false });
  try {
    expect(reader.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(reader.records().some((r) => r.name === 'product-system')).toBe(true);
  } finally {
    reader.close();
  }
  const relocated = fresh();
  cacheSelectedArchiveClosure(relocated, selected.lock, archives);
  put(relocated, '.ia/distributions.lock.json', json(selected.lock));
  expect(applyInstallation(planInstallation(relocated, selected.lock, 'restore')).generation).toBe(
    plan.pointer.generation,
  );
  expect(collectInstallationGarbage(root, true).archives).toEqual([]);
});

it('refuses incomplete, extra, substituted and skewed selections before any cache write', () => {
  const badMaps = [
    new Map([[releases.product.archiveDigest, releases.product.bytes]]),
    new Map([...archives, ['a'.repeat(64), releases.product.bytes]]),
    new Map([...archives, [releases.product.archiveDigest, releases.language.bytes]]),
  ];
  for (const input of badMaps) {
    const root = fresh();
    expect(() => cacheSelectedArchiveClosure(root, selected.lock, input)).toThrow();
    expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
  }
  const root = fresh(),
    lock = {
      ...selected.lock,
      packages: selected.lock.packages.map((pkg, index) => (index === 0 ? { ...pkg, manifest: 'a'.repeat(64) } : pkg)),
    };
  expect(() => cacheSelectedArchiveClosure(root, lock, archives)).toThrow();
  expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
});

it('preflights every existing cache collision and hardlink before publishing earlier members', () => {
  for (const alias of [false, true]) {
    const root = fresh(),
      path = cachePath(releases.product.archiveDigest);
    if (alias) {
      put(root, 'aliased', releases.product.bytes);
      mkdirSync(dirname(join(root, path)), { recursive: true });
      linkSync(join(root, 'aliased'), join(root, path));
    } else put(root, path, 'tampered');
    expect(() => cacheSelectedArchiveClosure(root, selected.lock, archives)).toThrow(/unaliased|differs/);
    expect(existsSync(join(root, cachePath(releases.language.pin.archive)))).toBe(false);
  }
});

it('refuses a canonically repacked substituted guide even when archive and manifest pins are updated', () => {
  const product = releases.product,
    path = [...product.files.keys()].find((path) => path.endsWith('schemas/product.SPEC.md'))!;
  const files = new Map(product.files),
    replacement = Buffer.from('Substituted guide\n');
  files.set(path, replacement);
  const manifest = {
    ...product.manifest,
    files: product.manifest.files.map((pin) =>
      pin.path === path ? { ...pin, bytes: replacement.length, sha256: sha256(replacement) } : pin,
    ),
  };
  const content = buildArchive(manifest, files),
    digest = sha256(content);
  const lock = {
    ...selected.lock,
    packages: selected.lock.packages.map((pkg) =>
      pkg.id === product.manifest.id
        ? { ...pkg, archive: digest, manifest: sha256(json(manifest)), location: `sha256:${digest}` }
        : pkg,
    ),
  };
  const root = fresh();
  expect(() =>
    cacheSelectedArchiveClosure(
      root,
      lock,
      new Map([
        [releases.language.pin.archive, releases.language.bytes],
        [digest, content],
      ]),
    ),
  ).toThrow(/authoring/i);
  expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
});

it('refuses changed cache bytes at installation time and retains unresolved orphan closures during GC', () => {
  const root = fresh();
  cacheSelectedArchiveClosure(root, selected.lock, archives);
  expect(() => collectInstallationGarbage(root, true)).toThrow(/authoring/i);
  for (const [digest, content] of archives)
    expect(readFileSync(join(root, cachePath(digest)))).toEqual(Buffer.from(content));
  const plan = planInstallation(root, selected.lock, 'install');
  put(root, cachePath(releases.product.archiveDigest), releases.language.bytes);
  expect(() => applyInstallation(plan)).toThrow();
  expect(existsSync(join(root, '.ia/distributions/active.json'))).toBe(false);
});

it('does not claim activation after interrupted staging or portable lock publication and recovers for retry', () => {
  for (const checkpoint of ['store:', 'portable-lock']) {
    const root = fresh();
    cacheSelectedArchiveClosure(root, selected.lock, archives);
    expect(() =>
      applyInstallation(planInstallation(root, selected.lock, 'install'), {
        checkpoint(name) {
          if (name.startsWith(checkpoint)) throw Error('owned interruption');
        },
      }),
    ).toThrow('owned interruption');
    expect(existsSync(join(root, '.ia/distributions/active.json'))).toBe(false);
    if (checkpoint === 'portable-lock') {
      expect(() => open(root)).toThrow(/recovery-required/);
      expect(recoverInstallation(root)).toEqual({ status: 'recovered', committed: false });
    }
    expect(applyInstallation(planInstallation(root, selected.lock, 'install')).status).toBe('installed');
    expect(readInstalledGeneration(root)?.lock).toEqual(selected.lock);
  }
});
