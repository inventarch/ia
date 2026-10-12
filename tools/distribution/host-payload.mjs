// Spec §3.2 (amended): the host payload @inventarch/cli carries, generated from the workspace's built packages.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isEntry } from '../entry/is-entry.mjs';

const ROOTS = ['apps/cli', 'apps/distribution', 'apps/mcp-door', 'apps/steward-hook'];
/** Imported only by the private service bridge (apps/mcp-door/src/service*.ts); the public door never loads them. */
export const EXCLUDED = new Set(['@modelcontextprotocol/client', '@inventarch/service-contracts']);
/**
 * Plan amendments C16 and C24 (milestone generation-binding): the first-party installed operation implementations
 * whose executable handler bytes the payload ships, each a payload root beside ROOTS. Each names its implementation
 * id, the installed package that holds the handler, the handler's built module inside it and the module export that
 * declares it. The package is resolved from the repository's own node_modules, never an enclosing directory's, and bundled with its declared
 * dependency closure; the declaration is imported here, by the producer, and never by a host app
 * (tools/dependencies/check.ts). An implementation whose package or module is not there is listed as unavailable.
 */
export const IMPLEMENTATIONS = Object.freeze([
  Object.freeze({
    id: 'captured-source-read-v1',
    package: '@inventarch/agent-composition-system',
    module: 'dist/installed-read.js',
    declaration: 'installedReadCatalog',
  }),
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
/** Spec §3.2: the runtime closure ceiling; inventory.json, scripts/ia.mjs and release.json are not counted. */
export const PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Drops every "development" condition: it points at sources the payload does not carry. */
const released = (value) =>
  value === null || typeof value !== 'object'
    ? value
    : Array.isArray(value)
      ? value.map(released)
      : Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'development')
            .map(([key, entry]) => [key, released(entry)]),
        );
/** The public CLI is the only launcher root; retired staging aliases are not accepted. */
const CLI = new Set(['@inventarch/cli']);
const OMITTED_PACKAGES = [
  '@inventarch/architecture-system',
  '@inventarch/code-quality-system',
  '@inventarch/monorepo-kit-host',
];
const omittedTarget = (text) =>
  /inventarch-development|development-native/.test(text) || OMITTED_PACKAGES.some((name) => text.includes(name));
/** Public manifests must already express the complete public payload; the packer does not rewrite capability authority. */
export function staticCliManifest(input) {
  const metadata = structuredClone(input);
  if (omittedTarget(JSON.stringify(metadata))) throw Error('Public payload manifest reaches an omitted capability');
  return metadata;
}
/** Conservative coupling check; the ordinary dependency gate separately rejects nonliteral runtime imports. */
export function assertStaticPayloadCode(path, bytes) {
  if (/\.[cm]?js$/.test(path) && omittedTarget(bytes.toString('utf8')))
    throw Error('Static payload code reaches the omitted development capability: ' + path);
}
/** Whether `child` is `parent` or under it, compared as the platform's volumes compare names. */
const under = (parent, child) => {
  const key = (path) => (process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path);
  const rest = relative(key(parent), key(child));
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
};
/**
 * Node's node_modules walk from the dependent's own directory. pnpm links every declared dependency, workspace or
 * store, into the dependent's node_modules (store packages see their dependencies as siblings), so no exports map
 * is consulted: some packages expose neither "." nor "./package.json". With a `ceiling` (review finding B-RC2, for an
 * implementation's closure) the walk stays inside it: a dependency found only above the repository's own install fails
 * the build (review finding B3-N9) rather than being shipped and imported from wherever an enclosing directory holds one.
 */
function manifestDir(name, from, ceiling = null) {
  if (ceiling !== null && !under(ceiling, from))
    throw Error('Installed package outside the repository install: ' + name);
  for (let candidate = from; ; candidate = dirname(candidate)) {
    if (basename(candidate) !== 'node_modules') {
      // Resolve the dependency directory before its relative package links. Windows fixtures may
      // reach this directory through a junction on a different drive from the installed workspace.
      const modules = join(candidate, 'node_modules');
      const path = existsSync(modules) ? join(realpathSync(modules), name, 'package.json') : null;
      if (path && existsSync(path)) {
        const dir = realpathSync(dirname(path));
        if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name)
          throw Error('Installed package manifest names another package: ' + name);
        return dir;
      }
    }
    if (dirname(candidate) === candidate || (ceiling !== null && !under(ceiling, dirname(candidate))))
      throw Error('Installed package manifest unavailable: ' + name);
  }
}
/**
 * Review finding B-N3: an implementation package as the repository itself installs it, in `<repository>/node_modules`
 * and nowhere above, or null. Walking up as `manifestDir` does would ship, and import at build time, whatever package of
 * that name an enclosing directory happens to hold.
 */
