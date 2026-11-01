import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import { verifyPortable } from '../src/legacy.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const native =
  '#! ia 1.0\n\n@spec alpha\n  meaning\n    says "Portable alpha knowledge."\n  work\n    title "Alpha"\n    status draft\n    source "docs/alpha.md"\n';
const body = '# Alpha\n\nExact portable knowledge.\n';
const envelope = {
  format: 'iakb.portable.v1',
  provenance: { sourceId: 'fixture', commit: '1'.repeat(40), verification: 'unverified' },
  files: [
    { path: '.ia/src/notes.ia', text: native, sha256: hash(native) },
    { path: 'docs/alpha.md', text: body, sha256: hash(body) },
  ],
};
const portable = { ...envelope, digest: 'e50a076dfc4e12ab4d52438eef5caf06cad35ce614b84caec71f64a8e919822d' };
describe('legacy wire contract', () => {
  it('preserves the independently characterized canonical digest and exact bytes', () => {
    expect(verifyPortable(portable)).toEqual(portable);
    expect(verifyPortable(JSON.stringify(portable))).toEqual(portable);
  });
  it('refuses altered bytes, fields, aliases and legacy path broadening', () => {
    for (const change of [
      (p: typeof portable) => {
        p.files[1]!.text += 'changed';
      },
      (p: typeof portable) => {
        p.files[1]!.path = 'README.md';
      },
      (p: typeof portable) => {
        p.files[1]!.path = '../docs/alpha.md';
      },
    ]) {
      const p = structuredClone(portable);
      change(p);
      const { digest: _digest, ...content } = p;
      p.digest = hash(stableSerialize(content));
      expect(() => verifyPortable(p)).toThrow();
    }
    expect(() => verifyPortable({ ...portable, extra: true })).toThrow();
  });
  it('keeps its original 8 MiB selected byte limit', () => {
    const megabyte = 1024 * 1024;
    const sealed = (extra: number) => {
      const bodies = Array.from({ length: 8 }, (_, i) => {
        const text = 'x'.repeat(i < 7 ? megabyte : megabyte - Buffer.byteLength(native) + extra);
        return { path: 'docs/b' + i + '.md', text, sha256: hash(text) };
      });
      const content = { ...envelope, files: [envelope.files[0]!, ...bodies] };
      return { ...content, digest: hash(stableSerialize(content)) };
    };
    expect(verifyPortable(sealed(0)).files).toHaveLength(9);
    expect(() => verifyPortable(sealed(1))).toThrow('Portable byte limit exceeded');
  });
});
