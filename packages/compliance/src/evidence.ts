import { stableSerialize } from '@ia/graph';
import { isBuiltinCheck } from './check-ids.js';
import { DIGEST, assertCatalog, catalogEntry, codecOf } from './catalog.js';
import type { EvaluatorCatalog } from './catalog.js';
import { PREDICATE_ID, isIssuedResolution, obligationIdOf, resolutionDigest } from './obligations.js';
import type { Obligation, ObligationResolution } from './obligations.js';
import {
  bounded,
  compareText,
  deepFreeze,
  exactKeys,
  frozenCopy,
  jsonData,
  record,
  sanitized,
  sha256,
} from './shape.js';
import { assess } from './types.js';
import type { Assessment, EvidenceCode, Finding, Verdict } from './types.js';

/** Current receipt format (C28). Any other value refuses. */
export const EVIDENCE_RECEIPT_FORMAT = 'ia-evidence-receipt/1';
export const EVIDENCE_RESULTS = Object.freeze([
  'passed',
  'failed',
  'unavailable',
  'error',
  'cancelled',
  'not-evaluated',
  'not-applicable',
] as const);
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];
export type ReceiptTrust = 'local-unsigned' | 'service-associated';
export interface CandidateDigests {
  readonly candidate: string;
  readonly native: string;
  readonly code: string;
  readonly policy: string;
  readonly dependency: string;
}
export interface EnvironmentIdentity {
  readonly id: string;
  readonly toolchain: string;
}
export interface EvaluatorIdentity {
  readonly id: string;
  readonly implementationVersion: string;
  readonly implementationDigest: string;
}
export interface EvidenceReceipt {
  readonly format: typeof EVIDENCE_RECEIPT_FORMAT;
  readonly receiptId: string;
  readonly attemptId: string;
  readonly obligationId: string;
  readonly subject: string;
  readonly inputDigest: string;
  readonly digests: CandidateDigests;
  readonly environment: EnvironmentIdentity;
  readonly evaluator: EvaluatorIdentity;
  readonly catalogDigest: string;
  readonly policyRevision: string;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly result: EvidenceResult;
  readonly evidenceDigest: string;
  readonly issuer: string;
  /** A claim only: local-unsigned is a local diagnostic, and service-associated counts only when the host verifier accepts it (D3). */
  readonly trust: ReceiptTrust;
}
/** The current transition's captured identities and trust policy, supplied by the trusted host. */
export interface ReceiptContext {
  readonly catalog: EvaluatorCatalog;
  readonly attemptId: string;
  readonly policyRevision: string;
  readonly digests: CandidateDigests;
  readonly environment: EnvironmentIdentity;
  /** Required, no default (D3): the weakest receipt trust this host accepts. */
  readonly minimumTrust: ReceiptTrust;
  /** Trusted host code that authenticates a service-associated receipt; without it such a receipt refuses. The issuer string never elevates trust. */
  readonly verifyServiceReceipt?: (receipt: EvidenceReceipt) => boolean;
}
export interface ReceiptExpectation extends ReceiptContext {
  readonly obligation: Obligation;
}
export interface AdmissionContext extends ReceiptContext {
  /** A resolution digest the host pinned out of band; required to admit a resolution not issued in this process (D2). */
  readonly expectedResolutionDigest?: string;
}
export interface ReceiptValidation {
  readonly valid: boolean;
  readonly receipt?: EvidenceReceipt;
  readonly key?: string;
  readonly trust?: ReceiptTrust;
  readonly findings: readonly Finding[];
}
export type EvaluatorObservation =
  | { readonly kind: 'completed'; readonly byteLength: number; readonly output: unknown }
  | { readonly kind: 'timeout' | 'crashed' | 'cancelled' | 'unavailable' };
export interface EvaluatorOutcome {
  readonly result: EvidenceResult;
  readonly evidence?: unknown;
  readonly evidenceDigest: string;
  readonly diagnostics: readonly string[];
  readonly findings: readonly Finding[];
}
export interface ObligationDecision {
  readonly obligationId: string;
  readonly requirement: string;
  readonly evaluator: string;
  readonly required: boolean;
  readonly status: 'satisfied' | 'not-applicable' | 'blocked' | 'optional-unevaluated' | 'optional-failed';
  readonly result: EvidenceResult;
  readonly receiptId?: string;
  /** Trust of the receipt this decision relied on (D3). */
  readonly trust?: ReceiptTrust;
}
export interface TransitionDecision {
  readonly admitted: boolean;
  readonly subject: string;
  readonly minimumTrust: ReceiptTrust;
  /** Weakest trust among receipts that satisfied an obligation, or none. */
  readonly reliedTrust: ReceiptTrust | 'none';
  readonly decisions: readonly ObligationDecision[];
  readonly assessment: Assessment;
}

