import { expect, it } from 'vitest';
import { distributionLock, releaseDescriptor } from '../src/marketplace.js';
import {
  installationPointer,
  installationApplyRequest,
  installationInspectRequest,
  installationPlanRequest,
  installationReviewRequest,
} from '../src/installation.js';

const source = { workspaceId: 'workspace', revisionId: 'a'.repeat(64), generation: 2 };
it('requires exact source and acquired closure selection without accepting authority or native storage data', () => {
  const request = { commandId: 'plan', source, acquisitionId: 'acquisition', operation: 'install' };
  expect(installationPlanRequest.parse(request)).toEqual(request);
  for (const field of ['owner', 'actor', 'root', 'lock', 'policy', 'archives', 'url'])
    expect(installationPlanRequest.safeParse({ ...request, [field]: 'injected' }).success).toBe(false);
  expect(installationPlanRequest.safeParse({ ...request, source: { ...source, generation: -1 } }).success).toBe(false);
  expect(installationPlanRequest.safeParse({ ...request, operation: 'restore' }).success).toBe(false);
});
it('requires explicit exact review, decision and closed bounded inspection', () => {
  const review = {
    commandId: 'review',
    planId: 'plan',
    digest: 'b'.repeat(64),
    accept: true,
    rationale: 'Install the reviewed native closure.',
  };
  expect(installationReviewRequest.parse(review)).toEqual(review);
  expect(installationReviewRequest.safeParse({ ...review, rationale: '   ' }).success).toBe(false);
  expect(
    installationApplyRequest.safeParse({ commandId: 'apply', planId: 'plan', digest: review.digest }).success,
  ).toBe(false);
  expect(installationInspectRequest.parse({ kind: 'current' })).toEqual({ kind: 'current' });
  expect(installationInspectRequest.safeParse({ kind: 'current', owner: 'other' }).success).toBe(false);
});

// Decision dec-008 (A14, A15): the released lock, pointer and descriptor carry a formatVersion and no name; the plain
// shape names the document beside it. Both are read, in one document or another, and any other name is refused.
const hash = 'a'.repeat(64);
const lockBody = {
  formatVersion: 1,
  engine: '^0.1.0',
  requests: [{ id: 'test/one', range: '^1.0.0' }],
  packages: [
    {
      id: 'test/one',
      version: '1.0.0',
      archive: hash,
      manifest: hash,
      location: `sha256:${hash}`,
      dependencies: [],
    },
  ],
};
const pointerBody = { formatVersion: 1, generation: hash, previous: null, counter: 1 };
const descriptorBody = {
  formatVersion: 1,
  id: 'independent/product',
  version: '1.0.0',
  distribution: 'workspace-system/definition/distribution/example',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  assets: [],
  source: { repository: 'https://independent.example/source', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 1 },
  license: 'UNLICENSED',
  description: 'Independent release',
};
it.each([
  ['distribution-lock', distributionLock, lockBody],
  ['activation-pointer', installationPointer, pointerBody],
  ['release-descriptor', releaseDescriptor, descriptorBody],
] as const)('%s: reads the released shape and the plain shape, and refuses any other name', (name, schema, body) => {
  expect(schema.safeParse(body).success).toBe(true);
  expect(schema.safeParse({ format: name, ...body }).success).toBe(true);
  for (const format of [`${name}-1`, `ia.${name}.v1`, 'other-document', 1, ''])
    expect(schema.safeParse({ format, ...body }).success, String(format)).toBe(false);
  expect(schema.safeParse({ format: name, ...body, formatVersion: 2 }).success).toBe(false);
  expect(schema.safeParse({ format: name, ...body, formatVersion: undefined }).success).toBe(false);
});
