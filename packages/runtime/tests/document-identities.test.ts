import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names are written exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import {
  assemblePacket,
  expandReleases,
  kitBindings,
  kitChecks,
  kitDelivery,
  packetDigest,
  readBindings,
  readPacketIdentity,
  readReleases,
  releaseRecords,
} from '../src/method/index.js';

// Decision dec-008. The bindings sidecar, the kit sidecars and releases files and the method packet are read
// by programs released separately (the plugin, the door, kits), so this release reads the plain `format` name with
// `formatVersion` beside the released shapes and keeps writing the released packet shape until the switch flips.
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ia-document-identities-')));
});
afterEach(() => {
  flip.plain = false;
  rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
};
const wrong = (name: string, versions: readonly number[] = [1]): Record<string, unknown>[] => [
  { format: name },
  { format: name, formatVersion: Math.max(...versions) + 1 },
  { format: name, formatVersion: '1' },
  { format: `${name}-1`, formatVersion: 1 },
  { format: `ia.${name}.v1`, formatVersion: 1 },
  { format: 'other-document', formatVersion: 1 },
  { format: '1' },
  { format: 1, formatVersion: 1 },
  { formatVersion: 1 },
];

it('bindings: reads the released integer format and the plain shape, and refuses any other', () => {
  const body = { bindings: { 'work.plan': { kit: 'k', capability: 'c' } } };
  for (const identity of [{ format: 1 }, { format: 'bindings', formatVersion: 1 }]) {
    put(join(dir, '.ia', 'bindings.json'), { ...identity, ...body });
    expect(readBindings(dir)?.bindings['work.plan']).toEqual([{ kit: 'k', capability: 'c' }]);
  }
  for (const identity of [{ format: 2 }, ...wrong('bindings')]) {
    put(join(dir, '.ia', 'bindings.json'), { ...identity, ...body });
    expect(() => readBindings(dir), JSON.stringify(identity)).toThrow(/bindings/);
  }
});

const kitOf = (name: string, file: string, value: unknown) => {
  const kit = join(dir, name);
  put(join(kit, file), value);
  return { dir: kit, id: 'test/kit' };
};
it('kit-checks: reads the released integer format and the plain shape, and refuses any other', () => {
  for (const identity of [{ format: 1 }, { format: 'kit-checks', formatVersion: 1 }])
    expect(kitChecks(kitOf('a', 'checks.json', { ...identity, checks: {} }))).toEqual({ checks: {}, undeclared: [] });
  for (const identity of [{ format: 2 }, ...wrong('kit-checks')])
    expect(() => kitChecks(kitOf('b', 'checks.json', { ...identity, checks: {} })), JSON.stringify(identity)).toThrow(
      /malformed/,
    );
});
it('kit-delivery: reads the released integer format and the plain shape, and refuses any other', () => {
  for (const identity of [{ format: 1 }, { format: 'kit-delivery', formatVersion: 1 }])
    expect(kitDelivery(kitOf('a', 'delivery.json', { ...identity, whole: [] }))).toEqual({ whole: [], undeclared: [] });
  for (const identity of [{ format: 2 }, ...wrong('kit-delivery')])
    expect(
      () => kitDelivery(kitOf('b', 'delivery.json', { ...identity, whole: [] })),
      JSON.stringify(identity),
    ).toThrow(/malformed/);
});
it('kit-bindings: reads the released integer format and the plain shape, and refuses any other', () => {
  for (const identity of [{ format: 1 }, { format: 'kit-bindings', formatVersion: 1 }])
    expect(kitBindings(kitOf('a', 'bindings.json', { ...identity, recommend: {} }))).toEqual({
      recommend: {},
      unbound: null,
      undeclared: [],
    });
  for (const identity of [{ format: 2 }, ...wrong('kit-bindings')])
    expect(
      () => kitBindings(kitOf('b', 'bindings.json', { ...identity, recommend: {} })),
      JSON.stringify(identity),
    ).toThrow(/malformed/);
});

const row = { version: '1.0.0', archive: 'a'.repeat(64) };
const releaseFolder = (name: string, index: Record<string, unknown>, file: Record<string, unknown>) => {
  const kit = join(dir, name);
  put(join(kit, 'releases.json'), {
    ...index,
    kit: 'test/kit',
    latest: '1.0.0',
    releases: [{ ...row, file: 'releases/1.0.0.json' }],
  });
  put(join(kit, 'releases', '1.0.0.json'), { ...file, kit: 'test/kit', ...row, records: ['r/one'] });
  return kit;
};
it('kit-releases and kit-release: read the released shapes and the plain shapes, and refuse any other', () => {
  const shapes: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ format: 2 }, { format: 2 }],
    [
      { format: 'kit-releases', formatVersion: 2 },
      { format: 'kit-release', formatVersion: 2 },
    ],
    [{ format: 'kit-releases', formatVersion: 2 }, { format: 2 }],
  ];
  shapes.forEach(([index, file], at) => {
    const kit = releaseFolder(`two-${at}`, index, file);
    expect(readReleases(kit).releases).toHaveLength(1);
    expect(releaseRecords(kit, { ...row, version: '1.0.0' })).toEqual(['r/one']);
    expect(expandReleases(kit).releases[0]?.records).toEqual(['r/one']);
  });
  // Format 1 is the document with no identity at all; its plain name carries formatVersion 1.
  for (const identity of [{}, { format: 'kit-releases', formatVersion: 1 }]) {
    const kit = join(dir, `one-${Object.keys(identity).length}`);
    put(join(kit, 'releases.json'), { ...identity, kit: 'test/kit', releases: [{ ...row, records: ['r/one'] }] });
    expect(readReleases(kit).releases).toHaveLength(1);
    expect(expandReleases(kit).releases[0]?.records).toEqual(['r/one']);
  }
  for (const identity of [{ format: 3 }, { format: 1 }, ...wrong('kit-releases', [1, 2])]) {
    const kit = join(dir, 'bad-index');
    put(join(kit, 'releases.json'), { ...identity, kit: 'test/kit', releases: [{ ...row, records: [] }] });
    expect(() => readReleases(kit), JSON.stringify(identity)).toThrow();
  }
  for (const identity of [{ format: 1 }, { format: 3 }, ...wrong('kit-release', [2])]) {
    const kit = releaseFolder('bad-file', { format: 2 }, identity);
    expect(() => releaseRecords(kit, { ...row, version: '1.0.0' }), JSON.stringify(identity)).toThrow();
  }
});

