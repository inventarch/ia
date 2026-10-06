import { expect, it } from 'vitest';
import { verifyInstalledAdapter } from '../src/adapters.js';
import { metadataDigest } from '../src/resource-format.js';
import { adapterFixture } from './adapter-fixture.js';

it('verifies an exact closed installed adapter without executing or loading its catalog entrypoint', () => {
  const f = adapterFixture(),
    selected = verifyInstalledAdapter(f.adapter, f.catalog);
  expect(selected).toEqual(f.adapter);
  f.adapter.operations[0]!.handler = 'changed-after-admission';
  expect(selected.operations[0]!.handler).toBe('retained-ingest-v1');
  expect(Object.isFrozen(selected.operations)).toBe(true);
});

it('refuses unknown keys, duplicate JSON fields, changed operation contracts and unqualified containment', () => {
  const f = adapterFixture();
  for (const value of [
    { ...f.adapter, module: './untrusted.js' },
    JSON.stringify(f.adapter).replace('"version":"1.0.0"', '"version":"1.0.0","version":"1.0.0"'),
  ])
    expect(() => verifyInstalledAdapter(value, f.catalog)).toThrow();
  const changed = structuredClone(f.adapter);
  changed.operations[0]!.recovery = 'manual';
  const { digest: _digest, ...body } = changed;
  changed.digest = metadataDigest(body);
  expect(() => verifyInstalledAdapter(changed, f.catalog)).toThrow();
  const contained = structuredClone(f.adapter);
  contained.effects[0]!.enforcement = 'contained';
  const { digest: _old, ...containedBody } = contained;
  contained.digest = metadataDigest(containedBody);
  expect(() => verifyInstalledAdapter(contained, { adapters: { retained: contained }, containments: [] })).toThrow();
  expect(
    verifyInstalledAdapter(contained, {
      adapters: { retained: contained },
      containments: [{ adapterDigest: contained.digest, targetPolicy: 'owned-store' }],
    }).digest,
  ).toBe(contained.digest);
});

it('refuses unbounded operation envelopes and executable paths in opaque binding keys', () => {
  const f = adapterFixture();
  for (const mutate of [
    (value: typeof f.adapter) => {
      value.limits.durationMs = 120001;
    },
    (value: typeof f.adapter) => {
      value.limits.inputBytes = 1024 * 1024 + 1;
    },
    (value: typeof f.adapter) => {
      value.implementation.entrypoint = '../load.js';
    },
  ]) {
    const value = structuredClone(f.adapter);
    mutate(value);
    const { digest: _digest, ...body } = value;
    value.digest = metadataDigest(body);
    expect(() => verifyInstalledAdapter(value, { adapters: { retained: value }, containments: [] })).toThrow();
  }
});
