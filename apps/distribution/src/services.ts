import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import {
  decodeDistributionJson,
  decodeDistributionLock,
  DISTRIBUTION_LIMITS,
  INSTALL_PATHS,
  readInstalledGeneration,
} from '@inventarch/db/distribution';
import type {
  ActivationPointer,
  BundleMetadata,
  DistributionLock,
  GenerationInputs,
} from '@inventarch/db/distribution';
import { DraftError, formatDraft } from '@inventarch/authoring-system';
import type { DraftResult } from '@inventarch/authoring-system';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '@inventarch/language';
import { acquireArtifact, readArtifactBytes } from './acquire.js';
import { inspectArchiveMetadata } from './archive.js';
import {
  ARCHIVE_CACHE,
  cacheArchive,
  cacheSelectedArchiveClosure,
  CACHED_ARCHIVE_NAME,
  cachePath,
  planInstallation,
} from './install.js';
import type { InstallationPlan } from './install.js';
import { packDistribution } from './pack.js';
import type { PackedDistribution } from './snapshot.js';
import type { ReleaseCandidate } from './resolve.js';
import { bytes, contained, createFile, fail, locate, object, portable, utf8, workspace } from './files.js';
import { observeHosts } from './host-observe.js';
import type { HostObservation } from './host-observe.js';

export { createFile, json, replace, sha256, DistributionError } from './files.js';
export { acquireArtifact } from './acquire.js';
export type { ArtifactRequest } from './acquire.js';
export type { HostObservation } from './host-observe.js';
/**
 * The language identity a compiled artifact is produced under. It travels as a service value because a
 * presentation host may not depend on @inventarch/language, and because the two constants belong together: a digest
 * without its version names nothing.
 */
export const LANGUAGE_IDENTITY: { readonly language: string; readonly kernelDigest: string } = Object.freeze({
  language: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
});
export type { InstallationPlan } from './install.js';
export type { ReleaseCandidate } from './resolve.js';
export type { BundleMetadata } from '@inventarch/db/distribution';
export type { DraftResult } from '@inventarch/authoring-system';

type Findings = Handle['report']['findings'];
/**
 * Every exported service resolves its own `root` through workspace(), so no caller inherits an
 * unstated precondition about which of the two meanings a root string carries. The resolution is
 * idempotent, and services that compose re-resolve an already-resolved root rather than trusting it.
 */
export interface WorkspaceFileRequest {
  readonly root: string;
  readonly path: string;
  readonly limit?: number;
}
export function readWorkspaceFile(request: WorkspaceFileRequest): Buffer {
  const path = portable(request.path),
    root = workspace(request.root);
  return (
    bytes(root, path, request.limit ?? DISTRIBUTION_LIMITS.metadata) ??
    fail('INPUT-INVALID', `Missing input ${request.path}`)
  );
}
export function readWorkspaceJson(request: WorkspaceFileRequest): unknown {
  return decodeDistributionJson(utf8(readWorkspaceFile(request)));
}
export function readWorkspaceLock(options: { readonly root: string }): DistributionLock {
  return decodeDistributionLock(readWorkspaceJson({ root: options.root, path: INSTALL_PATHS.lock }));
}

export interface WorkOutputRequest {
  readonly root: string;
  readonly path: string;
  /** Authoring drafts accept an absolute path inside the explicit root; saved plans never do. */
  readonly acceptAbsolute?: boolean;
  /** The whole refusal message, used as given. Every absolute spelling is refused by portable() first. */
  readonly refusal?: string;
}
const placement = (root: string, request: WorkOutputRequest): string => {
  const supplied =
    request.acceptAbsolute === true && isAbsolute(request.path)
      ? relative(root, resolve(request.path)).replaceAll('\\', '/')
      : request.path;
  const path = portable(supplied);
  if (!path.startsWith('.ia/work/')) fail('PATH-UNSAFE', request.refusal ?? 'Saved plans require a new .ia/work file');
  return path;
};
export function workOutputPath(request: WorkOutputRequest): string {
  return placement(workspace(request.root), request);
}
/**
 * Newness is a separate rule from placement: createFile refuses an existing entry with
 * LOCAL-MODIFICATION. Content resolves after the placement check so serializing a value that can
 * itself refuse never preempts an unsafe destination.
 */
