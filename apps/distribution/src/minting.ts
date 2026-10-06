import { EditorSnapshot } from '@inventarch/db/editor';
import {
  decodeDistributionJson,
  decodeDistributionLock,
  deriveGenerationInputs,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  satisfies,
} from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import { verifyCapture, type Capture } from '@inventarch/agent-composition-system';
import { assessAuthoringMinting, resolveAuthoring } from '@inventarch/agent-composition-system/authoring';
import {
  AUTHORING_MANIFEST_PATH,
  captureAuthoringManifestBytes,
} from '@inventarch/agent-composition-system/authoring-manifest';
import { RESOURCE_LIMITS } from '@inventarch/agent-composition-system/resources';
import { digest } from '@inventarch/graph';
import { verifyArchive, type VerifiedArchive } from './archive.js';
import { distributionSnapshot } from './snapshot.js';
import { fail, utf8 } from './files.js';
import { KERNEL_SOURCES } from '@inventarch/language';

export interface MintingReleaseSet {
  readonly lock: unknown;
  readonly archives: ReadonlyMap<string, Uint8Array>;
}
export interface ReleaseMintingRequest {
  readonly floor: Capture['sources'];
  readonly baseline: MintingReleaseSet | null;
  readonly candidate: MintingReleaseSet;
  readonly policyRevision: string;
}
export interface ReleaseMintingAssessment {
  readonly format: 'ia.release-minting.v1';
  readonly ready: boolean;
  readonly semantic: 'not-evaluated';
  readonly floor: string;
  readonly policyRevision: string;
  readonly baseline: {
    readonly lock: DistributionLock | null;
    readonly capture: string;
    readonly view: string;
    readonly resources: string;
    readonly index: string;
  };
  readonly candidate: {
    readonly lock: DistributionLock;
    readonly capture: string;
    readonly view: string;
    readonly resources: string;
    readonly index: string;
  };
  readonly changed: ReturnType<typeof assessAuthoringMinting>['changed'];
  readonly legacyMissing: readonly string[];
  readonly assessment: string;
  readonly proof: string;
}
const refused = (): never =>
  fail('MINTING-INVALID', 'Explicit complete minting evidence is unavailable or inconsistent');
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
/** The installed immutable language floor can be selected only by its exact policy digest. */
export function installedMintingFloor(): { readonly sources: Capture['sources']; readonly digest: string } {
  const sources = distributionSnapshot({
    sources: KERNEL_SOURCES.map((source) => ({
      ...source,
      location: { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' },
    })),
    folders: [],
    floorOrigin: 'explicit',
  }).sources;
  return Object.freeze({ sources, digest: digest(sources) });
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    return refused();
  const names = Reflect.ownKeys(input),
    fields = Object.getOwnPropertyDescriptors(input);
  if (
    names.length !== keys.length ||
    names.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !fields[key]?.enumerable ||
        !Object.hasOwn(fields[key]!, 'value'),
    )
  )
    return refused();
  return input as Record<string, unknown>;
}
function releaseSet(input: unknown) {
  const row = object(input, ['lock', 'archives']),
    lock = decodeDistributionLock(row['lock']),
    archives = row['archives'];
  if (!satisfies(DISTRIBUTION_ENGINE_VERSION, lock.engine)) return refused();
  if (!(archives instanceof Map) || archives.size !== new Set(lock.packages.map((pkg) => pkg.archive)).size)
    return refused();
  const releases = new Map<string, VerifiedArchive>();
  let total = 0;
  for (const pkg of lock.packages) {
    const bytes: unknown = archives.get(pkg.archive);
    if (!(bytes instanceof Uint8Array) || (total += bytes.length) > DISTRIBUTION_LIMITS.expanded) return refused();
    const release = verifyArchive(bytes, pkg.archive);
    if (release.manifestDigest !== pkg.manifest || !satisfies(DISTRIBUTION_ENGINE_VERSION, release.manifest.engine))
      return refused();
    releases.set(pkg.id, release);
  }
  return { lock, releases, inputs: deriveGenerationInputs(lock, releases) };
}
function selectedView(floor: Capture['sources'], input: MintingReleaseSet | null) {
  const selected = input === null ? null : releaseSet(input),
    sources: Capture['sources'][number][] = [...floor];
  for (const system of selected?.inputs.systems ?? []) {
    const release = selected!.releases.get(system.selected)!;
    for (const path of system.files) {
      if (sources.some((source) => source.path === path)) return refused();
      sources.push({
        path,
        text: utf8(release.files.get(path)!),
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      });
    }
  }
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = {
    version: 1 as const,
    id: 'release-minting',
    floorOrigin: 'explicit' as const,
    folders: selected?.inputs.systems.map((system) => system.name) ?? [],
    sources,
  };
  const capture = verifyCapture({ ...body, revision: digest(body) });
  const reader = new EditorSnapshot({
    root: '.',
    sources,
    folders: body.folders,
    floorOrigin: body.floorOrigin,
    fingerprint: capture.revision,
  });
  try {
    const providers = [...(selected?.releases.values() ?? [])].filter((release) =>
      release.files.has(AUTHORING_MANIFEST_PATH),
    );
    if (providers.length > 1) return refused();
    const provider = providers[0],
      bytes = provider?.files.get(AUTHORING_MANIFEST_PATH);
    let request: Parameters<typeof captureAuthoringManifestBytes>[1] = { sources: [] };
    if (provider && bytes) {
      if (bytes.length > RESOURCE_LIMITS.metadataBytes) return refused();
      const manifest = decodeDistributionJson(utf8(bytes));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return refused();
      const rows = (manifest as Record<string, unknown>)['files'];
      if (!Array.isArray(rows) || rows.length > RESOURCE_LIMITS.files) return refused();
      const files = rows.map((input: unknown) => {
        if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>)['path'] !== 'string')
          return refused();
        const path = (input as { path: string }).path,
          content = provider.files.get(path);
        if (!content) return refused();
        return { path, content: utf8(content) };
      });
      request = {
        sources: [
          {
            source: capture.id,
            revision: capture.revision,
            imports: [{ alias: 'floor', source: capture.id, revision: capture.revision }],
            manifest,
            files,
          },
        ],
      };
    }
    const authoring = captureAuthoringManifestBytes(capture, request),
      registry = reader.inspect().graph.registry;
    const view = resolveAuthoring(capture, authoring.resources, authoring.index, {
      reader,
      within: reader.resolveScope().token,
      allowedResources: authoring.resources.files.map((file) => file.key),
      allowedSystems: [...registry.systems.keys(), 'floor'],
      allowedRegistrations: [...registry.registrations.keys()],
      allowedArtifacts: authoring.index.artifacts.map((artifact) => artifact.id),
      allowedDocuments: authoring.index.documents.map((document) => document.id),
    });
    return {
      view,
      reader,
      pin: {
        lock: selected?.lock ?? null,
        capture: capture.revision,
        view: view.proof,
        resources: authoring.resources.digest,
        index: authoring.index.digest,
      },
    };
  } catch (error) {
    reader.close();
    throw error;
  }
}
/** Exact structural comparison only; the invoking host retains current publication authority. */
export function assessReleaseMinting(input: ReleaseMintingRequest): ReleaseMintingAssessment {
  const row = object(input, ['floor', 'baseline', 'candidate', 'policyRevision']);
  if (typeof row['policyRevision'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['policyRevision'])) return refused();
  const floor = distributionSnapshot({ sources: row['floor'], folders: [], floorOrigin: 'explicit' }).sources;
  if (!floor.length || floor.some((source) => source.location.placement.kind !== 'floor')) return refused();
  const baseline = selectedView(floor, row['baseline'] as MintingReleaseSet | null);
  try {
    const candidate = selectedView(floor, row['candidate'] as MintingReleaseSet);
    try {
      if (candidate.pin.lock === null) return refused();
      const assessment = assessAuthoringMinting(baseline.view, candidate.view);
      const body = {
        format: 'ia.release-minting.v1' as const,
        ready: assessment.ready,
        semantic: 'not-evaluated' as const,
        floor: digest(floor),
        policyRevision: row['policyRevision'],
        baseline: baseline.pin,
        candidate: { ...candidate.pin, lock: candidate.pin.lock },
        changed: assessment.changed,
        legacyMissing: assessment.legacyMissing,
        assessment: assessment.proof,
      };
      return frozen({ ...body, proof: digest(body) });
    } finally {
      candidate.reader.close();
    }
  } finally {
    baseline.reader.close();
  }
}
