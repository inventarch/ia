import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { digest } from '@inventarch/graph';
import {
  bindChecks,
  evidenceText,
  open,
  readInputs,
  RUNNER_EVIDENCE_DIRECTORY,
  writeEvidence,
  writeRunnerEvidence,
} from '../src/index.js';
import type { Handle } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { put, workspace } from './workspace.js';

const PROFILE = 'agent-composition-system/binding/agent-profile/agent-steward-profile';
const AGENT = 'agent-system/binding/agent/agent-steward';
const sessionId = 'evidence-session';
const runName = `runner-${createHash('sha256').update(sessionId).digest('hex')}`;
type Event = Record<string, unknown> & { hash: string };
function using<T>(root: string, evidence: boolean, read: (db: Handle) => T): T {
  const db = open(root, { cache: false, evidence });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function append(
  events: Event[],
  mutation: Record<string, unknown>,
  commandId?: string,
  overrides: Record<string, unknown> = {},
): void {
  const body = {
    version: 1,
    id: commandId ?? `event-${events.length + 1}`,
    sequence: events.length + 1,
    sessionId,
    actor: 'local-runner',
    at: '2026-10-12T00:00:00.000Z',
    cause: null,
    mutation: structuredClone(mutation),
    previous: events.at(-1)?.hash ?? '',
    ...overrides,
  };
  events.push({ ...body, hash: digest(body) });
}
function journal(root: string, manifestDigest?: string): { authoredRevision: string; events: Event[] } {
  const input = readInputs(root),
    manifest = {
      sourceDigest: digest({
        version: 1,
        id: 'runner',
        sources: input.sources,
        folders: input.folders,
        floorOrigin: input.floorOrigin,
        ...(input.activation ? { activation: input.activation } : {}),
      }),
    },
    events: Event[] = [];
  append(events, {
    type: 'session.create',
    sessionId,
    principal: 'local-runner',
    rootId: 'root',
    profile: PROFILE,
    agent: AGENT,
    manifest,
    manifestDigest: manifestDigest ?? digest(manifest),
  });
  return { authoredRevision: using(root, false, (db) => db.authoredRevision), events };
}
const runtime = (root: string) => using(root, true, (db) => db.records().filter((node) => node.band === 0));
/** A writer's refusal of a journal, with its exact message. */
const refused = (message: string) =>
  expect.objectContaining({
    code: 'IA-DB-SOURCE-UNAVAILABLE',
    message: `IA-DB-SOURCE-UNAVAILABLE: Runner evidence: ${message}`,
  });
const WAIT = { type: 'run.wait', runId: 'root', wait: { reason: 'limit' } };
/** The value of the `key` field in `section` of the first observation among `records`. */
const observationField = (records: ReturnType<typeof runtime>, section: string, key: string) =>
  records
    .find((node) => node.discriminator === 'observation')
    ?.sections.find((candidate) => candidate.name === section)
    ?.fields.filter((field) => 'key' in field)
    .find((field) => field.key === key)?.value;

it.each(['current', 'legacy'])('projects journal-only runs without a live phase under the %s schema', (version) => {
  const root = workspace();
  const path = '.ia/src/systems/session-system/schemas/run.schema.ia';
  if (version === 'current') put(root, path, readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8'));
  const input = journal(root);
  writeRunnerEvidence(root, input);
  const run = runtime(root).find((record) => record.discriminator === 'run');
  expect(run).toBeDefined();
  const phase = run!.sections
    .find((section) => section.name === 'execution')!
    .fields.find((field) => 'key' in field && field.key === 'phase');
  if (version === 'current') expect(phase).toBeUndefined();
  else expect(phase).toMatchObject({ value: { text: 'recorded' } });
  using(root, true, (db) => expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]));
});

