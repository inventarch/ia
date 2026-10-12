// Plan amendments C16 and C24 (milestone generation-binding): the installed-implementation catalog a host payload
// carries, read only through its release pins and the handler bytes the payload actually ships, and the per-consumer
// join receipts a host registration records from its committed state.
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { json, sha256 } from '../src/files.js';
import { acquireHostRegistrationLock, verifyHostCache } from '../src/host.js';
import { hostVerifier, observeHosts } from '../src/host-observe.js';
import type { HostVerifier } from '../src/host-observe.js';
import {
  installedImplementationsValue,
  joinedCatalog,
  joinHost,
  JOINS,
  leaveHost,
  readInstalledImplementations,
  readJoins,
} from '../src/implementations.js';
import { openWorkspaceSession, recordValidation } from '../src/services.js';

// Spies that keep the real behaviour, so a test can count how often a payload is verified.
vi.mock('../src/host.js', { spy: true });
const actualHost = await vi.importActual<typeof import('../src/host.js')>('../src/host.js');

const roots: string[] = [];
const temp = () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'ia-implementations-')));
  roots.push(root);
  return root;
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const code = (value: string) => expect.objectContaining({ code: value });

const MODULE = 'runtime/node_modules/@acme/handler/dist/handler.js',
  HELPER = 'runtime/node_modules/@acme/handler/dist/helper.js',
  BASE = 'runtime/node_modules/@acme/base/index.js',
  PACKAGES = ['@acme/base', '@acme/handler'];
type Operation = Record<string, unknown>;
/**
 * A materialized v2 payload as the builder lays one out: a handler package and the package it depends on, a package
 * outside that closure, an optional catalog naming the handler with pins computed from the shipped bytes, and the
 * inventory, launcher and release that pin them all. `mutate` edits the catalog row before it is pinned.
 */
function payload(options: { catalog?: boolean; mutate?: (operation: Operation) => Operation } = {}) {
  const root = temp(),
    files = new Map<string, string>([
      [
        'runtime/node_modules/@acme/handler/package.json',
        json({ name: '@acme/handler', dependencies: { '@acme/base': '1' } }),
      ],
      [MODULE, "import { helper } from './helper.js';\nexport const read = () => helper;\n"],
      [HELPER, 'export const helper = 1;\n'],
      ['runtime/node_modules/@acme/base/package.json', json({ name: '@acme/base' })],
      [BASE, 'export default 1;\n'],
      ['runtime/node_modules/@acme/other/package.json', json({ name: '@acme/other' })],
    ]);
  const operation = (options.mutate ?? ((row) => row))({
    id: 'read-v1',
    status: 'available',
    version: 1,
    operation: 'acme/binding/operation/read',
    handler: 'acme.read.v1',
    input: 'read-input-v1',
    output: 'read-output-v1',
    module: MODULE,
    digest: sha256(files.get(MODULE)!),
    packages: PACKAGES,
  });
  if (options.catalog !== false)
    files.set(
      'implementations.json',
      json({
        format: 'ia.installed-implementations.v1',
        evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
        operations: [operation],
      }),
    );
  const inventory = json({
    format: 'ia.host-cache.v2',
    version: '2.1.0',
    packages: [],
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) })),
  });
  const launcher = '// launcher\n',
    release = json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) });
  for (const [path, text] of files) put(root, path, text);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(root, 'release.json', release);
  return { root, release: sha256(release), catalog: files.get('implementations.json') ?? null };
}

it('lists an operation as available only with the handler bytes the payload ships, pinned by their digest', () => {
  const { root, release, catalog } = payload();
  expect(verifyHostCache(root).release).toBe(release);
  const read = readInstalledImplementations(root, release);
  expect(read).toMatchObject({
    status: 'present',
    release,
    version: '2.1.0',
    digest: sha256(catalog!),
    evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
  });
  expect(read.status === 'present' && read.operations).toEqual([
    expect.objectContaining({
      id: 'read-v1',
      status: 'available',
      module: MODULE,
      digest: sha256(readFileSync(resolve(root, MODULE))),
    }),
  ]);
});

