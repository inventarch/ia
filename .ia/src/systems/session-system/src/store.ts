import { copy, digest, identifier, requireValue } from './codec.js';
import { eventFor, replay } from './reducer.js';
import type {
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
/** Validated append-only journal with a replaceable transactional persistence adapter. */
export class JournalStore implements SessionStore {
  constructor(
    private readonly backend: JournalBackend,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
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
    return this.backend.commit(command, hash, events, owner);
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
