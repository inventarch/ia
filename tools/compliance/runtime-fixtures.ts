import { resolve } from 'node:path';
import type { CompiledRecord } from '../../packages/language/src/index.js';
import { Door, mandateAuthorityOf, mandateRefusal } from '../../packages/runtime/src/index.js';
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

/** The conformance sample-mandate allows Observation and Verification and excludes the hook word; codes come only from execution. */
export function runMandateFixtures(records: readonly CompiledRecord[]): readonly FixtureResult[] {
  const path = '.ia/src/systems/agent-system/records/sample-mandate.ia',
    mandate = records.find((r) => r.discriminator === 'mandate' && r.name === 'sample-mandate');
  const fixtures = [
    { name: 'mandate-move', expected: 'IA-RUNTIME-MANDATE-MOVE', mode: 'author', words: [] },
    { name: 'mandate-word', expected: 'IA-RUNTIME-MANDATE-WORD', mode: 'read', words: ['hook'] },
  ] as const;
  return fixtures.map(({ name, expected, mode, words }): FixtureResult => {
    const refusal = mandate === undefined ? undefined : mandateRefusal(mandateAuthorityOf(mandate), mode, words),
      observedCodes = refusal === undefined ? [] : [refusal.code];
    const findings: Finding[] = observedCodes.includes(expected)
      ? []
      : [
          {
            code: 'IA-COMP-FIXTURE-MISMATCH',
            severity: 'error',
            path,
            line: 1,
            message: `${name}: expected ${expected}, received ${refusal?.code ?? 'success'}`,
          },
        ];
    return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
  });
}
