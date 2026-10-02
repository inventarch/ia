import type { ReadHandle } from '@ia/db';
import { stableSerialize } from '@ia/graph';
import type { Edge } from '@ia/graph';
import { context, DEFAULT_TOKENIZER, prepareCoordinate } from '@ia/runtime';
import type { Packet, Tokenizer } from '@ia/runtime';
import { frozen, metadataDigest } from './resource-format.js';
import { LifecycleError, verifyLifecycleProfile } from './lifecycle-profile.js';
import type { LifecycleEvent, LifecycleProfile } from './lifecycle-profile.js';
import { fragmentLifecycleContext } from './lifecycle-transport.js';
import type { LifecycleSegmentOutput } from './lifecycle-transport.js';
export { assembleLifecycleContextSegments, LIFECYCLE_CONTEXT_SLOTS } from './lifecycle-transport.js';

export interface LifecyclePins {
  readonly binding: string;
  readonly source: string;
  readonly view: string;
  readonly resources: string;
  readonly installation: string | null;
  readonly profile: string;
  readonly policy: string;
  readonly implementation: string;
}
export interface ContextPart {
  readonly id: string;
  readonly text: string;
  readonly citations: readonly string[];
}
export interface RequiredContextParts {
  readonly pins: LifecyclePins;
  readonly parts: readonly ContextPart[];
  readonly missing: readonly { readonly id: string; readonly reason: string }[];
  readonly proof: string;
}
export interface RequiredPartsInput {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly pins: LifecyclePins;
  readonly coordinate: Readonly<Record<string, string>>;
}
export type RequiredParts = (input: RequiredPartsInput) => RequiredContextParts;
export interface LifecycleBudgets {
  readonly tokens: number;
  readonly records: number;
  readonly bytes: number;
  readonly timeoutMs: number;
}
export interface ScopedContextRequest {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly pins: LifecyclePins;
  readonly profile: LifecycleProfile;
  readonly event: LifecycleEvent;
  readonly coordinate: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly budgets: LifecycleBudgets;
  readonly requiredParts: RequiredParts;
  readonly tokenizer?: Tokenizer;
  /** Reserve mandatory authoring and native blocking material without optional retrieval. */
  readonly optional?: 'include' | 'omit';
}
export type LifecycleOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: 'SessionStart' | 'UserPromptSubmit';
        readonly additionalContext: string;
      };
    }
  | { readonly format: 'ia.native-context.v1'; readonly additionalContext: string };