export function writeWorkOutput(request: WorkOutputRequest & { readonly content: Buffer | (() => Buffer) }): string {
  const root = workspace(request.root),
    path = placement(root, request);
  createFile(root, path, typeof request.content === 'function' ? request.content() : request.content);
  return path;
}

export interface InstalledState {
  readonly status: 'installed' | 'uninstalled';
  readonly pointer?: ActivationPointer;
  readonly lock?: DistributionLock;
  readonly inputs?: GenerationInputs;
  /**
   * Spec §7: observed per host, only when the caller opts in via `hosts: true`. Absent — never `[]` — when not
   * requested, so a caller cannot mistake "didn't ask" for "asked, and none are registered". Observation walks
   * every managed file under `.ia/distributions/hosts/`, so callers that don't need it (`distribute.ts`, `init.ts`,
   * the native `list`/`doctor` body) must not pay for it.
   */
  readonly hosts?: readonly HostObservation[];
}
export function readInstalledState(options: {
  readonly root: string;
  readonly hosts?: boolean;
  readonly hostRelease?: string | null;
}): InstalledState {
  const root = workspace(options.root),
    installed = readInstalledGeneration(root);
  const hosts = options.hosts === true ? { hosts: observeHosts(root, options.hostRelease ?? null) } : {};
  return installed
    ? { status: 'installed', pointer: installed.pointer, lock: installed.lock, inputs: installed.inputs, ...hosts }
    : { status: 'uninstalled', ...hosts };
}

export interface CatalogRequest {
  readonly root: string;
  readonly entries: unknown;
  readonly offline?: boolean;
  readonly signal?: AbortSignal | undefined;
}
export async function resolveCatalog(request: CatalogRequest): Promise<readonly ReleaseCandidate[]> {
  request.signal?.throwIfAborted();
  const { entries } = request,
    offline = request.offline === true;
  if (!Array.isArray(entries) || entries.length > 1000) fail('INPUT-INVALID', 'Expected bounded release catalog');
  const root = workspace(request.root),
    result: ReleaseCandidate[] = [];
  for (const entry of entries) {
    request.signal?.throwIfAborted();
    const row = object(
      entry,
      Object.hasOwn(entry ?? {}, 'path') ? ['path', 'withdrawn'] : ['url', 'digest', 'withdrawn'],
    );
    if (typeof row['withdrawn'] !== 'boolean') fail('INPUT-INVALID', 'Expected withdrawal flag');
    if (typeof row['path'] === 'string') {
      const content = bytes(root, portable(row['path']), DISTRIBUTION_LIMITS.compressed);
      if (!content) fail('ARTIFACT-UNAVAILABLE', 'Missing selected local archive');
      const release = cacheArchive(root, content);
      result.push({ release, location: `sha256:${release.archiveDigest}`, withdrawn: row['withdrawn'] });
    } else {
      if (typeof row['url'] !== 'string' || typeof row['digest'] !== 'string')
        fail('INPUT-INVALID', 'Invalid remote catalog entry');
      result.push({
        ...(await acquireArtifact({ root, url: row['url'], digest: row['digest'], offline, signal: request.signal })),
        withdrawn: row['withdrawn'],
      });
    }
  }
  return result;
}