it('reads a payload with no catalog, such as one built before it existed, as unavailable while it still verifies', () => {
  const { root, release } = payload({ catalog: false });
  expect(verifyHostCache(root).release).toBe(release);
  expect(readInstalledImplementations(root, release)).toMatchObject({
    status: 'unavailable',
    release,
    reason: expect.stringContaining('carries no installed-implementation catalog'),
  });
  // A v1 payload carries none either; a payload whose release no longer matches its pin is damaged, not old.
  const v1 = temp(),
    inventory = json({
      format: 'ia.host-cache.v1',
      host: 'claude',
      name: 'legacy',
      version: '1.0.0',
      native: 'a'.repeat(64),
      packages: [],
      files: [],
    }),
    launcher = '// launcher\n',
    text = json({ format: 'ia.host-release.v1', inventory: sha256(inventory), launcher: sha256(launcher) });
  put(v1, 'inventory.json', inventory);
  put(v1, 'scripts/ia.mjs', launcher);
  put(v1, 'release.json', text);
  expect(verifyHostCache(v1).format).toBe(1);
  expect(readInstalledImplementations(v1, sha256(text))).toMatchObject({ status: 'unavailable' });
  expect(() => readInstalledImplementations(root, 'c'.repeat(64))).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  expect(() => readInstalledImplementations(temp(), release)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
});

it('reports a declaration whose handler bytes are not shipped as unavailable, never available', () => {
  const unavailable = (read: ReturnType<typeof readInstalledImplementations>) =>
    read.status === 'present' ? read.operations[0] : read;
  // Metadata only: the catalog names a module the inventory does not list.
  const absent = payload({
    mutate: (row) => ({ ...row, module: 'runtime/node_modules/@acme/handler/dist/absent.js' }),
  });
  expect(unavailable(readInstalledImplementations(absent.root, absent.release))).toEqual({
    id: 'read-v1',
    status: 'unavailable',
    reason: expect.stringContaining('is not in this payload'),
  });
  // A closure package the payload does not ship.
  const missing = payload({ mutate: (row) => ({ ...row, packages: ['@acme/base', '@acme/handler', '@acme/zzz'] }) });
  expect(unavailable(readInstalledImplementations(missing.root, missing.release))).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('@acme/zzz'),
  });
  // Handler or closure bytes deleted from a materialized payload: the payload no longer verifies, so nothing in it is
  // read, let alone available (binders report it as unavailable).
  for (const path of [MODULE, BASE]) {
    const { root, release } = payload();
    unlinkSync(resolve(root, path));
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
    expect(() => verifyHostCache(root)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
  }
});

