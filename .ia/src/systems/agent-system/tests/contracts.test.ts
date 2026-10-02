import { expect, it } from 'vitest';
import type { ModelAdapter, ModelResponse, Profile } from '../src/index.js';

it('keeps the model boundary single-attempt and independent of a provider SDK', async () => {
  const profile: Profile = {
    id: 'author',
    agent: 'author',
    role: 'author',
    voice: '',
    instructions: [],
    operations: [],
    capabilities: [],
    delegates: [],
    outcomes: ['answer'],
    completion: 'response',
    checks: [],
    model: 'external',
  };
  const response: ModelResponse = {
    action: { type: 'outcome', kind: 'answer', message: 'ready', continuation: 'finish' },
    usage: 1,
    provider: 'test',
    model: 'scripted',
  };
  const adapter: ModelAdapter = { id: 'scripted', generate: async () => response };
  expect(
    await adapter.generate(
      {
        version: 1,
        sessionId: 's',
        runId: 'r',
        attemptId: 'a',
        task: 'test',
        profile,
        history: [],
        context: null,
        operations: [],
        maxOutputTokens: 10,
      },
      new AbortController().signal,
    ),
  ).toBe(response);
});
