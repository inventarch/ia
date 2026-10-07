import { INVERSE_OF } from '@inventarch/language';
import type { Predicate, Term } from '@inventarch/language';
import { snapshot } from './immutable.js';
import { compare, stableSerialize } from './revision.js';
import type { Edge, EdgeAssertion, Graph } from './types.js';

interface DirectedRowBase {
  /** The side the viewed record reads the row from: `out` when it is the active source, `in` when the active target. */
  readonly direction: 'out' | 'in';
  /** The other endpoint, always an admitted winner: a dangling or consent-refused assertion is a finding, not a row. */
  readonly counterpart: string;
  /** The record whose text states the row: the viewed record or its counterpart. */
  readonly declaredOn: string;
  /** Where `declaredOn` states it: the assertion's lines, or the line of the field holding the ref. */
  readonly source: EdgeAssertion['source'];
}
/**
 * G06b: one edge assertion read from one endpoint. `edge` is the declaration of the viewed record itself, in the verb
 * its author wrote; `inverse` is the counterpart's declaration read from this side in the kernel's spelling for it,
 * the active predicate at the source and its `INVERSE_OF` spelling at the target. Only `edge` rows are declared.
 */
export interface DirectedEdgeRow extends DirectedRowBase {
  readonly kind: 'edge' | 'inverse';
  /** True exactly for `inverse`: a view over the counterpart's declaration, never authoritative over it. */
  readonly derived: boolean;
  readonly predicate: Predicate;
  readonly spelling: string;
  /** Which active endpoint declared the assertion, whichever side reads it: `declared by source` or `by target`. */
  readonly declaredBy: 'source' | 'target';
  /** The edge's fragment, on the record its declaration references: an `edge` row's counterpart, an `inverse` row's own record. */
  readonly fragment?: string;
  readonly condition?: readonly Term[];
}
/** G06b: one G06a typed field reference read from one end; `field` is the holder's field path, `declaredOn` the holder. */
export interface DirectedFieldRow extends DirectedRowBase {
  readonly kind: 'field-ref';
  readonly derived: true;
  readonly field: string;
}
export type DirectedRow = DirectedEdgeRow | DirectedFieldRow;

const KINDS: readonly DirectedRow['kind'][] = ['edge', 'inverse', 'field-ref'];
const DIRECTIONS: readonly DirectedRow['direction'][] = ['out', 'in'];
const rowOrder = (a: DirectedRow, b: DirectedRow): number =>
  KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
  DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction) ||
  compare('predicate' in a ? a.predicate : a.field, 'predicate' in b ? b.predicate : b.field) ||
  compare(a.counterpart, b.counterpart) ||
  compare(a.declaredOn, b.declaredOn) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line ||
  compare(stableSerialize(a), stableSerialize(b));

/**
 * G06b: every row the graph holds at `identity`, read from its side. Each assertion of an edge it is an endpoint of
 * gives one row per side it occupies (both sides of a self-relation), so an edge asserted from both ends keeps both
 * declarations; each G06a field reference it holds or is named by gives one `field-ref` row. Derived on read from the
 * load-time `out`, `in`, `referencesFrom` and `referencedBy` indexes, so no call scans the graph; it adds no index,
 * diagnostic or revision input. An identity that is not an admitted winner has no rows.
 */
export function directedView(graph: Graph, identity: string): readonly DirectedRow[] {
  const rows: DirectedRow[] = [];
  const read = (edge: Edge, direction: 'out' | 'in'): void => {
    const counterpart = direction === 'out' ? edge.to : edge.from;
    if (counterpart === null) return;
    for (const assertion of edge.assertions) {
      // An author always stands at the active endpoint its spelling names: `out` at the source, `in` at the target.
      const declared = assertion.direction === direction;
      rows.push({
        kind: declared ? 'edge' : 'inverse',
        derived: !declared,
        direction,
        predicate: edge.predicate,
        spelling: declared
          ? assertion.spelling
          : direction === 'out'
            ? edge.predicate
            : INVERSE_OF.get(edge.predicate)!,
        declaredBy: assertion.direction === 'out' ? 'source' : 'target',
        declaredOn: assertion.author,
        counterpart,
        source: assertion.source,
        ...(edge.fragment === undefined ? {} : { fragment: edge.fragment }),
        ...(edge.condition === undefined ? {} : { condition: edge.condition }),
      });
    }
  };
  if (graph.nodes.has(identity)) {
    for (const edges of graph.out.get(identity)?.values() ?? []) for (const edge of edges) read(edge, 'out');
    for (const edges of graph.in.get(identity)?.values() ?? []) for (const edge of edges) read(edge, 'in');
    for (const reference of graph.referencesFrom.get(identity) ?? [])
      rows.push({
        kind: 'field-ref',
        derived: true,
        direction: 'out',
        field: reference.field,
        counterpart: reference.to,
        declaredOn: identity,
        source: reference.source,
      });
    for (const reference of graph.referencedBy.get(identity) ?? [])
      rows.push({
        kind: 'field-ref',
        derived: true,
        direction: 'in',
        field: reference.field,
        counterpart: reference.from,
        declaredOn: reference.from,
        source: reference.source,
      });
  }
  return snapshot(rows.sort(rowOrder));
}
