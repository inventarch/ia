import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { unaliased } from '@ia/db';
import type { ReadHandle } from '@ia/db';
import { EditorSnapshot } from '@ia/db/editor';
import { createAuthoringIndex } from './authoring.js';
import type { AuthoringIndexInput, CapturedAuthoringIndex } from './authoring-types.js';
import { adoptWorkspace, captureWorkspace } from './corpus.js';
import type { Capture } from './corpus.js';
import { canonicalPackageRoot, verifyPackageSource } from './resource-files.js';
import {
  association as verifyAssociation,
  decodeJson,
  filePin,
  invalid,
  keyOf,
  list,
  metadataDigest,
  object,
  occurrenceOf,
  ordered,
  portablePath,
  RESOURCE_LIMITS,
  sourceRevision,
  text,
} from './resource-format.js';
import { captureResources, resourceOccurrences, verifyResources } from './resources.js';
import type {
  CapturedResources,
  ResourceAssociation,
  ResourceFile,
  ResourceFilePin,
  ResourceKey,
  ResourceOccurrence,
  ResourceRoot,
} from './resources.js';

export interface AuthoringManifestImport {
  readonly alias: string;
  readonly source: string;
  readonly revision: string;
}
export interface AuthoringManifestSource extends ResourceRoot {
  readonly imports: readonly AuthoringManifestImport[];
  readonly manifest: unknown;
}
export interface AuthoringManifestRequest {
  readonly sources: readonly AuthoringManifestSource[];
}
export interface AuthoringManifestByteSource {
  readonly source: string;
  readonly revision: string;
  readonly imports: readonly AuthoringManifestImport[];
  readonly manifest: unknown;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
export interface AuthoringManifestBytesRequest {
  readonly sources: readonly AuthoringManifestByteSource[];
}
export interface CapturedAuthoringManifest {
  readonly resources: CapturedResources;
  readonly index: CapturedAuthoringIndex;
}
export const AUTHORING_MANIFEST_PATH = '.ia/authoring.resources.json';

function detachedManifest(input: unknown): unknown {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > RESOURCE_LIMITS.metadataBytes)
      invalid('Authoring manifest exceeds its metadata ceiling');
    input = decodeJson(input);
  }
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 20 || bytes > RESOURCE_LIMITS.metadataBytes)
      invalid('Authoring manifest structure exceeds its ceiling');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('Non-finite authoring data');
      return value;
    }
    if (typeof value === 'string') {
      text(value, RESOURCE_LIMITS.metadataBytes);
      bytes += Buffer.byteLength(value);
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) invalid('Non-data or cyclic authoring manifest');
    const array = Array.isArray(value);
    if (array && value.length > 2000) invalid('Authoring manifest array exceeds its ceiling');
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      invalid('Authoring manifest must contain plain data');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(value),
      output: unknown[] | Record<string, unknown> = array ? [] : (Object.create(null) as Record<string, unknown>);
    if (array && keys.length !== value.length + 1) invalid('Sparse or extended authoring manifest array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const property = typeof key === 'string' ? descriptors[key] : undefined;
      if (
        typeof key !== 'string' ||
        !property?.enumerable ||
        !Object.hasOwn(property, 'value') ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        invalid('Authoring manifest contains non-data properties');
      bytes += Buffer.byteLength(key);
      Object.defineProperty(output, key, {
        value: copy(property.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && (output as unknown[]).length !== value.length) invalid('Sparse authoring manifest array');
    ancestors.delete(value);
    return output;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > RESOURCE_LIMITS.metadataBytes)
    invalid('Authoring manifest exceeds its metadata ceiling');
  return result;
}

export interface LocalAuthoringViewOptions {
  readonly root: string;
  readonly id: string;
  readonly adopted: readonly { readonly id: string; readonly root: string }[];
  /** Explicit physical package roots. `self` names the workspace capture; other values are exact captured source ids. */
  readonly manifests: readonly { readonly source: string; readonly root: string }[];
  readonly scope: { readonly root: string; readonly identities: readonly string[] | null };
}
export interface LocalAuthoringView extends CapturedAuthoringManifest {
  readonly capture: Capture;
  readonly reader: ReadHandle;
  readonly within: string;
  readonly systems: readonly string[];
  readonly registrations: readonly string[];
  assertCurrent(): void;
  close(): void;
}

/** Explicit trusted local host bridge. Every call captures a new view; retained hosts use the pure capture APIs instead. */
export function openLocalAuthoringView(options: LocalAuthoringViewOptions): LocalAuthoringView {
  object(options, ['root', 'id', 'adopted', 'manifests', 'scope']);
  const root = canonicalPackageRoot(options.root),
    id = text(options.id, 64);
  const adopted = list(options.adopted, 64).map((input) => {
    const row = object(input, ['id', 'root']);
    return { id: text(row['id'], 64), root: canonicalPackageRoot(text(row['root'], 4096)) };
  });
  const manifests = list(options.manifests, 64).map((input) => {
    const row = object(input, ['source', 'root']);
    return { source: text(row['source'], 64), root: canonicalPackageRoot(text(row['root'], 4096)) };
  });
  const selected = object(options.scope, ['root', 'identities']),
    scopeRoot = text(selected['root']);
  const identities = selected['identities'] === null ? null : list(selected['identities'], 2000).map((i) => text(i));
  const fixed: LocalAuthoringViewOptions = { root, id, adopted, manifests, scope: { root: scopeRoot, identities } };
  const capture = captureWorkspace(root, id, {
    adopted: adopted.map((source) => adoptWorkspace(source.root, source.id)),
  });
  const vector = resourceOccurrences(capture).sourceRevisions;
  const sources = manifests.map((source): AuthoringManifestSource => {
    const binding = vector.find((s) => s.source === (source.source === 'self' ? capture.id : source.source));
    if (!binding) invalid('Explicit authoring package is outside the captured source set');
    return {
      ...binding,
      root: source.root,
      imports: [{ alias: 'floor', source: capture.id, revision: capture.revision }],
      manifest: readAuthoringManifestFile(source.root),
    };
  });
  const captured = captureAuthoringManifest(capture, { sources });
  const reader = new EditorSnapshot({
    root,
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  try {
    const within = reader.resolveScope({ root: scopeRoot, ...(identities === null ? {} : { identities }) }).token,
      registry = reader.inspect().graph.registry;
    let closed = false;
    return Object.freeze({
      ...captured,
      capture,
      reader,
      within,
      systems: Object.freeze([...new Set([...registry.systems.keys(), 'floor'])].sort()),
      registrations: Object.freeze([...new Set([...registry.registrations.keys(), ...registry.blocked])].sort()),
      assertCurrent(): void {
        if (closed) invalid('Local authoring view is closed');
        const current = openLocalAuthoringView(fixed);
        try {
          if (
            current.capture.revision !== capture.revision ||
            current.resources.digest !== captured.resources.digest ||
            current.index.digest !== captured.index.digest
          )
            invalid('Local authoring source or selected resource view changed');
        } finally {
          current.close();
        }
      },
      close(): void {
        if (!closed) {
          closed = true;
          reader.close();
        }
      },
    });
  } catch (error) {
    reader.close();
    throw error;
  }
}

/** Read one explicitly bound data file. No directory enumeration or executable loading. */
export function readAuthoringManifestFile(inputRoot: string): unknown {
  const root = canonicalPackageRoot(inputRoot);
  const contained = (): string => {
    canonicalPackageRoot(root);
    let current = root;
    for (const part of AUTHORING_MANIFEST_PATH.split('/')) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) invalid('Authoring manifest crosses a filesystem alias');
    }
    // Another case or normalization of the same names is not an alias (#315); the loop above has refused every link.
    if (!unaliased(current, realpathSync.native(current))) invalid('Aliased authoring manifest');
    return current;
  };
  const path = contained(),
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > RESOURCE_LIMITS.metadataBytes)
      invalid('Authoring manifest must be one bounded regular file');
    const bytes = Buffer.alloc(RESOURCE_LIMITS.metadataBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd),
      current = lstatSync(contained());
    if (
      length > RESOURCE_LIMITS.metadataBytes ||
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1 ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs
    )
      invalid('Authoring manifest changed while loading');
    return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(fd);
  }
}

