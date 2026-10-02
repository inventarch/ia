// Implements service-host-extraction-and-mcp-design SH-06/07; AW-11/12.
// Browser-safe structural contracts. Native admission and execution remain with their owners.
import { z } from 'zod';
export { z } from 'zod';

export const SERVICE_VERSION = 1 as const;
export const LIMITS = Object.freeze({
  requestBytes: 768 * 1024,
  responseBytes: 256 * 1024,
  pageItems: 100,
  offerings: 100,
  operations: 32,
});
export const id = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const empty = z.strictObject({});
export const jsonValue = z.json();
export const schemaDocument = z.record(z.string(), jsonValue);
export const binding = z.strictObject({ provider: id, offering: id, workspaceView: id, revision: id, digest });
export type Binding = z.infer<typeof binding>;
export const evidenceReference = z.strictObject({
  id,
  digest,
  kind: z.enum(['source', 'artifact', 'receipt', 'public-contract']),
});
export const operationDescriptor = z.strictObject({
  id,
  input: schemaDocument,
  output: schemaDocument,
  effects: z
    .array(z.enum(['read', 'model', 'write', 'external-write']))
    .min(1)
    .max(4),
  outcomes: z.array(id).min(1).max(32),
  waits: z.array(id).max(32),
  cancellation: z.enum(['none', 'intent']),
  resume: z.boolean(),
  maxInputBytes: z.number().int().positive().max(LIMITS.requestBytes),
  maxOutputBytes: z.number().int().positive().max(LIMITS.responseBytes),
});
export const offeringDescriptor = z.strictObject({
  ...binding.shape,
  version: z.literal(SERVICE_VERSION),
  title: z.string().min(1).max(160),
  origin: z.string().url().max(2048),
  mode: z.enum(['source', 'hosted', 'hybrid']),
  execution: z.enum(['read-only', 'request-driven', 'standalone-worker', 'durable-worker']),
  prerequisites: z.array(evidenceReference).max(100),
  operations: z.array(operationDescriptor).min(1).max(LIMITS.operations),
});
export type OfferingDescriptor = z.infer<typeof offeringDescriptor>;
export const invocation = z.strictObject({ binding, operation: id, input: jsonValue });
export type Invocation = z.infer<typeof invocation>;
// Attachment is a pinned consumer selection, not registration, grants or an event subscription.
export const attachment = z.strictObject({ version: z.literal(1), binding, attachedAt: z.string().datetime() });
export const sessionRequest = z.strictObject({ sessionId: id });
export const eventRequest = z.strictObject({ sessionId: id, cursor: z.string().min(1).max(2048).optional() });
export const publicSession = z.strictObject({
  version: z.literal(1),
  id,
  sequence: z.number().int().nonnegative(),
  state: z.enum(['active', 'waiting', 'paused', 'completed', 'cancelled', 'failed', 'unavailable']),
  resumable: z.boolean(),
  evidence: z.array(evidenceReference).max(100),
  // Counts and states only. Model text, manifests, grants and internal IDs need separate publication.
  pendingQuestions: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(),
});
export const publicEvent = z.strictObject({ sequence: z.number().int().positive(), kind: id });
export const publicEvents = z.strictObject({
  items: z.array(publicEvent).max(LIMITS.pageItems),
  next: z.string().max(2048).nullable(),
  complete: z.boolean(),
});
export type PublicSession = z.infer<typeof publicSession>;
// A capture is supplied data, never a server filesystem path. Its owning native adapter
// verifies the complete capture schema, canonical revision and semantic admission.
export const captureRequest = z.strictObject({ capture: z.record(z.string(), jsonValue) });
export const captureReceipt = z.strictObject({ id: digest });
const boundedText = z.string().min(1).max(16_384).regex(/\S/);
const positiveRevision = z.number().int().positive();
export const nativeStartRequest = z.strictObject({
  id,
  commandId: id,
  captureId: digest,
  task: boundedText,
  entry: z.enum(['author', 'architect', 'system-architect']).optional(),
});
export const sessionAdvanceRequest = z.strictObject({
  sessionId: id,
  commandId: id,
  expectedSequence: z.number().int().nonnegative(),
});
export const sessionRecoverRequest = z.strictObject({
  sessionId: id,
  commandId: id,
  expectedSequence: z.number().int().nonnegative(),
  token: digest,
});
export const publicRecovery = z.strictObject({
  sessionId: id,
  sequence: z.number().int().nonnegative(),
  reason: z.enum([
    'model-error',
    'invalid-model-action',
    'operation-error',
    'effect-uncertain',
    'allowance-exhausted',
    'budget-exhausted',
    'source-changed',
    'authority-denied',
    'control-pending',
    'no-recovery',
    'unsupported-recovery',
    'execution-pending',
  ]),
  remainingAttempts: z.number().int().nonnegative(),
  action: z.strictObject({ kind: z.enum(['repair', 'retry']), token: digest }).nullable(),
});
export type PublicRecovery = z.infer<typeof publicRecovery>;
export type SessionRecoverRequest = z.infer<typeof sessionRecoverRequest>;
export const exactQuestionReply = z.strictObject({
  sessionId: id,
  commandId: id,
  questionId: id,
  revision: positiveRevision,
  digest,
  answer: jsonValue,
});
export const exactProposalReview = z.strictObject({
  sessionId: id,
  commandId: id,
  proposalId: id,
  revision: positiveRevision,
  digest,
  accept: z.boolean(),
  rationale: boundedText,
});
export const sessionControlRequest = z.strictObject({
  sessionId: id,
  commandId: id,
  kind: z.enum(['pause', 'cancel', 'resume']),
});
export const publicControlReceipt = z.strictObject({
  session: publicSession,
  commandId: id,
  kind: sessionControlRequest.shape.kind,
  status: z.enum(['recorded', 'applied']),
});
// Text and candidates are separately authorized publications, not journal projections.
// Schemas constrain shape; the consuming host must check disclosure and evidence policy.
export const publicQuestion = z.strictObject({
  id,
  revision: positiveRevision,
  digest,
  prompt: boundedText,
  choices: z.array(z.string().max(2048)).max(32),
  required: z.boolean(),
});
export const publicProposal = z.strictObject({
  id,
  revision: positiveRevision,
  digest,
  candidate: jsonValue,
  status: z.enum(['offered', 'accepted', 'rejected', 'superseded', 'expired']),
});
export const publicPending = z.strictObject({
  sessionId: id,
  questions: z.array(publicQuestion).max(LIMITS.pageItems),
  proposals: z.array(publicProposal).max(LIMITS.pageItems),
});
export const publicResult = z.strictObject({
  sessionId: id,
  state: publicSession.shape.state,
  outcome: z
    .strictObject({ summary: boundedText, evidence: z.array(evidenceReference).max(LIMITS.pageItems) })
    .nullable(),
  proposals: z.array(publicProposal).max(LIMITS.pageItems),
});
export type PublicPending = z.infer<typeof publicPending>;
export type PublicResult = z.infer<typeof publicResult>;
export const errorCategory = z.enum([
  'invalid',
  'unauthenticated',
  'forbidden',
  'not-found',
  'conflict',
  'expired',
  'quota',
  'unavailable',
  'internal',
]);
export type ErrorCategory = z.infer<typeof errorCategory>;
export const status: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  expired: 410,
  quota: 429,
  unavailable: 503,
  internal: 500,
});
export class ServiceError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
export const errorResult = z.strictObject({ code: id, category: errorCategory, message: z.string().max(500) });
export function failure(error: unknown): z.infer<typeof errorResult> {
  return error instanceof ServiceError
    ? { code: error.code, category: error.category, message: error.message.slice(0, 500) }
    : { code: 'internal', category: 'internal', message: 'The operation could not be completed' };
}
export function decode<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError('invalid', 'invalid-request', 'Expected exact fields and typed values');
  return result.data;
}
/** JSON Schema draft-07, also embedded in OpenAPI 3.1 and MCP tool metadata. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' });
}
