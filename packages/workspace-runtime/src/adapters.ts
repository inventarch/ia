import type { OperationDefinition } from '@inventarch/agent-system';
import type { Json } from '@inventarch/session-system';
import { decodeJson, frozen, hash, integer, list, metadataDigest, object, text } from './resource-format.js';
export { metadataDigest as adapterMetadataDigest } from './resource-format.js';

export const ADAPTER_LIMITS = Object.freeze({
  durationMs: 120_000,
  inputBytes: 1024 * 1024,
  outputBytes: 1024 * 1024,
  concurrency: 4,
  operations: 64,
  metadataBytes: 2 * 1024 * 1024,
});
export class AdapterError extends Error {
  readonly code = 'IA-ADAPTER-INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
export const adapterInvalid = (message: string): never => {
  throw new AdapterError(message);
};
export function adapterKey(value: unknown): string {
  const key = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key))
    return adapterInvalid('An opaque installed catalog key is required');
  return key;
}
function boundedText(value: unknown, limit = 128): string {
  const result = text(value, limit);
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) return adapterInvalid('Bounded installed metadata is required');
  return result;
}
function one<const T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    return adapterInvalid('Unsupported installed adapter contract');
  return value as T;
}
function strings(value: unknown, max: number, decode = adapterKey): string[] {
  const rows = list(value, max).map(decode),
    sorted = [...rows].sort();
  if (new Set(rows).size !== rows.length || rows.some((row, index) => row !== sorted[index]))
    return adapterInvalid('Installed metadata sets must be unique and sorted');
  return rows;
}
export function adapterJson(input: unknown): Json {
  let nodes = 0;
  const read = (value: unknown, depth: number): Json => {
    if (++nodes > 10_000 || depth > 16) return adapterInvalid('Installed JSON shape exceeds its bound');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, ADAPTER_LIMITS.inputBytes);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !Object.hasOwn(field, 'value'))
      )
        return adapterInvalid('Expected closed JSON array data');
      return value.map((item) => read(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const row = object(value, Object.keys(value));
      return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, read(item, depth + 1)]));
    }
    return adapterInvalid('Expected finite JSON data');
  };
  return read(input, 0);
}
export interface InstalledAdapterEffect {
  readonly id: string;
  readonly kind:
    | 'managed-draft'
    | 'retained-store'
    | 'temporary-files'
    | 'host-transcript-read'
    | 'loopback-listener'
    | 'process'
    | 'remote-call';
  readonly targetPolicy: string;
  readonly enforcement: 'adapter' | 'contained';
  readonly credentials: readonly string[];
  readonly telemetry: string;
}
export interface InstalledAdapterDescriptor {
  readonly format: 'ia.installed-adapter.v1';
  readonly id: string;
  readonly version: string;
  readonly implementation:
    | {
        readonly kind: 'local';
        readonly inventoryDigest: string;
        readonly entrypoint: string;
        readonly transport: 'stdio' | 'process';
        readonly runtime: string;
        readonly platforms: readonly string[];
        readonly abi: string;
      }
    | {
        readonly kind: 'remote';
        readonly provider: string;
        readonly origin: string;
        readonly contractDigest: string;
        readonly clientProfile: string;
      };
  readonly operations: readonly OperationDefinition[];
  readonly effects: readonly InstalledAdapterEffect[];
  readonly limits: {
    readonly durationMs: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly concurrency: number;
  };
  readonly recovery: { readonly id: string; readonly contractDigest: string };
  readonly digest: string;
}
export interface InstalledAdapterCatalog {
  readonly adapters: Readonly<Record<string, unknown>>;
  readonly containments: readonly { readonly adapterDigest: string; readonly targetPolicy: string }[];
}
/** Decode and hash only; installed qualification additionally requires verifyInstalledAdapter. */
export function decodeInstalledAdapter(input: unknown): InstalledAdapterDescriptor {
  const row = object(typeof input === 'string' ? decodeJson(input) : input, [
    'format',
    'id',
    'version',
    'implementation',
    'operations',
    'effects',
    'limits',
    'recovery',
    'digest',
  ]);
  one(row['format'], ['ia.installed-adapter.v1']);
  const limitsRow = object(row['limits'], ['durationMs', 'inputBytes', 'outputBytes', 'concurrency']);
  const limits = {
    durationMs: integer(limitsRow['durationMs'], ADAPTER_LIMITS.durationMs, 1),
    inputBytes: integer(limitsRow['inputBytes'], ADAPTER_LIMITS.inputBytes, 1),
    outputBytes: integer(limitsRow['outputBytes'], ADAPTER_LIMITS.outputBytes, 1),
    concurrency: integer(limitsRow['concurrency'], ADAPTER_LIMITS.concurrency, 1),
  };
  const implementationRow = row['implementation'];
  if (!implementationRow || typeof implementationRow !== 'object' || Array.isArray(implementationRow))
    return adapterInvalid('Installed implementation descriptor required');
  const kind = Object.getOwnPropertyDescriptor(implementationRow, 'kind')?.value;
  let implementation: InstalledAdapterDescriptor['implementation'];
  if (kind === 'local') {
    const local = object(implementationRow, [
      'kind',
      'inventoryDigest',
      'entrypoint',
      'transport',
      'runtime',
      'platforms',
      'abi',
    ]);
    const platforms = strings(local['platforms'], 16);
    if (!platforms.length) return adapterInvalid('An explicit supported platform is required');
    implementation = {
      kind,
      inventoryDigest: hash(local['inventoryDigest']),
      entrypoint: adapterKey(local['entrypoint']),
      transport: one(local['transport'], ['stdio', 'process']),
      runtime: boundedText(local['runtime']),
      platforms,
      abi: adapterKey(local['abi']),
    };
  } else {
    const remote = object(implementationRow, ['kind', 'provider', 'origin', 'contractDigest', 'clientProfile']);
    one(remote['kind'], ['remote']);
    const origin = boundedText(remote['origin'], 2048),
      url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== origin)
      return adapterInvalid('An exact credential-free HTTPS service origin is required');
    implementation = {
      kind: 'remote',
      provider: adapterKey(remote['provider']),
      origin,
      contractDigest: hash(remote['contractDigest']),
      clientProfile: adapterKey(remote['clientProfile']),
    };
  }
  const operations = list(row['operations'], ADAPTER_LIMITS.operations).map((value): OperationDefinition => {
    const hasPurpose = !!value && typeof value === 'object' && Object.hasOwn(value, 'purpose');
    const op = object(value, [
      'id',
      'handler',
      'digest',
      'effects',
      'recovery',
      'timeoutMs',
      'input',
      'output',
      'maxOutputBytes',
      ...(hasPurpose ? ['purpose'] : []),
    ]);
    const effects = strings(op['effects'], 3).map((effect) => one(effect, ['read', 'local-write', 'external-write']));
    return {
      id: adapterKey(op['id']),
      handler: adapterKey(op['handler']),
      digest: hash(op['digest']),
      effects,
      recovery: one(op['recovery'], ['repeatable', 'idempotent', 'reconcile', 'manual']),
      timeoutMs: integer(op['timeoutMs'], limits.durationMs, 1),
      input: adapterJson(op['input']),
      output: adapterJson(op['output']),
      maxOutputBytes: integer(op['maxOutputBytes'], limits.outputBytes, 1),
      ...(hasPurpose ? { purpose: one(op['purpose'], ['candidate-validation']) } : {}),
    };
  });
  if (!operations.length) return adapterInvalid('At least one installed operation is required');
  const effects = list(row['effects'], 64).map((value): InstalledAdapterEffect => {
    const effect = object(value, ['id', 'kind', 'targetPolicy', 'enforcement', 'credentials', 'telemetry']);
    return {
      id: adapterKey(effect['id']),
      kind: one(effect['kind'], [
        'managed-draft',
        'retained-store',
        'temporary-files',
        'host-transcript-read',
        'loopback-listener',
        'process',
        'remote-call',
      ]),
      targetPolicy: adapterKey(effect['targetPolicy']),
      enforcement: one(effect['enforcement'], ['adapter', 'contained']),
      credentials: strings(effect['credentials'], 16),
      telemetry: adapterKey(effect['telemetry']),
    };
  });
  for (const rows of [operations, effects]) {
    const ids = rows.map((item) => item.id);
    if (new Set(ids).size !== ids.length || ids.join('\0') !== [...ids].sort().join('\0'))
      return adapterInvalid('Installed operation/effect identities must be unique and sorted');
  }
  const recoveryRow = object(row['recovery'], ['id', 'contractDigest']);
  const body = {
    format: 'ia.installed-adapter.v1' as const,
    id: adapterKey(row['id']),
    version: boundedText(row['version']),
    implementation,
    operations,
    effects,
    limits,
    recovery: { id: adapterKey(recoveryRow['id']), contractDigest: hash(recoveryRow['contractDigest']) },
  };
  if (
    Buffer.byteLength(JSON.stringify(body)) > ADAPTER_LIMITS.metadataBytes ||
    hash(row['digest']) !== metadataDigest(body)
  )
    return adapterInvalid('Installed adapter digest or metadata size differs');
  return frozen({ ...body, digest: hash(row['digest']) });
}
export function verifyInstalledAdapter(value: unknown, catalog: InstalledAdapterCatalog): InstalledAdapterDescriptor {
  const descriptor = decodeInstalledAdapter(value),
    installed = decodeInstalledAdapter(catalog.adapters[descriptor.id]);
  if (descriptor.digest !== installed.digest)
    return adapterInvalid('Installed adapter operation, effect, recovery or implementation contract changed');
  for (const effect of descriptor.effects)
    if (
      effect.enforcement === 'contained' &&
      !catalog.containments.some(
        (item) => item.adapterDigest === descriptor.digest && item.targetPolicy === effect.targetPolicy,
      )
    )
      return adapterInvalid('Required containment has no qualified installed boundary');
  return descriptor;
}
