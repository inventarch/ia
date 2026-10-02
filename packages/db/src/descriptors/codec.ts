import { createHash } from 'node:crypto';
import { types } from 'node:util';
import semver from 'semver';
import { parseStrictJson } from '../json.js';
import type { StrictJsonFault } from '../json.js';

/** OS09 DESC-02 initial limits. Collections are arrays and layout objects; names are unique per collection. */
export const DESCRIPTOR_LIMITS = Object.freeze({
  resourceBytes: 1024 * 1024,
  depth: 16,
  entries: 1000,
  nodes: 200_000,
  text: 200,
  message: 256,
});
export const DESCRIPTOR_FORMAT = 1;
export type DescriptorKind = 'domain-model' | 'storage-binding' | 'app-composition';
export type DescriptorCode =
  | 'DESC-ENVELOPE-INVALID'
  | 'DESC-ENVELOPE-MISMATCH'
  | 'DESC-FORMAT-UNSUPPORTED'
  | 'DESC-FEATURE-UNSUPPORTED'
  | 'DESC-RESOURCE-REFERENCE'
  | 'DESC-RESOURCE-UNDISCLOSED'
  | 'DESC-RESOURCE-SIZE'
  | 'DESC-RESOURCE-DEPTH'
  | 'DESC-RESOURCE-DUPLICATE-KEY'
  | 'DESC-RESOURCE-MALFORMED'
  | 'DESC-DIGEST-MISMATCH'
  | 'DESC-FIELD-UNKNOWN'
  | 'DESC-FIELD-MISSING'
  | 'DESC-FIELD-INVALID'
  | 'DESC-ENTRIES-EXCEEDED'
  | 'DESC-NAME-DUPLICATE'
  | 'DESC-REFERENCE-UNRESOLVED'
  | 'DESC-EXECUTABLE-REFUSED'
  | 'DESC-SECRET-REFUSED'
  | 'DESC-REGISTRY-INVALID'
  | 'DESC-CONTRACT-UNKNOWN'
  | 'DESC-CONTRACT-VERSION'
  | 'DESC-CONTRACT-KIND'
  | 'DESC-CONTRACT-SCHEMA'
  | 'DESC-CAPABILITY-UNDECLARED'
  | 'DESC-SKEW'
  | 'DESC-MAPPING'
  | 'DESC-STORAGE-UNSUPPORTED'
  | 'DESC-TARGET-UNSUPPORTED'
  | 'DESC-DEFINITION-UNTRUSTED';
/** Typed, bounded diagnostic. `source` is the envelope's native source path; `resource` the same-envelope key when the fault is in resource data. */
export interface DescriptorDiagnostic {
  readonly code: DescriptorCode;
  readonly owner: string;
  readonly source: string;
  readonly resource?: string;
  readonly field: string;
  readonly message: string;
}
/** A refusal carries exactly one deterministic diagnostic and no partial value. */
export type DescriptorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly [DescriptorDiagnostic] };