it('refuses a payload with any file its inventory does not list, inside a closure package or outside every one (B-R1)', () => {
  // A module planted where Node's resolution prefers it to the shipped dependency: in the handler package's own
  // node_modules, or in a node_modules beside the scope directories, outside every closure package.
  for (const directory of [
    'runtime/node_modules/@acme/handler/node_modules/@acme/base',
    'runtime/node_modules/@acme/node_modules/@acme/base',
  ]) {
    const { root, release } = payload(),
      workspaceRoot = temp();
    put(root, `${directory}/package.json`, json({ name: '@acme/base', main: 'index.js' }));
    put(root, `${directory}/index.js`, 'export default "planted";\n');
    expect(() => verifyHostCache(root), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(() => readInstalledImplementations(root, release), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    // A registration naming that payload records no join: the join refuses rather than vouch for it.
    registered(workspaceRoot, 'claude', root, release);
    expect(() => joinHost(workspaceRoot, 'claude', REVISION), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(existsSync(resolve(workspaceRoot, JOINS))).toBe(false);
  }
});

it('detects altered handler bytes and disagreeing pins as an integrity failure, never as available', () => {
  for (const path of [MODULE, HELPER, BASE]) {
    const { root, release } = payload();
    writeFileSync(resolve(root, path), readFileSync(resolve(root, path), 'utf8') + '// altered after the build\n');
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(() => verifyHostCache(root)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  }
  // A catalog whose handler digest disagrees with the inventory the release pins.
  {
    const { root, release } = payload({ mutate: (row: Operation) => ({ ...row, digest: 'f'.repeat(64) }) });
    expect(verifyHostCache(root).release).toBe(release);
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  }
  // Changed catalog bytes.
  const { root, release, catalog } = payload();
  writeFileSync(resolve(root, 'implementations.json'), catalog + ' ');
  expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
});

it('refuses handler bytes reached through a hard link or a junction', () => {
  // The second name lives outside the payload, so the inventoried file is aliased without an unexpected entry in it.
  const linked = payload();
  linkSync(resolve(linked.root, BASE), resolve(temp(), 'alias.js'));
  expect(() => readInstalledImplementations(linked.root, linked.release)).toThrow(code('IA-DIST-PATH-UNSAFE'));
  const junction = payload(),
    copy = temp(),
    base = resolve(junction.root, 'runtime/node_modules/@acme/base');
  cpSync(base, copy, { recursive: true });
  rmSync(base, { recursive: true });
  symlinkSync(copy, base, 'junction');
  expect(() => readInstalledImplementations(junction.root, junction.release)).toThrow(code('IA-DIST-PATH-UNSAFE'));
});

it('accepts only well-formed catalogs', () => {
  const available = JSON.parse(payload().catalog!).operations[0] as Operation;
  const catalog = (
    operations: unknown[],
    evaluators: unknown = { format: 'ia-evaluator-catalog/1.0', entries: [] },
  ) => ({
    format: 'ia.installed-implementations.v1',
    evaluators,
    operations,
  });
  const unavailable = { id: 'zeta-v1', status: 'unavailable', reason: 'not shipped' };
  expect(installedImplementationsValue(catalog([available, unavailable])).operations).toHaveLength(2);
  for (const bad of [
    catalog([unavailable, available]),
    catalog([available, available]),
    catalog([{ ...available, packages: undefined }]),
    catalog([{ ...available, closure: 'f'.repeat(64) }]),
    catalog([{ ...available, extra: 1 }]),
    catalog([{ ...available, module: 'runtime/node_modules/@acme/other/index.js' }]),
    catalog([{ ...available, packages: ['@acme/handler', '@acme/base'] }]),
    catalog([{ ...available, status: 'revoked' }]),
    catalog([{ ...unavailable, reason: '' }]),
    catalog([available], { format: 'ia-evaluator-catalog/2.0', entries: [] }),
    { ...catalog([available]), format: 'ia.installed-implementations.v2' },
  ])
    expect(() => installedImplementationsValue(bad)).toThrow(code('IA-DIST-INPUT-INVALID'));
});

/** A workspace whose `host` registration names the payload at `cache`, as `applyHost` records one. */
function registered(root: string, host: 'claude' | 'codex', cache: string, release: string): void {
  put(
    root,
    `.ia/distributions/hosts/${host}-workspace.json`,
    json({ format: 'ia.host-state.v1', host, id: 'workspace', cache, release, owned: '{}\n', created: true }),
  );
}
const REVISION = 'd'.repeat(64);

it('joins each registered host from its committed registration and drops a join with its registration', () => {
  const root = temp(),
    { root: cache, release, catalog } = payload();
  registered(root, 'claude', cache, release);
  registered(root, 'codex', cache, release);
  const join = {
    consumer: 'claude',
    implementation: 'installed-implementations',
    version: '2.1.0',
    digest: sha256(catalog!),
    release,
    consumerRevision: REVISION,
  };
  expect(joinHost(root, 'claude', REVISION)).toEqual({ status: 'joined', join });
  expect(joinHost(root, 'codex', 'e'.repeat(64))).toMatchObject({ status: 'joined' });
  expect(readJoins(root)).toEqual([join, { ...join, consumer: 'codex', consumerRevision: 'e'.repeat(64) }]);
  // Re-joining at another revision replaces only that consumer's row.
  joinHost(root, 'claude', 'f'.repeat(64));
  expect(readJoins(root)!.map((row) => [row.consumer, row.consumerRevision])).toEqual([
    ['claude', 'f'.repeat(64)],
    ['codex', 'e'.repeat(64)],
  ]);
  expect(leaveHost(root, 'claude')).toBe(true);
  expect(leaveHost(root, 'claude')).toBe(false);
  expect(readJoins(root)!.map((row) => row.consumer)).toEqual(['codex']);
  // No registration any more: the join goes with it, and so does the receipt file once it is empty.
  rmSync(resolve(root, '.ia/distributions/hosts/codex-workspace.json'));
  expect(joinHost(root, 'codex', REVISION)).toEqual({ status: 'unregistered' });
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  expect(readJoins(root)).toBeNull();
});

it('records no join for a registered payload without a catalog, and drops the one it had', () => {
  const root = temp(),
    current = payload(),
    old = payload({ catalog: false });
  registered(root, 'claude', current.root, current.release);
  expect(joinHost(root, 'claude', REVISION).status).toBe('joined');
  registered(root, 'claude', old.root, old.release);
  expect(joinHost(root, 'claude', REVISION)).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('carries no installed-implementation catalog'),
  });
  expect(readJoins(root)).toBeNull();
});

it('refuses to replace unreadable receipts, to write through aliases or past a pending host journal', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  put(root, JOINS, '{broken');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(expect.objectContaining({ path: JOINS }));
  expect(readFileSync(resolve(root, JOINS), 'utf8')).toBe('{broken');
  rmSync(resolve(root, JOINS));
  put(root, '.ia/distributions/hosts/pending.json', '{}');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-RECOVERY-REQUIRED'));
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  const hosts = resolve(root, '.ia/distributions/hosts'),
    other = temp();
  cpSync(hosts, other, { recursive: true });
  rmSync(hosts, { recursive: true });
  rmSync(resolve(other, 'pending.json'));
  symlinkSync(other, hosts, 'junction');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-PATH-UNSAFE'));
  expect(existsSync(resolve(other, 'joins.json'))).toBe(false);
  expect(() => joinHost(temp(), 'claude', 'not-a-revision')).toThrow(code('IA-DIST-INPUT-INVALID'));
  expect(() => joinHost(temp(), 'cursor', REVISION)).toThrow(code('IA-DIST-HOST-UNSUPPORTED'));
});

it('carries a catalog-declared revocation distinctly from an implementation that is not shipped', () => {
  const { root, release } = payload({
    mutate: () => ({ id: 'read-v1', status: 'revoked', reason: 'withdrawn by its producer' }),
  });
  const read = readInstalledImplementations(root, release);
  expect(read.status === 'present' && read.operations).toEqual([
    { id: 'read-v1', status: 'revoked', reason: 'withdrawn by its producer' },
  ]);
  expect(() =>
    installedImplementationsValue({
      format: 'ia.installed-implementations.v1',
      evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
      operations: [{ id: 'read-v1', status: 'revoked' }],
    }),
  ).toThrow(code('IA-DIST-INPUT-INVALID'));
});

/**
 * `payload()` materialized where an installation keeps it, `<home>/hosts/<release>`, with the trust that installation
 * holds (review finding B2-R2): its IA home and the release it pins.
 */
function installed(options: Parameters<typeof payload>[0] = {}, home = temp()) {
  const built = payload(options),
    root = resolve(home, 'hosts', built.release);
  // Copied, not renamed: a directory rename on Windows can be refused while the indexer still holds the new tree.
  cpSync(built.root, root, { recursive: true });
  return { ...built, root, home, trust: { home, release: built.release } };
}
const RERUN = 'run "ia host claude --apply"';
/**
 * Review finding B2-RC2: the result of `run` and every synchronous filesystem call made meanwhile whose path names
 * `directory` (case and separators folded). Each watched export of node:fs is wrapped, `.native` included, and the
 * wrappers reach every named import through `syncBuiltinESMExports`; an empty list means `directory` was never touched.
 */
function watched<T>(
  directory: string,
  run: (calls: readonly string[]) => T,
): { readonly result: T; readonly calls: readonly string[] } {
  const fold = (value: unknown) => String(value).toLowerCase().replaceAll('/', '\\');
  const needle = fold(directory),
    calls: string[] = [],
    originals = new Map<string, unknown>();
  const target = fsModule as unknown as Record<
    string,
    ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown }
  >;
  const watch = (name: string, original: (...args: unknown[]) => unknown) =>
    function (this: unknown, path: unknown, ...rest: unknown[]) {
      if (fold(path).includes(needle)) calls.push(`${name} ${String(path)}`);
      return original.call(this, path, ...rest);
    };
  for (const name of [
    'existsSync',
    'statSync',
    'lstatSync',
    'readFileSync',
    'realpathSync',
    'readdirSync',
    'opendirSync',
    'openSync',
    'accessSync',
    'readlinkSync',
  ]) {
    const original = target[name]!;
    originals.set(name, original);
    const wrapped = watch(name, original) as (typeof target)[string];
    if (typeof original.native === 'function') wrapped.native = watch(`${name}.native`, original.native);
    target[name] = wrapped;
  }
  syncBuiltinESMExports();
  try {
    return { result: run(calls), calls };
  } finally {
    for (const [name, original] of originals) target[name] = original as (typeof target)[string];
    syncBuiltinESMExports();
  }
}

