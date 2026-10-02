import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '@ia/language';
import { canonicalRoot, dimensionsOf, reaches, revisionOf, stableSerialize, validateCoordinate } from '../src/index.js';
import { snapshot } from '../src/immutable.js';
import { inputs, instance, records, registry } from './native.js';

describe('roots and reach', () => {
  it.each([
    ['', ''],
    ['.', ''],
    ['./team/', 'team'],
    ['a/../team', 'team'],
    ['team\\child', 'team/child'],
  ])('canonicalizes %s', (input, expected) => expect(canonicalRoot(input!)).toBe(expected));
  it.each(['../outside', 'a/../../outside', '/absolute', 'Z:/root', './Z:/root', 'a/../Z:relative', '\\server\share'])(
    'refuses invalid root %s',
    (root) => expect(() => canonicalRoot(root)).toThrow(expect.objectContaining({ code: 'IA-GRAPH-SCOPE-INVALID' })),
  );
  it('uses segment boundaries, not string prefixes', () => {
    expect(reaches('', 'any/path')).toBe(true);
    expect(reaches('team', 'team')).toBe(true);
    expect(reaches('team', 'team/child')).toBe(true);
    expect(reaches('team', 'teammate')).toBe(false);
    expect(reaches('team', '')).toBe(false);
  });
});
describe('immutable structured snapshots', () => {
  it('breaks input aliases through nested records, maps and sets', () => {
    const source = { map: new Map([['x', { values: ['original'] }]]), set: new Set(['original']) };
    const copy = snapshot(source);
    source.map.get('x')!.values.push('changed');
    source.map.set('other', { values: [] });
    source.set.add('changed');
    expect([...copy.map.keys()]).toEqual(['x']);
    expect(copy.map.get('x')!.values).toEqual(['original']);
    expect([...copy.set]).toEqual(['original']);
    expect(() => copy.map.set('bad', { values: [] })).toThrow();
    expect(() => Map.prototype.set.call(copy.map, 'bad', {})).toThrow();
    expect(() => copy.set.add('bad')).toThrow();
    expect(() => copy.map.get('x')!.values.push('bad')).toThrow();
    let mapSeen: unknown;
    copy.map.forEach((_v, _k, map) => {
      mapSeen = map;
    });
    expect(mapSeen).toBe(copy.map);
    let setSeen: unknown;
    copy.set.forEach((_v, _k, set) => {
      setSeen = set;
    });
    expect(setSeen).toBe(copy.set);
  });
  it('keeps a frozen native registry serializable without mutable map slots', () => {
    const copy = snapshot(registry);
    expect(stableSerialize(copy)).toBe(stableSerialize(registry));
    expect(() => (copy.schemas as Map<string, unknown>).clear()).toThrow();
  });
  it('serializes objects/collections deterministically without tag collisions', () => {
    expect(
      stableSerialize({
        b: new Set(['z', 'a']),
        a: new Map([
          ['z', 1],
          ['a', 2],
        ]),
      }),
    ).toBe(
      stableSerialize({
        a: new Map([
          ['a', 2],
          ['z', 1],
        ]),
        b: new Set(['a', 'z']),
      }),
    );
    expect(stableSerialize(new Map())).not.toBe(stableSerialize({ $map: [] }));
    expect(stableSerialize(new Set())).not.toBe(stableSerialize([]));
    expect(() => stableSerialize(Infinity)).toThrow();
    expect(() => stableSerialize(undefined)).toThrow();
  });
});
describe('corpus revision', () => {
  const metadata = { languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST };
  const baseline = revisionOf(registry, { ...metadata, sources: inputs });
  it('uses all native source inputs independent of their order or map insertion order', () => {
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    const reordered = {
      ...registry,
      systems: new Map([...registry.systems].reverse()),
      schemas: new Map([...registry.schemas].reverse()),
    };
    expect(revisionOf(reordered, { ...metadata, sources: [...inputs].reverse() })).toBe(baseline);
  });
  it.each(['bytes', 'path', 'placement', 'provenance', 'kernel', 'version', 'registry'])('changes for %s', (change) => {
    const source = inputs[0]!;
    const replaced = {
      ...source,
      ...(change === 'bytes' ? { text: source.text + '\n' } : {}),
      ...(change === 'path' ? { path: 'new-path.ia' } : {}),
      ...(change === 'placement'
        ? { location: { ...source.location, placement: { kind: 'open' as const, band: 50 as const, reach: '' } } }
        : {}),
      ...(change === 'provenance' ? { location: { ...source.location, provenance: 'runtime' as const } } : {}),
    };
    const result = revisionOf(change === 'registry' ? { ...registry, blocked: new Set(['new']) } : registry, {
      sources: [replaced, ...inputs.slice(1)],
      languageVersion: change === 'version' ? 'different' : LANGUAGE_VERSION,
      kernelDigest: change === 'kernel' ? 'different' : KERNEL_DIGEST,
    });
    expect(result).not.toBe(baseline);
  });
  it('refuses duplicate canonical paths and inconsistent placement bands', () => {
    expect(() =>
      revisionOf(registry, { ...metadata, sources: [inputs[0]!, { ...inputs[0]!, path: `./${inputs[0]!.path}` }] }),
    ).toThrow('duplicate canonical paths');
    const source = {
      ...inputs[0]!,
      location: { ...inputs[0]!.location, placement: { kind: 'floor' as const, band: 100 as const, reach: '' } },
    };
    expect(() => revisionOf(registry, { ...metadata, sources: [source] })).toThrow('placement');
  });
});
describe('coordinate and authored dimensions', () => {
  it('canonicalizes known values and keeps omitted axes absent', () => {
    expect(validateCoordinate({ primitive: 'memory', phase: 'ACT', severity: 'BLOCKING', move: undefined })).toEqual({
      primitive: 'Memory',
      phase: 'act',
      severity: 'blocking',
    });
    expect(validateCoordinate({})).toEqual({});
  });
  it.each<Readonly<Record<string, unknown>>>([
    { phase: 'bad' },
    { missing: 'act' },
    { Phase: 'act' },
    { phase: 1 },
    { phase: null },
    { constructor: 'toString' },
  ])('refuses invalid coordinate %j with admitted values', (coordinate) => {
    expect(() => validateCoordinate(coordinate)).toThrow(
      expect.objectContaining({
        code: 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
        message: expect.stringContaining('admitted:'),
      }),
    );
  });
  it('reads actual severity and explicit classification without interpreting glosses', () => {
    const law = records.find((r) => r.name === 'sample-rule')!;
    expect(dimensionsOf(law)).toEqual({
      dimensions: { provenance: 'workspace', severity: 'blocking' },
      diagnostics: [],
    });
    const record = instance(
      '@law x\n  artifact-set evidence\n  meaning\n    category "decision"\n  governance\n    severity ADVISORY',
    );
    expect(dimensionsOf(record)).toEqual({
      dimensions: { provenance: 'workspace', severity: 'advisory', artifactSet: 'evidence' },
      diagnostics: [],
    });
  });
  it.each([
    '  artifact-set invalid',
    '  artifact-set [evidence]',
    '  artifact-set evidence\n  artifact-set inquiry',
    '  governance\n    severity enormous',
    '  governance\n    severity blocking\n    severity advisory',
  ])('refuses malformed dimension %s', (body) => {
    expect(dimensionsOf(instance(`@law x\n${body}`)).diagnostics.map((d) => d.code)).toEqual([
      'IA-GRAPH-DIMENSION-UNKNOWN',
    ]);
  });
  it('does not invent absent dimensions or derive authority from provenance', () => {
    const record = instance('@law x\n  meaning\n    says "blocking evidence"');
    expect(dimensionsOf({ ...record, provenance: 'bootstrap' }).dimensions).toEqual({ provenance: 'bootstrap' });
  });
});
