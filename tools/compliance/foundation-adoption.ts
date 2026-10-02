import type { AdoptionEvaluators, ClauseEvaluator, ClauseResult } from '../../packages/compliance/src/index.js';
import { FOUNDATION_ADOPTER, FOUNDATION_CONTRACT } from '../native/fixture-authoring.js';
import type { FoundationEvidence, FoundationObservationId } from '../native/fixture-authoring.js';

const requirements: Readonly<Record<string, readonly FoundationObservationId[]>> = {
  'REQ-FOUNDATION-INPUT': ['input'],
  'REQ-FOUNDATION-VALID': ['valid-native-record'],
  'REQ-FOUNDATION-REFUSE': ['missing-required-field', 'foreign-vocabulary'],
};
const unavailable = (message: string): ClauseResult => ({ outcome: 'not-evaluated', message });

/** Explicit repository composition; never installed as a generic compliance default. */
export function foundationAdoptionEvaluators(evidence?: FoundationEvidence): AdoptionEvaluators {
  const revision = evidence?.revision,
    adopter = evidence?.adopter;
  const observations = evidence?.observations.map((observation) => ({ ...observation })) ?? [];
  return new Map([
    [
      FOUNDATION_CONTRACT,
      new Map(
        Object.entries(requirements).map(([id, needed]) => {
          const evaluate: ClauseEvaluator = (context) => {
            if (revision === undefined || revision !== context.graph.revision)
              return unavailable('Foundation observations are missing or belong to another source revision');
            if (
              adopter !== FOUNDATION_ADOPTER ||
              context.adopter.identity !== adopter ||
              context.graph.location !== '' ||
              context.graph.phase !== undefined
            )
              return unavailable('Foundation observations do not cover this adopter or contextual view');
            const results = needed.map((name): ClauseResult => {
              const found = observations.filter((o) => o.id === name);
              return found.length === 1 ? found[0]! : unavailable(`Need exactly one ${name} observation`);
            });
            const outcome = results.some((r) => r.outcome === 'fail')
              ? 'fail'
              : results.some((r) => r.outcome !== 'pass')
                ? 'not-evaluated'
                : 'pass';
            return { outcome, message: results.map((r) => r.message).join('; ') };
          };
          return [id, evaluate];
        }),
      ),
    ],
  ]);
}
