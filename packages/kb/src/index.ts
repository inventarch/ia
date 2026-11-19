/** The plain name every package written now carries, beside `formatVersion` 1. */
export const KB_FORMAT = 'kb-package';
/** The literal packages carried before formats stopped carrying their version; still read, never written. */
export const LEGACY_KB_FORMAT = 'ia.kb.package.v1';
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
