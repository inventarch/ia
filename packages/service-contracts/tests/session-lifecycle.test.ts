import { expect, it } from 'vitest';
import {
  sessionContinuation,
  sessionContinueRequest,
  sessionDirectory,
  sessionListRequest,
  sessionRenewRequest,
} from '../src/session-lifecycle.js';

it('uses bounded opaque renewal choices without accepting caller authority or deadlines', () => {
  const request = {
    sessionId: 'session',
    commandId: 'renew',
    expectedSequence: 8,
    token: `1789900000000.${'a'.repeat(64)}`,
  };
  expect(sessionRenewRequest.parse(request)).toEqual(request);
  for (const input of [
    { ...request, actor: 'admin' },
    { ...request, deadline: 1 },
    { ...request, limits: {} },
    { ...request, expectedSequence: '8' },
    { ...request, token: 'x'.repeat(2049) },
  ])
    expect(() => sessionRenewRequest.parse(input)).toThrow();
  const view = {
    sessionId: 'session',
    sequence: 8,
    status: 'renewal-required',
    renewal: { token: request.token, deadline: 1789900000000 },
  };
  expect(sessionContinuation.parse(view)).toEqual(view);
  expect(() => sessionContinuation.parse({ ...view, manifest: {} })).toThrow();
});
it('requires an explicit new session identity without caller-supplied source or runtime replacement', () => {
  const request = {
    sessionId: 'old',
    id: 'new',
    commandId: 'continue',
    expectedSequence: 8,
    task: 'Continue the reviewed work',
    entry: 'author',
  };
  expect(sessionContinueRequest.parse(request)).toEqual(request);
  for (const input of [
    { ...request, id: 'old' },
    { ...request, actor: 'alice' },
    { ...request, captureId: 'a'.repeat(64) },
    { ...request, manifest: {} },
    { ...request, source: {} },
    { ...request, task: '' },
    { ...request, expectedSequence: '8' },
  ])
    expect(() => sessionContinueRequest.parse(input)).toThrow();
});
it('bounds owned directory pagination and keeps summary content separate from retained execution', () => {
  expect(sessionListRequest.parse({ workspaceId: 'workspace', limit: 20 })).toEqual({
    workspaceId: 'workspace',
    limit: 20,
  });
  for (const value of [
    { workspaceId: 'workspace', owner: 'forged' },
    { workspaceId: 'workspace', limit: 101 },
    { workspaceId: 'workspace', cursor: '' },
  ])
    expect(() => sessionListRequest.parse(value)).toThrow();
  const session = {
    version: 1,
    id: 'session',
    sequence: 1,
    state: 'waiting',
    resumable: false,
    evidence: [],
    pendingQuestions: 1,
    pendingProposals: 0,
  };
  const item = {
    workspaceId: 'workspace',
    creator: 'alice',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    source: null,
    session,
  };
  expect(sessionDirectory.parse({ items: [item], next: null }).items).toHaveLength(1);
  expect(() => sessionDirectory.parse({ items: [{ ...item, task: 'Private task' }], next: null })).toThrow();
});
