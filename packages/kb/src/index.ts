import { written } from './plain-format.js';

/** The plain name packages carry once `WRITE_PLAIN_NAMES` is `true`, beside `formatVersion` 1. */
export const PLAIN_KB_FORMAT = 'kb-package';
/** The literal packages carried before formats stopped carrying their version; still read, and written while `WRITE_PLAIN_NAMES` is `false`. */
export const LEGACY_KB_FORMAT = 'ia.kb.package.v1';
/** The format literal written by `packageFromCommit`: `ia.kb.package.v1` while `WRITE_PLAIN_NAMES` is `false`, `kb-package` once flipped. */
export const KB_FORMAT = written(PLAIN_KB_FORMAT, LEGACY_KB_FORMAT);
export { createFoundation, foundationFromWorkspace } from './foundation.js';
export type { Foundation, FoundationInput, NativeProfile } from './foundation.js';
export { KnowledgeError, LIMITS } from './format.js';
export { packageFromCommit, verifyPackage, verifySelection, validatePackage } from './package.js';
export type { KnowledgePackage, KnowledgeSelection, PackageRequest } from './package.js';
export { captureKnowledge } from './local.js';
export { readKnowledgeSelection, selectableKnowledgeRecord } from './selection.js';
export type { KnowledgeSnapshot, KnowledgeOptions } from './local.js';
export { openKnowledgeView } from './view.js';
export type { KnowledgeCitation } from './view.js';
