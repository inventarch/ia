/** C25-C29 producer-boundary observations. Synthetic local receipts qualify the pure APIs, not a live writer or service. */
import type { Graph, Node } from '../../packages/graph/src/index.js';
import {
  EVALUATOR_CATALOG_FORMAT,
  EVIDENCE_RECEIPT_FORMAT,
  acceptEvaluatorOutput,
  admitTransition,
  bindEvaluators,
  createEvaluatorCatalog,
  evidenceDigest,
  resolveObligations,
  validateCheck,
  validateReceipt,
} from '../../packages/compliance/src/index.js';
import type {
  EvaluatorCatalog,
  EvaluatorCodec,
  EvaluatorEntry,
  EvidenceCode,
  EvidenceReceipt,
  Finding,
  FixtureResult,
  Obligation,
  ObligationInput,
  ReceiptContext,
} from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

const hex = (value: string) => `sha256:${value.repeat(64)}`;
const codecs: readonly EvaluatorCodec[] = [
  { id: 'fixture-input@1', validate: () => true },
  {
    id: 'fixture-output@1',
    validate: (value) =>
      typeof value === 'object' && value !== null && typeof (value as { files?: unknown }).files === 'number',
  },
];
const entry: EvaluatorEntry = {
  id: 'fixture-read',
  contractVersion: '1.0.0',
  implementationVersion: '1.0.0',
  implementationDigest: hex('a'),
  inputSchemaId: 'fixture-input@1',
  outputSchemaId: 'fixture-output@1',
  supportedScopes: ['package'],
  effects: ['read'],
  environmentProfile: { id: 'node-offline', credentials: 'none' },
  limits: { timeoutMs: 1000, memoryBytes: 1048576, outputBytes: 1024, concurrency: 1 },
  evidencePolicy: { kind: 'reusable', maxAgeMs: 3600000, environmentSensitive: true },
  availability: { status: 'supported' },
};
const fresh: EvaluatorEntry = {
  ...entry,
  id: 'fixture-fresh',
  implementationDigest: hex('b'),
  evidencePolicy: { kind: 'fresh-run' },
};
const revoked: EvaluatorEntry = {
  ...entry,
  id: 'fixture-revoked',
  implementationDigest: hex('c'),
  availability: { status: 'revoked', reason: 'Fixture revocation' },
};
const unavailable: EvaluatorEntry = {
  ...entry,
  id: 'fixture-unavailable',
  implementationDigest: hex('d'),
  availability: { status: 'unavailable', reason: 'Fixture host has no implementation' },
};
const build = (entries: readonly unknown[], format = EVALUATOR_CATALOG_FORMAT) =>
  createEvaluatorCatalog({ format, entries }, { codecs });

