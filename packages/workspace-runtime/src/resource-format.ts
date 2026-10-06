import { createHash } from 'node:crypto';
import type { ReadHandle } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import { isKind } from '@inventarch/language';

export const RESOURCE_LIMITS = Object.freeze({
  files: 256,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
  serializedBytes: 26 * 1024 * 1024,
  owners: 2000,
  uses: 64,
  pathBytes: 1024,
});
export interface SourceRevision {
  readonly source: string;
  readonly revision: string;
}
export interface ResourceKey extends SourceRevision {
  readonly path: string;
}
export interface ResourceOccurrence extends ResourceKey {
  readonly identity: string;
  readonly line: number;
}
export type ResourceRole = 'body' | 'guide' | 'example' | 'template' | 'image' | 'support';
export interface ResourceUse {
  readonly key: ResourceKey;
  readonly role: ResourceRole;
  readonly order: number;
  readonly required: boolean;
  readonly delivery: 'inline' | 'installed-reference';
}
export interface ResourceAssociation {
  readonly owner: ResourceOccurrence;
  readonly resources: readonly ResourceUse[];
}
export type ResourceMediaType =
  | 'text/markdown'
  | 'text/plain'
  | 'application/json'
  | 'image/png'
  | 'image/jpeg'
  | 'image/svg+xml';
export interface ResourceFile {
  readonly key: ResourceKey;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: ResourceMediaType;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}
export interface ResourceResolveOptions {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly owners: readonly ResourceOccurrence[];
  readonly allowedResources: readonly ResourceKey[];
  readonly expectedDigest: string;
  readonly maxBytes: number;
}
export interface ResolvedResource {
  readonly owner: ResourceOccurrence;
  readonly use: ResourceUse;
  readonly file: ResourceFile;
  readonly citation: string;
  readonly reference: string;
}
export interface ResourceResolution {
  readonly digest: string;
  readonly nativeCaptureRevision: string;
  readonly viewRevision: string;
  readonly items: readonly ResolvedResource[];
  readonly omissions: readonly {
    owner: ResourceOccurrence;
    key: ResourceKey;
    reason: 'missing' | 'excluded' | 'budget';
  }[];
  readonly bytes: number;
}
export type ResourceFilePin = Omit<ResourceFile, 'content'>;
export interface CapturedResources {
  readonly format: 'ia.captured-resources.v1';
  readonly sourceRevisions: readonly SourceRevision[];
  readonly nativeCaptureRevision: string;
  readonly files: readonly ResourceFile[];
  readonly associations: readonly ResourceAssociation[];
  readonly digest: string;
}
export class ResourceError extends Error {
  readonly code = 'IA-RESOURCE-INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ResourceError';
  }
}
export function invalid(message: string): never {
  throw new ResourceError(message);
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const metadataDigest = (value: unknown): string => sha256(stableSerialize(value));
export const keyOf = (value: ResourceKey): string => `${value.source}@${value.revision}:${value.path}`;
export const occurrenceOf = (value: ResourceOccurrence): string => `${keyOf(value)}:${value.line}:${value.identity}`;
export const useOf = (value: ResourceUse): string =>
  `${value.role}:${String(value.order).padStart(10, '0')}:${keyOf(value.key)}`;
export const ordered = <T>(rows: readonly T[], key: (row: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
export function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid('Expected a plain resource object');
  const fields = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    fields.length !== keys.length ||
    fields.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    invalid('Unknown, missing or non-data resource field');
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum: number = RESOURCE_LIMITS.pathBytes): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value)
    invalid('Invalid or oversized resource text');
  return value;
}
export function hash(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid('Invalid resource revision or hash');
  return result;
}
export function integer(value: unknown, maximum: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    invalid('Invalid resource integer or limit');
  return value;
}
export function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid('Invalid resource collection or limit');
  return value;
}
export function portablePath(value: unknown): string {
  const path = text(value);
  if (
    path !== path.normalize('NFC') ||
    /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
    path
      .split('/')
      .some(
        (p) =>
          !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      )
  )
    invalid('Unsafe or aliased resource path');
  return path;
}
export function sourceRevision(value: unknown): SourceRevision {
  const row = object(value, ['source', 'revision']),
    source = text(row['source'], 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(source)) invalid('Invalid resource source identity');
  return { source, revision: hash(row['revision']) };
}
export function resourceKey(value: unknown): ResourceKey {
  const row = object(value, ['source', 'revision', 'path']);
  return { ...sourceRevision({ source: row['source'], revision: row['revision'] }), path: portablePath(row['path']) };
}
export function occurrence(value: unknown): ResourceOccurrence {
  const row = object(value, ['source', 'revision', 'path', 'identity', 'line']),
    identity = text(row['identity']);
  if (
    !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(identity) ||
    !isKind(identity.split('/')[1]!)
  )
    invalid('Invalid native resource owner identity');
  return {
    ...resourceKey({ source: row['source'], revision: row['revision'], path: row['path'] }),
    identity,
    line: integer(row['line'], Number.MAX_SAFE_INTEGER, 1),
  };
}
export function association(value: unknown): ResourceAssociation {
  const row = object(value, ['owner', 'resources']),
    orders = new Set<string>(),
    keys = new Set<string>();
  const resources = list(row['resources'], RESOURCE_LIMITS.uses).map((input): ResourceUse => {
    const use = object(input, ['key', 'role', 'order', 'required', 'delivery']),
      key = resourceKey(use['key']),
      role = use['role'];
    if (
      typeof role !== 'string' ||
      !['body', 'guide', 'example', 'template', 'image', 'support'].includes(role) ||
      typeof use['required'] !== 'boolean' ||
      typeof use['delivery'] !== 'string' ||
      !['inline', 'installed-reference'].includes(use['delivery'])
    )
      invalid('Invalid resource association role or delivery');
    const order = integer(use['order'], 1_000_000),
      orderKey = `${String(role)}:${order}`,
      roleKey = `${String(role)}:${keyOf(key)}`;
    if (orders.has(orderKey) || keys.has(roleKey)) invalid('Duplicate resource role/order or role/key');
    orders.add(orderKey);
    keys.add(roleKey);
    return {
      key,
      role: role as ResourceRole,
      order,
      required: use['required'],
      delivery: use['delivery'] as ResourceUse['delivery'],
    };
  });
  return { owner: occurrence(row['owner']), resources: ordered(resources, useOf) };
}
export function filePin(value: unknown): ResourceFilePin {
  const row = object(value, ['key', 'bytes', 'sha256', 'mediaType', 'encoding']),
    mediaType = row['mediaType'],
    encoding = row['encoding'];
  if (
    typeof mediaType !== 'string' ||
    !['text/markdown', 'text/plain', 'application/json', 'image/png', 'image/jpeg', 'image/svg+xml'].includes(
      mediaType,
    ) ||
    encoding !== (mediaType === 'image/png' || mediaType === 'image/jpeg' ? 'base64' : 'utf8')
  )
    invalid('Unsupported resource media type or encoding');
  return {
    key: resourceKey(row['key']),
    bytes: integer(row['bytes'], RESOURCE_LIMITS.fileBytes),
    sha256: hash(row['sha256']),
    mediaType: mediaType as ResourceMediaType,
    encoding: encoding as ResourceFile['encoding'],
  };
}
export function file(value: unknown): ResourceFile {
  const row = object(value, ['key', 'bytes', 'sha256', 'mediaType', 'encoding', 'content']);
  const pin = filePin({
    key: row['key'],
    bytes: row['bytes'],
    sha256: row['sha256'],
    mediaType: row['mediaType'],
    encoding: row['encoding'],
  });
  const content = text(
    row['content'],
    pin.encoding === 'utf8' ? RESOURCE_LIMITS.fileBytes : 4 * Math.ceil(RESOURCE_LIMITS.fileBytes / 3),
  );
  const bytes = Buffer.from(content, pin.encoding);
  if (
    (pin.encoding === 'base64' && bytes.toString('base64') !== content) ||
    bytes.length !== pin.bytes ||
    sha256(bytes) !== pin.sha256
  )
    invalid('Resource bytes do not match the declared size/hash/encoding');
  return { ...pin, content };
}

