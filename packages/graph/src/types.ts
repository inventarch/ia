import type {
  Band,
  Cell,
  CompiledRecord,
  CompiledValue,
  EdgeReference,
  FrozenRegistry,
  Phase,
  Predicate,
  Span,
  Term,
} from '@inventarch/language';
import type { Dimensions } from './coordinate.js';
import type { GraphDiagnostic } from './diagnostics.js';
import type { RevisionInputs } from './revision.js';
import type { TextIndex } from './text.js';

export interface Node extends CompiledRecord {
  readonly band: Band;
  readonly reach: string;
  readonly dimensions: Dimensions;
  /** G13: `recordDigest` over this record's own source lines; it moves only when that text changes. */
  readonly digest: string;
}
export interface Occurrence {
  readonly key: string;
  readonly node: Node;
  readonly status: 'inactive' | 'refused' | 'winner' | 'shadowed' | 'tied' | 'blocked';
  readonly shadowedBy?: string;
}
export interface Shadow {
  readonly identity: string;
  readonly winner: string;
  readonly shadowed: string;
}
export interface Tie {
  readonly identity: string;
  readonly band: Band;
  readonly occurrences: readonly string[];
}
export interface EdgeAssertion {
  readonly author: string;
  readonly direction: 'out' | 'in';
  /** The verb as the author wrote it (`CompiledEdge.spelling`); the edge's `from`/`to` stay normalized to the active direction. */
  readonly spelling: string;
  readonly reference: EdgeReference;
  readonly source: { readonly path: string; readonly line: number; readonly endLine: number };
}
export interface Edge {
  readonly from: string | null;
  readonly predicate: Predicate;
  readonly to: string | null;
  readonly author: string;
  readonly reference: EdgeReference;
  readonly fragment?: string;
  readonly fragmentEndpoint?: 'from' | 'to';
  readonly condition?: readonly Term[];
  readonly conditionSubject: string;
  readonly source: EdgeAssertion['source'];
  readonly assertions: readonly EdgeAssertion[];
}
/**
 * A resolved typed ref value held in a record field (G06a): `field` is the compiler's field path, `head.steward`,
 * `composition.mandate`, `binding.target`, or the bare section name for a section-level `- @word name` item.
 * Derived only: it is not an Edge, carries no predicate and is never consent- or cardinality-checked.
 */
export interface FieldReference {
  readonly from: string;
  readonly to: string;
  readonly field: string;
  readonly reference: Extract<CompiledValue, { kind: 'ref' }>;
  readonly source: { readonly path: string; readonly line: number; readonly endLine: number };
}
export interface CellRef {
  readonly identity: string;
  readonly primary: boolean;
  readonly span: Span;
}
export interface LoadOptions extends RevisionInputs {
  readonly location: string;
  readonly phase?: Phase;
}
export interface Graph {
  readonly text: TextIndex;
  readonly revision: string;
  readonly location: string;
  readonly phase?: Phase;
  readonly registry: FrozenRegistry;
  readonly nodes: ReadonlyMap<string, Node>;
  readonly occurrences: readonly Occurrence[];
  readonly shadows: readonly Shadow[];
  readonly ties: readonly Tie[];
  readonly diagnostics: readonly GraphDiagnostic[];
  readonly edges: readonly Edge[];
  readonly out: ReadonlyMap<string, ReadonlyMap<Predicate, readonly Edge[]>>;
  readonly in: ReadonlyMap<string, ReadonlyMap<Predicate, readonly Edge[]>>;
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly byDiscriminator: ReadonlyMap<string, readonly string[]>;
  readonly byKind: ReadonlyMap<string, readonly string[]>;
  readonly bySystem: ReadonlyMap<string, readonly string[]>;
  readonly byCategory: ReadonlyMap<string, readonly string[]>;
  readonly byLane: ReadonlyMap<string, readonly string[]>;
  readonly byArtifactSet: ReadonlyMap<string, readonly string[]>;
  readonly cells: ReadonlyMap<string, readonly CellRef[]>;
  readonly selectors: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly conditions: ReadonlyMap<string, readonly string[]>;
  readonly dangling: readonly Edge[];
  readonly byDanglingReference: ReadonlyMap<string, readonly Edge[]>;
  /** G06a: resolved typed field refs, disjoint from `edges`; `in`, `out` and every edge count ignore them. */
  readonly references: readonly FieldReference[];
  /** `references` keyed by target identity, each list in `references` order. */
  readonly referencedBy: ReadonlyMap<string, readonly FieldReference[]>;
}
export interface CellSelection {
  readonly kind: 'exact' | 'primary';
  readonly cell: Cell;
}
