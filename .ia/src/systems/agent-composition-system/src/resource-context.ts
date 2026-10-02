// Internal seam: one verified native context shared by resource and projection callers. Not a package subpath.
import { EditorSnapshot } from '@ia/db/editor';
import { stableSerialize } from '@ia/graph';
import { verifyCapture } from './corpus.js';
import type { Capture } from './corpus.js';
import { installedId, installedSource, resourcePrefix } from './resource-sources.js';
import {
  association,
  decodeJson,
  file,
  frozen,
  hash,
  integer,
  invalid,
  keyOf,
  list,
  metadataDigest,
  object,
  occurrence,
  occurrenceOf,
  ordered,
  portablePath,
  RESOURCE_LIMITS,
  resourceKey,
  sourceRevision,
} from './resource-format.js';
import type {
  CapturedResources,
  ResolvedResource,
  ResourceAssociation,
  ResourceKey,
  ResourceOccurrence,
  ResourceResolution,
  ResourceResolveOptions,
  SourceRevision,
} from './resource-format.js';

/** One verified, frozen copy of the caller's capture and the admission derived from it. */
export interface NativeContext {
  readonly capture: Capture;
  readonly sourceRevisions: readonly SourceRevision[];
  readonly occurrences: readonly ResourceOccurrence[];
  readonly viewRevision: string;
}

/** Most contexts this module instance retains, for its lifetime; each pins one capture under corpus.ts's 20 MiB canonical ceiling. */
export const NATIVE_CONTEXT_ENTRIES = 4;
// Least recently used first. The key is the revision verifyCapture recomputed over the one copy it returns: that
// revision digests every other capture field, so an equal key means equal bytes. The build reads nothing else that
// changes its output (process.cwd() only names the reader root), and each value is deeply frozen, so it is shared.
const contexts = new Map<string, NativeContext>();
/** Drops every retained context. */
export function clearNativeContexts(): void {
  contexts.clear();
}

/** Verifies the caller's capture on every call, then reuses the context already built from the same verified bytes. */
export function nativeContext(input: Capture): NativeContext {
  const capture = verifyCapture(input),
    cached = contexts.get(capture.revision);
  if (cached) {
    contexts.delete(capture.revision);
    contexts.set(capture.revision, cached);
    return cached;
  }
  const context = buildNativeContext(frozen(capture));
  contexts.set(capture.revision, context);
  if (contexts.size > NATIVE_CONTEXT_ENTRIES) contexts.delete(contexts.keys().next().value!);
  return context;
}