export interface PreparedContext {
  readonly format: 'ia.prepared-lifecycle-context.v1';
  readonly id: string;
  readonly pins: LifecyclePins;
  readonly payload: string;
  readonly output: LifecycleOutput;
  readonly delivery: 'unconfirmed';
  readonly usage: {
    readonly bytes: number;
    readonly tokens: number;
    readonly records: number;
    readonly estimator: string;
  };
}
export interface PreparedContextSegments extends Omit<PreparedContext, 'format' | 'output'> {
  readonly format: 'ia.prepared-lifecycle-context-segments.v1';
  readonly outputs: readonly LifecycleSegmentOutput[];
}
export interface LifecycleView {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly pins: LifecyclePins;
  readonly requiredParts: RequiredParts;
  close(): void;
}
export interface LifecycleBinding {
  readonly profile: LifecycleProfile;
  readonly coordinate: Readonly<Record<string, unknown>>;
  readonly bootstrap: string;
  readonly budgets: LifecycleBudgets;
  readonly binding: string;
  readonly policy: string;
  readonly implementation: string;
}
export interface LifecycleHost {
  openCurrentView(binding: LifecycleBinding, event: LifecycleEvent, signal: AbortSignal): Promise<LifecycleView>;
  assertCurrent(view: LifecycleView, binding: LifecycleBinding, signal: AbortSignal): void | Promise<void>;
  /** Optional explicitly retained stream admission. It must compare content on replay and never assert stdout delivery. */
  acceptInput?(identity: LifecycleInputIdentity, signal: AbortSignal): void | Promise<void>;
  readonly now?: () => number;
}
export interface LifecycleInputIdentity {
  readonly binding: string;
  readonly key: string | null;
  readonly inputDigest: string;
}
const pinKeys = [
  'binding',
  'source',
  'view',
  'resources',
  'installation',
  'profile',
  'policy',
  'implementation',
] as const;
function fail(code: string, message: string): never {
  throw new LifecycleError(`IA-LIFECYCLE-${code}`, message);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INPUT', 'Invalid lifecycle digest');
  return value;
}
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    fail('INPUT', 'Expected lifecycle data');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    fields = Reflect.ownKeys(value);
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
    fail('INPUT', 'Lifecycle fields are unknown, missing or non-data');
  return value as Record<string, unknown>;
}
function checkedPins(value: LifecyclePins): LifecyclePins {
  const row = plain(value, pinKeys);
  for (const key of pinKeys) if (key !== 'installation' || row[key] !== null) hash(row[key]);
  return frozen({ ...value });
}
function checkedBudgets(value: LifecycleBudgets): LifecycleBudgets {
  plain(value, ['tokens', 'records', 'bytes', 'timeoutMs']);
  for (const [name, maximum] of [
    ['tokens', 256 * 1024],
    ['records', 256],
    ['bytes', 1024 * 1024],
    ['timeoutMs', 60_000],
  ] as const) {
    const number = value[name];
    if (!Number.isSafeInteger(number) || number < (name === 'timeoutMs' ? 1 : 0) || number > maximum)
      fail('BUDGET', 'Lifecycle budget is outside its finite bound');
  }
  return frozen({ ...value });
}
function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value)
    fail('INPUT', 'Invalid or unbounded lifecycle text');
  return value;
}
function snapshotEvent(profile: LifecycleProfile, input: LifecycleEvent): LifecycleEvent {
  plain(input, [
    'format',
    'profile',
    'host',
    'kind',
    'source',
    'session',
    'agent',
    'cwd',
    'promptId',
    'prompt',
    'key',
    'inputDigest',
    'delivery',
  ]);
  if (
    input.format !== 'ia.lifecycle-event.v1' ||
    input.profile !== profile.digest ||
    input.host !== profile.host ||
    input.delivery !== 'unconfirmed' ||
    !(profile.host === 'ia-native' ? ['native'] : ['prompt', 'start']).includes(input.kind)
  )
    fail('INPUT', 'Lifecycle event/profile differs');
  boundedText(input.session, 256);
  boundedText(input.cwd, 4096);
  hash(input.inputDigest);
  if (!input.session || (input.kind === 'native' ? input.cwd !== '' : !input.cwd))
    fail('INPUT', 'Lifecycle event has no session or differs from its cwd profile');
  if (input.agent !== null) boundedText(input.agent, 256);
  if (input.promptId !== null) boundedText(input.promptId, 256);
  if (input.kind === 'start') {
    if (
      input.prompt !== null ||
      input.key !== null ||
      !['startup', 'resume', 'clear', 'compact', 'fork'].includes(input.source!)
    )
      fail('INPUT', 'Lifecycle bootstrap differs');
  } else {
    boundedText(input.prompt, profile.maxPromptBytes);
    if (input.source !== null) fail('INPUT', 'Prompt has a bootstrap source');
    const key =
      input.promptId === null
        ? null
        : metadataDigest({
            format: 'ia.lifecycle-input-key.v1',
            profile: profile.digest,
            session: input.session,
            agent: input.agent,
            promptId: input.promptId,
            event: input.kind === 'native' ? 'NativeContext' : 'UserPromptSubmit',
          });
    if (input.key !== key) fail('INPUT', 'Lifecycle event identity differs');
  }
  return frozen({ ...input });
}
function parts(value: RequiredContextParts, pins: LifecyclePins): RequiredContextParts {
  plain(value, ['pins', 'parts', 'missing', 'proof']);
  if (stableSerialize(checkedPins(value.pins)) !== stableSerialize(pins)) fail('STALE', 'Required context pins differ');
  hash(value.proof);
  if (
    !Array.isArray(value.missing) ||
    value.missing.length > 128 ||
    !Array.isArray(value.parts) ||
    value.parts.length > 128
  )
    fail('INPUT', 'Required context collection exceeds its bound');
  if (value.missing.length) fail('REQUIRED', 'Required authoring context is unavailable');
  let bytes = 0;
  const ids = new Set<string>();
  const selected = value.parts.map((part) => {
    plain(part, ['id', 'text', 'citations']);
    const id = boundedText(part.id, 1024),
      text = boundedText(part.text, 1024 * 1024);
    if (!id || ids.has(id) || !Array.isArray(part.citations) || part.citations.length > 128)
      fail('INPUT', 'Required context identity/citations differ');
    ids.add(id);
    const citations = part.citations.map((citation: unknown) => boundedText(citation, 4096));
    bytes += Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(citations));
    if (bytes > 1024 * 1024) fail('BUDGET', 'Required context exceeds its byte bound');
    return { id, text, citations };
  });
  return frozen({ pins, parts: selected, missing: [], proof: value.proof });
}
function packetBody(packet: Packet) {
  const edge = (value: Edge) => ({
    from: value.from,
    predicate: value.predicate,
    to: value.to,
    author: value.author,
    ...(value.fragment === undefined ? {} : { fragment: value.fragment, fragmentEndpoint: value.fragmentEndpoint }),
    ...(value.condition === undefined ? {} : { condition: value.condition, conditionSubject: value.conditionSubject }),
    ...(value.from === null || value.to === null ? { reference: value.reference } : {}),
    citations: [
      ...new Map(
        [value.source, ...value.assertions.map((item) => item.source)].map((source) => [
          JSON.stringify(source),
          source,
        ]),
      ).values(),
    ],
  });
  return {
    revision: packet.revision,
    coordinate: { values: packet.coordinate.values, sources: packet.coordinate.sources },
    included: packet.included.map((entry) => ({
      address: entry.address,
      identity: entry.identity,
      kind: entry.kind,
      text: entry.text,
      citations: entry.citations,
      ...(entry.clauses?.some((clause) => clause.condition !== undefined)
        ? {
            conditions: entry.clauses
              .filter((clause) => clause.condition !== undefined)
              .map((clause) => ({ key: clause.key, when: clause.condition, citation: clause.citation })),
          }
        : {}),
      ...(entry.condition === undefined ? {} : { condition: entry.condition }),
      ...(entry.severity === undefined ? {} : { severity: entry.severity }),
    })),
    omitted: (['budget', 'disqualified', 'unresolved'] as const)
      .map((reason) => ({ reason, count: packet.omitted.filter((row) => row.reason === reason).length }))
      .filter((row) => row.count > 0),
    followed: packet.followed.map(edge),
    gated: packet.gated.map(edge),
    dangling: packet.dangling.map(edge),
  };
}
/** Pure selection over the caller-owned admitted view; never discovers resources or paths. */
export function prepareScopedContext(input: ScopedContextRequest): PreparedContext {
  return selectScopedContext(input, false) as PreparedContext;
}
export function prepareScopedContextSegments(input: ScopedContextRequest): PreparedContextSegments {
  return selectScopedContext(input, true) as PreparedContextSegments;
}
function selectScopedContext(
  input: ScopedContextRequest,
  segmented: boolean,
): PreparedContext | PreparedContextSegments {
  if (input.optional !== undefined && input.optional !== 'include' && input.optional !== 'omit')
    fail('INPUT', 'Unknown optional context selection');
  const profile = verifyLifecycleProfile(input.profile),
    event = snapshotEvent(profile, input.event),
    pins = checkedPins(input.pins),
    budgets = checkedBudgets(input.budgets);
  if (segmented && profile.host !== 'claude-code') fail('INPUT', 'Native context is not segmented');
  const text = boundedText(input.text, profile.maxPromptBytes),
    within = boundedText(input.within, 4096);
  if (event.prompt !== null && event.prompt !== text)
    fail('INPUT', 'Lifecycle selection text differs from its event input');
  if (!within || pins.profile !== profile.digest || input.reader.snapshot({ within }).revision !== pins.view)
    fail('STALE', 'Lifecycle view/profile pins differ');
  const declared = Object.freeze({ ...input.coordinate }),
    coordinate = prepareCoordinate(text, declared);
  if (!coordinate.values.phase || !coordinate.values.primitive)
    fail('COORDINATE', 'Lifecycle context requires explicit phase and primitive coordinates');
  const required = parts(
    input.requiredParts({
      reader: input.reader,
      within,
      pins,
      coordinate: coordinate.values as Readonly<Record<string, string>>,
    }),
    pins,
  );
  const tokenizer = input.tokenizer ?? DEFAULT_TOKENIZER;
  boundedText(tokenizer.name, 128);
  const count = (text: string): number => {
    const result = tokenizer.count(text);
    if (!Number.isSafeInteger(result) || result < 0 || (text.length > 0 && result === 0))
      fail('BUDGET', 'Lifecycle tokenizer returned an invalid count');
    return result;
  };
  const requiredRecords = required.parts.length;
  if (requiredRecords > budgets.records) fail('BUDGET', 'Required context exceeds record budget');
  let tokenBudget = input.optional === 'omit' ? 0 : budgets.tokens,
    minimumTried = false;
  // Each pass asks the runtime to trim optional material. Blocking overflow is always final.
  for (let pass = 0; pass < 32; pass++) {
    const selected = context(
      input.reader,
      { within, revision: pins.view, coordinate: declared, text },
      { tokens: tokenBudget, records: budgets.records - requiredRecords },
      { tokenizer },
    );
    if (!selected.ok) {
      if (
        !minimumTried &&
        selected.code === 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW' &&
        selected.required &&
        selected.required.tokens <= budgets.tokens &&
        selected.required.records <= budgets.records - requiredRecords
      ) {
        tokenBudget = selected.required.tokens;
        minimumTried = true;
        continue;
      }
      fail('CONTEXT', `Lifecycle context unavailable: ${selected.code}`);
    }
    const body = {
      format: 'ia.lifecycle-context.v1',
      pins,
      event: { kind: event.kind, source: event.source, key: event.key, inputDigest: event.inputDigest },
      required: { proof: required.proof, parts: required.parts },
      context: packetBody(selected.packet),
      budgets: { tokens: budgets.tokens, records: budgets.records, bytes: budgets.bytes, estimator: tokenizer.name },
      delivery: 'unconfirmed',
    };
    const id = metadataDigest(body),
      payload = JSON.stringify({ ...body, id });
    const output: LifecycleOutput =
      event.kind === 'native'
        ? { format: 'ia.native-context.v1', additionalContext: payload }
        : {
            hookSpecificOutput: {
              hookEventName: event.kind === 'start' ? 'SessionStart' : 'UserPromptSubmit',
              additionalContext: payload,
            },
          };
    let fragments: ReturnType<typeof fragmentLifecycleContext> | undefined;
    if (segmented) {
      try {
        fragments = fragmentLifecycleContext(payload);
      } catch (error) {
        if (!(error instanceof LifecycleError) || error.code !== 'IA-LIFECYCLE-BUDGET') throw error;
      }
    }
    const serialized = fragments?.serialized ?? JSON.stringify(output),
      bytes = Buffer.byteLength(serialized),
      tokens = count(serialized);
    const fits = segmented
      ? fragments !== undefined
      : profile.maxContextCharacters === null || payload.length <= profile.maxContextCharacters;
    if (fits && bytes <= budgets.bytes && tokens <= budgets.tokens) {
      if (input.reader.snapshot({ within }).revision !== pins.view)
        fail('STALE', 'Lifecycle view changed during selection');
      const common = {
        id,
        pins,
        payload,
        delivery: 'unconfirmed' as const,
        usage: {
          bytes,
          tokens,
          records: selected.packet.limits.recordsUsed + requiredRecords,
          estimator: tokenizer.name,
        },
      };
      return fragments
        ? frozen({ format: 'ia.prepared-lifecycle-context-segments.v1', ...common, outputs: fragments.outputs })
        : frozen({ format: 'ia.prepared-lifecycle-context.v1', ...common, output });
    }
    if (tokenBudget === 0) break;
    const deficit = Math.max(
      fits ? 1 : Math.ceil(tokenBudget / 4),
      tokens - budgets.tokens,
      Math.ceil((bytes - budgets.bytes) / 4),
    );
    tokenBudget = Math.max(0, Math.min(tokenBudget - deficit, selected.packet.limits.tokensUsed - 1));
  }
  fail('BUDGET', 'Required context and complete host wrapper exceed the delivery budget');
}
/** The returned JSON is generated/unconfirmed. A stdout write is not host acknowledgement. */
export function serializeLifecycleContext(prepared: PreparedContext): LifecycleOutput {
  return prepared.output;
}

