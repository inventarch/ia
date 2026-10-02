// Browser-only shapes. Current authority, exact byte hashes and native admission are host decisions.
import { z } from 'zod';
import { digest, id } from './index.js';
import { SOURCE_LIMITS, sourceAdmission, sourceEntry, sourceReceipt } from './sources.js';
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const sourceChangeCandidate = z
  .strictObject({
    format: z.literal('ia.source-change.v1'),
    workspaceId: id,
    base: z.strictObject({ revisionId: digest.nullable(), generation: counter }),
    changes: z
      .array(
        z
          .strictObject({
            path: sourceEntry.shape.path,
            previous: digest.nullable(),
            next: z
              .strictObject({
                digest,
                text: z
                  .string()
                  .max(SOURCE_LIMITS.sourceBytes)
                  .refine((text) => bytes(text) <= SOURCE_LIMITS.sourceBytes),
              })
              .nullable(),
          })
          .refine((change) => change.next !== null || change.previous !== null, 'An absent file cannot be deleted')
          .refine((change) => change.next?.digest !== change.previous, 'A change must change the exact bytes'),
      )
      .min(1)
      .max(SOURCE_LIMITS.files),
  })
  .refine(
    (value) =>
      value.changes.every((change, index) => index === 0 || value.changes[index - 1]!.path < change.path) &&
      new Set(value.changes.map((change) => change.path.toLowerCase())).size === value.changes.length,
    'Changes must be sorted and distinct',
  )
  .refine(
    (value) =>
      value.changes.reduce((sum, change) => sum + bytes(change.next?.text ?? ''), 0) <= SOURCE_LIMITS.revisionBytes,
    'Candidate byte limit exceeded',
  );
export type SourceChangeCandidate = z.infer<typeof sourceChangeCandidate>;
export const sourceProposalReference = z.strictObject({
  sessionId: id,
  proposalId: id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest,
});
export type SourceProposalReference = z.infer<typeof sourceProposalReference>;
export const sourceApplyPrepareRequest = z.strictObject({ commandId: id, proposal: sourceProposalReference });
export const sourceApplyReviewRequest = z.strictObject({
  commandId: id,
  applicationId: id,
  digest,
  accept: z.boolean(),
  rationale: z.string().min(1).max(4096),
});
export const sourceApplyRequest = z.strictObject({ commandId: id, applicationId: id, digest, decisionId: id });
export const sourceApplyInspectRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proposals'), sessionId: id, cursor: z.string().min(1).max(2048).optional() }),
  z.strictObject({ kind: z.literal('application'), applicationId: id }),
  z.strictObject({
    kind: z.literal('file'),
    applicationId: id,
    path: sourceEntry.shape.path,
    side: z.enum(['base', 'next']),
    offset: counter.max(SOURCE_LIMITS.sourceBytes),
    limit: z
      .number()
      .int()
      .positive()
      .max(32 * 1024),
  }),
]);
export const sourceApplyPrepared = z.strictObject({
  state: z.literal('prepared'),
  applicationId: id,
  digest,
  proposal: sourceProposalReference,
  workspaceId: id,
  base: sourceChangeCandidate.shape.base,
  admission: sourceAdmission,
  policyDigest: digest,
  validator: digest,
  edits: z
    .array(z.strictObject({ path: sourceEntry.shape.path, previous: digest.nullable(), next: digest.nullable() }))
    .max(SOURCE_LIMITS.files),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export const sourceApplyDecision = z.strictObject({
  state: z.enum(['reviewed', 'rejected']),
  applicationId: id,
  digest,
  decisionId: id,
  accept: z.boolean(),
  rationale: z.string().min(1).max(4096),
  reviewedAt: z.string().datetime(),
});
export const sourceApplyReceipt = z.strictObject({
  state: z.literal('applied'),
  applicationId: id,
  digest,
  candidateDigest: digest,
  decisionId: id,
  proposal: sourceProposalReference,
  source: sourceReceipt,
  appliedAt: z.string().datetime(),
});
export type SourceApplyPrepared = z.infer<typeof sourceApplyPrepared>;
export type SourceApplyDecision = z.infer<typeof sourceApplyDecision>;
export type SourceApplyReceipt = z.infer<typeof sourceApplyReceipt>;
export const sourceApplyInspection = z.strictObject({
  kind: z.literal('application'),
  applicationId: id,
  state: z.enum(['prepared', 'reviewed', 'rejected', 'applied', 'unavailable']),
  available: z.boolean(),
  prepared: sourceApplyPrepared.nullable(),
  decision: sourceApplyDecision.nullable(),
  receipt: sourceApplyReceipt.nullable(),
});
export const sourceApplyProposals = z.strictObject({
  kind: z.literal('proposals'),
  items: z.array(sourceProposalReference).max(100),
  next: z.string().min(1).max(2048).nullable(),
});
export const sourceApplyFile = z.strictObject({
  kind: z.literal('file'),
  applicationId: id,
  path: sourceEntry.shape.path,
  side: z.enum(['base', 'next']),
  digest,
  bytes: counter.max(SOURCE_LIMITS.sourceBytes),
  offset: counter.max(SOURCE_LIMITS.sourceBytes),
  data: z
    .string()
    .max(44 * 1024)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  next: counter.max(SOURCE_LIMITS.sourceBytes).nullable(),
});
export const sourceApplyInspectResult = z.discriminatedUnion('kind', [
  sourceApplyProposals,
  sourceApplyInspection,
  sourceApplyFile,
]);
export type SourceApplyInspectRequest = z.infer<typeof sourceApplyInspectRequest>;
export type SourceApplyInspectResult = z.infer<typeof sourceApplyInspectResult>;
