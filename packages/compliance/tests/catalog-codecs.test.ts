import { afterEach, describe, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names come back exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
afterEach(() => {
  flip.plain = false;
});
import {
  EVALUATOR_CATALOG_FORMAT,
  EVALUATOR_CATALOG_FORMAT_VERSION,
  LEGACY_EVALUATOR_CATALOG_FORMAT,
  createEvaluatorCatalog,
  isCodecRef,
  legacyCodecRef,
} from '../src/index.js';
import type { CatalogInput, EvaluatorCodec } from '../src/index.js';
import { codecOf } from '../src/catalog.js';

const hex = (c: string) => `sha256:${c.repeat(64)}`;
const base = {
  id: 'acme-strict-typing',
  contractVersion: '1.0.0',
  implementationVersion: '2.1.0',
  implementationDigest: hex('a'),
  supportedScopes: ['package'],
  effects: ['read', 'process'],
  environmentProfile: { id: 'node-22-offline', credentials: 'none' },
  limits: { timeoutMs: 60000, memoryBytes: 536870912, outputBytes: 4096, concurrency: 2 },
  evidencePolicy: { kind: 'reusable', maxAgeMs: 3600000, environmentSensitive: true },
  availability: { status: 'supported' },
};
const current = {
  ...base,
  inputCodec: { id: 'acme-typing-input', version: 1 },
  outputCodec: { id: 'acme-typing-result', version: 1 },
};
const legacy = { ...base, inputSchemaId: 'acme-typing-input@1', outputSchemaId: 'acme-typing-result@1' };
const accepts =
  (marker: string): EvaluatorCodec['validate'] =>
  (v) =>
    typeof v === 'object' && v !== null && marker in v;
const codecs: readonly EvaluatorCodec[] = [
  { id: 'acme-typing-input', version: 1, validate: accepts('v1') },
  { id: 'acme-typing-input', version: 2, validate: accepts('v2') },
  { id: 'acme-typing-result', version: 1, validate: () => true },
];
const make = (input: CatalogInput, list: readonly EvaluatorCodec[] = codecs) =>
  createEvaluatorCatalog(input, { codecs: list });
const now = (entries: readonly unknown[]) =>
  make({ format: EVALUATOR_CATALOG_FORMAT, formatVersion: EVALUATOR_CATALOG_FORMAT_VERSION, entries });
const old = (entries: readonly unknown[], format: string = LEGACY_EVALUATOR_CATALOG_FORMAT) =>
  make({ format, entries });
const codes = (r: { assessment: { findings: readonly { code: string }[] } }) =>
  r.assessment.findings.map((f) => f.code);

describe('versioned codecs (T1.6)', () => {
  it('registers codecs as {id, version} and references them by the pair', () => {
    const r = now([current]);
    if (!r.ok) throw new Error(JSON.stringify(r.assessment.findings));
    expect(r.catalog.format).toBe('evaluator-catalog');
    expect(r.catalog.formatVersion).toBe(2);
    expect(r.catalog.entries[0]!.inputCodec).toEqual({ id: 'acme-typing-input', version: 1 });
    expect(r.catalog.entries[0]).not.toHaveProperty('inputSchemaId');
    expect(codecOf(r.catalog, r.catalog.entries[0]!.outputCodec)?.id).toBe('acme-typing-result');
    expect(codecOf(r.catalog, { id: 'acme-typing-result', version: 9 })).toBeUndefined();
  });

  it('lets two versions of one codec id coexist and selects each correctly', () => {
    const r = now([
      current,
      {
        ...current,
        id: 'acme-other-typing',
        implementationDigest: hex('b'),
        inputCodec: { id: 'acme-typing-input', version: 2 },
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.assessment.findings));
    const byId = (id: string) => r.catalog.entries.find((e) => e.id === id)!;
    const v1 = codecOf(r.catalog, byId('acme-strict-typing').inputCodec)!;
    const v2 = codecOf(r.catalog, byId('acme-other-typing').inputCodec)!;
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v1.validate({ v1: 1 })).toBe(true);
    expect(v1.validate({ v2: 1 })).toBe(false);
    expect(v2.validate({ v2: 1 })).toBe(true);
    expect(codes(now([{ ...current, inputCodec: { id: 'acme-typing-input', version: 3 } }]))).toEqual([
      'IA-COMP-CATALOG-CODEC-UNKNOWN',
    ]);
  });

  it('still reads the legacy name@N catalog and resolves it to the same codecs', () => {
    const r = old([legacy]);
    if (!r.ok) throw new Error(JSON.stringify(r.assessment.findings));
    expect(r.catalog.formatVersion).toBe(1);
    expect(r.catalog.format).toBe(LEGACY_EVALUATOR_CATALOG_FORMAT);
    expect(r.catalog.entries[0]!.inputCodec).toEqual({ id: 'acme-typing-input', version: 1 });
    const fresh = now([current]);
    if (!fresh.ok) throw new Error('current');
    expect(codecOf(r.catalog, r.catalog.entries[0]!.inputCodec)?.validate).toBe(
      codecOf(fresh.catalog, fresh.catalog.entries[0]!.inputCodec)?.validate,
    );
    // Any 1.x minor is still read; the digest of a legacy catalog is the one main's build computes without this change.
    expect(old([legacy], 'ia-evaluator-catalog/1.3').ok).toBe(true);
    expect(r.catalog.digest).toBe('sha256:c211233d54a0409932518c058e591a960ee21b09d2911824fc358650bfb2d73e');
    expect(legacyCodecRef('acme-typing-input@2')).toEqual({ id: 'acme-typing-input', version: 2 });
    // Each shape is exact: the legacy fields are not read in the current shape, nor the reverse.
    expect(codes(now([legacy]))).toEqual(['IA-COMP-CATALOG-ENTRY-INVALID']);
    expect(codes(old([current]))).toEqual(['IA-COMP-CATALOG-ENTRY-INVALID']);
  });

  it('refuses malformed ids, versions, formats and registrations', () => {
    const bad: unknown[] = [
      { id: 'acme-typing-input@1', version: 1 },
      { id: 'Acme', version: 1 },
      { id: 'acme-typing-input', version: 0 },
      { id: 'acme-typing-input', version: 1.5 },
      { id: 'acme-typing-input', version: '1' },
      { id: 'acme-typing-input' },
      { id: 'acme-typing-input', version: 1, extra: true },
      'acme-typing-input@1',
    ];
    for (const ref of bad) {
      expect(isCodecRef(ref)).toBe(false);
      expect(codes(now([{ ...current, inputCodec: ref }]))).toEqual(['IA-COMP-CATALOG-ENTRY-INVALID']);
    }
    for (const id of ['acme-typing-input@0', 'acme-typing-input@01', 'acme-typing-input@', '@1', 'x@1@2', 'acme'])
      expect(legacyCodecRef(id)).toBeUndefined();
    expect(codes(old([{ ...legacy, inputSchemaId: 'acme-typing-input@0' }]))).toEqual([
      'IA-COMP-CATALOG-ENTRY-INVALID',
    ]);
    const version = (formatVersion: unknown) =>
      codes(make({ format: EVALUATOR_CATALOG_FORMAT, formatVersion, entries: [] } as never));
    expect(version(3)).toEqual(['IA-COMP-CATALOG-VERSION']);
    expect(version(2.5)).toEqual(['IA-COMP-CATALOG-VERSION']);
    expect(codes(make({ format: EVALUATOR_CATALOG_FORMAT, entries: [] }))).toEqual(['IA-COMP-CATALOG-VERSION']);
    expect(codes(old([], 'ia-evaluator-catalog/2.0'))).toEqual(['IA-COMP-CATALOG-VERSION']);
    for (const list of [
      [{ id: 'a@1', version: 1, validate: () => true }],
      [{ id: 'acme', version: 0, validate: () => true }],
      [{ id: 'acme', validate: () => true }],
      [codecs[0]!, codecs[0]!],
    ])
      expect(() => make({ format: 'x', entries: [] }, list as never)).toThrow(TypeError);
  });
});

describe('released catalog digest (dec-008, A15)', () => {
  /** The digest origin/main computes for `legacy`: the entries as declared, `name@major` codec ids, format 1.0. */
  const RELEASED = 'sha256:c211233d54a0409932518c058e591a960ee21b09d2911824fc358650bfb2d73e';
  it('by default digests the released shape, whichever shape declared the entries', () => {
    const fromLegacy = old([legacy]),
      fromCurrent = now([current]);
    if (!fromLegacy.ok || !fromCurrent.ok) throw new Error('catalogs');
    expect(fromLegacy.catalog.digest).toBe(RELEASED);
    // Receipts and policies pin this digest, and older programs compute it over the released shape.
    expect(fromCurrent.catalog.digest).toBe(RELEASED);
    // The reader view is unchanged: codec references stay {id, version}.
    expect(fromCurrent.catalog.formatVersion).toBe(2);
    expect(fromCurrent.catalog.entries[0]!.inputCodec).toEqual({ id: 'acme-typing-input', version: 1 });
  });
  it('digests the current shape once the switch flips, and a legacy catalog keeps its own digest', () => {
    flip.plain = true;
    const fromLegacy = old([legacy]),
      fromCurrent = now([current]);
    if (!fromLegacy.ok || !fromCurrent.ok) throw new Error('catalogs');
    expect(fromLegacy.catalog.digest).toBe(RELEASED);
    expect(fromCurrent.catalog.digest).not.toBe(RELEASED);
    expect(fromCurrent.catalog.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