export interface CachedCandidatesRequest {
  readonly root: string;
  /**
   * The ids to start from (a command's request ids and locked ids). Given, only cached releases whose id is in the dependency
   * closure of these ids over every cached manifest (all versions) are returned, so a stale duplicate of an unrelated
   * `id@version` never reaches resolution. Absent, every cached release is returned.
   */
  readonly reach?: readonly string[];
}
/**
 * Registry spec §5.4: `--offline` without a catalog resolves from the workspace cache. Every `<digest>.ia.tgz` file there,
 * in name order, passes canonical byte-integrity checks against the digest its name carries and is offered at `sha256:<digest>`; the cache holds no
 * withdrawal state, so none is withdrawn. Other names and subdirectories are ignored; a link or hard link refuses (`bytes`).
 * Only manifest-level metadata is kept: planning re-reads and re-verifies the selected archives, so holding up to 1,000
 * archives' files here would buy nothing. Every cached archive has its byte integrity checked, reachable or not. Authoring readiness belongs only to final selected-closure planning, not metadata enumeration.
 */
export function cachedCandidates(options: CachedCandidatesRequest): readonly ReleaseCandidate<BundleMetadata>[] {
  const { reach } = options;
  if (reach !== undefined && (!Array.isArray(reach) || !reach.every((id) => typeof id === 'string')))
    fail('INPUT-INVALID', 'Expected a list of distribution ids to reach');
  const root = workspace(options.root),
    directory = contained(root, ARCHIVE_CACHE);
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) fail('PATH-UNSAFE', `Archive cache is not a directory: ${ARCHIVE_CACHE}`);
  const digests = readdirSync(directory, { withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => CACHED_ARCHIVE_NAME.exec(e.name)?.[1])
    .filter((d) => d !== undefined)
    .sort();
  // Checked before any archive is read, the same bound a catalog carries.
  if (digests.length > 1000) fail('LIMIT-EXCEEDED', 'Archive cache holds more than 1000 archives');
  const candidates = digests.map((digest): ReleaseCandidate<BundleMetadata> => {
    const path = cachePath(digest);
    return locate(path, () => {
      const content =
        bytes(root, path, DISTRIBUTION_LIMITS.compressed) ??
        fail('SOURCE-CHANGED', `Archive cache changed while reading: ${path}`);
      const { manifest, archiveDigest, manifestDigest } = inspectArchiveMetadata(content, digest).pending;
      return {
        release: Object.freeze({ manifest, archiveDigest, manifestDigest }),
        location: `sha256:${digest}`,
        withdrawn: false,
      };
    });
  });
  if (reach === undefined) return candidates;
  const closure = new Set(reach),
    pending = [...closure];
  while (pending.length) {
    const id = pending.pop()!;
    for (const c of candidates)
      if (c.release.manifest.id === id)
        for (const d of c.release.manifest.dependencies)
          if (!closure.has(d.id)) {
            closure.add(d.id);
            pending.push(d.id);
          }
  }
  return candidates.filter((c) => closure.has(c.release.manifest.id));
}

