import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  existsSync,
  linkSync,
  lstatSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalDistributionJson, sha256 } from '@inventarch/db/distribution';
import type { BundleManifest } from '@inventarch/db/distribution';
import { productStructure } from '../../../tools/release/product-structure.mjs';
import { buildArchive, inspectArchiveMetadata, verifyArchive } from '../src/archive.js';
import { applyInstallation, cachedReleases, planInstallation } from '../src/install.js';
import { runNative } from '../src/native-command.js';
import { registryAdd, registryWithdraw } from '../src/registry-build.js';
import { registryChooser } from '../src/registry-config.js';
import { registryWithdrawals, resolveFromRegistries } from '../src/registry-resolve.js';
import { cachedCandidates, planRestore } from '../src/services.js';
import { resolveReleases } from '../src/resolve.js';
import { repository } from './snapshot-fixture.js';
import { serveDirectory } from './registry-fixture.js';

/** A denied Windows file-link fixture is an explicit skip; all other setup failures still fail the test. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

const temporary = mkdtempSync(join(tmpdir(), 'ia-registry-selected-'));
let releases: ReturnType<typeof publish>[],
  sequence = 0;
const fresh = () => {
  const root = join(temporary, `consumer-${sequence++}`);
  mkdirSync(root);
  return root;
};
function put(root: string, file: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
function publish(manifest: BundleManifest, files: ReadonlyMap<string, Uint8Array>) {
  const bytes = buildArchive(manifest, files);
  return {
    manifest,
    files,
    bytes,
    archiveDigest: sha256(bytes),
    manifestDigest: sha256(canonicalDistributionJson(manifest)),
  };
}
function registry(selected = releases) {
  const dir = fresh();
  put(dir, 'ia-registry.json', JSON.stringify({ format: 'ia.registry.v1', name: 'Selected fixture' }));
  for (const release of selected) {
    const { manifest, archiveDigest: archive, manifestDigest: digest } = release;
    put(dir, `artifacts/${archive}.ia.tgz`, release.bytes);
    put(
      dir,
      `packages/${manifest.id}.json`,
      JSON.stringify({
        format: 'ia.registry-package.v1',
        id: manifest.id,
        releases: [
          {
            version: manifest.version,
            archive,
            manifest: digest,
            engine: manifest.engine,
            language: manifest.language,
            dependencies: manifest.dependencies.map(({ id, range }) => ({ id, range })),
            withdrawn: false,
            access: 'public',
            artifact: `artifacts/${archive}.ia.tgz`,
          },
        ],
      }),
    );
  }
  return dir;
}
const requests = [{ id: 'inventarch/product-structure', range: '0.1.0' }];
const choose = (root: string, flag: string) => registryChooser({ root, env: {}, flag, cwd: root });
beforeAll(() => {
  const packed = productStructure(repository);
  releases = [verifyArchive(packed.language.bytes), packed.product].map((release) =>
    publish(
      {
        ...release.manifest,
        source: { ...release.manifest.source, repository: 'https://fixture.example/selected', commit: 'a'.repeat(40) },
      },
      release.files,
    ),
  );
}, 30_000);
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-registry-selected-'))
    throw Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it.each(['directory', 'https'] as const)(
  'admits selected dependent guides through %s and reuses exact cached pins offline',
  async (transport) => {
    const root = fresh(),
      dir = registry(),
      base = transport === 'https' ? 'https://registry.test/base/' : dir;
    if (transport === 'https') serveDirectory(dir, base);
    expect(() => verifyArchive(releases[1]!.bytes)).toThrow(/authoring/i);
    expect('files' in inspectArchiveMetadata(releases[1]!.bytes).pending).toBe(false);
    const result = await resolveFromRegistries({ root, requests, engine: '0.1.0', choose: choose(root, base) });
    const { lock } = resolveReleases(requests, result.candidates, '0.1.0');
    expect(cachedReleases(root, lock).size).toBe(2);
    expect(applyInstallation(planInstallation(root, lock, 'install')).status).toBe('installed');
    const offline = await resolveFromRegistries({
      root,
      requests,
      engine: '0.1.0',
      previous: lock,
      named: [],
      choose: () => {
        throw Error('Offline pins must not contact a registry');
      },
    });
    expect(resolveReleases(requests, offline.candidates, '0.1.0').lock).toEqual(lock);
    const file = join(dir, 'packages/inventarch/product-structure.json'),
      index = JSON.parse(readFileSync(file, 'utf8'));
    index.releases[0].withdrawn = true;
    writeFileSync(file, JSON.stringify(index));
    expect(await registryWithdrawals(root, lock, choose(root, base))).toEqual(['inventarch/product-structure@0.1.0']);
  },
);

it('refuses late corrupt bytes and index skew before caching earlier selected members', async () => {
  for (const mode of ['bytes', 'index']) {
    const root = fresh(),
      dir = registry();
    if (mode === 'bytes') put(dir, `artifacts/${releases[1]!.archiveDigest}.ia.tgz`, 'corrupt');
    else {
      const file = join(dir, 'packages/inventarch/product-structure.json'),
        index = JSON.parse(readFileSync(file, 'utf8'));
      index.releases[0].manifest = 'f'.repeat(64);
      writeFileSync(file, JSON.stringify(index));
    }
    await expect(
      resolveFromRegistries({ root, requests, engine: '0.1.0', choose: choose(root, dir) }),
    ).rejects.toThrow();
    expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
  }
});

it('refuses an unrelated selected root supplying an undeclared guide dependency', async () => {
  const product = releases[1]!,
    unbound = publish({ ...product.manifest, dependencies: [] }, product.files);
  const dir = registry([releases[0]!, unbound]),
    root = fresh();
  await expect(
    resolveFromRegistries({
      root,
      requests: [...requests, { id: releases[0]!.manifest.id, range: releases[0]!.manifest.version }],
      engine: '0.1.0',
      choose: choose(root, dir),
    }),
  ).rejects.toThrow();
  expect(existsSync(join(root, '.ia/distributions/cache'))).toBe(false);
});

it('plans dependent offline cache selection and remote locked restore through actual selected admission', async () => {
  const source = fresh(),
    dir = registry(),
    base = 'https://registry.test/base/';
  serveDirectory(dir, base);
  const result = await resolveFromRegistries({ root: source, requests, engine: '0.1.0', choose: choose(source, base) });
  const { lock } = resolveReleases(requests, result.candidates, '0.1.0');
  const offline = resolveReleases(
    requests,
    cachedCandidates({ root: source, reach: requests.map((row) => row.id) }),
    '0.1.0',
  );
  expect(offline.lock.packages.map((row) => row.archive)).toEqual(lock.packages.map((row) => row.archive));
  expect(applyInstallation(planInstallation(source, offline.lock, 'install')).status).toBe('installed');
  const restored = fresh();
  const plan = await planRestore({ root: restored, lock, withdrawn: [] });
  expect(applyInstallation(plan.plan).status).toBe('installed');
  expect(cachedReleases(restored, lock).size).toBe(2);
  const refused = fresh();
  put(dir, `artifacts/${releases[1]!.archiveDigest}.ia.tgz`, 'corrupt');
  await expect(planRestore({ root: refused, lock, withdrawn: [] })).rejects.toThrow();
  expect(existsSync(join(refused, '.ia/distributions/cache'))).toBe(false);
});

it('publishes a dependent archive only after its exact public dependencies are available', async () => {
  const dir = fresh(),
    inputs = fresh(),
    target = releases[1]!;
  const candidates = releases.map((release) => ({
    release,
    location: `sha256:${release.archiveDigest}`,
    withdrawn: false,
  }));
  const { lock } = resolveReleases(requests, candidates, '0.1.0');
  const selection = { lock, archives: new Map(releases.map((release) => [release.archiveDigest, release.bytes])) };
  const targetPath = join(inputs, 'product.ia.tgz'),
    canonicalPath = join(inputs, 'language.ia.tgz');
  writeFileSync(targetPath, target.bytes);
  writeFileSync(canonicalPath, releases[0]!.bytes);
  expect(() => registryAdd({ dir, archive: targetPath })).toThrow(/authoring/i);
  expect(() => registryAdd({ dir, archive: targetPath, selection })).toThrow(/dependency/i);
  expect(existsSync(join(dir, 'ia-registry.json'))).toBe(false);
  registryAdd({ dir, archive: canonicalPath });
  expect(registryAdd({ dir, archive: targetPath, selection })).toMatchObject({
    id: target.manifest.id,
    archive: target.archiveDigest,
  });
  const consumer = fresh(),
    resolved = await resolveFromRegistries({
      root: consumer,
      requests,
      engine: '0.1.0',
      choose: choose(consumer, dir),
    });
  expect(resolveReleases(requests, resolved.candidates, '0.1.0').lock.packages).toHaveLength(2);
  expect(registryAdd({ dir, archive: targetPath, selection }).archive).toBe(target.archiveDigest);
});

it('refuses withdrawn, missing, changed or skewed registry dependency before publishing a target', () => {
  const target = releases[1]!,
    { lock } = resolveReleases(
      requests,
      releases.map((release) => ({ release, location: `sha256:${release.archiveDigest}`, withdrawn: false })),
      '0.1.0',
    );
  const selection = { lock, archives: new Map(releases.map((release) => [release.archiveDigest, release.bytes])) };
  for (const mode of ['withdrawn', 'missing', 'changed', 'index']) {
    const dir = registry([releases[0]!]),
      input = fresh(),
      archive = join(input, 'product.ia.tgz');
    writeFileSync(archive, target.bytes);
    const dependency = releases[0]!,
      dependencyPath = join(dir, `artifacts/${dependency.archiveDigest}.ia.tgz`);
    if (mode === 'withdrawn')
      registryWithdraw({ dir, id: dependency.manifest.id, version: dependency.manifest.version });
    else if (mode === 'missing') rmSync(dependencyPath);
    else if (mode === 'changed') writeFileSync(dependencyPath, 'changed');
    else {
      const file = join(dir, `packages/${dependency.manifest.id}.json`),
        index = JSON.parse(readFileSync(file, 'utf8'));
      index.releases[0].engine = '>=0.1.0';
      writeFileSync(file, JSON.stringify(index));
    }
    expect(() => registryAdd({ dir, archive, selection })).toThrow();
    expect(existsSync(join(dir, `artifacts/${target.archiveDigest}.ia.tgz`))).toBe(false);
    expect(existsSync(join(dir, `packages/${target.manifest.id}.json`))).toBe(false);
  }
});

it('publishes through CLI selection-root without changing the source installation and refuses stale cache', async () => {
  const source = fresh(),
    origin = registry(),
    dir = registry([releases[0]!]),
    input = fresh();
  const acquired = await resolveFromRegistries({
    root: source,
    requests,
    engine: '0.1.0',
    choose: choose(source, origin),
  });
  const { lock } = resolveReleases(requests, acquired.candidates, '0.1.0');
  applyInstallation(planInstallation(source, lock, 'install'));
  const archive = join(input, 'product.ia.tgz');
  writeFileSync(archive, releases[1]!.bytes);
  const lockPath = join(source, '.ia/distributions.lock.json'),
    before = readFileSync(lockPath);
  const args = ['registry', 'add', '--registry', dir, '--archive', archive, '--selection-root', source];
  expect(await runNative(args)).toMatchObject({ exitCode: 0, result: { id: releases[1]!.manifest.id } });
  expect(readFileSync(lockPath)).toEqual(before);
  expect(cachedReleases(source, lock).size).toBe(2);
  await expect(runNative([...args.slice(0, -1), 'relative'])).rejects.toThrow(/absolute/);
  const refused = registry([releases[0]!]);
  writeFileSync(join(source, `.ia/distributions/cache/${releases[1]!.archiveDigest}.ia.tgz`), 'changed');
  await expect(
    runNative(['registry', 'add', '--registry', refused, '--archive', archive, '--selection-root', source]),
  ).rejects.toThrow();
  expect(existsSync(join(refused, `artifacts/${releases[1]!.archiveDigest}.ia.tgz`))).toBe(false);
});

// LKI-08: dependency-first publication of a selected closure, repeat publication and no-target-effects refusals.
/** Every file under a registry with its bytes and stat identity, so "no effects" means nothing was created, rewritten or touched. */
function tree(dir: string, at = ''): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const name of readdirSync(join(dir, at)).sort()) {
    const path = at ? `${at}/${name}` : name,
      stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) {
      rows[path + '/'] = 'dir';
      Object.assign(rows, tree(dir, path));
    } else rows[path] = `${sha256(readFileSync(join(dir, path)))}:${stat.mode}:${stat.mtimeMs}:${stat.ino}`;
  }
  return rows;
}
function closure(members: readonly (typeof releases)[number][], roots = requests) {
  const { lock } = resolveReleases(
    roots,
    members.map((release) => ({ release, location: `sha256:${release.archiveDigest}`, withdrawn: false })),
    '0.1.0',
  );
  return { lock, archives: new Map(members.map((release) => [release.archiveDigest, release.bytes])) };
}
const languageRequests = () => [{ id: releases[0]!.manifest.id, range: releases[0]!.manifest.version }];
const input = (release: (typeof releases)[number]): string => {
  const path = join(fresh(), 'input.ia.tgz');
  writeFileSync(path, release.bytes);
  return path;
};
const publishClosure = (dir: string) => [
  registryAdd({ dir, archive: input(releases[0]!), selection: closure([releases[0]!], languageRequests()) }),
  registryAdd({ dir, archive: input(releases[1]!), selection: closure(releases) }),
];