const RECEIPT_KEYS = [
  'format',
  'receiptId',
  'attemptId',
  'obligationId',
  'subject',
  'inputDigest',
  'digests',
  'environment',
  'evaluator',
  'catalogDigest',
  'policyRevision',
  'observedAt',
  'completedAt',
  'result',
  'evidenceDigest',
  'issuer',
  'trust',
] as const;
const DIGEST_KEYS = ['candidate', 'native', 'code', 'policy', 'dependency'] as const;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TRUST: readonly ReceiptTrust[] = ['local-unsigned', 'service-associated'];
/** Milliseconds for a real ISO-8601 UTC instant; calendar-invalid dates (e.g. 02-30) are rejected by round trip. */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19) ? undefined : ms;
}
function note(
  code: EvidenceCode | 'IA-COMP-NOT-EVALUATED',
  path: string,
  message: string,
  identity?: string,
  warning = false,
): Finding {
  return {
    code,
    severity: warning ? 'warning' : 'error',
    path,
    line: 1,
    ...(identity === undefined ? {} : { identity }),
    message: `${path}: ${message}`,
  };
}
function trustPolicy(context: ReceiptContext): void {
  assertCatalog(context.catalog);
  if (!TRUST.includes(context.minimumTrust))
    throw new TypeError('minimumTrust is required: local-unsigned or service-associated');
  if (context.verifyServiceReceipt !== undefined && typeof context.verifyServiceReceipt !== 'function')
    throw new TypeError('verifyServiceReceipt must be a function');
}
/** sha256 of the canonical serialization of JSON evidence (stableSerialize). */
export function evidenceDigest(value: unknown): string {
  return sha256(value ?? null);
}
const freshRun = (obligation: Obligation) => obligation.evidencePolicy.kind === 'fresh-run';
const environmentBound = (obligation: Obligation) =>
  obligation.evidencePolicy.kind === 'fresh-run' || obligation.evidencePolicy.environmentSensitive;
/**
 * EVAL-04 deduplication key: candidate, obligation, evaluator, policy revision and digest, the relevant environment
 * ({id, toolchain} or toolchain only, nothing else) and, for fresh-run, the transition attempt.
 */
export function evidenceKey(
  obligation: Obligation,
  context: Pick<ReceiptContext, 'attemptId' | 'policyRevision' | 'digests' | 'environment'>,
): string {
  const { id, implementationVersion, implementationDigest } = obligation.evaluator,
    { id: environment, toolchain } = context.environment;
  return sha256({
    candidate: context.digests.candidate,
    obligation: obligation.obligationId,
    evaluator: { id, implementationVersion, implementationDigest },
    policy: { revision: context.policyRevision, digest: context.digests.policy },
    environment: environmentBound(obligation) ? { id: environment, toolchain } : { toolchain },
    attempt: freshRun(obligation) ? context.attemptId : null,
  });
}
function shape(receipt: unknown): string | undefined {
  if (!exactKeys(receipt, RECEIPT_KEYS)) return 'Receipt fields must be exactly the v1 set';
  if (receipt.format !== EVIDENCE_RECEIPT_FORMAT) return `Receipt format must be ${EVIDENCE_RECEIPT_FORMAT}`;
  for (const key of ['receiptId', 'attemptId', 'obligationId', 'subject', 'issuer', 'policyRevision'] as const)
    if (!sanitized(receipt[key], 512)) return `Receipt ${key} must be sanitized single-line text`;
  for (const key of ['inputDigest', 'catalogDigest', 'evidenceDigest'] as const)
    if (typeof receipt[key] !== 'string' || !DIGEST.test(receipt[key])) return `Receipt ${key} must be a sha256 digest`;
  const digests = receipt.digests;
  if (
    !exactKeys(digests, DIGEST_KEYS) ||
    !DIGEST_KEYS.every((k) => typeof digests[k] === 'string' && DIGEST.test(digests[k]))
  )
    return 'Receipt digests must be candidate, native, code, policy and dependency sha256 digests';
  if (
    !exactKeys(receipt.environment, ['id', 'toolchain']) ||
    !sanitized(receipt.environment.id, 512) ||
    !sanitized(receipt.environment.toolchain, 512)
  )
    return 'Receipt environment must be {id, toolchain}';
  if (
    !exactKeys(receipt.evaluator, ['id', 'implementationVersion', 'implementationDigest']) ||
    !Object.values(receipt.evaluator).every((v) => sanitized(v, 512))
  )
    return 'Receipt evaluator must be {id, implementationVersion, implementationDigest}';
  if (!(EVIDENCE_RESULTS as readonly unknown[]).includes(receipt.result)) return 'Receipt result is not a v1 result';
  if (!(TRUST as readonly unknown[]).includes(receipt.trust))
    return 'Receipt trust must be local-unsigned or service-associated';
  return undefined;
}
/**
 * Validate one receipt against the current obligation and captured identities (C28, EVAL-03/04). `now` is an
 * explicit ISO-8601 UTC instant; no clock is read. Refuses stale inputs, wrong subject/code/toolchain, forged,
 * substituted or revoked evaluators, expired reuse, fresh-run reuse from another attempt and trust that the host
 * verifier did not establish or that is below minimumTrust (D3).
 */
