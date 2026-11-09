import type {
  Json,
  Limits,
  Session,
  SessionStore,
  Recovery,
  Effect,
  ReviewContract,
  Owner,
} from '@inventarch/session-system';
import { WRITE_PLAIN_NAMES } from './written-names.js';

export const DEFAULT_MODEL_REQUEST_BYTES = 131_072;
export const MAX_MODEL_REQUEST_BYTES = 262_144;

export type OutcomeKind =
  | 'answer'
  | 'deliverable'
  | 'clarification'
  | 'proposal'
  | 'follow-up'
  | 'handoff'
  | 'blocked'
  | 'refusal'
  | 'failure';
export type ResourceLimits = Partial<Omit<Limits, 'deadline'>> & { durationMs?: number };
/**
 * Rule and evaluator names carry no version: the contract's version is a field. New writes use the plain names.
 * The original literals stay accepted so stored manifests, sessions and reviews written before the rename still
 * verify; this explicit list is compatibility for at least one major release and nothing parses suffixes.
 */
export const INDEPENDENT_REVIEW_RULE = 'independent-exact-candidate' as const;
export const OPERATOR_REVIEW_RULE = 'operator-exact-candidate' as const;
export const COMPLETION_EVALUATOR = 'completion' as const;
export type IndependentReviewRule = typeof INDEPENDENT_REVIEW_RULE | 'independent-exact-candidate-v1';
export type OperatorReviewRule = typeof OPERATOR_REVIEW_RULE | 'operator-exact-candidate-v1';
export type CompletionEvaluatorId = typeof COMPLETION_EVALUATOR | 'ia.completion.v1';
const INDEPENDENT_REVIEW_RULES: readonly unknown[] = [INDEPENDENT_REVIEW_RULE, 'independent-exact-candidate-v1'];
const OPERATOR_REVIEW_RULES: readonly unknown[] = [OPERATOR_REVIEW_RULE, 'operator-exact-candidate-v1'];
const COMPLETION_EVALUATORS: readonly unknown[] = [COMPLETION_EVALUATOR, 'ia.completion.v1'];
export function isIndependentReviewRule(value: unknown): value is IndependentReviewRule {
  return INDEPENDENT_REVIEW_RULES.includes(value);
}
export function isOperatorReviewRule(value: unknown): value is OperatorReviewRule {
  return OPERATOR_REVIEW_RULES.includes(value);
}
export function isCompletionEvaluator(value: unknown): value is CompletionEvaluatorId {
  return COMPLETION_EVALUATORS.includes(value);
}
/** The names a writer emits: the plain ones once `WRITE_PLAIN_NAMES` is flipped, until then the released literals. */
export function writtenCompletionEvaluator(): CompletionEvaluatorId {
  return WRITE_PLAIN_NAMES ? COMPLETION_EVALUATOR : 'ia.completion.v1';
}
export function writtenOperatorReviewRule(): OperatorReviewRule {
  return WRITE_PLAIN_NAMES ? OPERATOR_REVIEW_RULE : 'operator-exact-candidate-v1';
}
/** The rule a review under `policyRule` carries: the policy's own literal until the switch flips, then the plain name. */
export function writtenIndependentReviewRule(policyRule: IndependentReviewRule): IndependentReviewRule {
  return WRITE_PLAIN_NAMES ? INDEPENDENT_REVIEW_RULE : policyRule;
}
export interface IndependentReviewPolicy {
  rule: IndependentReviewRule;
  reviewer: string;
  mandate: string;
  policyRevision: string;
}
/** Issued by trusted host authorization, never by model output or caller-supplied role labels. */
export interface ReviewGrant {
  principal: string;
  workspace: string;
  mandate: string;
  policyRevision: string;
  expiresAt: number;
  operations: string[];
  effects: ('local-write' | 'external-write')[];
  sources: string[];
  destinations: Json[];
}
export interface ExecutionContract {
  review?: IndependentReviewPolicy;
  /** Pinned structural request ceiling; cumulative token accounting remains independent. */
  requestBytes?: number;
  id: string;
  mandateContracts: string[];
  inputContracts: { id: string; schema: Json }[];
  effects: Grant['effects'];
  limits: ResourceLimits;
  delegation: { profile: string; limits: ResourceLimits }[];
  checks: { id: string; phases: ('before-effect' | 'completion')[] }[];
  completionEvaluator: CompletionEvaluatorId;
  repairAttempts: number;
  maxAttempts: number;
}
export interface ArtifactRequirement {
  operation: string;
  destination: Json;
}
export interface TaskContract {
  version: 1;
  objective: Json;
  inputs: { id: string; schema: Json }[];
  outcomes: OutcomeKind[];
  completion: Profile['completion'];
  evaluator: CompletionEvaluatorId;
  escalation: 'persist-required-wait';
  artifact: ArtifactRequirement | null;
}
export interface Profile {
  id: string;
  agent: string;
  role: string;
  voice: string;
  instructions: string[];
  operations: string[];
  capabilities: string[];
  delegates: string[];
  outcomes: OutcomeKind[];
  completion: 'response' | 'proposal' | 'artifact';
  checks: string[];
  model: string;
  contract?: ExecutionContract;
}
export interface OperationDefinition {
  id: string;
  handler: string;
  digest: string;
  effects: ('read' | 'local-write' | 'external-write')[];
  recovery: Recovery;
  timeoutMs: number;
  input: Json;
  output: Json;
  maxOutputBytes?: number;
  purpose?: 'candidate-validation';
}
export interface ReactionBinding {
  id: string;
  event: 'attempt.observed' | 'outcome.accepted' | 'question.answered';
  operation: string;
  required: boolean;
  digest: string;
}
export interface Manifest {
  version: 1;
  id: string;
  digest: string;
  workspace: string;
  sourceDigest: string;
  profiles: Record<string, Profile>;
  operations: Record<string, OperationDefinition>;
  reactions: ReactionBinding[];
  provenance: Json;
}
export interface Grant {
  id: string;
  principal: string;
  workspace: string;
  expiresAt: number;
  profiles: string[];
  operations: string[];
  effects: ('read' | 'local-write' | 'external-write')[];
  sources: string[];
  models: string[];
  limits: Limits;
  destinations?: Json[];
}
export type ModelAction =
  | { type: 'continue'; message: string }
  | {
      type: 'invoke';
      operation: string;
      input: Json;
      review?: { proposalId: string; revision: number; digest: string; decisionId: string };
    }
  | { type: 'delegate'; profile: string; task: Json }
  | {
      type: 'outcome';
      kind: OutcomeKind;
      message: string;
      continuation: 'finish' | 'continue' | 'await-input' | 'await-review' | 'await-dependency' | 'fail';
      questions?: { prompt: string; choices: string[]; required: boolean }[];
      proposal?: Json;
      artifacts?: string[];
      evidence?: string[];
      followUps?: string[];
      review?: { operation: string; input: Json; validationReceipt: string };
    };