it('finds the catalog a host joined for binding, and says why there is none', () => {
  const root = temp(),
    current = installed(),
    old = installed({ catalog: false }, current.home);
  // No join receipt: an ia project-only workspace, or one registered before joins existed.
  expect(joinedCatalog(root, current.trust)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('no host has joined an installed-implementation catalog'),
  });
  registered(root, 'claude', current.root, current.release);
  joinHost(root, 'claude', REVISION);
  const joined = joinedCatalog(root, current.trust);
  expect(joined).toMatchObject({
    status: 'joined',
    consumer: 'claude',
    release: current.release,
    version: '2.1.0',
    digest: sha256(current.catalog!),
  });
  expect(joined.status === 'joined' && joined.catalog.operations[0]).toMatchObject({
    id: 'read-v1',
    status: 'available',
  });
  // The registration moved to another payload without a new join: not this installation's, so nothing binds through it.
  registered(root, 'claude', old.root, old.release);
  expect(joinedCatalog(root, current.trust)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining(`host claude is registered for release ${old.release.slice(0, 12)}`),
  });
  // Another current join is used instead, in consumer order.
  registered(root, 'codex', current.root, current.release);
  joinHost(root, 'codex', REVISION);
  expect(joinedCatalog(root, current.trust)).toMatchObject({ status: 'joined', consumer: 'codex' });
  rmSync(resolve(root, '.ia/distributions/hosts/codex-workspace.json'));
  expect(joinedCatalog(root, current.trust)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('host codex joined a catalog but is no longer registered'),
  });
  put(root, JOINS, '{broken');
  expect(joinedCatalog(root, current.trust)).toEqual({
    status: 'unavailable',
    reason: `${JOINS} cannot be read (IA-DB-SOURCE-UNAVAILABLE)`,
  });
});