function repositoryPackageDir(name, repository) {
  const modules = join(repository, 'node_modules');
  if (!existsSync(modules)) return null;
  const path = join(realpathSync(modules), name, 'package.json');
  if (!existsSync(path)) return null;
  const dir = realpathSync(dirname(path));
  if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name)
    throw Error('Installed package manifest names another package: ' + name);
  return dir;
}
/**
 * The assembler's copy filter (tools/distribution/assemble-host.mjs:79) plus the payload's self-exclusion. Each of
 * `implementations` is located and, when its handler module is built, bundled as a further root; the located rows say
 * why one is not shipped.
 */
export async function collectPayload(repository, implementations = IMPLEMENTATIONS) {
  const files = new Map(),
    packages = new Map();
  const bundle = (dir, ceiling = null) => {
    const original = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
      metadata = staticCliManifest(original),
      name = metadata.name;
    const developmentOmitted =
      original.exports?.['./development'] !== undefined && metadata.exports?.['./development'] === undefined;
    // The payload must not depend on the caller's Node conditions (NODE_OPTIONS=--conditions=development), so @ia manifests ship without them.
    const manifest = name.startsWith('@inventarch/')
        ? Buffer.from(
            json(metadata.exports === undefined ? metadata : { ...metadata, exports: released(metadata.exports) }),
          )
        : readFileSync(join(dir, 'package.json')),
      digest = hash(manifest);
    const previous = packages.get(name);
    if (previous) {
      if (previous.version !== metadata.version || previous.manifestDigest !== digest)
        throw Error('Conflicting runtime package versions: ' + name);
      return;
    }
    if (packages.size >= 64) throw Error('Runtime package ceiling of 64 exceeded at ' + name);
    if (Object.keys(metadata.optionalDependencies ?? {}).length || Object.keys(metadata.peerDependencies ?? {}).length)
      throw Error('Optional/peer runtime requires a separately qualified profile: ' + name);
    const notices = readdirSync(dir)
      .filter((n) => /^(?:licen[cs]e|notice|copying)(?:[.-]|$)/i.test(n))
      .sort();
    packages.set(name, {
      name,
      version: metadata.version,
      manifestDigest: digest,
      license: metadata.license ?? 'UNSPECIFIED',
      notices,
    });
    // Preserve only literal public documentation selected by the package's shipped file list.
    // Adding a references directory wholesale would admit private teaching from the producer tree.
    const documentation = new Set(
      (metadata.files ?? []).filter((path) => /^(?:LANGUAGE\.md|references\/[A-Za-z0-9_.-]+\.md)$/.test(path)),
    );
    const keep = name.startsWith('@inventarch/')
      ? new Set([
          'dist',
          'assets',
          'package.json',
          'README.md',
          'SPEC.md',
          ...notices,
          ...[...documentation].map((path) => path.split('/')[0]),
        ])
      : null;
    const visit = (rel = '') => {
      for (const entry of readdirSync(join(dir, rel)).sort()) {
        const path = rel ? rel + '/' + entry : entry,
          top = path.split('/')[0];
        if (top === 'node_modules' || (keep && !keep.has(top))) continue;
        if (
          keep &&
          top === 'references' &&
          !documentation.has(path) &&
          ![...documentation].some((selected) => selected.startsWith(path + '/'))
        )
          continue;
        if (CLI.has(name) && (path === 'assets/host' || path.startsWith('assets/host/') || path === 'assets/host.json'))
          continue;
        if (
          developmentOmitted &&
          (path === 'dist/inventarch-development' ||
            path.startsWith('dist/inventarch-development/') ||
            path === 'assets/development-native' ||
            path.startsWith('assets/development-native/') ||
            path === 'assets/development-native.json')
        )
          continue;
        const stat = lstatSync(join(dir, path));
        if (stat.isSymbolicLink()) throw Error('Package links are unsupported: ' + name + '/' + path);
        if (stat.isDirectory()) visit(path);
        else if (stat.isFile()) {
          const bytes = path === 'package.json' ? manifest : readFileSync(join(dir, path));
          assertStaticPayloadCode(path, bytes);
          files.set(`runtime/node_modules/${name}/${path}`, bytes);
        } else throw Error('Package contains a special file: ' + name + '/' + path);
      }
    };
    visit();
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort())
      if (!EXCLUDED.has(dependency)) bundle(manifestDir(dependency, dir, ceiling), ceiling);
  };
  for (const root of ROOTS) bundle(resolve(repository, root));
  const located = implementations.map((implementation) => {
    const dir = repositoryPackageDir(implementation.package, repository);
    if (dir === null)
      return { ...implementation, dir, reason: `${implementation.package} is not installed in this repository` };
    if (statSync(join(dir, implementation.module), { throwIfNoEntry: false })?.isFile() !== true)
      return { ...implementation, dir, reason: `${implementation.package} has no built ${implementation.module}` };
    // B-RC2: the closure resolves inside the repository install that holds the implementation package, never above it.
    bundle(dir, dirname(realpathSync(join(repository, 'node_modules'))));
    return { ...implementation, dir, reason: null };
  });
  return {
    files,
    packages: [...packages.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    implementations: located,
  };
}
const PACKAGE_PATH = /^runtime\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
/** The bare specifier's package name: `@scope/name` or `name`. */
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
/** An @inventarch manifest's released export target for `subpath` ("." or "./x"): its string, or its `default`. */
function exportTarget(manifest, subpath) {
  const entry = manifest.exports === undefined ? undefined : manifest.exports[subpath];
  if (manifest.exports === undefined && subpath === '.') return manifest.main ?? 'index.js';
  if (typeof entry === 'string') return entry;
  return entry !== null && typeof entry === 'object' && typeof entry.default === 'string' ? entry.default : undefined;
}
/**
 * The installed packages `name`'s shipped manifests declare, transitively and without EXCLUDED, read from the payload
 * files themselves; a reason string when one of them is not shipped.
 */