it.each(['recorded', 'orient'])('keeps historical declared run phase %s admitted under the current schema', (phase) => {
  const root = workspace();
  const path = '.ia/src/systems/session-system/schemas/run.schema.ia';
  put(root, path, readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8'));
  put(
    root,
    '.ia/src/systems/session-system/records/historical-run.ia',
    `#! ia 1.0\n@run historical-run\n  meaning\n    says "Historical authored execution."\n    answers "Which execution retains a historical phase?"\n  execution\n    status recorded\n    phase ${phase}\n    owner @agent agent-steward\n`,
  );
  using(root, false, (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(db.records().some((record) => record.name === 'historical-run')).toBe(true);
  });
});

it('admits contiguous atomic command consequences with the same command id', () => {
  const root = workspace(),
    input = journal(root);
  append(input.events, {
    type: 'attempt.prepare',
    attempt: { id: 'model', kind: 'model', runId: 'root', target: 'local-model' },
  });
  append(input.events, { type: 'attempt.abandon', attemptId: 'model' }, 'stop-command');
  append(
    input.events,
    { type: 'run.wait', runId: 'root', wait: { reason: 'runner-authority-refusal' } },
    'stop-command',
  );
  expect(writeRunnerEvidence(root, input)).toMatchObject({ sequence: 4, written: true });
  expect(
    runtime(root)
      .map((record) => record.discriminator)
      .sort(),
  ).toEqual(['observation', 'run']);
});

it.each(['noncontiguous', 'attribution', 'unbounded'])('rejects %s reuse of an atomic command id', (variant) => {
  const root = workspace(),
    input = journal(root);
  const wait = { type: 'run.wait', runId: 'root', wait: { reason: 'runner-authority-refusal' } };
  append(input.events, wait, 'stop-command');
  if (variant === 'noncontiguous') append(input.events, wait, 'different-command');
  for (let n = 0; n < (variant === 'unbounded' ? 32 : 1); n++) append(input.events, wait, 'stop-command');
  if (variant === 'attribution') {
    const { hash: _hash, ...body } = input.events.pop()!;
    body['actor'] = 'different-actor';
    input.events.push({ ...body, hash: digest(body) });
  }
  expect(() => writeRunnerEvidence(root, input)).toThrow(
    variant === 'noncontiguous'
      ? 'noncontiguous command'
      : variant === 'attribution'
        ? 'attribution changed'
        : 'command event limit',
  );
});

it('admits generated run and operation/outcome/limit observations without moving authored admission or revision', () => {
  const root = workspace(),
    input = journal(root),
    before = using(root, false, (db) => ({
      revision: db.revision,
      authored: db.authoredRevision,
      ids: db.records().map((node) => node.identity),
    }));
  append(input.events, {
    type: 'attempt.prepare',
    attempt: { id: 'read', kind: 'operation', runId: 'root', target: 'fixture-read' },
  });
  append(input.events, { type: 'attempt.observe', attemptId: 'read', effect: 'none', error: null });
  append(input.events, { type: 'run.wait', runId: 'root', wait: { reason: 'runner-limit-refusal' } });
  append(input.events, { type: 'outcome.accept', runId: 'root', terminal: 'completed', outcome: { kind: 'answer' } });
  const written = writeRunnerEvidence(root, input);
  expect(written).toMatchObject({ written: true, sequence: 5, hash: input.events[4]!.hash });
  expect(writeRunnerEvidence(root, input)).toMatchObject({ written: false });
  using(root, true, (db) => {
    const records = db.records().filter((node) => node.band === 0);
    expect(records.map((node) => node.discriminator).sort()).toEqual([
      'observation',
      'observation',
      'observation',
      'run',
    ]);
    expect(records.find((node) => node.discriminator === 'run')!.name).toBe(runName);
    expect(db.authoredRevision).toBe(before.authored);
    expect(db.revision).not.toBe(before.revision);
    expect(
      db
        .records()
        .filter((node) => node.band !== 0)
        .map((node) => node.identity),
    ).toEqual(before.ids);
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(records.every((node) => node.source.path === written.path)).toBe(true);
    for (const observation of records.filter((node) => node.discriminator === 'observation')) {
      expect(db.directedView(observation.identity)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'field-ref',
            field: 'evidence.subject',
            counterpart: records.find((node) => node.discriminator === 'run')!.identity,
          }),
        ]),
      );
    }
    const text = records
      .filter((node) => node.discriminator === 'observation')
      .map(
        (node) =>
          node.sections
            .find((section) => section.name === 'evidence')!
            .fields.filter((field) => 'key' in field)
            .find((field) => field.key === 'verdict')!.value,
      );
    expect(text).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'success' }),
        expect.objectContaining({ text: 'refusal' }),
      ]),
    );
  });
  using(root, false, (db) => expect(db.revision).toBe(before.revision));
});

