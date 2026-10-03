import { isPhase, isPrimitive } from '@inventarch/language';
import {
  decodeJson,
  hash,
  integer,
  list,
  metadataDigest,
  object,
  occurrence,
  resourceKey,
  text,
} from './resource-format.js';
import type {
  ArtifactInput,
  AuthoringCriterion,
  AuthoringIndexInput,
  AuthoringTargetRequest,
  CapturedAuthoringIndex,
  CapturedArtifact,
  CapturedDocument,
  DocumentInput,
  DocumentProfile,
  LifecycleCoordinate,
  LifecycleModel,
  SystemReferenceInput,
} from './authoring-types.js';

export const AUTHORING_LIMITS = Object.freeze({
  artifacts: 2000,
  systems: 2000,
  documents: 256,
  profiles: 256,
  models: 256,
  members: 200,
  metadataBytes: 2 * 1024 * 1024,
});
export class AuthoringError extends Error {
  readonly code: 'IA-AUTHORING-INVALID' | 'IA-AUTHORING-SCOPE' | 'IA-AUTHORING-STALE';
  constructor(message: string, code: AuthoringError['code'] = 'IA-AUTHORING-INVALID') {
    super(message);
    this.name = 'AuthoringError';
    this.code = code;
  }
}
export function invalidAuthoring(message: string): never {
  throw new AuthoringError(message);
}
export function authoringId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(result)) invalidAuthoring('Invalid authoring identifier');
  return result;
}
const words = (value: unknown, max = AUTHORING_LIMITS.members) => unique(list(value, max).map(authoringId), (v) => v);
export function unique<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const keys = rows.map(key);
  if (new Set(keys).size !== keys.length) invalidAuthoring('Duplicate authoring identity');
  return [...rows];
}
const keys = (v: unknown) =>
  unique(list(v, AUTHORING_LIMITS.members).map(resourceKey), (k) => `${k.source}@${k.revision}:${k.path}`);
const occurrences = (v: unknown) =>
  unique(
    list(v, AUTHORING_LIMITS.members).map(occurrence),
    (k) => `${k.source}@${k.revision}:${k.path}:${k.line}:${k.identity}`,
  );
