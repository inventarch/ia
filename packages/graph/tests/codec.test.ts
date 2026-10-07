import { createHash } from 'node:crypto';
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
    // UTF-16 code-unit order, not code-point order, except that array-index keys lead in numeric order.
    expect(canonical({ '\uffff': 0, '\u{1f600}': 1, é: 2, z: 3, Z: 4, 10: 5, 9: 6 })).toBe(
      '{"9":6,"10":5,"Z":4,"z":3,"é":2,"\u{1f600}":1,"\uffff":0}',
    );
    const hidden = Object.defineProperty({ [Symbol('s')]: 1, a: -0 }, 'b', { value: 2, enumerable: false });
    expect(canonical(hidden)).toBe('{"a":0}');
    expect(canonical(Object.assign(Object.create(null) as object, { b: 1e21, a: [] }))).toBe('{"a":[],"b":1e+21}');
  });

  it('digests the UTF-8 bytes of the canonical text as lowercase hex SHA-256', () => {
    const expected = createHash('sha256').update(Buffer.from('{"é":"ü"}', 'utf8')).digest('hex');
    expect(digest({ é: 'ü' })).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses non-finite, non-plain and unsafe data with stable codes', () => {
    const refusal = (value: unknown): CodecError => {
      try {
        canonical(value);
      } catch (error) {
        expect(error).toBeInstanceOf(CodecError);
        expect(error).toBeInstanceOf(Error);
        expect((error as CodecError).name).toBe('CodecError');
        return error as CodecError;
      }
      throw new Error('expected a refusal');
    };
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => 0,
      Symbol('s'),
      new Map(),
      new Date(0),
      { a: undefined },
    ])
      expect(refusal(value).code).toBe('IA-SESSION-INPUT-INVALID');
    for (const key of ['__proto__', 'prototype', 'constructor'])
      expect(refusal(JSON.parse(`{"${key}": 1}`))).toMatchObject({
        code: 'IA-SESSION-INPUT-INVALID',
        message: 'Unsafe object key',
      });
    const nest = (levels: number, leaf: unknown): unknown => {
      let value = leaf;
      for (let i = 0; i < levels; i += 1) value = [value];
      return value;
    };
    expect(canonical(nest(64, 0))).toBe(`${'['.repeat(64)}0${']'.repeat(64)}`);
    expect(refusal(nest(65, 0)).code).toBe('IA-SESSION-LIMIT-EXCEEDED');
    expect(refusal(nest(65, undefined)).code).toBe('IA-SESSION-LIMIT-EXCEEDED');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(refusal(cyclic).code).toBe('IA-SESSION-LIMIT-EXCEEDED');
    const ring: unknown[] = [1, 'x'];
    ring.push({ next: ring, ok: true });
    expect(refusal(ring).code).toBe('IA-SESSION-LIMIT-EXCEEDED');
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
    const bare = copy(Object.assign(Object.create(null) as object, { b: 1, a: 2 }));
    expect(Object.getPrototypeOf(bare)).toBe(Object.prototype);
    expect(Object.keys(bare)).toEqual(['a', 'b']);
  });
});