/** Namespace the host event under the trusted registration; transcript paths supply no store identity. */
export function lifecycleInputIdentity(binding: string, event: LifecycleEvent): LifecycleInputIdentity {
  hash(binding);
  hash(event.inputDigest);
  if (event.key !== null) hash(event.key);
  return frozen({
    binding,
    key: event.key === null ? null : metadataDigest({ format: 'ia.bound-lifecycle-input.v1', binding, key: event.key }),
    inputDigest: event.inputDigest,
  });
}

function abort(signal: AbortSignal): void {
  if (signal.aborted)
    fail(
      'CANCELLED',
      signal.reason instanceof LifecycleError ? signal.reason.message : 'Lifecycle context was cancelled',
    );
}
async function bounded<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  abort(signal);
  let listener!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () =>
      reject(
        signal.reason instanceof LifecycleError
          ? signal.reason
          : new LifecycleError('IA-LIFECYCLE-CANCELLED', 'Lifecycle context was cancelled'),
      );
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        abort(signal);
        return work();
      }),
      cancelled,
    ]);
    abort(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
/** Opens every bootstrap/prompt afresh; the host decides whether that view is live or retained. */
export async function prepareLifecycleContext(
  input: LifecycleBinding,
  inputEvent: LifecycleEvent,
  host: LifecycleHost,
  caller?: AbortSignal,
): Promise<PreparedContext> {
  return prepareLifecycle(input, inputEvent, host, false, caller) as Promise<PreparedContext>;
}
export async function prepareLifecycleContextSegments(
  input: LifecycleBinding,
  inputEvent: LifecycleEvent,
  host: LifecycleHost,
  caller?: AbortSignal,
): Promise<PreparedContextSegments> {
  return prepareLifecycle(input, inputEvent, host, true, caller) as Promise<PreparedContextSegments>;
}
async function prepareLifecycle(
  input: LifecycleBinding,
  inputEvent: LifecycleEvent,
  host: LifecycleHost,
  segmented: boolean,
  caller?: AbortSignal,
): Promise<PreparedContext | PreparedContextSegments> {
  const profile = verifyLifecycleProfile(input.profile),
    event = snapshotEvent(profile, inputEvent),
    budgets = checkedBudgets(input.budgets);
  const coordinate = frozen({ ...input.coordinate });
  prepareCoordinate('', coordinate);
  const binding: LifecycleBinding = frozen({
    profile,
    coordinate,
    budgets,
    bootstrap: boundedText(input.bootstrap, profile.maxPromptBytes),
    binding: hash(input.binding),
    policy: hash(input.policy),
    implementation: hash(input.implementation),
  });
  const open = host.openCurrentView.bind(host),
    current = host.assertCurrent.bind(host),
    accept = host.acceptInput?.bind(host);
  const controller = new AbortController(),
    signal = controller.signal,
    now = host.now ?? Date.now,
    deadline = now() + budgets.timeoutMs;
  const cancel = () =>
    controller.abort(new LifecycleError('IA-LIFECYCLE-CANCELLED', 'Lifecycle context was cancelled'));
  if (caller?.aborted) cancel();
  else caller?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new LifecycleError('IA-LIFECYCLE-DEADLINE', 'Lifecycle context deadline exceeded')),
    budgets.timeoutMs,
  );
  let view: LifecycleView | undefined,
    dispose: (() => void) | undefined,
    admitted = false;
  try {
    view = await bounded(async () => {
      const result = await open(binding, event, signal);
      if (signal.aborted) {
        result.close();
        abort(signal);
      }
      view = result;
      dispose = result.close.bind(result);
      return result;
    }, signal);
    const pins = checkedPins(view.pins);
    const reader = view.reader,
      within = view.within,
      requiredParts = view.requiredParts;
    const unchanged = (): void => {
      if (
        view!.reader !== reader ||
        view!.within !== within ||
        view!.requiredParts !== requiredParts ||
        stableSerialize(view!.pins) !== stableSerialize(pins)
      )
        fail('STALE', 'Lifecycle view binding changed during a host callback');
    };
    if (
      pins.binding !== binding.binding ||
      pins.policy !== binding.policy ||
      pins.implementation !== binding.implementation ||
      pins.profile !== profile.digest
    )
      fail('STALE', 'Current lifecycle binding pins differ');
    await bounded(() => current(view!, binding, signal), signal);
    unchanged();
    if (event.key !== null && accept)
      await bounded(() => accept(lifecycleInputIdentity(binding.binding, event), signal), signal);
    unchanged();
    const prepared = selectScopedContext(
      {
        reader,
        within,
        pins,
        profile,
        event,
        coordinate,
        text: event.prompt ?? binding.bootstrap,
        budgets,
        requiredParts,
      },
      segmented,
    );
    if (now() >= deadline) fail('DEADLINE', 'Lifecycle context deadline exceeded');
    await bounded(() => current(view!, binding, signal), signal);
    unchanged();
    abort(signal);
    if (now() >= deadline) fail('DEADLINE', 'Lifecycle context deadline exceeded');
    admitted = true;
    return prepared;
  } finally {
    if (!admitted && !signal.aborted) controller.abort();
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    dispose?.();
  }
}