const optionalKey = (v: unknown) => (v === null ? null : resourceKey(v));
const optionalOccurrence = (v: unknown) => (v === null ? null : occurrence(v));
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalidAuthoring('Invalid authoring enumeration');
  return value as T;
}
function criterion(v: unknown): AuthoringCriterion {
  const row = object(v, ['id', 'version', 'basis', 'text']);
  return {
    id: authoringId(row['id']),
    version: authoringId(row['version']),
    basis: enumeration(row['basis'], ['structural', 'semantic']),
    text: text(row['text'], 8192),
  };
}
function criteria(v: unknown): AuthoringCriterion[] {
  return unique(list(v, AUTHORING_LIMITS.members).map(criterion), (r) => r.id);
}
function coordinate(v: unknown): LifecycleCoordinate {
  const row = object(v, [
    'model',
    'version',
    'workflow',
    'iteration',
    'stage',
    'role',
    'maturity',
    'phase',
    'primitive',
  ]);
  const phase = row['phase'],
    primitive = row['primitive'];
  if (
    (phase !== null && (typeof phase !== 'string' || !isPhase(phase))) ||
    (primitive !== null && (typeof primitive !== 'string' || !isPrimitive(primitive)))
  )
    invalidAuthoring('Invalid method coordinate');
  return {
    model: authoringId(row['model']),
    version: authoringId(row['version']),
    workflow: authoringId(row['workflow']),
    iteration: integer(row['iteration'], 1_000_000),
    stage: authoringId(row['stage']),
    role: enumeration(row['role'], ['created', 'refined', 'consumed', 'evaluated']),
    maturity: authoringId(row['maturity']),
    phase: phase as LifecycleCoordinate['phase'],
    primitive: primitive as LifecycleCoordinate['primitive'],
  };
}
export function authoringRequest(value: unknown): AuthoringTargetRequest {
  const row = object(value, ['target', 'document', 'lifecycle']),
    candidate = row['target'];
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    invalidAuthoring('Invalid authoring target');
  const kind = Object.getOwnPropertyDescriptor(candidate, 'kind')?.value as unknown;
  let target: AuthoringTargetRequest['target'];
  if (kind === undefined) target = occurrence(candidate);
  else if (kind === 'word') {
    const input = object(candidate, ['kind', 'word']);
    target = { kind, word: authoringId(input['word']) };
  } else if (kind === 'system') {
    const input = object(candidate, ['kind', 'name']);
    target = { kind, name: authoringId(input['name']) };
  } else if (kind === 'artifact' || kind === 'document') {
    const input = object(candidate, ['kind', 'id']);
    target = { kind, id: authoringId(input['id']) };
  } else invalidAuthoring('Invalid authoring target kind');
  let lifecycle: AuthoringTargetRequest['lifecycle'] = null;
  if (row['lifecycle'] !== null) {
    const input = object(row['lifecycle'], [
      'model',
      'version',
      'workflow',
      'iteration',
      'stage',
      'phase',
      'primitive',
    ]);
    const {
      role: _role,
      maturity: _maturity,
      ...selected
    } = coordinate({ ...input, role: 'consumed', maturity: 'selected' });
    lifecycle = selected;
  }
  return { target, document: row['document'] === null ? null : authoringId(row['document']), lifecycle };
}
function system(v: unknown): SystemReferenceInput {
  const row = object(v, ['system', 'authoring', 'architecture', 'extensions', 'methods', 'steward', 'base']);
  return {
    system: occurrence(row['system']),
    authoring: keys(row['authoring']),
    architecture: keys(row['architecture']),
    extensions: keys(row['extensions']),
    methods: occurrences(row['methods']),
    steward: optionalOccurrence(row['steward']),
    base: optionalOccurrence(row['base']),
  };
}
function artifact(v: unknown, retained: boolean): ArtifactInput | CapturedArtifact {
  const row = object(v, [
    'id',
    'source',
    'purpose',
    'contract',
    'dependencies',
    'lifecycle',
    ...(retained ? ['revision'] : []),
  ]);
  const source = row['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source))
    invalidAuthoring('Invalid artifact source');
  const kind = Reflect.getOwnPropertyDescriptor(source, 'kind')?.value as unknown;
  let parsed: ArtifactInput['source'];
  if (kind === 'native') {
    const s = object(source, ['kind', 'occurrence']);
    parsed = { kind, occurrence: occurrence(s['occurrence']) };
  } else if (kind === 'resource') {
    const s = object(source, ['kind', 'key', 'range']);
    const range = s['range'] === null ? null : object(s['range'], ['start', 'end']);
    const start = range ? integer(range['start'], 10_000_000, 1) : 0,
      end = range ? integer(range['end'], 10_000_000, start) : 0;
    parsed = { kind, key: resourceKey(s['key']), range: range ? { start, end } : null };
  } else invalidAuthoring('Unsupported artifact source');
  const result: ArtifactInput = {
    id: authoringId(row['id']),
    source: parsed,
    purpose: text(row['purpose'], 8192),
    contract: optionalKey(row['contract']),
    dependencies: words(row['dependencies']),
    lifecycle: list(row['lifecycle'], AUTHORING_LIMITS.members).map(coordinate),
  };
  return retained ? { ...result, revision: hash(row['revision']) } : result;
}
function profile(v: unknown): DocumentProfile {
  const row = object(v, ['id', 'version', 'roles', 'criteria']);
  const roles = list(row['roles'], AUTHORING_LIMITS.members).map((v) => {
    const r = object(v, ['id', 'min', 'max', 'context', 'contract']);
    const min = integer(r['min'], AUTHORING_LIMITS.members);
    return {
      id: authoringId(r['id']),
      min,
      max: integer(r['max'], AUTHORING_LIMITS.members, min),
      context: enumeration(r['context'], ['required-input', 'expected-output', 'optional'] as const),
      contract: optionalKey(r['contract']),
    };
  });
  return {
    id: authoringId(row['id']),
    version: authoringId(row['version']),
    roles: unique(roles, (r) => r.id),
    criteria: criteria(row['criteria']),
  };
}
function document(v: unknown, retained: boolean): DocumentInput | CapturedDocument {
  const row = object(v, ['id', 'version', 'profile', 'members', 'gaps']),
    p = object(row['profile'], ['id', 'version']);
  const members = list(row['members'], AUTHORING_LIMITS.members).map((v) => {
    const m = object(v, ['artifact', 'role', 'order', ...(retained ? ['revision'] : [])]);
    const base = {
      artifact: authoringId(m['artifact']),
      role: authoringId(m['role']),
      order: integer(m['order'], AUTHORING_LIMITS.members),
    };
    return retained ? { ...base, revision: hash(m['revision']) } : base;
  });
  unique(members, (m) => JSON.stringify([m.artifact, m.role]));
  unique(members, (m) => String(m.order));
  const gaps = list(row['gaps'], AUTHORING_LIMITS.members).map((v) => {
    const g = object(v, ['role', 'reason']);
    return { role: authoringId(g['role']), reason: text(g['reason'], 8192) };
  });
  const result = {
    id: authoringId(row['id']),
    version: authoringId(row['version']),
    profile: { id: authoringId(p['id']), version: authoringId(p['version']) },
    members,
    gaps: unique(gaps, (g) => g.role),
  };
  return result as DocumentInput | CapturedDocument;
}
function lifecycle(v: unknown): LifecycleModel {
  const row = object(v, ['id', 'version', 'stages', 'transitions']);
  const transitions = list(row['transitions'], AUTHORING_LIMITS.members).map((v) => {
    const t = object(v, ['id', 'from', 'to', 'inputs', 'outputs', 'feedback', 'criteria']);
    if (typeof t['feedback'] !== 'boolean') invalidAuthoring('Invalid lifecycle feedback');
    return {
      id: authoringId(t['id']),
      from: authoringId(t['from']),
      to: authoringId(t['to']),
      inputs: words(t['inputs']),
      outputs: words(t['outputs']),
      feedback: t['feedback'],
      criteria: criteria(t['criteria']),
    };
  });
  return {
    id: authoringId(row['id']),
    version: authoringId(row['version']),
    stages: words(row['stages']),
    transitions: unique(transitions, (t) => t.id),
  };
}
export function decodeAuthoring(value: unknown, retained: false): AuthoringIndexInput;
export function decodeAuthoring(value: unknown, retained: true): CapturedAuthoringIndex;
export function decodeAuthoring(value: unknown, retained: boolean): AuthoringIndexInput | CapturedAuthoringIndex {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > AUTHORING_LIMITS.metadataBytes)
        invalidAuthoring('Authoring metadata exceeds its ceiling');
      value = decodeJson(value);
    }
    const row = object(value, [
      'systems',
      'artifacts',
      'profiles',
      'documents',
      'lifecycles',
      ...(retained ? ['format', 'nativeCaptureRevision', 'resourceDigest', 'digest'] : []),
    ]);
    const body = {
      systems: list(row['systems'], AUTHORING_LIMITS.systems).map(system),
      artifacts: unique(
        list(row['artifacts'], AUTHORING_LIMITS.artifacts).map((v) => artifact(v, retained)),
        (r) => r.id,
      ),
      profiles: unique(list(row['profiles'], AUTHORING_LIMITS.profiles).map(profile), (p) => `${p.id}@${p.version}`),
      documents: unique(
        list(row['documents'], AUTHORING_LIMITS.documents).map((v) => document(v, retained)),
        (d) => d.id,
      ),
      lifecycles: unique(
        list(row['lifecycles'], AUTHORING_LIMITS.models).map(lifecycle),
        (m) => `${m.id}@${m.version}`,
      ),
    };
    const result = retained
      ? {
          ...body,
          format: row['format'],
          nativeCaptureRevision: hash(row['nativeCaptureRevision']),
          resourceDigest: hash(row['resourceDigest']),
          digest: hash(row['digest']),
        }
      : body;
    if (
      (retained && row['format'] !== 'ia.authoring-index.v1') ||
      Buffer.byteLength(JSON.stringify(result)) > AUTHORING_LIMITS.metadataBytes
    )
      invalidAuthoring('Invalid authoring format or metadata ceiling');
    return result as AuthoringIndexInput | CapturedAuthoringIndex;
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    throw new AuthoringError('Invalid closed authoring index');
  }
}
export function indexBody(index: CapturedAuthoringIndex): Omit<CapturedAuthoringIndex, 'digest'> {
  const { digest: _digest, ...body } = index;
  return body;
}
export const authoringDigest = metadataDigest;
