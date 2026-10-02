import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { open, readInputs } from '@ia/db';
import {
  canonicalDistributionJson as json,
  decodeActivationPointer,
  decodeDistributionJson,
  decodeDistributionLock,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  installationWorkspace,
  INSTALL_PATHS,
  metadataDigest,
  platformDebris,
  readExpandedBundle,
  readInstalledGeneration,
} from '@ia/db/distribution';
import type { ActivationPointer, DistributionLock } from '@ia/db/distribution';
import { verifyArchive, verifySelectedArchiveClosure } from './archive.js';
import type { VerifiedArchive } from './archive.js';
import {
  bytes,
  contained,
  createFile,
  fail,
  object,
  replace,
  sha256,
  syncDirectory,
  utf8,
  workspace,
} from './files.js';

import { planInstallationSnapshot, type InstallOperation, type NativeInstallationPlan } from './installation-core.js';
import { distributionSnapshot } from './snapshot.js';
export type { InstallOperation } from './installation-core.js';
export interface InstallationPlan {
  readonly formatVersion: 1;
  readonly operation: InstallOperation;
  readonly root: string;
  readonly engine: string;
  readonly binding: { readonly source: string; readonly active: string | null; readonly lock: string | null };
  readonly lock: DistributionLock;
  readonly pointer: ActivationPointer;
  readonly changes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly updated: readonly string[];
    readonly shadowed: readonly string[];
  };
  readonly digest: string;
}
export interface InstallOptions {
  readonly checkpoint?: (name: string) => void;
}
/** The workspace archive cache: `<digest>.ia.tgz` files only, each written once by `cacheArchive`. */
export const ARCHIVE_CACHE = '.ia/distributions/cache';
/** A cache entry's name; group 1 is the archive digest. */
export const CACHED_ARCHIVE_NAME = /^([a-f0-9]{64})\.ia\.tgz$/;
export const cachePath = (digest: string): string => {
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('INPUT-INVALID', 'Invalid archive digest');
  return `${ARCHIVE_CACHE}/${digest}.ia.tgz`;
};
const hashOrNull = (content: Buffer | null): string | null => (content === null ? null : sha256(content));
function state(root: string): InstallationPlan['binding'] {
  return {
    source: readInputs(root, { candidateInstallation: null }).fingerprint,
    active: hashOrNull(bytes(root, INSTALL_PATHS.active)),
    lock: hashOrNull(bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata)),
  };
}
function immutable(root: string, path: string, content: Buffer): void {
  const current = bytes(root, path, Math.max(content.length, DISTRIBUTION_LIMITS.file));
  if (current) {
    if (!current.equals(content)) fail('LOCAL-MODIFICATION', `Managed immutable content differs: ${path}`);
  } else createFile(root, path, content);
}
export function cacheArchive(rootInput: string, content: Uint8Array, expectedDigest?: string): VerifiedArchive {
  const root = workspace(rootInput),
    release = verifyArchive(content, expectedDigest);
  immutable(root, cachePath(release.archiveDigest), Buffer.from(content));
  return release;
}
/** Qualify an exact selected closure before publishing any immutable cache member. */
export function cacheSelectedArchiveClosure(
  rootInput: string,
  lockInput: unknown,
  input: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, VerifiedArchive> {
  const root = workspace(rootInput),
    lock = decodeDistributionLock(lockInput);
  if (!(input instanceof Map) || input.size !== new Set(lock.packages.map((pkg) => pkg.archive)).size)
    fail('INPUT-INVALID', 'Expected exact selected archive map');
  const archives = new Map<string, Buffer>();
  let total = 0;
  for (const [digest, content] of input) {
    cachePath(digest);
    if (!(content instanceof Uint8Array) || content.byteLength > DISTRIBUTION_LIMITS.compressed)
      fail('LIMIT-EXCEEDED', 'Invalid or oversized selected archive');
    total += content.byteLength;
    if (total > DISTRIBUTION_LIMITS.expanded) fail('LIMIT-EXCEEDED', 'Combined selected archives exceed their ceiling');
    archives.set(digest, Buffer.from(content));
  }
  const releases = verifySelectedArchiveClosure(lock, archives);
  // Preflight the entire selection, so an existing collision or alias cannot cause
  // earlier members to be published before that refusal. Writes still recheck.
  for (const [digest, content] of archives) {
    const path = cachePath(digest),
      current = bytes(root, path, DISTRIBUTION_LIMITS.compressed);
    if (current && !current.equals(content)) fail('LOCAL-MODIFICATION', `Managed immutable content differs: ${path}`);
  }
  for (const [digest, content] of archives) immutable(root, cachePath(digest), content);
  return releases;
}
function cachedArchiveBytes(root: string, lock: DistributionLock): ReadonlyMap<string, Buffer> {
  let total = 0;
  return new Map(
    lock.packages.map((pkg) => {
      const content = bytes(root, cachePath(pkg.archive), DISTRIBUTION_LIMITS.compressed);
      if (!content) fail('RESTORE-REQUIRED', `Missing cached archive ${pkg.archive}; supply its exact bytes`);
      total += content.length;
      if (total > DISTRIBUTION_LIMITS.expanded)
        fail('LIMIT-EXCEEDED', 'Combined archive cache selection exceeds its ceiling');
      return [pkg.archive, content];
    }),
  );
}
/** Read exact bounded cache bytes without cache writes or installation activation. Admission belongs to the consuming operation. */
export function readCachedArchiveSelection(rootInput: string, lockInput: unknown): ReadonlyMap<string, Buffer> {
  return cachedArchiveBytes(workspace(rootInput), decodeDistributionLock(lockInput));
}
export function cachedReleases(root: string, lock: DistributionLock): ReadonlyMap<string, VerifiedArchive> {
  return verifySelectedArchiveClosure(lock, cachedArchiveBytes(root, lock));
}
function noPending(root: string): void {
  if (bytes(root, INSTALL_PATHS.pending, 4 * DISTRIBUTION_LIMITS.metadata))
    fail('RECOVERY-REQUIRED', 'Recover the pending native transaction first');
}
function candidate(root: string, lock: DistributionLock, operation: InstallOperation): NativeInstallationPlan {
  const source = readInputs(root, { candidateInstallation: null }),
    activeBytes = bytes(root, INSTALL_PATHS.active),
    previousLock = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata);
  return planInstallationSnapshot({
    base: distributionSnapshot({ sources: source.sources, folders: source.folders, floorOrigin: source.floorOrigin }),
    current: {
      pointer: activeBytes ? decodeActivationPointer(utf8(activeBytes)) : null,
      lock: previousLock ? decodeDistributionLock(utf8(previousLock)) : null,
    },
    lock,
    operation,
    archives: cachedArchiveBytes(root, lock),
  });
}
export function planInstallation(rootInput: string, lockInput: unknown, operation: InstallOperation): InstallationPlan {
  const root = workspace(rootInput);
  noPending(root);
  const binding = state(root),
    lock = decodeDistributionLock(lockInput);
  if (operation !== 'restore' && (bytes(root, INSTALL_PATHS.active) || bytes(root, INSTALL_PATHS.lock)))
    readInstalledGeneration(root);
  const checked = candidate(root, lock, operation);
  if (json(state(root)) !== json(binding)) fail('SOURCE-CHANGED', 'Workspace changed while planning');
  const body = {
    formatVersion: 1 as const,
    operation,
    root,
    engine: DISTRIBUTION_ENGINE_VERSION,
    binding,
    lock,
    pointer: checked.pointer,
    changes: checked.changes,
  };
  return Object.freeze({ ...body, digest: metadataDigest(body) });
}
function decodePlan(input: unknown): InstallationPlan {
  const row = object(typeof input === 'string' ? decodeDistributionJson(input) : decodeDistributionJson(json(input)), [
    'formatVersion',
    'operation',
    'root',
    'engine',
    'binding',
    'lock',
    'pointer',
    'changes',
    'digest',
  ]);
  if (
    row['formatVersion'] !== 1 ||
    !['install', 'update', 'remove', 'restore', 'rollback'].includes(String(row['operation'])) ||
    typeof row['root'] !== 'string' ||
    row['engine'] !== DISTRIBUTION_ENGINE_VERSION
  )
    fail('INPUT-INVALID', 'Invalid installation plan');
  const { digest, ...body } = row;
  if (digest !== metadataDigest(body)) fail('INPUT-INVALID', 'Installation plan digest differs');
  decodeDistributionLock(row['lock']);
  decodeActivationPointer(row['pointer']);
  object(row['binding'], ['source', 'active', 'lock']);
  object(row['changes'], ['added', 'removed', 'updated', 'shadowed']);
  return row as unknown as InstallationPlan;
}
function acquire(root: string, recovering = false): () => void {
  const path = '.ia/distributions/install-lock.json',
    target = contained(root, path);
  mkdirSync(dirname(target), { recursive: true });
  if (recovering && existsSync(target)) {
    const value = object(decodeDistributionJson(utf8(bytes(root, path, 4096)!)), ['pid']);
    const pid = value['pid'];
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0)
      fail('INSTALL-BUSY', 'Invalid native lock requires manual reconciliation');
    try {
      process.kill(pid as number, 0);
      fail('INSTALL-BUSY', 'Native lock belongs to a running process');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    unlinkSync(target);
  }
  let fd: number;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('INSTALL-BUSY', 'Another installer holds the workspace lock');
    throw error;
  }
  try {
    writeFileSync(fd, json({ pid: process.pid }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    unlinkSync(target);
    syncDirectory(dirname(target));
  };
}
export function applyInstallation(
  input: unknown,
  options: InstallOptions = {},
): { status: 'installed'; generation: string; counter: number; host: 'pending' } {
  const plan = decodePlan(input),
    root = workspace(plan.root),
    release = acquire(root),
    checkpoint = options.checkpoint ?? (() => {});
  try {
    noPending(root);
    if (
      json(state(root)) !== json(plan.binding) ||
      json(planInstallation(root, plan.lock, plan.operation)) !== json(plan)
    )
      fail('STALE-PLAN', 'Installation bindings changed; create a fresh plan');
    const releases = cachedReleases(root, plan.lock),
      checked = candidate(root, plan.lock, plan.operation);
    for (const pkg of plan.lock.packages) {
      const artifact = releases.get(pkg.id)!,
        directory = `${INSTALL_PATHS.store}/${pkg.archive}`;
      for (const [path, content] of artifact.files) {
        immutable(root, `${directory}/${path}`, content);
        checkpoint(`store:${pkg.id}:${path}`);
      }
      immutable(root, `${directory}/distribution.json`, Buffer.from(json(artifact.manifest)));
      checkpoint(`manifest:${pkg.id}`);
    }
    const directory = `${INSTALL_PATHS.generations}/${plan.pointer.generation}`,
      generated = installationWorkspace(plan.lock, checked.inputs, releases);
    for (const [path, content] of [
      ['lock.json', json(plan.lock)],
      ['inputs.json', json(checked.inputs)],
      ...(generated === null ? [] : [['workspace.ia', generated]]),
    ]) {
      immutable(root, `${directory}/${path}`, Buffer.from(content!));
      checkpoint(`generation:${path}`);
    }
    const reader = open(root, { cache: false, candidateInstallation: plan.pointer });
    try {
      if (reader.report.findings.some((f) => f.severity === 'error'))
        fail('ADMISSION-FAILED', 'Staged installation failed native admission');
    } finally {
      reader.close();
    }
    if (json(state(root)) !== json(plan.binding)) fail('STALE-PLAN', 'Workspace changed before activation');
    const beforeActive = bytes(root, INSTALL_PATHS.active)?.toString('utf8') ?? null,
      beforeLock = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata)?.toString('utf8') ?? null;
    const pending = {
      formatVersion: 1,
      beforeActive,
      beforeLock,
      afterActive: json(plan.pointer),
      afterLock: json(plan.lock),
    };
    replace(root, INSTALL_PATHS.pending, Buffer.from(json(pending)));
    checkpoint('pending');
    if (json(state(root)) !== json(plan.binding)) fail('STALE-PLAN', 'Workspace changed after pending write');
    replace(root, INSTALL_PATHS.lock, Buffer.from(pending.afterLock));
    checkpoint('portable-lock');
    // Lock replacement is expected; recheck source and the old pointer immediately before commit.
    const current = state(root);
    if (
      current.source !== plan.binding.source ||
      current.active !== plan.binding.active ||
      current.lock !== sha256(pending.afterLock)
    )
      fail('STALE-PLAN', 'Activation inputs changed');
    readInstalledGeneration(root, plan.pointer);
    replace(root, INSTALL_PATHS.active, Buffer.from(pending.afterActive));
    checkpoint('active');
    replace(root, INSTALL_PATHS.pending, null);
    checkpoint('complete');
    return { status: 'installed', generation: plan.pointer.generation, counter: plan.pointer.counter, host: 'pending' };
  } finally {
    release();
  }
}
export function recoverInstallation(
  rootInput: string,
  options: InstallOptions = {},
): { status: 'current' | 'recovered'; committed?: boolean } {
  const root = workspace(rootInput),
    release = acquire(root, true),
    checkpoint = options.checkpoint ?? (() => {});
  try {
    const content = bytes(root, INSTALL_PATHS.pending, 4 * DISTRIBUTION_LIMITS.metadata);
    if (!content) return { status: 'current' };
    const pending = object(decodeDistributionJson(utf8(content)), [
      'formatVersion',
      'beforeActive',
      'beforeLock',
      'afterActive',
      'afterLock',
    ]);
    if (pending['formatVersion'] !== 1) fail('RECOVERY-REQUIRED', 'Unknown pending format');
    const decode = (key: string, nullable: boolean, parser: (input: unknown) => unknown): string | null => {
      const v = pending[key];
      if (nullable && v === null) return null;
      if (typeof v !== 'string' || json(parser(v)) !== v) fail('RECOVERY-REQUIRED', 'Invalid pending state bytes');
      return v;
    };
    const beforeActive = decode('beforeActive', true, decodeActivationPointer),
      beforeLock = decode('beforeLock', true, decodeDistributionLock),
      afterActive = decode('afterActive', false, decodeActivationPointer)!,
      afterLock = decode('afterLock', false, decodeDistributionLock)!;
    const currentActive = bytes(root, INSTALL_PATHS.active)?.toString('utf8') ?? null,
      currentLock = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata)?.toString('utf8') ?? null;
    if (
      (currentActive !== beforeActive && currentActive !== afterActive) ||
      (currentLock !== beforeLock && currentLock !== afterLock)
    )
      fail('RECOVERY-REQUIRED', 'Unknown edited pointer/lock; manual reconciliation required');
    const committed = currentActive === afterActive;
    const next = decodeActivationPointer(afterActive),
      previous = beforeActive === null ? null : decodeActivationPointer(beforeActive);
    if (next.counter !== (previous?.counter ?? 0) + 1 || next.previous !== (previous?.generation ?? null))
      fail('RECOVERY-REQUIRED', 'Invalid pending activation sequence');
    if (committed && json(readInstalledGeneration(root, next)!.lock) !== afterLock)
      fail('RECOVERY-REQUIRED', 'Committed lock differs from its generation');
    replace(
      root,
      INSTALL_PATHS.lock,
      committed ? Buffer.from(afterLock) : beforeLock === null ? null : Buffer.from(beforeLock),
    );
    checkpoint('recovery-lock');
    replace(root, INSTALL_PATHS.pending, null);
    checkpoint('recovery-complete');
    return { status: 'recovered', committed };
  } finally {
    release();
  }
}
/** Conservative explicit GC: retain every generation, and collect only verified orphan archives/stores. */
export function collectInstallationGarbage(
  rootInput: string,
  apply = false,
): { status: 'planned' | 'collected'; archives: readonly string[]; retainedGenerations: readonly string[] } {
  const root = workspace(rootInput),
    release = acquire(root);
  try {
    noPending(root);
    const binding = state(root),
      referenced = new Set<string>(),
      retained: string[] = [];
    const portable = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata);
    if (portable) decodeDistributionLock(utf8(portable)).packages.forEach((p) => referenced.add(p.archive));
    const generations = contained(root, INSTALL_PATHS.generations);
    if (existsSync(generations)) {
      const entries = readdirSync(generations, { withFileTypes: true });
      if (entries.length > 1024) fail('LIMIT-EXCEEDED', 'Retained generation inventory exceeds 1024 entries');
      for (const entry of entries) {
        if (entry.isFile() && platformDebris(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name))
          fail('LOCAL-MODIFICATION', 'Unrecognized generation entry');
        const generation = readInstalledGeneration(root, {
          formatVersion: 1,
          generation: entry.name,
          previous: null,
          counter: 1,
        })!;
        generation.lock.packages.forEach((p) => referenced.add(p.archive));
        retained.push(entry.name);
      }
    }
    const candidates: { archive: string; paths: string[]; dirs: string[]; hashes: Map<string, string> }[] = [],
      cache = contained(root, ARCHIVE_CACHE);
    if (existsSync(cache))
      for (const entry of readdirSync(cache, { withFileTypes: true })) {
        if (entry.isFile() && platformDebris(entry.name)) continue;
        const match = CACHED_ARCHIVE_NAME.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink()) fail('LOCAL-MODIFICATION', 'Unrecognized cache entry');
        const archive = match[1]!;
        if (referenced.has(archive)) continue;
        const archivePath = cachePath(archive),
          content = bytes(root, archivePath, DISTRIBUTION_LIMITS.compressed)!,
          artifact = verifyArchive(content, archive),
          paths: string[] = [],
          dirs = new Set<string>(),
          hashes = new Map<string, string>();
        const directory = `${INSTALL_PATHS.store}/${archive}`;
        if (existsSync(contained(root, directory))) {
          readExpandedBundle(root, {
            id: artifact.manifest.id,
            version: artifact.manifest.version,
            archive,
            manifest: artifact.manifestDigest,
            location: `sha256:${archive}`,
            dependencies: artifact.manifest.dependencies.map((d) => d.id),
          });
          for (const file of [...artifact.manifest.files.map((f) => f.path), 'distribution.json']) {
            const path = `${directory}/${file}`;
            paths.push(path);
            hashes.set(path, sha256(bytes(root, path, DISTRIBUTION_LIMITS.file)!));
            const parts = path.split('/');
            while (parts.length > 4) {
              parts.pop();
              dirs.add(parts.join('/'));
            }
          }
          dirs.add(directory);
        }
        paths.push(archivePath);
        hashes.set(archivePath, sha256(content));
        candidates.push({ archive, paths, dirs: [...dirs].sort((a, b) => b.length - a.length), hashes });
      }
    if (apply) {
      if (json(state(root)) !== json(binding))
        fail('STALE-PLAN', 'Workspace changed during garbage collection planning');
      // Preflight the complete deletion set before removing a single owned file.
      for (const candidate of candidates)
        for (const path of candidate.paths)
          if (sha256(bytes(root, path, DISTRIBUTION_LIMITS.compressed)!) !== candidate.hashes.get(path))
            fail('LOCAL-MODIFICATION', 'Garbage collection target changed');
      // The Finder and AppleDouble files the readers skipped go with the directory they sit in, or it would outlive its archive (#323).
      for (const candidate of candidates) {
        for (const path of candidate.paths) replace(root, path, null);
        for (const dir of candidate.dirs) {
          const target = contained(root, dir);
          if (!existsSync(target)) continue;
          for (const entry of readdirSync(target, { withFileTypes: true }))
            if (entry.isFile() && platformDebris(entry.name) && lstatSync(join(target, entry.name)).isFile())
              unlinkSync(join(target, entry.name));
          if (readdirSync(target).length === 0) rmdirSync(target);
        }
      }
    }
    return {
      status: apply ? 'collected' : 'planned',
      archives: candidates.map((c) => c.archive).sort(),
      retainedGenerations: retained.sort(),
    };
  } finally {
    release();
  }
}
