import { createHash } from 'node:crypto';
import { stableSerialize } from '@ia/graph';

export const AUTHORING_PROTOCOL = 1 as const;
export const AUTHORING_LIMITS = Object.freeze({
  contextFiles: 20,
  contextBytes: 512 * 1024,
  outputFiles: 10,
  outputFileBytes: 256 * 1024,
  outputBytes: 1024 * 1024,
});
export interface ContextFile {
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly citations: readonly string[];
}
export interface AuthoringRequestV1 {
  readonly protocol: 1;
  readonly idempotencyKey: string;
  readonly languageVersion: '1.0';
  readonly intent: string;
  readonly target: { readonly system: string; readonly discriminator: string; readonly paths: readonly string[] };
  readonly expectedSteward: string;
  readonly base: { readonly viewRevision: string; readonly manifestDigest: string };
  readonly context: readonly ContextFile[];
}
export interface AuthoringProposalV1 {
  readonly protocol: 1;
  readonly runId: string;
  readonly requestDigest: string;
  readonly agent: { readonly id: string; readonly version: string; readonly steward: string };
  readonly files: readonly {
    readonly path: string;
    readonly operation: 'create';
    readonly content: string;
    readonly digest: string;
  }[];
  readonly summary: string;
  readonly citations: readonly {
    readonly path: string;
    readonly digest: string;
    readonly line: number;
    readonly endLine: number;
  }[];
}
export type RunState = 'queued' | 'running' | 'cancel-requested' | 'completed' | 'cancelled' | 'failed';
export interface RunReceipt {
  readonly runId: string;
  readonly requestDigest: string;
  readonly state: RunState;
  readonly cursor: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly state: 'reported' | 'unknown';
  };
  readonly error?: string;
}
export interface AuthoringEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly type: 'status' | 'usage' | 'completed' | 'cancelled' | 'failed';
  readonly state: RunState;
  readonly message: string;
  readonly at: string;
}
export interface Capabilities {
  readonly protocol: 1;
  readonly languageVersions: readonly string[];
  readonly account: { readonly id: string; readonly label: string };
  readonly entitlement: 'enabled' | 'disabled';
  readonly authoringAvailable: boolean;
  readonly agent: { readonly id: string; readonly version: string };
  readonly limits: typeof AUTHORING_LIMITS;
  readonly retentionDays: number;
  readonly chatAvailable?: boolean;
}
export const CHAT_LIMITS = Object.freeze({
  turns: 20,
  messageBytes: 8192,
  replyBytes: 16384,
  historyBytes: 512 * 1024,
});
export interface ChatTurnRequest {
  readonly protocol: 1;
  readonly kind: 'chat';
  readonly languageVersion: '1.0';
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly parentRunId: string | null;
  readonly message: string;
  readonly base: AuthoringRequestV1['base'];
  readonly context: readonly ContextFile[];
}
export interface ChatReply {
  readonly protocol: 1;
  readonly conversationId: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly agent: Capabilities['agent'];
  readonly message: string;
  readonly proposal: { readonly request: AuthoringRequestV1; readonly proposal: AuthoringProposalV1 } | null;
}
export interface ChatConversation {
  readonly protocol: 1;
  readonly id: string;
  readonly expiresAt: string;
  readonly turns: readonly {
    readonly receipt: RunReceipt;
    readonly parentRunId: string | null;
    readonly userMessage: string;
    readonly assistantMessage: string | null;
    readonly hasProposal: boolean;
  }[];
}
export class AuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthoringError';
  }
}
export const digestText = (text: string): string => createHash('sha256').update(text).digest('hex');
export const digestValue = (value: unknown): string => digestText(stableSerialize(value));
export const manifestDigest = (context: readonly ContextFile[]): string =>
  digestValue(context.map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path.localeCompare(b.path)));
