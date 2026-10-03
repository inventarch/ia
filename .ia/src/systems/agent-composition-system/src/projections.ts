import type { ReadHandle } from '@inventarch/db';
import type { CompiledChild, CompiledRecord, CompiledValue } from '@inventarch/language';
import type { Capture } from './corpus.js';
import type { CapturedResources, ResourceKey, ResourceOccurrence } from './resources.js';
import {
  nativeContext,
  nativeCoordinate,
  occurrencesByCoordinate,
  resolveResourcesWith,
  verifyResourcesWith,
} from './resource-context.js';
import {
  frozen,
  hash,
  keyOf,
  metadataDigest,
  occurrenceOf,
  ordered,
  portablePath,
  sha256,
  ResourceError,
} from './resource-format.js';
import {
  fail,
  id,
  inputFailure,
  PROJECTION_LIMITS,
  ProjectionError,
  verifyProjectionDescriptor,
} from './projection-format.js';
import type {
  ProjectionDiagnostic,
  ProjectionExport,
  ProjectionFile,
  ProjectionManifest,
  ProjectionOmission,
  ProjectionOutput,
  ProjectionResult,
} from './projection-format.js';
import {
  checkFeatures,
  codexAgentRegistration,
  discoveryLink,
  inert,
  invocation,
  isCodex,
  outputPath,
  pluginFile,
  renderRecord,
  resourceDestination,
  resourceMarkdown,
  serializeExport,
  verifyCatalog,
} from './projection-host.js';
import type { ProjectionCatalog } from './projection-host.js';

export { PROJECTION_LIMITS, ProjectionError, verifyProjectionDescriptor } from './projection-format.js';
export type {
  Presentation,
  ProfilePin,
  ProjectionArgument,
  ProjectionCode,
  ProjectionDescriptor,
  ProjectionDiagnostic,
  ProjectionExport,
  ProjectionFile,
  ProjectionManifest,
  ProjectionOmission,
  ProjectionOutput,
  ProjectionPattern,
  ProjectionResult,
} from './projection-format.js';
export {
  claudeProseCatalog,
  codexProseCatalog,
  CLAUDE_PROSE_FEATURES,
  CODEX_PROSE_FEATURES,
} from './projection-host.js';
export type { ProjectionCatalog } from './projection-host.js';
export interface ProjectionOptions {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly allowedResources: readonly ResourceKey[];
  readonly expectedResourcesDigest: string;
  readonly inventoryDigest: string;
  readonly catalog: ProjectionCatalog;
  readonly name: string;
  readonly version: string;
}