it('publishes sourced language then product dependency-first, each through its own exact selection, for a real consumer', async () => {
  const dir = fresh(),
    product = releases[1]!,
    language = releases[0]!;
  // Out of order: the product cannot precede its dependency, and the refusal leaves an empty registry.
  expect(() => registryAdd({ dir, archive: input(product), selection: closure(releases) })).toThrow(/dependency/i);
  expect(readdirSync(dir)).toEqual([]);
  const [first, second] = publishClosure(dir);
  expect(first).toMatchObject({ status: 'registry-added', id: language.manifest.id, archive: language.archiveDigest });
  expect(second).toMatchObject({ status: 'registry-added', id: product.manifest.id, archive: product.archiveDigest });
  expect(
    Object.keys(tree(dir))
      .filter((path) => path.endsWith('.tgz'))
      .sort(),
  ).toEqual([language, product].map((release) => `artifacts/${release.archiveDigest}.ia.tgz`).sort());
  for (const transport of ['directory', 'https'] as const) {
    const consumer = fresh(),
      base = transport === 'https' ? 'https://registry.test/base/' : dir;
    if (transport === 'https') serveDirectory(dir, base);
    const resolved = await resolveFromRegistries({
      root: consumer,
      requests,
      engine: '0.1.0',
      choose: choose(consumer, base),
    });
    const { lock } = resolveReleases(requests, resolved.candidates, '0.1.0');
    expect(lock.packages.map((row) => row.archive).sort()).toEqual(
      [language, product].map((release) => release.archiveDigest).sort(),
    );
    expect(applyInstallation(planInstallation(consumer, lock, 'install')).status).toBe('installed');
  }
});

