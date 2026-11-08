/** Executable boundary fixtures over the actual native corpus. These mutate
 * typed products to exercise refusal APIs; they are not substitute providers. */
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '@inventarch/language';
import type { CompiledRecord, FrozenRegistry, SchemaField } from '@inventarch/language';
import {
  GraphUsageError,
  canonicalRoot,
  load,
  resolve,
  traverse,
  validateCoordinate,
  variants,
} from '@inventarch/graph';
import type { Graph, Node, RevisionSource } from '@inventarch/graph';
import { canonAssessment, canonAssessments } from '../canon/rules.js';
import { validateAdoption } from '../adoption.js';
import type { AdoptionEvaluators } from '../adoption.js';
import { runLanguageFixture } from '../fixtures.js';
import type { FixtureResult } from '../fixtures.js';
import {
  validateCheck,
  validateCoverage,
  validateFragments,
  validateParse,
  validateSelectors,
} from '../graph-checks.js';
import { validateSchema } from '../schema.js';
import { validateSystems } from '../systems.js';
import type { SystemFolder } from '../systems.js';
import { assess } from '../types.js';
import type { Finding } from '../types.js';
import { validateVariants } from '../variants.js';

export function runRefusalFixtures(
  graph: Graph,
  inputs: readonly RevisionSource[],
  folders: readonly SystemFolder[],
): readonly FixtureResult[] {
  const records = [...graph.nodes.values()],
    registry = graph.registry;
  const agent = records.find((r) => r.discriminator === 'agent')!,
    method = records.find((r) => r.name === 'sample-procedure')!;
  const law = records.find((r) => r.discriminator === 'law')!,
    contract = records.find((r) => r.name === 'foundation-authoring-contract')!,
    check = records.find((r) => r.discriminator === 'check')!,
    mandate = records.find((r) => r.discriminator === 'mandate' && r.name === 'sample-mandate')!;
  /** A blocking `@law` enforced by a `@check` that runs `checkId`, so the canon rule is active; returns its findings over `offenders`. */
  const canonFixture = (checkId: string, offenders: readonly Node[], find?: () => readonly Finding[]) => {
    const canonCheck: Node = {
      ...check,
      identity: `fixture/check/${checkId.toLowerCase()}`,
      name: checkId.toLowerCase(),
      sections: check.sections.map((s) =>
        s.name !== 'check'
          ? s
          : {
              ...s,
              fields: s.fields.map((f) =>
                'key' in f && f.key === 'runs' ? { ...f, value: { kind: 'scalar' as const, text: checkId } } : f,
              ),
            },
      ),
    };
    const canonLaw: Node = {
      ...law,
      identity: `fixture/law/${checkId.toLowerCase()}`,
      name: checkId.toLowerCase(),
      edges: law.edges.map((e) =>
        e.predicate === 'enforce' ? { ...e, direction: 'in' as const, target: canonCheck.identity } : e,
      ),
    };
    const nodes = [canonLaw, canonCheck, ...offenders];
    // A file-based rule reads the checkout, which these record fixtures do not have: its db test reads real files, and
    // this fixture observes only that the enforcing law activates it and sets the severity of what it finds.
    return find === undefined
      ? canonAssessments(nodes, undefined).flatMap((a) => a.findings)
      : (canonAssessment(nodes, checkId, find)?.findings ?? []);
  };
  const kitRecords: readonly Node[] = [
    {
      ...method,
      discriminator: 'distribution',
      identity: 'fixture/distribution/kit-a-distribution',
      name: 'kit-a-distribution',
      source: { ...method.source, path: '.ia/src/systems/kit-a/records/distribution.ia' },
      sections: [
        {
          name: 'distribution',
          span: { line: 1, endLine: 1 },
          fields: [
            {
              key: 'records',
              value: {
                kind: 'list' as const,
                items: [{ kind: 'ref' as const, discriminator: 'system', name: 'kit-a' }],
              },
              span: { line: 1, endLine: 1 },
            },
          ],
        },
      ],
    },
  ];
  const ambiguous: Node = {
    ...law,
    variants: [
      {
        key: 'requires',
        value: { kind: 'string', text: 'one' },
        condition: [{ axis: 'phase', value: 'act' }],
        span: { line: 10, endLine: 10 },
      },
      {
        key: 'requires',
        value: { kind: 'string', text: 'two' },
        condition: [{ axis: 'primitive', value: 'Memory' }],
        span: { line: 11, endLine: 11 },
      },
    ],
  };
  const rebuild = (changed: readonly CompiledRecord[] = records, vocabulary: FrozenRegistry = registry) =>
    load(changed, vocabulary, {
      sources: inputs,
      languageVersion: LANGUAGE_VERSION,
      kernelDigest: KERNEL_DIGEST,
      location: '',
    });
  const schemaFindings = (changed: CompiledRecord = agent, vocabulary = registry) =>
    validateSchema(changed, vocabulary, records).findings;
  const systemFindings = (changed = folders, vocabulary = registry, pool: readonly CompiledRecord[] = records) =>
    validateSystems(changed, vocabulary, pool).flatMap((a) => a.findings);
  const rule = {
    predicate: 'cite' as const,
    direction: 'out' as const,
    spelling: 'cite',
    target: 'playbook',
    must: true,
    cardinality: 'one' as const,
    span: { line: 1, endLine: 1 },
  };
  const schemas = new Map(registry.schemas);
  schemas.set('agent', { ...schemas.get('agent')!, edges: [rule] });
  // W0 narrowing rows: the agent's `meaning.says` value re-typed, and its schema re-declared to narrow that one field.
  const saying = (value: CompiledRecord['head'][number]['value']): CompiledRecord => ({
    ...agent,
    sections: agent.sections.map((s) =>
      s.name !== 'meaning'
        ? s
        : { ...s, fields: s.fields.map((f) => ('key' in f && f.key === 'says' ? { ...f, value } : f)) },
    ),
  });
  const narrowed = (field: Partial<SchemaField>): FrozenRegistry => {
    const declared = new Map(registry.schemas),
      original = declared.get('agent')!;
    declared.set('agent', {
      ...original,
      fields: [{ section: 'meaning', key: 'says', type: 'text', must: true, span: original.span, ...field }],
    });
    return { ...registry, schemas: declared };
  };
  const edge = {
    predicate: 'cite' as const,
    direction: 'out' as const,
    spelling: 'cite',
    reference: { kind: 'ref' as const, discriminator: 'playbook', name: 'missing' },
    target: null,
    span: agent.source,
  };
  /** The sample mandate with its stated move list emptied, which admission refuses (compliance C05). */
  const unmoved: CompiledRecord = {
    ...mandate,
    sections: mandate.sections.map((s) =>
      s.name !== 'authority'
        ? s
        : {
            ...s,
            fields: s.fields.map((f) =>
              'key' in f && f.key === 'moves' ? { ...f, value: { kind: 'list' as const, items: [] } } : f,
            ),
          },
    ),
  };
  /** One boundary per code, and a labelled second one where a code has a second refusal to show. */
  const examples: readonly (readonly [Finding['code'], () => readonly Finding[], string?])[] = [
    [
      'IA-GRAPH-IDENTITY-TIE',
      () => rebuild([...records, { ...method, source: { ...method.source, line: 1000 } }]).diagnostics,
    ],
    ['IA-GRAPH-TARGET-MISSING', () => rebuild(records.filter((r) => r.identity !== contract.identity)).diagnostics],
    [
      'IA-GRAPH-TARGET-AMBIGUOUS',
      () => {
        const result = resolve(
          { kind: 'ref', discriminator: method.discriminator, name: method.name },
          [method, { ...method, source: { ...method.source, line: 1000 } }],
          registry,
        );
        return result.ok
          ? []
          : [
              {
                code: result.code,
                path: method.source.path,
                line: 1,
                severity: 'error',
                message: 'Ambiguous boundary reference',
              },
            ];
      },
    ],
    ['IA-GRAPH-EDGE-UNCONSENTED', () => rebuild(records, { ...registry, consent: new Map() }).diagnostics],
    [
      'IA-GRAPH-DIMENSION-UNKNOWN',
      () =>
        rebuild(
          records.map((r) =>
            r !== method
              ? r
              : { ...r, head: [{ key: 'artifact-set', value: { kind: 'scalar', text: 'unknown' }, span: r.source }] },
          ),
        ).diagnostics,
    ],
    [
      'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
      () => {
        validateCoordinate({ phase: 'unknown' });
        return [];
      },
    ],
    [
      'IA-GRAPH-VERB-UNKNOWN',
      () => {
        traverse(graph, { start: [], follow: ['imagines'] });
        return [];
      },
    ],
    [
      'IA-GRAPH-TRAVERSAL-INVALID',
      () => {
        traverse(graph, { start: [], depth: 9 });
        return [];
      },
    ],
    ['IA-GRAPH-VARIANT-AMBIGUOUS', () => variants(ambiguous, { phase: 'act', primitive: 'Memory' }).diagnostics],
    [
      'IA-GRAPH-SCOPE-INVALID',
      () => {
        canonicalRoot('../escape');
        return [];
      },
    ],
    ['IA-COMP-SCHEMA-MISSING', () => schemaFindings(agent, { ...registry, schemas: new Map() })],
    ['IA-COMP-SCHEMA-KIND-MISMATCH', () => schemaFindings({ ...agent, kind: 'definition' })],
    [
      'IA-COMP-SECTION-MISSING',
      () => schemaFindings({ ...agent, sections: agent.sections.filter((s) => s.name !== 'meaning') }),
    ],
    [
      'IA-COMP-SECTION-UNKNOWN',
      () =>
        schemaFindings({
          ...agent,
          sections: [...agent.sections, { name: 'unknown', span: agent.source, fields: [] }],
        }),
    ],
    [
      'IA-COMP-FIELD-MISSING',
      () =>
        schemaFindings({
          ...agent,
          sections: agent.sections.map((s) => (s.name !== 'meaning' ? s : { ...s, fields: [] })),
        }),
    ],
    [
      'IA-COMP-FIELD-DUPLICATE',
      () =>
        schemaFindings({
          ...agent,
          sections: agent.sections.map((s) =>
            s.name !== 'meaning'
              ? s
              : { ...s, fields: [...s.fields, ...s.fields.filter((f) => 'key' in f && f.key === 'says')] },
          ),
        }),
    ],
    [
      'IA-COMP-FIELD-UNKNOWN',
      () =>
        schemaFindings({
          ...agent,
          sections: agent.sections.map((s) =>
            s.name !== 'meaning'
              ? s
              : {
                  ...s,
                  fields: [...s.fields, { key: 'ready', value: { kind: 'scalar', text: 'true' }, span: agent.source }],
                },
          ),
        }),
    ],
    [
      'IA-COMP-FIELD-TYPE',
      () =>
        schemaFindings({
          ...agent,
          sections: agent.sections.map((s) =>
            s.name !== 'meaning'
              ? s
              : {
                  ...s,
                  fields: s.fields.map((f) =>
                    'key' in f && f.key === 'says' ? { ...f, value: { kind: 'list', items: [] } } : f,
                  ),
                },
          ),
        }),
    ],
    [
      'IA-COMP-FIELD-VALUE',
      () => schemaFindings(saying({ kind: 'scalar', text: 'nope' }), narrowed({ type: 'id', values: ['yes'] })),
    ],
    [
      'IA-COMP-FIELD-REF-TARGET',
      () =>
        schemaFindings(
          saying({ kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' }),
          narrowed({ type: 'ref', target: 'agent' }),
        ),
    ],
    [
      'IA-COMP-FIELD-REF-MISSING',
      () =>
        schemaFindings(
          saying({ kind: 'ref', discriminator: 'playbook', name: 'missing' }),
          narrowed({ type: 'ref', target: 'playbook' }),
        ),
    ],
    ['IA-COMP-FIELD-VALUE', () => schemaFindings(unmoved), 'mandate-moves-empty'],
    ['IA-COMP-FIELD-FORM', () => schemaFindings(agent, narrowed({ type: 'text', form: 'iso-date' }))],
    ['IA-COMP-EDGE-CARDINALITY', () => schemaFindings(agent, { ...registry, schemas })],
    ['IA-COMP-EDGE-UNRESOLVED', () => schemaFindings({ ...agent, edges: [edge] }, { ...registry, schemas })],
    ['IA-COMP-SYSTEM-MALFORMED', () => systemFindings([{ name: 'empty', path: 'empty', sources: [], records: [] }])],
    [
      'IA-COMP-DISCRIMINATOR-FOREIGN',
      () =>
        systemFindings(folders.map((f) => (f.name !== 'agent-system' ? f : { ...f, records: [...f.records, method] }))),
    ],
    ['IA-COMP-BOOTSTRAP-ORDER', () => systemFindings(folders, { ...registry, order: [...registry.order].reverse() })],
    [
      'IA-COMP-STEWARD-MISSING',
      () =>
        systemFindings(
          folders,
          registry,
          records.filter((r) => r.discriminator !== 'agent'),
        ),
    ],
    [
      'IA-COMP-CONSENT-EMPTY',
      () =>
        systemFindings(folders, {
          ...registry,
          systems: new Map([...registry.systems].map(([key, value]) => [key, { ...value, consent: [] }])),
        }),
    ],
    [
      'IA-COMP-SCHEMA-UNREFERENCED',
      () =>
        systemFindings(folders, {
          ...registry,
          registrations: new Map([...registry.registrations].filter(([key]) => key !== 'agent')),
        }),
    ],
    [
      'IA-COMP-SCHEMA-MULTIPLE',
      () =>
        systemFindings(folders, {
          ...registry,
          registrations: new Map([
            ...registry.registrations,
            ['duplicate', { ...registry.registrations.get('agent')!, keyword: 'duplicate' }],
          ]),
        }),
    ],
    [
      'IA-COMP-FRAGMENT-MISSING',
      () =>
        validateFragments(
          rebuild(
            records.map((r) =>
              r.discriminator !== 'case'
                ? r
                : {
                    ...r,
                    edges: r.edges.map((e) => ({
                      ...e,
                      fragment: 'REQ-MISSING',
                      reference: { ...e.reference, fragment: 'REQ-MISSING' },
                    })),
                  },
            ),
          ),
        ).findings,
    ],
    [
      'IA-COMP-COVERAGE-MISSING',
      () => {
        const g = rebuild(records.filter((r) => r.name !== 'valid-native-record'));
        return validateCoverage(g.nodes.get(contract.identity)!, g).findings;
      },
    ],
    [
      'IA-COMP-COVERAGE-KIND',
      () => {
        const g = rebuild(
          records.map((r) =>
            r.discriminator !== 'case'
              ? r
              : {
                  ...r,
                  sections: r.sections.map((s) =>
                    s.name !== 'scenario'
                      ? s
                      : {
                          ...s,
                          fields: s.fields.map((f) =>
                            'key' in f && f.key === 'kind' ? { ...f, value: { kind: 'scalar', text: 'success' } } : f,
                          ),
                        },
                  ),
                },
          ),
        );
        return validateCoverage(g.nodes.get(contract.identity)!, g).findings;
      },
    ],
    [
      'IA-COMP-SELECTOR-INVALID',
      () => validateSelectors({ ...method, selectors: [[{ axis: 'phase', value: 'unknown' }]] }).findings,
    ],
    ['IA-COMP-CHECK-UNKNOWN', () => validateCheck({ ...check, sections: [] }).findings],
    [
      'IA-COMP-CHECK-CONFLICT',
      () =>
        validateCheck({
          ...check,
          sections: check.sections.map((s) =>
            s.name !== 'check'
              ? s
              : {
                  ...s,
                  fields: [
                    ...s.fields,
                    { key: 'implementation', value: { kind: 'string', text: 'fixture-other-evaluator' }, span: s.span },
                  ],
                },
          ),
        }).findings,
    ],
    ['IA-COMP-VARIANT-AMBIGUOUS', () => validateVariants(ambiguous).findings],
    [
      'IA-COMP-ADOPTION-FAILED',
      () => {
        const evaluators: AdoptionEvaluators = new Map([
          [
            contract.identity,
            new Map(
              contract.requirements.map((r) => [
                r.id,
                () => ({ outcome: 'fail' as const, message: 'Fixture rejects the structural claim' }),
              ]),
            ),
          ],
        ]);
        return validateAdoption(graph, evaluators).flatMap((a) => a.findings);
      },
    ],
    ['IA-COMP-NOT-EVALUATED', () => validateParse(undefined).findings],
    [
      'IA-COMP-CANON-WORK-PLACEMENT',
      () =>
        canonFixture('CANON-WORK-PLACEMENT', [
          {
            ...method,
            discriminator: 'spec',
            identity: 'fixture/spec/offending-spec',
            name: 'offending-spec',
            source: { ...method.source, path: '.ia/src/systems/work-system/records/offending-spec.ia' },
          },
        ]),
    ],
    [
      'IA-COMP-CANON-KIT-WORDS',
      () =>
        canonFixture('CANON-KIT-WORDS', [
          ...kitRecords,
          {
            ...law,
            identity: 'fixture/law/kit-method',
            name: 'kit-method',
            source: { ...law.source, path: '.ia/src/systems/kit-a/records/method.ia' },
          },
          {
            ...method,
            discriminator: 'system',
            identity: 'fixture/system/kit-a',
            name: 'kit-a',
            source: { ...method.source, path: '.ia/src/systems/kit-a/system.ia' },
            sections: [
              {
                name: 'discriminators',
                span: { line: 1, endLine: 1 },
                fields: [
                  {
                    key: 'widget',
                    value: { kind: 'scalar' as const, text: 'lowers to definition' },
                    span: { line: 1, endLine: 1 },
                  },
                ],
              },
            ],
          },
        ]),
    ],
    [
      'IA-COMP-CANON-KIT-WORKSPACE',
      () =>
        canonFixture('CANON-KIT-WORKSPACE', [
          ...kitRecords,
          {
            ...method,
            discriminator: 'workspace',
            identity: 'fixture/workspace/kit-workspace',
            name: 'kit-workspace',
            source: { ...method.source, path: '.ia/src/workspace.ia' },
            sections: [
              {
                name: 'composition',
                span: { line: 1, endLine: 1 },
                fields: [
                  {
                    key: 'sources',
                    value: { kind: 'string' as const, text: '.ia/src @authored' },
                    span: { line: 1, endLine: 1 },
                  },
                ],
              },
            ],
          },
        ]),
    ],
    [
      'IA-COMP-CANON-TEACHING-LINKS',
      () =>
        canonFixture('CANON-TEACHING-LINKS', [], () => [
          {
            code: 'IA-COMP-CANON-TEACHING-LINKS',
            path: '.ia/src/doc.md',
            line: 1,
            severity: 'warning',
            message: '.ia/src/doc.md: target outside installed teaching closure: ../../README.md',
          },
        ]),
    ],
    [
      'IA-COMP-CANON-SOURCE-ROOTS',
      () =>
        canonFixture('CANON-SOURCE-ROOTS', [], () => [
          {
            code: 'IA-COMP-CANON-SOURCE-ROOTS',
            path: 'nested/.ia/src',
            line: 1,
            severity: 'warning',
            message: 'nested/.ia/src: A kit authors one .ia/src; this nested root is neither released nor adopted.',
          },
        ]),
    ],
    [
      'IA-COMP-CANON-KIT-SCRIPTS',
      () =>
        canonFixture('CANON-KIT-SCRIPTS', [], () => [
          {
            code: 'IA-COMP-CANON-KIT-SCRIPTS',
            path: 'tools/run.mjs',
            line: 1,
            severity: 'warning',
            message: 'tools/run.mjs: A kit holds no scripts; move this file into an executing system or remove it.',
          },
        ]),
    ],
    [
      'IA-COMP-FIXTURE-MISMATCH',
      () =>
        runLanguageFixture({
          path: 'fixture.ia',
          clause: 'parser',
          mode: 'fail',
          source: '#! ia 1.0\n',
          diagnostics: [],
        }).assessment.findings,
    ],
  ];
  return Object.freeze(
    examples.map(([code, run, label]): FixtureResult => {
      let observed: readonly Finding[];
      let unexpected = false;
      try {
        observed = run();
      } catch (error) {
        if (error instanceof GraphUsageError)
          observed = [{ code: error.code, path: '', line: 1, severity: 'error', message: error.message }];
        else {
          unexpected = true;
          observed = [
            {
              code: 'IA-COMP-FIXTURE-MISMATCH',
              path: '',
              line: 1,
              severity: 'error',
              message: `Boundary fixture threw: ${error instanceof Error ? error.message : String(error)}`,
            },
          ];
        }
      }
      const findings: Finding[] =
        !unexpected && observed.some((d) => d.code === code)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                path: '',
                line: 1,
                severity: 'error',
                message: `${code} boundary fixture produced ${observed.map((d) => `${d.code}: ${d.message}`).join(', ')}`,
              },
            ];
      return Object.freeze({
        assessment: assess('COMP-FIXTURES', `boundary/${code}${label === undefined ? '' : `/${label}`}`, findings),
        observedCodes: Object.freeze([...new Set(observed.map((d) => d.code))].sort()),
      });
    }),
  );
}
