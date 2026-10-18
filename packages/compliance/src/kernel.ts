import { createHash } from 'node:crypto';
import { buildRegistry, compile, parse } from '@inventarch/language';
import type { CompiledField, CompiledRecord, Location } from '@inventarch/language';
import { validateSchema } from './schema.js';

/** One floor source: a canonical `.ia/src/floor/` path and its text. */
export interface KernelSource {
  readonly path: string;
  readonly text: string;
}
export interface GeneratedKernel {
  /** The kernel module text, as `packages/language/src/kernel.generated.ts` holds it. */
  readonly text: string;
  readonly digest: string;
  readonly records: number;
  /** Every exported constant of that module by name, `KERNEL_DIGEST` and `KERNEL_SOURCES` included. */
  readonly constants: Readonly<Record<string, unknown>>;
  readonly sources: readonly KernelSource[];
}
/** The closed contract: the kernel memberships the language's code relies on, which the floor must reproduce. */
const CLOSED_CONTRACT = {
  KINDS: ['governance', 'contract', 'definition', 'template', 'check', 'policy', 'binding'],
  CATEGORIES: [
    'thing',
    'kind',
    'property',
    'state',
    'event',
    'relation',
    'rule',
    'capability',
    'intent',
    'decision',
    'evidence',
    'representation',
    'process',
    'measure',
    'boundary',
  ],
  PREDICATE_PAIRS: [
    ['govern', 'governed-by'],
    ['enforce', 'enforced-by'],
    ['ground', 'grounded-by'],
    ['constrain', 'constrained-by'],
    ['implement', 'implemented-by'],
    ['produce', 'produced-by'],
    ['consume', 'consumed-by'],
    ['record-lineage-from', 'lineage-recorded-by'],
    ['grant-access-to', 'access-granted-by'],
    ['run-before', 'run-after'],
    ['trigger', 'triggered-by'],
    ['cite', 'cited-by'],
    ['supersede', 'superseded-by'],
    ['require', 'required-by'],
    ['use', 'used-by'],
    ['forbid', 'forbidden-by'],
    ['route', 'routed-by'],
    ['land', 'landed-by'],
  ],
  PHASES: ['orient', 'plan', 'act', 'learn'],
  PRIMITIVES: ['Memory', 'Attention', 'Inference', 'Decision', 'Escalation', 'Learning'],
  MOVES: ['Observation', 'Execution', 'Delegation', 'Synthesis', 'Verification'],
  AXES: ['shape', 'category', 'phase', 'primitive', 'move', 'kind', 'lane', 'predicate', 'artifact-set'],
  LANES: ['authority', 'contracts', 'definitions', 'templates', 'enforcement', 'bindings'],
  SHAPES: ['context', 'governance', 'execution', 'sequence', 'learning'],
  ARTIFACT_SETS: [
    'inquiry',
    'decision',
    'contract',
    'product-definition',
    'execution',
    'operational',
    'evidence',
    'projection',
    'principle',
  ],
  SEVERITIES: ['blocking', 'advisory', 'informational'],
  PROVENANCES: ['workspace', 'methodology', 'bootstrap', 'runtime'],
  BANDS: [100, 90, 50, 10, 0],
  PLACEMENT_KINDS: ['authored', 'adopted', 'open', 'floor', 'runtime'],
  BAND_OF: {
    authored: 100,
    adopted: 90,
    open: 50,
    floor: 10,
    runtime: 0,
  },
  VALUE_TYPES: ['text', 'id', 'qname', 'number', 'ref', 'flag'],
  CARDINALITIES: ['one', 'one-or-more', 'optional'],
  PRESENT_PHRASES: [
    'governs',
    'enforces',
    'grounds',
    'constrains',
    'implements',
    'produces',
    'consumes',
    'records lineage from',
    'grants access to',
    'runs before',
    'triggers',
    'cites',
    'supersedes',
    'requires',
    'uses',
    'forbids',
    'routes to',
    'lands at',
  ],
} as const;
const location: Location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const equal = (a: unknown, b: unknown, label: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${label}: expected ${JSON.stringify(b)}, found ${JSON.stringify(a)}`);
};
/**
 * The `KERNEL_DIGEST` of a floor: sha256 over its `[path, text]` pairs sorted by path, CRLF read as LF. A floor is
 * identified by this digest whether or not it regenerates.
 */
export function kernelDigest(input: readonly KernelSource[]): string {
  const sources = input
    .map((source) => [source.path, source.text.replaceAll('\r\n', '\n')] as const)
    .sort((a, b) => compare(a[0], b[0]));
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex');
}

function field(record: CompiledRecord, section: string, key: string): CompiledField | undefined {
  const fields = record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.key === key);
  if (fields.length > 1) throw new Error(`${record.identity}: duplicate ${section}.${key}`);
  return fields[0];
}
function scalar(record: CompiledRecord, section: string, key: string): string {
  const value = field(record, section, key)?.value;
  if (value === undefined || !('text' in value))
    throw new Error(`${record.identity}: missing scalar ${section}.${key}`);
  return value.text;
}
function values(record: CompiledRecord, section: string, key: string): string[] {
  const value = field(record, section, key)?.value;
  if (value?.kind !== 'list') throw new Error(`${record.identity}: missing list ${section}.${key}`);
  return value.items.map((v) => {
    if (!('text' in v)) throw new Error(`${record.identity}: nontext list item`);
    return v.text;
  });
}
function belongs(values: readonly string[], domain: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value) => !domain.includes(value)))
    throw new Error(`${label}: expected unique members of ${domain.join(', ')}`);
}

/**
 * Validates the floor against the closed contract and emits the language's kernel module. Pure: it reads no files.
 * Throws, before any output, on a floor that does not compile, validate or match the closed contract.
 */
export function generateKernel(input: readonly KernelSource[]): GeneratedKernel {
  const sources = [...input]
    .map((source) => ({ ...source, text: source.text.replaceAll('\r\n', '\n') }))
    .sort((a, b) => compare(a.path, b.path));
  if (new Set(sources.map((s) => s.path)).size !== sources.length) throw new Error('Duplicate kernel source path');
  if (sources.some((s) => !s.path.startsWith('.ia/src/floor/') || s.path.includes('..') || s.path.includes('\\')))
    throw new Error('Kernel sources require canonical relative floor paths');
  const parsed = sources.map((source) => ({ ...parse(source.text, source.path), location }));
  const registered = buildRegistry(parsed);
  if (registered.diagnostics.length > 0) throw new Error(JSON.stringify(registered.diagnostics));
  const registry = registered.registry;
  equal([...registry.systems.keys()], ['taxonomy'], 'kernel systems');
  const first = parsed.flatMap((source) => compile(source.ast, registry, location, []).records);
  const results = parsed.map((source) =>
    compile(
      source.ast,
      registry,
      location,
      first.filter((record) => record.source.path !== source.ast.path),
    ),
  );
  const diagnostics = results.flatMap((r) => r.diagnostics);
  if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics));
  const records = results.flatMap((r) => r.records);
  const identityCounts = new Set(records.map((r) => r.identity));
  if (identityCounts.size !== records.length) throw new Error('Duplicate kernel identity across files');
  for (const record of records) {
    const assessment = validateSchema(record, registry, records);
    if (assessment.outcome !== 'pass') throw new Error(JSON.stringify(assessment));
    if (record.discriminator !== 'system' && record.discriminator !== 'schema')
      for (const key of ['says', 'answers'])
        if (scalar(record, 'meaning', key).trim() === '')
          throw new Error(`${record.identity}: meaning.${key} must not be blank`);
  }
  const emitted: Record<string, unknown> = {};
  const families: readonly [string, string][] = [
    ['kind', 'KINDS'],
    ['category', 'CATEGORIES'],
    ['lane', 'LANES'],
    ['phase', 'PHASES'],
    ['primitive', 'PRIMITIVES'],
    ['move', 'MOVES'],
    ['axis', 'AXES'],
    ['intent-shape', 'SHAPES'],
    ['artifact-set', 'ARTIFACT_SETS'],
    ['placement', 'PLACEMENT_KINDS'],
    ['value-type', 'VALUE_TYPES'],
    ['cardinality', 'CARDINALITIES'],
  ];
  const admitted = new Set(['system', 'schema', 'predicate', 'dimension', ...families.map((p) => p[0])]);
  equal([...registry.registrations.keys()].sort(compare), [...admitted].sort(compare), 'kernel registrations');
  for (const schema of registry.schemas.values()) {
    const enrollment = [...registry.registrations.values()].filter((r) => r.schema === schema.name);
    if (enrollment.length !== 1)
      throw new Error(`@schema ${schema.name}: expected exactly one enrollment, found ${enrollment.length}`);
  }
  for (const record of records)
    if (!admitted.has(record.discriminator)) throw new Error(`Unexpected kernel family ${record.discriminator}`);
  const family = (word: string): CompiledRecord[] => {
    const selected = records
      .filter((r) => r.discriminator === word)
      .sort((a, b) => Number(scalar(a, 'data', 'order')) - Number(scalar(b, 'data', 'order')));
    selected.forEach((record, i) => equal(Number(scalar(record, 'data', 'order')), i, `${word} order`));
    return selected;
  };
  for (const [word, key] of families) {
    const names = family(word).map((r) => r.displayName);
    equal(names, CLOSED_CONTRACT[key as keyof typeof CLOSED_CONTRACT], key);
    emitted[key] = names;
  }
  const predicates = family('predicate');
  const pairs = predicates.map((r) => [r.displayName, scalar(r, 'data', 'inverse')]);
  equal(pairs, CLOSED_CONTRACT.PREDICATE_PAIRS, 'PREDICATE_PAIRS');
  emitted['PREDICATE_PAIRS'] = pairs;
  emitted['PRESENT_PHRASES'] = predicates.map((r) => scalar(r, 'data', 'phrase'));
  equal(emitted['PRESENT_PHRASES'], CLOSED_CONTRACT.PRESENT_PHRASES, 'PRESENT_PHRASES');
  const dimensionRecords = family('dimension');
  equal(
    dimensionRecords.map((r) => r.name),
    ['severity', 'provenance', 'artifact-set'],
    'dimensions',
  );
  emitted['DIMENSION_PATHS'] = Object.fromEntries(dimensionRecords.map((r) => [r.name, scalar(r, 'data', 'path')]));
  equal(
    emitted['DIMENSION_PATHS'],
    { severity: 'governance.severity', provenance: 'provenance', 'artifact-set': 'classification' },
    'dimension paths',
  );
  for (const [i, key] of ['SEVERITIES', 'PROVENANCES', 'ARTIFACT_SETS'].entries()) {
    const items = values(dimensionRecords[i]!, 'data', 'values');
    equal(items, CLOSED_CONTRACT[key as keyof typeof CLOSED_CONTRACT], key!);
    emitted[key!] = items;
  }
  const axisDomains: Record<string, unknown> = {
    shape: emitted['SHAPES'],
    category: emitted['CATEGORIES'],
    phase: emitted['PHASES'],
    primitive: emitted['PRIMITIVES'],
    move: emitted['MOVES'],
    kind: emitted['KINDS'],
    lane: emitted['LANES'],
    predicate: pairs.map((p) => p[0]),
    'artifact-set': emitted['ARTIFACT_SETS'],
  };
  for (const axis of family('axis'))
    equal(values(axis, 'data', 'values'), axisDomains[axis.name], `${axis.name} values`);
  const placements = family('placement');
  emitted['BANDS'] = placements.map((r) => Number(scalar(r, 'data', 'band')));
  emitted['BAND_OF'] = Object.fromEntries(placements.map((r) => [r.name, Number(scalar(r, 'data', 'band'))]));
  equal(emitted['BANDS'], CLOSED_CONTRACT.BANDS, 'BANDS');
  equal(emitted['BAND_OF'], CLOSED_CONTRACT.BAND_OF, 'BAND_OF');
  emitted['KIND_LANES'] = Object.fromEntries(
    family('kind').map((r) => {
      if (r.name !== 'contract' && field(r, 'data', 'authority-lane') !== undefined)
        throw new Error(`${r.identity}: authority-lane is only defined for contract`);
      const lane = scalar(r, 'data', 'lane');
      belongs([lane], CLOSED_CONTRACT.LANES, 'kind lane');
      return [r.name, lane];
    }),
  );
  equal(
    scalar(family('kind').find((r) => r.name === 'contract')!, 'data', 'authority-lane'),
    'authority',
    'contract authority facet lane',
  );
  emitted['PRIMITIVE_ANCHORS'] = Object.fromEntries(
    family('primitive').map((r) => {
      const phase = scalar(r, 'data', 'anchor');
      belongs([phase], CLOSED_CONTRACT.PHASES, 'primitive anchor');
      return [r.displayName, phase];
    }),
  );
  const rows = family('intent-shape').map((r) => {
    const category = scalar(r, 'routing', 'category');
    belongs([category], CLOSED_CONTRACT.CATEGORIES, 'shape category');
    const primitive = scalar(r, 'routing', 'primitive');
    belongs([primitive], CLOSED_CONTRACT.PRIMITIVES, 'shape primitive');
    const kinds = values(r, 'routing', 'kind-focus');
    if (kinds.length === 0) throw new Error(`${r.identity}: shape kind-focus must not be empty`);
    belongs(kinds, CLOSED_CONTRACT.KINDS, 'shape kind-focus');
    const lanes = values(r, 'routing', 'lane-focus');
    if (lanes.length === 0) throw new Error(`${r.identity}: shape lane-focus must not be empty`);
    belongs(lanes, CLOSED_CONTRACT.LANES, 'shape lane-focus');
    const focus = values(r, 'routing', 'predicate-focus');
    if (focus.length === 0) throw new Error(`${r.identity}: shape predicate-focus must not be empty`);
    belongs(
      focus,
      pairs.map((p) => p[0]!),
      'shape predicate-focus',
    );
    const priming = field(r, 'routing', 'priming-order') === undefined ? [] : values(r, 'routing', 'priming-order');
    belongs(
      priming,
      pairs.map((p) => p[0]!),
      'shape priming-order',
    );
    return [
      r.name,
      {
        category,
        primitive,
        tiePrecedence: Number(scalar(r, 'routing', 'tie-precedence')),
        kinds,
        lanes,
        predicates: focus,
        priming,
      },
    ] as const;
  });
  equal(rows.map((r) => r[1].tiePrecedence).sort(), [0, 1, 2, 3, 4], 'shape tie precedence');
  emitted['SHAPE_ROWS'] = Object.fromEntries(rows);
  const digest = kernelDigest(sources);
  emitted['KERNEL_DIGEST'] = digest;
  const text =
    '// Generated by tools/kernel/generate.ts from validated .ia/src/floor; do not edit.\n\n' +
    Object.entries(emitted)
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)} as const;\n`)
      .join('\n') +
    `\nexport const KERNEL_SOURCES: readonly Readonly<{ path: string; text: string }>[] = Object.freeze(${JSON.stringify(sources, null, 2)}.map((source) => Object.freeze(source)));\n`;
  return { text, digest, records: records.length, constants: { ...emitted, KERNEL_SOURCES: sources }, sources };
}