function references(value: CompiledValue): Extract<CompiledValue, { kind: 'ref' }>[] {
  return value.kind === 'ref' ? [value] : value.kind === 'list' ? value.items.flatMap(references) : [];
}
function fieldReferences(fields: readonly CompiledChild[]): Extract<CompiledValue, { kind: 'ref' }>[] {
  return fields.flatMap((f) =>
    'item' in f ? references(f.item) : [...references(f.value), ...fieldReferences(f.fields ?? [])],
  );
}
/** One export's dependency closure over the host's current scoped reader. */
class NativeClosure {
  readonly selected = new Map<string, CompiledRecord>();
  readonly scoped: readonly CompiledRecord[];
  readonly owners: ReadonlyMap<string, ResourceOccurrence>;
  constructor(
    readonly options: ProjectionOptions,
    available: ReadonlyMap<string, ResourceOccurrence>,
  ) {
    this.scoped = options.reader.records({ within: options.within });
    // Scoped winners join admitted occurrences through the shared first-match coordinate index.
    this.owners = new Map(
      this.scoped.flatMap((r) => {
        const o = available.get(nativeCoordinate(r.identity, r.source.line, r.source.path));
        return o ? [[r.identity, o] as const] : [];
      }),
    );
  }
  exact(owner: ResourceOccurrence, discriminator?: string): CompiledRecord {
    const admitted = this.owners.get(owner.identity),
      record = this.scoped.find((r) => r.identity === owner.identity);
    if (
      !admitted ||
      occurrenceOf(admitted) !== occurrenceOf(owner) ||
      !record ||
      (discriminator && record.discriminator !== discriminator)
    )
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Expected one exact admitted occurrence in the current scope', owner);
    return record;
  }
  resolve(reference: Parameters<ReadHandle['resolve']>[0], owner: ResourceOccurrence): CompiledRecord {
    const result = this.options.reader.resolve(reference, { within: this.options.within });
    if (!result.ok)
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Native dependency is unresolved, ambiguous or scope-excluded', owner);
    const target = this.owners.get(result.identity);
    if (!target) fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Native dependency has no exact captured occurrence', owner);
    return this.exact(target);
  }
  add(record: CompiledRecord, depth = 0, compositionAncestors: readonly string[] = []): void {
    const owner = this.owners.get(record.identity)!;
    if (compositionAncestors.includes(record.identity))
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Cyclic native composition dependency', owner);
    if (depth > PROJECTION_LIMITS.depth)
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Projection dependency depth exceeded', owner);
    if (this.selected.has(record.identity)) return;
    this.selected.set(record.identity, record);
    if (this.selected.size > PROJECTION_LIMITS.occurrences)
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Projection occurrence ceiling exceeded');
    for (const section of record.sections) {
      if (section.name === 'relationships') continue;
      for (const ref of fieldReferences(section.fields)) {
        this.add(
          this.resolve(ref, owner),
          depth + 1,
          section.name === 'composition' ? [...compositionAncestors, record.identity] : [],
        );
      }
    }
    for (const edge of record.edges) {
      if (
        (['cite', 'use', 'require'].includes(edge.predicate) && edge.direction === 'out') ||
        (edge.predicate === 'govern' && edge.direction === 'in')
      )
        this.add(this.resolve(edge.reference, owner), depth + 1);
    }
    // Governing edges are resolved through the same scoped reader, never an unfiltered graph.
    for (const candidate of this.scoped)
      for (const edge of candidate.edges)
        if (edge.predicate === 'govern' && edge.direction === 'out') {
          const target = this.options.reader.resolve(edge.reference, { within: this.options.within });
          if (target.ok && target.identity === record.identity) this.add(candidate, depth + 1);
        }
  }
  export(entry: ProjectionExport): void {
    this.add(this.exact(entry.target));
    const p = entry.presentation;
    if (p.kind !== 'agent') {
      if (!['capability', 'playbook'].includes(this.exact(entry.target).discriminator))
        fail(
          'IA-PROJECTION-SOURCE-UNAVAILABLE',
          'Skill/command target must be an admitted capability or playbook',
          entry.target,
        );
      for (const owner of p.body) this.add(this.exact(owner));
      return;
    }
    if (occurrenceOf(p.agent) !== occurrenceOf(entry.target))
      inputFailure('Agent export target and presentation agent differ');
    this.add(this.exact(p.agent, 'agent'));
    if (p.voice) this.add(this.exact(p.voice, 'voice'));
    if (p.mandate) this.add(this.exact(p.mandate, 'mandate'));
    if (p.agentProfile) {
      const profile = this.exact(p.agentProfile, 'agent-profile');
      const delegates = profile.sections
        .filter((s) => s.name === 'composition')
        .flatMap((s) => s.fields)
        .filter((f) => 'key' in f && f.key === 'delegates');
      if (fieldReferences(delegates).length)
        fail(
          'IA-PROJECTION-FEATURE-UNAVAILABLE',
          'Native delegation needs a separately qualified host mapping',
          p.agentProfile,
        );
      const model = profile.sections
        .filter((s) => s.name === 'execution')
        .flatMap((s) => s.fields)
        .find((f) => 'key' in f && f.key === 'model-profile');
      if (model && 'value' in model && (!('text' in model.value) || model.value.text !== p.model))
        fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Model metadata differs from its native profile', p.agentProfile);
      for (const [field, explicit] of [
        ['agent', p.agent],
        ['voice', p.voice],
        ['mandate', p.mandate],
      ] as const) {
        const matches = profile.sections
          .filter((s) => s.name === 'composition')
          .flatMap((s) => s.fields)
          .filter((f) => 'key' in f && f.key === field);
        if (explicit) {
          const value = matches[0];
          if (
            matches.length !== 1 ||
            !value ||
            !('value' in value) ||
            value.when ||
            value.value.kind !== 'ref' ||
            this.resolve(value.value, p.agentProfile).identity !== explicit.identity
          )
            fail(
              'IA-PROJECTION-SOURCE-UNAVAILABLE',
              'Authored presentation contradicts its native agent profile',
              explicit,
            );
        }
      }
      this.add(profile);
    }
  }
  occurrences(): ResourceOccurrence[] {
    return ordered(
      [...this.selected.keys()].map((id) => this.owners.get(id)!),
      occurrenceOf,
    );
  }
}

