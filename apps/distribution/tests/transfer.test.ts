import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cacheAcquisition } from '../src/transfer.js';
import { resolveReleases } from '../src/resolve.js';
import { snapshotFixture } from './snapshot-fixture.js';

let fixture: ReturnType<typeof snapshotFixture>;
beforeAll(() => {
  fixture = snapshotFixture();
});
afterAll(() => {
  fixture?.close();
});
function receipt() {
  const lock = resolveReleases(
    [{ id: fixture.packed.manifest.id, range: '^0.1.0' }],
    [{ release: fixture.packed, location: `sha256:${fixture.packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  ).lock;
  return { acquisitionId: 'acquired', lock };
}
function chunk(request: { acquisitionId: string; archive: string; offset: number; length: number }) {
  expect(request.acquisitionId).toBe('acquired');
  expect(request.archive).toBe(fixture.packed.archiveDigest);
  const end = Math.min(fixture.packed.bytes.length, request.offset + request.length);
  return {
    archive: request.archive,
    bytes: fixture.packed.bytes.length,
    offset: request.offset,
    data: fixture.packed.bytes.subarray(request.offset, end).toString('base64'),
    next: end === fixture.packed.bytes.length ? null : end,
  };
}

it('assembles protected chunks into an exact verified native cache without activating a workspace', async () => {
  const target = fixture.target();
  let calls = 0;
  const result = await cacheAcquisition(
    target,
    receipt(),
    async (input) => {
      calls++;
      return chunk(input);
    },
    { chunkBytes: 1024 },
  );
  expect(calls).toBeGreaterThan(1);
  expect(result.archives).toEqual([fixture.packed.archiveDigest]);
  expect(result.lock).toEqual(receipt().lock);
  expect(existsSync(join(target, '.ia/distributions/active.json'))).toBe(false);
});

it('refuses redirected identity, reordered offsets, corrupt bytes and truncated transfer', async () => {
  for (const alter of [
    (value: ReturnType<typeof chunk>) => ({ ...value, archive: 'f'.repeat(64) }),
    (value: ReturnType<typeof chunk>) => ({ ...value, offset: value.offset + 1 }),
    (value: ReturnType<typeof chunk>) => ({ ...value, data: Buffer.from('corrupt').toString('base64') }),
    (value: ReturnType<typeof chunk>) => ({ ...value, next: null }),
  ])
    await expect(
      cacheAcquisition(fixture.target(), receipt(), async (input) => alter(chunk(input)), { chunkBytes: 1024 }),
    ).rejects.toThrow();
});

it('snapshots the selected acquisition and stops when current authority is revoked between chunks', async () => {
  const selected = receipt(),
    target = fixture.target();
  let calls = 0;
  const work = cacheAcquisition(
    target,
    selected,
    async (input) => {
      selected.acquisitionId = 'retargeted';
      if (++calls === 2) throw new Error('License revoked');
      return chunk(input);
    },
    { chunkBytes: 1024 },
  );
  await expect(work).rejects.toThrow('License revoked');
  expect(calls).toBe(2);
  expect(existsSync(join(target, '.ia/distributions/active.json'))).toBe(false);
});

it('rejects caller URLs and extra transfer fields before accepting bytes', async () => {
  await expect(
    cacheAcquisition(fixture.target(), { ...receipt(), url: 'https://untrusted.example/' }, async (input) =>
      chunk(input),
    ),
  ).rejects.toThrow();
  await expect(
    cacheAcquisition(fixture.target(), receipt(), async (input) => ({ ...chunk(input), storagePath: 'private' })),
  ).rejects.toThrow();
});

it('bounds a transport that ignores cancellation', async () => {
  await expect(
    cacheAcquisition(fixture.target(), receipt(), async () => new Promise(() => {}), { requestTimeoutMs: 20 }),
  ).rejects.toThrow();
});

it('refuses a second package identity borrowing the same authentic archive', async () => {
  const selected = receipt(),
    pkg = selected.lock.packages[0]!;
  const lock = {
    ...selected.lock,
    requests: [...selected.lock.requests, { id: 'fixture/other', range: pkg.version }],
    packages: [...selected.lock.packages, { ...pkg, id: 'fixture/other' }],
  };
  await expect(
    cacheAcquisition(fixture.target(), { ...selected, lock }, async (input) => chunk(input)),
  ).rejects.toThrow();
});
