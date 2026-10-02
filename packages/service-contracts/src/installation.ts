// Browser-only installation shapes. Authority and native derivation remain on the host.
import { z } from 'zod';
import { digest, id } from './index.js';
import { distributionLock } from './marketplace.js';
import { sourceAdmission, sourceReceipt, sourceReference } from './sources.js';
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const installationPointer = z.strictObject({
  formatVersion: z.literal(1),
  generation: digest,
  previous: digest.nullable(),
  counter: counter.min(1),
});
export const installationSource = sourceReference.extend({ generation: counter });
export const installationPlanRequest = z.strictObject({
  commandId: id,
  source: installationSource,
  acquisitionId: id,
  operation: z.enum(['install', 'update', 'remove']),
});
export const installationReviewRequest = z.strictObject({
  commandId: id,
  planId: id,
  digest,
  accept: z.boolean(),
  rationale: z
    .string()
    .min(1)
    .max(4096)
    .refine((text) => text.trim().length > 0),
});
export const installationApplyRequest = z.strictObject({ commandId: id, planId: id, digest, decisionId: id });
export const installationChanges = z.strictObject({
  added: z.array(z.string().min(1).max(256)).max(100),
  removed: z.array(z.string().min(1).max(256)).max(100),
  updated: z.array(z.string().min(1).max(256)).max(100),
  shadowed: z.array(z.string().min(1).max(1024)).max(10_000),
});
export const installationPrepared = z.strictObject({
  state: z.literal('prepared'),
  planId: digest,
  digest,
  source: installationSource,
  acquisitionId: id,
  operation: installationPlanRequest.shape.operation,
  previous: installationPointer.nullable(),
  pointer: installationPointer,
  lock: distributionLock,
  nativeDigest: digest,
  policyDigest: digest,
  validator: digest,
  decisionDigest: digest,
  changes: installationChanges,
  admission: sourceAdmission,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export const installationDecision = z.strictObject({
  state: z.enum(['reviewed', 'rejected']),
  planId: digest,
  digest,
  decisionId: digest,
  reviewer: z.string().min(1).max(512),
  accept: z.boolean(),
  rationale: installationReviewRequest.shape.rationale,
  reviewedAt: z.string().datetime(),
});
export const installationReceipt = z.strictObject({
  state: z.literal('applied'),
  planId: digest,
  digest,
  decisionId: digest,
  pointer: installationPointer,
  source: sourceReceipt,
  appliedAt: z.string().datetime(),
});
export const installationInspectRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('plan'), planId: digest }),
]);
export const installationCurrent = z.strictObject({
  kind: z.literal('current'),
  state: z.enum(['absent', 'installed', 'unavailable']),
  planId: digest.nullable(),
  source: sourceReference.nullable(),
  pointer: installationPointer.nullable(),
  lock: distributionLock.nullable(),
});
export const installationInspection = z.strictObject({
  kind: z.literal('plan'),
  state: z.enum(['prepared', 'reviewed', 'rejected', 'applied', 'unavailable']),
  planId: digest,
  prepared: installationPrepared.nullable(),
  decision: installationDecision.nullable(),
  receipt: installationReceipt.nullable(),
});
export const installationInspectResult = z.discriminatedUnion('kind', [installationCurrent, installationInspection]);
export type InstallationPrepared = z.infer<typeof installationPrepared>;
export type InstallationDecision = z.infer<typeof installationDecision>;
export type InstallationReceipt = z.infer<typeof installationReceipt>;
export type InstallationPlanRequest = z.infer<typeof installationPlanRequest>;
export type InstallationInspectResult = z.infer<typeof installationInspectResult>;
