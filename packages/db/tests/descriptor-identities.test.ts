import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names are written exactly when the follow-up release flips it. */
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
  compileAppComposition,
  compileDomainModel,
  compileStorageBinding,
  createDescriptorRegistry,
  decodeDescriptorResource,
} from '../src/descriptors/index.js';
import type { DescriptorEnvelope, DescriptorResult } from '../src/descriptors/index.js';

// Decision dec-008. Descriptor resources and the trusted registry are shared documents: services other than
// this build read them, so this release reads `{format: '<name>', formatVersion: 1}` beside the released `format: 1`
// and keeps writing the released shape until the switch flips.
const fixtures = resolve(import.meta.dirname, '../fixtures/descriptors');
const read = (path: string): string => readFileSync(resolve(fixtures, path), 'utf8');
const resources: Record<string, string> = Object.fromEntries(
  readdirSync(resolve(fixtures, 'resources')).map((name) => [name, read(`resources/${name}`)]),
);
const registryData = JSON.parse(read('registry.json')) as Record<string, unknown>;
const emitted = JSON.parse(read('envelopes.json')) as Record<string, DescriptorEnvelope>;
function ok<T>(result: DescriptorResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected refusal ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}
const code = <T>(result: DescriptorResult<T>): string => (result.ok ? 'ok' : result.diagnostics[0]!.code);
const registry = (identity: Record<string, unknown> = {}) => {
  const { format: _format, ...rest } = registryData;
  return createDescriptorRegistry({ ...(Object.keys(identity).length ? identity : { format: 1 }), ...rest });
};

type Json = Record<string, unknown>;
/** The resource re-stamped, with the envelope digest recomputed honestly so only the identity differs. */
function restamped(name: string, identity: Json) {
  const { format: _format, ...rest } = JSON.parse(resources[name]!) as Json;
  const text = JSON.stringify({ ...identity, ...rest });
  return { text, digest: ok(decodeDescriptorResource(text)).digest };
}
function domain(identity: Json, key = 'orders') {
  const file = `${key}.domain.json`,
    { text, digest } = restamped(file, identity);
  const envelope = { ...emitted[key]!, fields: { ...emitted[key]!.fields, digest } };
  return compileDomainModel({ envelope, resources: { ...resources, [file]: text }, registry: ok(registry()) });
}
function storage(identity: Json) {
  const { text, digest } = restamped('orders.storage.json', identity);
  const envelope = { ...emitted['orders-store']!, fields: { ...emitted['orders-store']!.fields, digest } };
  const model = ok(compileDomainModel({ envelope: emitted['orders']!, resources, registry: ok(registry()) }));
  return compileStorageBinding({
    envelope,
    resources: { ...resources, 'orders.storage.json': text },
    registry: ok(registry()),
    model,
  });
}
function app(identity: Json) {
  const { text, digest } = restamped('orders-desk.app.json', identity);
  const envelope = { ...emitted['orders-desk']!, fields: { ...emitted['orders-desk']!.fields, digest } };
  return compileAppComposition({
    envelope,
    resources: { ...resources, 'orders-desk.app.json': text },
    registry: ok(registry()),
  });
}
const readers = [
  ['domain-descriptor', (identity: Json) => domain(identity)],
  ['storage-descriptor', storage],
  ['app-descriptor', app],
] as const;

it.each(readers)(
  '%s: a resource reads in the released shape and in the plain shape, and compiles alike',
  (name, run) => {
    const released = ok(run({ format: 1 }) as DescriptorResult<Json>),
      plain = ok(run({ format: name, formatVersion: 1 }) as DescriptorResult<Json>);
    // The resource digest and what is derived from it name the bytes read, so they differ; everything compiled is the same.
    const strip = ({ digests: _digests, resource: _resource, ...rest }: Json) => rest;
    expect(strip(plain)).toEqual(strip(released));
  },
);
it.each(readers)('%s: any other identity is refused', (name, run) => {
  const refused = (identity: Json) => code(run(identity) as DescriptorResult<Json>);
  expect(refused({ format: 2 })).toBe('DESC-FORMAT-UNSUPPORTED');
  expect(refused({ format: name, formatVersion: 2 })).toBe('DESC-FORMAT-UNSUPPORTED');
  for (const identity of [
    { format: name },
    { format: name, formatVersion: '1' },
    { format: `${name}-1`, formatVersion: 1 },
    { format: `ia.${name}.v1`, formatVersion: 1 },
    { format: 'other-descriptor', formatVersion: 1 },
    { format: '1' },
    { format: 1, formatVersion: 1 },
  ])
    expect(refused(identity), JSON.stringify(identity)).not.toBe('ok');
});
it('descriptor-registry: reads the released shape and the plain shape; refuses any other', () => {
  const released = ok(registry({ format: 1 })),
    plain = ok(registry({ format: 'descriptor-registry', formatVersion: 1 }));
  expect(plain.targets).toEqual(released.targets);
  expect(plain.contracts).toEqual(released.contracts);
  for (const identity of [
    { format: 2 },
    { format: 'descriptor-registry' },
    { format: 'descriptor-registry', formatVersion: 2 },
    { format: 'ia.descriptor-registry.v1', formatVersion: 1 },
    { format: 1, formatVersion: 1 },
  ])
    expect(code(registry(identity)), JSON.stringify(identity)).not.toBe('ok');
});

// What this package compiles and registers is written by it, so it follows the switch.
it('writes the released shape by default, so the compiled output stays what released programs read', () => {
  expect(ok(registry({ format: 1 })).format).toBe(1);
  const model = ok(domain({ format: 1 }));
  expect(model.format).toBe(1);
  expect(Object.hasOwn(model, 'formatVersion')).toBe(false);
  expect(ok(storage({ format: 1 })).format).toBe(1);
  expect(ok(app({ format: 1 })).format).toBe(1);
});
it('writes the plain format name with formatVersion once the switch flips', () => {
  flip.plain = true;
  expect(ok(registry({ format: 1 }))).toMatchObject({ format: 'descriptor-registry', formatVersion: 1 });
  expect(ok(domain({ format: 1 }))).toMatchObject({ format: 'compiled-domain-descriptor', formatVersion: 1 });
  expect(ok(storage({ format: 1 }))).toMatchObject({ format: 'compiled-storage-descriptor', formatVersion: 1 });
  expect(ok(app({ format: 1 }))).toMatchObject({ format: 'compiled-app-descriptor', formatVersion: 1 });
});