it('reports a joined payload whose handler bytes no longer match their pins as damaged, and a missing one as unavailable', () => {
  const root = temp(),
    { root: cache, release, trust } = installed();
  registered(root, 'claude', cache, release);
  joinHost(root, 'claude', REVISION);
  writeFileSync(resolve(cache, MODULE), readFileSync(resolve(cache, MODULE), 'utf8') + '// altered\n');
  expect(joinedCatalog(root, trust)).toEqual({
    status: 'damaged',
    consumer: 'claude',
    release,
    payload: cache,
    reason: 'IA-DIST-INTEGRITY-MISMATCH: Unexpected host payload',
  });
  rmSync(cache, { recursive: true });
  expect(joinedCatalog(root, trust)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining(
      `this installation's payload for host claude is not materialized in ${trust.home}; ${RERUN}`,
    ),
  });
});

it('binds only through the payload this installation pins in its own IA home, and opens no other (B2-R2, B2-RC2)', () => {
  const genuine = installed();
  // A self-consistent forged payload (another catalog, every pin recomputed) outside the IA home, registered and joined
  // at its own release: never trusted, and no filesystem call ever names it.
  const forgedRoot = temp(),
    forged = payload({ mutate: (row) => ({ ...row, handler: 'acme.forged.v1' }) });
  registered(forgedRoot, 'claude', forged.root, forged.release);
  joinHost(forgedRoot, 'claude', REVISION);
  const forgedRead = watched(forged.root, () => joinedCatalog(forgedRoot, genuine.trust));
  expect(forgedRead.result).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining(
      `host claude is registered for release ${forged.release.slice(0, 12)}, not this installation's ${genuine.release.slice(0, 12)}; ${RERUN}`,
    ),
  });
  expect(forgedRead.calls).toEqual([]);
  // The genuine release, but a copy of its payload inside the workspace: the registration names another directory, so
  // nothing is read from it.
  const inRepo = temp(),
    copy = resolve(inRepo, '.ia/work/payload');
  cpSync(genuine.root, copy, { recursive: true });
  registered(inRepo, 'claude', copy, genuine.release);
  joinHost(inRepo, 'claude', REVISION);
  const copied = watched(copy, () => joinedCatalog(inRepo, genuine.trust));
  expect(copied.result).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining(
      `host claude's registration names a payload other than ${resolve(genuine.home, 'hosts', genuine.release)} (another directory or another spelling of it); ${RERUN}`,
    ),
  });
  expect(copied.calls).toEqual([]);
  // A stale registration: an earlier release materialized in the same IA home, which ia doctor reports as stale.
  const stale = temp(),
    earlier = installed({ mutate: (row) => ({ ...row, version: 2 }) }, genuine.home);
  registered(stale, 'claude', earlier.root, earlier.release);
  joinHost(stale, 'claude', REVISION);
  const staleRead = watched(earlier.root, () => joinedCatalog(stale, genuine.trust));
  expect(staleRead.result).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining(`registered for release ${earlier.release.slice(0, 12)}`),
  });
  expect(staleRead.calls).toEqual([]);
  // An installation that pins no payload trusts no join at all.
  const own = temp();
  registered(own, 'claude', genuine.root, genuine.release);
  joinHost(own, 'claude', REVISION);
  expect(joinedCatalog(own, genuine.trust)).toMatchObject({ status: 'joined', consumer: 'claude' });
  // The watcher sees the trusted payload being read, so an empty list above is evidence, not silence.
  expect(watched(genuine.root, () => joinedCatalog(own, genuine.trust)).calls.length).toBeGreaterThan(0);
  expect(joinedCatalog(own, null)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('carries no host payload of its own'),
  });
  expect(() => joinedCatalog(own, { home: 'relative', release: genuine.release })).toThrow(
    code('IA-DIST-INPUT-INVALID'),
  );
});

