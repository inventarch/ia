import { afterAll, beforeAll, expect, it } from 'vitest';
import { readInputs } from '@inventarch/db';
import { distributionSnapshot, packSnapshot } from '../src/snapshot.js';
import { packDistribution } from '../src/pack.js';
import { descriptor, snapshotFixture, sourceInput } from './snapshot-fixture.js';

let fixture: ReturnType<typeof snapshotFixture>;
beforeAll(() => {
  fixture = snapshotFixture();
});
afterAll(() => {
  fixture?.close();
});

it('packs identical archive bytes and native closure from immutable and physical input', () => {
  const snapshot = distributionSnapshot(sourceInput(fixture.input));
  const packed = packSnapshot(snapshot, descriptor, new Map([['LICENSE', fixture.license]]));
  expect(packed.sourceFingerprint).toBe(fixture.input.fingerprint);
  expect(packed.manifest).toEqual(fixture.packed.manifest);
  expect(packed.bytes).toEqual(fixture.packed.bytes);
  expect(packed.archiveDigest).toBe(fixture.packed.archiveDigest);
  expect(packed.manifest.files.some((file) => file.path.endsWith('/repository-distribution.ia'))).toBe(true);
  expect(packed.manifest.files.some((file) => file.path.includes('/floor/'))).toBe(false);
});

it('retains captured bytes after filesystem changes without reading a caller-selected root', () => {
  const original = distributionSnapshot(sourceInput(fixture.input));
  const isolated = fixture.target();
  fixture.put(isolated, '.ia/src/unrelated.ia', '#! ia 1.0\n# Changed outside the immutable input.\n');
  expect(packSnapshot(original, descriptor, new Map([['LICENSE', fixture.license]])).bytes).toEqual(
    fixture.packed.bytes,
  );
  expect(() => distributionSnapshot({ ...sourceInput(fixture.input), root: isolated })).toThrow();
  expect(() =>
    packSnapshot({ ...original, fingerprint: 'f'.repeat(64) }, descriptor, new Map([['LICENSE', fixture.license]])),
  ).toThrow();
});

it('refuses to pack a release descriptor that names no distribution', () => {
  // db decodes such a descriptor (position-packet plan amendment B7); it releases nothing, so the packer refuses it.
  const snapshot = distributionSnapshot(sourceInput(fixture.input)),
    { distribution: _distribution, ...unnamed } = descriptor;
  expect(() => packSnapshot(snapshot, unnamed, new Map([['LICENSE', fixture.license]]))).toThrow(
    expect.objectContaining({
      code: 'IA-DIST-CLOSURE-INVALID',
      message: 'Release descriptor names no distribution; there is nothing to pack',
    }),
  );
});

it('snapshots caller metadata and requires the exact explicit asset inventory', () => {
  const input = structuredClone(sourceInput(fixture.input)),
    snapshot = distributionSnapshot(input);
  Object.assign(input.sources[0]!, { text: '#! ia 1.0\n# caller mutation\n' });
  expect(packSnapshot(snapshot, descriptor, new Map([['LICENSE', fixture.license]])).bytes).toEqual(
    fixture.packed.bytes,
  );
  expect(() => packSnapshot(snapshot, descriptor, new Map())).toThrow();
  expect(() =>
    packSnapshot(
      snapshot,
      descriptor,
      new Map([
        ['LICENSE', fixture.license],
        ['private.txt', Buffer.from('private')],
      ]),
    ),
  ).toThrow();
});

it('refuses aliased paths, malformed provenance and unadmitted native definitions', () => {
  const input = sourceInput(fixture.input),
    source = input.sources[0]!;
  expect(() =>
    distributionSnapshot({ ...input, sources: [...input.sources, { ...source, path: source.path.toUpperCase() }] }),
  ).toThrow();
  expect(() =>
    distributionSnapshot({
      ...input,
      sources: [
        { ...source, location: { ...source.location, provenance: 'invented-authority' } },
        ...input.sources.slice(1),
      ],
    }),
  ).toThrow();
  const malformed = distributionSnapshot({
    ...input,
    sources: [
      ...input.sources,
      {
        path: '.ia/src/invalid.ia',
        text: '#! ia 1.0\n@missing-word wrong\n',
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      },
    ],
  });
  expect(() => packSnapshot(malformed, descriptor, new Map([['LICENSE', fixture.license]]))).toThrow(
    /DISCRIMINATOR-UNREGISTERED/,
  );
});