function diagnostic(error: unknown): ProjectionDiagnostic {
  if (error instanceof ProjectionError) return error.diagnostic;
  if (error instanceof ResourceError) return { code: 'IA-RESOURCE-INVALID', message: error.message };
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('IA-DB-')
  )
    return { code: 'IA-PROJECTION-SOURCE-UNAVAILABLE', message: 'Current native scope is unavailable' };
  return { code: 'IA-PROJECTION-INPUT-INVALID', message: 'Invalid projection capture, catalog or request' };
}

/** Pure projection over captured inputs and a host-selected current scoped reader. */
export function compileProjection(
  capture: Capture,
  descriptor: unknown,
  inputResources: unknown,
  options: ProjectionOptions,
): ProjectionResult {
  try {
    // One verified capture copy and one native context serve the whole compile; per-export checks below still run.
    const description = verifyProjectionDescriptor(descriptor),
      context = nativeContext(capture),
      resources: CapturedResources = verifyResourcesWith(inputResources, context),
      catalog = verifyCatalog(options.catalog);
    id(options.name);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(options.version)) inputFailure('Invalid product version');
    if (
      metadataDigest(description.sourceRevisions) !== metadataDigest(context.sourceRevisions) ||
      description.resourcesDigest !== resources.digest ||
      description.inventoryDigest !== hash(options.inventoryDigest)
    )
      fail('IA-PROJECTION-SOURCE-UNAVAILABLE', 'Projection source/resource/inventory selection is stale');
    // This also validates token and whole native view even when no export uses resources.
    resolveResourcesWith(resources, context, {
      reader: options.reader,
      within: options.within,
      owners: [],
      allowedResources: options.allowedResources,
      expectedDigest: options.expectedResourcesDigest,
      maxBytes: PROJECTION_LIMITS.totalBytes,
    });
    const available = occurrencesByCoordinate(context),
      namespaces = new Set<string>();
    for (const entry of description.exports) {
      const key = `${entry.presentation.kind === 'agent' && !(isCodex(catalog) && description.product === 'plugin') ? 'agent' : 'invocation'}:${entry.outputName}`;
      if (namespaces.has(key)) inputFailure('Conflicting projection output name');
      namespaces.add(key);
    }
    const files = new Map<string, ProjectionFile>(),
      outputs = new Map<string, ProjectionOutput>(),
      omissions: ProjectionOmission[] = [],
      exported: ProjectionManifest['exports'][number][] = [];
    const add = (
      path: string,
      bytes: Buffer,
      encoding: 'utf8' | 'base64',
      role: ProjectionOutput['role'],
      sources: readonly ResourceOccurrence[],
      keys: readonly ResourceKey[],
    ) => {
      portablePath(path);
      const sha = sha256(bytes),
        existing = files.get(path.toLowerCase());
      if (existing && (existing.path !== path || existing.sha256 !== sha || role !== 'resource'))
        inputFailure('Conflicting generated output path');
      if (bytes.length > PROJECTION_LIMITS.fileBytes) inputFailure('Generated file exceeds its byte ceiling');
      files.set(path.toLowerCase(), {
        path,
        bytes: bytes.length,
        sha256: sha,
        encoding,
        content: bytes.toString(encoding),
      });
      const previous = outputs.get(path);
      const owners = ordered(
        [...new Map([...(previous?.sources ?? []), ...sources].map((o) => [occurrenceOf(o), o])).values()],
        occurrenceOf,
      );
      outputs.set(path, {
        path,
        bytes: bytes.length,
        sha256: sha,
        role,
        sources: owners,
        resources: ordered(
          [...new Map([...(previous?.resources ?? []), ...keys].map((k) => [keyOf(k), k])).values()],
          keyOf,
        ),
      });
    };
    for (const entry of description.exports) {
      try {
        const selected = description.profiles.find((p) => p.id === entry.profile)!;
        if (metadataDigest(selected) !== metadataDigest(catalog.profile))
          fail(
            'IA-PROJECTION-FEATURE-UNAVAILABLE',
            'Selected host profile is unavailable or has changed',
            entry.target,
          );
        checkFeatures(entry, catalog, description.product);
        const closure = new NativeClosure(options, available);
        closure.export(entry);
        const owners = closure.occurrences(),
          associated = resources.associations.filter((a) =>
            owners.some((o) => occurrenceOf(o) === occurrenceOf(a.owner)),
          );
        const declared = associated.find((a) => occurrenceOf(a.owner) === occurrenceOf(entry.target))?.resources ?? [];
        if (metadataDigest(entry.resources) !== metadataDigest(declared))
          fail('IA-RESOURCE-INVALID', 'Export resources differ from the captured target association', entry.target);
        const resolution = resolveResourcesWith(resources, context, {
          reader: options.reader,
          within: options.within,
          owners: associated.map((a) => a.owner),
          allowedResources: options.allowedResources,
          expectedDigest: options.expectedResourcesDigest,
          maxBytes: PROJECTION_LIMITS.totalBytes,
        });
        const selectedFiles = [...new Map(resolution.items.map((r) => [keyOf(r.file.key), r.file])).values()];
        const destinations = new Map(
          selectedFiles.map((f) => [keyOf(f.key), resourceDestination(resources.digest, f)]),
        );
        const path = outputPath(description.product, entry, catalog),
          blocks: string[] = [];
        for (const owner of owners)
          blocks.push(
            resourceMarkdown(
              renderRecord(closure.selected.get(owner.identity)!, owner),
              { key: owner },
              path,
              destinations,
              true,
            ),
          );
        for (const file of selectedFiles)
          if (file.mediaType === 'text/markdown')
            resourceMarkdown(file.content, file, destinations.get(keyOf(file.key))!, destinations, false);
        const inlined = new Set<string>(),
          discovered = new Set<string>();
        for (const resource of resolution.items) {
          const destination = destinations.get(keyOf(resource.file.key))!;
          if (resource.use.delivery === 'inline' && !inlined.has(keyOf(resource.file.key))) {
            if (!['text/markdown', 'text/plain', 'application/json'].includes(resource.file.mediaType))
              fail(
                'IA-PROJECTION-FEATURE-UNAVAILABLE',
                'This inert profile cannot inline image content',
                resource.owner,
              );
            const content =
              resource.file.mediaType === 'text/markdown'
                ? resourceMarkdown(resource.file.content, resource.file, path, destinations, true)
                : resource.file.content;
            inert(content);
            blocks.push(`## ${resource.use.role}\n\nSource: ${resource.citation}\n\n${content}`);
            inlined.add(keyOf(resource.file.key));
          }
          if (!discovered.has(keyOf(resource.file.key)))
            blocks.push(`Resource (${resource.use.role}): ${discoveryLink(path, destination, resource.file.key.path)}`);
          discovered.add(keyOf(resource.file.key));
        }
        const body =
          `\n# ${entry.outputName}\n\n${entry.description}\n\n` +
          'Native declarations below are guidance. Conditional clauses apply only under their stated conditions; this projection activates no IA operation or machine enforcement.\n' +
          invocation(entry, catalog, description.product) +
          '\n' +
          blocks.join('\n\n') +
          '\n';
        inert(body);
        const serialized = serializeExport(description.product, entry, catalog, body);
        // Do all export-level validation before admitting its files to the product.
        for (const file of serialized) {
          if (Buffer.byteLength(file.content) > PROJECTION_LIMITS.fileBytes)
            inputFailure('Generated file exceeds its byte ceiling');
          portablePath(file.path);
        }
        for (const destination of destinations.values()) portablePath(destination);
        for (const file of selectedFiles)
          add(
            destinations.get(keyOf(file.key))!,
            Buffer.from(file.content, file.encoding),
            file.encoding,
            'resource',
            owners,
            [file.key],
          );
        for (const file of serialized)
          add(
            file.path,
            Buffer.from(file.content),
            'utf8',
            file.role,
            owners,
            selectedFiles.map((f) => f.key),
          );
        exported.push({ id: entry.id, target: entry.target, closure: owners });
        for (const omission of resolution.omissions)
          omissions.push({
            export: entry.id,
            feature: 'resources',
            reason: `${keyOf(omission.key)}: ${omission.reason}`,
          });
      } catch (error) {
        const result = diagnostic(error);
        if (entry.required || result.code === 'IA-PROJECTION-INPUT-INVALID') throw error;
        omissions.push({ export: entry.id, feature: entry.profile, reason: `${result.code}: ${result.message}` });
      }
    }
    if (description.product === 'plugin') {
      const file = pluginFile(catalog, options.name, options.version);
      add(
        file.path,
        Buffer.from(file.content),
        'utf8',
        file.role,
        exported.map((e) => e.target),
        [],
      );
    }
    if (description.product === 'workspace' && isCodex(catalog)) {
      const registered = description.exports.filter(
        (entry) => entry.presentation.kind === 'agent' && exported.some((e) => e.id === entry.id),
      );
      const file = codexAgentRegistration(registered);
      if (file)
        add(
          file.path,
          Buffer.from(file.content),
          'utf8',
          file.role,
          registered.map((e) => e.target),
          [],
        );
    }
    if (new Set(exported.flatMap((e) => e.closure.map(occurrenceOf))).size > PROJECTION_LIMITS.occurrences)
      inputFailure('Generated product exceeds its native occurrence ceiling');
    if (
      files.size > PROJECTION_LIMITS.files ||
      [...files.values()].reduce((sum, file) => sum + file.bytes, 0) > PROJECTION_LIMITS.totalBytes
    )
      inputFailure('Generated product exceeds its file/byte ceiling');
    const manifestBody = {
      format: 'ia.projection-manifest.v1' as const,
      product: description.product,
      sourceRevisions: description.sourceRevisions,
      descriptorDigest: description.digest,
      resourcesDigest: resources.digest,
      inventoryDigest: description.inventoryDigest,
      profiles: description.profiles,
      exports: exported,
      outputs: ordered([...outputs.values()], (o) => o.path),
      omissions,
      enforcement: [
        {
          feature: 'prose-projection',
          level: 'guidance' as const,
          evidence: `generated:${catalog.profile.id}; installed/live-host qualification not established`,
        },
        ...(isCodex(catalog)
          ? [
              {
                feature: 'agent-presentation',
                level: 'guidance' as const,
                evidence:
                  description.product === 'plugin'
                    ? 'explicit role skills; no native custom-agent registration or model/tool override'
                    : 'native workspace TOML agents; tool intent is guidance, not an enforced allowlist',
              },
            ]
          : []),
      ],
    };
    if (Buffer.byteLength(JSON.stringify(manifestBody)) > PROJECTION_LIMITS.metadataBytes)
      inputFailure('Projection manifest exceeds its metadata ceiling');
    return frozen({
      format: 'ia.projection-result.v1',
      status: 'compiled',
      manifest: { ...manifestBody, digest: metadataDigest(manifestBody) },
      files: ordered([...files.values()], (f) => f.path),
      diagnostics: [],
    });
  } catch (error) {
    return frozen({ format: 'ia.projection-result.v1', status: 'refused', diagnostics: [diagnostic(error)] });
  }
}

/** Recompile the exact captured inputs; never trust caller-authored generated files. */
export function serializeProjection(
  capture: Capture,
  descriptor: unknown,
  resources: unknown,
  options: ProjectionOptions,
): ProjectionResult {
  return compileProjection(capture, descriptor, resources, options);
}