it('republishes the selected closure as a no-op with identical results and registry bytes, in either order', () => {
  const dir = fresh(),
    first = publishClosure(dir),
    before = tree(dir);
  expect(publishClosure(dir)).toEqual(first);
  expect(tree(dir)).toEqual(before);
  expect(registryAdd({ dir, archive: input(releases[1]!), selection: closure(releases) })).toEqual(first[1]);
  expect(registryAdd({ dir, archive: input(releases[0]!) })).toEqual(first[0]);
  expect(tree(dir)).toEqual(before);
});

it('refuses every invalid selected closure with no registry effects, on an empty and a populated registry', () => {
  const [language, product] = [releases[0]!, releases[1]!];
  const other = publish({ ...language.manifest, id: 'inventarch/unrelated-language' }, language.files);
  const undeclared = publish({ ...product.manifest, dependencies: [] }, product.files);
  const good = closure(releases),
    languageOnly = closure([language], languageRequests());
  const cases: Record<string, () => Parameters<typeof registryAdd>[0]> = {
    'missing dependency bytes': () => ({
      dir: '',
      archive: input(product),
      selection: { lock: good.lock, archives: new Map([[product.archiveDigest, product.bytes]]) },
    }),
    'extra archive bytes': () => ({
      dir: '',
      archive: input(product),
      selection: { lock: good.lock, archives: new Map([...good.archives, [other.archiveDigest, other.bytes]]) },
    }),
    'substituted dependency bytes': () => ({
      dir: '',
      archive: input(product),
      selection: { lock: good.lock, archives: new Map([...good.archives, [language.archiveDigest, other.bytes]]) },
    }),
    'unrelated release in the lock': () => ({
      dir: '',
      archive: input(product),
      selection: closure([language, product, other], [...requests, { id: other.manifest.id, range: '0.1.0' }]),
    }),
    'target file is not the selected target': () => ({ dir: '', archive: input(undeclared), selection: good }),
    'target absent from the lock': () => ({ dir: '', archive: input(product), selection: languageOnly }),
    'selected undeclared dependency': () => ({
      dir: '',
      archive: input(undeclared),
      selection: closure([undeclared], requests),
    }),
    'target file not an archive': () => {
      const path = join(fresh(), 'bad.ia.tgz');
      writeFileSync(path, 'not an archive');
      return { dir: '', archive: path, selection: good };
    },
    'relative target path': () => ({ dir: '', archive: 'product.ia.tgz', selection: good }),
  };
  for (const populated of [false, true])
    for (const [name, make] of Object.entries(cases)) {
      const dir = registry(populated ? [language, other] : []),
        before = tree(dir);
      expect(() => registryAdd({ ...make(), dir }), `${populated ? 'populated' : 'empty'}: ${name}`).toThrow();
      expect(tree(dir), `${populated ? 'populated' : 'empty'}: ${name}`).toEqual(before);
    }
});