const parts = () => ({
  resolver: 'test',
  binding: null,
  closure: [],
  scope: null,
  instructions: [],
  references: [],
  role: null,
  requestedOperations: [],
  runner: [],
  missing: [],
  envelope: {},
});
it('packet: reads the released contract and the plain shape, and refuses any other', () => {
  expect(readPacketIdentity({ contract: 1 })).toEqual({ version: 1, plain: false, keys: ['contract'] });
  expect(readPacketIdentity({ format: 'packet', formatVersion: 1 })).toMatchObject({ version: 1, plain: true });
  for (const identity of [
    { contract: 2 },
    { contract: '1' },
    { contract: 1, format: 'packet', formatVersion: 1 },
    ...wrong('packet').filter((shape) => shape['formatVersion'] !== 1 || shape['format'] !== 'packet'),
  ])
    expect(readPacketIdentity(identity), JSON.stringify(identity)).toBeUndefined();
});
// Forward compatibility: a released door and plugin read `contract`, so by default it is what is written.
it('packet: writes the released contract by default, and the plain shape once the switch flips; the digest never moves', () => {
  const released = assemblePacket(parts()) as unknown as Record<string, unknown>;
  expect(released['contract']).toBe(1);
  expect(Object.keys(released)[0]).toBe('contract');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  flip.plain = true;
  const plain = assemblePacket(parts()) as unknown as Record<string, unknown>;
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain).toMatchObject({ format: 'packet', formatVersion: 1 });
  expect(Object.hasOwn(plain, 'contract')).toBe(false);
  expect(plain['digest']).toBe(released['digest']);
  expect(packetDigest(plain)).toBe(packetDigest(released));
});
