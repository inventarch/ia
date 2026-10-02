import { expect, it } from 'vitest';
import {
  sourceApplyInspectRequest,
  sourceApplyPrepareRequest,
  sourceApplyRequest,
  sourceApplyReviewRequest,
  sourceChangeCandidate,
} from '../src/source-apply.js';

const hash = 'a'.repeat(64);
const candidate = {
  format: 'ia.source-change.v1',
  workspaceId: 'workspace',
  base: { revisionId: hash, generation: 2 },
  changes: [
    { path: '.ia/src/systems/example-system/note.ia', previous: null, next: { digest: hash, text: '#! ia 1.0\n' } },
  ],
};

it('keeps exact source-change destinations, prior bytes and proposed bytes in one closed candidate', () => {
  expect(sourceChangeCandidate.parse(candidate)).toEqual(candidate);
  const removed = { ...candidate, changes: [{ ...candidate.changes[0], previous: hash, next: null }] };
  expect(sourceChangeCandidate.parse(removed)).toEqual(removed);
  for (const value of [
    { ...candidate, format: 'ia.source-change.v2' },
    { ...candidate, owner: 'someone-else' },
    { ...candidate, policy: {} },
    { ...candidate, root: 'C:/private' },
    { ...candidate, base: { ...candidate.base, generation: '2' } },
    {
      ...candidate,
      changes: [{ ...candidate.changes[0], next: { ...candidate.changes[0]!.next, authority: 'write' } }],
    },
  ])
    expect(() => sourceChangeCandidate.parse(value)).toThrow();
});

it('refuses unsafe, duplicate, unsorted and unbounded authored edits', () => {
  for (const path of [
    '../secret.ia',
    '.ia/src/../secret.ia',
    '.ia/src/floor/file.ia',
    '.ia/adopted/foreign/file.ia',
    '.ia/src/CON.ia',
    '.ia/src/back\\slash.ia',
  ])
    expect(() => sourceChangeCandidate.parse({ ...candidate, changes: [{ ...candidate.changes[0], path }] })).toThrow();
  for (const changes of [
    [],
    [candidate.changes[0], candidate.changes[0]],
    [
      { ...candidate.changes[0], path: '.ia/src/z.ia' },
      { ...candidate.changes[0], path: '.ia/src/a.ia' },
    ],
    [
      { ...candidate.changes[0], path: '.ia/src/A.ia' },
      { ...candidate.changes[0], path: '.ia/src/a.ia' },
    ],
    Array.from({ length: 101 }, (_, n) => ({
      ...candidate.changes[0],
      path: `.ia/src/file-${n.toString().padStart(3, '0')}.ia`,
    })),
    [{ ...candidate.changes[0], previous: null, next: null }],
  ])
    expect(() => sourceChangeCandidate.parse({ ...candidate, changes })).toThrow();
});

it('accepts only an exact retained proposal reference at preparation, never replacement candidate bytes', () => {
  const request = {
    commandId: 'prepare',
    proposal: { sessionId: 'session', proposalId: 'proposal', revision: 1, digest: hash },
  };
  expect(sourceApplyPrepareRequest.parse(request)).toEqual(request);
  for (const value of [
    { ...request, candidate },
    { ...request, actor: 'alice' },
    { ...request, proposal: { ...request.proposal, revision: 0 } },
    { ...request, proposal: { ...request.proposal, digest: 'wrong' } },
  ])
    expect(() => sourceApplyPrepareRequest.parse(value)).toThrow();
});

it('separates human review and atomic application without caller-selected grants or expiry', () => {
  const review = {
    commandId: 'review',
    applicationId: 'application',
    digest: hash,
    accept: true,
    rationale: 'Apply these exact source edits.',
  };
  const apply = { commandId: 'apply', applicationId: 'application', digest: hash, decisionId: 'decision' };
  expect(sourceApplyReviewRequest.parse(review)).toEqual(review);
  expect(sourceApplyRequest.parse(apply)).toEqual(apply);
  for (const field of [
    { candidate },
    { expiresAt: Date.now() + 1000 },
    { reviewer: 'admin' },
    { policy: {} },
    { destination: 'another-workspace' },
  ]) {
    expect(() => sourceApplyReviewRequest.parse({ ...review, ...field })).toThrow();
    expect(() => sourceApplyRequest.parse({ ...apply, ...field })).toThrow();
  }
  expect(() => sourceApplyRequest.parse({ ...apply, accept: true })).toThrow();
});

it('bounds proposal discovery and exact candidate file reads independently of generic session publication', () => {
  for (const request of [
    { kind: 'proposals', sessionId: 'session' },
    { kind: 'application', applicationId: 'application' },
    {
      kind: 'file',
      applicationId: 'application',
      path: candidate.changes[0]!.path,
      side: 'next',
      offset: 0,
      limit: 1024,
    },
  ])
    expect(sourceApplyInspectRequest.parse(request)).toEqual(request);
  for (const request of [
    { kind: 'proposals', sessionId: 'session', owner: 'foreign' },
    { kind: 'proposals', sessionId: 'session', cursor: 'x'.repeat(2049) },
    { kind: 'file', applicationId: 'application', path: '../secret', side: 'next', offset: 0, limit: 1 },
    {
      kind: 'file',
      applicationId: 'application',
      path: candidate.changes[0]!.path,
      side: 'next',
      offset: -1,
      limit: 1,
    },
    {
      kind: 'file',
      applicationId: 'application',
      path: candidate.changes[0]!.path,
      side: 'next',
      offset: 0,
      limit: 32 * 1024 + 1,
    },
  ])
    expect(() => sourceApplyInspectRequest.parse(request)).toThrow();
});
