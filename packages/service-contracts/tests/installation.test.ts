import { expect, it } from 'vitest';
import {
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
