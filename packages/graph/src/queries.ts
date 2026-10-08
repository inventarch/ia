import { KIND_LANES, SEVERITIES } from '@inventarch/language';
import type { CompiledRecord, Lane, Term, Variant } from '@inventarch/language';
import { validateCoordinate } from './coordinate.js';
import type { Coordinate, Dimensions } from './coordinate.js';
import { graphDiagnostic } from './diagnostics.js';
import type { GraphDiagnostic } from './diagnostics.js';
import { snapshot } from './immutable.js';
import { compare } from './revision.js';
import type { CellSelection, Node } from './types.js';

/** G05: a record's lane, the kernel's lane for its kind, except that a contract of facet `authority` is `authority`. */
export function laneOf(record: Pick<CompiledRecord, 'kind' | 'facet'>): Lane {
  return record.kind === 'contract' && record.facet === 'authority' ? 'authority' : KIND_LANES[record.kind];
}

/** Both severity sources can raise the stakes; the native list is strongest first. */
export function effectiveSeverity(subject: Dimensions, coordinate: Coordinate): string | undefined {
  const request = validateCoordinate(coordinate).severity;
  return SEVERITIES.find((value) => value === subject.severity || value === request);
}

export function conditionHolds(
  condition: readonly Term[] | undefined,
  subject: Dimensions,
  input: Coordinate,
): boolean {
  const coordinate = validateCoordinate(input);
  return (condition ?? []).every(({ axis, value }) => {
    const actual =
      axis === 'severity'
        ? effectiveSeverity(subject, coordinate)
        : axis === 'provenance'
          ? subject.provenance
          : axis === 'artifact-set'
            ? subject.artifactSet
            : coordinate[axis];
    return actual === value;
  });
}

export interface SelectorMatch {
  readonly status: 'matched' | 'neutral' | 'disqualified';
  readonly specificity: number;
}
export function selectors(record: Node, input: Coordinate): SelectorMatch {
  const coordinate = validateCoordinate(input);
  let specificity = -1,
    neutral = record.selectors.length === 0;
  for (const group of record.selectors) {
    if (group.some((term) => coordinate[term.axis] !== undefined && coordinate[term.axis] !== term.value)) continue;
    if (group.every((term) => coordinate[term.axis] === term.value)) specificity = Math.max(specificity, group.length);
    else neutral = true;
  }
  return Object.freeze(
    specificity >= 0
      ? { status: 'matched', specificity }
      : { status: neutral ? 'neutral' : 'disqualified', specificity: 0 },
  );
}

export interface VariantSelection {
  readonly selected: ReadonlyMap<string, Variant>;
  readonly diagnostics: readonly GraphDiagnostic[];
}
export function variants(record: Node, input: Coordinate): VariantSelection {
  const coordinate = validateCoordinate(input),
    families = new Map<string, Variant[]>();
  for (const variant of record.variants) {
    if (!conditionHolds(variant.condition, record.dimensions, coordinate)) continue;
    const group = families.get(variant.key) ?? [];
    group.push(variant);
    families.set(variant.key, group);
  }
  const selected = new Map<string, Variant>(),
    diagnostics: GraphDiagnostic[] = [];
  for (const [key, family] of [...families].sort(([a], [b]) => compare(a, b))) {
    const maximum = Math.max(...family.map((v) => v.condition?.length ?? 0));
    const best = family.filter((v) => (v.condition?.length ?? 0) === maximum).sort((a, b) => a.span.line - b.span.line);
    if (best.length === 1) selected.set(key, best[0]!);
    else
      diagnostics.push(
        graphDiagnostic(
          'IA-GRAPH-VARIANT-AMBIGUOUS',
          record.source.path,
          best[0]!.span.line,
          `${record.identity}: ${key} has equal maximum specificity ${maximum} at lines ${best.map((v) => v.span.line).join(', ')}`,
        ),
      );
  }
  return snapshot({ selected, diagnostics });
}

export function cell(record: Node, input: Coordinate): CellSelection | undefined {
  const coordinate = validateCoordinate(input);
  if (coordinate.phase === undefined || coordinate.primitive === undefined) return undefined;
  const applicable = record.cells.filter(
    (c) => c.phase === coordinate.phase && conditionHolds(c.condition, record.dimensions, coordinate),
  );
  const exact = applicable.find((c) => c.primitive === coordinate.primitive);
  if (exact !== undefined) return snapshot({ kind: 'exact' as const, cell: exact });
  const primary = applicable.find((c) => c.primary);
  return primary === undefined ? undefined : snapshot({ kind: 'primary' as const, cell: primary });
}
