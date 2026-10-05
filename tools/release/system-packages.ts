import '../temp/physical-temp.mjs';
/** Receipt-bound public system packaging. Native ownership is never inferred from executable exports. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { readInputs } from '@inventarch/db';
import { decodeDistributionLock } from '@inventarch/db/distribution';
import { distributionSnapshot, packSnapshotSet } from '../../apps/distribution/src/snapshot.js';
import { contained } from '../../apps/distribution/src/files.js';
import { isEntry } from '../entry/is-entry.mjs';
import { child } from './shared/paths.mjs';
import { systemArchivePartitions, type NativeSystemOwner } from './system-partitions.js';
import {
  verifySystemPackage,
  SYSTEM_PACKAGE_FORMAT,
  OWNED_SYSTEM_PACKAGE_FORMAT,
  SYSTEM_NATIVE_PATH,
  SYSTEM_BINDING_PATH,
  SYSTEM_SELECTION_PATH,
} from '../../apps/distribution/src/system-package.js';
import type { SystemPackageBinding, OwnedSystemPackageBinding } from '../../apps/distribution/src/system-package.js';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const INTERNAL_SCOPE = '@' + 'ia/';
const versions = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export {
  verifySystemPackage,
  SYSTEM_PACKAGE_FORMAT,
  OWNED_SYSTEM_PACKAGE_FORMAT,
  SYSTEM_NATIVE_PATH,
  SYSTEM_BINDING_PATH,
  SYSTEM_SELECTION_PATH,
};
export type { SystemPackageBinding };
interface FilePin {
  readonly path: string;
  readonly sha256: string;
}
interface PublicReceipt {
  readonly sourceRevision: string;
  readonly files: readonly FilePin[];
}
interface PackagePolicy {
  readonly format: 'ia.system-package-policy.v2';
  readonly packages: readonly string[];
  readonly owners: readonly {
    readonly owner: string;
    readonly kind: 'compiled' | 'native-only';
    readonly npmVersion: string;
    readonly native: NativeSystemOwner;
  }[];
}
function file(root: string, path: string): Buffer {
  const target = contained(root, path);
  let current = resolve(root);
  if (lstatSync(current).isSymbolicLink()) throw new Error('System package root is aliased');
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('System package input is aliased: ' + path);
  }
  if (!lstatSync(target).isFile()) throw new Error('System package input is not a regular file: ' + path);
  return readFileSync(target);
}
function codeFiles(root: string): readonly FilePin[] {
  const files: FilePin[] = [];
  const visit = (path: string): void => {
    const target = contained(root, path),
      stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('System package code is aliased');
    if (stat.isDirectory()) for (const name of readdirSync(target).sort(order)) visit(path + '/' + name);
    else if (stat.isFile() && ![SYSTEM_NATIVE_PATH, SYSTEM_BINDING_PATH, SYSTEM_SELECTION_PATH].includes(path))
      files.push({ path, sha256: sha(file(root, path)) });
    else if (!stat.isFile()) throw new Error('System package code is not regular');
  };
  visit('dist');
  return files.sort((a, b) => order(a.path, b.path));
}
interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly files: readonly string[];
  exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  scripts?: Readonly<Record<string, string>>;
  readonly publishConfig?: { exports?: unknown; readonly access?: string; readonly registry?: string };
  readonly [key: string]: unknown;
}
/** Resolve only the reviewed pack controls before pinning final npm bytes. Unknown pack behavior refuses. */
export function ownedPackageInputs(
  root: string,
  source: PackageManifest,
  readOwned: (path: string) => Buffer,
  catalog: Readonly<Record<string, string>> = {},
): { manifest: PackageManifest; payload: ReadonlyMap<string, Buffer> } {
  const manifest = structuredClone(source);
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.includes('dist') ||
    manifest.files.some(
      (path: unknown) =>
        typeof path !== 'string' ||
        !path ||
        /[!*?\[\]{}()]/.test(path) ||
        path.startsWith('.') ||
        path.split('/').includes('node_modules'),
    )
  )
    throw new Error('System package requires an exact positive files list');
  for (const key of ['bundledDependencies', 'bundleDependencies', 'directories', 'pnpm', 'packageManager'])
    if (Object.hasOwn(manifest, key)) throw new Error('Unsupported system package pack control: ' + key);
  for (const key of ['prepublishOnly', 'prepack', 'postpack', 'prepare', 'publish', 'postpublish'])
    if (Object.hasOwn(manifest.scripts ?? {}, key))
      throw new Error('System package packing cannot execute lifecycle scripts');
  if (manifest.publishConfig !== undefined) {
    if (
      !manifest.publishConfig ||
      typeof manifest.publishConfig !== 'object' ||
      Array.isArray(manifest.publishConfig) ||
      Object.keys(manifest.publishConfig).some((key) => !['exports', 'access', 'registry'].includes(key))
    )
      throw new Error('Unsupported system package publishConfig');
    if (Object.hasOwn(manifest.publishConfig, 'exports')) manifest.exports = manifest.publishConfig.exports;
    delete manifest.publishConfig.exports;
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      throw new Error('Invalid system package dependency section');
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') throw new Error('Invalid system package dependency');
      if (value.startsWith('catalog:')) {
        if (
          value !== 'catalog:' ||
          typeof catalog[name] !== 'string' ||
          /^(catalog|workspace|jsr):/.test(catalog[name]!)
        )
          throw new Error('Unresolved system package catalog dependency');
        (dependencies as Record<string, string>)[name] = catalog[name]!;
      } else if (/^(workspace|jsr):/.test(value)) throw new Error('Unresolved system package dependency protocol');
    }
  }
  // The pinned pnpm packer moves surviving scripts after the other manifest fields.
  if (manifest.scripts !== undefined) {
    const scripts = manifest.scripts;
    delete manifest.scripts;
    manifest.scripts = scripts;
  }
  for (const name of ['.npmignore', '.gitignore'])
    if (existsSync(contained(root, name))) throw new Error('Unsupported system package ignore control');
  const payload = new Map<string, Buffer>();
  const visit = (path: string): void => {
    const target = contained(root, path);
    if (path.split('/').some((part) => ['node_modules', '.npmignore', '.gitignore'].includes(part)))
      throw new Error('Unsupported system package payload control');
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('System package payload is aliased');
    if (stat.isDirectory()) for (const name of readdirSync(target).sort(order)) visit(path + '/' + name);
    else if (!stat.isFile()) throw new Error('System package payload is not regular');
    else if (!['package.json', SYSTEM_BINDING_PATH, SYSTEM_NATIVE_PATH, SYSTEM_SELECTION_PATH].includes(path))
      payload.set(path, path.startsWith('dist/') ? file(root, path) : readOwned(path));
  };
  // npm includes these root documents even when they are absent from package.files.
  const automatic = readdirSync(root).filter((path) => /^(readme|licen[cs]e)(?:$|\.)/i.test(path));
  for (const path of new Set<string>([...manifest.files, ...automatic])) {
    const target = contained(root, path);
    if (existsSync(target)) visit(path);
  }
  return { manifest, payload: new Map([...payload].sort(([a], [b]) => order(a, b))) };
}
/** Verify the exact package view, never a workspace tree containing sources or dependency links. */
function verifyPreparedPackage(
  inputs: ReadonlyMap<string, Buffer>,
  pin: string,
  archives: ReadonlyMap<string, Uint8Array>,
): void {
  const parent = resolve(tmpdir()),
    scratch = mkdtempSync(resolve(parent, 'ia-system-package-view-'));
  if (dirname(scratch) !== parent) throw new Error('Unsafe system package view cleanup');
  try {
    for (const [path, bytes] of inputs) {
      const target = contained(scratch, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    verifySystemPackage(scratch, pin, { archives });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
/** Positive source selection, exact owned systems and selected teaching closure are required together. */
export function bundleSystemPackages(
  root: string,
  receipt: PublicReceipt,
  policy: PackagePolicy,
): readonly { owner: string; bindingSha256: string; binding: OwnedSystemPackageBinding }[] {
  if (
    policy.format !== 'ia.system-package-policy.v2' ||
    !/^[a-f0-9]{40,64}$/.test(receipt.sourceRevision) ||
    new Set(policy.packages).size !== policy.packages.length ||
    json(policy.packages) !== json(policy.owners.map((row) => row.owner))
  )
    throw new Error('Invalid system package policy or source revision');
  const selected = new Map(receipt.files.map((row) => [row.path, row.sha256]));
  if (selected.size !== receipt.files.length) throw new Error('Duplicate public receipt path');
  const pinned = (path: string): Buffer => {
    const bytes = file(root, path);
    if (sha(bytes) !== selected.get(path))
      throw new Error('System package input is absent or changed in public receipt: ' + path);
    return bytes;
  };
  for (const path of selected.keys()) if (path.startsWith('.ia/src/') && path.endsWith('.ia')) pinned(path);
  const workspace = parse(pinned('pnpm-workspace.yaml').toString('utf8')) as {
    catalog?: Readonly<Record<string, string>>;
  };
  const before = readInputs(root);
  for (const source of before.sources.filter((row) => row.location.placement.kind !== 'floor'))
    if (selected.get(source.path) !== sha(source.text)) throw new Error('Native source escaped positive input receipt');
  const resources = JSON.parse(pinned('.ia/authoring.resources.json').toString('utf8')) as {
    files: readonly FilePin[];
  };
  const assets = new Map(
    ['LICENSE', 'NOTICE', ...resources.files.map((row) => row.path)].map((path) => [path, pinned(path)]),
  );
  const snapshot = distributionSnapshot({
    sources: before.sources,
    folders: before.folders,
    floorOrigin: before.floorOrigin,
  });
  const partitions = systemArchivePartitions(
    snapshot,
    resources,
    assets,
    policy.owners.map((row) => row.native),
  );
  const packed = packSnapshotSet(snapshot, partitions);
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: packed
      .map((row) => ({ id: row.manifest.id, range: row.manifest.version }))
      .sort((a, b) => order(a.id, b.id)),
    packages: packed
      .map((row) => ({
        id: row.manifest.id,
        version: row.manifest.version,
        archive: row.archiveDigest,
        manifest: row.manifestDigest,
        location: 'sha256:' + row.archiveDigest,
        dependencies: row.manifest.dependencies.map((dependency) => dependency.id),
      }))
      .sort((a, b) => order(a.id, b.id)),
  });
  const selectionBytes = json(lock),
    archives = new Map(packed.map((row) => [row.archiveDigest, row.bytes]));
  const prepared = policy.owners.map((entry, index) => {
    const owner = entry.owner,
      native = packed[index]!;
    if (
      !/^\.ia\/src\/systems\/[a-z][a-z0-9-]*$/.test(owner) ||
      owner !== '.ia/src/systems/' + entry.native.system ||
      !versions.test(entry.npmVersion) ||
      !versions.test(entry.native.version) ||
      !['compiled', 'native-only'].includes(entry.kind)
    )
      throw new Error('Unreviewed system package owner or version');
    if (!selected.has(owner + '/package.json')) throw new Error('System package owner is outside public selection');
    for (const row of native.manifest.files)
      if (row.path !== '.ia/authoring.resources.json' && selected.get(row.path) !== row.sha256)
        throw new Error('Native bundle escaped receipt-selected bytes: ' + row.path);
    if (native.manifest.systems.length !== 1 || native.manifest.systems[0]!.name !== entry.native.system)
      throw new Error('Native archive contains another system owner');
    const folder = child(root, owner),
      sourcePackage = JSON.parse(file(folder, 'package.json').toString('utf8'));
    const preparedInputs = ownedPackageInputs(
      folder,
      sourcePackage,
      (path) => pinned(owner + '/' + path),
      workspace.catalog,
    );
    const pkg = { ...preparedInputs.manifest, dependencies: { ...preparedInputs.manifest.dependencies } };
    if (pkg.scripts !== undefined) {
      const scripts = pkg.scripts;
      delete pkg.scripts;
      pkg.scripts = scripts;
    }
    const system = native.manifest.systems[0]!;
    if (pkg.name !== '@inventarch/' + system.name || pkg.version !== entry.npmVersion)
      throw new Error('Package differs from its explicit owner/version policy');
    for (const dependency of native.manifest.dependencies) {
      const target = policy.owners.find((row) => row.native.id === dependency.id);
      if (!target || dependency.range !== target.native.version)
        throw new Error('Unknown native dependency owner/version');
      const name = '@inventarch/' + target.native.system;
      if (Object.hasOwn(pkg.dependencies, name) && pkg.dependencies[name] !== target.npmVersion)
        throw new Error('Compiled and native dependency versions conflict');
      pkg.dependencies[name] = target.npmVersion;
    }
    for (const [name, value] of Object.entries(pkg.dependencies))
      if (
        name.startsWith(INTERNAL_SCOPE) ||
        typeof value !== 'string' ||
        (name.startsWith('@inventarch/') && !versions.test(value))
      )
        throw new Error('Unpinned or private system package dependency');
    mkdirSync(child(folder, 'dist'), { recursive: true });
    const files = codeFiles(folder);
    const targets = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(targets)
          : [];
    if (entry.kind === 'compiled') {
      if (
        !files.some((row) => row.path.endsWith('.js')) ||
        !pkg.exports ||
        targets(pkg.exports).some(
          (path) => !path.startsWith('./dist/') || !files.some((row) => './' + row.path === path),
        )
      )
        throw new Error('System package entrypoint is outside compiled pinned code');
    } else if (
      files.length ||
      json(pkg.exports) !==
        json({ './native.ia.tgz': './' + SYSTEM_NATIVE_PATH, './system-package.json': './' + SYSTEM_BINDING_PATH })
    )
      throw new Error('Native-only package contains executable or unreviewed exports');
    // pnpm writes packed package.json with two-space indentation and no terminal newline.
    const manifestBytes = Buffer.from(JSON.stringify(pkg, null, 2));
    const binding: OwnedSystemPackageBinding = {
      format: OWNED_SYSTEM_PACKAGE_FORMAT,
      kind: entry.kind,
      package: { name: pkg.name, version: pkg.version, manifestSha256: sha(manifestBytes) },
      system,
      payload: {
        digest: sha(json([...preparedInputs.payload].map(([path, bytes]) => ({ path, sha256: sha(bytes) })))),
        files: [...preparedInputs.payload].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
      },
      native: {
        path: SYSTEM_NATIVE_PATH,
        archiveSha256: native.archiveDigest,
        manifestSha256: native.manifestDigest,
        id: native.manifest.id,
        version: native.manifest.version,
        selection: { path: SYSTEM_SELECTION_PATH, sha256: sha(selectionBytes) },
      },
      code: { digest: sha(json(files)), files },
      entrypoints: pkg.exports,
      dependencies: pkg.dependencies,
      protocols: { distribution: native.manifest.formatVersion, language: native.manifest.language, binding: 2 },
    };
    const bindingSha256 = sha(json(binding));
    const packageView = new Map(preparedInputs.payload);
    packageView.set('package.json', manifestBytes);
    packageView.set(SYSTEM_NATIVE_PATH, native.bytes);
    packageView.set(SYSTEM_SELECTION_PATH, Buffer.from(selectionBytes));
    packageView.set(SYSTEM_BINDING_PATH, Buffer.from(json(binding)));
    verifyPreparedPackage(packageView, bindingSha256, archives);
    return { owner, folder, native, manifestBytes, binding, bindingSha256 };
  });
  if (readInputs(root).fingerprint !== before.fingerprint)
    throw new Error('Native system inputs changed while packing');
  for (const row of prepared) {
    writeFileSync(child(row.folder, 'package.json'), row.manifestBytes);
    writeFileSync(child(row.folder, SYSTEM_NATIVE_PATH), row.native.bytes);
    writeFileSync(child(row.folder, SYSTEM_SELECTION_PATH), selectionBytes);
    writeFileSync(child(row.folder, SYSTEM_BINDING_PATH), json(row.binding));
    // The complete isolated package view passed above; actual packed/installed roots must match it.
  }
  return prepared.map(({ owner, binding, bindingSha256 }) => ({ owner, binding, bindingSha256 }));
}
if (isEntry(process.argv[1], import.meta.url)) {
  if (process.argv.length !== 5)
    throw new Error('Usage: system-packages.ts <isolated-pack-root> <public-receipt> <explicit-policy>');
  const [root, receipt, policy] = process.argv.slice(2);
  console.log(
    json(
      bundleSystemPackages(
        resolve(root!),
        JSON.parse(readFileSync(receipt!, 'utf8')),
        JSON.parse(readFileSync(policy!, 'utf8')),
      ),
    ),
  );
}
