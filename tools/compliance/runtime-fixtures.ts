import { resolve } from 'node:path';
import { Door } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

/** Real native-tree door requests; observed codes come only from execution. */
export function runRuntimeFixtures(root: string): readonly FixtureResult[] {
  const base = 'packages/compliance/fixtures/loop',
    door = new Door(resolve(root, base), { cache: false });
  const coordinate = { phase: 'act', primitive: 'Decision', category: 'process' };
  const choices = ['a', 'b'].map((name) => `governance-system/definition/procedure/choice-${name}`);
  const fixtures = [
    { name: 'invalid-operation', expected: 'IA-RUNTIME-REQUEST-INVALID', input: { operation: 'invented' } },
    {
      name: 'invalid-budget',
      expected: 'IA-RUNTIME-BUDGET-INVALID',
      input: { operation: 'context', params: { text: '', coordinate, budget: { tokens: -1, records: 1 } } },
    },
    {
      name: 'blocking-overflow',
      expected: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
      input: { operation: 'context', params: { text: '', coordinate, budget: { tokens: 0, records: 0 } } },
    },
    {
      name: 'incomplete',
      expected: 'coordinate-incomplete',
      input: { operation: 'select', params: { text: '', coordinate: { phase: 'act' }, candidates: choices } },
    },
    {
      name: 'tied',
      expected: 'deny-wins-tie',
      input: { operation: 'select', params: { text: '', coordinate, candidates: choices } },
    },
    {
      name: 'no-candidate',
      expected: 'no-candidate',
      input: { operation: 'select', params: { text: '', coordinate, candidates: [] } },
    },
  ];
  try {
    return fixtures.map(({ name, expected, input }): FixtureResult => {
      const result = door.request(input),
        observedCodes = result.ok ? [] : [result.code];
      const findings: Finding[] = observedCodes.includes(expected)
        ? []
        : [
            {
              code: 'IA-COMP-FIXTURE-MISMATCH',
              severity: 'error',
              path: base,
              line: 1,
              message: `${name}: expected ${expected}, received ${result.ok ? 'success' : result.code}`,
            },
          ];
      return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
    });
  } finally {
    door.close();
  }
}