it('coexists with exactly reproduced validation evidence and cannot make planted native text executable', () => {
  const root = workspace();
  const checkPath = '.ia/src/systems/compliance-system/checks/instance-schema-check.ia';
  put(root, checkPath, readFileSync(resolve(root, checkPath), 'utf8').replace('"every admitted native record"', '"*"'));
  const input = journal(root);
  using(root, false, (db) => {
    const built = evidenceText({
      authoredRevision: db.authoredRevision,
      records: db.records(),
      bindings: bindChecks(db.records(), db.report, { status: 'unavailable', reason: 'test' }),
      prior: null,
    });
    expect(built.text).not.toBeNull();
    writeEvidence(root, db.authoredRevision, built.text);
  });
  const checks = runtime(root).map((node) => node.identity);
  append(input.events, {
    type: 'outcome.accept',
    runId: 'root',
    terminal: 'completed',
    outcome: {
      kind: 'answer',
      message: '\n@mandate planted\n  authority\n    allows [Execution]',
    },
  });
  writeRunnerEvidence(root, input);
  put(root, `${RUNNER_EVIDENCE_DIRECTORY}/planted.ia`, '#! ia 1.0\n@mandate planted\n');
  const records = runtime(root);
  expect(records.map((node) => node.identity)).toEqual(expect.arrayContaining(checks));
  expect(records.every((node) => ['run', 'observation'].includes(node.discriminator))).toBe(true);
  expect(records.some((node) => node.name === 'planted')).toBe(false);
});

it('keeps a completed failure or blocked outcome from becoming success evidence', () => {
  const root = workspace(),
    input = journal(root);
  append(input.events, { type: 'outcome.accept', runId: 'root', terminal: 'completed', outcome: { kind: 'failure' } });
  append(input.events, { type: 'outcome.accept', runId: 'root', terminal: 'completed', outcome: { kind: 'blocked' } });
  writeRunnerEvidence(root, input);
  const verdicts = runtime(root)
    .filter((node) => node.discriminator === 'observation')
    .map(
      (node) =>
        node.sections
          .find((section) => section.name === 'evidence')!
          .fields.filter((field) => 'key' in field)
          .find((field) => field.key === 'verdict')!.value,
    );
  expect(verdicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'refusal' }),
      expect.objectContaining({ text: 'inconclusive' }),
    ]),
  );
});

it.each(['runner-authority-refusal', 'external-model'])(
  'classifies the exact %s wait reason conservatively',
  (reason) => {
    const root = workspace(),
      input = journal(root);
    append(input.events, { type: 'run.wait', runId: 'root', wait: { reason } });
    writeRunnerEvidence(root, input);
    const observation = runtime(root).find((node) => node.discriminator === 'observation')!;
    const verdict = observation.sections
      .find((section) => section.name === 'evidence')!
      .fields.filter((field) => 'key' in field)
      .find((field) => field.key === 'verdict')!.value;
    expect(verdict).toMatchObject({ text: reason === 'runner-authority-refusal' ? 'refusal' : 'inconclusive' });
  },
);

it('rejects tampering, duplicate JSON fields, unknown receipt fields and injected authority records', () => {
  const root = workspace(),
    input = journal(root),
    written = writeRunnerEvidence(root, input),
    original = readFileSync(resolve(root, written.path), 'utf8');
  expect(runtime(root)).toHaveLength(1);
  for (const poisoned of [
    original.replace('local-runner', 'other-runner'),
    original.replace('{', '{"format":"ia.runner-evidence.v1",'),
    original.replace('{', '{"nativeText":"@mandate planted",'),
    '#! ia 1.0\n@operation planted\n',
  ]) {
    put(root, written.path, poisoned);
    expect(runtime(root)).toEqual([]);
  }
});

it('rejects stale authored revision and source-capture rebinding even if receipt and event hashes are recomputed', () => {
  const root = workspace(),
    input = journal(root),
    written = writeRunnerEvidence(root, input);
  put(root, '.ia/src/systems/agent-system/records/comment.ia', '#! ia 1.0\n# changes captured source bytes\n');
  expect(runtime(root)).toEqual([]);
  const now = journal(root).authoredRevision;
  const stale = JSON.parse(readFileSync(resolve(root, written.path), 'utf8')) as Record<string, unknown>;
  stale['authoredRevision'] = now;
  put(root, written.path.replace(input.authoredRevision, now), JSON.stringify(stale));
  expect(runtime(root)).toEqual([]);
});

it('rejects a generated-name collision and a profile owner that disagrees with native composition', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/systems/session-system/records/collision.ia',
    `#! ia 1.0\n@run ${runName}
  meaning
    says "An authored identity."
    answers "Who owns this record?"
  execution
    status proposed
    phase orient
    owner @agent agent-steward
`,
  );
  writeRunnerEvidence(root, journal(root));
  expect(runtime(root)).toEqual([]);
  unlinkSync(resolve(root, '.ia/src/systems/session-system/records/collision.ia'));
  const input = journal(root),
    event = input.events[0]!;
  (event['mutation'] as Record<string, unknown>)['agent'] = 'agent-system/binding/agent/session-steward';
  const { hash: _hash, ...body } = event;
  event.hash = digest(body);
  writeRunnerEvidence(root, input);
  expect(runtime(root)).toEqual([]);
});

