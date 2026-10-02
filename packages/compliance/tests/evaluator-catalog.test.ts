import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '@ia/language';
import { load, stableSerialize } from '@ia/graph';
import type { Node } from '@ia/graph';
import {
  CHECK_IDS,
  EVALUATION_PROFILES,
  EVALUATOR_CATALOG_FORMAT,
  EVIDENCE_CODES,
  EVIDENCE_RECEIPT_FORMAT,
  acceptEvaluatorOutput,
  adaptBuiltinVerdict,
  admitTransition,
  bindEvaluators,
  createEvaluatorCatalog,
  evaluate,
  evidenceDigest,
  evidenceKey,
  inspectObligations,
  isEvaluatorCatalog,
  profileOccurrences,
  resolutionDigest,
  resolveObligations,
  selectEvaluator,
  validateCheck,
  validateReceipt,
  verdict,
} from '../src/index.js';
import type {
  AdmissionContext,
  EvaluatorCatalog,
  EvaluatorCodec,
  EvidenceReceipt,
  Obligation,
  ObligationInput,
  ObligationResolution,
  ReceiptContext,
  ReportOptions,
} from '../src/index.js';
import { inputs, records, registry, sources } from './native.js';

const hex = (c: string) => `sha256:${c.repeat(64)}`;
const codecs: readonly EvaluatorCodec[] = [
  { id: 'acme-typing-input@1', validate: (v) => typeof v === 'object' },
  {
    id: 'acme-typing-result@1',
    validate: (v) => typeof v === 'object' && v !== null && typeof (v as { files?: unknown }).files === 'number',
  },
];
const typing = {
  id: 'acme-strict-typing',
  contractVersion: '1.0.0',
  implementationVersion: '2.1.0',
  implementationDigest: hex('a'),
  inputSchemaId: 'acme-typing-input@1',
  outputSchemaId: 'acme-typing-result@1',
  supportedScopes: ['package'],
  effects: ['read', 'process'],
  environmentProfile: { id: 'node-22-offline', credentials: 'none' },
  limits: { timeoutMs: 60000, memoryBytes: 536870912, outputBytes: 4096, concurrency: 2 },
  evidencePolicy: { kind: 'reusable', maxAgeMs: 3600000, environmentSensitive: true },
  availability: { status: 'supported' },
};
const coverage = {
  ...typing,
  id: 'acme-file-coverage',
  implementationDigest: hex('b'),
  evidencePolicy: { kind: 'fresh-run' },
};
const lint = {
  ...typing,
  id: 'acme-lint',
  implementationDigest: hex('c'),
  availability: { status: 'unavailable', reason: 'Not installed on this host' },
};
const legacy = {
  ...typing,
  id: 'acme-legacy',
  implementationDigest: hex('d'),
  availability: { status: 'revoked', reason: 'Superseded after advisory 7' },
};
function build(entries: readonly unknown[], format = EVALUATOR_CATALOG_FORMAT) {
  return createEvaluatorCatalog({ format, entries }, { codecs });
}
function catalogOf(entries: readonly unknown[] = [typing, coverage, lint, legacy]): EvaluatorCatalog {
  const result = build(entries);
  if (!result.ok) throw new Error(JSON.stringify(result.assessment.findings));
  return result.catalog;
}
const codesOf = (result: { assessment: { findings: readonly { code: string }[] } }) =>
  result.assessment.findings.map((f) => f.code);

describe('evaluator catalog v1 construction (EVAL-01, EVAL-Q02)', () => {
  it('builds a frozen, deterministic, order-independent catalog', () => {
    const a = catalogOf(),
      b = catalogOf([legacy, lint, coverage, typing]);
    expect(isEvaluatorCatalog(a)).toBe(true);
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.digest);
    expect(a.entries.map((e) => e.id)).toEqual([
      'acme-file-coverage',
      'acme-legacy',
      'acme-lint',
      'acme-strict-typing',
    ]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.entries[0]!.limits)).toBe(true);
    expect(() => {
      (a.entries[0]!.availability as { status: string }).status = 'supported';
    }).toThrow();
    expect(isEvaluatorCatalog({ ...a })).toBe(false);
    expect(a.builtins).toEqual([...CHECK_IDS]);
    expect(catalogOf([{ ...typing, availability: { status: 'revoked', reason: 'Key compromise' } }]).digest).not.toBe(
      catalogOf([typing]).digest,
    );
  });
  it('refuses duplicate id/version, digest disagreement and a built-in override', () => {
    expect(codesOf(build([typing, typing]))).toEqual(['IA-COMP-CATALOG-DUPLICATE']);
    expect(codesOf(build([typing, { ...typing, implementationDigest: hex('e') }]))).toEqual([
      'IA-COMP-CATALOG-DIGEST-CONFLICT',
    ]);
    expect(codesOf(build([{ ...typing, id: 'comp-check' }]))).toEqual(['IA-COMP-CATALOG-BUILTIN-OVERRIDE']);
    expect(codesOf(build([{ ...typing, id: 'COMP-CHECK' }]))).toEqual(['IA-COMP-CATALOG-BUILTIN-OVERRIDE']);
    const custom = createEvaluatorCatalog(
      { format: EVALUATOR_CATALOG_FORMAT, entries: [typing] },
      { codecs, builtins: ['acme-strict-typing'] },
    );
    expect(codesOf(custom)).toEqual(['IA-COMP-CATALOG-BUILTIN-OVERRIDE']);
    // Two supported versions of one id would make check.runs ambiguous.
    expect(
      codesOf(build([typing, { ...typing, implementationVersion: '2.2.0', implementationDigest: hex('f') }])),
    ).toEqual(['IA-COMP-CATALOG-DUPLICATE']);
    expect(
      build([
        { ...typing, availability: { status: 'revoked', reason: 'Old build' } },
        { ...typing, implementationVersion: '2.2.0', implementationDigest: hex('f') },
      ]).ok,
    ).toBe(true);
  });
  it('refuses an unknown format major, an unsupported contract major and malformed format text', () => {
    expect(codesOf(build([typing], 'ia-evaluator-catalog/2.0'))).toEqual(['IA-COMP-CATALOG-VERSION']);
    expect(codesOf(build([typing], 'something-else'))).toEqual(['IA-COMP-CATALOG-VERSION']);
    expect(build([typing], 'ia-evaluator-catalog/1.3').ok).toBe(true);
    expect(codesOf(build([{ ...typing, contractVersion: '2.0.0' }]))).toEqual(['IA-COMP-CATALOG-VERSION']);
  });
  it('refuses non-positive or non-integral limits', () => {
    for (const limits of [
      { ...typing.limits, timeoutMs: 0 },
      { ...typing.limits, memoryBytes: -1 },
      { ...typing.limits, outputBytes: 1.5 },
      { ...typing.limits, concurrency: Number.POSITIVE_INFINITY },
      { timeoutMs: 1, memoryBytes: 1, outputBytes: 1 },
    ])
      expect(codesOf(build([{ ...typing, limits }]))).toEqual(['IA-COMP-CATALOG-LIMITS']);
  });
  it('refuses unknown codec IDs and codec versions the host did not register', () => {
    expect(codesOf(build([{ ...typing, inputSchemaId: 'acme-typing-input@2' }]))).toEqual([
      'IA-COMP-CATALOG-CODEC-UNKNOWN',
    ]);
    expect(codesOf(build([{ ...typing, outputSchemaId: 'unknown@1' }]))).toEqual(['IA-COMP-CATALOG-CODEC-UNKNOWN']);
  });
  it('refuses malformed entries, unknown fields, ambient credentials and unsanitized reasons', () => {
    const bad = [
      { ...typing, id: 'strict typing' },
      { ...typing, id: 'unnamespaced' },
      { ...typing, implementationDigest: 'abc' },
      { ...typing, implementationVersion: 'v2' },
      { ...typing, supportedScopes: [] },
      { ...typing, effects: ['read', 'read'] },
      { ...typing, environmentProfile: { id: 'host', credentials: 'ambient' } },
      { ...typing, evidencePolicy: { kind: 'reusable', maxAgeMs: 0, environmentSensitive: true } },
      { ...typing, evidencePolicy: { kind: 'sometimes' } },
      { ...typing, availability: { status: 'revoked', reason: 'token=abc\nsecret' } },
      { ...typing, availability: { status: 'revoked' } },
      { ...typing, availability: { status: 'supported', reason: 'x' } },
      { ...typing, command: 'rm -rf /' },
      { ...typing, callback: 'module.js#run' },
      null,
      'acme-strict-typing',
    ];
    for (const entry of bad)
      expect(codesOf(build([entry])), JSON.stringify(entry)).toEqual(['IA-COMP-CATALOG-ENTRY-INVALID']);
    const refused = build([typing, { ...typing, id: 'bad id' }]);
    expect(refused.ok).toBe(false);
    expect('catalog' in refused).toBe(false);
  });
  it('declares every new code in a separate frozen inventory', () => {
    expect(Object.isFrozen(EVIDENCE_CODES)).toBe(true);
    expect(new Set(EVIDENCE_CODES).size).toBe(EVIDENCE_CODES.length);
    expect(EVIDENCE_CODES.every((c) => c.startsWith('IA-COMP-'))).toBe(true);
  });
});

