import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  acquisitionRequest,
  artifactReadRequest,
  releaseBuildRequest,
  releasePublishRequest,
  releaseTerms,
} from '../src/marketplace.js';
const hash = 'a'.repeat(64);
const descriptor = {
  formatVersion: 1,
  id: 'independent/product',
  version: '1.0.0',
  distribution: 'workspace-system/definition/distribution/example',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [{ id: 'independent/foundation', range: '^1.0.0', systems: ['workspace-system'] }],
  assets: [{ path: 'LICENSE', role: 'license' }],
  source: { repository: 'https://independent.example/source', commit: hash, recipe: 'ustar-v1', epoch: 1700000000 },
  license: 'UNLICENSED',
  description: 'Independent release',
};
const request = { commandId: 'build', source: { workspaceId: 'source', revisionId: hash }, descriptor };
it('retains the full Apache license while refusing oversized or empty release terms', () => {
  const terms = {
    license: 'Apache-2.0',
    revision: '2026-10-01',
    text: readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'),
  };
  expect(terms.text.length).toBeGreaterThan(8192);
  expect(releaseTerms.parse(terms)).toEqual(terms);
  for (const text of ['', 'x'.repeat(16385)]) expect(releaseTerms.safeParse({ ...terms, text }).success).toBe(false);
});
it('uses closed browser native release descriptors without caller authority or server paths', () => {
  expect(releaseBuildRequest.parse(request)).toEqual(request);
  for (const next of [
    { ...descriptor, owner: 'foreign' },
    { ...descriptor, source: { ...descriptor.source, root: 'Z:/private' } },
    { ...descriptor, dependencies: [{ ...descriptor.dependencies[0], grant: true }] },
    { ...descriptor, assets: [{ path: 'LICENSE', role: 'license', url: 'https://private.example/' }] },
    { ...descriptor, language: ['2.0'] },
    { ...descriptor, assets: [{ path: 'LICENSE', role: 'execute' }] },
  ])
    expect(releaseBuildRequest.safeParse({ ...request, descriptor: next }).success).toBe(false);
  expect(releaseBuildRequest.safeParse({ ...request, actor: 'administrator' }).success).toBe(false);
});
it('bounds publication, acquisition and protected artifact selectors independently of native semantics', () => {
  expect(releasePublishRequest.safeParse({ commandId: 'publish', stageId: 'stage', approved: true }).success).toBe(
    false,
  );
  expect(acquisitionRequest.safeParse({ commandId: 'acquire', owner: 'foreign', quote: {} }).success).toBe(false);
  expect(
    artifactReadRequest.parse({ acquisitionId: 'acquisition', archive: hash, offset: 0, length: 98304 }).length,
  ).toBe(98304);
  for (const fields of [
    { length: 98305 },
    { offset: -1 },
    { url: 'https://private.example/archive' },
    { path: '/storage/file' },
  ])
    expect(
      artifactReadRequest.safeParse({ acquisitionId: 'acquisition', archive: hash, offset: 0, length: 1, ...fields })
        .success,
    ).toBe(false);
});
