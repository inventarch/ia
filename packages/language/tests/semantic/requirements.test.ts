import { describe, expect, it } from 'vitest';
import { BudgetExceeded, WORK_COST, WorkBudget, metered } from '../../src/bounded.js';
import { requirementCollisions, isRequirementId } from '../../src/semantic/requirements.js';

describe('requirement occurrence validation', () => {
  it.each(['REQ-A', 'REQ-1', 'REQ-A-B-12', 'REQ-00-X'])('accepts %s', (id) => expect(isRequirementId(id)).toBe(true));
  it.each(['req-A', 'REQ-', 'REQ-a', 'REQ-A-', 'REQ-A--B', 'REQ-A/B', 'REQ-A#B', 'REQ-A B'])('refuses %s', (id) =>
    expect(isRequirementId(id)).toBe(false),
  );
  it('spends what it says on the budget it is given, else the one in force', () => {
    const occurrences = ['a.ia', 'b.ia'].map((path) => ({ id: 'REQ-A', identity: 'x', path, line: 1 })),
      given = new WorkBudget(1_000),
      inForce = new WorkBudget(1_000),
      { diagnostics } = requirementCollisions(occurrences, given);
    expect(given.spent()).toBe(
      diagnostics.reduce((sum, d) => sum + WORK_COST.diagnostic + (d.message.length >>> 6), 0),
    );
    metered(inForce, () => requirementCollisions(occurrences));
    expect(inForce.spent()).toBe(given.spent());
    expect(() => requirementCollisions(occurrences, new WorkBudget(WORK_COST.diagnostic))).toThrow(BudgetExceeded);
  });
  it('keeps distinct IDs', () => {
    const result = requirementCollisions([
      { id: 'REQ-A', identity: 'x', path: 'a.ia', line: 1 },
      { id: 'REQ-B', identity: 'x', path: 'a.ia', line: 2 },
    ]);
    expect(result.refused.size).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([
    ['x', 'a.ia', 100],
    ['y', 'a.ia', 100],
    ['y', 'b.ia', 100],
    ['y', 'b.ia', 10],
  ] as const)('rejects every duplicate across owner %s path %s band %s', (identity, path, band) => {
    const first = { id: 'REQ-A', identity: 'x', path: 'a.ia', line: 4, band: 100 };
    const second = { id: 'REQ-A', identity, path, line: 8, band };
    const result = requirementCollisions([first, second]);
    expect([...result.refused]).toEqual([first, second]);
    expect(result.diagnostics.map((d) => [d.code, d.path, d.line])).toEqual([
      ['IA-LANG-REQUIREMENT-DUPLICATE', 'a.ia', 4],
      ['IA-LANG-REQUIREMENT-DUPLICATE', path, 8],
    ]);
    expect(result.diagnostics[0]!.message).toContain(`${path}:8`);
  });
  it('reports three participants deterministically without mutation', () => {
    const a = Object.freeze({ id: 'REQ-A', identity: 'x', path: 'a.ia', line: 4 });
    const b = Object.freeze({ id: 'REQ-A', identity: 'y', path: 'b.ia', line: 8 });
    const c = Object.freeze({ id: 'REQ-A', identity: 'z', path: 'c.ia', line: 2 });
    const expected = requirementCollisions([a, b, c]);
    for (const pool of [
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ]) {
      expect(requirementCollisions(Object.freeze(pool)).diagnostics).toEqual(expected.diagnostics);
      expect(requirementCollisions(pool).refused.size).toBe(3);
    }
  });
  it('names eight other occurrences in order and counts the rest', () => {
    const occurrences = Array.from({ length: 12 }, (_, i) => ({
      id: 'REQ-A',
      identity: 'x',
      path: 'a.ia',
      line: 90 - i,
    }));
    const { diagnostics } = requirementCollisions(occurrences);
    expect(diagnostics).toHaveLength(12);
    const first = diagnostics.find((d) => d.line === 79)!;
    const others = [80, 81, 82, 83, 84, 85, 86, 87].map((line) => `a.ia:${line} (x)`).join(', ');
    expect(first.message).toBe(`Requirement REQ-A is also declared at ${others} and 3 more.`);
  });
  it('names up to eight other occurrences exactly as written', () => {
    const occurrences = Array.from({ length: 9 }, (_, i) => ({
      id: 'REQ-A',
      identity: 'x',
      path: 'a.ia',
      line: 10 + i,
    }));
    const { diagnostics } = requirementCollisions(occurrences);
    const others = [11, 12, 13, 14, 15, 16, 17, 18].map((line) => `a.ia:${line} (x)`).join(', ');
    expect(diagnostics[0]?.message).toBe(`Requirement REQ-A is also declared at ${others}.`);
  });
});