it.skipIf(process.platform !== 'win32')(
  'compares a network path a registration names to the pinned payload and never opens it (B2-RC2)',
  (context) => {
    // The genuine payload through a network path (the same directory on this machine): a path the workspace names is
    // compared, never opened. Only where the administrative share answers.
    const genuine = installed(),
      own = temp();
    const unc = `\\\\localhost\\${genuine.root.slice(0, 1)}$${genuine.root.slice(2)}`;
    if (!existsSync(unc)) return context.skip('the administrative share does not answer on this machine');
    // Joined through the pinned payload, then registered through the network spelling of the same directory.
    registered(own, 'claude', genuine.root, genuine.release);
    joinHost(own, 'claude', REVISION);
    registered(own, 'claude', unc, genuine.release);
    const network = watched('\\\\localhost\\', () => joinedCatalog(own, genuine.trust));
    expect(network.result).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('names a payload other than'),
    });
    expect(network.calls).toEqual([]);
  },
);

it('reports the trusted payload damaged whichever host joined it, in either consumer order (B2-N1)', () => {
  for (const [trusted, other] of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const) {
    const root = temp(),
      genuine = installed(),
      elsewhere = payload();
    registered(root, trusted, genuine.root, genuine.release);
    joinHost(root, trusted, REVISION);
    registered(root, other, elsewhere.root, elsewhere.release);
    joinHost(root, other, REVISION);
    writeFileSync(resolve(genuine.root, MODULE), readFileSync(resolve(genuine.root, MODULE), 'utf8') + '// altered\n');
    expect(joinedCatalog(root, genuine.trust), trusted).toEqual({
      status: 'damaged',
      consumer: trusted,
      release: genuine.release,
      payload: genuine.root,
      reason: expect.stringContaining('IA-DIST-INTEGRITY-MISMATCH'),
    });
  }
});

it('reports a release.json that no longer hashes to its pin as damaged, parseable or not, naming the code once (B2-N2)', () => {
  for (const change of [() => '{broken', (text: string) => `${text}\n`]) {
    const root = temp(),
      genuine = installed(),
      path = resolve(genuine.root, 'release.json');
    registered(root, 'claude', genuine.root, genuine.release);
    joinHost(root, 'claude', REVISION);
    writeFileSync(path, change(readFileSync(path, 'utf8')));
    expect(() => readInstalledImplementations(genuine.root, genuine.release)).toThrow(
      code('IA-DIST-INTEGRITY-MISMATCH'),
    );
    expect(joinedCatalog(root, genuine.trust)).toEqual({
      status: 'damaged',
      consumer: 'claude',
      release: genuine.release,
      payload: genuine.root,
      reason: 'IA-DIST-INTEGRITY-MISMATCH: Host release differs from its pin',
    });
  }
});

it('records no join while another holder has the host lock, and checks for a pending journal under it (B-N4)', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  const unlock = acquireHostRegistrationLock(root);
  try {
    expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-INSTALL-BUSY'));
    expect(() => leaveHost(root, 'claude')).not.toThrow();
  } finally {
    unlock();
  }
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  expect(joinHost(root, 'claude', REVISION).status).toBe('joined');
  // With receipts present, a removal under a held lock refuses too, and leaves them as they were.
  const before = readFileSync(resolve(root, JOINS), 'utf8'),
    held = acquireHostRegistrationLock(root);
  try {
    expect(() => leaveHost(root, 'claude')).toThrow(code('IA-DIST-INSTALL-BUSY'));
  } finally {
    held();
  }
  expect(readFileSync(resolve(root, JOINS), 'utf8')).toBe(before);
  // Review finding B-RC3: the journal is checked under the lock, so one that appears as the lock is taken still
  // refuses, and no receipt is written. Checked before the lock, as the code before B-N4 did, it would be missed.
  rmSync(resolve(root, JOINS));
  vi.mocked(acquireHostRegistrationLock).mockImplementationOnce((locked) => {
    put(locked, '.ia/distributions/hosts/pending.json', '{}');
    return actualHost.acquireHostRegistrationLock(locked);
  });
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-RECOVERY-REQUIRED'));
  expect(existsSync(resolve(root, JOINS))).toBe(false);
});

