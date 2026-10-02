import { pathKey } from '@ia/db';
import { stableSerialize } from '@ia/graph';
import type { Capture } from './corpus.js';
import { canonicalPackageRoot, readPinnedResource, verifyPackageSource } from './resource-files.js';
import type { ResourceRoot } from './resource-files.js';
import {
  filePin,
  frozen,
  invalid,
  keyOf,
  list,
  metadataDigest,
  object,
  ordered,
  RESOURCE_LIMITS,
  ResourceError,
  sourceRevision,
} from './resource-format.js';
import type {
  CapturedResources,
  ResourceAssociation,
  ResourceFile,
  ResourceFilePin,
  ResourceOccurrence,
  ResourceResolution,
  ResourceResolveOptions,
  SourceRevision,
} from './resource-format.js';
import {
  nativeContext,
  requireScope,
  resolveResourcesWith,
  validateAssociations,
  verifyResourcesWith,
} from './resource-context.js';
export { RESOURCE_LIMITS, ResourceError } from './resource-format.js';
export { nativeResourcePath } from './resource-sources.js';
export type {
  CapturedResources,
  ResourceAssociation,
  ResourceFile,
  ResourceFilePin,
  ResourceKey,
  ResourceOccurrence,
  ResourceUse,
  SourceRevision,
  ResourceMediaType,
  ResourceRole,
  ResourceResolveOptions,
  ResolvedResource,
  ResourceResolution,
} from './resource-format.js';
export type { ResourceRoot } from './resource-files.js';

/** Privileged inventory over the caller-selected native capture; no disk access. */
export function resourceOccurrences(capture: Capture): {
  readonly sourceRevisions: readonly SourceRevision[];
  readonly occurrences: readonly ResourceOccurrence[];
} {
  const context = nativeContext(capture);
  return frozen({ sourceRevisions: context.sourceRevisions, occurrences: context.occurrences });
}
/** Exact decoding and admitted occurrence joins, with no filesystem or network reads. */
export function verifyResources(value: unknown, capture: Capture): CapturedResources {
  return verifyResourcesWith(value, nativeContext(capture));
}

export interface ResourceCaptureRequest {
  readonly roots: readonly ResourceRoot[];
  readonly files: readonly ResourceFilePin[];
  readonly associations: readonly ResourceAssociation[];
}
/** Capture only host-allowlisted bytes from pinned package sources; never publish. */
export function captureResources(capture: Capture, request: ResourceCaptureRequest): CapturedResources {
  try {
    object(request, ['roots', 'files', 'associations']);
    const context = nativeContext(capture),
      associations = validateAssociations(request.associations, context);
    const vector = new Map(context.sourceRevisions.map((row) => [row.source, row.revision])),
      roots = new Map<string, ResourceRoot>(),
      rootAliases = new Set<string>();
    for (const input of list(request.roots, context.sourceRevisions.length)) {
      const row = object(input, ['source', 'revision', 'root']),
        source = sourceRevision({ source: row['source'], revision: row['revision'] });
      if (typeof row['root'] !== 'string' || vector.get(source.source) !== source.revision || roots.has(source.source))
        invalid('Unselected or duplicate resource package root');
      // Two spellings of one root alias where the volume folds names: case on win32, case and normalization on darwin (#315).
      const root = canonicalPackageRoot(row['root']),
        alias = pathKey(root);
      if (rootAliases.has(alias)) invalid('Resource package roots must not alias');
      rootAliases.add(alias);
      roots.set(source.source, { ...source, root });
    }
    const pins = list(request.files, RESOURCE_LIMITS.files).map(filePin),
      needed = new Set(pins.map((pin) => pin.key.source));
    const associated = new Set(associations.flatMap((a) => a.resources.map((u) => keyOf(u.key)))),
      selectedPins = new Set(pins.map((pin) => keyOf(pin.key)));
    if (
      new Set(pins.map((pin) => keyOf(pin.key).toLowerCase())).size !== pins.length ||
      pins.some((pin) => !associated.has(keyOf(pin.key))) ||
      pins.reduce((sum, pin) => sum + pin.bytes, 0) > RESOURCE_LIMITS.totalBytes
    )
      invalid('Duplicate, unassociated or oversized resource file selection');
    if (associations.some((a) => a.resources.some((u) => u.required && !selectedPins.has(keyOf(u.key)))))
      invalid('Required resource is absent from the capture allowlist');
    if (Buffer.byteLength(stableSerialize({ pins, associations })) > RESOURCE_LIMITS.metadataBytes)
      invalid('Resource metadata exceeds its ceiling');
    if ([...roots.keys()].some((id) => !needed.has(id))) invalid('Resource capture supplied an unused package root');
    for (const root of roots.values()) verifyPackageSource(root, context.capture);
    const files: ResourceFile[] = pins.map((pin) => {
      const root = roots.get(pin.key.source);
      if (!root || root.revision !== pin.key.revision) invalid('Resource file has no matching selected package root');
      const bytes = readPinnedResource(root.root, pin);
      const content =
        pin.encoding === 'base64'
          ? bytes.toString('base64')
          : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { ...pin, content };
    });
    // Recheck the whole selection before returning an immutable snapshot.
    for (const pin of pins) readPinnedResource(roots.get(pin.key.source)!.root, pin);
    for (const root of roots.values()) verifyPackageSource(root, context.capture);
    const body = {
      format: 'ia.captured-resources.v1' as const,
      sourceRevisions: context.sourceRevisions,
      nativeCaptureRevision: context.capture.revision,
      files: ordered(files, (f) => keyOf(f.key)),
      associations,
    };
    return verifyResourcesWith({ ...body, digest: metadataDigest(body) }, context);
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    invalid('Resource capture failed; check selected roots, native revision and pinned file bytes');
  }
}

/** Intersect native scope with independent resource authority; required data is atomic. */
export function resolveResources(
  value: unknown,
  capture: Capture,
  options: ResourceResolveOptions,
): ResourceResolution {
  requireScope(options);
  return resolveResourcesWith(value, nativeContext(capture), options);
}
