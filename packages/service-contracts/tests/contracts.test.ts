import { expect, it } from 'vitest';
import {
  captureFailure,
  errorResult,
  failure,
  captureRequest,
  decode,
  exactProposalReview,
  exactQuestionReply,
  invocation,
  jsonSchema,
  nativeStartRequest,
  publicControlReceipt,
  publicPending,
  publicRecovery,
  publicResult,
  sessionAdvanceRequest,
  sessionControlRequest,
  sessionRecoverRequest,
  sessionRequest,
  ServiceError,
} from '../src/index.js';

it('shares exact noncoercing envelopes and draft-07 schemas', () => {
  for (const input of [null, {}, { sessionId: 1 }, { sessionId: 'owned', tenant: 'forged' }])
    expect(() => decode(sessionRequest, input)).toThrow(ServiceError);
  const request = { sessionId: 'owned' };
  expect(decode(sessionRequest, request)).toEqual(request);
  expect(jsonSchema(sessionRequest)).toMatchObject({
    type: 'object',
    additionalProperties: false,
    required: ['sessionId'],
  });
  expect(() => decode(invocation, { binding: {}, operation: 'read', input: {} })).toThrow(ServiceError);
});

it('binds native controls to exact object versions without accepting caller authority', () => {
  const pin = { sessionId: 'session', commandId: 'command', revision: 1, digest: 'a'.repeat(64) };
  const reply = { ...pin, questionId: 'question', answer: { choice: 'yes' } };
  expect(decode(exactQuestionReply, reply)).toEqual(reply);
  for (const input of [
    { ...reply, actor: 'admin' },
    { ...reply, revision: '1' },
    { ...reply, revision: 0 },
    { ...reply, digest: 'changed' },
  ])
    expect(() => decode(exactQuestionReply, input)).toThrow(ServiceError);
  const review = { ...pin, proposalId: 'proposal', accept: true, rationale: 'Reviewed the exact candidate' };
  expect(decode(exactProposalReview, review)).toEqual(review);
  expect(() => decode(exactProposalReview, { ...review, accept: 'true' })).toThrow(ServiceError);
  expect(() => decode(exactProposalReview, { ...review, rationale: '   ' })).toThrow(ServiceError);
  expect(() =>
    decode(sessionControlRequest, { sessionId: 'session', commandId: 'command', kind: 'cancel', runId: 'private-run' }),
  ).toThrow(ServiceError);
  const advance = { sessionId: 'session', commandId: 'advance', expectedSequence: 0 };
  expect(decode(sessionAdvanceRequest, advance)).toEqual(advance);
  for (const input of [
    { sessionId: 'session' },
    { ...advance, expectedSequence: -1 },
    { ...advance, expectedSequence: '0' },
    { ...advance, model: 'private-model' },
  ])
    expect(() => decode(sessionAdvanceRequest, input)).toThrow(ServiceError);
});

it('bounds explicit capture/start envelopes and published text views', () => {
  for (const capture of [null, [], 'server/path'])
    expect(() => decode(captureRequest, { capture })).toThrow(ServiceError);
  const start = { id: 'session', commandId: 'command', captureId: 'a'.repeat(64), task: 'Inspect my captured source' };
  expect(decode(nativeStartRequest, start)).toEqual(start);
  for (const entry of ['author', 'architect', 'system-architect'])
    expect(decode(nativeStartRequest, { ...start, entry })).toEqual({ ...start, entry });
  for (const input of [
    { ...start, task: '' },
    { ...start, task: 'x'.repeat(16_385) },
    { ...start, entry: 'private-agent' },
    { ...start, entry: 'coach' },
    { ...start, root: '/private' },
  ])
    expect(() => decode(nativeStartRequest, input)).toThrow(ServiceError);
  const question = {
    id: 'question',
    revision: 1,
    digest: 'a'.repeat(64),
    prompt: 'Which option?',
    choices: ['One', 'Two'],
    required: true,
  };
  const pending = { sessionId: 'session', questions: [question], proposals: [] };
  expect(decode(publicPending, pending)).toEqual(pending);
  for (const input of [
    { ...pending, manifest: {} },
    { ...pending, questions: [{ ...question, respondent: 'private-agent' }] },
    { ...pending, questions: Array(101).fill(question) },
  ])
    expect(() => decode(publicPending, input)).toThrow(ServiceError);
  expect(() =>
    decode(publicResult, {
      sessionId: 'session',
      state: 'completed',
      outcome: { summary: 'Done', evidence: [], transcript: [] },
      proposals: [],
    }),
  ).toThrow(ServiceError);
  for (const schema of [
    captureRequest,
    nativeStartRequest,
    sessionAdvanceRequest,
    exactQuestionReply,
    exactProposalReview,
    sessionControlRequest,
    publicControlReceipt,
    publicPending,
    publicResult,
  ])
    expect(jsonSchema(schema)).toMatchObject({ type: 'object', additionalProperties: false });
});
it('publishes only safe recovery choices and accepts an exact opaque recovery selection', () => {
  const request = { sessionId: 'session', commandId: 'recover', expectedSequence: 7, token: 'a'.repeat(64) };
  expect(decode(sessionRecoverRequest, request)).toEqual(request);
  for (const value of [
    { ...request, attemptId: 'private' },
    { ...request, kind: 'repair' },
    { ...request, expectedSequence: '7' },
    { ...request, token: 'private-attempt' },
  ])
    expect(() => decode(sessionRecoverRequest, value)).toThrow(ServiceError);
  const recovery = {
    sessionId: 'session',
    sequence: 7,
    reason: 'model-error',
    remainingAttempts: 1,
    action: { kind: 'repair', token: request.token },
  };
  expect(decode(publicRecovery, recovery)).toEqual(recovery);
  expect(
    decode(publicRecovery, { ...recovery, reason: 'allowance-exhausted', remainingAttempts: 0, action: null }),
  ).toMatchObject({ action: null });
  for (const value of [
    { ...recovery, manifest: {} },
    { ...recovery, action: { ...recovery.action, attemptId: 'private' } },
    { ...recovery, reason: 'secret-provider-message' },
  ])
    expect(() => decode(publicRecovery, value)).toThrow(ServiceError);
  for (const schema of [sessionRecoverRequest, publicRecovery])
    expect(jsonSchema(schema)).toMatchObject({ type: 'object', additionalProperties: false });
});

it('preserves bounded capture refusal evidence without disclosing arbitrary error details', () => {
  const capture = { reason: 'overflow' as const, requiredBytes: 716801, limit: 716800, proof: 'a'.repeat(64) };
  const error = new ServiceError('invalid', 'capture-overflow', 'Complete context exceeds the bound', capture);
  expect(errorResult.parse(failure(error))).toEqual({
    code: error.code,
    category: 'invalid',
    message: error.message,
    capture,
  });
  expect(failure(new ServiceError('forbidden', 'denied', 'Unavailable'))).toEqual({
    code: 'denied',
    category: 'forbidden',
    message: 'Unavailable',
  });
  expect(failure(Error('private database path'))).toEqual({
    code: 'internal',
    category: 'internal',
    message: 'The operation could not be completed',
  });
  for (const extra of [
    { diagnostics: '/private/secret' },
    { limit: 0 },
    { requiredBytes: -1 },
    { proof: 'not-a-pin' },
    { reason: 'unknown' },
  ])
    expect(() => captureFailure.parse({ ...capture, ...extra })).toThrow();
});
