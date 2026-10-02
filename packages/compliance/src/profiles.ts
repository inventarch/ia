import { isBuiltinCheck } from './check-ids.js';
import { EVALUATOR_ID } from './catalog.js';
import type { ObligationOccurrence } from './obligations.js';
import { exactKeys } from './shape.js';

/**
 * Consumer evaluation profiles (C29, OBL-02). A profile id such as strict-typing-v1 is a consumer contract id, not a
 * native word: it maps one selected law/contract occurrence to required obligations that host catalog evaluators
 * discharge. Cases and declarations never satisfy them; only valid receipts do.
 */
export const EVALUATION_PROFILES = Object.freeze({
  'strict-typing-v1': Object.freeze(['configuration', 'included-file-coverage', 'compiler-run'] as const),
});
export type EvaluationProfile = keyof typeof EVALUATION_PROFILES;
export interface ProfileBinding {
  readonly occurrence: string;
  readonly word: ObligationOccurrence['word'];
  readonly adoption: string;
  readonly provenance: ObligationOccurrence['provenance'];
  /** Catalog evaluator id for each profile requirement; built-in CHECK_IDS are refused. */
  readonly evaluators: Readonly<Record<string, string>>;
  readonly input?: unknown;
  readonly applicability?: string;
}
/**
 * Expand a profile into required obligation occurrences with requirement `<profile>/<name>`, for resolveObligations.
 * Throws TypeError for an unknown profile, a missing or extra requirement mapping, or an evaluator id that is not a
 * catalog id (built-ins cannot discharge a profile; the real compiler run must come from an installed evaluator).
 */
export function profileOccurrences(
  profile: EvaluationProfile,
  binding: ProfileBinding,
): readonly ObligationOccurrence[] {
  const names = (EVALUATION_PROFILES as Readonly<Record<string, readonly string[]>>)[profile];
  if (!Object.hasOwn(EVALUATION_PROFILES, profile) || names === undefined)
    throw new TypeError(`Unknown evaluation profile ${String(profile)}`);
  if (!exactKeys(binding.evaluators, names))
    throw new TypeError(`${profile} requires exactly the evaluators ${names.join(', ')}`);
  return Object.freeze(
    names.map((name) => {
      const runs = binding.evaluators[name];
      if (typeof runs !== 'string' || !EVALUATOR_ID.test(runs) || isBuiltinCheck(runs))
        throw new TypeError(`${profile}/${name} must map to a catalog evaluator id`);
      return Object.freeze({
        identity: binding.occurrence,
        word: binding.word,
        adoption: binding.adoption,
        requirement: `${profile}/${name}`,
        runs,
        provenance: binding.provenance,
        required: true,
        ...(binding.input === undefined ? {} : { input: binding.input }),
        ...(binding.applicability === undefined ? {} : { applicability: binding.applicability }),
      });
    }),
  );
}