describe('check.runs with and without a catalog (EVAL-Q01, EVAL-Q02)', () => {
  const graphOptions = {
    sources: inputs,
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  };
  const graph = load(records, registry, graphOptions);
  const check = [...graph.nodes.values()].find((n) => n.discriminator === 'check')!;
  const runs = (node: Node, text: string): Node => ({
    ...node,
    sections: node.sections.map((s) =>
      s.name === 'check'
        ? {
            ...s,
            fields: s.fields.map((f) =>
              'key' in f && f.key === 'runs' ? { ...f, value: { kind: 'scalar' as const, text } } : f,
            ),
          }
        : s,
    ),
  });
  it('keeps the built-in-only result byte-identical without a catalog', () => {
    const unknown = validateCheck(runs(check, 'acme-strict-typing'));
    expect(unknown.findings.map((f) => f.code)).toEqual(['IA-COMP-CHECK-UNKNOWN']);
    expect(unknown.findings[0]!.message).toBe(
      `${check.source.path}:${check.source.line}: ${check.identity}: Unknown or missing check.runs 'acme-strict-typing'; implemented: ${CHECK_IDS.join(', ')}`,
    );
    expect(stableSerialize(validateCheck(runs(check, 'COMP-MAGIC'), undefined))).toBe(
      stableSerialize(validateCheck(runs(check, 'COMP-MAGIC'))),
    );
  });
  it('admits a supported catalog id, leaves unavailable not-evaluated, fails revoked and still refuses unknown ids', () => {
    const catalog = catalogOf();
    expect(validateCheck(runs(check, 'acme-strict-typing'), catalog).outcome).toBe('pass');
    expect(validateCheck(check, catalog).outcome).toBe('pass');
    // D5: unavailable is visibly unevaluated at declaration level; admission blocks required obligations.
    const unavailable = validateCheck(runs(check, 'acme-lint'), catalog);
    expect(unavailable.outcome).toBe('not-evaluated');
    expect(unavailable.findings.map((f) => [f.code, f.severity])).toEqual([
      ['IA-COMP-EVALUATOR-UNAVAILABLE', 'warning'],
    ]);
    expect(unavailable.findings[0]!.message).toContain('Not installed on this host');
    expect(validateCheck(runs(check, 'acme-legacy'), catalog).findings.map((f) => f.code)).toEqual([
      'IA-COMP-EVALUATOR-REVOKED',
    ]);
    expect(validateCheck(runs(check, 'acme-legacy'), catalog).outcome).toBe('fail');
    expect(validateCheck(runs(check, 'acme-unknown'), catalog).findings.map((f) => f.code)).toEqual([
      'IA-COMP-CHECK-UNKNOWN',
    ]);
    expect(() => validateCheck(check, { ...catalog })).toThrow(TypeError);
  });
  it('leaves existing report verdicts unchanged and runs custom ids only with the exact registration', () => {
    const folders = [...registry.systems.keys()]
      .filter((n) => n !== 'taxonomy')
      .map((name) => {
        const path = `.ia/src/systems/${name}`;
        return {
          name,
          path,
          sources: sources.filter((s) => s.ast.path.startsWith(path + '/')),
          records: records.filter((r) => r.source.path.startsWith(path + '/')),
        };
      });
    const evidence: ReportOptions['evidence'] = new Map(
      ['COMP-KERNEL', 'COMP-FIXTURES'].map((c) => [
        c as 'COMP-KERNEL',
        verdict({ check: c, scope: 't', outcome: 'pass', findings: [] }, graph.revision),
      ]),
    );
    const options = { sourceDiagnostics: [], folders, evidence };
    expect(stableSerialize(evaluate(graph, { ...options, catalog: catalogOf() }))).toBe(
      stableSerialize(evaluate(graph, options)),
    );
    expect(stableSerialize(evaluate(graph, { catalog: catalogOf() }))).toBe(stableSerialize(evaluate(graph)));
    const custom = records.map((r) =>
      r.identity !== check.identity ? r : (runs(check as unknown as Node, 'acme-strict-typing') as unknown as typeof r),
    );
    const changed = load(custom, registry, graphOptions);
    const verdictOf = (report: ReturnType<typeof evaluate>) =>
      report.verdicts.find((v) => v.check === 'COMP-CHECK' && v.scope === check.identity)!;
    expect(verdictOf(evaluate(changed, options)).findings.map((f) => f.code)).toEqual(['IA-COMP-CHECK-UNKNOWN']);
    expect(verdictOf(evaluate(changed, { ...options, catalog: catalogOf() })).outcome).toBe('pass');
    expect(
      verdictOf(
        evaluate(changed, {
          ...options,
          catalog: catalogOf([{ ...typing, availability: { status: 'revoked', reason: 'Compromised' } }]),
        }),
      ).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-EVALUATOR-REVOKED']);
  });
  it('binds host callbacks only by exact id and implementation digest (EVAL-02)', () => {
    const catalog = catalogOf(),
      run = () => 'typing',
      other = () => 'other';
    const bound = bindEvaluators(catalog, new Map([[`acme-strict-typing@${hex('a')}`, run]]));
    expect(bound.assessment.outcome).toBe('pass');
    expect(bound.implementation('acme-strict-typing', hex('a'))).toBe(run);
    expect(bound.implementation('acme-strict-typing', hex('e'))).toBeUndefined();
    const substituted = bindEvaluators(
      catalog,
      new Map([
        [`acme-strict-typing@${hex('e')}`, other],
        [`acme-legacy@${hex('d')}`, other],
        [`acme-unknown@${hex('a')}`, other],
      ]),
    );
    expect(substituted.assessment.findings.map((f) => f.code)).toEqual([
      'IA-COMP-EVALUATOR-SUBSTITUTED',
      'IA-COMP-EVALUATOR-SUBSTITUTED',
      'IA-COMP-EVALUATOR-SUBSTITUTED',
    ]);
    expect(substituted.implementation('acme-strict-typing', hex('a'))).toBeUndefined();
    expect(selectEvaluator(catalog, 'acme-strict-typing')!.implementationDigest).toBe(hex('a'));
  });
});

const catalog = catalogOf();
const facts = { language: 'typescript', packages: ['core'] };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const baseInput = (): Mutable<ObligationInput> => ({
  subject: 'repo/candidate-7',
  policyRevision: 'policy-3',
  catalog,
  catalogDigest: catalog.digest,
  facts,
  adoptions: [
    { identity: 'governance-system/rule/law/strict-typing', source: 'root', mandatory: true },
    { identity: 'pkg/contract/signature/extras', source: 'package', mandatory: false },
  ],
  occurrences: [
    {
      identity: 'governance-system/rule/law/strict-typing',
      word: 'law',
      adoption: 'governance-system/rule/law/strict-typing',
      requirement: 'compiler-run',
      runs: 'acme-strict-typing',
      provenance: { path: '.ia/src/laws/strict.ia', line: 3 },
      applicability: 'typescript-source@1',
      input: { project: 'tsconfig.json' },
    },
    {
      identity: 'governance-system/rule/law/strict-typing',
      word: 'law',
      adoption: 'governance-system/rule/law/strict-typing',
      requirement: 'included-files',
      runs: 'acme-file-coverage',
      provenance: { path: '.ia/src/laws/strict.ia', line: 4 },
    },
    {
      identity: 'pkg/contract/signature/extras',
      word: 'contract',
      adoption: 'pkg/contract/signature/extras',
      requirement: 'REQ-LINT',
      runs: 'acme-lint',
      provenance: { path: 'pkg/extras.ia', line: 9 },
    },
    {
      identity: 'compliance-system/definition/check/check-inventory-check',
      word: 'check',
      adoption: 'governance-system/rule/law/strict-typing',
      requirement: 'declaration',
      runs: 'COMP-CHECK',
      provenance: { path: '.ia/src/checks/x.ia', line: 1 },
    },
  ],
  predicates: new Map([
    [
      'typescript-source@1',
      (f) =>
        f['language'] === 'typescript'
          ? { status: 'applicable' }
          : { status: 'not-applicable', reason: 'No TypeScript sources in scope' },
    ],
  ]),
});

describe('obligation resolution (OBL-01..OBL-03)', () => {
  it('produces immutable, sorted, deterministic obligations from explicit inputs', () => {
    const result = resolveObligations(baseInput());
    expect(result.status).toBe('resolved');
    expect(result.catalogDigest).toBe(catalog.digest);
    expect(result.policyRevision).toBe('policy-3');
    const ids = result.obligations.map((o) => o.obligationId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(4);
    expect(Object.isFrozen(result.obligations)).toBe(true);
    expect(Object.isFrozen(result.obligations[0]!.evaluator)).toBe(true);
    const reversed = { ...baseInput() };
    reversed.occurrences = [...reversed.occurrences].reverse();
    reversed.adoptions = [...reversed.adoptions].reverse();
    expect(stableSerialize(resolveObligations(reversed))).toBe(stableSerialize(result));
    const compiler = result.obligations.find((o) => o.requirement === 'compiler-run')!;
    expect(compiler).toMatchObject({
      subject: 'repo/candidate-7',
      required: true,
      applicability: { status: 'applicable', predicate: 'typescript-source@1' },
      evaluator: {
        id: 'acme-strict-typing',
        implementationVersion: '2.1.0',
        implementationDigest: hex('a'),
        availability: 'supported',
        builtin: false,
      },
      evidencePolicy: { kind: 'reusable' },
      provenance: {
        path: '.ia/src/laws/strict.ia',
        line: 3,
        adoption: 'governance-system/rule/law/strict-typing',
        source: 'root',
      },
    });
    expect(compiler.inputDigest).toMatch(/^sha256:/);
    expect(result.obligations.find((o) => o.runs === 'COMP-CHECK')!.evaluator).toMatchObject({
      builtin: true,
      implementationDigest: 'builtin:COMP-CHECK',
    });
    expect(result.obligations.find((o) => o.runs === 'acme-lint')).toMatchObject({
      required: false,
      evaluator: { availability: 'unavailable' },
    });
  });
  it('distinguishes applicable, not-applicable with reason and undetermined; undetermined required blocks', () => {
    const notApplicable = resolveObligations({ ...baseInput(), facts: { language: 'python' } });
    expect(notApplicable.obligations.find((o) => o.requirement === 'compiler-run')!.applicability).toEqual({
      status: 'not-applicable',
      reason: 'No TypeScript sources in scope',
      basis: 'predicate',
      predicate: 'typescript-source@1',
    });
    for (const predicates of [
      new Map(),
      new Map([
        [
          'typescript-source@1',
          () => {
            throw new Error('secret=hunter2');
          },
        ],
      ]),
      new Map([['typescript-source@1', () => ({ status: 'maybe' })]]),
    ]) {
      const result = resolveObligations({
        ...baseInput(),
        predicates: predicates as NonNullable<ObligationInput['predicates']>,
      });
      expect(result.status).toBe('resolved');
      expect(result.obligations.find((o) => o.requirement === 'compiler-run')!.applicability.status).toBe(
        'undetermined',
      );
      expect(result.assessment.outcome).toBe('fail');
      expect(codesOf(result)).toEqual(['IA-COMP-OBLIGATION-UNDETERMINED']);
      expect(JSON.stringify(result)).not.toContain('hunter2');
    }
  });
  it('refuses unresolved references and policy conflicts without partial output', () => {
    const unknownRun = baseInput();
    unknownRun.occurrences = [
      ...unknownRun.occurrences,
      { ...unknownRun.occurrences[0]!, requirement: 'x', runs: 'acme-missing' },
    ];
    const missingAdoption = baseInput();
    missingAdoption.occurrences = [{ ...missingAdoption.occurrences[0]!, adoption: 'nowhere' }];
    const conflict = baseInput();
    conflict.occurrences = [...conflict.occurrences, { ...conflict.occurrences[0]!, input: { project: 'other.json' } }];
    const shadow = baseInput();
    shadow.adoptions = [
      ...shadow.adoptions,
      { identity: 'governance-system/rule/law/strict-typing', source: 'package', mandatory: false },
    ];
    const pinned = { ...baseInput(), catalogDigest: hex('0') };
    for (const [input, code] of [
      [unknownRun, 'IA-COMP-OBLIGATION-UNRESOLVED'],
      [missingAdoption, 'IA-COMP-OBLIGATION-UNRESOLVED'],
      [conflict, 'IA-COMP-OBLIGATION-CONFLICT'],
      [shadow, 'IA-COMP-OBLIGATION-CONFLICT'],
      [pinned, 'IA-COMP-OBLIGATION-CONFLICT'],
    ] as const) {
      const result = resolveObligations(input);
      expect(result.status).toBe('refused');
      expect(result.obligations).toEqual([]);
      expect(codesOf(result)).toContain(code);
    }
    const duplicate = baseInput();
    duplicate.occurrences = [...duplicate.occurrences, duplicate.occurrences[0]!];
    expect(resolveObligations(duplicate).obligations).toHaveLength(4);
  });
  it('keeps root-adopted obligations required despite package metadata, with a WEAKENED warning (EVAL-02, EVAL-Q03 producer side)', () => {
    const attempt = {
      ...baseInput(),
      packageMetadata: [
        {
          occurrence: 'governance-system/rule/law/strict-typing',
          requirement: 'compiler-run',
          action: 'disable' as const,
          source: 'packages/core/package.json',
        },
        {
          occurrence: 'governance-system/rule/law/strict-typing',
          requirement: 'included-files',
          action: 'optional' as const,
          source: 'packages/core/package.json',
        },
        {
          occurrence: 'pkg/contract/signature/extras',
          requirement: 'REQ-LINT',
          action: 'disable' as const,
          source: 'packages/core/package.json',
        },
      ],
    };
    const result = resolveObligations(attempt);
    expect(result.status).toBe('resolved');
    expect(
      result.obligations
        .filter((o) => o.provenance.source === 'root')
        .every((o) => o.required && o.applicability.status !== 'not-applicable'),
    ).toBe(true);
    expect(codesOf(result).filter((c) => c === 'IA-COMP-OBLIGATION-WEAKENED')).toHaveLength(2);
    expect(result.obligations.find((o) => o.runs === 'acme-lint')!.applicability).toMatchObject({
      status: 'not-applicable',
      basis: 'package-metadata',
      source: 'packages/core/package.json',
      reason: 'Disabled by package metadata packages/core/package.json',
    });
  });
  it('explains selected definitions, versions, applicability and missing support without executing evaluators', () => {
    const input = baseInput();
    input.occurrences = [
      ...input.occurrences,
      { ...input.occurrences[0]!, requirement: 'extra', runs: 'acme-missing' },
    ];
    const explanation = inspectObligations(input);
    expect(explanation.catalogFormat).toBe(EVALUATOR_CATALOG_FORMAT);
    expect(explanation.rows.map((r) => [r.runs, r.support])).toEqual(
      expect.arrayContaining([
        ['acme-strict-typing', 'supported'],
        ['acme-lint', 'unavailable'],
        ['acme-missing', 'unknown'],
        ['COMP-CHECK', 'builtin'],
      ]),
    );
    expect(explanation.rows.find((r) => r.runs === 'acme-strict-typing')).toMatchObject({
      implementationVersion: '2.1.0',
      contractVersion: '1.0.0',
      applicability: { status: 'applicable' },
    });
    expect(Object.isFrozen(explanation.rows)).toBe(true);
    expect(codesOf({ assessment: explanation.assessment })).toContain('IA-COMP-OBLIGATION-UNRESOLVED');
  });
});

describe('receipts and transition admission (EVAL-03, EVAL-04, EVAL-Q07, EVAL-Q08)', () => {
  const resolution = resolveObligations(baseInput());
  const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!;
  const files = resolution.obligations.find((o) => o.requirement === 'included-files')!;
  const builtin = resolution.obligations.find((o) => o.runs === 'COMP-CHECK')!;
  const context: ReceiptContext = {
    catalog,
    attemptId: 'attempt-2',
    policyRevision: 'policy-3',
    digests: { candidate: hex('1'), native: hex('2'), code: hex('3'), policy: hex('4'), dependency: hex('5') },
    environment: { id: 'node-22-offline', toolchain: 'typescript@5.9.2' },
    minimumTrust: 'local-unsigned',
  };
  const receipt = (obligation: Obligation, overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt => ({
    format: EVIDENCE_RECEIPT_FORMAT,
    receiptId: `r-${obligation.requirement}`,
    attemptId: 'attempt-2',
    obligationId: obligation.obligationId,
    subject: obligation.subject,
    inputDigest: obligation.inputDigest,
    digests: context.digests,
    environment: context.environment,
    evaluator: {
      id: obligation.evaluator.id,
      implementationVersion: obligation.evaluator.implementationVersion,
      implementationDigest: obligation.evaluator.implementationDigest,
    },
    catalogDigest: catalog.digest,
    policyRevision: 'policy-3',
    observedAt: '2026-09-28T10:00:00Z',
    completedAt: '2026-09-28T10:01:00Z',
    result: 'passed',
    evidenceDigest: evidenceDigest({ files: 3 }),
    issuer: 'local-host',
    trust: 'local-unsigned',
    ...overrides,
  });
  const now = '2026-09-28T10:30:00Z';
  const all = () => [receipt(compiler), receipt(files), receipt(builtin)];
  it('admits only when every required applicable obligation has a valid passed receipt', () => {
    const decision = admitTransition(resolution, all(), context, now);
    expect(decision.admitted).toBe(true);
    expect(decision.assessment.outcome).toBe('not-evaluated');
    expect(decision.decisions.find((d) => d.obligationId === compiler.obligationId)).toMatchObject({
      status: 'satisfied',
      result: 'passed',
      receiptId: 'r-compiler-run',
    });
    expect(decision.decisions.find((d) => d.evaluator === 'acme-lint')).toMatchObject({
      status: 'optional-unevaluated',
      required: false,
    });
    expect(Object.isFrozen(decision.decisions)).toBe(true);
    const missing = admitTransition(resolution, [receipt(compiler), receipt(builtin)], context, now);
    expect(missing.admitted).toBe(false);
    expect(missing.decisions.find((d) => d.obligationId === files.obligationId)).toMatchObject({
      status: 'blocked',
      result: 'not-evaluated',
    });
    expect(admitTransition({ ...resolution, status: 'refused', obligations: [] }, all(), context, now).admitted).toBe(
      false,
    );
  });
  it('blocks failed, unavailable, error, cancelled, not-evaluated and evaluator-claimed not-applicable results', () => {
    for (const result of ['failed', 'unavailable', 'error', 'cancelled', 'not-evaluated', 'not-applicable'] as const) {
      const decision = admitTransition(
        resolution,
        [receipt(compiler, { result }), receipt(files), receipt(builtin)],
        context,
        now,
      );
      expect(decision.admitted, result).toBe(false);
      expect(decision.decisions.find((d) => d.obligationId === compiler.obligationId)!.result).toBe(result);
      expect(decision.assessment.findings.map((f) => f.code)).toContain(
        result === 'failed' ? 'IA-COMP-OBLIGATION-FAILED' : 'IA-COMP-OBLIGATION-BLOCKED',
      );
    }
  });
  it('blocks a required obligation whose applicability is undetermined, and accepts resolver not-applicable evidence', () => {
    const undetermined = resolveObligations({ ...baseInput(), predicates: new Map() });
    expect(admitTransition(undetermined, all(), context, now).admitted).toBe(false);
    const skipped = resolveObligations({ ...baseInput(), facts: { language: 'python' } });
    const decision = admitTransition(
      skipped,
      [receipt(skipped.obligations.find((o) => o.requirement === 'included-files')!), receipt(builtin)],
      context,
      now,
    );
    expect(decision.admitted).toBe(true);
    expect(decision.decisions.find((d) => d.requirement === 'compiler-run')).toMatchObject({
      status: 'not-applicable',
    });
  });
  it('blocks a required obligation whose evaluator is unavailable or revoked', () => {
    const input = baseInput();
    input.adoptions = input.adoptions.map((a) => ({ ...a, source: 'root', mandatory: true }));
    const strict = resolveObligations(input),
      lintObligation = strict.obligations.find((o) => o.runs === 'acme-lint')!;
    const decision = admitTransition(strict, [...strict.obligations.map((o) => receipt(o))], context, now);
    expect(decision.admitted).toBe(false);
    expect(decision.decisions.find((d) => d.obligationId === lintObligation.obligationId)).toMatchObject({
      status: 'blocked',
      result: 'unavailable',
    });
    expect(decision.assessment.findings.map((f) => f.code)).toContain('IA-COMP-EVALUATOR-UNAVAILABLE');
  });
  it('rejects stale input, wrong subject, wrong code, wrong toolchain, forged and revoked evaluators (EVAL-04)', () => {
    const expectation = { ...context, obligation: compiler };
    const cases: readonly [Partial<EvidenceReceipt>, string][] = [
      [{ digests: { ...context.digests, candidate: hex('9') } }, 'IA-COMP-RECEIPT-STALE'],
      [{ inputDigest: hex('9') }, 'IA-COMP-RECEIPT-STALE'],
      [{ policyRevision: 'policy-2' }, 'IA-COMP-RECEIPT-STALE'],
      [{ subject: 'repo/other' }, 'IA-COMP-RECEIPT-SUBJECT'],
      [{ obligationId: files.obligationId }, 'IA-COMP-RECEIPT-SUBJECT'],
      [{ digests: { ...context.digests, code: hex('9') } }, 'IA-COMP-RECEIPT-CODE'],
      [{ environment: { ...context.environment, toolchain: 'typescript@4.0.0' } }, 'IA-COMP-RECEIPT-TOOLCHAIN'],
      [
        { evaluator: { id: 'acme-strict-typing', implementationVersion: '2.1.0', implementationDigest: hex('e') } },
        'IA-COMP-RECEIPT-EVALUATOR',
      ],
      [
        { evaluator: { id: 'acme-legacy', implementationVersion: '2.1.0', implementationDigest: hex('d') } },
        'IA-COMP-RECEIPT-REVOKED',
      ],
      [{ format: 'ia-evidence-receipt/2' as typeof EVIDENCE_RECEIPT_FORMAT }, 'IA-COMP-RECEIPT-INVALID'],
      [{ completedAt: '2026-09-28T11:00:00Z' }, 'IA-COMP-RECEIPT-INVALID'],
      [{ result: 'great' as 'passed' }, 'IA-COMP-RECEIPT-INVALID'],
      [{ trust: 'service-associated', issuer: 'anyone' }, 'IA-COMP-RECEIPT-UNTRUSTED'],
    ];
    for (const [overrides, code] of cases) {
      const validation = validateReceipt(receipt(compiler, overrides), expectation, now);
      expect(validation.valid, code).toBe(false);
      expect(
        validation.findings.map((f) => f.code),
        JSON.stringify(overrides),
      ).toEqual([code]);
    }
    expect(validateReceipt({ ...receipt(compiler), extra: 1 }, expectation, now).findings.map((f) => f.code)).toEqual([
      'IA-COMP-RECEIPT-INVALID',
    ]);
    expect(
      validateReceipt(
        receipt(compiler, { trust: 'service-associated', issuer: 'svc' }),
        { ...expectation, verifyServiceReceipt: (r) => r.issuer === 'svc' },
        now,
      ).valid,
    ).toBe(true);
    expect(
      validateReceipt(receipt(compiler), { ...expectation, minimumTrust: 'service-associated' }, now).findings.map(
        (f) => f.code,
      ),
    ).toEqual(['IA-COMP-RECEIPT-UNTRUSTED']);
    // Revoking the installed implementation after the fact rejects its receipts.
    const revoked = catalogOf([
      { ...typing, availability: { status: 'revoked', reason: 'Compromised build' } },
      coverage,
    ]);
    expect(
      validateReceipt(receipt(compiler), { ...expectation, catalog: revoked }, now).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-REVOKED']);
    // A rejected receipt cannot satisfy the transition.
    expect(
      admitTransition(
        resolution,
        [receipt(compiler, { subject: 'repo/other' }), receipt(files), receipt(builtin)],
        context,
        now,
      ).admitted,
    ).toBe(false);
  });
  it('permits reuse only under a matching reusable policy and always requires this attempt for fresh-run (EVAL-Q08)', () => {
    const reused = receipt(compiler, { attemptId: 'attempt-1' });
    expect(validateReceipt(reused, { ...context, obligation: compiler }, now).valid).toBe(true);
    expect(
      validateReceipt(reused, { ...context, obligation: compiler }, '2026-09-28T11:01:01Z').findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-EXPIRED']);
    expect(
      validateReceipt(
        receipt(compiler, { environment: { ...context.environment, id: 'node-22-online' } }),
        { ...context, obligation: compiler },
        now,
      ).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-STALE']);
    const fresh = receipt(files, { attemptId: 'attempt-1' });
    expect(validateReceipt(fresh, { ...context, obligation: files }, now).findings.map((f) => f.code)).toEqual([
      'IA-COMP-RECEIPT-FRESH-RUN',
    ]);
    expect(
      validateReceipt(
        receipt(builtin, { attemptId: 'attempt-1' }),
        { ...context, obligation: builtin },
        now,
      ).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-FRESH-RUN']);
    expect(admitTransition(resolution, [receipt(compiler), fresh, receipt(builtin)], context, now).admitted).toBe(
      false,
    );
    expect(admitTransition(resolution, [reused, receipt(files), receipt(builtin)], context, now).admitted).toBe(true);
    // Deduplication key: candidate, obligation, evaluator, policy, relevant environment and the attempt for fresh-run.
    const key = evidenceKey(compiler, context);
    expect(evidenceKey(compiler, { ...context, attemptId: 'attempt-9' })).toBe(key);
    expect(evidenceKey(compiler, { ...context, environment: { ...context.environment, id: 'other' } })).not.toBe(key);
    expect(evidenceKey(compiler, { ...context, digests: { ...context.digests, candidate: hex('8') } })).not.toBe(key);
    expect(evidenceKey(compiler, { ...context, policyRevision: 'policy-4' })).not.toBe(key);
    expect(evidenceKey(files, context)).not.toBe(evidenceKey(files, { ...context, attemptId: 'attempt-9' }));
    expect(validateReceipt(receipt(compiler), { ...context, obligation: compiler }, now).key).toBe(key);
  });
  it('turns timeouts, crashes, oversized or invalid output into bounded, secret-free error results (EVAL-Q07)', () => {
    const secret = 'sk-live-0123456789';
    const oversized = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 4097,
      output: { result: 'passed', evidence: { files: 1, leaked: secret } },
    });
    expect(oversized.result).toBe('error');
    expect(oversized.findings.map((f) => f.code)).toEqual(['IA-COMP-EVALUATOR-OUTPUT-INVALID']);
    expect(JSON.stringify(oversized)).not.toContain(secret);
    const invalid = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 10,
      output: { result: 'passed', evidence: { nope: secret } },
    });
    expect(invalid.result).toBe('error');
    expect(JSON.stringify(invalid)).not.toContain(secret);
    expect(
      acceptEvaluatorOutput(catalog, compiler, {
        kind: 'completed',
        byteLength: 10,
        output: { result: 'not-applicable', evidence: { files: 1 } },
      }).result,
    ).toBe('error');
    const throwing = acceptEvaluatorOutput(
      (
        createEvaluatorCatalog(
          { format: EVALUATOR_CATALOG_FORMAT, entries: [typing] },
          {
            codecs: [
              codecs[0]!,
              {
                id: 'acme-typing-result@1',
                validate: () => {
                  throw new Error(secret);
                },
              },
            ],
          },
        ) as { catalog: EvaluatorCatalog }
      ).catalog,
      compiler,
      { kind: 'completed', byteLength: 10, output: { result: 'passed', evidence: { files: 1 } } },
    );
    expect(throwing.result).toBe('error');
    expect(JSON.stringify(throwing)).not.toContain(secret);
    expect(acceptEvaluatorOutput(catalog, compiler, { kind: 'timeout' })).toMatchObject({
      result: 'error',
      diagnostics: ['Evaluator exceeded its 60000 ms timeout'],
    });
    expect(acceptEvaluatorOutput(catalog, compiler, { kind: 'crashed' }).result).toBe('error');
    expect(acceptEvaluatorOutput(catalog, compiler, { kind: 'cancelled' }).result).toBe('cancelled');
    expect(acceptEvaluatorOutput(catalog, compiler, { kind: 'unavailable' }).result).toBe('unavailable');
    const lintObligation = resolution.obligations.find((o) => o.runs === 'acme-lint')!;
    expect(
      acceptEvaluatorOutput(catalog, lintObligation, {
        kind: 'completed',
        byteLength: 1,
        output: { result: 'passed', evidence: { files: 1 } },
      }).result,
    ).toBe('unavailable');
    const failed = acceptEvaluatorOutput(
      catalog,
      compiler,
      {
        kind: 'completed',
        byteLength: 100,
        output: {
          result: 'failed',
          evidence: { files: 2 },
          diagnostics: [
            `src/a.ts:1 error token=${secret}`,
            `Authorization: Bearer ${secret}`,
            'x'.repeat(1000),
            ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
          ],
        },
      },
      { secrets: [secret] },
    );
    expect(failed.result).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failed.diagnostics.length).toBeLessThanOrEqual(20);
    expect(failed.diagnostics.every((d) => d.length <= 240)).toBe(true);
    expect(failed.evidenceDigest).toBe(evidenceDigest({ files: 2 }));
    const passed = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 10,
      output: { result: 'passed', evidence: { files: 3 } },
    });
    expect(passed).toMatchObject({ result: 'passed', evidenceDigest: evidenceDigest({ files: 3 }), findings: [] });
    const blocked = admitTransition(
      resolution,
      [
        receipt(compiler, { result: oversized.result, evidenceDigest: oversized.evidenceDigest }),
        receipt(files),
        receipt(builtin),
      ],
      context,
      now,
    );
    expect(blocked.admitted).toBe(false);
  });
});

