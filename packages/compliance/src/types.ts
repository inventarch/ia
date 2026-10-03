import type { Diagnostic } from '@inventarch/language';
import type { GraphCode } from '@inventarch/graph';

export const COMP_CODES = [
  'IA-COMP-SCHEMA-MISSING',
  'IA-COMP-SCHEMA-KIND-MISMATCH',
  'IA-COMP-SECTION-MISSING',
  'IA-COMP-SECTION-UNKNOWN',
  'IA-COMP-FIELD-MISSING',
  'IA-COMP-FIELD-UNKNOWN',
  'IA-COMP-FIELD-DUPLICATE',
  'IA-COMP-FIELD-TYPE',
  'IA-COMP-FIELD-VALUE',
  'IA-COMP-FIELD-REF-TARGET',
  'IA-COMP-FIELD-REF-MISSING',
  'IA-COMP-FIELD-FORM',
  'IA-COMP-EDGE-CARDINALITY',
  'IA-COMP-EDGE-UNRESOLVED',
  'IA-COMP-SYSTEM-MALFORMED',
  'IA-COMP-DISCRIMINATOR-FOREIGN',
  'IA-COMP-BOOTSTRAP-ORDER',
  'IA-COMP-STEWARD-MISSING',
  'IA-COMP-CONSENT-EMPTY',
  'IA-COMP-SCHEMA-UNREFERENCED',
  'IA-COMP-SCHEMA-MULTIPLE',
  'IA-COMP-FRAGMENT-MISSING',
  'IA-COMP-COVERAGE-MISSING',
  'IA-COMP-COVERAGE-KIND',
  'IA-COMP-SELECTOR-INVALID',
  'IA-COMP-CHECK-UNKNOWN',
  'IA-COMP-VARIANT-AMBIGUOUS',
  'IA-COMP-ADOPTION-FAILED',
  'IA-COMP-NOT-EVALUATED',
  'IA-COMP-FIXTURE-MISMATCH',
  'IA-COMP-PROJECTION-INVALID',
] as const;
export type CompCode = (typeof COMP_CODES)[number];
/** Evaluator-catalog, obligation and receipt codes (C25-C29). A separate inventory: the repository
 * fixture gate (tools/compliance/check.ts) covers COMP_CODES and does not enrol these (open follow-up, SPEC C29). */
export const EVIDENCE_CODES = Object.freeze([
  'IA-COMP-CATALOG-VERSION',
  'IA-COMP-CATALOG-ENTRY-INVALID',
  'IA-COMP-CATALOG-LIMITS',
  'IA-COMP-CATALOG-DUPLICATE',
  'IA-COMP-CATALOG-DIGEST-CONFLICT',
  'IA-COMP-CATALOG-BUILTIN-OVERRIDE',
  'IA-COMP-CATALOG-CODEC-UNKNOWN',
  'IA-COMP-EVALUATOR-UNAVAILABLE',
  'IA-COMP-EVALUATOR-REVOKED',
  'IA-COMP-EVALUATOR-SUBSTITUTED',
  'IA-COMP-EVALUATOR-OUTPUT-INVALID',
  'IA-COMP-OBLIGATION-UNRESOLVED',
  'IA-COMP-OBLIGATION-CONFLICT',
  'IA-COMP-OBLIGATION-UNDETERMINED',
  'IA-COMP-OBLIGATION-WEAKENED',
  'IA-COMP-OBLIGATION-FAILED',
  'IA-COMP-OBLIGATION-BLOCKED',
  'IA-COMP-OBLIGATION-UNVERIFIED',
  'IA-COMP-RECEIPT-INVALID',
  'IA-COMP-RECEIPT-SUBJECT',
  'IA-COMP-RECEIPT-STALE',
  'IA-COMP-RECEIPT-CODE',
  'IA-COMP-RECEIPT-TOOLCHAIN',
  'IA-COMP-RECEIPT-EVALUATOR',
  'IA-COMP-RECEIPT-REVOKED',
  'IA-COMP-RECEIPT-EXPIRED',
  'IA-COMP-RECEIPT-FRESH-RUN',
  'IA-COMP-RECEIPT-UNTRUSTED',
] as const);
export type EvidenceCode = (typeof EVIDENCE_CODES)[number];
export interface Finding extends Omit<Diagnostic, 'code'> {
  readonly code: CompCode | EvidenceCode | Diagnostic['code'] | GraphCode;
}
export interface Assessment {
  readonly check: string;
  readonly scope: string;
  readonly outcome: 'pass' | 'fail' | 'not-evaluated';
  readonly findings: readonly Finding[];
}
export interface Verdict extends Assessment {
  readonly revision: string;
}
export function verdict(assessment: Assessment, revision: string): Verdict {
  if (revision.trim() === '') throw new TypeError('A verdict requires an explicit nonempty revision');
  return Object.freeze({
    ...assessment,
    findings: Object.freeze(assessment.findings.map((f) => Object.freeze({ ...f }))),
    revision,
  });
}
export function assess(check: string, scope: string, findings: readonly Finding[], unavailable = false): Assessment {
  return Object.freeze({
    check,
    scope,
    outcome: findings.some((f) => f.severity === 'error')
      ? 'fail'
      : unavailable || findings.some((f) => f.code === 'IA-COMP-EDGE-UNRESOLVED' || f.code === 'IA-COMP-NOT-EVALUATED')
        ? 'not-evaluated'
        : 'pass',
    findings: Object.freeze(
      findings
        .map((f) => Object.freeze({ ...f }))
        .sort(
          (a, b) =>
            compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
        ),
    ),
  });
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