function dataRows(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid('Invalid authoring collection');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid('Sparse or extended authoring collection');
  const rows: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = fields[String(index)];
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid('Non-data authoring collection');
    rows.push(field.value);
  }
  return rows;
}
interface ManifestBinding {
  readonly source: string;
  readonly revision: string;
  readonly imports: readonly AuthoringManifestImport[];
  readonly manifest: unknown;
}
function bindSources(
  capture: Capture,
  request: unknown,
  field: 'root' | 'files',
): readonly (ManifestBinding & { readonly data: unknown })[] {
  const envelope = object(request, ['sources']),
    vector = new Map(resourceOccurrences(capture).sourceRevisions.map((s) => [s.source, s.revision]));
  const sources = new Map<string, ManifestBinding & { data: unknown }>();
  for (const input of dataRows(envelope['sources'], 64)) {
    const row = object(input, ['source', 'revision', field, 'imports', 'manifest']),
      source = sourceRevision({ source: row['source'], revision: row['revision'] });
    if (source.source === 'self' || sources.has(source.source) || vector.get(source.source) !== source.revision)
      invalid('Invalid or duplicate authoring source binding');
    const aliases = new Set<string>();
    const imports = dataRows(row['imports'], 64).map((input): AuthoringManifestImport => {
      const value = object(input, ['alias', 'source', 'revision']),
        alias = text(value['alias'], 64),
        selected = sourceRevision({ source: value['source'], revision: value['revision'] });
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(alias) ||
        alias === 'self' ||
        aliases.has(alias) ||
        vector.get(selected.source) !== selected.revision
      )
        invalid('Invalid, duplicate or unavailable authoring import');
      aliases.add(alias);
      return { alias, ...selected };
    });
    sources.set(source.source, { ...source, imports, manifest: row['manifest'], data: row[field] });
  }
  return [...sources.values()];
}
function resolveSelections(capture: Capture, sources: readonly ManifestBinding[]) {
  const native = resourceOccurrences(capture);
  const files: ResourceFilePin[] = [],
    associations: ResourceAssociation[] = [];
  const index: { -readonly [K in keyof AuthoringIndexInput]: AuthoringIndexInput[K][number][] } = {
    systems: [],
    artifacts: [],
    profiles: [],
    documents: [],
    lifecycles: [],
  };
  for (const source of sources) {
    const value = detachedManifest(source.manifest);
    const row = object(value, ['format', 'files', 'associations', 'index']);
    // The same bound applies to object input before any selected file is opened.
    if (
      row['format'] !== 'ia.authoring-resources.v1' ||
      Buffer.byteLength(JSON.stringify(row)) > RESOURCE_LIMITS.metadataBytes
    )
      invalid('Invalid authoring manifest format or size');
    const key = (input: unknown): ResourceKey => {
      const selector = object(input, ['source', 'path']),
        id = text(selector['source'], 64),
        selected = id === 'self' ? source : source.imports.find((i) => i.alias === id);
      if (!selected) invalid('Authoring selector names an unbound source');
      return { source: selected.source, revision: selected.revision, path: portablePath(selector['path']) };
    };
    const occurrence = (input: unknown): ResourceOccurrence => {
      const selector = object(input, ['source', 'path', 'identity']),
        selected = key({ source: selector['source'], path: selector['path'] }),
        identity = text(selector['identity']);
      const matches = native.occurrences.filter(
        (o) =>
          o.source === selected.source &&
          o.revision === selected.revision &&
          o.path === selected.path &&
          o.identity === identity,
      );
      if (matches.length !== 1) invalid('Authoring native selector is missing or ambiguous');
      return matches[0]!;
    };
    const nullableKey = (input: unknown): ResourceKey | null => (input === null ? null : key(input));
    for (const input of list(row['files'], RESOURCE_LIMITS.files)) {
      const file = object(input, ['path', 'bytes', 'sha256', 'mediaType', 'encoding']);
      files.push(
        filePin({
          key: { source: source.source, revision: source.revision, path: portablePath(file['path']) },
          bytes: file['bytes'],
          sha256: file['sha256'],
          mediaType: file['mediaType'],
          encoding: file['encoding'],
        }),
      );
    }
    for (const input of list(row['associations'], RESOURCE_LIMITS.owners)) {
      const association = object(input, ['owner', 'resources']);
      const resources = list(association['resources'], RESOURCE_LIMITS.uses).map((input) => {
        const use = object(input, ['key', 'role', 'order', 'required', 'delivery']);
        return { ...use, key: key(use['key']) };
      });
      associations.push(verifyAssociation({ owner: occurrence(association['owner']), resources }));
    }
    const raw = object(row['index'], ['systems', 'artifacts', 'profiles', 'documents', 'lifecycles']);
    for (const input of list(raw['systems'], 256)) {
      const system = object(input, ['system', 'authoring', 'architecture', 'extensions', 'methods', 'steward', 'base']);
      index.systems.push({
        system: occurrence(system['system']),
        authoring: list(system['authoring'], 64).map(key),
        architecture: list(system['architecture'], 64).map(key),
        extensions: list(system['extensions'], 64).map(key),
        methods: list(system['methods'], 64).map(occurrence),
        steward: system['steward'] === null ? null : occurrence(system['steward']),
        base: system['base'] === null ? null : occurrence(system['base']),
      });
    }
    for (const input of list(raw['artifacts'], 2000)) {
      const artifact = object(input, ['id', 'source', 'purpose', 'contract', 'dependencies', 'lifecycle']);
      const location = artifact['source'];
      if (location === null || typeof location !== 'object' || !Object.hasOwn(location, 'kind'))
        invalid('Invalid authoring artifact source');
      let sourceValue: AuthoringIndexInput['artifacts'][number]['source'];
      if ((location as { kind: unknown }).kind === 'native') {
        const value = object(location, ['kind', 'occurrence']);
        sourceValue = { kind: 'native', occurrence: occurrence(value['occurrence']) };
      } else {
        const value = object(location, ['kind', 'key', 'range']);
        if (value['kind'] !== 'resource') invalid('Invalid authoring artifact source kind');
        sourceValue = {
          kind: 'resource',
          key: key(value['key']),
          range: value['range'] as { start: number; end: number } | null,
        };
      }
      index.artifacts.push({
        ...artifact,
        source: sourceValue,
        contract: nullableKey(artifact['contract']),
      } as unknown as AuthoringIndexInput['artifacts'][number]);
    }
    for (const input of list(raw['profiles'], 256)) {
      const profile = object(input, ['id', 'version', 'roles', 'criteria']);
      const roles = list(profile['roles'], 200).map((input) => {
        const role = object(input, ['id', 'min', 'max', 'context', 'contract']);
        return { ...role, contract: nullableKey(role['contract']) };
      });
      index.profiles.push({ ...profile, roles } as unknown as AuthoringIndexInput['profiles'][number]);
    }
    index.documents.push(...(list(raw['documents'], 256) as AuthoringIndexInput['documents']));
    index.lifecycles.push(...(list(raw['lifecycles'], 256) as AuthoringIndexInput['lifecycles']));
  }
  return { files, associations, index };
}
/** Resolve closed author-selected metadata against the exact native capture, then capture only pinned bytes. */
export function captureAuthoringManifest(
  capture: Capture,
  request: AuthoringManifestRequest,
): CapturedAuthoringManifest {
  const sources = bindSources(capture, request, 'root').map(({ data, ...source }) => ({
    ...source,
    root: canonicalPackageRoot(text(data, 4096)),
  }));
  const { files, associations, index } = resolveSelections(capture, sources);
  for (const source of sources) verifyPackageSource(source, capture);
  const needed = new Set(files.map((file) => file.key.source));
  const resources = captureResources(capture, {
    roots: sources
      .filter((s) => needed.has(s.source))
      .map(({ source, revision, root }) => ({ source, revision, root })),
    files,
    associations,
  });
  return Object.freeze({ resources, index: createAuthoringIndex(capture, resources, index) });
}
/** Pure retained-byte counterpart; no roots, filesystem reads, discovery or executable loading. */
export function captureAuthoringManifestBytes(
  capture: Capture,
  request: AuthoringManifestBytesRequest,
): CapturedAuthoringManifest {
  const sources = bindSources(capture, request, 'files'),
    selections = resolveSelections(capture, sources);
  const content = new Map<string, string>();
  let bytes = 0;
  for (const source of sources)
    for (const value of dataRows(source.data, RESOURCE_LIMITS.files)) {
      const row = object(value, ['path', 'content']),
        path = portablePath(row['path']),
        body = text(row['content'], RESOURCE_LIMITS.fileBytes),
        key = keyOf({ source: source.source, revision: source.revision, path });
      bytes += Buffer.byteLength(body);
      if (content.has(key) || bytes > RESOURCE_LIMITS.totalBytes)
        invalid('Duplicate or oversized retained authoring resources');
      content.set(key, body);
    }
  if (content.size !== selections.files.length)
    invalid('Retained authoring bytes differ from the explicit file inventory');
  const files: ResourceFile[] = selections.files.map((pin) => {
    const selected = content.get(keyOf(pin.key));
    if (selected === undefined || pin.encoding !== 'utf8') invalid('Missing or non-UTF8 retained authoring resource');
    return { ...pin, content: selected };
  });
  const body = {
    format: 'ia.captured-resources.v1' as const,
    nativeCaptureRevision: capture.revision,
    sourceRevisions: resourceOccurrences(capture).sourceRevisions,
    files: ordered(files, (file) => keyOf(file.key)),
    associations: ordered(selections.associations, (association) => occurrenceOf(association.owner)),
  };
  const resources = verifyResources({ ...body, digest: metadataDigest(body) }, capture);
  return Object.freeze({ resources, index: createAuthoringIndex(capture, resources, selections.index) });
}
