import { INVERSE_OF } from '@inventarch/language';
import type { Predicate } from '@inventarch/language';
import { snapshot } from './immutable.js';
import type { Edge, EdgeAssertion, Graph } from './types.js';

/**
 * One row of an identity's derived directed view (G14). `direction` is relative to the viewed identity; `other` is the
 * counterpart (null when the authored target did not resolve); `declaredOn` is the record whose source holds the row.
 * `kind: 'edge'` is a row the viewed record declared, in the spelling it wrote; `'inverse'` is the counterpart's
 * declared row seen from this end; `'field-ref'` is a typed field reference (G06a), held (`out`) or naming it (`in`).
 * A field reference has no predicate. `derived` marks a row this record did not declare: never authoritative over the
 * declared row it is read from.
 */
export interface DirectedRow {
  readonly predicate: Predicate | null;
  readonly direction: 'out' | 'in';
  readonly spelling: string;
  readonly declaredOn: string;
  readonly other: string | null;
  readonly kind: 'edge' | 'inverse' | 'field-ref';
  readonly derived: boolean;
  /**
   * Whether the row may be followed under the consent rule: a resolved edge was admitted by G07 (or is the S07
   * structural ground), a field reference needs no consent (G06a), and a dangling row has no counterpart to consent.
   */
  readonly consented: boolean;
  readonly source: { readonly path: string; readonly line: number };
}

/**
 * The spelling a derived inverse is read in: the canonical form of the direction opposite to the one its author
 * wrote. An active-direction assertion (`cites`, `cite`) reads `cited-by` from its target; an inverse one (`cited-by`)
 * reads as the bare predicate (`cite`) from the other end.
 */
export function counterpartSpelling(predicate: Predicate, authored: EdgeAssertion['direction']): string {
  return authored === 'out' ? INVERSE_OF.get(predicate)! : predicate;
}

const consented = (other: string | null): boolean => other !== null;
const at = (source: { readonly path: string; readonly line: number }) => ({ path: source.path, line: source.line });
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const nullable = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(a, b);
const KIND_ORDER = { edge: 0, inverse: 1, 'field-ref': 2 } as const;
/** Total over predicate (field references last), direction, counterpart, declarer, source, kind and spelling. */
const rowOrder = (a: DirectedRow, b: DirectedRow): number =>
  nullable(a.predicate, b.predicate) ||
  compare(a.direction, b.direction) ||
  nullable(a.other, b.other) ||
  compare(a.declaredOn, b.declaredOn) ||
  compare(a.source.path, b.source.path) ||
  a.source.line - b.source.line ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  compare(a.spelling, b.spelling);

/** The rows one end of `edge` reads: `side` is that end (`out` = `from`, `in` = `to`). */
function edgeRows(edge: Edge, side: 'out' | 'in'): DirectedRow[] {
  const other = side === 'out' ? edge.to : edge.from;
  // An assertion's direction names its author's end: `out` is written on `from`, `in` on `to` (G06).
  const own = edge.assertions.filter((assertion) => assertion.direction === side);
  if (own.length > 0)
    return own.map((assertion) => ({
      predicate: edge.predicate,
      direction: side,
      spelling: assertion.spelling,
      declaredOn: assertion.author,
      other,
      kind: 'edge',
      derived: false,
      consented: consented(other),
      source: at(assertion.source),
    }));
  const declaring = edge.assertions
    .filter((assertion) => assertion.direction !== side)
    .sort((a, b) => compare(a.source.path, b.source.path) || a.source.line - b.source.line)[0];
  if (declaring === undefined) return [];
  return [
    {
      predicate: edge.predicate,
      direction: side,
      spelling: counterpartSpelling(edge.predicate, declaring.direction),
      declaredOn: declaring.author,
      other,
      kind: 'inverse',
      derived: true,
      consented: consented(other),
      source: at(declaring.source),
    },
  ];
}

/**
 * G14: every row touching `identity`, labelled by who declared it. Computed from the graph's own edges and field
 * references on each call; it adds no adjacency, changes no edge and is empty for an identity nothing touches.
 */
export function directedView(graph: Graph, identity: string): readonly DirectedRow[] {
  // Each end reads its own adjacency map: a row a record declares on itself sits in both, as separate copies.
  const rows: DirectedRow[] = [];
  for (const side of ['out', 'in'] as const)
    for (const list of (side === 'out' ? graph.out : graph.in).get(identity)?.values() ?? [])
      for (const edge of list) rows.push(...edgeRows(edge, side));
  for (const reference of graph.references)
    if (reference.from === identity)
      rows.push({
        predicate: null,
        direction: 'out',
        spelling: reference.field,
        declaredOn: identity,
        other: reference.to,
        kind: 'field-ref',
        derived: false,
        consented: true,
        source: at(reference.source),
      });
  for (const reference of graph.referencedBy.get(identity) ?? [])
    rows.push({
      predicate: null,
      direction: 'in',
      spelling: reference.field,
      declaredOn: reference.from,
      other: reference.from,
      kind: 'field-ref',
      derived: true,
      consented: true,
      source: at(reference.source),
    });
  return snapshot(rows.sort(rowOrder));
}