it('refuses registry-side conflicts with no effects: rebound version, licensed listing, signed index, renamed registry, skewed dependency', () => {
  const [language, product] = [releases[0]!, releases[1]!],
    selection = closure(releases);
  const edit = (
    dir: string,
    id: string,
    change: (index: { releases: Record<string, unknown>[]; signatures?: unknown }) => void,
  ) => {
    const file = join(dir, `packages/${id}.json`),
      index = JSON.parse(readFileSync(file, 'utf8'));
    change(index);
    writeFileSync(file, JSON.stringify(index));
  };
  const modes: Record<string, (dir: string) => string | undefined> = {
    'target version rebound to other bytes': (dir) => {
      const rebound = publish({ ...product.manifest, description: 'rebound' }, product.files);
      registryAdd({ dir, archive: input(rebound), selection: closure([language, rebound]) });
      return undefined;
    },
    'target listed as licensed': (dir) => {
      registryAdd({ dir, archive: input(product), selection });
      edit(dir, product.manifest.id, (index) => {
        const row = index.releases[0]!;
        delete row['artifact'];
        row['access'] = 'licensed';
      });
      return undefined;
    },
    'target index signed with only another version': (dir) => {
      const newer = publish({ ...product.manifest, version: '0.2.0' }, product.files);
      registryAdd({
        dir,
        archive: input(newer),
        selection: closure([language, newer], [{ id: product.manifest.id, range: '0.2.0' }]),
      });
      edit(dir, product.manifest.id, (index) => {
        index.signatures = [];
      });
      return undefined;
    },
    'registry named differently': () => 'Another name',
    'dependency ranges skewed in the index': (dir) => {
      edit(dir, language.manifest.id, (index) => {
        index.releases[0]!['dependencies'] = [{ id: 'inventarch/extra', range: '0.1.0' }];
      });
      return undefined;
    },
    'dependency listed as licensed': (dir) => {
      edit(dir, language.manifest.id, (index) => {
        const row = index.releases[0]!;
        delete row['artifact'];
        row['access'] = 'licensed';
      });
      return undefined;
    },
  };
  for (const [name, arrange] of Object.entries(modes)) {
    const dir = registry([language]),
      renamed = arrange(dir),
      before = tree(dir);
    expect(
      () => registryAdd({ dir, archive: input(product), selection, ...(renamed ? { name: renamed } : {}) }),
      name,
    ).toThrow();
    expect(tree(dir), name).toEqual(before);
  }
});

