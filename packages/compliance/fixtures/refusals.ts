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
import {
  renderHostArtifacts,
  validateAdoption,
  validateCheck,
  validateCoverage,
  validateFragments,
  validateParse,
  validateSchema,
  validateSelectors,
  validateSystems,
  validateVariants,
  runLanguageFixture,
} from '../src/index.js';
import type { AdoptionEvaluators, Finding, FixtureResult, SystemFolder } from '../src/index.js';
import { assess } from '../src/types.js';

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
    check = records.find((r) => r.discriminator === 'check')!;
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
  const examples: readonly [Finding['code'], () => readonly Finding[]][] = [
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
    ['IA-COMP-PROJECTION-INVALID', () => renderHostArtifacts(records, '').assessment.findings],
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
    examples.map(([code, run]): FixtureResult => {
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
        assessment: assess('COMP-FIXTURES', `boundary/${code}`, findings),
        observedCodes: Object.freeze([...new Set(observed.map((d) => d.code))].sort()),
      });
    }),
  );
}