export function validateReceipt(receipt: unknown, expectation: ReceiptExpectation, now: string): ReceiptValidation {
  trustPolicy(expectation);
  const { obligation, catalog } = expectation,
    at = instant(now);
  if (at === undefined) throw new TypeError('validateReceipt requires an explicit, real ISO-8601 UTC instant');
  const path = `<receipt ${obligation.obligationId}>`,
    refuse = (code: EvidenceCode, message: string): ReceiptValidation =>
      deepFreeze({ valid: false, findings: [note(code, path, message, obligation.occurrence)] });
  let problem: string | undefined;
  try {
    problem = shape(receipt);
  } catch {
    problem = 'Receipt could not be read';
  }
  if (problem !== undefined) return refuse('IA-COMP-RECEIPT-INVALID', problem);
  const r = frozenCopy(receipt as EvidenceReceipt),
    observed = instant(r.observedAt),
    completed = instant(r.completedAt);
  if (observed === undefined || completed === undefined || observed > completed || completed > at)
    return refuse(
      'IA-COMP-RECEIPT-INVALID',
      'Receipt times must be real ISO-8601 UTC instants with observedAt <= completedAt <= now',
    );
  if (r.obligationId !== obligation.obligationId || r.subject !== obligation.subject)
    return refuse('IA-COMP-RECEIPT-SUBJECT', 'Receipt names a different obligation or subject');
  const expected = obligation.evaluator,
    same =
      r.evaluator.id === expected.id &&
      r.evaluator.implementationVersion === expected.implementationVersion &&
      r.evaluator.implementationDigest === expected.implementationDigest;
  if (expected.builtin) {
    if (!same || !isBuiltinCheck(expected.id))
      return refuse('IA-COMP-RECEIPT-EVALUATOR', `Receipt evaluator is not built-in ${expected.id}`);
  } else {
    const entry = catalogEntry(catalog, r.evaluator.id, r.evaluator.implementationVersion);
    if (entry === undefined || entry.implementationDigest !== r.evaluator.implementationDigest)
      return refuse(
        'IA-COMP-RECEIPT-EVALUATOR',
        'Receipt evaluator identity is unknown to the catalog or its digest is forged',
      );
    if (entry.availability.status === 'revoked')
      return refuse(
        'IA-COMP-RECEIPT-REVOKED',
        `Receipt evaluator ${entry.id}@${entry.implementationVersion} is revoked: ${entry.availability.reason}`,
      );
    if (!same)
      return refuse(
        'IA-COMP-RECEIPT-EVALUATOR',
        `Receipt evaluator is not the obligation's ${expected.id}@${expected.implementationVersion}`,
      );
  }
  if (r.digests.code !== expectation.digests.code)
    return refuse('IA-COMP-RECEIPT-CODE', 'Receipt code digest does not match the candidate code');
  if (r.environment.toolchain !== expectation.environment.toolchain)
    return refuse('IA-COMP-RECEIPT-TOOLCHAIN', 'Receipt toolchain does not match the current toolchain');
  if (r.trust === 'service-associated') {
    let verified = false;
    try {
      verified = expectation.verifyServiceReceipt?.(r) === true;
    } catch {
      verified = false;
    }
    if (!verified)
      return refuse(
        'IA-COMP-RECEIPT-UNTRUSTED',
        'Service-associated receipt was not verified by the host; the issuer string never establishes trust',
      );
  }
  if (expectation.minimumTrust === 'service-associated' && r.trust !== 'service-associated')
    return refuse(
      'IA-COMP-RECEIPT-UNTRUSTED',
      'A local unsigned receipt is a local diagnostic, not authenticated approval',
    );
  const stale = [
    ...(['candidate', 'native', 'policy', 'dependency'] as const)
      .filter((k) => r.digests[k] !== expectation.digests[k])
      .map((k) => `${k} digest`),
    ...(r.inputDigest !== obligation.inputDigest ? ['input digest'] : []),
    ...(r.policyRevision !== expectation.policyRevision ? ['policy revision'] : []),
    ...(r.catalogDigest !== catalog.digest ? ['catalog digest'] : []),
    ...(environmentBound(obligation) && r.environment.id !== expectation.environment.id ? ['environment'] : []),
  ];
  if (stale.length > 0) return refuse('IA-COMP-RECEIPT-STALE', `Receipt is stale: ${stale.join(', ')} changed`);
  if (freshRun(obligation) && r.attemptId !== expectation.attemptId)
    return refuse('IA-COMP-RECEIPT-FRESH-RUN', 'Fresh-run obligation requires a result from this transition attempt');
  if (obligation.evidencePolicy.kind === 'reusable' && at - completed > obligation.evidencePolicy.maxAgeMs)
    return refuse(
      'IA-COMP-RECEIPT-EXPIRED',
      `Reusable evidence is older than ${obligation.evidencePolicy.maxAgeMs} ms`,
    );
  return deepFreeze({
    valid: true,
    receipt: r,
    key: evidenceKey(obligation, expectation),
    trust: r.trust,
    findings: [],
  });
}
function outcomeOf(
  result: EvidenceResult,
  diagnostics: readonly string[],
  findings: readonly Finding[] = [],
  evidence?: unknown,
): EvaluatorOutcome {
  return deepFreeze({
    result,
    ...(evidence === undefined ? {} : { evidence }),
    evidenceDigest: evidence === undefined ? evidenceDigest({ result, diagnostics }) : evidenceDigest(evidence),
    diagnostics,
    findings,
  });
}
/**
 * Convert a host's observation of one catalog evaluator run into a bounded result (C28, EVAL-Q07). Timeouts,
 * crashes, oversized output, an unreadable or non-JSON envelope, codec rejection or failure and evaluator-claimed
 * results other than passed/failed become `error` with fixed compliance-authored diagnostics; no evaluator text is
 * echoed for them. Failed diagnostics are bounded and redacted. Never throws for evaluator output; throws TypeError
 * for a built-in obligation (use adaptBuiltinVerdict). Performs no execution.
 */
