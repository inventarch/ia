import { describe, expect, it } from 'vitest';
import { admits } from '../../src/registry/consent.js';
import type { ConsentRow } from '../../src/registry/types.js';

const row = (
  predicate: ConsentRow['predicate'],
  targets: ConsentRow['targets'],
  sources: ConsentRow['sources'],
): ConsentRow => ({ predicate, targets, sources, span: { line: 1, endLine: 1 } });

describe('admits', () => {
  it('admits only when one row admits both ends of the edge', () => {
    const rows = [row('cite', ['law'], ['check']), row('cite', ['pattern'], ['guardrail'])];
    expect(admits(rows, 'cite', 'check', 'law')).toBe(true);
    expect(admits(rows, 'cite', 'guardrail', 'pattern')).toBe(true);
    expect(admits(rows, 'cite', 'check', 'pattern')).toBe(false);
    expect(admits(rows, 'use', 'check', 'law')).toBe(false);
  });

  it('treats * as any keyword on its side and an absent ledger as admitting nothing', () => {
    expect(admits([row('use', '*', ['agent'])], 'use', 'agent', 'anything')).toBe(true);
    expect(admits([row('use', '*', ['agent'])], 'use', 'other', 'anything')).toBe(false);
    expect(admits([row('use', '*', '*')], 'use', 'a', 'b')).toBe(true);
    expect(admits(undefined, 'use', 'a', 'b')).toBe(false);
  });

  it('allows any source with a source wildcard while still restricting the target and predicate', () => {
    const rows = [row('use', ['agent'], '*')];
    expect(admits(rows, 'use', 'anything', 'agent')).toBe(true);
    expect(admits(rows, 'use', 'anything', 'other')).toBe(false);
    expect(admits(rows, 'cite', 'anything', 'agent')).toBe(false);
  });

  it('matches any listed member on both sides without treating a prefix as a member', () => {
    const rows = [row('cite', ['law', 'rule'], ['agent', 'check'])];
    expect(admits(rows, 'cite', 'check', 'rule')).toBe(true);
    expect(admits(rows, 'cite', 'agent', 'law')).toBe(true);
    expect(admits(rows, 'cite', 'agent-extra', 'law')).toBe(false);
    expect(admits(rows, 'cite', 'agent', 'law-extra')).toBe(false);
  });

  it('admits nothing from an empty ledger', () => {
    expect(admits([], 'cite', 'agent', 'law')).toBe(false);
  });
});
