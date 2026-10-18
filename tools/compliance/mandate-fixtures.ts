import type { CompiledRecord } from '../../packages/language/src/index.js';
import { mandateAuthorityOf, mandateRefusal } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

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