export function acceptEvaluatorOutput(
  catalog: EvaluatorCatalog,
  obligation: Obligation,
  observation: EvaluatorObservation,
  options: { readonly secrets?: readonly string[] } = {},
): EvaluatorOutcome {
  assertCatalog(catalog);
  if (obligation.evaluator.builtin)
    throw new TypeError('Built-in obligations report through evaluate(); use adaptBuiltinVerdict');
  const path = `<evaluator ${obligation.evaluator.id}>`;
  const error = (message: string) =>
    outcomeOf('error', [message], [note('IA-COMP-EVALUATOR-OUTPUT-INVALID', path, message, obligation.occurrence)]);
  const entry = catalogEntry(catalog, obligation.evaluator.id, obligation.evaluator.implementationVersion);
  if (
    entry === undefined ||
    entry.implementationDigest !== obligation.evaluator.implementationDigest ||
    entry.availability.status !== 'supported'
  ) {
    const status = entry?.availability.status === 'revoked' ? 'revoked' : 'unavailable',
      message = `Evaluator ${obligation.evaluator.id}@${obligation.evaluator.implementationVersion} is ${status} in catalog ${catalog.digest}`;
    return outcomeOf(
      'unavailable',
      [message],
      [
        note(
          status === 'revoked' ? 'IA-COMP-EVALUATOR-REVOKED' : 'IA-COMP-EVALUATOR-UNAVAILABLE',
          path,
          message,
          obligation.occurrence,
        ),
      ],
    );
  }
  try {
    switch (observation.kind) {
      case 'timeout':
        return error(`Evaluator exceeded its ${entry.limits.timeoutMs} ms timeout`);
      case 'crashed':
        return error('Evaluator terminated without a valid result');
      case 'cancelled':
        return outcomeOf('cancelled', ['Evaluation was cancelled by the host']);
      case 'unavailable':
        return outcomeOf(
          'unavailable',
          ['Evaluator could not be started by the host'],
          [
            note(
              'IA-COMP-EVALUATOR-UNAVAILABLE',
              path,
              'Evaluator could not be started by the host',
              obligation.occurrence,
            ),
          ],
        );
      case 'completed':
        break;
      default:
        return error('Host reported an unknown observation');
    }
    const { byteLength, output } = observation;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return error('Evaluator output size was not reported');
    if (byteLength > entry.limits.outputBytes)
      return error(`Evaluator output exceeded its ${entry.limits.outputBytes} byte limit`);
    if (!jsonData(output)) return error('Evaluator output is not JSON data');
    const envelope = frozenCopy(output);
    if (
      !record(envelope) ||
      !Object.keys(envelope).every((k) => k === 'result' || k === 'evidence' || k === 'diagnostics') ||
      !Object.hasOwn(envelope, 'evidence') ||
      (envelope['diagnostics'] !== undefined && !Array.isArray(envelope['diagnostics']))
    )
      return error('Evaluator output did not match the v1 result envelope');
    const result = envelope['result'];
    if (result !== 'passed' && result !== 'failed')
      return error('Evaluator reported a result other than passed or failed');
    const codec = codecOf(catalog, entry.outputSchemaId);
    let valid = false;
    try {
      valid = codec !== undefined && codec.validate(envelope['evidence']) === true;
    } catch {
      valid = false;
    }
    if (!valid) return error(`Evaluator output did not satisfy codec ${entry.outputSchemaId}`);
    return outcomeOf(
      result,
      result === 'failed' ? bounded(envelope['diagnostics'], options.secrets ?? []) : [],
      [],
      envelope['evidence'],
    );
  } catch {
    return error('Evaluator output could not be read');
  }
}
/**
 * Adapt a built-in compliance verdict to the result envelope (C28, spec §5): pass → passed, fail → failed,
 * not-evaluated or no verdict → not-evaluated, so unevaluated built-in outcomes are preserved. Throws TypeError for
 * a catalog obligation or a verdict for a different check.
 */
