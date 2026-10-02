import { REQUIREMENT_KINDS } from '@ia/language';
import type { CompiledChild, CompiledValue, Variant } from '@ia/language';
import { conditionHolds } from '@ia/graph';
import type { Coordinate, Node } from '@ia/graph';
import type { Clause } from './types.js';

export function valueText(value: CompiledValue): string {
  switch (value.kind) {
    case 'scalar':
    case 'string':
    case 'prose':
      return value.text;
    case 'ref':
      return `@${value.discriminator} ${value.name}${value.fragment === undefined ? '' : '#' + value.fragment}`;
    case 'list':
      return '[' + value.items.map(valueText).join(', ') + ']';
    case 'none':
    case 'block':
      return '';
  }
}
function childrenText(children: readonly CompiledChild[]): string {
  return children
    .filter((child) => !('key' in child) || child.key !== 'when')
    .map((child) => {
      if ('item' in child) return '- ' + valueText(child.item);
      return [child.key, valueText(child.value), ...(child.fields === undefined ? [] : [childrenText(child.fields)])]
        .filter(Boolean)
        .join(' ');
    })
    .join('\n');
}
/** The record's `says` and `answers`, rendered as recordText renders its meaning, or undefined when it has neither. */
export function purposeOf(node: Node): string | undefined {
  const fields = node.sections
    .filter((s) => s.name === 'meaning')
    .flatMap((s) => s.fields)
    .filter((f) => 'key' in f && (f.key === 'says' || f.key === 'answers'));
  return fields.length === 0 ? undefined : childrenText(fields);
}
export function clausesOf(node: Node, selected: ReadonlyMap<string, Variant>): readonly Clause[] {
  return [...selected.values()].map((variant) => {
    const field = node.sections
      .filter((s) => s.name === 'governance')
      .flatMap((s) => s.fields)
      .find((f) => 'key' in f && f.key === variant.key && f.span.line === variant.span.line);
    const text = [
      valueText(variant.value),
      ...(field !== undefined && 'fields' in field && field.fields !== undefined ? [childrenText(field.fields)] : []),
    ]
      .filter(Boolean)
      .join('\n');
    return {
      key: variant.key,
      text,
      ...(variant.condition === undefined ? {} : { condition: variant.condition }),
      citation: { path: node.source.path, ...variant.span },
    };
  });
}
export function recordText(node: Node, coordinate: Coordinate, clauses: readonly Clause[]): string {
  const semanticSections = new Set([
    'cognition',
    'activation',
    'relationships',
    'governance',
    ...(node.requirements.length === 0 ? [] : REQUIREMENT_KINDS),
  ]);
  return [
    `@${node.discriminator} ${node.displayName}`,
    childrenText(node.head),
    ...node.sections.filter((s) => !semanticSections.has(s.name)).map((s) => `${s.name}\n${childrenText(s.fields)}`),
    ...clauses.map((c) => `${c.key}: ${c.text}`),
    ...node.requirements
      .filter((r) => conditionHolds(r.condition, node.dimensions, coordinate))
      .map((r) => `${r.id}: ${r.text}`),
  ]
    .filter(Boolean)
    .join('\n');
}
