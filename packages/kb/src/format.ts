import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import { portablePath } from '@inventarch/workspace-runtime/resource-format';

/** Packages and legacy envelopes keep the format limits their readers enforce; `capture*` bounds one local read. */
export const LIMITS = Object.freeze({
  records: 1000,
  files: 100,
  fileBytes: 1024 * 1024,
  selectedBytes: 8 * 1024 * 1024,
  selectionBytes: 64 * 1024,
  captureRecords: 5000,
  captureFiles: 1000,
  captureBytes: 40 * 1024 * 1024,
  captureSelectionBytes: 512 * 1024,
  query: 200,
  results: 100,
  steps: 64,
  responseBytes: 48 * 1024,
});
export class KnowledgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}
export const fail = (message: string, code = 'IA-KB-INVALID'): never => {
  throw new KnowledgeError(code, message);
};
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const digest = (value: unknown): string => hash(stableSerialize(value));
export function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}
/** Bounded JSON data only: no getters, sparse arrays, prototypes, cycles or pre-allocation byte excess. */
export function data<T = unknown>(value: unknown, limit = 20 * 1024 * 1024): T {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('Invalid JSON byte limit');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > limit) fail('JSON byte limit exceeded');
    let depth = 0,
      quoted = false,
      escaped = false,
      tokens = 0,
      scalar = false;
    for (const c of value) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') {
        quoted = true;
        scalar = false;
        if (++tokens > 100000) fail('JSON node limit exceeded');
      } else if (c === '[' || c === '{') {
        scalar = false;
        if (++depth > 64) fail('JSON depth limit exceeded');
        if (++tokens > 100000) fail('JSON node limit exceeded');
      } else if (c === ']' || c === '}') {
        depth--;
        scalar = false;
      } else if (c === ',' || c === ':' || /\s/.test(c)) scalar = false;
      else if (!scalar) {
        scalar = true;
        if (++tokens > 100000) fail('JSON node limit exceeded');
      }
    }
  }
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const seen = new Set<object>();
  const stack: { v: unknown; depth: number; exit?: boolean }[] = [{ v: parsed, depth: 0 }];
  let nodes = 0,
    scheduled = 1,
    bytes = 0;
  while (stack.length) {
    const item = stack.pop()!,
      v = item.v;
    if (item.exit) {
      seen.delete(v as object);
      continue;
    }
    if (++nodes > 100000) fail('JSON node limit exceeded');
    if (item.depth > 64) fail('JSON depth limit exceeded');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      bytes += String(v).length;
    else if (typeof v === 'string') {
      if (Buffer.byteLength(v) > limit - bytes) fail('JSON byte limit exceeded');
      bytes += Buffer.byteLength(JSON.stringify(v));
    } else {
      if (typeof v !== 'object' || v === null || seen.has(v)) fail('Invalid JSON data');
      const obj = v as object,
        array = Array.isArray(obj),
        prototype = Object.getPrototypeOf(obj);
      if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
        fail('Invalid JSON object');
      const keys = Reflect.ownKeys(obj).filter((key) => !(array && key === 'length'));
      scheduled += keys.length * (array ? 1 : 2);
      if (scheduled > 100000) fail('JSON node limit exceeded');
      if (array && (keys.length !== obj.length || keys.some((key, i) => key !== String(i))))
        fail('JSON array fields only');
      seen.add(obj);
      stack.push({ v: obj, depth: item.depth, exit: true });
      bytes += 2 + Math.max(0, keys.length - 1);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!,
          descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          fail('JSON data fields only');
        if (!array) {
          if (Buffer.byteLength(key as string) > limit - bytes) fail('JSON byte limit exceeded');
          bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        }
        stack.push({ v: descriptor.value as unknown, depth: item.depth + 1 });
      }
    }
    if (bytes > limit) fail('JSON byte limit exceeded');
  }
  return JSON.parse(JSON.stringify(parsed)) as T;
}
export function closed<T>(value: unknown, keys: readonly string[]): T {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    fail('Invalid envelope fields');
  return value as T;
}
export function slug(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('Invalid source identity');
}
export function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('Invalid digest');
}
export function commitId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('Exact full commit required');
}
export function selectedPath(path: string, legacy = false): string {
  portablePath(path);
  const native = path.startsWith('.ia/src/') && path.endsWith('.ia') && !path.startsWith('.ia/src/floor/');
  const body = legacy
    ? /^(docs|content|knowledge)\/.+\.(md|txt)$/.test(path)
    : /\.(md|txt)$/.test(path) &&
      !path.split('/').some((p) => p.startsWith('.')) &&
      !path.split('/').includes('node_modules');
  if (!native && !body) fail('Path outside portable content selection');
  return path;
}
export interface KnowledgeFile {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}
export interface Provenance {
  readonly sourceId: string;
  readonly commit: string;
  readonly verification: 'unverified';
}
export interface LegacyPortable {
  readonly format: 'iakb.portable.v1';
  readonly provenance: Provenance;
  readonly files: readonly KnowledgeFile[];
  readonly digest: string;
}
export function verifyFiles(files: readonly KnowledgeFile[], legacy: boolean, withBytes = false): void {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) fail('Invalid file selection');
  const aliases = new Set<string>();
  let bytes = 0;
  for (const f of files) {
    closed(f, withBytes ? ['path', 'text', 'sha256', 'bytes'] : ['path', 'text', 'sha256']);
    selectedPath(f.path, legacy);
    sha(f.sha256);
    if (
      typeof f.text !== 'string' ||
      f.text.includes('\0') ||
      Buffer.byteLength(f.text) > LIMITS.fileBytes ||
      Buffer.from(f.text).toString('utf8') !== f.text ||
      hash(f.text) !== f.sha256
    )
      fail('Portable bytes/hash mismatch');
    const size = Buffer.byteLength(f.text);
    if (withBytes && (f as KnowledgeFile & { bytes: number }).bytes !== size) fail('Portable byte length mismatch');
    const key = f.path.toLowerCase();
    if (aliases.has(key)) fail('Aliased portable path');
    aliases.add(key);
    bytes += size;
  }
  if (bytes > LIMITS.selectedBytes) fail('Portable byte limit exceeded');
  if (!files.some((f) => f.path.startsWith('.ia/src/'))) fail('Native records required');
  if (
    files.map((f) => f.path).join('\0') !==
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => f.path)
      .join('\0')
  )
    fail('Noncanonical file ordering');
}
