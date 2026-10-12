import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { canonical, digest } from '@inventarch/graph';
import type { Graph, RevisionSource } from '@inventarch/graph';
import { DbError } from './errors.js';
import { RUNNER_EVIDENCE_DIRECTORY, readWorkspaceBytes, safePath } from './inputs.js';
import type { InputSnapshot } from './inputs.js';
import { parseStrictJson } from './json.js';
import { discard, staged, syncDirectory } from './retention.js';

/** Local journal claims, not execution authorization or an attestation by an external observer. */
export const RUNNER_EVIDENCE_FORMAT = 'ia.runner-evidence.v1';
const BYTES = 4 * 1024 * 1024;
const EVENTS = 4096;
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const NATIVE_ID = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TYPES = new Set([
  'session.create',
  'run.ready',
  'attempt.prepare',
  'attempt.dispatch',
  'attempt.abandon',
  'attempt.observe',
  'action.accept',
  'attempt.retry',
  'model.repair',
  'action.clear',
  'run.wait',
  'outcome.accept',
  'question.reply',
  'proposal.review',
  'decision.record',
  'child.create',
  'child.return',
  'control.submit',
  'control.apply',
  'session.rebind',
  'session.renew',
  'budget.extend',
  'reaction.queue',
  'reaction.settle',
  'attempt.reconcile.start',
  'attempt.reconcile',
]);
type Row = Record<string, unknown>;
interface JournalEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly actor: string;
  readonly at: string;
  readonly hash: string;
  readonly mutation: Row;
}
interface Receipt {
  readonly format: typeof RUNNER_EVIDENCE_FORMAT;
  readonly authoredRevision: string;
  readonly events: readonly JournalEvent[];
}
function fail(message: string): never {
  throw new DbError('IA-DB-SOURCE-UNAVAILABLE', `Runner evidence: ${message}`);
}
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a data object');
  return value as Row;
}
function exact(value: Row, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail('unknown or missing receipt field');
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value))
    fail('expected bounded single-line text');
  return value;
}
function hash(value: unknown): string {
  const result = text(value, 64);
  if (!HEX.test(result)) fail('expected SHA-256');
  return result;
}
function identifier(value: unknown): string {
  const result = text(value, 128);
  if (!ID.test(result) || ['__proto__', 'prototype', 'constructor'].includes(result))
    fail('invalid journal identifier');
  return result;
}
/** Copy bounded plain data without evaluating accessors, toJSON or custom instances. */
function data(value: unknown): unknown {
  let budget = BYTES,
    count = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 64 || ++count > 200_000 || (budget -= 8) < 0) fail('receipt complexity limit');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') {
      if ((budget -= Buffer.byteLength(item)) < 0 || Buffer.from(item).toString('utf8') !== item)
        fail('receipt byte or encoding limit');
      return item;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) fail('expected acyclic plain data');
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item),
      keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      if (
        keys.length !== item.length + 1 ||
        keys.some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))
      )
        fail('expected a dense data array');
      return Array.from({ length: item.length }, (_, at) => visit(descriptors[String(at)]!.value, depth + 1));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('expected plain data');
    const result: Row = Object.create(null) as Row;
    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value')
      )
        fail('unsafe data field');
      if ((budget -= Buffer.byteLength(key)) < 0) fail('receipt byte limit');
      result[key] = visit(descriptors[key]!.value, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
/** Checks the journal envelope and hashes, never reimplements the session transition reducer. */
function receipt(value: unknown): Receipt {
  const object = row(value);
  exact(object, ['format', 'authoredRevision', 'events']);
  if (object['format'] !== RUNNER_EVIDENCE_FORMAT) fail('unsupported receipt format');
  hash(object['authoredRevision']);
  const events = object['events'];
  if (!Array.isArray(events) || events.length === 0 || events.length > EVENTS) fail('journal event limit');
  let previous = '',
    sessionId = '';
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = row(events[index]),
      mutation = row(event['mutation']);
    exact(event, ['version', 'id', 'sequence', 'sessionId', 'actor', 'at', 'cause', 'mutation', 'previous', 'hash']);
    const type = text(mutation['type'], 64),
      id = identifier(event['id']);
    if (!TYPES.has(type) || event['version'] !== (type === 'session.renew' ? 2 : 1) || ids.has(id))
      fail('unknown event type/version or duplicate event id');
    ids.add(id);
    const currentSession = identifier(event['sessionId']),
      at = text(event['at'], 24);
    text(event['actor']);
    if (
      !STAMP.test(at) ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at ||
      Date.parse(at) > Date.now() + 300_000
    )
      fail('invalid journal time');
    if (event['cause'] !== null) identifier(event['cause']);
    const { hash: eventHash, ...body } = event;
    if (event['sequence'] !== index + 1 || event['previous'] !== previous || hash(eventHash) !== digest(body))
      fail('journal chain mismatch');
    if (index === 0) {
      sessionId = currentSession;
      if (type !== 'session.create' || mutation['sessionId'] !== sessionId || mutation['principal'] !== event['actor'])
        fail('missing journal creation');
      identifier(mutation['rootId']);
      if (!NATIVE_ID.test(text(mutation['profile']))) fail('expected a native profile identity');
    } else if (currentSession !== sessionId || type === 'session.create') fail('journal session mismatch');
    if (type === 'session.create' || type === 'session.rebind') {
      const manifest = row(mutation['manifest']);
      hash(manifest['sourceDigest']);
      if (hash(mutation['manifestDigest']) !== digest(manifest)) fail('journal manifest mismatch');
    }
    previous = eventHash as string;
  }
  return object as unknown as Receipt;
}
function decode(bytes: Uint8Array): Receipt {
  const value = parseStrictJson(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    { bytes: BYTES, depth: 64, nodes: 200_000 },
    (_fault, message) => fail(message),
  );
  return receipt(value);
}
const sessionKey = (id: string): string => createHash('sha256').update(id).digest('hex');
function receiptPath(value: Receipt): string {
  return `${RUNNER_EVIDENCE_DIRECTORY}/${value.authoredRevision}-${sessionKey(value.events[0]!.sessionId)}.json`;
}
/** The exact whole-workspace capture used by apps/runner, independently bound to the current database inputs. */
function sourceDigest(input: InputSnapshot): string {
  return digest({
    version: 1,
    id: 'runner',
    sources: input.sources,
    folders: input.folders,
    floorOrigin: input.floorOrigin,
    ...(input.activation ? { activation: input.activation } : {}),
  });
}
function directories(root: string): void {
  for (const path of ['.ia', '.ia/work', RUNNER_EVIDENCE_DIRECTORY]) {
    const stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new DbError('IA-DB-PATH-UNSAFE', `${path} is not a directory`, path);
  }
}
export interface RunnerEvidenceWrite {
  readonly path: string;
  readonly written: boolean;
  readonly sequence: number;
  readonly hash: string;
}
/**
 * The trusted runner calls this after reading its verified journal. It accepts no native source text. A receipt is
 * an atomic local copy of that journal, not independent proof it executed. It never prunes other sessions/revisions.
 * One runner owns a session; an older or divergent receipt cannot replace a newer receipt through this API.
 */
