import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createFoundation } from '../src/foundation.js';
const installation = () =>
  JSON.parse(readFileSync(new URL('./fixtures/public-installation.json', import.meta.url), 'utf8'));
it('derives the foundation profile and exact source membership from verified installation evidence', () => {
  const f = createFoundation({ installation: installation() });
  expect(f.native).toMatchObject({ id: 'inventarch/language', version: '3.1.1' });
  expect(f.capture.sources.some((s) => s.path.includes('/systems/work-system/'))).toBe(true);
  expect(f.installed).toEqual([]);
});
it('refuses supplied profile labels and tampered installation metadata or bytes', () => {
  const i = installation();
  const { pin: _pin, ...labels } = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8'),
  );
  expect(() =>
    createFoundation({ ...labels, native: { ...labels.native, version: '99.0.0', manifest: '0'.repeat(64) } }),
  ).toThrow();
  i.bundles[0].manifest.version = '99.0.0';
  expect(() => createFoundation({ installation: i })).toThrow();
  const changed = installation();
  changed.bundles[0].files[0].base64 = Buffer.from('injected').toString('base64');
  expect(() => createFoundation({ installation: changed })).toThrow();
});
