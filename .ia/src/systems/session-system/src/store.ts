import { copy, digest, identifier, requireValue, SessionError } from './codec.js';
import { eventFor, replay } from './reducer.js';
import type {
  Admission,
  AdmissionGate,
  Checkpoint,
  Command,
  CommandResult,
  Event,
  Journal,
  JournalBackend,
  Owner,
  Session,
  SessionStore,
} from './types.js';

const inbox = new Set([
  'session.create',
  'question.reply',
  'proposal.review',
  'decision.record',
  'control.submit',
  'budget.extend',
]);
export function commandDigest(command: Command): string {
  const { id: _id, expected: _expected, ...content } = command;
  return digest(content);
}
export function assertOwner(command: Command, owner?: Owner): void {
  requireValue(
    (!command.following?.length && inbox.has(command.mutation.type)) || owner?.sessionId === command.sessionId,
    'IA-SESSION-OWNER-REQUIRED',
    'Scheduler mutation requires current ownership',
  );
}
export function duplicate(journal: Journal | null, command: Command, hash: string): CommandResult | null {
  const result = journal?.commands[command.id];
  requireValue(
    !result || result.digest === hash,
    'IA-SESSION-COMMAND-CONFLICT',
    'Command ID already has different content',
  );
  return result ? copy(result) : null;
}
/** A backend's configured gate. A configured `admit` is required, so anything but a function refuses. */
export function admissionGate(options: { admit?: AdmissionGate }): AdmissionGate | undefined {
  if (!('admit' in options)) return undefined;
  requireValue(
    typeof options.admit === 'function',
    'IA-SESSION-ADMISSION-UNAVAILABLE',
    'Configured admission gate is not a function',
  );
  return options.admit;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const outputs = new Set(['attempt.observe', 'attempt.reconcile']);
export function commitAdmission(command: Command, events: Event[], owner?: Owner, next?: Session): Admission {
  requireValue(next, 'IA-SESSION-ADMISSION-DENIED', 'Commit offered without its resulting session');
  const observed = new Set(
    events.flatMap(({ mutation }) =>
      outputs.has(mutation.type) ? [(mutation as { attemptId: string }).attemptId] : [],
    ),
  );
  return {
    kind: 'commit',
    sessionId: command.sessionId,
    principal: next.principal,
    fence: owner?.fence ?? null,
    command,
    events,
    state: next,
    observed: [...observed].map((id) => next.attempts[id]!),
  };
}
/** A checkpoint restates history its commits already admitted, so it offers no observed attempts. */
export function checkpointAdmission(checkpoint: Checkpoint, owner: Owner): Admission {
  const state = checkpoint.state;
  return {
    kind: 'checkpoint',
    sessionId: state.id,
    principal: state.principal,
    fence: owner.fence,
    command: null,
    events: [],
    state,
    observed: [],
  };
}
/**
 * Asks the host gate synchronously, after every awaited check and before the first write; the caller writes and
 * commits without yielding. Only `true` admits, and the refusal never carries the offer or the host's error.
 */
export function admit(gate: AdmissionGate | undefined, offer: () => Admission): void {
  if (!gate) return;
  let decision: unknown;
  try {
    decision = gate(freeze(copy(offer())));
    // A promise never admits. Observe its rejection through the intrinsic `then`, which accepts a promise from any
    // realm, ignores its own methods and throws for anything else, so a refused gate cannot crash the host. Not
    // util.types.isPromise: importing node:util prints a colour warning on stderr when NO_COLOR and FORCE_COLOR are
    // both set, and installed CLIs load this module on every command.
    if (decision !== null && (typeof decision === 'object' || typeof decision === 'function'))
      Promise.prototype.then.call(decision, undefined, () => undefined);
  } catch {
    decision = undefined;
  }
  if (decision !== true) throw new SessionError('IA-SESSION-ADMISSION-DENIED', 'Host admission refused the write');
}
/** Validated append-only journal with a replaceable transactional persistence adapter. */
export class JournalStore implements SessionStore {
  constructor(
    private readonly backend: JournalBackend,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  get admission(): boolean {
    return this.backend.admission === true;
  }
  async journal(id: string): Promise<Journal> {
    identifier(id);
    const journal = await this.backend.load(id);
    requireValue(journal, 'IA-SESSION-NOT-FOUND', 'Session does not exist');
    return copy(journal);
  }
  async read(id: string): Promise<Session> {
    const journal = await this.journal(id);
    // The complete journal is authoritative. Invalid/missing checkpoints fall back to replay.
    const state = replay(journal.events);
    requireValue(state.id === id, 'IA-SESSION-STORE-CORRUPT', 'Journal/session identity mismatch');
    return state;
  }
  async command(command: Command, owner?: Owner): Promise<CommandResult> {
    identifier(command.id);
    identifier(command.sessionId);
    copy(command);
    requireValue(
      Number.isSafeInteger(command.expected) && command.expected >= 0,
      'IA-SESSION-INPUT-INVALID',
      'Invalid expected revision',
    );
    assertOwner(command, owner);
    if (owner) await this.backend.validate(owner);
    const journal = await this.backend.load(command.sessionId),
      hash = commandDigest(command);
    const prior = duplicate(journal, command, hash);
    if (prior) return prior;
    let state = journal ? replay(journal.events) : null;
    requireValue(command.expected === (state?.sequence ?? 0), 'IA-SESSION-REVISION-CONFLICT', 'Session changed');
    const events: Event[] = [],
      mutations = [command.mutation, ...(command.following ?? [])];
    requireValue(mutations.length <= 32, 'IA-SESSION-LIMIT-EXCEEDED', 'Too many atomic consequences');
    for (const mutation of mutations) {
      if (mutation.type === 'session.create')
        requireValue(mutation.sessionId === command.sessionId, 'IA-SESSION-INPUT-INVALID', 'Session identity mismatch');
      const event = eventFor(state, { ...command, expected: state?.sequence ?? 0, mutation }, this.now());
      state = replay([event], state);
      events.push(event);
      requireValue(
        state.budget.retainedBytes <= state.limits.bytes,
        'IA-SESSION-LIMIT-EXCEEDED',
        'Journal byte budget exhausted',
      );
      requireValue(
        Object.values(state.runs).every((run) => !run.limits || (run.retainedBytes ?? 0) <= run.limits.bytes),
        'IA-SESSION-LIMIT-EXCEEDED',
        'Run journal byte budget exhausted',
      );
    }
    return this.backend.commit(command, hash, events, owner, state ?? undefined);
  }
  async checkpoint(id: string, owner: Owner): Promise<Checkpoint> {
    const state = await this.read(id);
    const value: Checkpoint = {
      version: 1,
      sequence: state.sequence,
      hash: state.hash,
      stateDigest: digest(state),
      state,
    };
    await this.backend.checkpoint(id, value, owner);
    return copy(value);
  }
  acquire(id: string): Promise<Owner> {
    identifier(id);
    return this.backend.acquire(id);
  }
  release(owner: Owner): Promise<void> {
    return this.backend.release(owner);
  }
  validate(owner: Owner): Promise<void> {
    return this.backend.validate(owner);
  }
  close(): Promise<void> {
    return this.backend.close();
  }
}