export function sourcePath(path: string): boolean {
  return (
    path.startsWith('.ia/src/') &&
    path.endsWith('.ia') &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[\\\u0000-\u001f<>:"|?*]|[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  );
}
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AuthoringError('invalid-schema', 'Expected an object');
  const result = value as Record<string, unknown>;
  if (keys !== undefined && Object.keys(result).some((k) => !keys.includes(k)))
    throw new AuthoringError('invalid-schema', 'Unexpected object field');
  return result;
}
function text(value: unknown, max = 8192): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > max ||
    Buffer.from(value).toString('utf8') !== value
  )
    throw new AuthoringError('invalid-schema', 'Invalid text field');
  return value;
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new AuthoringError('invalid-schema', 'Invalid or oversized array');
  return value;
}
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new AuthoringError('invalid-digest', 'Expected SHA-256 hex digest');
  return result;
}
function word(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new AuthoringError('invalid-schema', 'Expected a canonical IA word');
  return result;
}
function path(value: unknown): string {
  const result = text(value, 500);
  if (!sourcePath(result)) throw new AuthoringError('unsafe-path', 'Expected a canonical IA source path');
  return result;
}
function uniquePaths(paths: readonly string[]): void {
  if (new Set(paths.map((p) => p.toLowerCase())).size !== paths.length)
    throw new AuthoringError('aliased-path', 'Duplicate or case-aliased paths are refused');
}
function disclosure(baseValue: unknown, contextValue: unknown): Pick<AuthoringRequestV1, 'base' | 'context'> {
  const base = object(baseValue, ['viewRevision', 'manifestDigest']);
  const context = array(contextValue, AUTHORING_LIMITS.contextFiles).map((entry): ContextFile => {
    const item = object(entry, ['path', 'digest', 'text', 'citations']),
      content = text(item['text'], AUTHORING_LIMITS.contextBytes),
      digest = sha(item['digest']);
    if (digestText(content) !== digest)
      throw new AuthoringError('digest-mismatch', 'Context bytes do not match the disclosure digest');
    return {
      path: path(item['path']),
      digest,
      text: content,
      citations: array(item['citations'], 100).map((c) => text(c, 500)),
    };
  });
  uniquePaths(context.map((f) => f.path));
  if (context.reduce((n, f) => n + Buffer.byteLength(f.text), 0) > AUTHORING_LIMITS.contextBytes)
    throw new AuthoringError('context-too-large', 'Disclosed context exceeds 512 KiB');
  const manifest = sha(base['manifestDigest']);
  if (manifestDigest(context) !== manifest)
    throw new AuthoringError('digest-mismatch', 'Context manifest does not match disclosed files');
  return { base: { viewRevision: sha(base['viewRevision']), manifestDigest: manifest }, context };
}
export function parseAuthoringRequest(value: unknown): AuthoringRequestV1 {
  const input = object(value, [
    'protocol',
    'idempotencyKey',
    'languageVersion',
    'intent',
    'target',
    'expectedSteward',
    'base',
    'context',
  ]);
  if (input['protocol'] !== 1 || input['languageVersion'] !== '1.0')
    throw new AuthoringError('unsupported-protocol', 'Expected authoring protocol 1 and IA 1.0');
  const target = object(input['target'], ['system', 'discriminator', 'paths']);
  const system = word(target['system']),
    discriminator = word(target['discriminator']),
    paths = array(target['paths'], AUTHORING_LIMITS.outputFiles).map(path);
  if (
    paths.length === 0 ||
    paths.some(
      (p) =>
        !p.startsWith(`.ia/src/systems/${system}/`) ||
        p.endsWith('/system.ia') ||
        p.endsWith('/steward.ia') ||
        p.includes('/schemas/'),
    ) ||
    ['system', 'schema'].includes(discriminator)
  )
    throw new AuthoringError('authority-change', 'Only new instances in the target system may be proposed');
  uniquePaths(paths);
  const expectedSteward = text(input['expectedSteward'], 300);
  if (!/^[a-z][a-z0-9-]*\/binding\/agent\/[a-z][a-z0-9-]*$/.test(expectedSteward))
    throw new AuthoringError('invalid-steward', 'Expected an admitted agent identity');
  return {
    protocol: 1,
    languageVersion: '1.0',
    idempotencyKey: text(input['idempotencyKey'], 100),
    intent: text(input['intent']),
    target: { system, discriminator, paths },
    expectedSteward,
    ...disclosure(input['base'], input['context']),
  };
}
function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result))
    throw new AuthoringError('invalid-id', 'Expected a UUID');
  return result;
}
export function parseChatTurn(value: unknown): ChatTurnRequest {
  const v = object(value, [
    'protocol',
    'kind',
    'languageVersion',
    'idempotencyKey',
    'conversationId',
    'parentRunId',
    'message',
    'base',
    'context',
  ]);
  if (v['protocol'] !== 1 || v['kind'] !== 'chat' || v['languageVersion'] !== '1.0')
    throw new AuthoringError('unsupported-protocol', 'Expected chat protocol 1 and IA 1.0');
  const message = text(v['message'], CHAT_LIMITS.messageBytes);
  if (!message.trim()) throw new AuthoringError('invalid-message', 'Enter a message');
  return {
    protocol: 1,
    kind: 'chat',
    languageVersion: '1.0',
    idempotencyKey: text(v['idempotencyKey'], 100),
    conversationId: uuid(v['conversationId']),
    parentRunId: v['parentRunId'] === null ? null : uuid(v['parentRunId']),
    message,
    ...disclosure(v['base'], v['context']),
  };
}
export function parseChatReply(
  value: unknown,
  request: ChatTurnRequest,
  runId: string,
  expectedAgent: Capabilities['agent'],
): ChatReply {
  const v = object(value, ['protocol', 'conversationId', 'runId', 'requestDigest', 'agent', 'message', 'proposal']),
    agent = object(v['agent'], ['id', 'version']);
  if (
    v['protocol'] !== 1 ||
    v['conversationId'] !== request.conversationId ||
    v['runId'] !== runId ||
    v['requestDigest'] !== digestValue(request) ||
    agent['id'] !== expectedAgent.id ||
    agent['version'] !== expectedAgent.version
  )
    throw new AuthoringError(
      'attestation-mismatch',
      'Chat reply does not match the authenticated conversation, turn or agent',
    );
  let proposal: ChatReply['proposal'] = null;
  if (v['proposal'] !== null) {
    const nested = object(v['proposal'], ['request', 'proposal']),
      targetRequest = parseAuthoringRequest(nested['request']);
    if (
      targetRequest.intent !== request.message ||
      targetRequest.idempotencyKey !== request.idempotencyKey ||
      digestValue(targetRequest.base) !== digestValue(request.base) ||
      digestValue(targetRequest.context) !== digestValue(request.context)
    )
      throw new AuthoringError('disclosure-mismatch', 'The agent cannot change the disclosed turn');
    proposal = {
      request: targetRequest,
      proposal: parseAuthoringProposal(nested['proposal'], targetRequest, runId, expectedAgent),
    };
  }
  return {
    protocol: 1,
    conversationId: request.conversationId,
    runId,
    requestDigest: digestValue(request),
    agent: expectedAgent,
    message: text(v['message'], CHAT_LIMITS.replyBytes),
    proposal,
  };
}
export function parseConversation(value: unknown, id: string): ChatConversation {
  const v = object(value, ['protocol', 'id', 'expiresAt', 'turns']);
  if (
    v['protocol'] !== 1 ||
    uuid(v['id']) !== id ||
    typeof v['expiresAt'] !== 'string' ||
    !Number.isFinite(Date.parse(v['expiresAt']))
  )
    throw new AuthoringError('invalid-conversation', 'Conversation identity or expiry is invalid');
  let parent: string | null = null;
  const seen = new Set<string>();
  const turns = array(v['turns'], CHAT_LIMITS.turns).map((entry): ChatConversation['turns'][number] => {
    const row = object(entry, ['receipt', 'parentRunId', 'userMessage', 'assistantMessage', 'hasProposal']),
      receipt = parseReceipt(row['receipt']);
    if (
      row['parentRunId'] !== parent ||
      seen.has(receipt.runId) ||
      typeof row['hasProposal'] !== 'boolean' ||
      (receipt.state !== 'completed' && (row['assistantMessage'] !== null || row['hasProposal']))
    )
      throw new AuthoringError('invalid-conversation', 'Conversation turns are out of order');
    parent = receipt.runId;
    seen.add(parent);
    return {
      receipt,
      parentRunId: row['parentRunId'] as string | null,
      userMessage: text(row['userMessage'], CHAT_LIMITS.messageBytes),
      assistantMessage: row['assistantMessage'] === null ? null : text(row['assistantMessage'], CHAT_LIMITS.replyBytes),
      hasProposal: row['hasProposal'],
    };
  });
  return { protocol: 1, id, expiresAt: v['expiresAt'], turns };
}
export function parseAuthoringProposal(
  value: unknown,
  request: AuthoringRequestV1,
  runId: string,
  agent: Capabilities['agent'],
): AuthoringProposalV1 {
  const input = object(value, ['protocol', 'runId', 'requestDigest', 'agent', 'files', 'summary', 'citations']),
    attestation = object(input['agent'], ['id', 'version', 'steward']);
  if (
    input['protocol'] !== 1 ||
    input['runId'] !== runId ||
    input['requestDigest'] !== digestValue(request) ||
    attestation['id'] !== agent.id ||
    attestation['version'] !== agent.version ||
    attestation['steward'] !== request.expectedSteward
  )
    throw new AuthoringError('attestation-mismatch', 'Proposal does not match the authenticated run, request or agent');
  const files = array(input['files'], AUTHORING_LIMITS.outputFiles).map((entry) => {
    const item = object(entry, ['path', 'operation', 'content', 'digest']),
      target = path(item['path']),
      content = text(item['content'], AUTHORING_LIMITS.outputFileBytes),
      digest = sha(item['digest']);
    if (item['operation'] !== 'create' || !request.target.paths.includes(target) || digestText(content) !== digest)
      throw new AuthoringError(
        'proposal-mismatch',
        'Only reviewed create-only targets with matching bytes are accepted',
      );
    return { path: target, operation: 'create' as const, content, digest };
  });
  uniquePaths(files.map((f) => f.path));
  if (files.length === 0 || files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > AUTHORING_LIMITS.outputBytes)
    throw new AuthoringError('proposal-too-large', 'Empty or oversized proposal');
  const citations = array(input['citations'], 200).map((entry) => {
    const item = object(entry, ['path', 'digest', 'line', 'endLine']),
      target = path(item['path']),
      digest = sha(item['digest']),
      source = request.context.find((c) => c.path === target && c.digest === digest);
    const line = item['line'],
      endLine = item['endLine'];
    if (
      source === undefined ||
      typeof line !== 'number' ||
      typeof endLine !== 'number' ||
      !Number.isInteger(line) ||
      !Number.isInteger(endLine) ||
      line < 1 ||
      endLine < line ||
      endLine > source.text.split('\n').length
    )
      throw new AuthoringError('citation-invalid', 'Citations must address disclosed source bytes');
    return { path: target, digest, line, endLine };
  });
  return {
    protocol: 1,
    runId,
    requestDigest: digestValue(request),
    agent: { ...agent, steward: request.expectedSteward },
    files,
    summary: text(input['summary']),
    citations,
  };
}
export function parseCapabilities(value: unknown): Capabilities {
  const v = object(value),
    account = object(v['account']),
    agent = object(v['agent']),
    limits = object(v['limits']);
  if (
    v['protocol'] !== 1 ||
    !array(v['languageVersions'], 10).includes('1.0') ||
    !['enabled', 'disabled'].includes(String(v['entitlement'])) ||
    typeof v['authoringAvailable'] !== 'boolean' ||
    typeof v['retentionDays'] !== 'number' ||
    !Number.isInteger(v['retentionDays']) ||
    v['retentionDays'] < 0
  )
    throw new AuthoringError('capabilities-invalid', 'Service capability contract is incompatible');
  for (const key of Object.keys(AUTHORING_LIMITS) as (keyof typeof AUTHORING_LIMITS)[])
    if (typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || (limits[key] as number) <= 0)
      throw new AuthoringError('capabilities-invalid', 'Invalid service limit');
  return {
    protocol: 1,
    languageVersions: ['1.0'],
    account: { id: text(account['id'], 200), label: text(account['label'], 320) },
    agent: { id: text(agent['id'], 300), version: text(agent['version'], 100) },
    entitlement: v['entitlement'] as Capabilities['entitlement'],
    authoringAvailable: v['authoringAvailable'],
    retentionDays: v['retentionDays'],
    limits: limits as unknown as typeof AUTHORING_LIMITS,
    chatAvailable: v['chatAvailable'] === true,
  };
}
export function parseReceipt(value: unknown, expectedDigest?: string): RunReceipt {
  const v = object(value),
    usage = object(v['usage']);
  const runId = text(v['runId'], 36),
    requestDigest = sha(v['requestDigest']);
  if (
    !/^[a-f0-9-]{36}$/.test(runId) ||
    (expectedDigest !== undefined && requestDigest !== expectedDigest) ||
    !['queued', 'running', 'cancel-requested', 'completed', 'cancelled', 'failed'].includes(String(v['state'])) ||
    !Number.isSafeInteger(v['cursor']) ||
    (v['cursor'] as number) < 0 ||
    !['reported', 'unknown'].includes(String(usage['state']))
  )
    throw new AuthoringError('invalid-receipt', 'Service returned an incompatible run receipt');
  for (const key of ['inputTokens', 'outputTokens'])
    if (usage[key] !== null && (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0))
      throw new AuthoringError('invalid-receipt', 'Invalid usage');
  const createdAt = text(v['createdAt'], 100),
    expiresAt = text(v['expiresAt'], 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(expiresAt)))
    throw new AuthoringError('invalid-receipt', 'Invalid run dates');
  return {
    runId,
    requestDigest,
    state: v['state'] as RunState,
    cursor: v['cursor'] as number,
    createdAt,
    expiresAt,
    usage: {
      inputTokens: usage['inputTokens'] as number | null,
      outputTokens: usage['outputTokens'] as number | null,
      state: usage['state'] as 'reported' | 'unknown',
    },
    ...(v['error'] === undefined ? {} : { error: text(v['error'], 8192) }),
  };
}
export function parseEvents(
  value: unknown,
  runId: string,
  digest: string,
  after: number,
): { receipt: RunReceipt; events: readonly AuthoringEvent[] } {
  const v = object(value),
    receipt = parseReceipt(v['receipt'], digest);
  if (receipt.runId !== runId) throw new AuthoringError('invalid-events', 'Run ownership mismatch');
  let cursor = after;
  const events = array(v['events'], 100).map((entry): AuthoringEvent => {
    const e = object(entry);
    if (
      e['runId'] !== runId ||
      e['sequence'] !== cursor + 1 ||
      !['status', 'usage', 'completed', 'cancelled', 'failed'].includes(String(e['type'])) ||
      !['queued', 'running', 'cancel-requested', 'completed', 'cancelled', 'failed'].includes(String(e['state']))
    )
      throw new AuthoringError('invalid-events', 'Events must be ordered and bound to this run');
    cursor++;
    return {
      runId,
      sequence: cursor,
      type: e['type'] as AuthoringEvent['type'],
      state: e['state'] as RunState,
      message: text(e['message']),
      at: text(e['at'], 100),
    };
  });
  if (cursor > receipt.cursor) throw new AuthoringError('invalid-events', 'Receipt cursor precedes its events');
  return { receipt, events };
}
export function serviceOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new AuthoringError('unsafe-origin', 'Service requires HTTPS or loopback development HTTP');
  return url;
}
/** Bounded, non-redirecting transport. Access tokens remain in the host supplying this client. */
export async function serviceJson(base: string, route: string, init: RequestInit = {}): Promise<unknown> {
  const origin = serviceOrigin(base),
    url = new URL(route, origin);
  if (url.origin !== origin.origin)
    throw new AuthoringError('unsafe-origin', 'Service request escaped its configured origin');
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers,
  });
  const reader = response.body?.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  if (reader !== undefined)
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new AuthoringError('response-too-large', 'Service response exceeded the client limit');
      }
      parts.push(item.value);
    }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new AuthoringError('invalid-response', 'Service did not return JSON', response.status);
  }
  if (!response.ok) {
    const error = object(value);
    throw new AuthoringError(
      typeof error['code'] === 'string'
        ? error['code']
        : typeof error['error'] === 'string'
          ? error['error']
          : 'service-error',
      typeof error['message'] === 'string' ? error['message'].slice(0, 500) : `Service returned ${response.status}`,
      response.status,
    );
  }
  return value;
}
