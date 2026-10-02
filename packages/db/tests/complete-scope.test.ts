import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { open } from '../src/index.js';
const root = resolve(import.meta.dirname, '../../..');
it('proves only complete current scopes, including their narrowing ancestry', () => {
  const reader = open(root, { cache: false }),
    other = open(root, { cache: false });
  try {
    const full = reader.resolveScope().token;
    expect(reader.isCompleteScope(full)).toBe(true);
    expect(reader.isCompleteScope(reader.resolveScope({ within: full }).token)).toBe(true);
    for (const scope of [
      reader.resolveScope({ phase: 'act' }),
      reader.resolveScope({ identities: reader.records().map((r) => r.identity) }),
      reader.resolveScope({ identities: [] }),
    ]) {
      expect(reader.isCompleteScope(scope.token)).toBe(false);
      expect(reader.isCompleteScope(reader.resolveScope({ within: scope.token, phase: null }).token)).toBe(false);
    }
    expect(() => reader.isCompleteScope('forged')).toThrow();
    expect(() => reader.isCompleteScope(other.resolveScope().token)).toThrow();
    reader.close();
    expect(() => reader.isCompleteScope(full)).toThrow();
  } finally {
    reader.close();
    other.close();
  }
});
