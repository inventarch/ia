import {
  ARTIFACT_SETS,
  AXES,
  CATEGORIES,
  KINDS,
  LANES,
  MOVES,
  PHASES,
  PREDICATES,
  PREDICATE_PAIRS,
  PRESENT_PHRASES,
  PRIMITIVES,
  PROVENANCES,
  SEVERITIES,
  SHAPES,
} from '../taxonomy.js';
import type { Predicate } from '../taxonomy.js';
import type { ConditionAxis } from './types.js';

export const CONDITION_AXES: readonly ConditionAxis[] = [...AXES, 'severity', 'provenance'];
const values = new Map<string, readonly string[]>([
  ['shape', SHAPES],
  ['category', CATEGORIES],
  ['phase', PHASES],
  ['primitive', PRIMITIVES],
  ['move', MOVES],
  ['kind', KINDS],
  ['lane', LANES],
  ['predicate', PREDICATES],
  ['artifact-set', ARTIFACT_SETS],
  ['severity', SEVERITIES],
  ['provenance', PROVENANCES],
]);

export function valuesFor(axis: string): readonly string[] | undefined {
  return values.get(axis);
}
export function canonicalValue(axis: string, value: string): string | undefined {
  return values.get(axis)?.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
}

export interface Verb {
  readonly predicate: Predicate;
  readonly direction: 'out' | 'in';
}
const verbs = new Map<string, Verb>();
for (const [predicate, inverse] of PREDICATE_PAIRS) {
  verbs.set(predicate, Object.freeze({ predicate, direction: 'out' }));
  verbs.set(inverse, Object.freeze({ predicate, direction: 'in' }));
}
for (const [index, phrase] of PRESENT_PHRASES.entries())
  verbs.set(phrase, Object.freeze({ predicate: PREDICATE_PAIRS[index]![0], direction: 'out' }));
export const VERB_PHRASES: readonly string[] = Object.freeze([...verbs.keys()]);
export function verbOf(phrase: string): Verb | undefined {
  return verbs.get(phrase);
}
