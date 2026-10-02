import type { ResourceKey, ResourceOccurrence, ResourceUse, SourceRevision } from './resource-format.js';
import {
  association,
  decodeJson,
  frozen,
  hash,
  integer,
  list,
  metadataDigest,
  object,
  occurrence,
  ordered,
  sourceRevision,
  text,
} from './resource-format.js';
export const PROJECTION_LIMITS = Object.freeze({
  exports: 128,
  profiles: 16,
  occurrences: 2000,
  depth: 64,
  files: 256,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
});
export type ProjectionCode =
  | 'IA-PROJECTION-INPUT-INVALID'
  | 'IA-PROJECTION-SOURCE-UNAVAILABLE'
  | 'IA-PROJECTION-FEATURE-UNAVAILABLE'
  | 'IA-RESOURCE-INVALID';
export interface ProjectionDiagnostic {
  readonly code: ProjectionCode;
  readonly message: string;
  readonly occurrence?: ResourceOccurrence;
}
export class ProjectionError extends Error {
  constructor(readonly diagnostic: ProjectionDiagnostic) {
    super(diagnostic.message);
    this.name = 'ProjectionError';
  }
}
export function fail(code: ProjectionCode, message: string, owner?: ResourceOccurrence): never {
  throw new ProjectionError({ code, message, ...(owner ? { occurrence: owner } : {}) });
}
export function inputFailure(message: string): never {
  return fail('IA-PROJECTION-INPUT-INVALID', message);
}
export interface ProfilePin {
  readonly id: string;
  readonly version: number;
  readonly implementationDigest: string;
}
export interface ProjectionArgument {
  readonly name: string;
  readonly type: 'text' | 'boolean' | 'integer';
  readonly required: boolean;
  readonly target: string;
}
export interface ProjectionPattern {
  readonly kind: 'path-glob' | 'command-prefix' | 'import-prefix' | 'prompt-literal';
  readonly value: string;
  readonly priority: number;
}
export type Presentation =
  | {
      readonly kind: 'agent';
      readonly agent: ResourceOccurrence;
      readonly agentProfile?: ResourceOccurrence;
      readonly voice?: ResourceOccurrence;
      readonly mandate?: ResourceOccurrence;
      readonly model: string;
      readonly tools: readonly string[];
      readonly delegates: readonly string[];
    }
  | {
      readonly kind: 'skill';
      readonly invocation: 'automatic-or-explicit';
      readonly arguments: readonly ProjectionArgument[];
      readonly patterns: readonly ProjectionPattern[];
      readonly body: readonly ResourceOccurrence[];
    }
  | {
      readonly kind: 'command';
      readonly invocation: 'explicit';
      readonly arguments: readonly ProjectionArgument[];
      readonly body: readonly ResourceOccurrence[];
    };
