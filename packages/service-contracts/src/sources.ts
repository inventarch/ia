// Browser-safe source workspace shapes; byte integrity and native admission are server-owned.
import { z } from 'zod';
import { digest, id, nativeStartRequest } from './index.js';
export { z } from 'zod';

export const SOURCE_LIMITS = Object.freeze({
  files: 100,
  sourceBytes: 256 * 1024,
  revisionBytes: 512 * 1024,
  retainedRevisions: 100,
  ownedBytes: 128 * 1024 * 1024,
  objects: 10_000,
  commands: 10_000,
  pins: 1000,
  historyPage: 100,
  requestBytes: 768 * 1024,
  orphanAgeMs: 24 * 60 * 60 * 1000,
});
export type SourceLimits = { [K in keyof typeof SOURCE_LIMITS]: number };
export function isOwnedSourcePath(path: string): boolean {
  return (
    path.length <= 500 &&
    path.startsWith('.ia/src/') &&
    !path.toLowerCase().startsWith('.ia/src/floor/') &&
    path.endsWith('.ia') &&
    path === path.normalize('NFC') &&
    !/[\\\u0000-\u001f\u007f<>:"|?*]/.test(path) &&
    !path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
      )
  );
}
export const sourceEntry = z.strictObject({
  path: z.string().refine(isOwnedSourcePath, 'Expected a portable owned .ia/src source path'),
  digest,
});
export type SourceEntry = z.infer<typeof sourceEntry>;
export const sourceManifest = z
  .array(sourceEntry)
  .max(SOURCE_LIMITS.files)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.path.toLowerCase())).size === entries.length,
    'Source paths collide across supported hosts',
  );
export const sourceUploadRequest = z.strictObject({ digest, text: z.string().max(SOURCE_LIMITS.sourceBytes) });
export const sourceReference = z.strictObject({ workspaceId: id, revisionId: digest });
export type SourceReference = z.infer<typeof sourceReference>;
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sourceCommitRequest = z.strictObject({
  commandId: id,
  workspaceId: id,
  expectedGeneration: generation,
  expectedHead: digest.nullable(),
  files: sourceManifest,
});
export const sourceActivateRequest = z.strictObject({
  commandId: id,
  workspaceId: id,
  expectedGeneration: generation,
  revisionId: digest,
});
export const sourceRemoveRequest = sourceActivateRequest;
export const sourceAdmission = z.strictObject({
  ok: z.boolean(),
  revision: digest,
  refused: generation,
  diagnostics: z.array(z.strictObject({ code: z.string(), path: z.string(), line: generation })),
  unavailableChecks: z.array(z.string()),
});
export type SourceAdmission = z.infer<typeof sourceAdmission>;
export const sourceReceipt = z.strictObject({
  workspaceId: id,
  generation,
  draftHead: digest.nullable(),
  activeHead: digest.nullable(),
  revisionId: digest.optional(),
  admission: sourceAdmission.optional(),
  removed: z.array(digest).optional(),
});
export type SourceReceipt = z.infer<typeof sourceReceipt>;
export const workspaceSourceStart = nativeStartRequest.extend({ source: sourceReference.optional() });
export const sourceHistoryRequest = z.strictObject({ cursor: digest.optional() });
export const sourceHistory = sourceReceipt.extend({
  revisions: z
    .array(
      z.strictObject({
        id: digest,
        parent: digest.nullable(),
        actor: z.string().min(1).max(512),
        created: z.string().datetime(),
        admitted: z.union([z.literal(0), z.literal(1)]),
        lost: z.string().datetime().nullable(),
      }),
    )
    .max(SOURCE_LIMITS.historyPage),
  next: digest.nullable(),
});
export const sourceRevision = z.strictObject({
  ...sourceReference.shape,
  parent: digest.nullable(),
  actor: z.string().min(1).max(512),
  created: z.string().datetime(),
  admitted: z.boolean(),
  admission: sourceAdmission,
  files: z
    .array(
      z.strictObject({
        path: sourceEntry.shape.path,
        digest,
        bytes: z.number().int().nonnegative().max(SOURCE_LIMITS.sourceBytes),
      }),
    )
    .max(SOURCE_LIMITS.files),
});
export const sourceFileRequest = z.strictObject({
  ...sourceReference.shape,
  path: sourceEntry.shape.path,
  offset: z.number().int().nonnegative().max(SOURCE_LIMITS.sourceBytes),
  limit: z
    .number()
    .int()
    .positive()
    .max(32 * 1024),
});
export const sourceFile = z.strictObject({
  ...sourceReference.shape,
  path: sourceEntry.shape.path,
  digest,
  bytes: z.number().int().nonnegative().max(SOURCE_LIMITS.sourceBytes),
  offset: z.number().int().nonnegative().max(SOURCE_LIMITS.sourceBytes),
  data: z
    .string()
    .max(44 * 1024)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  next: z.number().int().nonnegative().max(SOURCE_LIMITS.sourceBytes).nullable(),
});