describe('LK-04 repair: facilitator decisions D1-D6 and review must-fixes', () => {
  const graph = load(records, registry, {
    sources: inputs,
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
  const check = [...graph.nodes.values()].find((n) => n.discriminator === 'check')!;
  const runs = (node: Node, text: string): Node => ({
    ...node,
    sections: node.sections.map((s) =>
      s.name === 'check'
        ? {
            ...s,
            fields: s.fields.map((f) =>
              'key' in f && f.key === 'runs' ? { ...f, value: { kind: 'scalar' as const, text } } : f,
            ),
          }
        : s,
    ),
  });
  const context: AdmissionContext = {
    catalog,
    attemptId: 'attempt-2',
    policyRevision: 'policy-3',
    digests: { candidate: hex('1'), native: hex('2'), code: hex('3'), policy: hex('4'), dependency: hex('5') },
    environment: { id: 'node-22-offline', toolchain: 'typescript@5.9.2' },
    minimumTrust: 'local-unsigned',
  };
  const now = '2026-09-28T10:30:00Z';
  const receipt = (obligation: Obligation, overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt => ({
    format: EVIDENCE_RECEIPT_FORMAT,
    receiptId: `r-${obligation.requirement}`,
    attemptId: 'attempt-2',
    obligationId: obligation.obligationId,
    subject: obligation.subject,
    inputDigest: obligation.inputDigest,
    digests: context.digests,
    environment: context.environment,
    evaluator: {
      id: obligation.evaluator.id,
      implementationVersion: obligation.evaluator.implementationVersion,
      implementationDigest: obligation.evaluator.implementationDigest,
    },
    catalogDigest: catalog.digest,
    policyRevision: 'policy-3',
    observedAt: '2026-09-28T10:00:00Z',
    completedAt: '2026-09-28T10:01:00Z',
    result: 'passed',
    evidenceDigest: evidenceDigest({ files: 3 }),
    issuer: 'local-host',
    trust: 'local-unsigned',
    ...overrides,
  });
  const resolution = resolveObligations(baseInput());
  const passing = (r: ObligationResolution, overrides: Partial<EvidenceReceipt> = {}) =>
    r.obligations
      .filter((o) => o.applicability.status === 'applicable' && o.evaluator.availability === 'supported')
      .map((o) => receipt(o, overrides));
  const failureCodes = (decision: { assessment: { findings: readonly { code: string; severity: string }[] } }) =>
    decision.assessment.findings.filter((f) => f.severity === 'error').map((f) => f.code);

  it('D1: package metadata never weakens any root-adopted obligation, mandatory or not', () => {
    const input = baseInput();
    input.adoptions = [
      { identity: 'governance-system/rule/law/strict-typing', source: 'root', mandatory: false },
      input.adoptions[1]!,
    ];
    input.occurrences = input.occurrences.map((o, i) =>
      i === 0 ? { ...o, required: true } : i === 1 ? { ...o, required: false } : o,
    );
    input.packageMetadata = [
      {
        occurrence: 'governance-system/rule/law/strict-typing',
        requirement: 'compiler-run',
        action: 'disable',
        source: 'packages/core/package.json',
      },
      {
        occurrence: 'governance-system/rule/law/strict-typing',
        requirement: 'included-files',
        action: 'disable',
        source: 'packages/core/package.json',
      },
    ];
    const result = resolveObligations(input);
    expect(result.status).toBe('resolved');
    expect(result.obligations.find((o) => o.requirement === 'compiler-run')).toMatchObject({
      required: true,
      applicability: { status: 'applicable' },
    });
    expect(result.obligations.find((o) => o.requirement === 'included-files')).toMatchObject({
      required: false,
      applicability: { status: 'applicable' },
    });
    expect(codesOf(result)).toEqual(['IA-COMP-OBLIGATION-WEAKENED', 'IA-COMP-OBLIGATION-WEAKENED']);
  });
  it('D2: admission verifies the resolver-issued resolution and refuses forged or modified copies', () => {
    expect(resolution.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolutionDigest(resolution)).toBe(resolution.digest);
    expect(admitTransition(resolution, passing(resolution), context, now).admitted).toBe(true);
    const copy = structuredClone(resolution) as ObligationResolution;
    // An unbranded copy needs a host-pinned digest; the embedded digest alone proves nothing.
    expect(failureCodes(admitTransition(copy, passing(resolution), context, now))).toContain(
      'IA-COMP-OBLIGATION-UNVERIFIED',
    );
    expect(
      admitTransition(copy, passing(resolution), { ...context, expectedResolutionDigest: resolution.digest }, now)
        .admitted,
    ).toBe(true);
    const forged: ObligationResolution[] = [
      { ...resolution, obligations: resolution.obligations.map((o) => ({ ...o, required: false })) },
      {
        ...resolution,
        obligations: resolution.obligations.map((o) => ({
          ...o,
          applicability: {
            status: 'not-applicable',
            reason: 'forged',
            basis: 'predicate',
            predicate: 'typescript-source@1',
          } as const,
        })),
      },
      { ...resolution, obligations: resolution.obligations.filter((o) => o.requirement !== 'compiler-run') },
      {
        ...resolution,
        obligations: resolution.obligations.map((o) =>
          o.requirement !== 'compiler-run'
            ? o
            : { ...o, evaluator: { ...o.evaluator, implementationDigest: hex('e') } },
        ),
      },
    ];
    for (const r of forged)
      for (const pin of [undefined, resolution.digest]) {
        const decision = admitTransition(
          r,
          passing(resolution),
          pin === undefined ? context : { ...context, expectedResolutionDigest: pin },
          now,
        );
        expect(decision.admitted).toBe(false);
        expect(failureCodes(decision)).toContain('IA-COMP-OBLIGATION-UNVERIFIED');
      }
    // Even a self-consistent digest the host pins cannot relabel a revoked catalog evaluator as a built-in, or drop not-applicable evidence.
    const legacyResolution = resolveObligations({
      ...baseInput(),
      occurrences: [
        { ...baseInput().occurrences[0]!, runs: 'acme-legacy', applicability: undefined as unknown as string },
      ].map(({ applicability: _a, ...o }) => o),
    });
    const legacyObligation = legacyResolution.obligations[0]!;
    expect(legacyObligation.evaluator.availability).toBe('revoked');
    const relabelled = {
      ...legacyResolution,
      obligations: [
        {
          ...legacyObligation,
          evaluator: {
            id: 'acme-legacy',
            contractVersion: '1.0.0',
            implementationVersion: 'builtin',
            implementationDigest: 'builtin:acme-legacy',
            builtin: true,
            availability: 'supported' as const,
          },
        },
      ],
    };
    const relabelledDigest = resolutionDigest(relabelled);
    const relabelDecision = admitTransition(
      { ...relabelled, digest: relabelledDigest },
      [receipt(relabelled.obligations[0]!)],
      { ...context, expectedResolutionDigest: relabelledDigest },
      now,
    );
    expect(relabelDecision.admitted).toBe(false);
    expect(failureCodes(relabelDecision)).toContain('IA-COMP-OBLIGATION-UNVERIFIED');
    const bare = {
      ...resolution,
      obligations: resolution.obligations.map((o) =>
        o.requirement !== 'compiler-run'
          ? o
          : {
              ...o,
              applicability: { status: 'not-applicable', reason: 'trust me' } as unknown as Obligation['applicability'],
            },
      ),
    };
    const bareDigest = resolutionDigest(bare);
    expect(
      failureCodes(
        admitTransition(
          { ...bare, digest: bareDigest },
          passing(resolution),
          { ...context, expectedResolutionDigest: bareDigest },
          now,
        ),
      ),
    ).toContain('IA-COMP-OBLIGATION-UNVERIFIED');
  });
  it('D3: service trust needs an explicit host verifier, minimumTrust is required, and decisions record trust', () => {
    const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!,
      expectation = { ...context, obligation: compiler };
    const service = receipt(compiler, { trust: 'service-associated', issuer: 'svc' });
    expect(validateReceipt(service, expectation, now).findings.map((f) => f.code)).toEqual([
      'IA-COMP-RECEIPT-UNTRUSTED',
    ]);
    expect(
      validateReceipt(service, { ...expectation, verifyServiceReceipt: () => false }, now).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-UNTRUSTED']);
    expect(
      validateReceipt(
        service,
        {
          ...expectation,
          verifyServiceReceipt: () => {
            throw new Error('boom');
          },
        },
        now,
      ).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-UNTRUSTED']);
    expect(
      validateReceipt(service, { ...expectation, verifyServiceReceipt: (r) => r.receiptId === service.receiptId }, now)
        .valid,
    ).toBe(true);
    const { minimumTrust: _m, ...withoutTrust } = context;
    expect(() => admitTransition(resolution, passing(resolution), withoutTrust as AdmissionContext, now)).toThrow(
      TypeError,
    );
    const local = admitTransition(resolution, passing(resolution), context, now);
    expect(local.minimumTrust).toBe('local-unsigned');
    expect(local.reliedTrust).toBe('local-unsigned');
    expect(local.decisions.filter((d) => d.status === 'satisfied').every((d) => d.trust === 'local-unsigned')).toBe(
      true,
    );
    const strict = {
      ...context,
      minimumTrust: 'service-associated' as const,
      verifyServiceReceipt: (r: EvidenceReceipt) => r.issuer === 'svc',
    };
    expect(admitTransition(resolution, passing(resolution), strict, now).admitted).toBe(false);
    const verified = admitTransition(
      resolution,
      passing(resolution, { trust: 'service-associated', issuer: 'svc' }),
      strict,
      now,
    );
    expect(verified.admitted).toBe(true);
    expect(verified.reliedTrust).toBe('service-associated');
  });
  it('D4: only CHECK_IDS are built-in; reserved ids block overrides but never pass or resolve', () => {
    const reserved = createEvaluatorCatalog(
      { format: EVALUATOR_CATALOG_FORMAT, entries: [typing] },
      { codecs, builtins: ['APPS-ANYTHING'] },
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.catalog.builtins).toEqual([...CHECK_IDS]);
    expect(reserved.catalog.reserved).toEqual(['APPS-ANYTHING']);
    expect(validateCheck(runs(check, 'APPS-ANYTHING'), reserved.catalog).findings.map((f) => f.code)).toEqual([
      'IA-COMP-CHECK-UNKNOWN',
    ]);
    expect(
      codesOf(
        createEvaluatorCatalog(
          { format: EVALUATOR_CATALOG_FORMAT, entries: [{ ...typing, id: 'apps-anything' }] },
          { codecs, builtins: ['APPS-ANYTHING'] },
        ),
      ),
    ).toEqual(['IA-COMP-CATALOG-BUILTIN-OVERRIDE']);
    const input = baseInput();
    input.catalog = reserved.catalog;
    input.catalogDigest = reserved.catalog.digest;
    input.occurrences = [{ ...input.occurrences[3]!, runs: 'APPS-ANYTHING' }];
    expect(codesOf(resolveObligations(input))).toContain('IA-COMP-OBLIGATION-UNRESOLVED');
    for (const builtins of [[1], 'APPS', [''], ['bad id']])
      expect(() =>
        createEvaluatorCatalog(
          { format: EVALUATOR_CATALOG_FORMAT, entries: [] },
          { codecs, builtins: builtins as unknown as string[] },
        ),
      ).toThrow(TypeError);
  });
  it('D5: an unavailable catalog evaluator leaves COMP-CHECK not-evaluated in reports; revoked fails', () => {
    const custom = records.map((r) =>
      r.identity !== check.identity ? r : (runs(check as unknown as Node, 'acme-lint') as unknown as typeof r),
    );
    const report = evaluate(
      load(custom, registry, {
        sources: inputs,
        languageVersion: LANGUAGE_VERSION,
        kernelDigest: KERNEL_DIGEST,
        location: '',
      }),
      { catalog },
    );
    expect(report.verdicts.find((v) => v.check === 'COMP-CHECK' && v.scope === check.identity)!.outcome).toBe(
      'not-evaluated',
    );
  });
  it('D6 / OBL-02: strict-typing-v1 maps to three required catalog obligations that presence never satisfies', () => {
    expect(EVALUATION_PROFILES['strict-typing-v1']).toEqual([
      'configuration',
      'included-file-coverage',
      'compiler-run',
    ]);
    const binding = {
      occurrence: 'governance-system/rule/law/strict-typing',
      word: 'law' as const,
      adoption: 'governance-system/rule/law/strict-typing',
      provenance: { path: '.ia/src/laws/strict.ia', line: 3 },
      evaluators: {
        configuration: 'acme-strict-typing',
        'included-file-coverage': 'acme-file-coverage',
        'compiler-run': 'acme-strict-typing',
      },
      input: { project: 'tsconfig.json' },
    };
    const occurrences = profileOccurrences('strict-typing-v1', binding);
    expect(occurrences.map((o) => [o.requirement, o.runs, o.required])).toEqual([
      ['strict-typing-v1/configuration', 'acme-strict-typing', true],
      ['strict-typing-v1/included-file-coverage', 'acme-file-coverage', true],
      ['strict-typing-v1/compiler-run', 'acme-strict-typing', true],
    ]);
    expect(() =>
      profileOccurrences('strict-typing-v1', {
        ...binding,
        evaluators: { ...binding.evaluators, 'compiler-run': 'COMP-CHECK' },
      }),
    ).toThrow(TypeError);
    expect(() => profileOccurrences('strict-typing-v2' as 'strict-typing-v1', binding)).toThrow(TypeError);
    const input = baseInput();
    input.occurrences = [...occurrences];
    input.adoptions = [{ identity: 'governance-system/rule/law/strict-typing', source: 'package', mandatory: false }];
    const profile = resolveObligations(input);
    expect(profile.obligations).toHaveLength(3);
    expect(
      profile.obligations.every((o) => o.required && !o.evaluator.builtin && o.applicability.status === 'applicable'),
    ).toBe(true);
    // Native cases and check declarations exist in the corpus, but only receipts count: nothing passes by presence.
    expect(records.some((r) => r.discriminator === 'case')).toBe(true);
    const none = admitTransition(profile, [], context, now);
    expect(none.admitted).toBe(false);
    expect(none.decisions.map((d) => [d.status, d.result])).toEqual([
      ['blocked', 'not-evaluated'],
      ['blocked', 'not-evaluated'],
      ['blocked', 'not-evaluated'],
    ]);
    const two = passing(profile).slice(0, 2);
    expect(admitTransition(profile, two, context, now).admitted).toBe(false);
    expect(admitTransition(profile, passing(profile), context, now).admitted).toBe(true);
  });
  it('M2: redacts credential assignments by pattern, quoted JSON keys and quoted api keys, normalising control characters first', () => {
    const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!;
    const lines = [
      'GITHUB_TOKEN=ghp_abc123',
      'export AWS_SECRET_ACCESS_KEY=AKIAxyz987',
      '{"password":"hunter2","user":"bob"}',
      "api_key 'k-live-555'",
      'Authorization: Bearer abc.def.ghi',
      'private-key: zzz-top',
      'DB_PASSWD = s3cr3t',
      'client_credential:cred-777',
      'x-auth=tok-888',
      'value a\tsupersecret9 here',
      'src/a.ts:1 error TS2322',
    ];
    const failed = acceptEvaluatorOutput(
      catalog,
      compiler,
      { kind: 'completed', byteLength: 100, output: { result: 'failed', evidence: { files: 1 }, diagnostics: lines } },
      { secrets: ['a\tsupersecret9'] },
    );
    const text = JSON.stringify(failed.diagnostics);
    for (const secret of [
      'ghp_abc123',
      'AKIAxyz987',
      'hunter2',
      'k-live-555',
      'abc.def.ghi',
      'zzz-top',
      's3cr3t',
      'cred-777',
      'tok-888',
      'supersecret9',
    ])
      expect(text, secret).not.toContain(secret);
    expect(failed.diagnostics).toContain('src/a.ts:1 error TS2322');
    expect(failed.diagnostics.some((d) => d.includes('"user":"bob"'))).toBe(true);
    const sliced = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 10,
      output: {
        result: 'failed',
        evidence: { files: 1 },
        diagnostics: [...Array.from({ length: 20 }, (_, i) => i), 'late line'],
      },
    });
    expect(sliced.diagnostics).toEqual([]);
  });
  it('redaction stays linear on hostile lines: repeated keywords, long tokens and unmatched quotes (no catastrophic backtracking)', () => {
    const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!;
    const hostile = [
      'token'.repeat(1600),
      'auth-'.repeat(1600),
      `${'a'.repeat(60000)}=`,
      'a "'.repeat(20000),
      'x '.repeat(30000) + 'password=leak-999',
    ];
    const started = performance.now();
    const result = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 100,
      output: { result: 'failed', evidence: { files: 1 }, diagnostics: hostile },
    });
    // Previously an 8,000-character keyword run took over a minute; the bound is generous for slow CI runners.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.diagnostics).toHaveLength(hostile.length);
    for (const line of result.diagnostics) expect(line.length).toBeLessThanOrEqual(240);
    // A credential assignment near the start of a long line is still redacted; text beyond the 240-character output is never emitted.
    const early = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 100,
      output: { result: 'failed', evidence: { files: 1 }, diagnostics: [`api_token=live-123 ${'y'.repeat(50000)}`] },
    });
    expect(JSON.stringify(early.diagnostics)).not.toContain('live-123');
    const chained = acceptEvaluatorOutput(catalog, compiler, {
      kind: 'completed',
      byteLength: 100,
      output: {
        result: 'failed',
        evidence: { files: 1 },
        diagnostics: ['a=token=chain-456', 'mode: fast, note "x", DB_TOKEN: t-789'],
      },
    });
    for (const secret of ['chain-456', 't-789'])
      expect(JSON.stringify(chained.diagnostics), secret).not.toContain(secret);
    expect(chained.diagnostics[1]).toContain('mode: fast');
  });
  it('M3: package directives use a closed action set and valid references; malformed occurrences refuse', () => {
    for (const directive of [
      {
        occurrence: 'pkg/contract/signature/extras',
        requirement: 'REQ-LINT',
        action: 'enforce',
        source: 'packages/core/package.json',
      },
      { occurrence: 42, requirement: 'REQ-LINT', action: 'disable', source: 'p' },
      { occurrence: 'pkg/contract/signature/extras', requirement: 'REQ-LINT', action: 'disable', source: 'token=abc' },
    ]) {
      const result = resolveObligations({ ...baseInput(), packageMetadata: [directive as never] });
      expect(result.status).toBe('refused');
      expect(codesOf(result)).toContain('IA-COMP-OBLIGATION-UNRESOLVED');
    }
    const input = baseInput();
    input.occurrences = [{ ...input.occurrences[1]!, provenance: undefined as never }];
    expect(resolveObligations(input).status).toBe('refused');
  });
  it('catalog top level is exactly {format, entries}; the digest includes the minor version', () => {
    expect(
      codesOf(
        createEvaluatorCatalog({ format: EVALUATOR_CATALOG_FORMAT, entries: [typing], revocations: [] } as never, {
          codecs,
        }),
      ),
    ).toEqual(['IA-COMP-CATALOG-VERSION']);
    const minor = build([typing], 'ia-evaluator-catalog/1.3');
    expect(minor.ok && minor.catalog.digest).not.toBe(catalogOf([typing]).digest);
    const lined = build([{ ...typing, id: 'bad id' }, typing, typing]);
    expect(lined.assessment.findings.map((f) => [f.code, f.line])).toEqual([
      ['IA-COMP-CATALOG-ENTRY-INVALID', 1],
      ['IA-COMP-CATALOG-DUPLICATE', 3],
    ]);
  });
  it('acceptEvaluatorOutput never throws for evaluator output, accepts only JSON evidence and refuses built-ins', () => {
    const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('secret=trap');
        },
      },
    );
    const cyclic: Record<string, unknown> = { files: 1 };
    cyclic['self'] = cyclic;
    for (const output of [
      hostile,
      { result: 'passed', evidence: { files: 1, when: new Date(0) } },
      { result: 'passed', evidence: { files: 1, run: () => 1 } },
      { result: 'passed', evidence: cyclic },
      { result: 'passed', evidence: new Map([['files', 1]]) },
      { result: 'passed', evidence: { files: Number.NaN } },
    ]) {
      let outcome: ReturnType<typeof acceptEvaluatorOutput> | undefined;
      expect(() => {
        outcome = acceptEvaluatorOutput(catalog, compiler, { kind: 'completed', byteLength: 10, output });
      }).not.toThrow();
      expect(outcome!.result).toBe('error');
      expect(JSON.stringify(outcome)).not.toContain('trap');
    }
    const builtin = resolution.obligations.find((o) => o.evaluator.builtin)!;
    expect(() => acceptEvaluatorOutput(catalog, builtin, { kind: 'timeout' })).toThrow(TypeError);
    expect(
      adaptBuiltinVerdict(builtin, verdict({ check: 'COMP-CHECK', scope: 'x', outcome: 'pass', findings: [] }, 'rev'))
        .result,
    ).toBe('passed');
    expect(
      adaptBuiltinVerdict(
        builtin,
        verdict(
          {
            check: 'COMP-CHECK',
            scope: 'x',
            outcome: 'fail',
            findings: [
              { code: 'IA-COMP-CHECK-UNKNOWN', severity: 'error', path: 'a.ia', line: 1, message: 'a.ia:1: unknown' },
            ],
          },
          'rev',
        ),
      ),
    ).toMatchObject({ result: 'failed', diagnostics: ['a.ia:1: unknown'] });
    expect(
      adaptBuiltinVerdict(
        builtin,
        verdict({ check: 'COMP-CHECK', scope: 'x', outcome: 'not-evaluated', findings: [] }, 'rev'),
      ).result,
    ).toBe('not-evaluated');
    expect(adaptBuiltinVerdict(builtin, undefined).result).toBe('not-evaluated');
    expect(() =>
      adaptBuiltinVerdict(builtin, verdict({ check: 'COMP-SCHEMA', scope: 'x', outcome: 'pass', findings: [] }, 'rev')),
    ).toThrow(TypeError);
    expect(() => adaptBuiltinVerdict(compiler, undefined)).toThrow(TypeError);
  });
  it('predicates see a frozen clone of facts; inputs pass the input codec and normalise the digest', () => {
    const facts = { language: 'typescript', packages: ['core'] };
    let seen: unknown;
    const input = {
      ...baseInput(),
      facts,
      predicates: new Map([
        [
          'typescript-source@1',
          (f: Record<string, unknown>) => {
            seen = f;
            (f['packages'] as string[]).push('evil');
            return { status: 'applicable' as const };
          },
        ],
      ]),
    } as unknown as ObligationInput;
    const result = resolveObligations(input);
    expect(seen).not.toBe(facts);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(facts.packages).toEqual(['core']);
    expect(result.obligations.find((o) => o.requirement === 'compiler-run')!.applicability.status).toBe('undetermined');
    const normalizing = createEvaluatorCatalog(
      { format: EVALUATOR_CATALOG_FORMAT, entries: [typing] },
      {
        codecs: [
          {
            id: 'acme-typing-input@1',
            validate: (v) =>
              typeof v === 'object' && v !== null && typeof (v as { project?: unknown }).project === 'string',
            normalize: (v) => ({ project: (v as { project: string }).project.toLowerCase() }),
          },
          codecs[1]!,
        ],
      },
    );
    if (!normalizing.ok) throw new Error('catalog');
    const one = (value: unknown) =>
      resolveObligations({
        ...baseInput(),
        catalog: normalizing.catalog,
        catalogDigest: normalizing.catalog.digest,
        adoptions: [baseInput().adoptions[0]!],
        occurrences: [{ ...baseInput().occurrences[0]!, input: value }],
      });
    expect(one({ project: 'TSCONFIG.json' }).obligations[0]!.inputDigest).toBe(
      one({ project: 'tsconfig.json' }).obligations[0]!.inputDigest,
    );
    expect(codesOf(one({ path: 1 }))).toContain('IA-COMP-OBLIGATION-UNRESOLVED');
    expect(codesOf(one({ project: 'x', when: new Date(0) }))).toContain('IA-COMP-OBLIGATION-UNRESOLVED');
  });
  it('receipts: real calendar instants, sanitized ids, optional-failed, and an environment key of {id, toolchain} only', () => {
    const compiler = resolution.obligations.find((o) => o.requirement === 'compiler-run')!,
      expectation = { ...context, obligation: compiler };
    expect(
      validateReceipt(receipt(compiler, { observedAt: '2026-02-30T00:00:00Z' }), expectation, now).findings.map(
        (f) => f.code,
      ),
    ).toEqual(['IA-COMP-RECEIPT-INVALID']);
    expect(() => validateReceipt(receipt(compiler), expectation, '2026-13-01T00:00:00Z')).toThrow(TypeError);
    expect(
      validateReceipt(receipt(compiler, { receiptId: 'r\n1' }), expectation, now).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-INVALID']);
    expect(
      validateReceipt(receipt(compiler, { issuer: 'token=abc' }), expectation, now).findings.map((f) => f.code),
    ).toEqual(['IA-COMP-RECEIPT-INVALID']);
    expect(
      evidenceKey(compiler, {
        ...context,
        environment: { ...context.environment, extra: 'ignored' } as ReceiptContext['environment'],
      }),
    ).toBe(evidenceKey(compiler, context));
    const lintOptional = resolveObligations({
      ...baseInput(),
      catalog: catalogOf([typing, coverage, { ...lint, availability: { status: 'supported' } }]),
      catalogDigest: catalogOf([typing, coverage, { ...lint, availability: { status: 'supported' } }]).digest,
    });
    const supportedCatalog = catalogOf([typing, coverage, { ...lint, availability: { status: 'supported' } }]);
    const lintObligation = lintOptional.obligations.find((o) => o.runs === 'acme-lint')!;
    const decision = admitTransition(
      lintOptional,
      [
        ...passing(lintOptional)
          .filter((r) => r.obligationId !== lintObligation.obligationId)
          .map((r) => ({ ...r, catalogDigest: supportedCatalog.digest })),
        receipt(lintObligation, { result: 'failed', catalogDigest: supportedCatalog.digest }),
      ],
      { ...context, catalog: supportedCatalog },
      now,
    );
    expect(decision.admitted).toBe(true);
    expect(decision.decisions.find((d) => d.obligationId === lintObligation.obligationId)).toMatchObject({
      status: 'optional-failed',
      result: 'failed',
      trust: 'local-unsigned',
    });
  });
});