export function adaptBuiltinVerdict(obligation: Obligation, verdictInput: Verdict | undefined): EvaluatorOutcome {
  if (!obligation.evaluator.builtin || !isBuiltinCheck(obligation.runs))
    throw new TypeError('adaptBuiltinVerdict accepts only built-in obligations');
  if (verdictInput === undefined) return outcomeOf('not-evaluated', [`${obligation.runs}: no verdict was supplied`]);
  if (verdictInput.check !== obligation.runs)
    throw new TypeError(`Verdict for ${verdictInput.check} cannot discharge ${obligation.runs}`);
  const diagnostics = bounded(verdictInput.findings.map((f) => f.message));
  const evidence = frozenCopy({
    check: verdictInput.check,
    scope: verdictInput.scope,
    revision: verdictInput.revision,
    outcome: verdictInput.outcome,
    findings: verdictInput.findings.map((f) => ({ code: f.code, severity: f.severity, path: f.path, line: f.line })),
  });
  return verdictInput.outcome === 'pass'
    ? outcomeOf('passed', [], [], evidence)
    : verdictInput.outcome === 'fail'
      ? outcomeOf('failed', diagnostics, [], evidence)
      : outcomeOf('not-evaluated', diagnostics, [], evidence);
}
/** D2: verify a resolution is resolver-issued (in-process brand) or matches a host-pinned digest, and is structurally sound against the catalog. */
function verifyResolution(resolution: ObligationResolution, context: AdmissionContext): string | undefined {
  try {
    const recomputed = resolutionDigest(resolution);
    if (recomputed !== resolution.digest) return 'resolution digest does not match its content';
    if (
      !isIssuedResolution(resolution) &&
      (context.expectedResolutionDigest === undefined || context.expectedResolutionDigest !== recomputed)
    )
      return 'resolution was not issued by resolveObligations in this process and its digest was not pinned by the host';
    const ids = new Set<string>();
    for (const o of resolution.obligations) {
      if (
        o.subject !== resolution.subject ||
        o.obligationId !== obligationIdOf(o.subject, o.occurrence, o.requirement, o.runs) ||
        ids.has(o.obligationId)
      )
        return 'obligation identity does not match its content';
      ids.add(o.obligationId);
      if (o.evaluator.id !== o.runs) return 'obligation evaluator does not match check.runs';
      if (o.evaluator.builtin) {
        if (
          !isBuiltinCheck(o.runs) ||
          o.evaluator.implementationDigest !== `builtin:${o.runs}` ||
          o.evaluator.implementationVersion !== 'builtin' ||
          stableSerialize(o.evidencePolicy) !== stableSerialize({ kind: 'fresh-run' })
        )
          return `${o.runs} is not a built-in evaluator`;
      } else {
        const entry = catalogEntry(context.catalog, o.evaluator.id, o.evaluator.implementationVersion);
        if (
          entry === undefined ||
          entry.implementationDigest !== o.evaluator.implementationDigest ||
          entry.contractVersion !== o.evaluator.contractVersion ||
          stableSerialize(entry.evidencePolicy) !== stableSerialize(o.evidencePolicy)
        )
          return `${o.runs} does not match the catalog`;
      }
      const a = o.applicability as unknown as Record<string, unknown>;
      if (
        a['status'] === 'not-applicable' &&
        !(
          sanitized(a['reason']) &&
          ((a['basis'] === 'predicate' && typeof a['predicate'] === 'string' && PREDICATE_ID.test(a['predicate'])) ||
            (a['basis'] === 'package-metadata' && sanitized(a['source'], 160) && o.provenance.source === 'package'))
        )
      )
        return 'not-applicable lacks resolver evidence';
      if (!['applicable', 'not-applicable', 'undetermined'].includes(a['status'] as string))
        return 'unknown applicability';
      if (o.provenance.source === 'root' && a['basis'] === 'package-metadata')
        return 'package metadata cannot change a root-adopted obligation';
    }
    return undefined;
  } catch {
    return 'resolution could not be read';
  }
}
/**
 * Pure success-transition decision (C28, spec §3). Admits only a verified resolution (D2) resolved against the same
 * catalog and policy in which every required, applicable obligation has a valid passed receipt of at least
 * minimumTrust (D3) as its latest valid result. failed, unavailable, error, cancelled, not-evaluated and
 * evaluator-claimed not-applicable block a required obligation; resolver not-applicable with evidence does not.
 * Optional obligations never block and stay visible as optional-unevaluated or optional-failed. No scheduling,
 * persistence or execution happens here. Host implementations must be bound (bindEvaluators) before invocation;
 * admission itself checks receipts' evaluator digests against the catalog.
 */
