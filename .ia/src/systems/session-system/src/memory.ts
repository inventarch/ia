import { randomUUID } from 'node:crypto';
import { copy, requireValue } from './codec.js';
import {
  admissionGate,
  admit,
  assertOwner,
  checkpointAdmission,
  commitAdmission,
  duplicate,
  JournalStore,
} from './store.js';
import type {
  AdmissionGate,
  Checkpoint,
  Command,
  CommandResult,
  Event,
  Journal,
  JournalBackend,
  Owner,
  Session,
} from './types.js';

export interface MemoryBackendOptions {
  /** Host admission gate run before every commit and checkpoint write (see `Admission`). Present means required: anything but a function refuses. */ admit?: AdmissionGate;
}
/** Deterministic conformance adapter; it makes no durability claim. */
export class MemoryBackend implements JournalBackend {
  readonly journals = new Map<string, Journal>();
  readonly admission: boolean;
  private readonly owners = new Map<string, Owner>();
  private readonly gate: AdmissionGate | undefined;
  private fence = 0;
  constructor(options: MemoryBackendOptions = {}) {
    this.gate = admissionGate(options);
    this.admission = this.gate !== undefined;
  }
  async load(id: string): Promise<Journal | null> {
    return copy(this.journals.get(id) ?? null);
  }
  async commit(command: Command, hash: string, events: Event[], owner?: Owner, next?: Session): Promise<CommandResult> {
    assertOwner(command, owner);
    if (owner) await this.validate(owner);
    const journal = this.journals.get(command.sessionId) ?? { events: [], commands: {}, checkpoint: null };
    const prior = duplicate(journal, command, hash);
    if (prior) return prior;
    requireValue(journal.events.length === command.expected, 'IA-SESSION-REVISION-CONFLICT', 'Session changed');
    admit(this.gate, () => commitAdmission(command, events, owner, next));
    const last = events.at(-1)!;
    const result = { id: command.id, digest: hash, sequence: last.sequence, hash: last.hash };
    this.journals.set(
      command.sessionId,
      copy({
        ...journal,
        events: [...journal.events, ...events],
        commands: { ...journal.commands, [command.id]: result },
      }),
    );
    return result;
  }
  async checkpoint(id: string, checkpoint: Checkpoint, owner: Owner): Promise<void> {
    await this.validate(owner);
    requireValue(owner.sessionId === id, 'IA-SESSION-OWNER-LOST', 'Wrong session owner');
    const journal = this.journals.get(id)!;
    requireValue(journal.events.length === checkpoint.sequence, 'IA-SESSION-REVISION-CONFLICT', 'Session changed');
    admit(this.gate, () => checkpointAdmission(checkpoint, owner));
    journal.checkpoint = copy(checkpoint);
  }
  async acquire(id: string): Promise<Owner> {
    requireValue(!this.owners.has(id), 'IA-SESSION-OWNER-BUSY', 'Session has an owner');
    const owner = { sessionId: id, token: randomUUID(), fence: ++this.fence };
    this.owners.set(id, owner);
    return copy(owner);
  }
  async validate(owner: Owner): Promise<void> {
    requireValue(
      this.owners.get(owner.sessionId)?.token === owner.token &&
        this.owners.get(owner.sessionId)?.fence === owner.fence,
      'IA-SESSION-OWNER-LOST',
      'Session ownership lost',
    );
  }
  async release(owner: Owner): Promise<void> {
    await this.validate(owner);
    this.owners.delete(owner.sessionId);
  }
  async close(): Promise<void> {
    this.owners.clear();
  }
}
export function memoryStore(options: MemoryBackendOptions = {}): JournalStore {
  return new JournalStore(new MemoryBackend(options));
}