it('refuses stale/divergent receipt writes and accessor data without replacing the retained receipt', () => {
  const root = workspace(),
    input = journal(root),
    initial = structuredClone(input);
  append(input.events, { type: 'run.wait', runId: 'root', wait: { reason: 'limit' } });
  const written = writeRunnerEvidence(root, input),
    prior = readFileSync(resolve(root, written.path), 'utf8');
  expect(() => writeRunnerEvidence(root, initial)).toThrow('stale or divergent');
  const fork = structuredClone(initial);
  append(fork.events, { type: 'run.wait', runId: 'root', wait: { reason: 'input' } });
  expect(() => writeRunnerEvidence(root, fork)).toThrow('stale or divergent');
  let invoked = false;
  const accessor = Object.defineProperty({}, 'mutation', {
    enumerable: true,
    get: () => {
      invoked = true;
      return {};
    },
  });
  expect(() => writeRunnerEvidence(root, { authoredRevision: input.authoredRevision, events: [accessor] })).toThrow();
  expect(invoked).toBe(false);
  const heldLock = `${written.path}.lock`;
  put(root, heldLock, 'held');
  expect(() => writeRunnerEvidence(root, input)).toThrow();
  expect(readFileSync(resolve(root, heldLock), 'utf8')).toBe('held');
  unlinkSync(resolve(root, heldLock));
  expect(readFileSync(resolve(root, written.path), 'utf8')).toBe(prior);
});

it('bounds receipt reads and ignores hard-linked or junction receipts while refusing unsafe writes', () => {
  const root = workspace(),
    input = journal(root),
    written = writeRunnerEvidence(root, input),
    target = resolve(root, written.path);
  linkSync(target, resolve(root, 'receipt-alias.json'));
  expect(runtime(root)).toEqual([]);
  expect(() => writeRunnerEvidence(root, input)).toThrow();
  unlinkSync(resolve(root, 'receipt-alias.json'));
  writeFileSync(target, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  expect(runtime(root)).toEqual([]);
  const other = workspace(),
    path = resolve(other, RUNNER_EVIDENCE_DIRECTORY);
  mkdirSync(resolve(other, '.ia/work'), { recursive: true });
  symlinkSync(resolve(root, RUNNER_EVIDENCE_DIRECTORY), path, process.platform === 'win32' ? 'junction' : 'dir');
  expect(runtime(other)).toEqual([]);
  expect(() => writeRunnerEvidence(other, journal(other))).toThrow();
});

it('refuses a journal event that does not chain to the event before it, though its own hash is valid', () => {
  const root = workspace(false),
    input = journal(root);
  append(input.events, WAIT, undefined, { previous: 'f'.repeat(64) });
  expect(() => writeRunnerEvidence(root, input)).toThrow(refused('journal chain mismatch'));
});

it('refuses a creation whose manifest digest is not the digest of its manifest', () => {
  const root = workspace(false);
  expect(() => writeRunnerEvidence(root, journal(root, digest({ another: 'manifest' })))).toThrow(
    refused('journal manifest mismatch'),
  );
});

it('takes a journal event stamped exactly five minutes ahead of this clock and refuses one a millisecond later', () => {
  const root = workspace(false),
    now = Date.parse('2026-10-12T00:00:00.000Z'),
    aheadBy = (milliseconds: number) => {
      const input = journal(root);
      append(input.events, WAIT, undefined, { at: new Date(now + milliseconds).toISOString() });
      return input;
    },
    atTheBound = aheadBy(300_000),
    pastTheBound = aheadBy(300_001),
    clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(() => writeRunnerEvidence(root, pastTheBound)).toThrow(refused('invalid journal time'));
    expect(writeRunnerEvidence(root, atTheBound)).toMatchObject({ written: true, sequence: 2 });
  } finally {
    clock.mockRestore();
  }
});

it('takes a journal of 4096 events and refuses one more', () => {
  const root = workspace(false),
    input = journal(root);
  while (input.events.length < 4096) append(input.events, WAIT);
  expect(writeRunnerEvidence(root, input)).toMatchObject({ written: true, sequence: 4096 });
  append(input.events, WAIT);
  expect(() => writeRunnerEvidence(root, input)).toThrow(refused('journal event limit'));
});