it('verifies a payload once for every read of one report that shares a verifier (B-N7)', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  const verify = hostVerifier();
  vi.mocked(verifyHostCache).mockClear();
  // The host row's observation, the catalog row and a join row, as ia doctor reads them.
  expect(observeHosts(root, release, verify)).toHaveLength(1);
  expect(readInstalledImplementations(cache, release, verify).status).toBe('present');
  expect(readInstalledImplementations(cache, release, verify).status).toBe('present');
  expect(vi.mocked(verifyHostCache)).toHaveBeenCalledTimes(1);
  // A failure is kept too: a damaged payload is scanned once, and every read of it refuses.
  writeFileSync(resolve(cache, MODULE), readFileSync(resolve(cache, MODULE), 'utf8') + '// altered\n');
  const again = hostVerifier();
  vi.mocked(verifyHostCache).mockClear();
  for (let read = 0; read < 2; read++)
    expect(() => readInstalledImplementations(cache, release, again)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  expect(vi.mocked(verifyHostCache)).toHaveBeenCalledTimes(1);
});

const NATIVE = resolve(import.meta.dirname, '../../../examples/conformance/native');
const TYPING = `#! ia 1.0

@check typing-check
  meaning
    says "Run an evaluator the payload catalog would have to list."
    answers "Which evaluator checks typing?"
  check
    runs acme-strict-typing
    scope "package"
  governance
    severity blocking
  relationships
    enforces @contract foundation-authoring-contract
`;
/** The native corpus (its learning-system authors the `@observation` word) with a check naming a foreign evaluator. */
function checked(): string {
  const root = temp();
  cpSync(NATIVE, resolve(root, '.ia/src'), { recursive: true });
  put(root, '.ia/src/systems/compliance-system/checks/typing-check.ia', TYPING);
  return root;
}
/** Every entry under `root` with its size, mtime and bytes: what a write anywhere would change. */
const snapshot = (root: string) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((entry) => {
      const stat = statSync(resolve(root, entry));
      return `${entry} ${stat.mtimeMs} ${stat.isFile() ? sha256(readFileSync(resolve(root, entry))) : 'directory'}`;
    });

it('binds checks through the joined catalog, so a payload without one leaves catalog checks unavailable (C15)', () => {
  const root = checked(),
    old = installed({ catalog: false });
  const checks = (trust: { home: string; release: string } | null) => {
    const session = openWorkspaceSession({ root, checks: 'structural' });
    try {
      return session.checks(trust);
    } finally {
      session.close();
    }
  };
  const byName = (result: ReturnType<typeof checks>) =>
    Object.fromEntries(result.results.map((row) => [row.name, row]));
  // A host registered with a payload that carries no catalog, as 2.0.0's does, records no join: unavailable, never
  // damaged, and the built-in check still binds.
  registered(root, 'claude', old.root, old.release);
  expect(joinHost(root, 'claude', REVISION).status).toBe('unavailable');
  const unjoined = checks(old.trust);
  expect(unjoined.catalog).toEqual({ status: 'unavailable', reason: expect.stringContaining('no host has joined') });
  expect(byName(unjoined)['typing-check']).toMatchObject({ status: 'unavailable', outcome: 'not-evaluated' });
  expect(byName(unjoined)['instance-schema-check']).toMatchObject({ status: 'bound', implementation: 'built-in' });
  // A receipt naming that payload anyway finds no catalog in it: still unavailable, not revoked.
  put(
    root,
    JOINS,
    json({
      format: 'ia.host-joins.v1',
      joins: [
        {
          consumer: 'claude',
          implementation: 'installed-implementations',
          version: '2.0.0',
          digest: 'e'.repeat(64),
          release: old.release,
          consumerRevision: REVISION,
        },
      ],
    }),
  );
  const listed = checks(old.trust);
  expect(listed.catalog).toEqual({ status: 'unavailable', reason: expect.stringContaining('carries no catalog') });
  expect(byName(listed)['typing-check']).toMatchObject({ status: 'unavailable' });
  // The current payload's catalog lists no evaluator: unavailable, with the reason. Damaged, it revokes the check.
  const current = installed();
  registered(root, 'claude', current.root, current.release);
  rmSync(resolve(root, JOINS));
  joinHost(root, 'claude', REVISION);
  expect(byName(checks(current.trust))['typing-check']).toMatchObject({
    status: 'unavailable',
    reason: 'the installed evaluator catalog lists no evaluator acme-strict-typing',
  });
  writeFileSync(resolve(current.root, MODULE), readFileSync(resolve(current.root, MODULE), 'utf8') + '// altered\n');
  expect(byName(checks(current.trust))['typing-check']).toMatchObject({ status: 'revoked' });
  // No trust: nothing binds through any join.
  expect(checks(null).catalog).toMatchObject({ status: 'unavailable' });
});