export function packageClosure(files, name) {
  const found = new Set(),
    queue = [name];
  while (queue.length) {
    const next = queue.pop();
    if (found.has(next)) continue;
    const manifest = files.get(`runtime/node_modules/${next}/package.json`);
    if (manifest === undefined) return `its dependency ${next} is not shipped`;
    found.add(next);
    for (const dependency of Object.keys(JSON.parse(manifest.toString('utf8')).dependencies ?? {}))
      if (!EXCLUDED.has(dependency)) queue.push(dependency);
  }
  return [...found].sort();
}
/**
 * C24: the handler's static module closure within the payload files, from `start`. Every literal import, export-from,
 * dynamic import and require in a reached module is followed: a relative one to the payload file it names, an
 * @inventarch package through its shipped manifest's released exports. A third-party package is a leaf, reached when
 * its manifest is shipped (it is bundled whole). Node built-ins are skipped. Returns the reached payload paths, the
 * packages they lie in and every path or package that is not shipped.
 */
export function moduleClosure(files, start) {
  const reached = new Set(),
    packages = new Set(),
    missing = new Set(),
    queue = [start];
  while (queue.length) {
    const path = queue.pop();
    if (reached.has(path)) continue;
    const bytes = files.get(path);
    if (bytes === undefined) {
      missing.add(path);
      continue;
    }
    reached.add(path);
    const owner = PACKAGE_PATH.exec(path)?.[1];
    if (owner !== undefined) packages.add(owner);
    for (const { fileName: specifier } of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(posix.join(posix.dirname(path), specifier));
        continue;
      }
      const name = packageName(specifier),
        manifest = files.get(`runtime/node_modules/${name}/package.json`);
      if (manifest === undefined) {
        missing.add(`runtime/node_modules/${name}/package.json`);
        continue;
      }
      packages.add(name);
      if (!name.startsWith('@inventarch/')) continue;
      const subpath = '.' + specifier.slice(name.length),
        target = exportTarget(JSON.parse(manifest.toString('utf8')), subpath);
      if (target === undefined) missing.add(`${name} export ${subpath}`);
      else queue.push(posix.join(`runtime/node_modules/${name}`, target));
    }
  }
  return { reached: [...reached].sort(), packages: [...packages].sort(), missing: [...missing].sort() };
}
/**
 * C24: one catalog row for a located implementation (`collectPayload`). It is available only when the payload ships
 * its handler module and every module the handler reaches lies in the package closure the payload ships, and when the
 * module, imported here by the producer at build time, declares the implementation; the row then pins the SHA-256 of
 * the shipped module bytes and names that package closure, whose other bytes the payload inventory pins (review finding
 * B-N5). Otherwise it is unavailable, with the reason. A module that is shipped but does not declare its implementation
 * is a producer error, never a row.
 */
