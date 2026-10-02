import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, compile, parse } from '../../packages/language/src/index.js';
import type { CompiledField, CompiledRecord, Location } from '../../packages/language/src/index.js';
import { validateSchema } from '../../packages/compliance/src/index.js';
import contract from './closed-contract.json' with { type: 'json' };
import { isEntry } from '../entry/is-entry.mjs';

export interface KernelSource {
  readonly path: string;
  readonly text: string;
}
const location: Location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const equal = (a: unknown, b: unknown, label: string): void => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${label}: expected ${JSON.stringify(b)}, found ${JSON.stringify(a)}`);
};

export function readKernel(root: string): readonly KernelSource[] {
  return readdirSync(resolve(root, '.ia/src/floor'))
    .filter((p) => p.endsWith('.ia'))
    .sort(compare)
    .map((name) => ({
      path: `.ia/src/floor/${name}`,
      text: readFileSync(resolve(root, '.ia/src/floor', name), 'utf8').replaceAll('\r\n', '\n'),
    }));
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

export function generateKernel(input: readonly KernelSource[]): { text: string; digest: string; records: number } {
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
    equal(names, contract[key as keyof typeof contract], key);
    emitted[key] = names;
  }
  const predicates = family('predicate');
  const pairs = predicates.map((r) => [r.displayName, scalar(r, 'data', 'inverse')]);
  equal(pairs, contract.PREDICATE_PAIRS, 'PREDICATE_PAIRS');
  emitted['PREDICATE_PAIRS'] = pairs;
  emitted['PRESENT_PHRASES'] = predicates.map((r) => scalar(r, 'data', 'phrase'));
  equal(emitted['PRESENT_PHRASES'], contract.PRESENT_PHRASES, 'PRESENT_PHRASES');
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
    equal(items, contract[key as keyof typeof contract], key!);
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
  equal(emitted['BANDS'], contract.BANDS, 'BANDS');
  equal(emitted['BAND_OF'], contract.BAND_OF, 'BAND_OF');
  emitted['KIND_LANES'] = Object.fromEntries(
    family('kind').map((r) => {
      const lane = scalar(r, 'data', 'lane');
      belongs([lane], contract.LANES, 'kind lane');
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
      belongs([phase], contract.PHASES, 'primitive anchor');
      return [r.displayName, phase];
    }),
  );
  const rows = family('intent-shape').map((r) => {
    const category = scalar(r, 'routing', 'category');
    belongs([category], contract.CATEGORIES, 'shape category');
    const primitive = scalar(r, 'routing', 'primitive');
    belongs([primitive], contract.PRIMITIVES, 'shape primitive');
    const kinds = values(r, 'routing', 'kind-focus');
    belongs(kinds, contract.KINDS, 'shape kind-focus');
    const lanes = values(r, 'routing', 'lane-focus');
    belongs(lanes, contract.LANES, 'shape lane-focus');
    const focus = values(r, 'routing', 'predicate-focus');
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
  const digest = createHash('sha256')
    .update(JSON.stringify(sources.map((s) => [s.path, s.text])))
    .digest('hex');
  emitted['KERNEL_DIGEST'] = digest;
  const text =
    '// Generated by tools/kernel/generate.ts from validated .ia/src/floor; do not edit.\n\n' +
    Object.entries(emitted)
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)} as const;\n`)
      .join('\n') +
    `\nexport const KERNEL_SOURCES: readonly Readonly<{ path: string; text: string }>[] = Object.freeze(${JSON.stringify(sources, null, 2)}.map((source) => Object.freeze(source)));\n`;
  return { text, digest, records: records.length };
}

export function checkKernel(root: string, write = false): { digest: string; records: number } {
  const result = generateKernel(readKernel(root));
  const path = resolve(root, 'packages/language/src/kernel.generated.ts');
  if (write) writeFileSync(path, result.text);
  else if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== result.text)
    throw new Error('Kernel output drift: run pnpm kernel:generate and review the result');
  return result;
}
if (isEntry(process.argv[1], import.meta.url)) {
  const flag = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(flag)) throw new Error('Usage: generate.ts [--check|--write]');
  const result = checkKernel(fileURLToPath(new URL('../../', import.meta.url)), flag === '--write');
  process.stdout.write(`Validated ${result.records} kernel records; digest ${result.digest}.\n`);
}
