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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';

const ROOTS = ['apps/cli', 'apps/distribution', 'apps/mcp-door', 'apps/steward-hook'];
/** Imported only by the private service bridge (apps/mcp-door/src/service*.ts); the public door never loads them. */
export const EXCLUDED = new Set(['@modelcontextprotocol/client', '@inventarch/service-contracts']);
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
/** The CLI under its public name and its private-staging name (tools/release/private.mjs), as in tools/dependencies/check.ts. */
const CLI = new Set(['@inventarch/cli', '@inventarch/inventarch-cli']);
// Package spellings are projected with the manifest namespace. Regex literals containing an escaped scope
// do not undergo that projection; keep these exact omitted-owner names as ordinary string literals.
const OMITTED_PACKAGES = [
  '@inventarch/architecture-system',
  '@inventarch/code-quality-system',
  '@inventarch/monorepo-kit-host',
];
const omittedTarget = (text) =>
  /inventarch-development|development-native/.test(text) || OMITTED_PACKAGES.some((name) => text.includes(name));
/** The offline launcher does not expose the separately qualified private development host. */
export function staticCliManifest(input) {
  const metadata = structuredClone(input);
  if (!CLI.has(metadata.name) || metadata.exports?.['./development'] === undefined) return metadata;
  const entry = metadata.exports['./development'];
  const peer = '@inventarch/monorepo-kit-host';
  if (
    JSON.stringify(Object.keys(entry).sort()) !== '["default","types"]' ||
    entry.default !== './dist/inventarch-development/index.js' ||
    entry.types !== './dist/inventarch-development/index.d.ts' ||
    JSON.stringify(metadata.peerDependencies) !== JSON.stringify({ [peer]: '0.1.0' }) ||
    JSON.stringify(metadata.peerDependenciesMeta) !== JSON.stringify({ [peer]: { optional: true } }) ||
    Object.keys(metadata.optionalDependencies ?? {}).length ||
    metadata.dependencies?.['@inventarch/architecture-system'] !== 'workspace:*' ||
    metadata.dependencies?.['@inventarch/code-quality-system'] !== 'workspace:*'
  )
    throw Error('Unreviewed private development payload boundary');
  delete metadata.exports['./development'];
  delete metadata.peerDependencies;
  delete metadata.peerDependenciesMeta;
  delete metadata.devDependencies?.[peer];
  delete metadata.dependencies['@inventarch/architecture-system'];
  delete metadata.dependencies['@inventarch/code-quality-system'];
  const targets = JSON.stringify({
    exports: metadata.exports,
    main: metadata.main,
    bin: metadata.bin,
    imports: metadata.imports,
  });
  if (omittedTarget(targets)) throw Error('Retained manifest target reaches the omitted development capability');
  return metadata;
}
/** Conservative coupling check; the ordinary dependency gate separately rejects nonliteral runtime imports. */
export function assertStaticPayloadCode(path, bytes) {
  if (/\.[cm]?js$/.test(path) && omittedTarget(bytes.toString('utf8')))
    throw Error('Static payload code reaches the omitted development capability: ' + path);
}
/**
 * Node's node_modules walk from the dependent's own directory. pnpm links every declared dependency, workspace or
 * store, into the dependent's node_modules (store packages see their dependencies as siblings), so no exports map
 * is consulted: some packages expose neither "." nor "./package.json".
 */
function manifestDir(name, from) {
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
    if (dirname(candidate) === candidate) throw Error('Installed package manifest unavailable: ' + name);
  }
}
/** The assembler's copy filter (tools/distribution/assemble-host.mjs:79) plus the payload's self-exclusion. */
export async function collectPayload(repository) {
  const files = new Map(),
    packages = new Map();
  const bundle = (dir) => {
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
      if (!EXCLUDED.has(dependency)) bundle(manifestDir(dependency, dir));
  };
  for (const root of ROOTS) bundle(resolve(repository, root));
  return { files, packages: [...packages.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
}
export async function generateHostPayload({ repository, write }) {
  const { packTree, HOST_TREE_LIMITS } = await import(
    pathToFileURL(resolve(repository, 'apps/distribution/dist/ustar.js')).href
  );
  const { files, packages } = await collectPayload(repository),
    runtimeBytes = [...files.values()].reduce((sum, b) => sum + b.length, 0);
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
  return { pin, archive };
}
if (isEntry(process.argv[1], import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write') throw Error('Usage: host-payload.mjs --write');
  const { pin } = await generateHostPayload({
    repository: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    write: true,
  });
  console.log(JSON.stringify(pin));
}
