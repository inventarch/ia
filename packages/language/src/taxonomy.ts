// Closed constants are generated from schema-validated native kernel records.
import {
  KINDS,
  CATEGORIES,
  PREDICATE_PAIRS,
  PHASES,
  PRIMITIVES,
  MOVES,
  AXES,
  LANES,
  SHAPES,
  ARTIFACT_SETS,
  SEVERITIES,
  PROVENANCES,
  BANDS,
  PLACEMENT_KINDS,
  VALUE_TYPES,
  CARDINALITIES,
} from './kernel.generated.js';
export {
  KINDS,
  CATEGORIES,
  PREDICATE_PAIRS,
  PHASES,
  PRIMITIVES,
  MOVES,
  AXES,
  LANES,
  SHAPES,
  ARTIFACT_SETS,
  SEVERITIES,
  PROVENANCES,
  BANDS,
  PLACEMENT_KINDS,
  VALUE_TYPES,
  CARDINALITIES,
  BAND_OF,
  PRESENT_PHRASES,
  DIMENSION_PATHS,
  KIND_LANES,
  PRIMITIVE_ANCHORS,
  SHAPE_ROWS,
  KERNEL_DIGEST,
} from './kernel.generated.js';

export type Kind = (typeof KINDS)[number];

export type Category = (typeof CATEGORIES)[number];

/** The eighteen active predicates with their inverses; semantic/vocabulary adds exact present-tense phrases. */
export type Predicate = (typeof PREDICATE_PAIRS)[number][0];
export const PREDICATES: readonly Predicate[] = PREDICATE_PAIRS.map((pair) => pair[0]);
export const INVERSE_OF: ReadonlyMap<Predicate, string> = new Map(
  PREDICATE_PAIRS.map((pair) => [pair[0], pair[1]] as const),
);

export type Phase = (typeof PHASES)[number];
export type Primitive = (typeof PRIMITIVES)[number];
export type Move = (typeof MOVES)[number];
/** The nine routing axes a selector or condition may name (spec 5.3). */
export type Axis = (typeof AXES)[number];
export type Lane = (typeof LANES)[number];
export type Shape = (typeof SHAPES)[number];
export type ArtifactSet = (typeof ARTIFACT_SETS)[number];

export type Severity = (typeof SEVERITIES)[number];
export type Provenance = (typeof PROVENANCES)[number];

/** Authority bands (graph spec 3.3): the closed set and nothing else. */
export type Band = (typeof BANDS)[number];
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/** The kernel's value types for schema fields (spec 4.3) and the edge cardinalities. */
export type ValueType = (typeof VALUE_TYPES)[number];
export type Cardinality = (typeof CARDINALITIES)[number];
/** A schema field type: a value type, or `list of` one. */
export type FieldType = ValueType | `list of ${ValueType}`;
/**
 * The closed table of text forms a schema may require with `as text form <form>` (W0-L5). Language-owned, not a
 * kernel value type: adding a form changes this table and the compliance predicate for it, never the kernel.
 */
export const TEXT_FORMS = ['iso-date'] as const;
export type TextForm = (typeof TEXT_FORMS)[number];

function member<T extends string>(set: readonly T[]): (x: string) => x is T {
  return (x: string): x is T => (set as readonly string[]).includes(x);
}
export const isKind: (x: string) => x is Kind = member(KINDS);
export const isCategory: (x: string) => x is Category = member(CATEGORIES);
export const isPredicate: (x: string) => x is Predicate = member(PREDICATES);
export const isPhase: (x: string) => x is Phase = member(PHASES);
export const isPrimitive: (x: string) => x is Primitive = member(PRIMITIVES);
export const isMove: (x: string) => x is Move = member(MOVES);
export const isAxis: (x: string) => x is Axis = member(AXES);
export const isSeverity: (x: string) => x is Severity = member(SEVERITIES);
export const isProvenance: (x: string) => x is Provenance = member(PROVENANCES);
export const isPlacementKind: (x: string) => x is PlacementKind = member(PLACEMENT_KINDS);
export const isValueType: (x: string) => x is ValueType = member(VALUE_TYPES);
export const isCardinality: (x: string) => x is Cardinality = member(CARDINALITIES);
export const isTextForm: (x: string) => x is TextForm = member(TEXT_FORMS);
/** The `id` value rule (compliance C05): an ASCII letter, then letters, digits or hyphens. */
export const isId = (x: string): boolean => /^[A-Za-z][A-Za-z0-9-]*$/.test(x);
export function isBand(x: number): x is Band {
  return (BANDS as readonly number[]).includes(x);
}

/** The field type spelled by a run of words: `text`, or `list of text`. */
export function fieldTypeOf(words: readonly string[]): FieldType | undefined {
  const first = words[0];
  const third = words[2];
  if (words.length === 1 && first !== undefined && isValueType(first)) return first;
  if (words.length === 3 && first === 'list' && words[1] === 'of' && third !== undefined && isValueType(third))
    return `list of ${third}`;
  return undefined;
}