export function writeRunnerEvidence(
  root: string,
  input: {
    readonly authoredRevision: string;
    readonly events: readonly unknown[];
  },
): RunnerEvidenceWrite {
  const clean = row(data(input));
  exact(clean, ['authoredRevision', 'events']);
  const value = receipt({ format: RUNNER_EVIDENCE_FORMAT, ...clean }),
    path = receiptPath(value),
    bytes = Buffer.from(canonical(value) + '\n'),
    last = value.events.at(-1)!;
  if (bytes.length > BYTES) fail('receipt byte limit');
  directories(root);
  mkdirSync(safePath(root, RUNNER_EVIDENCE_DIRECTORY), { recursive: true });
  directories(root);
  // Serialize the compare-and-replace across processes. A held or abandoned lock refuses; it is never stolen.
  const lock = safePath(root, `${path}.lock`),
    fd = openSync(lock, 'wx', 0o600),
    held = fstatSync(fd, { bigint: true });
  let temporary: string | undefined;
  try {
    const stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    if (stat) {
      const prior = decode(readWorkspaceBytes(root, path, BYTES));
      if (
        receiptPath(prior) !== path ||
        prior.events.length > value.events.length ||
        prior.events.at(-1)!.hash !== value.events[prior.events.length - 1]!.hash
      )
        fail('stale or divergent journal receipt');
      if (prior.events.length === value.events.length)
        return Object.freeze({ path, written: false, sequence: last.sequence, hash: last.hash });
    }
    temporary = staged(root, path, bytes);
    renameSync(safePath(root, temporary), safePath(root, path));
    temporary = undefined;
    syncDirectory(safePath(root, RUNNER_EVIDENCE_DIRECTORY));
  } finally {
    discard(root, temporary);
    closeSync(fd);
    const named = lstatSync(lock, { bigint: true, throwIfNoEntry: false });
    if (named?.isFile() && named.nlink === 1n && named.dev === held.dev && named.ino === held.ino) unlinkSync(lock);
  }
  return Object.freeze({ path, written: true, sequence: last.sequence, hash: last.hash });
}
const quote = (value: string): string => `"${value.replace(/["\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}"`;
/** Generated fixed-field native projection. Event payloads can never introduce declarations or relationships. */
function project(value: Receipt, path: string, graph: Graph): string | undefined {
  const first = value.events[0]!,
    creation = first.mutation,
    profile = graph.nodes.get(String(creation['profile'])),
    agent = graph.nodes.get(String(creation['agent'])),
    records = [...graph.nodes.values()];
  if (
    profile?.discriminator !== 'agent-profile' ||
    agent?.discriminator !== 'agent' ||
    !graph.referencesFrom
      .get(profile.identity)
      ?.some((ref) => ref.field === 'composition.agent' && ref.to === agent.identity) ||
    records.filter((node) => node.discriminator === 'agent' && node.name === agent.name).length !== 1 ||
    records.filter((node) => node.discriminator === 'agent-profile' && node.name === profile.name).length !== 1 ||
    !graph.registry.registrations.has('run') ||
    !graph.registry.registrations.has('observation')
  )
    return undefined;
  const key = sessionKey(first.sessionId),
    run = `runner-${key}`,
    rootId = creation['rootId'],
    names = new Set(
      records.filter((node) => ['run', 'observation'].includes(node.discriminator)).map((node) => node.name),
    );
  if (names.has(run)) return undefined;
  const blocks = [
    [
      `@run ${run}`,
      '  meaning',
      `    says ${quote(`Local journal ${first.sessionId} is recorded under profile ${profile.identity}; this projection does not report live engine state or phase.`)}`,
      '    answers "Which local runner journal does this record describe?"',
      '  execution',
      '    status recorded',
      '    phase recorded',
      `    owner @agent ${agent.name}`,
    ].join('\n'),
  ];
  const attempts = new Map<string, Row>();
  for (const event of value.events) {
    const mutation = event.mutation,
      type = mutation['type'];
    if (type === 'attempt.prepare') {
      const attempt = row(mutation['attempt']);
      attempts.set(identifier(attempt['id']), attempt);
    }
    let verdict = 'inconclusive',
      reason: string | undefined;
    if (mutation['runId'] === rootId && type === 'outcome.accept') {
      const outcome = row(mutation['outcome']);
      verdict =
        outcome['kind'] === 'refusal' || mutation['terminal'] === 'failed'
          ? 'refusal'
          : mutation['terminal'] === 'completed'
            ? 'success'
            : 'inconclusive';
      reason = `Journal event outcome.accept records ${text(outcome['kind'], 64)} with terminal ${String(mutation['terminal'])}.`;
    } else if (mutation['runId'] === rootId && type === 'run.wait') {
      const wait = row(mutation['wait']),
        why = text(wait['reason'], 128);
      verdict = ['limit', 'runner-limit-refusal'].includes(why) ? 'refusal' : 'inconclusive';
      reason = `Journal event run.wait records ${why}; a wait is not a terminal outcome.`;
    } else if (type === 'attempt.observe') {
      const attempt = attempts.get(String(mutation['attemptId']));
      if (attempt?.['kind'] === 'operation' && attempt['runId'] === rootId) {
        const effect = text(mutation['effect'], 16);
        if (!['none', 'applied', 'partial', 'unknown'].includes(effect)) fail('unknown journal effect');
        verdict =
          effect === 'partial' || effect === 'unknown'
            ? 'inconclusive'
            : mutation['error'] === null
              ? 'success'
              : 'refusal';
        reason = `Journal event attempt.observe records operation ${text(attempt['target'])}, effect ${effect}, ${mutation['error'] === null ? 'no reported error' : 'a reported error'}.`;
      }
    }
    if (reason === undefined) continue;
    const name = `${run}-${event.sequence}`;
    if (names.has(name)) return undefined;
    blocks.push(
      [
        `@observation ${name}`,
        '  meaning',
        `    says ${quote(reason)}`,
        '    answers "What outcome does this local journal event report?"',
        '  evidence',
        '    origin runner-journal',
        `    actor ${quote(event.actor)}`,
        `    observed-at ${quote(event.at)}`,
        `    captured-at ${quote(event.at)}`,
        '    workspace "."',
        `    locator ${quote(`${first.sessionId}#${event.sequence}`)}`,
        `    revision ${quote(value.authoredRevision)}`,
        `    bundle ${quote(path)}`,
        `    digest ${quote(event.hash)}`,
        '    availability available',
        `    subject @run ${run}`,
        `    snapshot-revision ${quote(value.authoredRevision)}`,
        '    evaluator "ia runner journal projection v1"',
        '    move Execution',
        `    verdict ${verdict}`,
        '  interpretation',
        '    applies "One root-run journal event at the bound authored revision."',
        '    limits "Local journal claims only. Hashes check integrity, not external truth, identity, authorization or successful real-world effects. Session transition validation belongs to the runner."',
        `    reason ${quote(reason)}`,
        '    basis journal',
        '  retention',
        '    status retained',
      ].join('\n'),
    );
  }
  const result = `#! ia 1.0\n\n${blocks.join('\n\n')}\n`;
  return Buffer.byteLength(result) <= BYTES ? result : undefined;
}
/** Optional evidence fails closed without making authored data unavailable. No filesystem or journal code executes. */
export function runnerEvidenceSources(
  input: InputSnapshot,
  authoredRevision: string,
  graph: Graph,
): readonly RevisionSource[] {
  const candidates = (input.runnerEvidence ?? []).filter((item) =>
    item.path.startsWith(`${RUNNER_EVIDENCE_DIRECTORY}/${authoredRevision}-`),
  );
  if (candidates.length > 128 || candidates.reduce((sum, item) => sum + item.bytes, 0) > 16 * 1024 * 1024) return [];
  const expected = sourceDigest(input),
    sources: RevisionSource[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    try {
      const data = readWorkspaceBytes(input.root, candidate.path, Math.min(BYTES, 16 * 1024 * 1024 - bytes));
      bytes += data.length;
      const value = decode(data);
      if (
        value.authoredRevision !== authoredRevision ||
        receiptPath(value) !== candidate.path ||
        value.events.some(
          (event) =>
            ['session.create', 'session.rebind'].includes(String(event.mutation['type'])) &&
            row(event.mutation['manifest'])['sourceDigest'] !== expected,
        )
      )
        continue;
      const text = project(value, candidate.path, graph);
      if (text !== undefined)
        sources.push(
          Object.freeze({
            path: candidate.path,
            text,
            location: Object.freeze({
              placement: Object.freeze({ kind: 'runtime', band: 0, reach: '' }),
              provenance: 'runtime',
            }),
          }),
        );
    } catch {
      /* A malformed, stale, changed or unsafe optional receipt is not evidence. */
    }
  }
  return Object.freeze(sources);
}
