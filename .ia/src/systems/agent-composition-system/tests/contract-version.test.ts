import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { digest } from '@inventarch/session-system';
import { compileHarness, compiledAliases, executionManifest, installed } from '../src/index.js';
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

/** The fixture with its model installed as `plain-model`, the host's default, and the host listing `listed`. */
function plainModel(listed: string[] = ['plain-model']): CompositionCatalog {
  const base = catalog();
  const host = base.hosts['captured-sample-v1'];
  const { 'host-model': original, ...models } = base.models;
  if (!host || !original) throw new Error('fixture host or model missing');
  const value = { ...host.value, models: listed, defaults: { ...host.value.defaults, model: 'plain-model' } };
  return {
    ...base,
    models: { ...models, 'plain-model': original },
    hosts: { 'captured-sample-v1': installed(value, host.version) },
  };
}
const modelAlias: CatalogAliases = { models: { 'host-model': 'plain-model' } };

it('compiles a profile that names an old model where the host lists its plain name', () => {
  const { revision: _revision, ...body } = captured;
  const sources = body.sources.map((source) =>
    source.path.endsWith('/sample-author-profile.ia')
      ? { ...source, text: source.text.replace('mandate-contract sample-task-v1', '$&\n    model-profile host-model') }
      : source,
  );
  expect(sources.find((s) => s.path.endsWith('/sample-author-profile.ia'))?.text).toContain('model-profile host-model');
  const explicit = { ...body, sources, revision: digest({ ...body, sources }) };
  const result = compileHarness(explicit, {
    harness: 'native-sample',
    entry: 'sample-entry',
    catalog: plainModel(),
    aliases: modelAlias,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.manifest.provenance.aliases).toContainEqual({ group: 'models', from: 'host-model', to: 'plain-model' });
});

it('allows a plain model that the host and a mandate still list under its old name', () => {
  const chosen = plainModel(['host-model']);
  const mandate = chosen.mandates['sample-task-v1'];
  if (!mandate) throw new Error('fixture mandate missing');
  chosen.mandates['sample-task-v1'] = installed({ ...mandate.value, models: ['host-model'] }, mandate.version);
  const harness = compiled(chosen, modelAlias);
  // The alias the lists relied on is recorded, so the harness rebuilds from its own table.
  expect(harness.provenance.aliases).toEqual([{ group: 'models', from: 'host-model', to: 'plain-model' }]);
  expect(compiled(chosen, compiledAliases(harness)).digest).toBe(harness.digest);
});

/** The fixture whose mandate requires evaluator `review-v1`, installed as `review`; `retained` keeps an old entry. */
function reviewed(retained?: ('before-effect' | 'completion')[]): CompositionCatalog {
  const base = catalog();
  const mandate = base.mandates['sample-task-v1'];
  if (!mandate) throw new Error('fixture mandate missing');
  return {
    ...base,
    mandates: {
      ...base.mandates,
      'sample-task-v1': installed({ ...mandate.value, checks: ['review-v1'] }, mandate.version),
    },
    evaluators: {
      review: installed({ phases: ['completion' as const] }),
      ...(retained ? { 'review-v1': installed({ phases: retained }) } : {}),
    },
  };
}
const reviewAlias: CatalogAliases = { evaluators: { 'review-v1': 'review' } };
/** Each profile's executed checks. */
const executedChecks = (harness: CompiledHarness, chosen: CompositionCatalog) =>
  Object.values(executionManifest(harness, chosen).profiles).map((profile) => profile.contract?.checks);

it('stores and executes the evaluator an aliased check resolves to, with no entry under the old name', () => {
  const chosen = reviewed();
  const harness = compiled(chosen, reviewAlias);
  expect(Object.values(harness.profiles).map((profile) => profile.checks)).toEqual([['review'], ['review']]);
  expect(executedChecks(harness, chosen)).toEqual([
    [{ id: 'review', phases: ['completion'] }],
    [{ id: 'review', phases: ['completion'] }],
  ]);
});

it('executes the pinned entry, not a retained old evaluator entry with other phases', () => {
  const chosen = reviewed(['before-effect']);
  const harness = compiled(chosen, reviewAlias);
  expect(executedChecks(harness, chosen)).toEqual([
    [{ id: 'review', phases: ['completion'] }],
    [{ id: 'review', phases: ['completion'] }],
  ]);
});

it('executes the pinned entry for a harness that stored the old check name', () => {
  const chosen = reviewed(['before-effect']);
  const { digest: _digest, ...body } = compiled(chosen, reviewAlias);
  // As a harness compiled before checks were stored under their installed name holds them.
  const profiles = Object.fromEntries(
    Object.entries(body.profiles).map(([id, profile]) => [
      id,
      { ...profile, checks: profile.checks.map((check) => (check === 'review' ? 'review-v1' : check)) },
    ]),
  );
  const stored = { ...body, profiles };
  const older = { ...stored, digest: digest(stored) } as CompiledHarness;
  expect(Object.values(older.profiles).map((profile) => profile.checks)).toEqual([['review-v1'], ['review-v1']]);
  expect(executedChecks(older, chosen)).toEqual([
    [{ id: 'review', phases: ['completion'] }],
    [{ id: 'review', phases: ['completion'] }],
  ]);
});

/** The fixture with its context installed as `plain-context`, while the host and the mandate still name the original. */
function plainContext(): CompositionCatalog {
  const base = catalog();
  const { 'captured-context-v1': original, ...contexts } = base.contexts;
  if (!original) throw new Error('fixture context missing');
  return { ...base, contexts: { ...contexts, 'plain-context': original } };
}

it('stores the context an old listed name resolves to, and rebuilds from the recorded aliases', () => {
  const chosen = plainContext();
  const harness = compiled(chosen, { contexts: { 'captured-context-v1': 'plain-context' } });
  expect(Object.values(harness.profiles).map((profile) => profile.contexts)).toEqual([
    ['plain-context'],
    ['plain-context'],
  ]);
  expect(harness.provenance.installed.filter((pin) => pin.group === 'contexts').map((pin) => pin.id)).toEqual([
    'plain-context',
  ]);
  expect(compiled(chosen, compiledAliases(harness)).digest).toBe(harness.digest);
});

it('refuses to execute an evaluator the harness does not pin', () => {
  const chosen = reviewed();
  chosen.evaluators['other'] = installed({ phases: ['before-effect' as const] });
  const { digest: _digest, ...body } = compiled(chosen, reviewAlias);
  const profiles = Object.fromEntries(
    Object.entries(body.profiles).map(([id, profile]) => [id, { ...profile, checks: ['other'] }]),
  );
  const stored = { ...body, profiles };
  const forged = { ...stored, digest: digest(stored) } as CompiledHarness;
  expect(() => executionManifest(forged, chosen)).toThrow(/not pinned: other/);
});

it('reads a recorded alias table without touching object prototypes', () => {
  const { digest: _digest, ...body } = compiled(catalog());
  const forged = {
    ...body,
    provenance: { ...body.provenance, aliases: [{ group: '__proto__', from: 'polluted', to: 'yes' }] },
  } as unknown as CompiledHarness;
  try {
    compiledAliases(forged);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  } finally {
    delete (Object.prototype as Record<string, unknown>)['polluted'];
  }
});
