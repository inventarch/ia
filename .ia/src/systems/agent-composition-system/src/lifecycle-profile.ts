import { stableSerialize } from '@inventarch/graph';
import { decodeJson, frozen, metadataDigest } from './resource-format.js';
import { claudeCodeRows, profileFromRows } from './lifecycle-rows.js';

export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}
export interface LifecycleProfile {
  readonly format: 'ia.lifecycle-profile.v1';
  readonly host: string;
  readonly version: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly events: readonly string[];
  readonly maxContextCharacters: number | null;
  readonly maxContextParts: number;
  readonly maxInputBytes: number;
  readonly maxPromptBytes: number;
  readonly digest: string;
  /** The row's closed UserPromptSubmit fields, digested with the body; absent on unavailable profiles and the two unfolded rows. */
  readonly promptFields?: readonly string[];
}
export interface LifecycleEvent {
  readonly format: 'ia.lifecycle-event.v1';
  readonly profile: string;
  readonly host: string;
  readonly kind: 'start' | 'prompt' | 'native';
  readonly source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | null;
  readonly session: string;
  readonly agent: string | null;
  readonly cwd: string;
  readonly promptId: string | null;
  readonly prompt: string | null;
  /** Retriable host event identity, if the host supplies one. Never a delivery acknowledgement. */
  readonly key: string | null;
  readonly inputDigest: string;
  readonly delivery: 'unconfirmed';
}
function fail(message: string): never {
  throw new LifecycleError('IA-LIFECYCLE-INPUT', message);
}
function string(value: unknown, max = 4096, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value) ||
    Buffer.byteLength(value) > max ||
    Buffer.from(value).toString('utf8') !== value ||
    /\u0000/.test(value)
  )
    fail('Invalid or oversized lifecycle text');
  return value;
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    fail('Expected lifecycle object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    fail('Unknown or non-data lifecycle field');
  return value as Record<string, unknown>;
}
/** H3-v1 (`@decision parallel-g-h3`): the exact Claude Code row new context registrations select. */
export const SELECTED_CLAUDE_CODE_VERSION = '2.1.285';
/** A compatibility declaration, not an observation that a host enabled or delivered hooks. */
export function lifecycleProfile(host: string, version: string): LifecycleProfile {
  string(host, 64);
  string(version, 64);
  return profileFromRows(claudeCodeRows, host, version);
}
export function verifyLifecycleProfile(input: LifecycleProfile): LifecycleProfile {
  const expected = lifecycleProfile(input.host, input.version);
  if (stableSerialize(input) !== stableSerialize(expected))
    fail('Lifecycle profile differs from its installed definition');
  if (!expected.available) throw new LifecycleError('IA-LIFECYCLE-UNAVAILABLE', expected.reason!);
  return expected;
}
/** The host and version of one available segmented row. */
export interface SegmentedLifecycleRow {
  readonly host: string;
  readonly version: string;
}
/** Each available segmented Claude Code row, keyed by its profile digest, computed once when the module loads. */
const segmentedRows: ReadonlyMap<string, SegmentedLifecycleRow> = new Map(
  [...claudeCodeRows.keys()].map((version) => [
    lifecycleProfile('claude-code', version).digest,
    frozen({ host: 'claude-code', version }),
  ]),
);
/** The available segmented row this exact digest names, or null; no version range is inferred. */
export function segmentedLifecycleRow(digest: unknown): SegmentedLifecycleRow | null {
  return typeof digest === 'string' ? (segmentedRows.get(digest) ?? null) : null;
}
/** True only for the digest of an available segmented Claude Code row; no version range is inferred. */
export function isSegmentedLifecycleProfile(digest: unknown): boolean {
  return segmentedLifecycleRow(digest) !== null;
}
/** Decode bounded host metadata only. No transcript, path, module or credential is opened. */
export function decodeLifecycleEvent(inputProfile: LifecycleProfile, input: string): LifecycleEvent {
  const profile = verifyLifecycleProfile(inputProfile);
  if (profile.host === 'ia-native') fail('Native context requires the trusted native event factory');
  if (
    typeof input !== 'string' ||
    Buffer.byteLength(input) > profile.maxInputBytes ||
    Buffer.from(input).toString('utf8') !== input
  )
    fail('Lifecycle input exceeds its byte bound or is invalid UTF-8');
  let decoded: unknown;
  try {
    decoded = decodeJson(input);
  } catch {
    fail('Lifecycle input is not bounded unambiguous JSON');
  }
  const common = [
    'session_id',
    'prompt_id',
    'transcript_path',
    'cwd',
    'scratchpad_dir',
    'permission_mode',
    'effort',
    'hook_event_name',
    'agent_id',
    'agent_type',
  ];
  const row = object(decoded, [
    ...common,
    'source',
    'model',
    'session_title',
    'seconds_since_last_response',
    'context_tokens',
    'prompt_cache_likely_expired',
    'estimated_cache_write_usd',
    'prompt',
  ]);
  const event = string(row['hook_event_name'], 64);
  if (!profile.events.includes(event)) fail('Unsupported lifecycle event');
  const promptFields = profile.host === 'claude-code' ? claudeCodeRows.get(profile.version) : undefined;
  if (!promptFields) fail('Unsupported lifecycle event');
  const start = event === 'SessionStart',
    eventFields = start
      ? [
          'source',
          'model',
          'session_title',
          'seconds_since_last_response',
          'context_tokens',
          'prompt_cache_likely_expired',
          'estimated_cache_write_usd',
        ]
      : promptFields;
  object(row, [...common, ...eventFields]);
  const session = string(row['session_id'], 256),
    cwd = string(row['cwd']),
    agent = row['agent_id'] === undefined ? null : string(row['agent_id'], 256),
    promptId = row['prompt_id'] === undefined ? null : string(row['prompt_id'], 256);
  for (const key of ['transcript_path', 'scratchpad_dir', 'agent_type', 'model', 'session_title'])
    if (row[key] !== undefined) string(row[key]);
  if (
    row['permission_mode'] !== undefined &&
    !['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].includes(
      string(row['permission_mode'], 32),
    )
  )
    fail('Unknown permission mode metadata');
  if (row['effort'] !== undefined) {
    const effort = object(row['effort'], ['level']);
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(string(effort['level'], 16)))
      fail('Unknown effort metadata');
  }
  for (const key of ['seconds_since_last_response', 'context_tokens', 'estimated_cache_write_usd'])
    if (
      row[key] !== undefined &&
      (typeof row[key] !== 'number' ||
        !Number.isFinite(row[key]) ||
        row[key] < 0 ||
        (key === 'context_tokens' && !Number.isSafeInteger(row[key])))
    )
      fail('Invalid cost metadata');
  if (row['prompt_cache_likely_expired'] !== undefined && typeof row['prompt_cache_likely_expired'] !== 'boolean')
    fail('Invalid cache metadata');
  const source = start ? string(row['source'], 16) : null;
  if (source !== null && !['startup', 'resume', 'clear', 'compact', 'fork'].includes(source))
    fail('Unsupported SessionStart source');
  const prompt = start ? null : string(row['prompt'], profile.maxPromptBytes, true);
  const key =
    !start && promptId !== null
      ? metadataDigest({
          format: 'ia.lifecycle-input-key.v1',
          profile: profile.digest,
          session,
          agent,
          promptId,
          event,
        })
      : null;
  return frozen({
    format: 'ia.lifecycle-event.v1',
    profile: profile.digest,
    host: profile.host,
    kind: start ? 'start' : 'prompt',
    source: source as LifecycleEvent['source'],
    session,
    agent,
    cwd,
    promptId,
    prompt,
    key,
    inputDigest: metadataDigest(row),
    delivery: 'unconfirmed',
  });
}

/** Authenticated native hosts supply their own retained session/profile/attempt, never a coding-host transcript. */
export function createNativeLifecycleEvent(input: {
  readonly session: string;
  readonly profile: string;
  readonly invocation: string | null;
  readonly text: string;
}): LifecycleEvent {
  const row = object(input, ['session', 'profile', 'invocation', 'text']),
    profile = lifecycleProfile('ia-native', '1');
  const session = string(row['session'], 256),
    agent = string(row['profile'], 256),
    prompt = string(row['text'], profile.maxPromptBytes, true);
  const promptId = row['invocation'] === null ? null : string(row['invocation'], 256);
  const key =
    promptId === null
      ? null
      : metadataDigest({
          format: 'ia.lifecycle-input-key.v1',
          profile: profile.digest,
          session,
          agent,
          promptId,
          event: 'NativeContext',
        });
  return frozen({
    format: 'ia.lifecycle-event.v1',
    profile: profile.digest,
    host: profile.host,
    kind: 'native',
    source: null,
    session,
    agent,
    cwd: '',
    promptId,
    prompt,
    key,
    inputDigest: metadataDigest({ session, agent, promptId, prompt }),
    delivery: 'unconfirmed',
  });
}