it('reads only in validation, bindings and checks; recordValidation is the one writer of evidence (C23)', () => {
  const root = checked();
  put(
    root,
    '.ia/src/systems/compliance-system/checks/whole-schema-check.ia',
    TYPING.replaceAll('typing-check', 'whole-schema-check')
      .replace('runs acme-strict-typing', 'runs COMP-SCHEMA')
      .replace('scope "package"', 'scope "*"'),
  );
  const before = snapshot(root);
  const session = openWorkspaceSession({ root, checks: 'structural' });
  try {
    expect(session.validation().status).toBe('admitted');
    session.bindings(null);
    const checks = session.checks(null);
    expect(snapshot(root)).toEqual(before);
    const written = recordValidation(session, checks);
    expect(written).toMatchObject({ written: true, observations: [{ verdict: 'success' }] });
    expect(existsSync(resolve(root, written.path!))).toBe(true);
  } finally {
    session.close();
  }
  // A session opened as every other command opens one reads no evidence and admits the unknown runner strictly.
  const plain = openWorkspaceSession({ root });
  try {
    expect(plain.validation().findings.map((finding) => finding.code)).toContain('IA-COMP-CHECK-UNKNOWN');
    expect(plain.reader.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(
      false,
    );
  } finally {
    plain.close();
  }
});

it('never lets a caller stand in for verification: a verifier hostVerifier did not make is ignored (B2-N6)', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  writeFileSync(resolve(cache, MODULE), readFileSync(resolve(cache, MODULE), 'utf8') + '// altered\n');
  // A function that claims every payload verifies, typed past the brand as a JavaScript caller could pass it.
  const claims = vi.fn(() => ({ release, format: 2, files: new Map(), directory: cache })) as unknown as HostVerifier;
  expect(() => readInstalledImplementations(cache, release, claims)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  expect(observeHosts(root, release, claims)[0]).toMatchObject({ host: 'claude' });
  expect(vi.mocked(claims)).not.toHaveBeenCalled();
});

const PROBE_BINDING = `#! ia 1.0

@execution-binding probe-read-binding
  meaning
    says "Select the test payload's read handler."
    answers "What does an execution binding join against?"
  binding
    kind operation
    implementation read-v1
`;
it('binds a deleted handler as unavailable and a catalog-declared revocation as revoked, through the session (B2-N4)', () => {
  const root = checked();
  put(root, '.ia/src/systems/agent-composition-system/records/probe-read-binding.ia', PROBE_BINDING);
  const bindings = (trust: { home: string; release: string }) => {
    const session = openWorkspaceSession({ root });
    try {
      return session.bindings(trust);
    } finally {
      session.close();
    }
  };
  const current = installed();
  registered(root, 'claude', current.root, current.release);
  joinHost(root, 'claude', REVISION);
  expect(bindings(current.trust).results).toEqual([expect.objectContaining({ status: 'bound' })]);
  // Only the handler module deleted: the payload is incomplete, which is not changed bytes, so nothing binds and
  // nothing is revoked either.
  rmSync(resolve(current.root, MODULE));
  const deleted = bindings(current.trust);
  expect(deleted.catalog).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('IA-DIST-ARTIFACT-UNAVAILABLE: Host payload is incomplete'),
  });
  expect(deleted.results).toEqual([expect.objectContaining({ status: 'unavailable' })]);
  // An intact catalog that revokes the implementation: revoked, an error, with the producer's reason.
  const withdrawn = installed({
    mutate: () => ({ id: 'read-v1', status: 'revoked', reason: 'withdrawn by its producer' }),
  });
  registered(root, 'claude', withdrawn.root, withdrawn.release);
  joinHost(root, 'claude', REVISION);
  expect(bindings(withdrawn.trust).results).toEqual([
    expect.objectContaining({
      status: 'revoked',
      reason: 'the installed catalog revokes read-v1: withdrawn by its producer',
    }),
  ]);
});

it('takes a session open time before it reads any input, so it never prunes what another run touched since (B4-RC3, F3)', () => {
  const root = checked(),
    clock = Date.now.bind(Date);
  let readsBefore = -1;
  const now = vi.spyOn(Date, 'now');
  try {
    const { result: session } = watched(root, (calls) => {
      now.mockImplementation(() => {
        if (readsBefore < 0) readsBefore = calls.length;
        return clock();
      });
      return openWorkspaceSession({ root, checks: 'structural' });
    });
    session.close();
    expect(readsBefore).toBe(0);
  } finally {
    now.mockRestore();
  }
});
