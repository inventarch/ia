import { CONDITION_AXES, SHAPE_ROWS, valuesFor } from '@ia/language';
import type { ConditionAxis, Kind, Lane, Predicate } from '@ia/language';
import { GraphUsageError, validateCoordinate } from '@ia/graph';
import type { Coordinate } from '@ia/graph';
import { defaultClassifier } from './classify.js';
import type { Classifier, Shape } from './classify.js';
import { RuntimeError } from './errors.js';

export type AxisSource = 'declared' | 'profile' | 'derived' | 'absent';
/** Host-schema metadata from the native domains, not another vocabulary table. */
export const COORDINATE_DOMAINS = Object.freeze(
  Object.fromEntries(CONDITION_AXES.map((axis) => [axis, Object.freeze([...valuesFor(axis)!])])) as Record<
    ConditionAxis,
    readonly string[]
  >,
);
export interface CoordinateOptions {
  readonly profile?: Coordinate;
  readonly classifier?: Classifier;
}
export interface PreparedCoordinate {
  readonly values: Coordinate;
  readonly sources: Readonly<Record<ConditionAxis, AxisSource>>;
  readonly focus: {
    readonly kinds: readonly Kind[];
    readonly lanes: readonly Lane[];
    readonly predicates: readonly Predicate[];
  };
}
export function prepareCoordinate(
  text: string,
  input: Readonly<Record<string, unknown>>,
  options: CoordinateOptions = {},
): PreparedCoordinate {
  if (typeof text !== 'string') throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', 'Request text must be a string');
  const declared = validateCoordinate(input),
    profile = validateCoordinate(options.profile ?? {});
  if (profile.phase !== undefined || profile.primitive !== undefined)
    throw new RuntimeError(
      'IA-RUNTIME-REQUEST-INVALID',
      'Phase and primitive must be declared on the request, not in its profile',
    );
  const values: Partial<Record<ConditionAxis, string>> = { ...profile, ...declared };
  const sources = Object.fromEntries(
    CONDITION_AXES.map((axis) => [
      axis,
      declared[axis] !== undefined ? 'declared' : profile[axis] !== undefined ? 'profile' : 'absent',
    ]),
  ) as Record<ConditionAxis, AxisSource>;
  if (values.shape === undefined) {
    const shape = (options.classifier ?? defaultClassifier).classify(text);
    if (typeof shape !== 'string')
      throw new GraphUsageError(
        'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
        `Classifier must return one of ${Object.keys(SHAPE_ROWS).join(', ')}`,
      );
    values.shape = validateCoordinate({ shape }).shape!;
    sources.shape = 'derived';
  }
  const row = SHAPE_ROWS[values.shape as Shape];
  if (values.category === undefined) {
    values.category = row.category;
    sources.category = 'derived';
  }
  return Object.freeze({
    values: Object.freeze(values),
    sources: Object.freeze(sources),
    focus: Object.freeze({
      kinds: Object.freeze([...row.kinds]),
      lanes: Object.freeze([...row.lanes]),
      predicates: Object.freeze([...row.predicates]),
    }),
  });
}
