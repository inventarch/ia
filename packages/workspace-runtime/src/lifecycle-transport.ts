import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import { decodeJson, frozen, metadataDigest } from './resource-format.js';
import { isSegmentedLifecycleProfile, LifecycleError } from './lifecycle-profile.js';

export const LIFECYCLE_CONTEXT_SLOTS = 12;
export const LIFECYCLE_CONTEXT_CHARACTERS = 10_000;
export interface LifecycleSegmentOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'SessionStart' | 'UserPromptSubmit';
    readonly additionalContext: string;
  };
}
export interface LifecycleFragments {
  readonly outputs: readonly LifecycleSegmentOutput[];
  readonly serialized: string;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const instruction =
  'Require all 12 matching slots and complete data; otherwise context is unavailable. Delivery unconfirmed.';
function fail(): never {
  throw new LifecycleError(
    'IA-LIFECYCLE-BUDGET',
    'Lifecycle segment set exceeds its bound or has missing, mixed or invalid data',
  );
}
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}
function bounded(text: unknown, maximum: number): string {
  if (
    typeof text !== 'string' ||
    text.length > maximum ||
    Buffer.byteLength(text) > 1024 * 1024 ||
    Buffer.from(text).toString('utf8') !== text
  )
    fail();
  return text;
}
function payloadInfo(payload: string) {
  bounded(payload, 1024 * 1024);
  const decoded = object(decodeJson(payload)),
    { id, ...body } = decoded,
    pins = object(body['pins']),
    event = object(body['event']);
  if (
    body['format'] !== 'ia.lifecycle-context.v1' ||
    body['delivery'] !== 'unconfirmed' ||
    id !== metadataDigest(body) ||
    !isSegmentedLifecycleProfile(pins['profile']) ||
    !['start', 'prompt'].includes(event['kind'] as string)
  )
    fail();
  if (
    Object.keys(pins).sort().join(',') !== 'binding,implementation,installation,policy,profile,resources,source,view' ||
    Object.values(pins).some((pin) => pin !== null && (typeof pin !== 'string' || !/^[a-f0-9]{64}$/.test(pin))) ||
    Object.entries(pins).some(([key, pin]) => key !== 'installation' && pin === null)
  )
    fail();
  if (
    Object.keys(event).sort().join(',') !== 'inputDigest,key,kind,source' ||
    typeof event['inputDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(event['inputDigest']) ||
    (event['key'] !== null && (typeof event['key'] !== 'string' || !/^[a-f0-9]{64}$/.test(event['key'])))
  )
    fail();
  if (
    event['kind'] === 'prompt'
      ? event['source'] !== null
      : !['startup', 'resume', 'clear', 'compact', 'fork'].includes(event['source'] as string) || event['key'] !== null
  )
    fail();
  return {
    id: id as string,
    pins,
    event,
    hookEventName: event['kind'] === 'start' ? ('SessionStart' as const) : ('UserPromptSubmit' as const),
  };
}
/** Exact deterministic transport only; no view, permission, input or delivery cache. */
export function fragmentLifecycleContext(payload: string): LifecycleFragments {
  const info = payloadInfo(payload),
    totalBytes = Buffer.byteLength(payload),
    wholeDigest = digest(payload);
  const frame = (slot: number, count: number, chunk: string | null) => ({
    format: 'ia.lifecycle-context-segment.v1',
    packetId: info.id,
    pins: info.pins,
    event: info.event,
    slot,
    dataCount: count,
    totalSlots: LIFECYCLE_CONTEXT_SLOTS,
    totalBytes,
    wholeDigest,
    chunkDigest: chunk === null ? null : digest(chunk),
    chunk,
    instruction,
    delivery: 'unconfirmed',
  });
  const points = Array.from(payload),
    chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    if (chunks.length >= LIFECYCLE_CONTEXT_SLOTS) fail();
    let low = 0,
      high = Math.min(points.length - offset, LIFECYCLE_CONTEXT_CHARACTERS);
    // Reserve the largest count representation before splitting; boundaries never split a surrogate pair.
    while (low < high) {
      const mid = Math.ceil((low + high) / 2),
        text = points.slice(offset, offset + mid).join('');
      if (JSON.stringify(frame(chunks.length, LIFECYCLE_CONTEXT_SLOTS, text)).length <= LIFECYCLE_CONTEXT_CHARACTERS)
        low = mid;
      else high = mid - 1;
    }
    if (!low) fail();
    chunks.push(points.slice(offset, offset + low).join(''));
    offset += low;
  }
  const outputs = Array.from({ length: LIFECYCLE_CONTEXT_SLOTS }, (_, slot) => ({
    hookSpecificOutput: {
      hookEventName: info.hookEventName,
      additionalContext: JSON.stringify(frame(slot, chunks.length, chunks[slot] ?? null)),
    },
  }));
  return frozen({ outputs, serialized: outputs.map((output) => JSON.stringify(output)).join('') });
}
/** Verifies an observed complete set, not host acknowledgement or all-or-nothing host enforcement. */
export function assembleLifecycleContextSegments(input: readonly string[]): {
  readonly payload: string;
  readonly id: string;
  readonly delivery: 'unconfirmed';
} {
  if (!Array.isArray(input) || input.length !== LIFECYCLE_CONTEXT_SLOTS) fail();
  const rows = input.map((text) => object(decodeJson(bounded(text, LIFECYCLE_CONTEXT_CHARACTERS))));
  const slots = new Set<number>();
  let payload = '';
  for (const row of rows) {
    const slot = row['slot'];
    if (
      !Number.isSafeInteger(slot) ||
      (slot as number) < 0 ||
      (slot as number) >= LIFECYCLE_CONTEXT_SLOTS ||
      slots.has(slot as number)
    )
      fail();
    slots.add(slot as number);
  }
  rows.sort((a, b) => (a['slot'] as number) - (b['slot'] as number));
  for (const row of rows) {
    if (row['chunk'] !== null) payload += bounded(row['chunk'], LIFECYCLE_CONTEXT_CHARACTERS);
  }
  const expected = fragmentLifecycleContext(payload),
    info = payloadInfo(payload);
  for (let slot = 0; slot < LIFECYCLE_CONTEXT_SLOTS; slot++)
    if (
      stableSerialize(rows[slot]) !==
      stableSerialize(decodeJson(expected.outputs[slot]!.hookSpecificOutput.additionalContext))
    )
      fail();
  return frozen({ payload, id: info.id, delivery: 'unconfirmed' });
}
