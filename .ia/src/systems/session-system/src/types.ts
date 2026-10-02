/** Versioned storage messages. This module deliberately has no engine/provider imports. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type Effect = 'none' | 'applied' | 'partial' | 'unknown';
export type Recovery = 'repeatable' | 'idempotent' | 'reconcile' | 'manual';
export interface Limits {
  steps: number;
  modelCalls: number;
  operations: number;
  tokens: number;
  children: number;
  depth: number;
  bytes: number;
  deadline: number;
}
export interface Budget {
  usedTokens: number;
  reservedTokens: number;
  steps: number;
  modelCalls: number;
  operations: number;
  children: number;
  retainedBytes: number;
}
export interface Wait {
  id: string;
  reason: string;
  objectIds: string[];
  continuation: string;
  details: Json;
}
export interface CausalReferences {
  actionId: string;
  modelAttemptId: string | null;
  questions: string[];
  proposals: string[];
  decisions: string[];
  receipts: string[];
}
export interface ReviewContract {
  reviewer: string;
  rule: string;
  expiresAt: number;
  operation: string;
  bindingDigest: string;
  inputDigest: string;
  candidateDigest: string;
  artifactDigest: string;
  destination: Json;
  effect: 'local-write' | 'external-write';
  validationReceipt: string;
}
export interface Run {
  id: string;
  parentId: string | null;
  profile: string;
  agent: string;
  task: Json;
  depth: number;
  status: RunStatus;
  wait: Wait | null;
  outcome: Json | null;
  pendingAction: Json | null;
  returned: boolean;
  cancelRequested: boolean;
  pauseRequested: boolean;
  transcript: Json[];
  contract?: Json;
  authority?: Json;
  limits?: Limits;
  retainedBytes?: number;
  cause?: CausalReferences;
  retryOf?: string;
  repairs?: number;
}
export interface Attempt {
  id: string;
  invocationId: string;
  runId: string;
  kind: 'model' | 'operation' | 'reconcile';
  target: string;
  bindingDigest: string;
  input: Json;
  inputDigest: string;
  authority: Json;
  recovery: Recovery;
  status: 'prepared' | 'dispatched' | 'observed';
  reservation: number;
  effect: Effect;
  actionAccepted: boolean;
  output: Json | null;
  error: string | null;
  usage: number | null;
  preparedAt: string;
  observedAt: string | null;
  cause?: CausalReferences;
  review?: ReviewContract & { proposalId: string; revision: number; digest: string; decisionId: string };
  preparedSequence?: number;
  reconciliations?: number;
}
export interface Question {
  id: string;
  revision: number;
  runId: string;
  prompt: string;
  respondent: string;
  required: boolean;
  choices: string[];
  answer: Json | null;
  status: 'open' | 'answered' | 'withdrawn' | 'superseded';
  digest: string;
  cause?: CausalReferences;
}
export interface Proposal {
  id: string;
  revision: number;
  runId: string;
  candidate: Json;
  digest: string;
  status: 'offered' | 'accepted' | 'rejected' | 'superseded' | 'expired';
  decisionId: string | null;
  review?: ReviewContract;
  cause?: CausalReferences;
}
export interface Decision {
  id: string;
  runId: string;
  subject: string;
  revision: number;
  choice: string;
  actor: string;
  rationale: string;
  evidence: string[];
  review?: ReviewContract;
  proposalDigest?: string;
}
export interface Reaction {
  id: string;
  cause: string;
  binding: string;
  runId: string;
  input: Json;
  required: boolean;
  status: 'queued' | 'settled';
  result: Json | null;
}
export interface Control {
  id: string;
  actor: string;
  kind: 'pause' | 'cancel' | 'resume';
  runId: string;
  applied: boolean;
}
export interface Receipt {
  version: 1;
  id: string;
  sessionId: string;
  runId: string;
  actionId: string;
  invocationId: string;
  attemptId: string;
  sequence: number;
  target: string;
  bindingDigest: string;
  inputDigest: string;
  authority: Json;
  effect: Effect;
  output: Json | null;
  error: string | null;
  usage: number | null;
  at: string;
  reconciles: string | null;
  cause?: CausalReferences;
  review?: Attempt['review'];
}
export interface Session {
  version: 1;
  id: string;
  principal: string;
  workspace: string;
  manifestDigest: string;
  manifest: Json;
  createdAt: string;
  rootId: string;
  sequence: number;
  hash: string;
  limits: Limits;
  budget: Budget;
  runs: Record<string, Run>;
  attempts: Record<string, Attempt>;
  questions: Record<string, Question>;
  proposals: Record<string, Proposal>;
  decisions: Record<string, Decision>;
  reactions: Record<string, Reaction>;
  controls: Control[];
  receipts: Receipt[];
}
export type Mutation =
  | {
      type: 'session.create';
      sessionId: string;
      principal: string;
      workspace: string;
      manifestDigest: string;
      manifest: Json;
      rootId: string;
      profile: string;
      agent: string;
      task: Json;
      limits: Limits;
      contract?: Json;
      authority?: Json;
    }
  | { type: 'run.ready'; runId: string }
  | {
      type: 'attempt.prepare';
      attempt: Omit<
        Attempt,
        'status' | 'effect' | 'actionAccepted' | 'output' | 'error' | 'usage' | 'preparedAt' | 'observedAt'
      >;
    }
  | { type: 'attempt.dispatch'; attemptId: string }
  | { type: 'attempt.abandon'; attemptId: string }
  | {
      type: 'attempt.observe';
      attemptId: string;
      output: Json | null;
      effect: Effect;
      error: string | null;
      usage: number | null;
      reconciles?: string;
    }
  | { type: 'action.accept'; runId: string; action: Json; attemptId: string; cause?: CausalReferences }
  | { type: 'attempt.retry'; attemptId: string; action: Json; maxAttempts: number }
  | { type: 'model.repair'; attemptId: string; allowance: number; details?: Json }
  | { type: 'action.clear'; runId: string }
  | { type: 'run.wait'; runId: string; wait: Wait }
  | {
      type: 'outcome.accept';
      runId: string;
      outcome: Json;
      terminal: 'completed' | 'failed' | null;
      questions?: Question[];
      proposal?: Proposal;
      wait?: Wait;
    }
  | { type: 'question.reply'; questionId: string; revision: number; digest: string; answer: Json }
  | {
      type: 'proposal.review';
      proposalId: string;
      revision: number;
      digest: string;
      accept: boolean;
      decisionId: string;
      rationale: string;
    }
  | { type: 'decision.record'; decision: Decision }
  | {
      type: 'child.create';
      parentId: string;
      childId: string;
      profile: string;
      agent: string;
      task: Json;
      contract?: Json;
      authority?: Json;
      limits?: Limits;
      cause?: CausalReferences;
    }
  | { type: 'child.return'; childId: string }
  | { type: 'control.submit'; control: Control }
  | { type: 'control.apply'; controlId: string }
  | { type: 'session.rebind'; manifestDigest: string; manifest: Json }
  | {
      type: 'session.renew';
      expectedSequence: number;
      previousDeadline: number;
      deadline: number;
      runs: Record<string, { previousDeadline: number; deadline: number }>;
    }
  | { type: 'budget.extend'; limits: Limits }
  | { type: 'reaction.queue'; reaction: Reaction }
  | { type: 'reaction.settle'; reactionId: string; result: Json }
  | { type: 'attempt.reconcile.start'; attemptId: string; maxAttempts: number }
  | {
      type: 'attempt.reconcile';
      attemptId: string;
      effect: Effect;
      output: Json | null;
      evidence: string;
      error?: string | null;
    };
export interface Event {
  version: 1 | 2;
  id: string;
  sequence: number;
  sessionId: string;
  actor: string;
  at: string;
  cause: string | null;
  mutation: Mutation;
  previous: string;
  hash: string;
}
export interface Owner {
  sessionId: string;
  token: string;
  fence: number;
}
export interface Command {
  id: string;
  sessionId: string;
  actor: string;
  expected: number;
  mutation: Mutation;
  cause?: string;
  following?: Mutation[];
}
export interface CommandResult {
  id: string;
  digest: string;
  sequence: number;
  hash: string;
}
export interface Checkpoint {
  version: 1;
  sequence: number;
  hash: string;
  stateDigest: string;
  state: Session;
}
export interface Journal {
  events: Event[];
  commands: Record<string, CommandResult>;
  checkpoint: Checkpoint | null;
}
/** Trusted adapter boundary, not exposed to a model or network caller. */
export interface JournalBackend {
  load(sessionId: string): Promise<Journal | null>;
  commit(command: Command, digest: string, events: Event[], owner?: Owner): Promise<CommandResult>;
  checkpoint(sessionId: string, checkpoint: Checkpoint, owner: Owner): Promise<void>;
  acquire(sessionId: string): Promise<Owner>;
  release(owner: Owner): Promise<void>;
  validate(owner: Owner): Promise<void>;
  close(): Promise<void>;
}
export interface SessionStore {
  read(sessionId: string): Promise<Session>;
  journal(sessionId: string): Promise<Journal>;
  command(command: Command, owner?: Owner): Promise<CommandResult>;
  checkpoint(sessionId: string, owner: Owner): Promise<Checkpoint>;
  acquire(sessionId: string): Promise<Owner>;
  release(owner: Owner): Promise<void>;
  validate(owner: Owner): Promise<void>;
  close(): Promise<void>;
}
