import * as graph from '@inventarch/graph';
import { expect, it } from 'vitest';
import { CodecError, SessionError, canonical, copy, digest, identifier } from '../src/index.js';

it('canonical command digests preserve exact data and reject unsafe or non-JSON inputs', () => {
  expect(digest({ z: [1, 2], a: 'x\r\n' })).toBe(digest({ a: 'x\r\n', z: [1, 2] }));
  expect(digest({ a: 'x\n', z: [1, 2] })).not.toBe(digest({ a: 'x\r\n', z: [1, 2] }));
  for (const value of [undefined, NaN, Infinity, new Map(), { value: undefined }, JSON.parse('{"__proto__":1}')])
    expect(() => canonical(value)).toThrow();
  expect(() => identifier('../other-session')).toThrow();
  const value = { data: ['private'] };
  const cloned = copy(value);
  cloned.data.push('later');
  expect(value.data).toEqual(['private']);
});

it("re-exports graph's CodecError class and refuses with SessionError under the graph codec's codes", () => {
  expect(CodecError).toBe(graph.CodecError);
  const refusal = (run: () => unknown): CodecError => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(graph.CodecError);
      return error as CodecError;
    }
    throw new Error('expected a refusal');
  };
  let deep: unknown = 0;
  for (let i = 0; i < 65; i += 1) deep = [deep];
  for (const [session, shared, code] of [
    [() => canonical(new Map()), () => graph.canonical(new Map()), 'IA-SESSION-INPUT-INVALID'],
    [() => digest({ value: NaN }), () => graph.digest({ value: NaN }), 'IA-SESSION-INPUT-INVALID'],
    [() => copy({ constructor: 1 }), () => graph.copy({ constructor: 1 }), 'IA-SESSION-INPUT-INVALID'],
    [() => canonical(deep), () => graph.canonical(deep), 'IA-SESSION-LIMIT-EXCEEDED'],
  ] as const) {
    const wrapped = refusal(session),
      original = refusal(shared);
    expect(wrapped).toBeInstanceOf(SessionError);
    expect(wrapped).toBeInstanceOf(CodecError);
    expect(original).not.toBeInstanceOf(SessionError);
    expect([wrapped.name, wrapped.code, wrapped.message]).toEqual(['SessionError', code, original.message]);
    expect(original.code).toBe(code);
  }
});