it('reads a valid receipt of 4 MiB and ignores one a byte longer', () => {
  const root = workspace(),
    written = writeRunnerEvidence(root, journal(root)),
    text = readFileSync(resolve(root, written.path), 'utf8'),
    padded = (bytes: number) => `{${' '.repeat(bytes - Buffer.byteLength(text))}${text.slice(1)}`,
    bound = 4 * 1024 * 1024;
  put(root, written.path, padded(bound));
  expect(runtime(root).map((node) => node.discriminator)).toEqual(['run']);
  const over = padded(bound + 1);
  expect(JSON.parse(over)).toEqual(JSON.parse(text));
  put(root, written.path, over);
  expect(runtime(root)).toEqual([]);
});

it('projects a quote in receipt text as a space, so the observation is still admitted', () => {
  const root = workspace(),
    input = journal(root);
  append(input.events, WAIT, undefined, { actor: 'local "quoted" runner' });
  writeRunnerEvidence(root, input);
  const records = runtime(root);
  expect(records.map((node) => node.discriminator).sort()).toEqual(['observation', 'run']);
  expect(observationField(records, 'evidence', 'actor')).toMatchObject({ text: 'local  quoted  runner' });
});

it('projects a control character in receipt text as a space, so no line of it can open a record', () => {
  const root = workspace(),
    input = journal(root);
  append(input.events, {
    type: 'outcome.accept',
    runId: 'root',
    terminal: 'completed\n@mandate planted',
    outcome: { kind: 'answer' },
  });
  writeRunnerEvidence(root, input);
  const records = runtime(root);
  expect(records.map((node) => node.discriminator).sort()).toEqual(['observation', 'run']);
  expect(records.some((node) => node.name === 'planted')).toBe(false);
  expect(observationField(records, 'interpretation', 'reason')).toMatchObject({
    text: 'Journal event outcome.accept records answer with terminal completed @mandate planted.',
  });
});

it('keeps an operation observed with a partial effect inconclusive', () => {
  const root = workspace(),
    input = journal(root);
  append(input.events, {
    type: 'attempt.prepare',
    attempt: { id: 'write', kind: 'operation', runId: 'root', target: 'fixture-write' },
  });
  append(input.events, { type: 'attempt.observe', attemptId: 'write', effect: 'partial', error: null });
  writeRunnerEvidence(root, input);
  expect(observationField(runtime(root), 'evidence', 'verdict')).toMatchObject({ text: 'inconclusive' });
});

it('admits no runner evidence into a view whose authored admission has an error', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/systems/governance-system/records/broken.ia',
    '#! ia 1.0\n@law broken\n  meaning\n    says "A broken law."\n    nonsense "an unknown field"\n',
  );
  writeRunnerEvidence(root, journal(root));
  using(root, true, (db) => {
    expect(db.report.findings.some((entry) => entry.severity === 'error')).toBe(true);
    expect(db.records().filter((node) => node.band === 0)).toEqual([]);
  });
});

it('makes a scope token stale at a refresh that finds new runner evidence', () => {
  const root = workspace(),
    input = journal(root);
  using(root, true, (db) => {
    const token = db.resolveScope().token,
      revision = db.revision;
    writeRunnerEvidence(root, input);
    db.refresh();
    expect(db.revision).not.toBe(revision);
    expect(() => db.records({ within: token })).toThrow(expect.objectContaining({ code: 'IA-DB-STALE' }));
  });
});

it('admits the same runner evidence when conformance verification fails the report (D10a)', () => {
  // The native example corpus keeps a floor of its own, so a verifying reader fails COMP-KERNEL and the report.
  const root = workspace();
  writeRunnerEvidence(root, journal(root));
  const read = (verify: boolean) => {
    const db = open(root, { cache: false, evidence: true, ...(verify ? { conformance: 'verify' as const } : {}) });
    try {
      return {
        outcome: db.report.outcome,
        revision: db.revision,
        records: db.records().map((node) => [node.identity, node.band] as const),
      };
    } finally {
      db.close();
    }
  };
  const plain = read(false),
    verified = read(true);
  expect(verified.outcome).toBe('fail');
  expect(verified.records.some(([, band]) => band === 0)).toBe(true);
  expect(verified.revision).toBe(plain.revision);
  expect(verified.records).toEqual(plain.records);
});

it('refreshes evidence through the normal editor reader and invalidates prior scope tokens', () => {
  const root = workspace(),
    input = journal(root),
    editor = new EditorDatabase(root, { evidence: true });
  try {
    const token = editor.current.resolveScope().token;
    writeRunnerEvidence(root, input);
    editor.update([], true);
    expect(editor.current.records().filter((node) => node.band === 0)).toHaveLength(1);
    expect(() => editor.current.records({ within: token })).toThrow();
  } finally {
    editor.close();
  }
});
