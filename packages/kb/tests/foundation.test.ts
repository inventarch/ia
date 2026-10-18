import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLegacyFoundation, validatePortable } from '../src/legacy.js';
import { digest, hash } from '../src/format.js';
import type { LegacyPortable } from '../src/format.js';
import type { Foundation } from '../src/foundation.js';
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const foundation = createLegacyFoundation(read('legacy-foundation.json'));
const portable = read('legacy-package.json') as LegacyPortable;
const repack = (files: LegacyPortable['files']) => {
  const { digest: _pin, ...value } = portable;
  const body = {
    ...value,
    files: files.map((f) => ({ ...f, sha256: hash(f.text) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return { ...body, digest: digest(body) };
};
describe('strict public foundation and captured resources', () => {
  it('reproduces historical pins without depending on executing package enumeration', () => {
    const view = validatePortable(portable, foundation);
    expect(view.foundationPin).toBe('b8517e1a48b45d2e4f5cfa4bc2054cbfc212621d03d551e90145ebad77271aad');
    expect(view.capture.revision).toBe('e504cb35b017e722e844842d64bd5aa8da361a233d2bc93f9ac247847ad7655c');
    expect(view.resources.digest).toBe('51c35d8fb5cca2298566c69b9f750f40f1f4015331be06a6e2c9869e12dfbaee');
    expect(view.records[0]?.body).toBe('# Alpha\n\nExact portable knowledge.\n');
    expect(view.admission.unavailableChecks).toEqual(['COMP-FIXTURES', 'COMP-KERNEL']);
    expect(validatePortable(structuredClone(portable), foundation)).toBe(view);
  });
  it('rejects an untrusted or altered foundation and changed pin inputs', () => {
    expect(() => validatePortable(portable, structuredClone(foundation))).toThrow('Host-owned');
    const altered = structuredClone(read('legacy-foundation.json')) as Foundation;
    expect(() =>
      createLegacyFoundation({
        ...altered,
        installed: [...altered.installed, { name: '@inventarch/kb', version: '3.1.1' }],
      }),
    ).toThrow();
    expect(() => createLegacyFoundation({ ...altered, native: { ...altered.native, version: '3.2.0' } })).toThrow();
  });
  it('rejects absent bodies, unassociated resources and dangling native relationships', () => {
    expect(() => validatePortable(repack(portable.files.slice(0, 1)), foundation)).toThrow(/binding/);
    expect(() =>
      validatePortable(
        repack([...portable.files, { path: 'docs/unselected.md', text: 'hidden', sha256: '' }]),
        foundation,
      ),
    ).toThrow(/Unassociated/);
    const native = portable.files[0]!;
    expect(() =>
      validatePortable(
        repack([{ ...native, text: native.text + '  relationships\n    cites @spec missing\n' }, portable.files[1]!]),
        foundation,
      ),
    ).toThrow(/closure|admission/);
  });
});
