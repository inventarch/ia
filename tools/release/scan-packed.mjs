import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unpackTree, HOST_TREE_LIMITS } from '../../apps/distribution/dist/ustar.js';
import { scanPackedArchives } from './packed-content.mjs';
/** npm:prepare already builds the trusted checkout; no code from an archive is loaded here. */
export function scanPackedPublicContent(root, packed) {
  const policy = JSON.parse(readFileSync(resolve(root, 'tools/distribution/public-content-policy.json'), 'utf8'));
  return scanPackedArchives(packed, policy, { unpackTree, limits: HOST_TREE_LIMITS });
}
