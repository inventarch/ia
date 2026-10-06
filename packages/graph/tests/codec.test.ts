import { describe, expect, it } from 'vitest';
import { CodecError, canonical, copy, digest } from '../src/codec.js';

/**
 * Byte-equality vectors captured from the session-system codec before it moved here (2026-10-06). They pin the
 * canonical text and the digest, so any later change to the algorithm is a deliberate, visible break.
 */
const VECTORS: readonly {
  readonly name: string;
  readonly value: unknown;
  readonly canonical: string;
  readonly digest: string;
}[] = [
  {
    name: 'object-sorted',
    value: { b: 1, a: [1, 'x', null, true], c: { z: '', y: 2.5 } },
    canonical: '{"a":[1,"x",null,true],"b":1,"c":{"y":2.5,"z":""}}',
    digest: '955ac9a11dc900b04b5937d20275b2ea116cadce45f90cb3a93eceb6a5f3b8f7',
  },
  {
    name: 'string',
    value: 'plain text',
    canonical: '"plain text"',
    digest: '86696ae0a7dd4789bb5a8256f0a58a13243fe65bafb37c44f3c73e2228fd78b7',
  },
  {
    name: 'number',
    value: 42,
    canonical: '42',
    digest: '73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049',
  },
  {
    name: 'array',
    value: [3, 2, 1],
    canonical: '[3,2,1]',
    digest: '30c8681f9b840aceee56b737f3b126ae67ec4eb71d2881db831f86014fba016d',
  },
  {
    name: 'empty-object',
    value: {},
    canonical: '{}',
    digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  },
  {
    name: 'nested',
    value: { outer: { inner: { leaf: [{ k: 'v' }] } } },
    canonical: '{"outer":{"inner":{"leaf":[{"k":"v"}]}}}',
    digest: '643edf75f23344411878bf6cb329677d6bb84dbe091304011752748facdb5889',
  },
];

describe('canonical codec', () => {
  it('produces the session codec bytes for the pinned vectors', () => {
    for (const vector of VECTORS) {
      expect(canonical(vector.value), vector.name).toBe(vector.canonical);
      expect(digest(vector.value), vector.name).toBe(vector.digest);
    }
  });

  it('orders keys and distinguishes exact text', () => {
    expect(digest({ z: [1, 2], a: 'x\r\n' })).toBe(digest({ a: 'x\r\n', z: [1, 2] }));
    expect(digest({ a: 'x\n', z: [1, 2] })).not.toBe(digest({ a: 'x\r\n', z: [1, 2] }));
  });

  it('refuses non-finite, non-plain and unsafe data with stable codes', () => {
    const refusal = (value: unknown): CodecError => {
      try {
        canonical(value);
      } catch (error) {
        expect(error).toBeInstanceOf(CodecError);
        expect((error as CodecError).name).toBe('CodecError');
        return error as CodecError;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal({ a: undefined }).code).toBe('IA-SESSION-INPUT-INVALID');
    expect(refusal(new Map()).code).toBe('IA-SESSION-INPUT-INVALID');
    expect(refusal(Number.NaN).code).toBe('IA-SESSION-INPUT-INVALID');
    expect(refusal(JSON.parse('{"__proto__": 1}')).code).toBe('IA-SESSION-INPUT-INVALID');
    let deep: unknown = 0;
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(refusal(deep).code).toBe('IA-SESSION-LIMIT-EXCEEDED');
  });

  it('copies through the canonical form and drops prototypes', () => {
    class Carrier {
      readonly b = 2;
      readonly a = 1;
    }
    expect(() => copy(new Carrier())).toThrow(CodecError);
    const original = { nested: { list: [1, { k: 'v' }] } };
    const copied = copy(original);
    expect(copied).toEqual(original);
    expect(copied).not.toBe(original);
    expect(copied.nested.list).not.toBe(original.nested.list);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
  });
});
