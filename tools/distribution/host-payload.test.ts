// Host registration spec §3.2 (amended): the payload @inventarch/cli embeds is generated from the workspace's built packages.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { unpackTree, HOST_TREE_LIMITS } from '../../apps/distribution/src/ustar.js';
import { verifyHostCache } from '../../apps/distribution/src/host.js';
import { readInstalledImplementations } from '../../apps/distribution/src/implementations.js';
import type { InstalledImplementations } from '../../apps/distribution/src/implementations.js';
import { importedModules, moduleProblem } from '../dependencies/check.js';
import {
  assertStaticPayloadCode,
  staticCliManifest,
  collectPayload,
  generateHostPayload,
  moduleClosure,
  operationRow,
  packageClosure,
} from './host-payload.mjs';

const repository = resolve(import.meta.dirname, '../..'),
  made: string[] = [];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const HANDLER = 'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js';
/** The catalog the release pins in an extracted payload, which must be present. */
function present(root: string, release: string): InstalledImplementations {
  const catalog = readInstalledImplementations(root, release);
  if (catalog.status !== 'present') throw Error(`Expected a catalog: ${catalog.reason}`);
  return catalog;
}
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});
function extract(archive: Buffer): string {
  const tree = unpackTree(archive, HOST_TREE_LIMITS),
    out = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-')));
  made.push(out);
  for (const [path, bytes] of tree) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), bytes);
  }
  return out;
}
it('produces a deterministic v2 payload that verifies after extraction', async () => {
  const first = await generateHostPayload({ repository, write: false }),
    second = await generateHostPayload({ repository, write: false });
  expect(first.pin).toEqual(second.pin);
  expect(first.archive.equals(second.archive)).toBe(true);
  const verified = verifyHostCache(extract(first.archive));
  expect(verified).toMatchObject({ format: 2, host: null, release: first.pin.release });
});
it('ships the installed read handler as a payload root and pins the catalog to the shipped handler bytes', async () => {
  const payload = await generateHostPayload({ repository, write: false });
  const root = extract(payload.archive);
  expect(verifyHostCache(root).release).toBe(payload.pin.release);
  const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8')) as {
    packages: { name: string }[];
    files: { path: string; bytes: number; sha256: string }[];
  };
  const listed = (path: string) => inventory.files.find((row) => row.path === path);
  const bytes = readFileSync(resolve(root, 'implementations.json'));
  expect(listed('implementations.json')).toEqual({
    path: 'implementations.json',
    bytes: bytes.length,
    sha256: sha(bytes),
  });
  const catalog = present(root, payload.pin.release);
  expect(catalog).toMatchObject({
    digest: sha(bytes),
    evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
  });
  expect(catalog.operations).toHaveLength(1);
  const operation = catalog.operations[0]!;
  if (operation.status !== 'available') throw Error(`Expected the read handler to ship: ${operation.reason}`);
  expect(operation).toMatchObject({
    id: 'captured-source-read-v1',
    operation: 'authoring-system/binding/operation/read-captured-source',
    handler: 'ia.captured-source.read.v1',
    input: 'captured-source-read-input-v1',
    output: 'captured-source-read-output-v1',
    module: HANDLER,
  });
  // The handler bytes are the installed adapter's built module, shipped in the payload and pinned by their SHA-256.
  const shipped = readFileSync(resolve(root, HANDLER));
  expect(
    shipped.equals(
      readFileSync(resolve(repository, '.ia/src/systems/agent-composition-system/dist/installed-read.js')),
    ),
  ).toBe(true);
  expect(operation.digest).toBe(sha(shipped));
  expect(listed(HANDLER)!.sha256).toBe(operation.digest);
  expect(inventory.packages.map((row) => row.name)).toContain('@inventarch/agent-composition-system');
  // The row names the handler's package closure, every file of which the verified inventory pins.
  expect(operation.packages).toEqual(
    expect.arrayContaining(['@inventarch/agent-composition-system', '@inventarch/db']),
  );
  expect(operation).not.toHaveProperty('closure');
  const closure = inventory.files.filter((row) =>
    operation.packages.some((name) => row.path.startsWith(`runtime/node_modules/${name}/`)),
  );
  expect(closure.some((row) => row.path.endsWith('/dist/compile.js'))).toBe(true);
});
it('never reports the read handler available once its shipped bytes are altered or missing', async () => {
  const { archive, pin } = await generateHostPayload({ repository, write: false });
  const altered = extract(archive);
  writeFileSync(resolve(altered, HANDLER), Buffer.concat([readFileSync(resolve(altered, HANDLER)), Buffer.from('\n')]));
  expect(() => readInstalledImplementations(altered, pin.release)).toThrow(
    expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }),
  );
  expect(() => verifyHostCache(altered)).toThrow(expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }));
  // A module the handler imports counts as handler bytes too.
  const dependency = extract(archive),
    compile = 'runtime/node_modules/@inventarch/agent-composition-system/dist/compile.js';
  writeFileSync(
    resolve(dependency, compile),
    Buffer.concat([readFileSync(resolve(dependency, compile)), Buffer.from(' ')]),
  );
  expect(() => readInstalledImplementations(dependency, pin.release)).toThrow(
    expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }),
  );
  // Missing handler bytes: the payload is incomplete, so nothing in it is read (binders report it as unavailable).
  const missing = extract(archive);
  unlinkSync(resolve(missing, HANDLER));
  expect(() => readInstalledImplementations(missing, pin.release)).toThrow(
    expect.objectContaining({ code: 'IA-DIST-ARTIFACT-UNAVAILABLE' }),
  );
  expect(() => verifyHostCache(missing)).toThrow(expect.objectContaining({ code: 'IA-DIST-ARTIFACT-UNAVAILABLE' }));
  // A module the inventory does not list, where Node's resolution would load it instead of the shipped agent-system:
  // in the handler package's own node_modules, or beside the scope directory, outside every closure package. Either
  // refuses the catalog, as host verification refuses the payload.
  for (const planted of [
    'runtime/node_modules/@inventarch/agent-composition-system/node_modules/@inventarch/agent-system',
    'runtime/node_modules/@inventarch/node_modules/@inventarch/agent-system',
  ]) {
    const root = extract(archive);
    mkdirSync(resolve(root, planted), { recursive: true });
    writeFileSync(
      resolve(root, planted, 'package.json'),
      JSON.stringify({ name: '@inventarch/agent-system', type: 'module' }),
    );
    writeFileSync(resolve(root, planted, 'index.js'), 'export const planted = true;\n');
    expect(() => verifyHostCache(root), planted).toThrow(
      expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }),
    );
    expect(() => readInstalledImplementations(root, pin.release), planted).toThrow(
      expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }),
    );
  }
});
it('reads the actual payload without its catalog, as a release before the catalog shipped, as unavailable yet verified', async () => {
  const { archive } = await generateHostPayload({ repository, write: false });
  const tree = unpackTree(archive, HOST_TREE_LIMITS);
  const text = (path: string) => tree.get(path)!.toString('utf8');
  const inventory = JSON.parse(text('inventory.json'));
  inventory.files = inventory.files.filter((row: { path: string }) => row.path !== 'implementations.json');
  const inventoryText = JSON.stringify(inventory, null, 2) + '\n',
    launcher = text('scripts/ia.mjs').replace(sha(text('inventory.json')), sha(inventoryText));
  const release =
    JSON.stringify({ format: 'ia.host-release.v2', inventory: sha(inventoryText), launcher: sha(launcher) }, null, 2) +
    '\n';
  tree.delete('implementations.json');
  tree.set('inventory.json', Buffer.from(inventoryText));
  tree.set('scripts/ia.mjs', Buffer.from(launcher));
  tree.set('release.json', Buffer.from(release));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-old-')));
  made.push(root);
  for (const [path, bytes] of tree) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  expect(verifyHostCache(root).release).toBe(sha(release));
  const verify = spawnSync(process.execPath, [join(root, 'scripts/ia.mjs'), 'verify'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(verify.status, verify.stderr).toBe(0);
  expect(readInstalledImplementations(root, sha(release))).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('carries no installed-implementation catalog'),
  });
});
it('lists an implementation whose handler module is not built as unavailable, with the reason, and ships nothing for it', async () => {
  const payload = await generateHostPayload({
    repository,
    write: false,
    implementations: [
      {
        id: 'unbuilt-v1',
        package: '@inventarch/agent-composition-system',
        module: 'dist/not-built.js',
        declaration: 'installedReadCatalog',
      },
    ],
  });
  expect(payload.catalog.operations).toEqual([
    {
      id: 'unbuilt-v1',
      status: 'unavailable',
      reason: '@inventarch/agent-composition-system has no built dist/not-built.js',
    },
  ]);
  const root = extract(payload.archive);
  expect(verifyHostCache(root).release).toBe(payload.pin.release);
  expect(present(root, payload.pin.release).operations).toEqual(payload.catalog.operations);
  const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8'));
  expect(inventory.packages.map((row: { name: string }) => row.name)).not.toContain(
    '@inventarch/agent-composition-system',
  );
});
it('follows a handler module closure through relative imports and released exports, naming what is not shipped', () => {
  const files = new Map(
    Object.entries({
      'runtime/node_modules/@inventarch/a/package.json': JSON.stringify({
        name: '@inventarch/a',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        dependencies: { '@inventarch/b': '1', semver: '1', '@inventarch/service-contracts': '1' },
      }),
      'runtime/node_modules/@inventarch/a/dist/index.js': [
        "import { x } from './x.js';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "export * from '@inventarch/b/sub';",
        "import semver from 'semver';",
        "// import './commented.js';",
        "export const lazy = () => import('./lazy.js');",
      ].join('\n'),
      'runtime/node_modules/@inventarch/a/dist/x.js': 'export const x = 1;\n',
      'runtime/node_modules/@inventarch/a/dist/lazy.js': 'export {};\n',
      'runtime/node_modules/@inventarch/b/package.json': JSON.stringify({
        name: '@inventarch/b',
        exports: { './sub': { default: './dist/sub.js' } },
      }),
      'runtime/node_modules/@inventarch/b/dist/sub.js': "export * from './gone.js';\nimport '@inventarch/c';\n",
      'runtime/node_modules/semver/package.json': JSON.stringify({ name: 'semver' }),
    }).map(([path, text]) => [path, Buffer.from(text)]),
  );
  expect(moduleClosure(files, 'runtime/node_modules/@inventarch/a/dist/index.js')).toEqual({
    reached: [
      'runtime/node_modules/@inventarch/a/dist/index.js',
      'runtime/node_modules/@inventarch/a/dist/lazy.js',
      'runtime/node_modules/@inventarch/a/dist/x.js',
      'runtime/node_modules/@inventarch/b/dist/sub.js',
    ],
    packages: ['@inventarch/a', '@inventarch/b', 'semver'],
    missing: ['runtime/node_modules/@inventarch/b/dist/gone.js', 'runtime/node_modules/@inventarch/c/package.json'],
  });
  // The declared package closure skips the private service contracts the payload never carries.
  expect(packageClosure(files, '@inventarch/a')).toEqual(['@inventarch/a', '@inventarch/b', 'semver']);
  files.delete('runtime/node_modules/semver/package.json');
  expect(packageClosure(files, '@inventarch/a')).toBe('its dependency semver is not shipped');
});
it('lists the read handler unavailable for a staged candidate whose dependencies lack the installed adapter', async () => {
  // A candidate staged like the private one below, but with no installed copy of the composition package to ship.
  const candidate = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-unshipped-')));
  made.push(candidate);
  mkdirSync(join(candidate, 'node_modules'));
  mkdirSync(join(candidate, 'apps'));
  for (const app of ['cli', 'distribution', 'mcp-door', 'steward-hook'])
    symlinkSync(join(repository, 'apps', app), join(candidate, 'apps', app), 'junction');
  const payload = await generateHostPayload({ repository: candidate, write: false });
  expect(payload.catalog.operations).toEqual([
    {
      id: 'captured-source-read-v1',
      status: 'unavailable',
      reason: '@inventarch/agent-composition-system is not installed in this repository',
    },
  ]);
  const root = extract(payload.archive);
  expect(verifyHostCache(root).release).toBe(payload.pin.release);
  expect(present(root, payload.pin.release).operations[0]).toMatchObject({ status: 'unavailable' });
  expect(readFileSync(resolve(root, 'inventory.json'), 'utf8')).not.toContain('agent-composition-system');
});
it('excludes the private service dependencies and the payload itself', async () => {
  const { files, packages } = await collectPayload(repository);
  expect(packages.map((p: { name: string }) => p.name)).toEqual(
    expect.arrayContaining([
      '@inventarch/cli',
      '@inventarch/distribution',
      '@inventarch/mcp-door',
      '@inventarch/steward-hook',
    ]),
  );
  expect(
    packages.some(
      (p: { name: string }) => p.name === '@modelcontextprotocol/client' || p.name === '@inventarch/service-contracts',
    ),
  ).toBe(false);
  const hasNestedPayload = (paths: Iterable<string>) =>
    [...paths].some((path) => /@inventarch\/cli\/assets\/host(\/|\.json$)/.test(path));
  expect(hasNestedPayload(files.keys())).toBe(false);
  // Prove the exclusion observes the current namespace before trusting its negative result.
  for (const suffix of ['.json', '/payload.tgz'])
    expect(hasNestedPayload([...files.keys(), `runtime/node_modules/@inventarch/cli/assets/host${suffix}`])).toBe(true);
  expect(
    packages.some((p) =>
      ['@inventarch/architecture-system', '@inventarch/code-quality-system', '@inventarch/monorepo-kit-host'].includes(
        p.name,
      ),
    ),
  ).toBe(false);
  expect([...files.keys()].some((path) => /inventarch-development|development-native/.test(path))).toBe(false);
  expect(packages.length).toBeLessThanOrEqual(64);
});
it('bundles @inventarch manifests without the development condition, pinned by the bundled bytes', async () => {
  const { files, packages } = await collectPayload(repository);
  for (const pkg of packages.filter((p) => p.name.startsWith('@inventarch/'))) {
    const bytes = files.get(`runtime/node_modules/${pkg.name}/package.json`) as Buffer;
    expect(bytes.toString('utf8')).not.toContain('"development"');
    expect(pkg.manifestDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});
it('retains the exact shipped guide and reference documentation in the offline payload', async () => {
  const { files, packages } = await collectPayload(repository);
  let checked = 0;
  for (const pkg of packages.filter((p) => p.name.startsWith('@inventarch/'))) {
    const prefix = `runtime/node_modules/${pkg.name}/`,
      manifest = JSON.parse(files.get(prefix + 'package.json')!.toString('utf8'));
    for (const path of manifest.files ?? [])
      if (/^(?:README\.md|SPEC\.md|LANGUAGE\.md|references\/[A-Za-z0-9_.-]+\.md)$/.test(path)) {
        expect(files.has(prefix + path), prefix + path).toBe(true);
        checked++;
      }
    for (const path of files.keys())
      if (path.startsWith(prefix + 'references/')) expect(manifest.files).toContain(path.slice(prefix.length));
  }
  expect(checked).toBeGreaterThan(0);
});
it("runs the real launcher from the extracted payload regardless of the caller's Node conditions", async () => {
  const { archive } = await generateHostPayload({ repository, write: false }),
    dir = extract(archive),
    launcher = join(dir, 'scripts/ia.mjs');
  const verify = spawnSync(process.execPath, [launcher, 'verify'], { encoding: 'utf8', timeout: 10_000 });
  expect(verify.status, verify.stderr).toBe(0);
  expect(JSON.parse(verify.stdout)).toMatchObject({ status: 'verified', host: null });
  const env = { ...process.env, NODE_OPTIONS: '--conditions=development' };
  const door = spawnSync(
    process.execPath,
    [launcher, 'door', 'records', '--root', join(repository, 'packages/compliance/fixtures/loop')],
    { encoding: 'utf8', timeout: 10_000, env },
  );
  expect(door.status, door.stderr).toBe(0);
  expect(JSON.parse(door.stdout)).toMatchObject({ ok: true });
});

it('refuses omitted capabilities instead of transforming a staging manifest', () => {
  const original = JSON.parse(readFileSync(join(repository, 'apps/cli/package.json'), 'utf8'));
  expect(staticCliManifest(original)).toEqual(original);
  expect(() =>
    staticCliManifest({ ...original, exports: { './development': './dist/inventarch-development/index.js' } }),
  ).toThrow(/omitted capability/);
  for (const code of [
    "import '@inventarch/architecture-system'",
    "require('@inventarch/code-quality-system')",
    "import('./inventarch-development/index.js')",
  ])
    expect(() => assertStaticPayloadCode('dist/retained.js', Buffer.from(code))).toThrow(/omitted/);
  expect(() => assertStaticPayloadCode('dist/retained.js', Buffer.from("import '@inventarch/runtime'"))).not.toThrow();
});
it('excludes the public CLI embedded payload so repeated materialization keeps the same bytes', async () => {
  const candidate = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-repeat-'))),
    cli = join(candidate, 'apps/cli');
  made.push(candidate);
  mkdirSync(cli, { recursive: true });
  for (const entry of ['dist', 'assets', 'LICENSE', 'README.md', 'SPEC.md', 'package.json'])
    cpSync(join(repository, 'apps/cli', entry), join(cli, entry), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(candidate, 'node_modules'), 'junction');
  mkdirSync(join(cli, 'node_modules'));
  for (const app of ['distribution', 'mcp-door', 'steward-hook'])
    symlinkSync(join(repository, 'apps', app), join(candidate, 'apps', app), 'junction');
  const first = await generateHostPayload({ repository: candidate, write: true }),
    second = await generateHostPayload({ repository: candidate, write: true });
  expect(second.pin).toEqual(first.pin);
  expect(second.archive.equals(first.archive)).toBe(true);
  expect(present(extract(first.archive), first.pin.release).operations[0]).toMatchObject({ status: 'available' });
  const { files } = await collectPayload(candidate);
  expect([...files.keys()].some((path) => /@inventarch\/cli\/assets\/host(\/|\.json$)/.test(path))).toBe(false);
});
it('keeps the catalog producer-only: no host app imports the composition package the payload ships', () => {
  for (const file of ['apps/distribution/src/implementations.ts', 'apps/cli/src/doctor.ts', 'apps/cli/src/host.ts'])
    expect(
      importedModules(readFileSync(resolve(repository, file), 'utf8'), file).filter((specifier) =>
        specifier?.startsWith('@inventarch/agent-composition-system'),
      ),
    ).toEqual([]);
  for (const name of ['@inventarch/cli', '@inventarch/distribution'])
    expect(
      moduleProblem({ name, path: repository, app: true }, 'src/x.ts', '@inventarch/agent-composition-system'),
    ).toBe(`${name} may not depend on @inventarch/agent-composition-system`);
});
it('never ships, or imports at build time, an implementation package found above the repository', async () => {
  // A repository whose own node_modules lacks the implementation package, inside a directory whose node_modules has it.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-outer-'))),
    fake = join(outer, 'repo'),
    marker = join(outer, 'imported-at-build.txt');
  made.push(outer);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const name of ['cli', 'mcp-door', 'steward-hook'])
    put(join(fake, 'apps', name, 'package.json'), JSON.stringify({ name: `fake-${name}`, version: '0.0.0' }));
  // The real distribution app, as the staged private candidate links it, so its built modules resolve their own imports.
  symlinkSync(join(repository, 'apps/distribution'), join(fake, 'apps/distribution'), 'junction');
  // Its own node_modules is the workspace's, which holds no @acme/impl; only the enclosing directory's does.
  symlinkSync(join(repository, 'node_modules'), join(fake, 'node_modules'), 'junction');
  put(
    join(outer, 'node_modules/@acme/impl/package.json'),
    JSON.stringify({ name: '@acme/impl', version: '1.0.0', type: 'module' }),
  );
  put(
    join(outer, 'node_modules/@acme/impl/dist/read.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport const catalog = () => ({ operations: {} });\n`,
  );
  const implementations = [
    { id: 'acme-read-v1', package: '@acme/impl', module: 'dist/read.js', declaration: 'catalog' },
  ];
  const { catalog, archive, pin } = await generateHostPayload({ repository: fake, write: false, implementations });
  expect(catalog.operations).toEqual([
    { id: 'acme-read-v1', status: 'unavailable', reason: '@acme/impl is not installed in this repository' },
  ]);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(resolve(extract(archive), 'inventory.json'), 'utf8')).not.toContain('@acme/impl');
  expect(pin.files).toBeGreaterThan(0);
});
it('resolves an implementation closure inside the repository install, never from an enclosing node_modules', async () => {
  // The implementation is installed in the repository, but the package it depends on only in the enclosing directory.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-ceiling-'))),
    candidate = join(outer, 'repo');
  made.push(outer);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(outer, path)), { recursive: true });
    writeFileSync(join(outer, path), text);
  };
  mkdirSync(join(candidate, 'apps'), { recursive: true });
  for (const app of ['cli', 'distribution', 'mcp-door', 'steward-hook'])
    symlinkSync(join(repository, 'apps', app), join(candidate, 'apps', app), 'junction');
  put(
    'repo/node_modules/@acme/impl/package.json',
    JSON.stringify({ name: '@acme/impl', version: '1.0.0', type: 'module', dependencies: { '@acme/outside': '1' } }),
  );
  put('repo/node_modules/@acme/impl/dist/read.js', 'export const catalog = () => ({ operations: {} });\n');
  put('node_modules/@acme/outside/package.json', JSON.stringify({ name: '@acme/outside', version: '1.0.0' }));
  await expect(
    collectPayload(candidate, [
      { id: 'acme-read-v1', package: '@acme/impl', module: 'dist/read.js', declaration: 'catalog' },
    ]),
  ).rejects.toThrow('Installed package manifest unavailable: @acme/outside');
});
it('lists an implementation unavailable when its module closure is incomplete or leaves its package closure, and refuses one that declares nothing', async () => {
  const files = (handler: string, extra: Record<string, string> = {}) =>
    new Map(
      Object.entries({
        'runtime/node_modules/@acme/handler/package.json': JSON.stringify({ name: '@acme/handler' }),
        'runtime/node_modules/@acme/handler/dist/read.js': handler,
        'runtime/node_modules/@acme/other/package.json': JSON.stringify({ name: '@acme/other' }),
        ...extra,
      }).map(([key, text]) => [key, Buffer.from(text)]),
    );
  const located = (dir: string | null = null) => ({
    id: 'acme-read-v1',
    package: '@acme/handler',
    module: 'dist/read.js',
    declaration: 'catalog',
    dir,
    reason: null,
  });
  // A relative import of a file the payload does not ship.
  expect(await operationRow(located(), files("import { gone } from './gone.js';\n"))).toEqual({
    id: 'acme-read-v1',
    status: 'unavailable',
    reason: 'its handler module closure lacks runtime/node_modules/@acme/handler/dist/gone.js',
  });
  // An import of a shipped package its own manifest does not declare.
  expect(await operationRow(located(), files("import other from '@acme/other';\n"))).toEqual({
    id: 'acme-read-v1',
    status: 'unavailable',
    reason: 'its handler module imports @acme/other, outside its package closure',
  });
  // A shipped module that declares no such implementation is the producer's error, never a catalog row.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-host-payload-declaration-')));
  made.push(dir);
  const handler = 'export const catalog = () => ({ operations: {} });\n';
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/read.js'), handler);
  await expect(operationRow(located(dir), files(handler))).rejects.toThrow(
    '@acme/handler/dist/read.js does not declare installed operation acme-read-v1',
  );
});