export async function operationRow(implementation, files) {
  const unavailable = (reason) => ({ id: implementation.id, status: 'unavailable', reason });
  if (implementation.reason !== null) return unavailable(implementation.reason);
  const module = `runtime/node_modules/${implementation.package}/${implementation.module}`,
    bytes = files.get(module);
  if (bytes === undefined) return unavailable(`the payload does not ship ${implementation.module}`);
  const packages = packageClosure(files, implementation.package);
  if (typeof packages === 'string') return unavailable(packages);
  const reach = moduleClosure(files, module);
  if (reach.missing.length) return unavailable(`its handler module closure lacks ${reach.missing[0]}`);
  const outside = reach.packages.find((name) => !packages.includes(name));
  if (outside !== undefined) return unavailable(`its handler module imports ${outside}, outside its package closure`);
  const source = join(implementation.dir, implementation.module);
  const declare = (await import(pathToFileURL(source).href))[implementation.declaration];
  const entry = typeof declare === 'function' ? declare().operations?.[implementation.id] : undefined;
  if (
    entry === undefined ||
    !Number.isSafeInteger(entry.version) ||
    entry.value === null ||
    typeof entry.value !== 'object' ||
    !['identity', 'handler', 'input', 'output'].every((key) => typeof entry.value[key] === 'string')
  )
    throw Error(
      `${implementation.package}/${implementation.module} does not declare installed operation ${implementation.id}`,
    );
  if (hash(readFileSync(source)) !== hash(bytes))
    throw Error('Handler module changed while the payload was built: ' + module);
  return {
    id: implementation.id,
    status: 'available',
    version: entry.version,
    operation: entry.value.identity,
    handler: entry.value.handler,
    input: entry.value.input,
    output: entry.value.output,
    module,
    digest: hash(bytes),
    packages,
  };
}
/**
 * The file URL of a module in the repository's own distribution app, by its real path. A staged repository links its
 * apps (junctions on Windows), and a module imported through the link would resolve its bare imports, such as
 * `@inventarch/db`, beside the link rather than beside the real file. On the Windows CI runner it did; there the
 * checkout and the temp directory are on different volumes.
 */
const distributionModule = (repository, name) =>
  pathToFileURL(realpathSync.native(resolve(repository, 'apps/distribution/dist', name))).href;
/**
 * The payload, its pin and its installed-implementation catalog (C16), which lists every one of `implementations` by
 * id: available with its shipped handler pins, or unavailable with the reason (C24). The catalog is generated here and
 * inventoried like every other payload file, since `verifyHostCache` refuses an uninventoried one. Its evaluators
 * section is an `ia-evaluator-catalog/1.0` with no installed entries: the built-ins are implicit, as that format
 * requires, and no installed evaluator exists yet.
 */
export async function generateHostPayload({ repository, write, implementations = IMPLEMENTATIONS }) {
  const { packTree, HOST_TREE_LIMITS } = await import(distributionModule(repository, 'ustar.js'));
  const { installedImplementationsValue } = await import(distributionModule(repository, 'implementations.js'));
  const { files, packages, implementations: located } = await collectPayload(repository, implementations);
  const operations = [];
  for (const implementation of [...located].sort((a, b) => (a.id < b.id ? -1 : 1)))
    operations.push(await operationRow(implementation, files));
  const catalog = installedImplementationsValue({
    format: 'ia.installed-implementations.v1',
    evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
    operations,
  });
  files.set('implementations.json', Buffer.from(json(catalog)));
  const runtimeBytes = [...files.values()].reduce((sum, b) => sum + b.length, 0);
  if (runtimeBytes > PAYLOAD_BYTES)
    throw Error(`Runtime closure of ${runtimeBytes} bytes exceeds the ${PAYLOAD_BYTES}-byte payload ceiling`);
  const version = JSON.parse(readFileSync(resolve(repository, 'apps/cli/package.json'), 'utf8')).version;
  const inventory = json({
    format: 'ia.host-cache.v2',
    version,
    packages,
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
  });
  const launcher = readFileSync(resolve(repository, 'apps/distribution/assets/host-launcher.mjs'), 'utf8').replace(
    '__INVENTORY_DIGEST__',
    hash(inventory),
  );
  const release = json({ format: 'ia.host-release.v2', inventory: hash(inventory), launcher: hash(launcher) });
  const tree = new Map([
    ...files,
    ['inventory.json', Buffer.from(inventory)],
    ['scripts/ia.mjs', Buffer.from(launcher)],
    ['release.json', Buffer.from(release)],
  ]);
  const archive = packTree(tree, HOST_TREE_LIMITS),
    bytes = [...tree.values()].reduce((sum, b) => sum + b.length, 0);
  const pin = { release: hash(release), archive: hash(archive), files: tree.size, bytes };
  if (write) {
    const assets = resolve(repository, 'apps/cli/assets'),
      folder = resolve(assets, 'host');
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(resolve(folder, pin.archive + '.tgz'), archive);
    writeFileSync(resolve(assets, 'host.json'), json(pin));
  }
  return { pin, archive, catalog };
}
if (isEntry(process.argv[1], import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write') throw Error('Usage: host-payload.mjs --write');
  const { pin, catalog } = await generateHostPayload({
    repository: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    write: true,
  });
  // An implementation the payload cannot ship is listed as unavailable in the catalog, and said here, not hidden.
  for (const operation of catalog.operations)
    if (operation.status === 'unavailable')
      console.error(`Installed operation ${operation.id} is unavailable in this payload: ${operation.reason}`);
  console.log(JSON.stringify(pin));
}