export function runEvidenceFixtures(graph: Graph): readonly FixtureResult[] {
  const built = build([entry, fresh, revoked, unavailable]);
  if (!built.ok) throw new Error('Evidence fixture catalog failed its positive control');
  const catalog: EvaluatorCatalog = built.catalog;
  const input: ObligationInput = {
    subject: 'fixture/package',
    policyRevision: 'fixture-policy-1',
    catalog,
    catalogDigest: catalog.digest,
    facts: {},
    adoptions: [{ identity: 'fixture-adoption', source: 'root', mandatory: true }],
    occurrences: [
      {
        identity: 'fixture-contract',
        word: 'contract',
        adoption: 'fixture-adoption',
        requirement: 'REQ-READ',
        runs: entry.id,
        provenance: { path: 'fixture.ia', line: 1 },
        input: {},
      },
    ],
  };
  const resolution = resolveObligations(input),
    obligation = resolution.obligations[0]!;
  const freshResolution = resolveObligations({
    ...input,
    occurrences: input.occurrences.map((row) => ({ ...row, runs: fresh.id })),
  });
  const freshObligation = freshResolution.obligations[0]!;
  const context: ReceiptContext = {
    catalog,
    attemptId: 'fixture-attempt-2',
    policyRevision: input.policyRevision,
    digests: { candidate: hex('1'), native: hex('2'), code: hex('3'), policy: hex('4'), dependency: hex('5') },
    environment: { id: 'node-offline', toolchain: 'fixture-toolchain' },
    minimumTrust: 'local-unsigned',
  };
  const now = '2026-09-28T10:30:00Z';
  const receipt = (selected: Obligation = obligation, overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt => ({
    format: EVIDENCE_RECEIPT_FORMAT,
    receiptId: 'fixture-receipt',
    attemptId: context.attemptId,
    obligationId: selected.obligationId,
    subject: selected.subject,
    inputDigest: selected.inputDigest,
    digests: context.digests,
    environment: context.environment,
    evaluator: {
      id: selected.evaluator.id,
      implementationVersion: selected.evaluator.implementationVersion,
      implementationDigest: selected.evaluator.implementationDigest,
    },
    catalogDigest: catalog.digest,
    policyRevision: context.policyRevision,
    observedAt: '2026-09-28T10:00:00Z',
    completedAt: '2026-09-28T10:01:00Z',
    result: 'passed',
    evidenceDigest: evidenceDigest({ files: 1 }),
    issuer: 'fixture-local-host',
    trust: 'local-unsigned',
    ...overrides,
  });
  if (
    !validateReceipt(receipt(), { ...context, obligation }, now).valid ||
    !admitTransition(resolution, [receipt()], context, now).admitted
  )
    throw new Error('Evidence fixture receipt/admission failed its positive control');
  const check = [...graph.nodes.values()].find((node) => node.discriminator === 'check');
  if (!check) throw new Error('Evidence fixtures need an admitted check in the supplied corpus');
  const runs = (id: string): Node => ({
    ...check,
    sections: check.sections.map((section) =>
      section.name !== 'check'
        ? section
        : {
            ...section,
            fields: section.fields.map((field) =>
              'key' in field && field.key === 'runs'
                ? { ...field, value: { kind: 'scalar' as const, text: id } }
                : field,
            ),
          },
    ),
  });
  const checked = (overrides: Partial<EvidenceReceipt>, time = now) =>
    validateReceipt(receipt(obligation, overrides), { ...context, obligation }, time).findings;
  const fixtures: readonly [EvidenceCode, () => readonly Finding[]][] = [
    ['IA-COMP-CATALOG-VERSION', () => build([entry], 'ia-evaluator-catalog/2.0').assessment.findings],
    ['IA-COMP-CATALOG-ENTRY-INVALID', () => build([{ ...entry, command: 'unregistered' }]).assessment.findings],
    [
      'IA-COMP-CATALOG-LIMITS',
      () => build([{ ...entry, limits: { ...entry.limits, timeoutMs: 0 } }]).assessment.findings,
    ],
    ['IA-COMP-CATALOG-DUPLICATE', () => build([entry, entry]).assessment.findings],
    [
      'IA-COMP-CATALOG-DIGEST-CONFLICT',
      () => build([entry, { ...entry, implementationDigest: hex('e') }]).assessment.findings,
    ],
    ['IA-COMP-CATALOG-BUILTIN-OVERRIDE', () => build([{ ...entry, id: 'COMP-CHECK' }]).assessment.findings],
    [
      'IA-COMP-CATALOG-CODEC-UNKNOWN',
      () => build([{ ...entry, inputSchemaId: 'unknown-codec@1' }]).assessment.findings,
    ],
    ['IA-COMP-EVALUATOR-UNAVAILABLE', () => validateCheck(runs(unavailable.id), catalog).findings],
    ['IA-COMP-EVALUATOR-REVOKED', () => validateCheck(runs(revoked.id), catalog).findings],
    [
      'IA-COMP-EVALUATOR-SUBSTITUTED',
      () => bindEvaluators(catalog, new Map([[`${entry.id}@${hex('f')}`, () => null]])).assessment.findings,
    ],
    [
      'IA-COMP-EVALUATOR-OUTPUT-INVALID',
      () =>
        acceptEvaluatorOutput(catalog, obligation, {
          kind: 'completed',
          byteLength: entry.limits.outputBytes + 1,
          output: { result: 'passed', evidence: { files: 1 } },
        }).findings,
    ],
    [
      'IA-COMP-OBLIGATION-UNRESOLVED',
      () =>
        resolveObligations({
          ...input,
          occurrences: input.occurrences.map((row) => ({ ...row, runs: 'fixture-unknown' })),
        }).assessment.findings,
    ],
    [
      'IA-COMP-OBLIGATION-CONFLICT',
      () => resolveObligations({ ...input, catalogDigest: hex('e') }).assessment.findings,
    ],
    [
      'IA-COMP-OBLIGATION-UNDETERMINED',
      () =>
        resolveObligations({
          ...input,
          occurrences: input.occurrences.map((row) => ({ ...row, applicability: 'missing-predicate@1' })),
        }).assessment.findings,
    ],
    [
      'IA-COMP-OBLIGATION-WEAKENED',
      () =>
        resolveObligations({
          ...input,
          packageMetadata: [
            {
              occurrence: obligation.occurrence,
              requirement: obligation.requirement,
              action: 'disable',
              source: 'package.json',
            },
          ],
        }).assessment.findings,
    ],
    [
      'IA-COMP-OBLIGATION-FAILED',
      () => admitTransition(resolution, [receipt(obligation, { result: 'failed' })], context, now).assessment.findings,
    ],
    ['IA-COMP-OBLIGATION-BLOCKED', () => admitTransition(resolution, [], context, now).assessment.findings],
    [
      'IA-COMP-OBLIGATION-UNVERIFIED',
      () => admitTransition({ ...resolution }, [receipt()], context, now).assessment.findings,
    ],
    [
      'IA-COMP-RECEIPT-INVALID',
      () => validateReceipt({ ...receipt(), extra: true }, { ...context, obligation }, now).findings,
    ],
    ['IA-COMP-RECEIPT-SUBJECT', () => checked({ subject: 'fixture/other-package' })],
    ['IA-COMP-RECEIPT-STALE', () => checked({ inputDigest: hex('e') })],
    ['IA-COMP-RECEIPT-CODE', () => checked({ digests: { ...context.digests, code: hex('e') } })],
    [
      'IA-COMP-RECEIPT-TOOLCHAIN',
      () => checked({ environment: { ...context.environment, toolchain: 'other-toolchain' } }),
    ],
    [
      'IA-COMP-RECEIPT-EVALUATOR',
      () => checked({ evaluator: { ...receipt().evaluator, implementationDigest: hex('e') } }),
    ],
    [
      'IA-COMP-RECEIPT-REVOKED',
      () =>
        checked({
          evaluator: {
            id: revoked.id,
            implementationVersion: revoked.implementationVersion,
            implementationDigest: revoked.implementationDigest,
          },
        }),
    ],
    ['IA-COMP-RECEIPT-EXPIRED', () => checked({}, '2026-09-28T11:01:01Z')],
    [
      'IA-COMP-RECEIPT-FRESH-RUN',
      () =>
        validateReceipt(
          receipt(freshObligation, { attemptId: 'fixture-attempt-1' }),
          { ...context, obligation: freshObligation },
          now,
        ).findings,
    ],
    ['IA-COMP-RECEIPT-UNTRUSTED', () => checked({ trust: 'service-associated', issuer: 'claimed-service' })],
  ];
  return Object.freeze(
    fixtures.map(([code, run]): FixtureResult => {
      let observed: readonly Finding[] = [],
        failure: string | undefined;
      try {
        observed = run();
      } catch (error) {
        failure = `Fixture threw ${error instanceof Error ? error.name : 'an unknown exception'}`;
      }
      const matches = failure === undefined && observed.some((finding) => finding.code === code);
      return Object.freeze({
        assessment: assess(
          'COMP-FIXTURES',
          `evidence-boundary/${code}`,
          matches
            ? []
            : [
                {
                  code: 'IA-COMP-FIXTURE-MISMATCH',
                  severity: 'error',
                  path: '',
                  line: 1,
                  message: `${code}: ${failure ?? `observed ${observed.map((finding) => finding.code).join(', ') || 'no findings'}`}`,
                },
              ],
        ),
        observedCodes: Object.freeze([...new Set(observed.map((finding) => finding.code))].sort()),
      });
    }),
  );
}