export function admitTransition(
  resolution: ObligationResolution,
  receipts: readonly unknown[],
  context: AdmissionContext,
  now: string,
): TransitionDecision {
  trustPolicy(context);
  if (instant(now) === undefined)
    throw new TypeError('admitTransition requires an explicit, real ISO-8601 UTC instant');
  const findings: Finding[] = [],
    decisions: ObligationDecision[] = [],
    scope = typeof resolution.subject === 'string' ? resolution.subject : '<resolution>';
  let usable = resolution.status === 'resolved';
  if (!usable)
    findings.push(
      note(
        'IA-COMP-OBLIGATION-BLOCKED',
        '<transition>',
        'Obligation resolution refused; no transition can be admitted',
      ),
    );
  const unverified = verifyResolution(resolution, context);
  if (unverified !== undefined) {
    usable = false;
    findings.push(note('IA-COMP-OBLIGATION-UNVERIFIED', '<transition>', `Resolution is not verified: ${unverified}`));
  } else if (
    resolution.catalogDigest !== context.catalog.digest ||
    resolution.policyRevision !== context.policyRevision
  ) {
    usable = false;
    findings.push(
      note(
        'IA-COMP-OBLIGATION-CONFLICT',
        '<transition>',
        'Obligations were resolved against a different catalog or policy revision',
      ),
    );
  }
  const byObligation = new Map<string, unknown[]>();
  for (const receipt of receipts) {
    let id = '';
    try {
      const claimed = record(receipt) ? receipt['obligationId'] : undefined;
      id = typeof claimed === 'string' ? claimed : '';
    } catch {
      id = '';
    }
    byObligation.set(id, [...(byObligation.get(id) ?? []), receipt]);
  }
  for (const obligation of usable ? resolution.obligations : []) {
    const base = {
      obligationId: obligation.obligationId,
      requirement: obligation.requirement,
      evaluator: obligation.evaluator.id,
      required: obligation.required,
    };
    const where = obligation.provenance.path,
      label = `${obligation.occurrence}#${obligation.requirement}`;
    const block = (result: EvidenceResult, code: EvidenceCode, message: string, receipt?: EvidenceReceipt) => {
      const optional = !obligation.required;
      decisions.push({
        ...base,
        status: optional ? (result === 'failed' ? 'optional-failed' : 'optional-unevaluated') : 'blocked',
        result,
        ...(receipt === undefined ? {} : { receiptId: receipt.receiptId, trust: receipt.trust }),
      });
      findings.push({
        ...note(
          optional ? 'IA-COMP-NOT-EVALUATED' : code,
          where,
          `${label}: ${message}`,
          obligation.occurrence,
          optional,
        ),
        line: obligation.provenance.line,
      });
    };
    if (obligation.applicability.status === 'not-applicable') {
      decisions.push({ ...base, status: 'not-applicable', result: 'not-applicable' });
      continue;
    }
    if (obligation.applicability.status === 'undetermined') {
      block(
        'not-evaluated',
        'IA-COMP-OBLIGATION-UNDETERMINED',
        `applicability is undetermined (${obligation.applicability.reason})`,
      );
      continue;
    }
    if (!obligation.evaluator.builtin) {
      const entry = catalogEntry(context.catalog, obligation.evaluator.id, obligation.evaluator.implementationVersion);
      const status =
        entry === undefined || entry.implementationDigest !== obligation.evaluator.implementationDigest
          ? 'unavailable'
          : entry.availability.status;
      if (status !== 'supported') {
        block(
          'unavailable',
          status === 'revoked' ? 'IA-COMP-EVALUATOR-REVOKED' : 'IA-COMP-EVALUATOR-UNAVAILABLE',
          `evaluator ${obligation.evaluator.id}@${obligation.evaluator.implementationVersion} is ${status}`,
        );
        continue;
      }
    }
    const validations = (byObligation.get(obligation.obligationId) ?? []).map((r) =>
      validateReceipt(r, { ...context, obligation }, now),
    );
    const valid = validations
      .filter((v) => v.valid)
      .map((v) => v.receipt!)
      .sort(
        (a, b) =>
          Date.parse(b.completedAt) - Date.parse(a.completedAt) ||
          (a.result === 'passed' ? 1 : 0) - (b.result === 'passed' ? 1 : 0) ||
          compareText(a.receiptId, b.receiptId),
      );
    const chosen = valid[0];
    if (chosen === undefined) {
      for (const v of validations)
        findings.push(...v.findings.map((f) => (obligation.required ? f : { ...f, severity: 'warning' as const })));
      block(
        'not-evaluated',
        'IA-COMP-OBLIGATION-BLOCKED',
        validations.length === 0 ? 'no receipt was supplied' : 'no supplied receipt is valid',
      );
      continue;
    }
    if (chosen.result === 'passed') {
      decisions.push({
        ...base,
        status: 'satisfied',
        result: 'passed',
        receiptId: chosen.receiptId,
        trust: chosen.trust,
      });
      continue;
    }
    block(
      chosen.result,
      chosen.result === 'failed' ? 'IA-COMP-OBLIGATION-FAILED' : 'IA-COMP-OBLIGATION-BLOCKED',
      chosen.result === 'not-applicable'
        ? 'an evaluator cannot declare not-applicable; only the resolver can'
        : `latest valid receipt reports ${chosen.result}`,
      chosen,
    );
  }
  const admitted =
    usable && !findings.some((f) => f.severity === 'error') && decisions.every((d) => d.status !== 'blocked');
  const relied = decisions.filter((d) => d.status === 'satisfied').map((d) => d.trust!);
  return deepFreeze({
    admitted,
    subject: scope,
    minimumTrust: context.minimumTrust,
    reliedTrust:
      relied.length === 0 ? 'none' : relied.includes('local-unsigned') ? 'local-unsigned' : 'service-associated',
    decisions: decisions.sort((a, b) => compareText(a.obligationId, b.obligationId)),
    assessment: assess('COMP-TRANSITION', scope, findings),
  });
}
