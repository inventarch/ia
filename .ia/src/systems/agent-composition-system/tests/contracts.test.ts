import { expect, it } from 'vitest';
import type { Manifest } from '../src/index.js';

it('describes portable composition with data rather than installed functions or credentials', () => {
  const manifest: Manifest = {
    version: 1,
    id: 'example',
    digest: 'pinned',
    workspace: 'workspace',
    sourceDigest: 'source',
    profiles: {},
    operations: {},
    reactions: [],
    provenance: {},
  };
  expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
});
