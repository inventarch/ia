import type { ChildNode, RecordNode } from '../ast.js';
import { diag, pushAll } from '../diagnostics.js';
import type { Diagnostic } from '../diagnostics.js';
import { REQUIREMENT_KINDS } from './types.js';

/** Forbidden positions only. Specialized semantic readers own their complete carriers. */
export function misplacedIn(children: readonly ChildNode[], path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stack: { readonly nodes: readonly ChildNode[]; index: number }[] = [{ nodes: children, index: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.index >= top.nodes.length) {
      stack.pop();
      continue;
    }
    const child = top.nodes[top.index++]!;
    if (child.kind !== 'field') continue;
    if (child.when !== undefined || child.words[0] === 'when') {
      diagnostics.push(
        diag('IA-LANG-CONDITION-MISPLACED', path, child.span.line, 'Conditions are not permitted in this position.', {
          endLine: child.span.endLine,
        }),
      );
    } else if (child.children.length > 0) {
      stack.push({ nodes: child.children, index: 0 });
    }
  }
  return diagnostics;
}

export function misplacedConditions(record: RecordNode, path: string): readonly Diagnostic[] {
  // Registry extraction owns the complete schema dialect and the system declaration dialect.
  if (record.discriminator === 'schema') return [];
  const head = record.head.filter(
    (field) =>
      !(record.discriminator === 'contract' && field.key === 'binds' && field.value.kind === 'string') &&
      !(record.discriminator === 'case' && field.words[0] === 'verdict'),
  );
  const diagnostics = record.discriminator === 'system' ? [] : misplacedIn(head, path);
  const semanticSections: readonly string[] = ['activation', 'cognition', 'relationships', 'governance'];
  for (const section of record.sections) {
    if (semanticSections.includes(section.name)) continue;
    if (record.discriminator === 'system' && ['discriminators', 'requires', 'edges'].includes(section.name)) continue;
    if (record.discriminator === 'contract' && (REQUIREMENT_KINDS as readonly string[]).includes(section.name))
      continue;
    if (record.discriminator === 'contract' && section.name === 'schema') continue;
    if (record.discriminator === 'case' && ['scenario', 'verdict'].includes(section.name)) continue;
    if (section.name === 'when')
      diagnostics.push(
        diag('IA-LANG-CONDITION-MISPLACED', path, section.span.line, 'A section cannot be a condition.', {
          endLine: section.span.endLine,
        }),
      );
    else pushAll(diagnostics, misplacedIn(section.children, path));
  }
  return diagnostics;
}
