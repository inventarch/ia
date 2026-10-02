import type { ChildNode, FileNode, RecordNode, Span, Value } from './ast.js';
import { targetOf, verbPrefix } from './semantic/edges.js';
import type { EdgeReference } from './semantic/types.js';

export interface TypedReference {
  readonly reference: EdgeReference;
  readonly record: RecordNode;
  readonly span: Span;
  readonly field: string;
  readonly section?: string;
  readonly use: 'value' | 'relationship';
  /** Index among typed references in this authored value, including repeated targets. */
  readonly index: number;
}

/** Typed uses, not graph adjacency. The AST is the sole authority for reference syntax. */
export function references(ast: FileNode): readonly TypedReference[] {
  const result: TypedReference[] = [];
  const valueRefs = (value: Value): readonly EdgeReference[] =>
    value.kind === 'ref'
      ? [value]
      : value.kind === 'list'
        ? value.items.filter((item): item is Extract<Value, { kind: 'ref' }> => item.kind === 'ref')
        : [];
  const visit = (children: readonly ChildNode[], record: RecordNode, section?: string): void => {
    for (const child of children) {
      if (child.kind === 'record') {
        recordRefs(child);
        continue;
      }
      const verb = child.kind === 'field' && section === 'relationships' ? verbPrefix(child.words) : undefined;
      const target = child.kind === 'field' && verb !== undefined ? targetOf(child, verb.length) : undefined;
      const refs = target === undefined ? valueRefs(child.value) : [target];
      refs.forEach((reference, index) =>
        result.push({
          reference,
          record,
          span: child.span,
          field: child.kind === 'field' ? child.key : '-',
          ...(section === undefined ? {} : { section }),
          use: target === undefined ? 'value' : 'relationship',
          index,
        }),
      );
      if (child.kind === 'field') visit(child.children, record, section);
    }
  };
  const recordRefs = (record: RecordNode): void => {
    visit(record.head, record);
    for (const section of record.sections) visit(section.children, record, section.name);
  };
  ast.records.forEach(recordRefs);
  return result;
}
