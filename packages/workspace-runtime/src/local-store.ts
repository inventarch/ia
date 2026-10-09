import {
  validateShape,
  type OperationAdapter,
  type OperationContext,
  type OperationDefinition,
  type OperationResult,
} from '@inventarch/agent-system';
import type { Json } from '@inventarch/session-system';
import {
  ADAPTER_LIMITS,
  adapterInvalid,
  adapterJson,
  adapterKey,
  decodeInstalledAdapter,
  verifyInstalledAdapter,
  type InstalledAdapterCatalog,
} from './adapters.js';
import { decodeJson, frozen, hash, integer, metadataDigest, object, text } from './resource-format.js';

export const RETAINED_STORE_LIMITS = Object.freeze({
  entries: 100_000,
  entryBytes: 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  indexBatch: 100,
});
export interface RetainedStoreBinding {
  readonly format: 'ia.retained-store.v1';
  readonly owner: string;
  readonly storeId: string;
  readonly rootBinding: string;
  readonly schemaVersion: number;
  readonly accessPolicy: string;
  readonly retention: { readonly days: number | null; readonly deletion: 'explicit' };
  readonly quotas: {
    readonly entries: number;
    readonly entryBytes: number;
    readonly totalBytes: number;
    readonly indexBatch: number;
  };
  readonly adapterDigest: string;
  readonly digest: string;
}
export function verifyStoreBinding(input: unknown, installed: unknown): RetainedStoreBinding {
  const adapter = decodeInstalledAdapter(installed),
    row = object(typeof input === 'string' ? decodeJson(input) : input, [
      'format',
      'owner',
      'storeId',
      'rootBinding',
      'schemaVersion',
      'accessPolicy',
      'retention',
      'quotas',
      'adapterDigest',
      'digest',
    ]);
  if (row['format'] !== 'ia.retained-store.v1' || !adapter.effects.some((effect) => effect.kind === 'retained-store'))
    return adapterInvalid('An explicit retained-store adapter binding is required');
  const owner = text(row['owner'], 512);
  if (!owner || /[\u0000-\u001f\u007f]/.test(owner))
    return adapterInvalid('A current authenticated store owner is required');
  const retention = object(row['retention'], ['days', 'deletion']),
    quotas = object(row['quotas'], ['entries', 'entryBytes', 'totalBytes', 'indexBatch']);
  if (retention['deletion'] !== 'explicit') return adapterInvalid('Retained store deletion must be explicit');
  const body = {
    format: 'ia.retained-store.v1' as const,
    owner,
    storeId: adapterKey(row['storeId']),
    rootBinding: adapterKey(row['rootBinding']),
    schemaVersion: integer(row['schemaVersion'], 1_000_000, 1),
    accessPolicy: adapterKey(row['accessPolicy']),
    retention: {
      days: retention['days'] === null ? null : integer(retention['days'], 36_500, 1),
      deletion: 'explicit' as const,
    },
    quotas: {
      entries: integer(quotas['entries'], RETAINED_STORE_LIMITS.entries, 1),
      entryBytes: integer(quotas['entryBytes'], RETAINED_STORE_LIMITS.entryBytes, 1),
      totalBytes: integer(quotas['totalBytes'], RETAINED_STORE_LIMITS.totalBytes, 1),
      indexBatch: integer(quotas['indexBatch'], RETAINED_STORE_LIMITS.indexBatch, 1),
    },
    adapterDigest: hash(row['adapterDigest']),
  };
  if (
    body.adapterDigest !== adapter.digest ||
    body.quotas.entryBytes > body.quotas.totalBytes ||
    hash(row['digest']) !== metadataDigest(body)
  )
    return adapterInvalid('Retained store binding digest, quotas or installed adapter differs');
  return frozen({ ...body, digest: hash(row['digest']) });
}
export interface LocalStorePorts {
  readonly adapter: unknown;
  readonly catalog: InstalledAdapterCatalog;
  current(): Promise<{ binding: unknown; adapter: unknown; catalog: InstalledAdapterCatalog }>;
  authorize(binding: RetainedStoreBinding, operation: OperationDefinition, context: OperationContext): Promise<void>;
  readonly storage: {
    execute(
      binding: RetainedStoreBinding,
      operation: OperationDefinition,
      input: Json,
      context: OperationContext,
    ): Promise<OperationResult>;
    reconcile?(
      binding: RetainedStoreBinding,
      operation: OperationDefinition,
      input: Json,
      context: OperationContext,
    ): Promise<{ status: 'absent' | 'applied' | 'partial' | 'unknown'; output: Json | null }>;
  };
}
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error('Retained store operation aborted'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
/** Host ports own physical roots and transactions; this wrapper never loads a module or opens storage. */
export function createLocalStoreAdapter(
  input: unknown,
  ports: LocalStorePorts,
): Readonly<Record<string, OperationAdapter>> {
  const installed = verifyInstalledAdapter(ports.adapter, ports.catalog),
    binding = verifyStoreBinding(input, installed);
  const current = ports.current,
    authorize = ports.authorize,
    execute = ports.storage.execute,
    reconcile = ports.storage.reconcile;
  let active = 0;
  const check = async (operation: OperationDefinition, context: OperationContext, wait: typeof bounded) => {
    const observed = await wait(() => current(), context.signal),
      adapter = verifyInstalledAdapter(observed.adapter, observed.catalog),
      selected = verifyStoreBinding(observed.binding, adapter);
    if (adapter.digest !== installed.digest || selected.digest !== binding.digest)
      return adapterInvalid('Current retained store root, policy, schema or installed adapter changed');
    await wait(() => authorize(binding, operation, context), context.signal);
    if (context.assertCurrent) await wait(() => context.assertCurrent!(), context.signal);
    context.signal.throwIfAborted();
  };
  const invoke = async <T>(
    operation: OperationDefinition,
    value: Json,
    parent: OperationContext,
    work: (input: Json, context: OperationContext) => Promise<T>,
  ): Promise<T> => {
    const input = frozen(adapterJson(value));
    if (
      Buffer.byteLength(JSON.stringify(input)) > Math.min(ADAPTER_LIMITS.inputBytes, installed.limits.inputBytes) ||
      !validateShape(operation.input, input)
    )
      return adapterInvalid('Retained operation input shape or complete byte bound differs');
    if (active >= installed.limits.concurrency)
      return adapterInvalid('Installed retained operation concurrency is exhausted');
    const outstanding = new Set<Promise<unknown>>();
    let ended = false,
      released = false;
    const release = () => {
      if (ended && outstanding.size === 0 && !released) {
        released = true;
        active--;
      }
    };
    const wait: typeof bounded = (work, observedSignal) =>
      bounded(() => {
        observedSignal.throwIfAborted();
        const pending = Promise.resolve().then(work);
        outstanding.add(pending);
        const settled = () => {
          outstanding.delete(pending);
          release();
        };
        void pending.then(settled, settled);
        return pending;
      }, observedSignal);
    const deadline = AbortSignal.timeout(Math.min(operation.timeoutMs, installed.limits.durationMs)),
      narrowed = new AbortController(),
      signal = AbortSignal.any([parent.signal, deadline, narrowed.signal]);
    const observed = new Map<AbortSignal, () => void>();
    const observe = () => {
      const current = parent.signal;
      if (current.aborted) narrowed.abort(current.reason);
      else if (!observed.has(current)) {
        const abort = () => narrowed.abort(current.reason);
        observed.set(current, abort);
        current.addEventListener('abort', abort, { once: true });
      }
    };
    const context: OperationContext = {
      ...parent,
      signal,
      get grant() {
        return parent.grant;
      },
      assertCurrent: async () => {
        if (parent.assertCurrent) await wait(() => parent.assertCurrent!(), signal);
        observe();
        signal.throwIfAborted();
      },
    };
    observe();
    active++;
    try {
      await check(operation, context, wait);
      const result = await wait(() => work(input, context), signal);
      await check(operation, context, wait);
      parent.signal.throwIfAborted();
      signal.throwIfAborted();
      return result;
    } finally {
      ended = true;
      release();
      for (const [observedSignal, abort] of observed) observedSignal.removeEventListener('abort', abort);
    }
  };
  return Object.freeze(
    Object.fromEntries(
      installed.operations.map((operation) => [
        operation.id,
        {
          id: operation.handler,
          execute: (value: Json, context: OperationContext) =>
            invoke(operation, value, context, async (input, current) => {
              const result = await execute(binding, operation, input, current),
                row = object(result, ['output', 'effect']),
                output = adapterJson(row['output']);
              if (
                !['none', 'applied', 'partial', 'unknown'].includes(String(row['effect'])) ||
                !validateShape(operation.output, output) ||
                Buffer.byteLength(JSON.stringify({ output, effect: row['effect'] })) >
                  Math.min(installed.limits.outputBytes, operation.maxOutputBytes ?? ADAPTER_LIMITS.outputBytes)
              )
                return adapterInvalid('Retained operation output shape or complete byte bound differs');
              return frozen({ output, effect: row['effect'] as OperationResult['effect'] });
            }),
          ...(reconcile
            ? {
                reconcile: (value: Json, context: OperationContext) =>
                  invoke(operation, value, context, async (input, current) => {
                    const result = await reconcile(binding, operation, input, current),
                      row = object(result, ['status', 'output']),
                      output = row['output'] === null ? null : adapterJson(row['output']);
                    if (
                      !['absent', 'applied', 'partial', 'unknown'].includes(String(row['status'])) ||
                      (output !== null && !validateShape(operation.output, output)) ||
                      Buffer.byteLength(JSON.stringify({ output, status: row['status'] })) >
                        Math.min(installed.limits.outputBytes, operation.maxOutputBytes ?? ADAPTER_LIMITS.outputBytes)
                    )
                      return adapterInvalid('Invalid retained reconciliation observation');
                    return frozen({ status: row['status'] as 'absent' | 'applied' | 'partial' | 'unknown', output });
                  }),
              }
            : {}),
        },
      ]),
    ),
  );
}
