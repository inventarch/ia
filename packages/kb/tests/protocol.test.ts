import { expect, it } from 'vitest';
import { KB_OPERATIONS, parseKnowledgeRequest } from '../src/protocol.js';
it('shares five closed, bounded read requests across adapters', () => {
  expect(KB_OPERATIONS.map((o) => o.name)).toEqual(['check', 'search', 'read', 'resolve', 'traverse']);
  expect(parseKnowledgeRequest('search', { query: 'body', limit: 3, within: 'opaque' })).toEqual({
    query: 'body',
    limit: 3,
    within: 'opaque',
  });
  for (const args of [{ query: 'body', root: 'elsewhere' }, { query: 'x'.repeat(201) }, { query: 'body', limit: 101 }])
    expect(() => parseKnowledgeRequest('search', args)).toThrow();
  expect(() => parseKnowledgeRequest('traverse', { identity: 'work-system/contract/spec/a', steps: 65 })).toThrow();
  expect(() => parseKnowledgeRequest('read', { locator: 'docs/a.md:1' })).toThrow();
});
