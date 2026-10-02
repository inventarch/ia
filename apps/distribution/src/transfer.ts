import { resolve } from 'node:path';
import { decodeDistributionLock, DISTRIBUTION_LIMITS } from '@ia/db/distribution';
import type { DistributionLock } from '@ia/db/distribution';
import { verifyArchive } from './archive.js';
import { cacheArchive } from './install.js';

export interface AcquisitionSelection {
  readonly acquisitionId: string;
  readonly lock: DistributionLock;
}
export interface ArtifactTransferRequest {
  readonly acquisitionId: string;
  readonly archive: string;
  readonly offset: number;
  readonly length: number;
}
export type ArtifactTransfer = (request: ArtifactTransferRequest, signal: AbortSignal) => Promise<unknown>;
function invalid(message: string): never {
  throw new Error(`Acquisition transfer refused: ${message}`);
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    return invalid('Expected closed data');
  const names = Reflect.ownKeys(input),
    fields = Object.getOwnPropertyDescriptors(input);
  if (
    names.length !== keys.length ||
    names.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !fields[key]?.enumerable ||
        !Object.hasOwn(fields[key]!, 'value'),
    )
  )
    return invalid('Unknown, missing or accessor field');
  return input as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid('Integer bound');
  return value;
}
async function read(
  transfer: ArtifactTransfer,
  request: ArtifactTransferRequest,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => transfer(Object.freeze(request), signal)),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error('Transfer cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Every chunk goes through the caller's authenticated transport. No URL, credential or activation is inferred. */
export async function cacheAcquisition(
  root: string,
  input: unknown,
  transfer: ArtifactTransfer,
  options: { chunkBytes?: number; requestTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ lock: DistributionLock; archives: readonly string[] }> {
  const row = object(input, ['acquisitionId', 'lock']),
    acquisitionId = row['acquisitionId'];
  if (typeof acquisitionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(acquisitionId))
    return invalid('Invalid acquisition identity');
  const lock = decodeDistributionLock(row['lock']),
    target = resolve(root),
    chunkBytes = integer(options.chunkBytes ?? 96 * 1024, 1024, 96 * 1024);
  const timeout = integer(options.requestTimeoutMs ?? 30_000, 1, 60_000),
    caller = options.signal;
  if (lock.packages.some((pkg) => pkg.location !== `sha256:${pkg.archive}`))
    return invalid('An acquired lock must use exact cached archive locations');
  if (new Set(lock.packages.map((pkg) => pkg.archive)).size !== lock.packages.length)
    return invalid('Distinct package identities cannot share an archive');
  const archives: string[] = [];
  let total = 0;
  for (const pkg of lock.packages) {
    let offset = 0,
      expected: number | undefined;
    const chunks: Buffer[] = [];
    for (;;) {
      const deadline = AbortSignal.timeout(timeout),
        signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
      const part = object(
        await read(transfer, { acquisitionId, archive: pkg.archive, offset, length: chunkBytes }, signal),
        ['archive', 'bytes', 'offset', 'data', 'next'],
      );
      signal.throwIfAborted();
      const bytes = integer(part['bytes'], 1, DISTRIBUTION_LIMITS.compressed),
        position = integer(part['offset'], 0, bytes);
      if (part['archive'] !== pkg.archive || position !== offset || (expected !== undefined && bytes !== expected))
        return invalid('Archive identity, size or offset changed');
      if (expected === undefined) {
        expected = bytes;
        total += bytes;
        if (total > DISTRIBUTION_LIMITS.expanded) return invalid('Aggregate archive byte limit');
      }
      const content = part['data'];
      if (typeof content !== 'string' || content.length > Math.ceil(chunkBytes / 3) * 4)
        return invalid('Bounded base64 chunk required');
      const payload = Buffer.from(content, 'base64'),
        length = Math.min(bytes - offset, chunkBytes);
      if (length <= 0 || payload.length !== length || payload.toString('base64') !== content)
        return invalid('Incomplete or noncanonical chunk');
      offset += length;
      const next = offset === bytes ? null : offset;
      if (part['next'] !== next) return invalid('Truncated or redirected continuation');
      chunks.push(payload);
      if (next === null) break;
    }
    const content = Buffer.concat(chunks),
      archive = verifyArchive(content, pkg.archive);
    if (
      archive.manifest.id !== pkg.id ||
      archive.manifest.version !== pkg.version ||
      archive.manifestDigest !== pkg.manifest
    )
      return invalid('Selected release differs from the verified archive');
    caller?.throwIfAborted();
    cacheArchive(target, content);
    archives.push(pkg.archive);
  }
  return { lock, archives: Object.freeze(archives) };
}
