import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import type { RevisionSource } from '@ia/graph';
import {
  canonicalDistributionJson,
  DISTRIBUTION_LIMITS,
  InstallationError,
  metadataDigest,
  portablePath,
  satisfies,
  sha256,
} from './codec.js';
import {
  decodeActivationPointer,
  decodeBundleManifest,
  decodeDistributionLock,
  decodeGenerationInputs,
  generationDigest,
} from './contracts.js';
import type { ActivationPointer, DistributionLock, GenerationInputs, LockedPackage } from './contracts.js';
import { deriveGenerationInputs, installationWorkspace } from './membership.js';
import type { BundleMetadata } from './membership.js';

export const DISTRIBUTION_ENGINE_VERSION = '0.1.0';
export const INSTALL_PATHS = Object.freeze({
  lock: '.ia/distributions.lock.json',
  active: '.ia/distributions/active.json',
  pending: '.ia/distributions/pending.json',
  store: '.ia/distributions/store',
  generations: '.ia/distributions/generations',
});
function corrupt(message: string): never {
  throw new InstallationError('corrupt-state', message);
}
function safe(root: string, path: string): string {
  portablePath(path);
  const absolute = resolve(root, path),
    volume = parse(absolute).root;
  let current = volume;
  for (const piece of absolute.slice(volume.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, piece);
    try {
      if (lstatSync(current).isSymbolicLink()) corrupt('Installed path traverses a link/junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let parent = resolve(root);
  for (const piece of path.split('/')) {
    if (
      existsSync(parent) &&
      readdirSync(parent).some((name) => name !== piece && name.toLowerCase() === piece.toLowerCase())
    )
      corrupt('Installed path has a case alias');
    parent = join(parent, piece);
  }
  return absolute;
}
function read(root: string, path: string, max: number = DISTRIBUTION_LIMITS.metadata): Buffer | null {
  const target = safe(root, path);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
    corrupt(`Expected bounded unaliased regular file: ${path}`);
  const bytes = readFileSync(target);
  if (bytes.length > max) corrupt('Installed file grew beyond limit');
  return bytes;
}
function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return corrupt('Invalid installed UTF-8');
  }
}
function required(root: string, path: string, max?: number): Buffer {
  return read(root, path, max) ?? corrupt(`Missing installed file: ${path}; restore exact artifacts`);
}
function decode<T>(bytes: Buffer, decoder: (value: unknown) => T): T {
  const value = decoder(utf8(bytes));
  if (canonicalDistributionJson(value) !== utf8(bytes)) corrupt('Installed metadata is not canonical');
  return value;
}
export interface ExpandedBundle extends BundleMetadata {
  readonly files: ReadonlyMap<string, Buffer>;
}
export function generationSources(
  pointer: ActivationPointer,
  lock: DistributionLock,
  inputs: GenerationInputs,
  bundles: ReadonlyMap<string, ExpandedBundle>,
): readonly RevisionSource[] {
  if (canonicalDistributionJson(deriveGenerationInputs(lock, bundles)) !== canonicalDistributionJson(inputs))
    corrupt('Generation membership differs from manifests');
  let total = 0;
  for (const bundle of bundles.values()) {
    const manifest = decodeBundleManifest(bundle.manifest);
    if (
      sha256(canonicalDistributionJson(manifest)) !== bundle.manifestDigest ||
      bundle.files.size !== manifest.files.length ||
      !satisfies(DISTRIBUTION_ENGINE_VERSION, manifest.engine)
    )
      corrupt('Bundle metadata/engine differs');
    for (const pin of manifest.files) {
      const content = bundle.files.get(pin.path);
      if (!content || content.length !== pin.bytes || sha256(content) !== pin.sha256)
        corrupt('Candidate payload pin differs');
      total += content.length;
      if (total > DISTRIBUTION_LIMITS.expanded) corrupt('Combined installation byte limit');
    }
  }
  const workspaceText = installationWorkspace(lock, inputs, bundles);
  if (generationDigest(lock, inputs, workspaceText) !== pointer.generation)
    corrupt('Candidate generation digest differs');
  const sources: RevisionSource[] = [];
  for (const system of inputs.systems) {
    const bundle = bundles.get(system.selected)!;
    for (const path of system.files)
      sources.push(
        Object.freeze({
          path: `${INSTALL_PATHS.store}/${bundle.archiveDigest}/${path}`,
          text: utf8(bundle.files.get(path)!),
          location: Object.freeze({
            placement: Object.freeze({ kind: 'adopted' as const, band: 90 as const, reach: '' }),
            provenance: 'methodology' as const,
          }),
        }),
      );
  }
  if (workspaceText !== null)
    sources.push(
      Object.freeze({
        path: `${INSTALL_PATHS.generations}/${pointer.generation}/workspace.ia`,
        text: workspaceText,
        location: Object.freeze({
          placement: Object.freeze({ kind: 'authored' as const, band: 100 as const, reach: '' }),
          provenance: 'workspace' as const,
        }),
      }),
    );
  return Object.freeze(sources);
}
/** Complete immutable payload verification; no execution, writes or network. */
export function readExpandedBundle(
  root: string,
  pkg: LockedPackage,
  maximumBytes: number = DISTRIBUTION_LIMITS.expanded,
): ExpandedBundle {
  const directory = `${INSTALL_PATHS.store}/${pkg.archive}`,
    manifestBytes = required(root, `${directory}/distribution.json`);
  if (sha256(manifestBytes) !== pkg.manifest) corrupt(`Manifest digest differs for ${pkg.id}`);
  const manifest = decode(manifestBytes, decodeBundleManifest);
  if (manifest.id !== pkg.id || manifest.version !== pkg.version) corrupt('Selected release identity differs');
  if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > maximumBytes)
    corrupt('Combined installation byte limit');
  const expected = new Map(manifest.files.map((f) => [f.path, f])),
    files = new Map<string, Buffer>(),
    aliases = new Set<string>();
  let expanded = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(safe(root, `${directory}${path ? '/' + path : ''}`), { withFileTypes: true })) {
      const local = `${path ? path + '/' : ''}${entry.name}`,
        key = portablePath(local).toLowerCase();
      if (aliases.has(key) || entry.isSymbolicLink()) corrupt('Aliased installed inventory');
      aliases.add(key);
      if (aliases.size > DISTRIBUTION_LIMITS.files * 8) corrupt('Installed directory inventory exceeds limit');
      if (entry.isDirectory()) {
        walk(local);
        continue;
      }
      if (!entry.isFile()) corrupt('Nonregular installed payload');
      if (local === 'distribution.json') continue;
      const pin = expected.get(local);
      if (!pin && platformDebris(entry.name)) continue;
      if (!pin) corrupt(`Extra installed file: ${local}`);
      const content = required(root, `${directory}/${local}`, DISTRIBUTION_LIMITS.file);
      expanded += content.length;
      if (expanded > DISTRIBUTION_LIMITS.expanded || content.length !== pin.bytes || sha256(content) !== pin.sha256)
        corrupt(`Installed content differs: ${local}`);
      if (pin.role === 'source') utf8(content);
      files.set(local, content);
    }
  };
  walk('');
  if (files.size !== expected.size) corrupt('Incomplete installed payload inventory');
  return { manifest, files, archiveDigest: pkg.archive, manifestDigest: pkg.manifest };
}
export interface InstalledGeneration {
  readonly pointer: ActivationPointer;
  readonly lock: DistributionLock;
  readonly inputs: GenerationInputs;
  readonly sources: readonly RevisionSource[];
  readonly fingerprint: string;
}
export function readInstalledGeneration(root: string, candidate?: ActivationPointer): InstalledGeneration | undefined {
  if (!candidate && read(root, INSTALL_PATHS.pending))
    throw new InstallationError('recovery-required', 'Run explicit distribution recovery before reading');
  const activeBytes = read(root, INSTALL_PATHS.active),
    portableBytes = read(root, INSTALL_PATHS.lock);
  if (!candidate && !activeBytes && !portableBytes) return undefined;
  if (!candidate && !activeBytes)
    throw new InstallationError('restore-required', 'Portable lock has no active installation');
  const pointer = candidate ? decodeActivationPointer(candidate) : decode(activeBytes!, decodeActivationPointer),
    directory = `${INSTALL_PATHS.generations}/${pointer.generation}`;
  const lockBytes = required(root, `${directory}/lock.json`),
    lock = decode(lockBytes, decodeDistributionLock);
  if (!candidate && (!portableBytes || !portableBytes.equals(lockBytes)))
    throw new InstallationError('lock-drift', 'Portable lock differs from the active generation; restore explicitly');
  if (!satisfies(DISTRIBUTION_ENGINE_VERSION, lock.engine)) corrupt('Installation engine compatibility differs');
  const inputs = decode(required(root, `${directory}/inputs.json`), decodeGenerationInputs),
    workspaceBytes = read(root, `${directory}/workspace.ia`, DISTRIBUTION_LIMITS.file),
    workspaceText = workspaceBytes === null ? null : utf8(workspaceBytes);
  if (generationDigest(lock, inputs, workspaceText) !== pointer.generation)
    corrupt('Generation inventory digest differs');
  if (
    readdirSync(safe(root, directory), { withFileTypes: true })
      .filter((entry) => !entry.isFile() || !platformDebris(entry.name))
      .map((entry) => entry.name)
      .sort()
      .join('|') !==
    (workspaceText === null ? ['inputs.json', 'lock.json'] : ['inputs.json', 'lock.json', 'workspace.ia']).join('|')
  )
    corrupt('Extra generation files');
  const bundles = new Map<string, ExpandedBundle>();
  let remaining = DISTRIBUTION_LIMITS.expanded as number;
  for (const pkg of lock.packages) {
    const bundle = readExpandedBundle(root, pkg, remaining);
    remaining -= bundle.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    bundles.set(pkg.id, bundle);
  }
  for (const bundle of bundles.values())
    if (!satisfies(DISTRIBUTION_ENGINE_VERSION, bundle.manifest.engine)) corrupt('Bundle engine compatibility differs');
  if (
    canonicalDistributionJson(deriveGenerationInputs(lock, bundles)) !== canonicalDistributionJson(inputs) ||
    installationWorkspace(lock, inputs, bundles) !== workspaceText
  )
    corrupt('Generation membership/workspace differs from manifests');
  const sources = generationSources(pointer, lock, inputs, bundles);
  if (
    !candidate &&
    (!read(root, INSTALL_PATHS.active)?.equals(activeBytes!) ||
      !read(root, INSTALL_PATHS.lock)?.equals(portableBytes!) ||
      existsSync(safe(root, INSTALL_PATHS.pending)))
  )
    throw new InstallationError(
      'recovery-required',
      'Activation changed during read; reopen after transaction completion',
    );
  return Object.freeze({
    pointer,
    lock,
    inputs,
    sources: Object.freeze(sources),
    fingerprint: metadataDigest({ pointer, lock, inputs }),
  });
}
/**
 * Files a platform writes into any directory it opens, which never belong to a payload: Finder's `.DS_Store`, and the
 * AppleDouble `._<name>` files macOS writes beside files on volumes without extended attributes (exFAT, SMB). A strict
 * inventory skips one only when it is not pinned; a pinned file of such a name is verified like any other (#323).
 */
export const platformDebris = (name: string): boolean => name === '.DS_Store' || name.startsWith('._');