export interface RestoreRequest {
  readonly root: string;
  readonly lock?: DistributionLock;
  readonly catalog?: unknown;
  /**
   * Registry spec §6.3: the locked `id@version` pins the registry marks withdrawn (`registryWithdrawals`). Supplied, it
   * replaces the catalog: no catalog is read or matched, and the pins name the refusal verbatim. It excludes `catalog`
   * (INPUT-INVALID when both are given), and offline ignores it as it ignores the catalog.
   */
  readonly withdrawn?: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly offline?: boolean;
  readonly allowWithdrawn?: boolean;
  /** Prefix only; the service appends `: <ids>`. The caller owns it because it names its own opt-in. */
  readonly withdrawnRefusalPrefix?: string;
}
/** Withdrawal pins are distinct locked `id@version` strings, at most one per locked package. */
function registryPins(lock: DistributionLock, input: unknown): readonly string[] {
  const locked = new Set(lock.packages.map((p) => `${p.id}@${p.version}`));
  if (
    !Array.isArray(input) ||
    input.length > locked.size ||
    new Set(input).size !== input.length ||
    !input.every((pin) => typeof pin === 'string' && locked.has(pin))
  )
    fail('INPUT-INVALID', 'Expected distinct locked id@version withdrawal pins');
  return input as string[];
}
export interface RestorePlan {
  readonly plan: InstallationPlan;
  readonly withdrawn: readonly string[];
}
/** Planning only: acquisition and the withdrawal decision happen here, activation does not. */
export async function planRestore(request: RestoreRequest): Promise<RestorePlan> {
  request.signal?.throwIfAborted();
  const root = workspace(request.root),
    offline = request.offline === true;
  if (request.catalog !== undefined && request.withdrawn !== undefined)
    fail('INPUT-INVALID', 'Restore takes a catalog or registry withdrawals, not both');
  const lock = decodeDistributionLock(request.lock ?? readWorkspaceLock({ root })),
    withdrawn: string[] = [];
  if (!offline && request.withdrawn !== undefined) withdrawn.push(...registryPins(lock, request.withdrawn));
  else if (!offline) {
    const entries = await resolveCatalog({ root, entries: request.catalog, offline: false, signal: request.signal });
    for (const pkg of lock.packages) {
      const matches = entries.filter(
        (e) =>
          e.release.archiveDigest === pkg.archive &&
          e.release.manifestDigest === pkg.manifest &&
          e.release.manifest.id === pkg.id &&
          e.release.manifest.version === pkg.version,
      );
      if (!matches.length)
        fail(
          'RESTORE-REQUIRED',
          `Connected catalog lacks locked ${pkg.id}; use exact offline artifacts or supply the release entry`,
        );
      if (matches.some((e) => e.withdrawn)) withdrawn.push(pkg.id);
    }
  }
  if (withdrawn.length && request.allowWithdrawn !== true)
    fail(
      'RELEASE-WITHDRAWN',
      `${request.withdrawnRefusalPrefix ?? 'Explicit withdrawal acceptance is required for'}: ${withdrawn.join(', ')}`,
    );
  const archives = new Map<string, Uint8Array>();
  let total = 0;
  for (const pkg of lock.packages) {
    request.signal?.throwIfAborted();
    const content = pkg.location.startsWith('https:')
      ? await readArtifactBytes({ root, url: pkg.location, digest: pkg.archive, offline, signal: request.signal })
      : (bytes(root, cachePath(pkg.archive), DISTRIBUTION_LIMITS.compressed) ??
        fail('RESTORE-REQUIRED', `Missing cached archive ${pkg.archive}; supply its exact bytes`));
    total += content.length;
    if (total > DISTRIBUTION_LIMITS.expanded)
      fail('LIMIT-EXCEEDED', 'Combined restore archive selection exceeds its ceiling');
    archives.set(pkg.archive, content);
  }
  request.signal?.throwIfAborted();
  cacheSelectedArchiveClosure(root, lock, archives);
  return { plan: planInstallation(root, lock, 'restore'), withdrawn };
}
export function pruneLockRequest(options: { readonly lock: DistributionLock; readonly id: string }): DistributionLock {
  const { lock, id } = options;
  if (!lock.requests.some((r) => r.id === id))
    fail('INPUT-INVALID', 'Removal must name a directly requested distribution');
  const requests = lock.requests.filter((r) => r.id !== id),
    keep = new Set<string>(),
    byId = new Map(lock.packages.map((p) => [p.id, p]));
  const visit = (key: string): void => {
    if (keep.has(key)) return;
    keep.add(key);
    byId.get(key)!.dependencies.forEach(visit);
  };
  requests.forEach((r) => visit(r.id));
  if (keep.has(id)) fail('CONFLICT', 'Distribution is still required by another direct request');
  return decodeDistributionLock({ ...lock, requests, packages: lock.packages.filter((p) => keep.has(p.id)) });
}

