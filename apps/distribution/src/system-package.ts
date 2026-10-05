/** Read-only integrity verification; never imports code, grants authority or installs systems. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeDistributionLock } from '@inventarch/db/distribution';
import { verifyArchive, verifySelectedArchiveClosure } from './archive.js';
import { contained } from './files.js';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const SYSTEM_PACKAGE_FORMAT = 'ia.system-package.v1';
export const OWNED_SYSTEM_PACKAGE_FORMAT = 'ia.system-package.v2';
export const SYSTEM_NATIVE_PATH = 'dist/native.ia.tgz';
export const SYSTEM_BINDING_PATH = 'dist/system-package.json';
export const SYSTEM_SELECTION_PATH = 'dist/native-selection.json';
interface FilePin {
  readonly path: string;
  readonly sha256: string;
}
export interface LegacySystemPackageBinding {
  readonly format: typeof SYSTEM_PACKAGE_FORMAT;
  readonly package: { readonly name: string; readonly version: string };
  readonly system: {
    readonly name: string;
    readonly provider: string;
    readonly version: string;
    readonly path: string;
  };
  readonly native: {
    readonly path: string;
    readonly archiveSha256: string;
    readonly manifestSha256: string;
    readonly id: string;
    readonly version: string;
  };
  readonly code: { readonly digest: string; readonly files: readonly FilePin[] };
  readonly entrypoints: unknown;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly protocols: { readonly distribution: number; readonly language: readonly string[]; readonly binding: 1 };
}
export interface OwnedSystemPackageBinding extends Omit<LegacySystemPackageBinding, 'format' | 'native' | 'protocols'> {
  readonly format: typeof OWNED_SYSTEM_PACKAGE_FORMAT;
  readonly package: LegacySystemPackageBinding['package'] & { readonly manifestSha256: string };
  readonly payload: { readonly digest: string; readonly files: readonly FilePin[] };
  readonly kind: 'compiled' | 'native-only';
  readonly native: LegacySystemPackageBinding['native'] & {
    readonly selection: { readonly path: typeof SYSTEM_SELECTION_PATH; readonly sha256: string };
  };
  readonly protocols: { readonly distribution: number; readonly language: readonly string[]; readonly binding: 2 };
}
export type SystemPackageBinding = LegacySystemPackageBinding | OwnedSystemPackageBinding;
/** Exact native archives only; caller selects installed roots, and this API never discovers them. */
export interface SystemPackageSelection {
  readonly archives: ReadonlyMap<string, Uint8Array>;
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
function codeFiles(root: string, owned: boolean): readonly FilePin[] {
  const files: FilePin[] = [];
  const visit = (path: string): void => {
    const target = contained(root, path),
      stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('System package code is aliased');
    if (stat.isDirectory()) for (const name of readdirSync(target).sort(order)) visit(path + '/' + name);
    else if (
      stat.isFile() &&
      path !== SYSTEM_NATIVE_PATH &&
      path !== SYSTEM_BINDING_PATH &&
      (!owned || path !== SYSTEM_SELECTION_PATH)
    )
      files.push({ path, sha256: sha(file(root, path)) });
    else if (!stat.isFile()) throw new Error('System package code is not regular');
  };
  visit('dist');
  return files.sort((a, b) => order(a.path, b.path));
}
/** Every owned installed file is inventoried; dependencies live outside the package root. */
function payloadFiles(root: string): readonly FilePin[] {
  const files: FilePin[] = [];
  const visit = (path: string): void => {
    const target = contained(root, path),
      stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('System package payload is aliased');
    if (stat.isDirectory()) for (const name of readdirSync(target).sort(order)) visit(path ? path + '/' + name : name);
    else if (!stat.isFile()) throw new Error('System package payload is not regular');
    else if (!['package.json', SYSTEM_BINDING_PATH, SYSTEM_NATIVE_PATH, SYSTEM_SELECTION_PATH].includes(path))
      files.push({ path, sha256: sha(file(root, path)) });
  };
  visit('');
  return files.sort((a, b) => order(a.path, b.path));
}
/** An external binding digest pins code/data and the complete selected native dependency lock. */
export function verifySystemPackage(
  root: string,
  expectedBindingDigest: string,
  selection?: SystemPackageSelection,
): SystemPackageBinding {
  const bytes = file(root, SYSTEM_BINDING_PATH);
  if (!/^[a-f0-9]{64}$/.test(expectedBindingDigest) || sha(bytes) !== expectedBindingDigest)
    throw new Error('System package binding digest differs');
  const binding = JSON.parse(bytes.toString('utf8')) as SystemPackageBinding;
  const manifestBytes = file(root, 'package.json'),
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (binding.format === OWNED_SYSTEM_PACKAGE_FORMAT) {
    if (
      !/^[a-f0-9]{64}$/.test(binding.package?.manifestSha256 ?? '') ||
      !binding.payload ||
      !Array.isArray(binding.payload.files) ||
      !/^[a-f0-9]{64}$/.test(binding.payload.digest)
    )
      throw new Error('System package lacks complete owned payload integrity');
    if (sha(manifestBytes) !== binding.package.manifestSha256) throw new Error('System package manifest bytes differ');
  }
  if (
    ![SYSTEM_PACKAGE_FORMAT, OWNED_SYSTEM_PACKAGE_FORMAT].includes(binding.format) ||
    manifest.name !== binding.package.name ||
    manifest.version !== binding.package.version ||
    json(manifest.exports) !== json(binding.entrypoints) ||
    json(manifest.dependencies ?? {}) !== json(binding.dependencies)
  )
    throw new Error('System package npm identity or entrypoints differ');
  if (binding.native.path !== SYSTEM_NATIVE_PATH) throw new Error('System package native path differs');
  const nativeBytes = file(root, binding.native.path);
  let native: ReturnType<typeof verifyArchive> | undefined;
  if (binding.format === OWNED_SYSTEM_PACKAGE_FORMAT) {
    if (
      !['compiled', 'native-only'].includes(binding.kind) ||
      binding.native.selection.path !== SYSTEM_SELECTION_PATH ||
      !selection ||
      !(selection.archives instanceof Map)
    )
      throw new Error('System package requires its exact selected native closure');
    const selectionBytes = file(root, SYSTEM_SELECTION_PATH);
    if (sha(selectionBytes) !== binding.native.selection.sha256)
      throw new Error('System package selected closure digest differs');
    const lock = decodeDistributionLock(selectionBytes.toString('utf8'));
    if (
      !selection.archives.get(binding.native.archiveSha256) ||
      sha(nativeBytes) !== binding.native.archiveSha256 ||
      sha(selection.archives.get(binding.native.archiveSha256)!) !== binding.native.archiveSha256
    )
      throw new Error('System package selected native archive differs');
    const verified = verifySelectedArchiveClosure(lock, selection.archives);
    const owners = [...verified.values()].flatMap((row) => row.manifest.systems.map((system) => system.name));
    if (owners.length !== verified.size || new Set(owners).size !== owners.length)
      throw new Error('System package selection duplicates native ownership');
    native = verified.get(binding.native.id);
    if (native?.manifest.systems.length !== 1) throw new Error('System package must own exactly one native system');
    if (lock.packages.some((row) => !selection.archives.has(row.archive)))
      throw new Error('System package dependency archive missing');
  } else native = verifyArchive(nativeBytes, binding.native.archiveSha256);
  if (
    native.archiveDigest !== binding.native.archiveSha256 ||
    native.manifestDigest !== binding.native.manifestSha256 ||
    native.manifest.id !== binding.native.id ||
    native.manifest.version !== binding.native.version ||
    !native.manifest.systems.some((row) => json(row) === json(binding.system))
  )
    throw new Error('System package native identity differs');
  const files = codeFiles(root, binding.format === OWNED_SYSTEM_PACKAGE_FORMAT);
  if (json(files) !== json(binding.code.files) || sha(json(files)) !== binding.code.digest)
    throw new Error('System package compiled bytes differ');
  if (binding.format === OWNED_SYSTEM_PACKAGE_FORMAT) {
    const payload = payloadFiles(root);
    if (json(payload) !== json(binding.payload.files) || sha(json(payload)) !== binding.payload.digest)
      throw new Error('System package owned payload differs');
    if (
      binding.kind === 'native-only' &&
      ([
        'bin',
        'scripts',
        'main',
        'module',
        'browser',
        'imports',
        'peerDependencies',
        'peerDependenciesMeta',
        'optionalDependencies',
        'bundledDependencies',
        'bundleDependencies',
        'gypfile',
        'directories',
      ].some((key) => Object.hasOwn(manifest, key)) ||
        payload.some((row) => !['README.md', 'SPEC.md', 'LICENSE', 'NOTICE', 'LANGUAGE.md'].includes(row.path)))
    )
      throw new Error('Native-only package contains executable metadata or payload');
  }
  if (binding.format === OWNED_SYSTEM_PACKAGE_FORMAT && binding.kind === 'native-only') {
    if (
      files.length ||
      json(binding.entrypoints) !==
        json({ './native.ia.tgz': './' + SYSTEM_NATIVE_PATH, './system-package.json': './' + SYSTEM_BINDING_PATH })
    )
      throw new Error('Native-only package contains executable or unreviewed exports');
  } else if (!files.some((row) => row.path.endsWith('.js')))
    throw new Error('System package has no compiled JavaScript');
  if (
    json(binding.protocols) !==
    json({
      distribution: native.manifest.formatVersion,
      language: native.manifest.language,
      binding: binding.format === OWNED_SYSTEM_PACKAGE_FORMAT ? 2 : 1,
    })
  )
    throw new Error('System package protocols differ');
  return binding;
}
