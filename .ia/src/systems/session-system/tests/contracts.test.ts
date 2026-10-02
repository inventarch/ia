import { expect, it } from 'vitest';
import { canonical, copy, digest, identifier } from '../src/index.js';

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