/** Bounded JSON decoding with decoded-key duplicate rejection; no IA parsing. */
export function decodeJson(input: string): unknown {
  if (Buffer.byteLength(input) > RESOURCE_LIMITS.serializedBytes)
    invalid('Serialized resource envelope exceeds its ceiling');
  let at = 0;
  const white = (): void => {
    while (/[\t\r\n ]/.test(input[at] ?? 'x')) at++;
  };
  const string = (): string => {
    const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    token.lastIndex = at;
    const match = token.exec(input);
    if (!match) invalid('Malformed resource JSON string');
    at = token.lastIndex;
    return JSON.parse(match[0]) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 16) invalid('Resource JSON nesting exceeds its ceiling');
    white();
    if (input[at] === '"') return string();
    if (input[at] === '{') {
      at++;
      white();
      const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (input[at] === '}') {
        at++;
        return row;
      }
      for (;;) {
        white();
        const key = string();
        if (Object.hasOwn(row, key)) invalid('Duplicate resource JSON key');
        white();
        if (input[at++] !== ':') invalid('Malformed resource JSON object');
        row[key] = value(depth + 1);
        white();
        const next = input[at++];
        if (next === '}') return row;
        if (next !== ',') invalid('Malformed resource JSON object');
      }
    }
    if (input[at] === '[') {
      at++;
      white();
      const rows: unknown[] = [];
      if (input[at] === ']') {
        at++;
        return rows;
      }
      for (;;) {
        rows.push(value(depth + 1));
        white();
        const next = input[at++];
        if (next === ']') return rows;
        if (next !== ',') invalid('Malformed resource JSON array');
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    token.lastIndex = at;
    const match = token.exec(input);
    if (!match) invalid('Malformed resource JSON value');
    at = token.lastIndex;
    return JSON.parse(match[0]) as unknown;
  };
  const result = value(0);
  white();
  if (at !== input.length) invalid('Trailing resource JSON data');
  return result;
}
