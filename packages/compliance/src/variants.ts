import { CONDITION_AXES, valuesFor } from '@ia/language';
import type { ConditionAxis, Variant } from '@ia/language';
import { conditionHolds } from '@ia/graph';
import type { Coordinate, Node } from '@ia/graph';
import { finding } from './graph-checks.js';
import { assess } from './types.js';
import type { Assessment, Finding } from './types.js';

type Value = string | undefined;
type Cube = ReadonlyMap<ConditionAxis, readonly Value[]>;
function constraint(variant: Variant, node: Node): Cube | undefined {
  const cube = new Map<ConditionAxis, readonly Value[]>();
  for (const term of variant.condition ?? []) {
    if (term.axis === 'provenance' || term.axis === 'artifact-set') {
      if (!conditionHolds([term], node.dimensions, {})) return undefined;
    } else if (term.axis === 'severity') {
      const values = [undefined, ...valuesFor('severity')!].filter((value) =>
        conditionHolds([term], node.dimensions, value === undefined ? {} : { severity: value }),
      );
      if (values.length === 0) return undefined;
      cube.set('severity', values);
    } else cube.set(term.axis, [term.value]);
  }
  return cube;
}
const intersects = (a: readonly Value[], b: readonly Value[]): boolean => a.some((value) => b.includes(value));

/** Find a point in base outside the union of stronger clause cubes. Each split
 * strictly reduces a finite domain; no Cartesian-product allocation or cutoff. */
function uncovered(base: Cube, stronger: readonly Cube[]): Coordinate | undefined {
  const overlaps = stronger.filter((cube) => [...cube].every(([axis, values]) => intersects(base.get(axis)!, values)));
  if (overlaps.length === 0)
    return Object.freeze(
      Object.fromEntries(
        [...base].filter(([, values]) => values[0] !== undefined).map(([axis, values]) => [axis, values[0]]),
      ),
    );
  if (
    overlaps.some((cube) =>
      [...cube].every(([axis, values]) => base.get(axis)!.every((value) => values.includes(value))),
    )
  )
    return undefined;
  for (const [axis, values] of overlaps[0]!) {
    const domain = base.get(axis)!;
    const inside = domain.filter((value) => values.includes(value)),
      outside = domain.filter((value) => !values.includes(value));
    if (inside.length === 0 || outside.length === 0) continue;
    for (const part of [outside, inside]) {
      const narrowed = new Map(base);
      narrowed.set(axis, part);
      const witness = uncovered(narrowed, overlaps);
      if (witness !== undefined) return witness;
    }
    return undefined;
  }
  throw new Error('Finite ambiguity search failed to refine an overlapping region');
}
export function validateVariants(node: Node): Assessment {
  const families = new Map<string, Variant[]>(),
    findings: Finding[] = [];
  for (const variant of node.variants) {
    const group = families.get(variant.key) ?? [];
    group.push(variant);
    families.set(variant.key, group);
  }
  for (const [key, family] of [...families].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const clauses = family
      .map((variant) => ({ variant, cube: constraint(variant, node), specificity: variant.condition?.length ?? 0 }))
      .filter((entry): entry is typeof entry & { cube: Cube } => entry.cube !== undefined)
      .sort((a, b) => a.variant.span.line - b.variant.span.line);
    const axes = CONDITION_AXES.filter((axis) => clauses.some((clause) => clause.cube.has(axis)));
    let found = false;
    for (let i = 0; i < clauses.length && !found; i++)
      for (let j = i + 1; j < clauses.length && !found; j++) {
        const a = clauses[i]!,
          b = clauses[j]!;
        if (a.specificity !== b.specificity) continue;
        const base = new Map<ConditionAxis, readonly Value[]>(
          axes.map((axis) => [
            axis,
            [undefined, ...valuesFor(axis)!].filter(
              (value) => (a.cube.get(axis)?.includes(value) ?? true) && (b.cube.get(axis)?.includes(value) ?? true),
            ),
          ]),
        );
        if ([...base.values()].some((values) => values.length === 0)) continue;
        const witness = uncovered(
          base,
          clauses.filter((clause) => clause.specificity > a.specificity).map((clause) => clause.cube),
        );
        if (witness === undefined) continue;
        findings.push(
          finding(
            'IA-COMP-VARIANT-AMBIGUOUS',
            node,
            `${key} ties at maximum specificity ${a.specificity} between lines ${a.variant.span.line} and ${b.variant.span.line}; coordinate ${JSON.stringify(witness)}`,
            a.variant.span.line,
          ),
        );
        found = true;
      }
  }
  return assess('COMP-VARIANT', node.identity, findings);
}