// Report each refusal independently: a file-symlink capability skip cannot hide the other four guards.
for (const mode of [
  'missing cache bytes',
  'symlinked cache bytes',
  'hardlinked cache bytes',
  'lock with an unrelated release',
  'workspace with no installation',
] as const)
  it(`refuses a selection-root with ${mode}, leaving registry and workspace untouched`, async (context) => {
    const [language, product] = [releases[0]!, releases[1]!],
      archive = input(product);
    const other = publish({ ...language.manifest, id: 'inventarch/unrelated-language' }, language.files);
    const installed = async (extra: boolean) => {
      const source = fresh(),
        roots = extra ? [...requests, { id: other.manifest.id, range: '0.1.0' }] : requests,
        dir = registry(extra ? [...releases, other] : releases);
      const acquired = await resolveFromRegistries({
        root: source,
        requests: roots,
        engine: '0.1.0',
        choose: choose(source, dir),
      });
      expect(
        applyInstallation(
          planInstallation(source, resolveReleases(roots, acquired.candidates, '0.1.0').lock, 'install'),
        ).status,
      ).toBe('installed');
      return source;
    };
    const cacheFile = (source: string, release: (typeof releases)[number]) =>
      join(source, `.ia/distributions/cache/${release.archiveDigest}.ia.tgz`);
    const modes: Record<string, () => Promise<string>> = {
      'missing cache bytes': async () => {
        const source = await installed(false);
        rmSync(cacheFile(source, language));
        return source;
      },
      'symlinked cache bytes': async () => {
        const source = await installed(false),
          file = cacheFile(source, language),
          real = join(fresh(), 'real.ia.tgz');
        writeFileSync(real, language.bytes);
        rmSync(file);
        if (!fileLink(real, file)) return context.skip('Windows denied file symlink creation (EPERM)');
        return source;
      },
      'hardlinked cache bytes': async () => {
        const source = await installed(false),
          file = cacheFile(source, language),
          real = join(fresh(), 'real.ia.tgz');
        writeFileSync(real, language.bytes);
        rmSync(file);
        linkSync(real, file);
        return source;
      },
      'lock with an unrelated release': async () => installed(true),
      'workspace with no installation': async () => fresh(),
    };
    const source = await modes[mode]!(),
      dir = registry([language, other]),
      before = tree(dir),
      workspaceBefore = tree(source);
    await expect(
      runNative(['registry', 'add', '--registry', dir, '--archive', archive, '--selection-root', source]),
      mode,
    ).rejects.toThrow();
    expect(tree(dir), mode).toEqual(before);
    expect(tree(source), mode).toEqual(workspaceBefore);
  });

it('republishes through CLI selection-root with identical output and untouched registry and installation', async () => {
  const [language, product] = [releases[0]!, releases[1]!],
    source = fresh(),
    origin = registry(),
    dir = registry([language]),
    archive = input(product);
  const acquired = await resolveFromRegistries({
    root: source,
    requests,
    engine: '0.1.0',
    choose: choose(source, origin),
  });
  applyInstallation(planInstallation(source, resolveReleases(requests, acquired.candidates, '0.1.0').lock, 'install'));
  const args = ['registry', 'add', '--registry', dir, '--archive', archive, '--selection-root', source],
    first = await runNative(args);
  const registryBefore = tree(dir),
    workspaceBefore = tree(source);
  expect(await runNative(args)).toEqual(first);
  expect(tree(dir)).toEqual(registryBefore);
  expect(tree(source)).toEqual(workspaceBefore);
});
