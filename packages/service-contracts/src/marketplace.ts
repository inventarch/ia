import { id, digest, z } from './index.js';
import { sourceReference } from './sources.js';

const text = z.string().min(1).max(128),
  version = z.string().min(1).max(128);
export const packageId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/)
  .max(256);
export const dependency = z.strictObject({ id: packageId, range: version });
export const releasePin = z.strictObject({ provider: id, packageId, version, archive: digest, manifest: digest });
export const releaseTerms = z.strictObject({ license: text, revision: text, text: z.string().min(1).max(16384) });
export const distributionLock = z.strictObject({
  formatVersion: z.literal(1),
  engine: version,
  requests: z.array(dependency).min(1).max(100),
  packages: z
    .array(
      z.strictObject({
        id: packageId,
        version,
        archive: digest,
        manifest: digest,
        location: z.string().min(1).max(2048),
        dependencies: z.array(packageId).max(100),
      }),
    )
    .min(1)
    .max(100),
});
export const releaseDescriptor = z.strictObject({
  formatVersion: z.literal(1),
  id: packageId,
  version,
  distribution: z.string().min(1).max(512),
  engine: version,
  language: z.tuple([z.literal('1.0')]),
  dependencies: z
    .array(z.strictObject({ id: packageId, range: version, systems: z.array(id).min(1).max(1000) }))
    .max(100),
  assets: z
    .array(z.strictObject({ path: z.string().min(1).max(1024), role: z.enum(['documentation', 'asset', 'license']) }))
    .max(1000),
  source: z.strictObject({
    repository: z.string().min(1).max(2048),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    recipe: id,
    epoch: z.number().int().min(0).max(8_589_934_591),
  }),
  license: text,
  description: z.string().min(1).max(1024),
});
export const releaseBuildRequest = z.strictObject({
  commandId: id,
  source: sourceReference,
  descriptor: releaseDescriptor,
});
export const buildReceipt = z.strictObject({
  id: id,
  release: releasePin,
  source: sourceReference.nullable(),
  createdAt: z.string().datetime(),
});
export const releasePublishRequest = z.strictObject({ commandId: id, stageId: id });
export const releaseWithdrawRequest = z.strictObject({ commandId: id, release: releasePin });
export const publishedRelease = z.strictObject({
  release: releasePin,
  terms: releaseTerms,
  description: z.string().max(1024),
  engine: version,
  dependencies: z.array(dependency).max(100),
  publicationRevision: text,
  publishedAt: z.string().datetime(),
  withdrawn: z.boolean(),
});
export const catalogRequest = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const catalogPage = z.strictObject({
  items: z.array(publishedRelease).max(100),
  next: z.string().max(4096).nullable(),
});
export const acquisitionQuoteRequest = z.strictObject({ requests: z.array(dependency).min(1).max(100) });
export const acquisitionQuote = z.strictObject({
  provider: id,
  lock: distributionLock,
  terms: z
    .array(z.strictObject({ release: releasePin, terms: releaseTerms }))
    .min(1)
    .max(100),
  expiresAt: z.number().int().positive(),
  decisionDigest: digest,
  token: digest,
});
export const acquisitionRequest = z.strictObject({ commandId: id, quote: acquisitionQuote });
export const acquisitionReceipt = z.strictObject({
  id,
  commandId: id,
  lock: distributionLock,
  releases: z.array(releasePin).min(1).max(100),
  termsDigest: digest,
  createdAt: z.string().datetime(),
});
export const artifactReadRequest = z.strictObject({
  acquisitionId: id,
  archive: digest,
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .min(1)
    .max(96 * 1024),
});
export const artifactChunk = z.strictObject({
  archive: digest,
  bytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  data: z.string().max(128 * 1024),
  next: z.number().int().nonnegative().nullable(),
});
export type ReleasePin = z.infer<typeof releasePin>;
export type ReleaseTerms = z.infer<typeof releaseTerms>;
export type BuildReceipt = z.infer<typeof buildReceipt>;
export type PublishedRelease = z.infer<typeof publishedRelease>;
export type AcquisitionQuote = z.infer<typeof acquisitionQuote>;
export type AcquisitionReceipt = z.infer<typeof acquisitionReceipt>;
export type ArtifactChunk = z.infer<typeof artifactChunk>;