function buildNativeContext(capture: Capture): NativeContext {
  const revisions = new Map<string, string>([[capture.id, capture.revision]]),
    groups = new Map<string, { path: string; text: string }[]>(),
    qualified = new Map<string, ResourceKey>();
  const installed = new Map<string, string>();
  for (const source of capture.sources) {
    const bundle = installedSource(source.path);
    if (bundle) {
      const id = installedId(bundle[1]!),
        path = portablePath(bundle[2]!);
      if (
        !capture.activation ||
        id === capture.id ||
        source.location.placement.kind !== 'adopted' ||
        path.startsWith('.ia/src/floor/') ||
        (installed.has(id) && installed.get(id) !== bundle[1])
      )
        invalid('Conflicting installed resource source');
      installed.set(id, bundle[1]!);
      const rows = groups.get(id) ?? [];
      rows.push({ path, text: source.text });
      groups.set(id, rows);
      qualified.set(source.path, { source: id, revision: '', path });
      continue;
    }
    const adopted = /^\.ia\/adopted\/([a-z][a-z0-9-]{0,63})\/([a-f0-9]{64})\/(\.ia\/src\/.+)$/.exec(source.path);
    if (adopted) {
      const id = adopted[1]!,
        revision = adopted[2]!,
        path = adopted[3]!;
      portablePath(path);
      if (
        id === capture.id ||
        source.location.placement.kind !== 'adopted' ||
        path.startsWith('.ia/src/floor/') ||
        (revisions.has(id) && revisions.get(id) !== revision)
      )
        invalid('Conflicting adopted resource source');
      revisions.set(id, revision);
      const rows = groups.get(id) ?? [];
      rows.push({ path, text: source.text });
      groups.set(id, rows);
      qualified.set(source.path, { source: id, revision, path });
    } else {
      const generated =
        capture.activation &&
        source.path === `.ia/distributions/generations/${capture.activation.generation}/workspace.ia`;
      if ((!source.path.startsWith('.ia/src/') && !generated) || source.location.placement.kind === 'adopted')
        invalid('Unqualified native resource source');
      portablePath(source.path);
      qualified.set(source.path, { source: capture.id, revision: capture.revision, path: source.path });
    }
  }
  for (const [id, rows] of groups) {
    const revision = metadataDigest(ordered(rows, (row) => row.path));
    if (installed.has(id)) {
      if (revisions.has(id)) invalid('Installed/adopted resource identity collision');
      revisions.set(id, revision);
      for (const [path, key] of qualified) if (key.source === id) qualified.set(path, { ...key, revision });
    } else if (revision !== revisions.get(id)) invalid('Adopted source revision differs from its exact native bytes');
  }
  const reader = new EditorSnapshot({
    root: process.cwd(),
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  try {
    const scope = reader.resolveScope(),
      occurrences = reader
        .records({ within: scope.token })
        .map((record) =>
          occurrence({ ...qualified.get(record.source.path)!, identity: record.identity, line: record.source.line }),
        );
    return frozen({
      capture,
      sourceRevisions: ordered(
        [...revisions].map(([source, revision]) => ({ source, revision })),
        (row) => row.source,
      ),
      occurrences: ordered(occurrences, occurrenceOf),
      viewRevision: reader.revision,
    });
  } finally {
    reader.close();
  }
}

/** Key for an admitted occurrence at its native capture path; the tuple form cannot collide. */
export const nativeCoordinate = (identity: string, line: number, path: string): string =>
  JSON.stringify([identity, line, path]);
// Safe to cache by identity: nativeContext returns a deeply frozen context.
const coordinates = new WeakMap<NativeContext, ReadonlyMap<string, ResourceOccurrence>>();
/** Occurrences by native coordinate, built once per context. The first occurrence in canonical order wins. */
export function occurrencesByCoordinate(context: NativeContext): ReadonlyMap<string, ResourceOccurrence> {
  const cached = coordinates.get(context);
  if (cached) return cached;
  const prefixes = new Map<string, string>(),
    index = new Map<string, ResourceOccurrence>();
  for (const o of context.occurrences) {
    const source = JSON.stringify([o.source, o.revision]);
    let prefix = prefixes.get(source);
    if (prefix === undefined) {
      prefix = resourcePrefix(context.capture, o);
      prefixes.set(source, prefix);
    }
    const key = nativeCoordinate(o.identity, o.line, prefix + o.path);
    if (!index.has(key)) index.set(key, o);
  }
  coordinates.set(context, index);
  return index;
}

export function validateAssociations(inputs: unknown, context: NativeContext): ResourceAssociation[] {
  const owners = new Set(context.occurrences.map(occurrenceOf)),
    seen = new Set<string>(),
    sources = new Map(context.sourceRevisions.map((row) => [row.source, row.revision]));
  return ordered(
    list(inputs, RESOURCE_LIMITS.owners).map((input) => {
      const row = association(input),
        key = occurrenceOf(row.owner);
      if (!owners.has(key) || seen.has(key)) invalid('Resource owner is missing, ambiguous, unadmitted or duplicated');
      seen.add(key);
      for (const use of row.resources)
        if (sources.get(use.key.source) !== use.key.revision)
          invalid('Resource association names an unavailable source revision');
      return row;
    }),
    (row) => occurrenceOf(row.owner),
  );
}

/** verifyResources over an existing context. */
export function verifyResourcesWith(input: unknown, context: NativeContext): CapturedResources {
  const value = typeof input === 'string' ? decodeJson(input) : input;
  const row = object(value, ['format', 'sourceRevisions', 'nativeCaptureRevision', 'files', 'associations', 'digest']);
  if (row['format'] !== 'ia.captured-resources.v1' || row['nativeCaptureRevision'] !== context.capture.revision)
    invalid('Resource format or native capture revision differs');
  const sourceRevisions = list(row['sourceRevisions'], RESOURCE_LIMITS.owners + 1).map(sourceRevision);
  if (stableSerialize(sourceRevisions) !== stableSerialize(context.sourceRevisions))
    invalid('Resource source vector differs from the complete native capture');
  const associations = validateAssociations(row['associations'], context),
    uses = new Map(associations.flatMap((a) => a.resources.map((u) => [keyOf(u.key), u] as const)));
  const aliases = new Set<string>();
  let total = 0;
  const files = list(row['files'], RESOURCE_LIMITS.files).map((value) => {
    const result = file(value),
      key = keyOf(result.key),
      alias = key.toLowerCase();
    if (aliases.has(alias) || !uses.has(key)) invalid('Duplicate, aliased or unassociated resource file');
    aliases.add(alias);
    total += result.bytes;
    return result;
  });
  if (total > RESOURCE_LIMITS.totalBytes) invalid('Captured resource bytes exceed their total ceiling');
  const available = new Set(files.map((f) => keyOf(f.key)));
  for (const association of associations)
    for (const use of association.resources)
      if (use.required && !available.has(keyOf(use.key))) invalid('Required associated resource is missing');
  const body = {
    format: 'ia.captured-resources.v1' as const,
    sourceRevisions,
    nativeCaptureRevision: context.capture.revision,
    files: ordered(files, (f) => keyOf(f.key)),
    associations,
  };
  if (
    stableSerialize(body.files) !== stableSerialize(row['files']) ||
    stableSerialize(associations) !== stableSerialize(row['associations'])
  )
    invalid('Resource inventories must use canonical ordering');
  if (
    Buffer.byteLength(stableSerialize({ ...body, files: body.files.map(({ content: _content, ...pin }) => pin) })) >
    RESOURCE_LIMITS.metadataBytes
  )
    invalid('Resource metadata exceeds its ceiling');
  const digest = hash(row['digest']);
  if (metadataDigest(body) !== digest) invalid('Resource envelope digest differs');
  const result = { ...body, digest };
  if (Buffer.byteLength(JSON.stringify(result)) > RESOURCE_LIMITS.serializedBytes)
    invalid('Serialized resource envelope exceeds its ceiling');
  return frozen(result);
}

export function requireScope(options: ResourceResolveOptions): void {
  if (typeof options.within !== 'string' || !options.within)
    invalid('Resource resolution requires an explicit native scope token');
}
/** resolveResources over an existing context. Every reader, scope, digest and owner check runs on each call. */
export function resolveResourcesWith(
  value: unknown,
  context: NativeContext,
  options: ResourceResolveOptions,
): ResourceResolution {
  requireScope(options);
  const resources = verifyResourcesWith(value, context),
    budget = integer(options.maxBytes, RESOURCE_LIMITS.totalBytes);
  if (hash(options.expectedDigest) !== resources.digest) invalid('Resource selection is stale');
  const current = options.reader.snapshot({ within: options.within });
  if (options.reader.revision !== context.viewRevision)
    invalid('Native resource view differs from the captured source generation');
  const index = occurrencesByCoordinate(context);
  const admitted = new Set(
    current.records.map((record) => {
      const owner = index.get(nativeCoordinate(record.identity, record.source.line, record.source.path));
      return owner ? occurrenceOf(owner) : '';
    }),
  );
  const owners = list(options.owners, RESOURCE_LIMITS.owners).map(occurrence),
    selected = new Set(owners.map(occurrenceOf));
  if (selected.size !== owners.length || [...selected].some((key) => !admitted.has(key)))
    invalid('Resource owner is outside the current native scope');
  const allowed = list(options.allowedResources, RESOURCE_LIMITS.files).map(resourceKey),
    permissions = new Set(allowed.map(keyOf));
  if (permissions.size !== allowed.length) invalid('Duplicate resource permission key');
  const files = new Map(resources.files.map((f) => [keyOf(f.key), f])),
    associations = new Map(resources.associations.map((a) => [occurrenceOf(a.owner), a]));
  const candidates: ResolvedResource[] = [],
    omissions: ResourceResolution['omissions'][number][] = [];
  let requiredBytes = 0;
  for (const owner of ordered(owners, occurrenceOf)) {
    const row = associations.get(occurrenceOf(owner));
    if (!row) invalid('Selected owner has no captured resource association');
    for (const use of row.resources) {
      const key = keyOf(use.key),
        file = files.get(key),
        reason = !permissions.has(key) ? 'excluded' : !file ? 'missing' : undefined;
      if (reason) {
        if (use.required) invalid('Required resource is missing or outside the current resource permission');
        omissions.push({ owner, key: use.key, reason });
        continue;
      }
      if (use.required) requiredBytes += file!.bytes;
      candidates.push({
        owner,
        use,
        file: file!,
        citation: `${key}#sha256=${file!.sha256}`,
        reference: `resources/${use.key.source}/${use.key.revision}/${file!.sha256}/${use.key.path}`,
      });
    }
  }
  if (requiredBytes > budget) invalid('Required resources exceed the delivery budget');
  const items: ResolvedResource[] = [];
  let bytes = requiredBytes;
  for (const item of candidates) {
    if (!item.use.required && bytes + item.file.bytes > budget)
      omissions.push({ owner: item.owner, key: item.use.key, reason: 'budget' });
    else {
      items.push(item);
      if (!item.use.required) bytes += item.file.bytes;
    }
  }
  return frozen({
    digest: resources.digest,
    nativeCaptureRevision: context.capture.revision,
    viewRevision: current.revision,
    items,
    omissions,
    bytes,
  });
}