it('does not reinterpret adopted source paths as authored publication inputs', () => {
  const target = fixture.target(),
    base = readInputs(target),
    mounted = fixture.input.sources.filter((source) => !source.path.startsWith('.ia/src/floor/'));
  const snapshot = distributionSnapshot({
    ...sourceInput(base),
    folders: fixture.input.folders,
    sources: [
      ...base.sources,
      ...mounted.map((source) => ({
        ...source,
        path: `.ia/adopted/foundation/${'a'.repeat(64)}/${source.path}`,
        location: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
      })),
    ],
  });
  expect(() => packSnapshot(snapshot, descriptor, new Map([['LICENSE', fixture.license]]))).toThrow(
    /authored|adopted|closure/i,
  );
});

const custom = [
  {
    path: '.ia/src/systems/custom-system/system.ia',
    text: '#! ia 1.0\n\n@system custom-system\n  provider "fixture.custom"\n  version "1.0.0"\n  describes "Requires-only distribution closure"\n  steward @agent custom-steward\n  requires\n    - governance-system\n    - agent-system\n    - workspace-system\n',
  },
  {
    path: '.ia/src/systems/custom-system/steward.ia',
    text: '#! ia 1.0\n\n@agent custom-steward\n  meaning\n    says "Own the custom distribution."\n    answers "Who owns these records?"\n  governance\n    applies [principle, distribution]\n    requires "Preserve declared native requirements."\n',
  },
  {
    path: '.ia/src/systems/custom-system/records/rule.ia',
    text: '#! ia 1.0\n\n@principle custom-rule\n  meaning\n    says "Retain required systems in the distribution closure."\n    answers "Which dependencies must the release retain?"\n  governance\n    severity advisory\n    requires "Traverse the native requires section."\n',
  },
  {
    path: '.ia/src/systems/custom-system/records/distribution.ia',
    text: '#! ia 1.0\n\n@distribution custom-distribution\n  meaning\n    says "The complete custom distribution."\n    answers "What is published?"\n  distribution\n    records [@principle custom-rule]\n',
  },
];
const customDescriptor = {
  ...descriptor,
  id: 'fixture/custom',
  distribution: 'workspace-system/definition/distribution/custom-distribution',
};
it('retains an adopted external foundation referenced only by native system requires', () => {
  const dependency = {
    id: descriptor.id,
    range: '^0.1.0',
    systems: fixture.packed.manifest.systems.map((system) => system.name),
  };
  const input = distributionSnapshot({
    floorOrigin: fixture.input.floorOrigin,
    folders: [...fixture.input.folders, 'custom-system'],
    sources: [
      ...fixture.input.sources.map((source) =>
        source.location.placement.kind === 'floor'
          ? source
          : {
              ...source,
              path: `.ia/adopted/foundation/${fixture.packed.sourceFingerprint}/${source.path}`,
              location: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
            },
      ),
      ...custom.map((source) => ({
        ...source,
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      })),
    ],
  });
  const packed = packSnapshot(
    input,
    { ...customDescriptor, dependencies: [dependency] },
    new Map([['LICENSE', fixture.license]]),
  );
  expect(packed.manifest.dependencies).toEqual([{ id: descriptor.id, range: '^0.1.0' }]);
  expect(packed.manifest.systems.map((system) => system.name)).toEqual(['custom-system']);
  expect(
    packed.manifest.files
      .filter((file) => file.role === 'source')
      .map((file) => file.path)
      .sort(),
  ).toEqual(custom.map((source) => source.path).sort());
});
it('includes authored required systems in full without external assignments in both packing adapters', () => {
  const root = fixture.target();
  for (const source of [...fixture.input.sources, ...custom]) fixture.put(root, source.path, source.text);
  fixture.put(root, 'LICENSE', fixture.license);
  const input = distributionSnapshot(sourceInput(readInputs(root))),
    packed = packSnapshot(input, customDescriptor, new Map([['LICENSE', fixture.license]]));
  expect(packed.manifest.systems.map((system) => system.name)).toEqual(
    expect.arrayContaining(['custom-system', 'governance-system', 'agent-system', 'workspace-system']),
  );
  for (const name of ['governance-system', 'agent-system', 'workspace-system']) {
    const required = fixture.input.sources
      .filter((source) => source.path.startsWith(`.ia/src/systems/${name}/`))
      .map((source) => source.path);
    expect(packed.manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining(required));
  }
  expect(packDistribution(root, customDescriptor).bytes).toEqual(packed.bytes);
});