export interface PackRequest {
  readonly sourceRoot: string;
  readonly descriptorPath: string;
  /** Resolved after packing, so no destination is selected or created for an archive that never exists. */
  readonly outputRoot: string | (() => string);
}
export interface PackedArchive {
  readonly status: 'packed';
  readonly path: string;
  readonly archive: string;
  readonly manifestDigest: string;
  readonly manifest: PackedDistribution['manifest'];
  readonly sourceFingerprint: string;
}
export function packToDirectory(request: PackRequest): PackedArchive {
  const root = workspace(request.sourceRoot),
    path = request.descriptorPath,
    descriptor = readWorkspaceFile({ root, path });
  const packed = packDistribution(root, utf8(descriptor));
  const out = workspace(typeof request.outputRoot === 'function' ? request.outputRoot() : request.outputRoot);
  if (!readWorkspaceFile({ root, path }).equals(descriptor))
    fail('SOURCE-CHANGED', 'Release descriptor changed during packing');
  const name = `${packed.archiveDigest}.ia.tgz`;
  createFile(out, name, packed.bytes);
  return {
    status: 'packed',
    path: name,
    archive: packed.archiveDigest,
    manifestDigest: packed.manifestDigest,
    manifest: packed.manifest,
    sourceFingerprint: packed.sourceFingerprint,
  };
}

export interface WorkspaceAdmission {
  readonly status: 'admitted' | 'refused';
  readonly revision: string;
  readonly findings: Findings;
  readonly records: number;
}
export interface WorkspaceSession {
  readonly reader: Handle;
  /** The complete disclosed workspace scope; refuses while admission has errors. */
  within(): string;
  admission(): WorkspaceAdmission;
  close(): void;
}
export function openWorkspaceSession(options: { readonly root: string }): WorkspaceSession {
  const reader = open(workspace(options.root), { cache: false });
  // Nothing is captured. formatSource refreshes this same handle, and reader.report is a live getter
  // over the state refresh() replaces, so a captured verdict beside a live revision could report an
  // admitted status next to error findings. The scope token is minted per call for the same reason:
  // refresh() builds a new view, an older token stays bound to the records of the older one, and a
  // draft admitted against those is admitted against a workspace the handle no longer reports.
  const errors = (): Findings => reader.report.findings.filter((f) => f.severity === 'error');
  return {
    reader,
    within: (): string => {
      if (errors().length) fail('CLOSURE-INCOMPLETE', 'Workspace admission failed; run validate for diagnostics');
      return reader.resolveScope().token;
    },
    admission: (): WorkspaceAdmission => {
      const findings = reader.report.findings;
      return {
        status: findings.some((f) => f.severity === 'error') ? 'refused' : 'admitted',
        revision: reader.revision,
        findings,
        records: reader.records().length,
      };
    },
    close: (): void => reader.close(),
  };
}
export function validateWorkspace(options: { readonly root: string }): WorkspaceAdmission {
  const session = openWorkspaceSession(options);
  try {
    return session.admission();
  } finally {
    session.close();
  }
}
export type FormatOutcome =
  | {
      readonly status: 'draft';
      readonly path: string;
      readonly text: string;
      readonly baseRevision: string;
      readonly candidateRevision: string;
      readonly findings: DraftResult['evidence']['findings'];
    }
  | { readonly status: 'refused'; readonly diagnostics: readonly unknown[] };
export interface FormatRequest {
  readonly session: WorkspaceSession;
  readonly path: string;
  readonly text: string;
  /** Re-reads the caller's source; a differing value means the returned draft describes stale input. */
  readonly reread?: () => string;
}
export function formatSource(request: FormatRequest): FormatOutcome {
  const reader = request.session.reader,
    within = request.session.within();
  const path = portable(request.path),
    baseRevision = reader.revision;
  let formatted: DraftResult;
  try {
    formatted = formatDraft({ reader, within, revision: baseRevision }, { path, text: request.text });
  } catch (error) {
    if (!(error instanceof DraftError)) throw error;
    if (error.code === 'IA-EXEC-OUTPUT-UNSAFE') fail('PATH-UNSAFE', error.message);
    return { status: 'refused', diagnostics: error.diagnostics };
  }
  if (reader.refresh().revision !== baseRevision || (request.reread?.() ?? request.text) !== request.text)
    fail('PLAN-STALE', 'Formatting inputs changed before returning the draft');
  return {
    status: 'draft',
    path,
    text: formatted.artifacts[0]!.text,
    baseRevision,
    candidateRevision: formatted.candidateRevision,
    findings: formatted.evidence.findings,
  };
}