export interface ModelRequest {
  version: 1;
  sessionId: string;
  runId: string;
  attemptId: string;
  task: Json;
  profile: Profile;
  history: Json[];
  context: Json;
  operations: OperationDefinition[];
  maxOutputTokens: number;
}
export interface ModelResponse {
  action: unknown;
  usage: number | null;
  provider: string;
  model: string;
}
export interface ModelAdapter {
  id: string;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse | { deferred: true }>;
}
export interface OperationContext {
  sessionId: string;
  runId: string;
  invocationId: string;
  attemptId: string;
  principal: string;
  grant: Grant;
  manifest: Manifest;
  signal: AbortSignal;
  agent?: string;
  owner?: Owner;
  review?: ReviewContract & { proposalId: string; revision: number; digest: string; decisionId: string };
  assertCurrent?: () => Promise<void>;
}
export interface OperationResult {
  output: Json;
  effect: Effect;
}
export interface OperationAdapter {
  id: string;
  execute(input: Json, context: OperationContext): Promise<OperationResult>;
  reconcile?(
    input: Json,
    context: OperationContext,
  ): Promise<{ status: 'absent' | 'applied' | 'partial' | 'unknown'; output: Json | null }>;
}
export interface Evaluation {
  status: 'pass' | 'fail' | 'unavailable';
  evidence: string[];
  message: string;
}
/** Space for the complete context JSON value after the retained request wrapper and history. */
export interface ContextBudget {
  readonly bytes: number;
}
export interface EngineHost {
  store: SessionStore;
  /**
   * When set, Engine refuses with IA-ENGINE-ADMISSION-UNAVAILABLE, at construction and at every later use of a store
   * the host replaces, unless `store` runs a host admission gate on every write (`SessionStore.admission`). A write
   * the store refuses rejects `advance` with the redacted IA-SESSION-ADMISSION-DENIED and nothing more is written; a
   * refused operation result stays dispatched and recovers under its operation's recovery contract.
   */
  requireAdmission?: boolean;
  model: ModelAdapter;
  operations: Readonly<Record<string, OperationAdapter>>;
  authorize(principal: string, manifest: Manifest, session: Session | null): Promise<Grant>;
  /** Current review authority for an identity authenticated by the host. Does not grant session ownership or write authority. */
  authorizeReview?(
    principal: string,
    manifest: Manifest,
    session: Session,
    review: ReviewContract,
  ): Promise<ReviewGrant>;
  /** Explicit fresh authority for a bounded human-wait renewal; ordinary grants never renew. */
  authorizeRenewal?(principal: string, manifest: Manifest, session: Session): Promise<Grant>;
  context(profile: Profile, task: Json, grant: Grant, budget?: ContextBudget): Promise<Json>;
  verifyManifest(manifest: Manifest): Promise<boolean>;
  evaluate(id: string, input: Json, grant: Grant): Promise<Evaluation>;
  /** Current destination/binding check. Required for effects; does not perform the effect. */
  preflight?(operation: OperationDefinition, input: Json, context: OperationContext): Promise<boolean>;
  now?(): number;
}
export interface StartRequest {
  commandId: string;
  sessionId: string;
  principal: string;
  profile: string;
  task: Json;
  limits?: Partial<Limits>;
  artifact?: ArtifactRequirement;
}
