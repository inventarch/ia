export { GRAPH_CODES, GraphUsageError } from './diagnostics.js';
export type { GraphCode, GraphDiagnostic } from './diagnostics.js';
export { canonicalRoot, reaches } from './paths.js';
export { stableSerialize, recordDigest, revisionOf } from './revision.js';
export type { RevisionInputs, RevisionSource } from './revision.js';
export { CodecError, canonical, copy, digest } from './codec.js';
export type { Json } from './codec.js';
export { validateCoordinate, dimensionsOf } from './coordinate.js';
export type { Coordinate, Dimensions } from './coordinate.js';
export { load, serialize } from './load.js';
export { resolve } from './resolve.js';
export type { Resolution } from './resolve.js';
export type {
  CellRef,
  CellSelection,
  Claim,
  Edge,
  EdgeAssertion,
  FieldReference,
  Graph,
  LoadOptions,
  Node,
  Occurrence,
  Shadow,
  Tie,
} from './types.js';
export { cell, conditionHolds, effectiveSeverity, selectors, variants } from './queries.js';
export type { SelectorMatch, VariantSelection } from './queries.js';
export { CLAIM_FIELDS, claimants, isSelection, selects } from './claims.js';
export type { ClaimMatch, Claimant } from './claims.js';
export { directedView } from './directed.js';
export type { DirectedEdgeRow, DirectedFieldRow, DirectedRow } from './directed.js';
export { traverse } from './traverse.js';
export type { Traversal, TraverseOptions, Via, WalkNode } from './traverse.js';
export { fold, tokenize, search } from './text.js';
export type { TextIndex, SearchHit } from './text.js';