export interface ProjectionExport {
  readonly id: string;
  readonly target: ResourceOccurrence;
  readonly binding?: ResourceOccurrence;
  readonly profile: string;
  readonly outputName: string;
  readonly required: boolean;
  readonly description: string;
  readonly resources: readonly ResourceUse[];
  readonly requirements: readonly {
    readonly feature: string;
    readonly minimumEvidence: 'generated' | 'process' | 'live-host';
  }[];
  readonly presentation: Presentation;
}
export interface ProjectionDescriptor {
  readonly format: 'ia.projection-descriptor.v1';
  readonly sourceRevisions: readonly SourceRevision[];
  readonly product: 'workspace' | 'plugin';
  readonly profiles: readonly ProfilePin[];
  readonly exports: readonly ProjectionExport[];
  readonly resourcesDigest: string;
  readonly inventoryDigest: string;
  readonly digest: string;
}
export interface ProjectionFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}
export interface ProjectionOutput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly role: 'agent' | 'skill' | 'command' | 'resource' | 'plugin' | 'host-metadata';
  readonly sources: readonly ResourceOccurrence[];
  readonly resources: readonly ResourceKey[];
}
export interface ProjectionOmission {
  readonly export: string;
  readonly feature: string;
  readonly reason: string;
}
export interface ProjectionManifest {
  readonly format: 'ia.projection-manifest.v1';
  readonly product: 'workspace' | 'plugin';
  readonly sourceRevisions: readonly SourceRevision[];
  readonly descriptorDigest: string;
  readonly resourcesDigest: string;
  readonly inventoryDigest: string;
  readonly profiles: readonly ProfilePin[];
  readonly exports: readonly {
    readonly id: string;
    readonly target: ResourceOccurrence;
    readonly closure: readonly ResourceOccurrence[];
  }[];
  readonly outputs: readonly ProjectionOutput[];
  readonly omissions: readonly ProjectionOmission[];
  readonly enforcement: readonly { readonly feature: string; readonly level: 'guidance'; readonly evidence: string }[];
  readonly digest: string;
}
export type ProjectionResult =
  | {
      readonly format: 'ia.projection-result.v1';
      readonly status: 'refused';
      readonly diagnostics: readonly ProjectionDiagnostic[];
    }
  | {
      readonly format: 'ia.projection-result.v1';
      readonly status: 'compiled';
      readonly manifest: ProjectionManifest;
      readonly files: readonly ProjectionFile[];
      readonly diagnostics: readonly ProjectionDiagnostic[];
    };