/** Attribution of the data currently being decoded. */
export interface Scope {
  readonly owner: string;
  readonly source: string;
  readonly resource?: string;
}
export class Refusal extends Error {
  constructor(
    readonly code: DescriptorCode,
    readonly field: string,
    message: string,
    readonly resourceless = false,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}
export function refuse(code: DescriptorCode, field: string, message: string): never {
  throw new Refusal(code, field, message);
}
/** Run a pure decoder; the only thrown value that becomes a diagnostic is a Refusal. */
export function attempt<T>(scope: Scope | (() => Scope), run: () => T): DescriptorResult<T> {
  try {
    return Object.freeze({ ok: true as const, value: run() });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const at = typeof scope === 'function' ? scope() : scope;
    const diagnostic = makeDiagnostic(at, error.code, error.field, error.message, error.resourceless);
    return Object.freeze({
      ok: false as const,
      diagnostics: Object.freeze([diagnostic]) as readonly [DescriptorDiagnostic],
    });
  }
}
/** Refuse a fault in envelope or host input rather than in resource data. */
export function refuseEnvelope(code: DescriptorCode, field: string, message: string): never {
  throw new Refusal(code, field, message, true);
}
/** Truncate to the message bound without splitting a UTF-16 surrogate pair. */
const bounded = (text: string): string => {
  if (text.length <= DESCRIPTOR_LIMITS.message) return text;
  let cut = DESCRIPTOR_LIMITS.message - 3;
  if (/[\uD800-\uDBFF]/.test(text.charAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}...`;
};
/** One diagnostic contract for both refusal and successful inspection results. */
export function makeDiagnostic(
  scope: Scope,
  code: DescriptorCode,
  field: string,
  message: string,
  resourceless = false,
): DescriptorDiagnostic {
  return Object.freeze({
    code,
    owner: bounded(scope.owner),
    source: bounded(scope.source),
    ...(resourceless || scope.resource === undefined ? {} : { resource: scope.resource }),
    field: bounded(field),
    message: bounded(message),
  });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Internal canonical form over data this module decoded or built: sorted keys (UTF-16 code unit order), no
 * whitespace, safe integers only, no Unicode normalisation. Equal to RFC 8785 for this value domain. Not exported:
 * hosts digest resource text through decodeDescriptorResource.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Descriptor numbers are safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new TypeError('Expected descriptor data');
}
export const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;

const FAULTS: Readonly<Record<StrictJsonFault, DescriptorCode>> = {
  input: 'DESC-RESOURCE-MALFORMED',
  size: 'DESC-RESOURCE-SIZE',
  encoding: 'DESC-RESOURCE-MALFORMED',
  depth: 'DESC-RESOURCE-DEPTH',
  nodes: 'DESC-RESOURCE-SIZE',
  'duplicate-key': 'DESC-RESOURCE-DUPLICATE-KEY',
  malformed: 'DESC-RESOURCE-MALFORMED',
  nonfinite: 'DESC-RESOURCE-MALFORMED',
  trailing: 'DESC-RESOURCE-MALFORMED',
};
const MESSAGES: Readonly<Record<StrictJsonFault, string>> = {
  input: 'Resource must be JSON text',
  size: 'Resource exceeds 1 MiB',
  encoding: 'Resource is not well-formed UTF-8 text',
  depth: 'Resource nesting exceeds 16 levels',
  nodes: 'Resource value count exceeds its bound',
  'duplicate-key': 'Duplicate JSON key',
  malformed: 'Malformed JSON',
  nonfinite: 'Nonfinite JSON number',
  trailing: 'Trailing content after the JSON value',
};
export interface DecodedResource {
  readonly value: unknown;
  readonly canonical: string;
  readonly digest: string;
}
/** Strict parse plus canonical digest. Numbers must be safe integers: exact decimals are strings. */
export function parseResource(text: string): DecodedResource {
  // DESC-02 counts containers: 16 nested objects/arrays with scalar leaves are admitted, a 17th refuses.
  const value = parseStrictJson(
    text,
    {
      bytes: DESCRIPTOR_LIMITS.resourceBytes,
      depth: DESCRIPTOR_LIMITS.depth,
      containers: DESCRIPTOR_LIMITS.depth,
      nodes: DESCRIPTOR_LIMITS.nodes,
    },
    (fault) => refuse(FAULTS[fault], '', MESSAGES[fault]),
  );
  const integers = (item: unknown, path: string): void => {
    if (typeof item === 'number' && !Number.isSafeInteger(item))
      refuse('DESC-RESOURCE-MALFORMED', path, 'Descriptor numbers must be safe integers; use a decimal string');
    if (Array.isArray(item))
      item.forEach((entry, index) => {
        integers(entry, `${path}[${index}]`);
      });
    else if (item !== null && typeof item === 'object')
      for (const [key, entry] of Object.entries(item)) integers(entry, join(path, key));
  };
  integers(value, '');
  const canonical = canonicalJson(value);
  return deepFreeze({
    value,
    canonical,
    digest: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  });
}
export const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

// Executable content never enters a descriptor (OS09 DOM-01, APPD-01).
// 1. Keys: these names refuse wherever they appear in a resource (a set lookup per key, linear in the resource).
const EXECUTABLE_KEYS = new Set([
  'import',
  'imports',
  'module',
  'component',
  'script',
  'code',
  'expression',
  'eval',
  'function',
  'handler',
  'css',
  'style',
  'class-name',
  'sql',
  'ddl',
  'url',
  'href',
  'src',
]);
const SECRET_KEYS = new Set(['password', 'secret-value', 'credential', 'token', 'api-key', 'private-key']);
export function refuseExecutableKeys(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      refuseExecutableKeys(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      const at = join(path, key),
        name = key.length <= 32 ? key.toLowerCase() : '';
      if (EXECUTABLE_KEYS.has(name))
        refuse('DESC-EXECUTABLE-REFUSED', at, 'Descriptor field would carry code, styling, SQL or a URL');
      if (SECRET_KEYS.has(name))
        refuse('DESC-SECRET-REFUSED', at, 'Descriptors carry secret references only, never secret values');
      refuseExecutableKeys(entry, at);
    }
}
// 2. Code-shaped values in identifier/reference positions. These strings are already invalid; the patterns only choose
// the more specific code. Every pattern is linear (anchored, or a literal with at most one unbounded class), and
// strings longer than CLASSIFIED_TEXT are refused as invalid without any pattern.
const CLASSIFIED_TEXT = 4096;
const CODE_VALUES: readonly RegExp[] = [
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\//,
  /^(?:javascript|data|vbscript|file|blob):/i,
  /^\.{0,2}\//,
  /^[A-Za-z]:[\\/]/,
  /\b(?:import|require|eval)\s*\(/,
  /=>/,
  /<[\s/]*script/i,
  /\$\{/,
  /\bnew\s+Function\b/,
  /\.(?:m?js|cjs|jsx|tsx?|css|wasm)$/i,
];
// 3. Free display text (screen titles, configuration defaults) may say "Node.js" or "=>"; only script-bearing
// shapes refuse there. Text readers bound the length before these run.
// A scheme counts only when a non-space character follows the colon, so "Data: overview" is ordinary text.
const TEXT_VALUES: readonly RegExp[] = [/^\s*(?:javascript|data|vbscript):\S/i, /<[\s/]*script/i, /\$\{/];
export function classifyInvalid(value: unknown, path: string): void {
  if (
    typeof value === 'string' &&
    value.length <= CLASSIFIED_TEXT &&
    CODE_VALUES.some((pattern) => pattern.test(value))
  )
    refuse('DESC-EXECUTABLE-REFUSED', path, 'Descriptor value names code, a module URL, a path or an expression');
}
export function freeText(value: unknown, path: string, max: number = DESCRIPTOR_LIMITS.text): string {
  const checked = text(value, path, max);
  if (TEXT_VALUES.some((pattern) => pattern.test(checked)))
    refuse('DESC-EXECUTABLE-REFUSED', path, 'Display text carries a script, a script URI or a template');
  return checked;
}

/**
 * Copy host-supplied input once as plain data before any field is read twice. Proxies, accessors, functions,
 * symbols, class instances, sparse arrays, cycles, excess depth and excess size refuse with `code`.
 */
export function snapshot(
  value: unknown,
  code: DescriptorCode,
  path: string,
  limits: { readonly depth: number; readonly nodes: number } = { depth: 32, nodes: DESCRIPTOR_LIMITS.nodes },
): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (item: unknown, at: string, depth: number): unknown => {
    const fault = (): never => refuseEnvelope(code, at, 'Input must be plain acyclic bounded data');
    if (++nodes > limits.nodes || depth > limits.depth) fault();
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      typeof item === 'number' ||
      item === undefined
    )
      return item;
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fault();
    const object = item as object,
      array = Array.isArray(object),
      prototype = Object.getPrototypeOf(object) as unknown;
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fault();
    // Size is checked before any per-property work: an array by its length, an object by its own key count.
    const length = array ? (object as unknown[]).length : 0;
    if (array && nodes + length > limits.nodes) fault();
    const keys = Reflect.ownKeys(object);
    if (!array && nodes + keys.length > limits.nodes) fault();
    if (keys.some((key) => typeof key === 'symbol')) fault();
    // An array holds exactly its indices 0..length-1 (no holes) and `length`; nothing else.
    if (
      array &&
      (keys.length !== length + 1 || keys.some((key, index) => key !== (index === length ? 'length' : String(index))))
    )
      fault();
    ancestors.add(object);
    // Null-prototype copies: no key of the copy can reach Object.prototype, and `__proto__` is refused outright.
    const result: Record<string, unknown> | unknown[] = array ? [] : (Object.create(null) as Record<string, unknown>);
    for (const key of keys as string[]) {
      if (array && key === 'length') continue;
      const where = array ? `${at}[${key}]` : join(at, key);
      if (key === '__proto__') refuseEnvelope(code, where, 'Input must not carry a __proto__ key');
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) fault();
      (result as Record<string, unknown>)[key] = copy(descriptor.value, where, depth + 1);
    }
    ancestors.delete(object);
    return result;
  };
  return copy(value, path, 0);
}

// Closed-shape readers. Every reader refuses with the field path; none coerces or defaults.
export type Row = Readonly<Record<string, unknown>>;
export function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('DESC-FIELD-INVALID', path, 'Expected an object');
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      refuse('DESC-FIELD-UNKNOWN', join(path, key), 'Unknown descriptor field');
  for (const key of required)
    if (!Object.hasOwn(value, key))
      refuse('DESC-FIELD-MISSING', join(path, key), 'Required descriptor field is missing');
  return value as Row;
}
export function list(value: unknown, path: string, min = 0): readonly unknown[] {
  if (!Array.isArray(value)) refuse('DESC-FIELD-INVALID', path, 'Expected a list');
  if (value.length > DESCRIPTOR_LIMITS.entries)
    refuse('DESC-ENTRIES-EXCEEDED', path, `Collection exceeds ${DESCRIPTOR_LIMITS.entries} entries`);
  if (value.length < min) refuse('DESC-FIELD-INVALID', path, `Expected at least ${min} entries`);
  return value;
}
const ID = /^[a-z][a-z0-9-]{0,63}$/;
export function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ID.test(value)) invalidText(value, path, 'Expected a lowercase identifier');
  return value;
}
/** Storage identifiers (store, column) follow common SQL identifier rules; they are data, never statements. */
export function storageId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    invalidText(value, path, 'Expected a storage identifier');
  return value;
}
export function text(value: unknown, path: string, max: number = DESCRIPTOR_LIMITS.text): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    refuse('DESC-FIELD-INVALID', path, 'Expected bounded single-line text');
  return value;
}
export function exactVersion(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 64 || semver.valid(value) !== value)
    refuse('DESC-FIELD-INVALID', path, 'Expected an exact SemVer version');
  return value;
}
export function integer(
  value: unknown,
  path: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    refuse('DESC-FIELD-INVALID', path, 'Expected a bounded safe integer');
  return value;
}
export function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') refuse('DESC-FIELD-INVALID', path, 'Expected true or false');
  return value;
}
export function choice<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value))
    refuse('DESC-FIELD-INVALID', path, `Expected one of ${options.join(', ')}`);
  return value as T;
}
export function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    refuse('DESC-FIELD-INVALID', path, 'Expected sha256:<64 lowercase hex>');
  return value;
}
/** A versioned contract reference `id@major`: trusted registry keys, never import specifiers. */
export interface ContractRef {
  readonly id: string;
  readonly version: number;
  readonly text: string;
}
export function contractRef(value: unknown, path: string): ContractRef {
  const match = typeof value === 'string' ? /^([a-z][a-z0-9-]{0,63})@([1-9][0-9]{0,5})$/.exec(value) : null;
  if (!match) invalidText(value, path, 'Expected a contract reference id@major');
  return { id: match[1]!, version: Number(match[2]), text: value as string };
}
function invalidText(value: unknown, path: string, message: string): never {
  classifyInvalid(value, path);
  refuse('DESC-FIELD-INVALID', path, message);
}
/** Names are unique within their collection. */
export function unique<T>(items: readonly T[], path: string, name: (item: T) => string, field = 'name'): readonly T[] {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = name(item);
    if (seen.has(key))
      refuse(
        'DESC-NAME-DUPLICATE',
        field ? `${path}[${index}].${field}` : `${path}[${index}]`,
        'Name is not unique within its collection',
      );
    seen.add(key);
  });
  return items;
}
/** v1 defines no optional features: any required feature is unknown and refuses rather than being dropped. */
export function features(value: unknown, path: string): readonly string[] {
  const names = list(value, path).map((entry, index) => id(entry, `${path}[${index}]`));
  if (names.length) refuse('DESC-FEATURE-UNSUPPORTED', `${path}[0]`, 'Unknown required descriptor feature');
  return names;
}
/** Check the format before the closed shape, so a newer major refuses as unsupported rather than as unknown fields. */
export function versioned(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  scan = true,
): Row {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'format'))
    format((value as Row)['format'], 'format');
  if (scan) refuseExecutableKeys(value);
  const row = record(value, '', required, optional);
  format(row['format'], 'format');
  return row;
}
export function format(value: unknown, path: string): void {
  if (value !== DESCRIPTOR_FORMAT)
    refuse(
      typeof value === 'number' && Number.isSafeInteger(value) ? 'DESC-FORMAT-UNSUPPORTED' : 'DESC-FIELD-INVALID',
      path,
      'Unsupported descriptor format',
    );
}
