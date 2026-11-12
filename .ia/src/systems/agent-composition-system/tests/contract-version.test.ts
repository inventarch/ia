import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { digest } from '@inventarch/session-system';
import { compileHarness, executionManifest, installed } from '../src/index.js';
import type { CatalogAliases, CompiledHarness, CompositionCatalog } from '../src/index.js';
import { compilerCapture, compilerCatalog } from './compiler-fixture.js';

// A contract's version is its installed entry's `version` field, not part of its name, and a catalogue that renames a
// contract keeps the original entry for existing pins and sends records that still name it to the new one.

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const captured = compilerCapture(root);
const implementationDigest = digest(readFileSync(`${root}/packages/workspace-runtime/src/corpus.ts`, 'utf8'));
const catalog = (): CompositionCatalog => compilerCatalog('ide', implementationDigest);
const compile = (chosen: CompositionCatalog, aliases?: CatalogAliases) =>
  compileHarness(captured, {
    harness: 'native-sample',
    entry: 'sample-entry',
    catalog: chosen,
    ...(aliases ? { aliases } : {}),
  });
function compiled(chosen: CompositionCatalog, aliases?: CatalogAliases): CompiledHarness {
  const result = compile(chosen, aliases);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.manifest;
}
const codes = (result: ReturnType<typeof compile>) => (result.ok ? [] : result.diagnostics.map((d) => d.code));
/** The fixture's mandate under a plain name, as a renamed catalogue would install it. */
function renamed(version = 1): CompositionCatalog {
  const base = catalog();
  const { 'sample-task-v1': original, ...rest } = base.mandates;
  if (!original) throw new Error('fixture mandate missing');
  return { ...base, mandates: { ...rest, 'sample-task': installed(original.value, version) } };
}

it('installs a contract at a positive integer version, inside its digest', () => {
  const entry = installed({ kind: 'identity' as const }, 2);
  expect(entry.version).toBe(2);
  expect(entry.digest).toBe(digest({ version: 2, value: { kind: 'identity' } }));
  expect(installed({ kind: 'identity' as const }).version).toBe(1);
  for (const version of [0, -1, 1.5, Number.NaN]) expect(() => installed({}, version)).toThrow();
});

it('compiles a contract installed at version 2 and pins it through its digest', () => {
  const first = catalog();
  const second = catalog();
  const original = first.mandates['sample-task-v1'];
  if (!original) throw new Error('fixture mandate missing');
  second.mandates['sample-task-v1'] = installed(original.value, 2);
  const one = compiled(first);
  const two = compiled(second);
  expect(two.digest).not.toBe(one.digest);
  const pin = two.provenance.installed.find((p) => p.group === 'mandates' && p.id === 'sample-task-v1');
  expect(pin?.digest).toBe(digest({ version: 2, value: original.value }));
  expect(() => executionManifest(two, second)).not.toThrow();
  expect(() => executionManifest(two, first)).toThrow(/Installed contract changed/);
});

it('refuses an installed entry whose version is not a positive integer', () => {
  for (const version of [0, 1.5, -2]) {
    const bad = catalog();
    const original = bad.mandates['sample-task-v1'];
    if (!original) throw new Error('fixture mandate missing');
    bad.mandates['sample-task-v1'] = {
      version,
      value: original.value,
      digest: digest({ version, value: original.value }),
    };
    expect(codes(compile(bad))).toContain('IA-COMPOSITION-CONFLICT');
  }
});

it('sends a record that names an old contract to its plain entry through the alias table, and records the alias', () => {
  const plain = renamed(2);
  expect(codes(compile(plain))).toContain('IA-COMPOSITION-UNAVAILABLE');
  const harness = compiled(plain, { mandates: { 'sample-task-v1': 'sample-task' } });
  const pins = harness.provenance.installed.filter((p) => p.group === 'mandates').map((p) => p.id);
  expect(pins).toEqual(['sample-task']);
  expect(harness.provenance.aliases).toEqual([{ group: 'mandates', from: 'sample-task-v1', to: 'sample-task' }]);
});

it('prefers the alias over a retained original, and still executes a harness pinned before the rename', () => {
  const before = catalog();
  const pinned = compiled(before);
  const original = before.mandates['sample-task-v1'];
  if (!original) throw new Error('fixture mandate missing');
  // The renamed catalogue keeps the original entry byte for byte and adds the plain one at version 2.
  const after = renamed(2);
  after.mandates['sample-task-v1'] = original;
  const aliases: CatalogAliases = { mandates: { 'sample-task-v1': 'sample-task' } };
  const fresh = compiled(after, aliases);
  expect(fresh.provenance.installed.filter((p) => p.group === 'mandates').map((p) => p.id)).toEqual(['sample-task']);
  // Existing pins verify against the retained original; without it they are refused.
  expect(() => executionManifest(pinned, after)).not.toThrow();
  expect(() => executionManifest(pinned, renamed(2))).toThrow(/Installed contract changed/);
});

it('refuses an alias to a missing entry, to itself, or to another alias', () => {
  expect(codes(compile(renamed(), { mandates: { 'sample-task-v1': 'missing' } }))).toContain(
    'IA-COMPOSITION-UNAVAILABLE',
  );
  expect(codes(compile(catalog(), { mandates: { 'sample-task-v1': 'sample-task-v1' } }))).toContain(
    'IA-COMPOSITION-CONFLICT',
  );
  expect(
    codes(compile(renamed(), { mandates: { 'sample-task-v1': 'sample-task', 'sample-task': 'other' } })),
  ).toContain('IA-COMPOSITION-CONFLICT');
});

it('leaves a compilation that uses no alias exactly as before', () => {
  const plainly = compiled(catalog());
  const withUnusedTable = compiled(catalog(), { mandates: { 'unused-old': 'sample-task-v1' } });
  expect(Object.hasOwn(plainly.provenance, 'aliases')).toBe(false);
  expect(withUnusedTable.digest).toBe(plainly.digest);
});