export function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const present =
    value !== null && typeof value === 'object' ? optional.filter((key) => Object.hasOwn(value, key)) : [];
  return object(value, [...required, ...present]);
}
export function id(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(result)) inputFailure('Invalid projection identifier');
  return result;
}
export function catalogId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(result)) inputFailure('Invalid installed catalog key');
  return result;
}
export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') inputFailure('Expected a literal projection boolean');
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) inputFailure('Unknown projection variant');
  return value as T;
}
export function unique<T>(rows: readonly T[], key: (row: T) => string): T[] {
  if (new Set(rows.map(key)).size !== rows.length) inputFailure('Duplicate projection entry');
  return [...rows];
}
function pin(value: unknown): ProfilePin {
  const row = object(value, ['id', 'version', 'implementationDigest']);
  return {
    id: catalogId(row['id']),
    version: integer(row['version'], 1_000_000, 1),
    implementationDigest: hash(row['implementationDigest']),
  };
}
function argument(value: unknown): ProjectionArgument {
  const row = object(value, ['name', 'type', 'required', 'target']),
    target = id(row['target']);
  if (
    [
      'root',
      'actor',
      'grant',
      'implementation',
      'scope',
      'within',
      'permissions',
      'credentials',
      'tenant',
      'subject',
    ].includes(target)
  )
    inputFailure('Argument cannot target host authority');
  return {
    name: id(row['name']),
    type: oneOf(row['type'], ['text', 'boolean', 'integer']),
    required: bool(row['required']),
    target,
  };
}
function presentation(value: unknown): Presentation {
  const kind =
    value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined;
  if (kind === 'agent') {
    const row = closed(value, ['kind', 'agent', 'model', 'tools', 'delegates'], ['agentProfile', 'voice', 'mandate']);
    const extra = Object.fromEntries(
      ['agentProfile', 'voice', 'mandate']
        .filter((key) => Object.hasOwn(row, key))
        .map((key) => [key, occurrence(row[key])]),
    );
    return {
      kind,
      agent: occurrence(row['agent']),
      ...extra,
      model: catalogId(row['model']),
      tools: unique(list(row['tools'], 64).map(catalogId), (v) => v),
      delegates: unique(list(row['delegates'], 64).map(catalogId), (v) => v),
    };
  }
  if (kind !== 'skill' && kind !== 'command') inputFailure('Unsupported presentation kind');
  const row = object(value, ['kind', 'invocation', 'arguments', 'body', ...(kind === 'skill' ? ['patterns'] : [])]);
  const args = unique(list(row['arguments'], 32).map(argument), (a) => a.name);
  unique(args, (a) => a.target);
  const body = unique(list(row['body'], 64).map(occurrence), (o) => JSON.stringify(o));
  if (kind === 'command') return { kind, invocation: oneOf(row['invocation'], ['explicit']), arguments: args, body };
  const patterns = list(row['patterns'], 32).map((value): ProjectionPattern => {
    const p = object(value, ['kind', 'value', 'priority']);
    return {
      kind: oneOf(p['kind'], ['path-glob', 'command-prefix', 'import-prefix', 'prompt-literal']),
      value: text(p['value'], 256),
      priority: integer(p['priority'], 100, -100),
    };
  });
  unique(patterns, (p) => `${p.kind}:${p.value}`);
  return { kind, invocation: oneOf(row['invocation'], ['automatic-or-explicit']), arguments: args, body, patterns };
}
/** Strict sidecar validation; no native admission or host installation occurs here. */
export function verifyProjectionDescriptor(value: unknown): ProjectionDescriptor {
  try {
    if (typeof value === 'string' && Buffer.byteLength(value) > PROJECTION_LIMITS.metadataBytes)
      inputFailure('Projection descriptor exceeds its ceiling');
    const row = object(typeof value === 'string' ? decodeJson(value) : value, [
      'format',
      'sourceRevisions',
      'product',
      'profiles',
      'exports',
      'resourcesDigest',
      'inventoryDigest',
      'digest',
    ]);
    if (row['format'] !== 'ia.projection-descriptor.v1') inputFailure('Unsupported projection descriptor format');
    const sourceRevisions = ordered(
      unique(list(row['sourceRevisions'], 2001).map(sourceRevision), (s) => s.source),
      (s) => s.source,
    );
    const profiles = ordered(
      unique(list(row['profiles'], PROJECTION_LIMITS.profiles).map(pin), (p) => p.id),
      (p) => p.id,
    );
    const exports = ordered(
      unique(
        list(row['exports'], PROJECTION_LIMITS.exports).map((value): ProjectionExport => {
          const e = closed(
            value,
            [
              'id',
              'target',
              'profile',
              'outputName',
              'required',
              'description',
              'resources',
              'requirements',
              'presentation',
            ],
            ['binding'],
          );
          const target = occurrence(e['target']),
            resources = association({ owner: target, resources: e['resources'] }).resources;
          const requirements = ordered(
            unique(
              list(e['requirements'], 64).map((v) => {
                const r = object(v, ['feature', 'minimumEvidence']);
                return {
                  feature: id(r['feature']),
                  minimumEvidence: oneOf(r['minimumEvidence'], ['generated', 'process', 'live-host']),
                };
              }),
              (r) => r.feature,
            ),
            (r) => r.feature,
          );
          return {
            id: id(e['id']),
            target,
            ...(Object.hasOwn(e, 'binding') ? { binding: occurrence(e['binding']) } : {}),
            profile: catalogId(e['profile']),
            outputName: id(e['outputName']),
            required: bool(e['required']),
            description: text(e['description'], 1024),
            resources,
            requirements,
            presentation: presentation(e['presentation']),
          };
        }),
        (e) => e.id,
      ),
      (e) => e.id,
    );
    if (!exports.length || exports.some((e) => !profiles.some((p) => p.id === e.profile)))
      inputFailure('Exports require selected profile pins');
    const body = {
      format: 'ia.projection-descriptor.v1' as const,
      sourceRevisions,
      product: oneOf(row['product'], ['workspace', 'plugin']),
      profiles,
      exports,
      resourcesDigest: hash(row['resourcesDigest']),
      inventoryDigest: hash(row['inventoryDigest']),
    };
    const digest = hash(row['digest']);
    const { digest: _inputDigest, ...inputBody } = row;
    if (
      Buffer.byteLength(JSON.stringify(body)) > PROJECTION_LIMITS.metadataBytes ||
      metadataDigest(body) !== digest ||
      metadataDigest(inputBody) !== digest
    )
      inputFailure('Projection descriptor digest, order or size differs');
    return frozen({ ...body, digest });
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    inputFailure('Malformed projection descriptor');
  }
}
