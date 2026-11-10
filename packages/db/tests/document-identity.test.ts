import { expect, it } from 'vitest';
import { identityOf, readIdentity } from '../src/document-identity.js';

// Decision dec-008 (A14, A15): a document names its type and version with `format` and `formatVersion`; each reader
// lists the exact shapes it still accepts, and nothing parses a version suffix.
const bindings = { name: 'bindings', versions: [1], released: [{ key: 'format', value: 1, version: 1 }] } as const;
const read = (value: unknown, spec: typeof bindings | typeof lock = bindings) =>
  readIdentity(value, spec.name, spec.versions, spec.released);
const lock = { name: 'lock', versions: [1], released: [{ key: 'formatVersion', value: 1, version: 1 }] } as const;

it('reads the plain shape and the exact released shape of an integer-format document', () => {
  expect(read({ format: 'bindings', formatVersion: 1 })).toEqual({
    version: 1,
    plain: true,
    keys: ['format', 'formatVersion'],
  });
  expect(read({ format: 1 })).toEqual({ version: 1, plain: false, keys: ['format'] });
});
it('refuses any other identity of an integer-format document', () => {
  for (const value of [
    { format: 2 },
    { format: '1' },
    { format: 1, formatVersion: 1 },
    { format: 'bindings' },
    { format: 'bindings', formatVersion: 2 },
    { format: 'bindings', formatVersion: '1' },
    { format: 'bindings.v1', formatVersion: 1 },
    { format: 'bindings', formatVersion: 1.5 },
    { schema: 'bindings' },
    null,
    [],
    'bindings',
  ])
    expect(read(value), JSON.stringify(value)).toBeUndefined();
});
it('reads a document that carried a version and no name with the name present or absent', () => {
  expect(read({ formatVersion: 1 }, lock)).toEqual({ version: 1, plain: false, keys: ['formatVersion'] });
  expect(read({ format: 'lock', formatVersion: 1 }, lock)).toEqual({
    version: 1,
    plain: true,
    keys: ['format', 'formatVersion'],
  });
  for (const value of [
    { formatVersion: 2 },
    { format: 'other', formatVersion: 1 },
    { format: 1, formatVersion: 1 },
    {},
  ])
    expect(read(value, lock), JSON.stringify(value)).toBeUndefined();
});
it('refuses a document that names itself in both shapes', () => {
  const schema = [{ key: 'schema', value: 'ia.thing.v1', version: 1 }] as const;
  expect(readIdentity({ schema: 'ia.thing.v1' }, 'thing', [1], schema)).toEqual({
    version: 1,
    plain: false,
    keys: ['schema'],
  });
  expect(readIdentity({ format: 'thing', formatVersion: 1 }, 'thing', [1], schema)?.plain).toBe(true);
  expect(
    readIdentity({ schema: 'ia.thing.v1', format: 'thing', formatVersion: 1 }, 'thing', [1], schema),
  ).toBeUndefined();
});
it('reads only own properties', () => {
  expect(read(Object.create({ format: 1 }))).toBeUndefined();
});
it('chooses the released or the plain identity by the switch it is given', () => {
  expect(identityOf(false, 'bindings', 1, { format: 1 })).toEqual({ format: 1 });
  expect(identityOf(true, 'bindings', 1, { format: 1 })).toEqual({ format: 'bindings', formatVersion: 1 });
  expect(identityOf(false, 'lock', 1, { formatVersion: 1 })).toEqual({ formatVersion: 1 });
  expect(Object.keys(identityOf(true, 'lock', 1, { formatVersion: 1 }))).toEqual(['format', 'formatVersion']);
});
