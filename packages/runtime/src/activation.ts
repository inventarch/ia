import { selectors } from '@inventarch/graph';
import type { Coordinate, Node } from '@inventarch/graph';

/**
 * A record's activation at a coordinate, read as graph `selectors` reads it (R04): `applying` when a group matches or
 * the record states none, `conditional` when no group is contradicted but none is decided because an axis it names is
 * unbound, `omitted` when every group is contradicted. `detail` names the undecided groups (`axis is value and ...`,
 * groups joined by `or`) for `conditional`, and the contradictory terms (`axis is value, request is other`) for
 * `omitted`.
 */
export type Activation =
  | { readonly status: 'applying' }
  | { readonly status: 'conditional' | 'omitted'; readonly detail: string };

export function activationAt(node: Node, values: Coordinate): Activation {
  const match = selectors(node, values);
  if (match.status === 'matched' || node.selectors.length === 0) return { status: 'applying' };
  if (match.status === 'disqualified') return { status: 'omitted', detail: contradictions(node, values) };
  const open = node.selectors
    .filter((group) => !group.some((t) => values[t.axis] !== undefined && values[t.axis] !== t.value))
    .map((group) => group.map((t) => `${t.axis} is ${t.value}`).join(' and '));
  return { status: 'conditional', detail: [...new Set(open)].join(' or ') };
}

/** The selector terms the coordinate contradicts, once each: `axis is value, request is other`, joined by `; `. */
export function contradictions(node: Node, values: Coordinate): string {
  const terms = node.selectors.flatMap((group) =>
    group
      .filter((t) => values[t.axis] !== undefined && values[t.axis] !== t.value)
      .map((t) => `${t.axis} is ${t.value}, request is ${values[t.axis]}`),
  );
  return [...new Set(terms)].join('; ');
}
