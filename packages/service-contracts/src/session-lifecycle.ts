// Browser-safe session discovery and explicit human-wait continuity (WT-04/06/07).
import { z } from 'zod';
import { id, LIMITS, nativeStartRequest, publicSession } from './index.js';
import { sourceReference } from './sources.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const deadline = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const token = z.string().min(1).max(2048);
export const sessionListRequest = z.strictObject({
  workspaceId: id,
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().positive().max(LIMITS.pageItems).optional(),
});
export const publicSessionSummary = z.strictObject({
  workspaceId: id,
  creator: z.string().min(1).max(512),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: sourceReference.nullable(),
  session: publicSession,
});
export const sessionDirectory = z.strictObject({
  items: z.array(publicSessionSummary).max(LIMITS.pageItems),
  next: z.string().min(1).max(2048).nullable(),
});
export const sessionContinuation = z.strictObject({
  sessionId: id,
  sequence,
  status: z.enum([
    'executable',
    'renewal-required',
    'runtime-incompatible',
    'authority-denied',
    'evidence-unavailable',
    'unsupported-wait',
    'budget-exhausted',
    'terminal',
  ]),
  renewal: z.strictObject({ token, deadline }).nullable(),
});
export const sessionRenewRequest = z.strictObject({ sessionId: id, commandId: id, expectedSequence: sequence, token });
export const sessionContinueRequest = z
  .strictObject({
    sessionId: id,
    id,
    commandId: id,
    expectedSequence: sequence,
    task: nativeStartRequest.shape.task,
    entry: nativeStartRequest.shape.entry,
  })
  .refine((value) => value.sessionId !== value.id, 'Continuation requires a new session identity');
export type SessionListRequest = z.infer<typeof sessionListRequest>;
export type PublicSessionSummary = z.infer<typeof publicSessionSummary>;
export type SessionDirectoryView = z.infer<typeof sessionDirectory>;
export type SessionContinuation = z.infer<typeof sessionContinuation>;
export type SessionRenewRequest = z.infer<typeof sessionRenewRequest>;
export type SessionContinueRequest = z.infer<typeof sessionContinueRequest>;
