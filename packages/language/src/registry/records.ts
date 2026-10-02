import type { ChildNode, FieldNode, FileNode, RecordNode } from '../ast.js';
import type { Diagnostic } from '../diagnostics.js';

export interface RecordSource {
  readonly record: RecordNode;
  /** Structural boundary, including trailing refused lines omitted by the accepted AST span. */
  readonly endLine: number;
  /** Parser errors owned by this record, excluding its nested declarations. */
  readonly errors: readonly Diagnostic[];
}

/** Every record once in source order, with its own parser faults. Structural children alias `nested`. */
export function recordsIn(ast: FileNode, parserDiagnostics: readonly Diagnostic[]): readonly RecordSource[] {
  const errors = parserDiagnostics.filter((d) => d.path === ast.path && d.severity === 'error');
  const fileEnd = Math.max(1, ...ast.records.map((r) => r.span.endLine), ...errors.map((d) => d.endLine ?? d.line));
  const limits = recordLimits(ast.records, fileEnd);
  if (ast.syntaxRecordSpans !== undefined) {
    const ends = new Map(ast.syntaxRecordSpans.map((span) => [span.line, span.endLine]));
    return [...limits].map(([record, fallback]) => {
      const endLine = ends.get(record.span.line) ?? fallback;
      return {
        record,
        endLine,
        errors: errors.filter(
          (d) =>
            d.line >= record.span.line &&
            d.line <= endLine &&
            !ast.syntaxRecordSpans!.some(
              (nested) =>
                nested.line > record.span.line &&
                nested.line <= endLine &&
                d.line >= nested.line &&
                d.line <= nested.endLine,
            ),
        ),
      };
    });
  }
  // JSON serialization copies the derived `nested` entries, so ownership cannot depend on aliases.
  const endsByLine = new Map([...limits].map(([record, endLine]) => [record.span.line, endLine]));
  return [...limits].map(([record, endLine]) => ({
    record,
    endLine,
    errors: errors.filter(
      (d) =>
        d.line >= record.span.line &&
        d.line <= endLine &&
        !record.nested.some((nested) => d.line >= nested.span.line && d.line <= endsByLine.get(nested.span.line)!),
    ),
  }));
}

/** Structural boundaries include refused trailing lines that accepted AST spans omit. */
function recordLimits(records: readonly RecordNode[], fileEnd: number): ReadonlyMap<RecordNode, number> {
  const limits = new Map<RecordNode, number>();
  const children = (nodes: readonly ChildNode[], endLine: number): void => {
    nodes.forEach((node, index) => {
      const end = (nodes[index + 1]?.span.line ?? endLine + 1) - 1;
      if (node.kind === 'record') record(node, end);
      else if (node.kind === 'field') children(node.children, end);
    });
  };
  const record = (node: RecordNode, endLine: number): void => {
    limits.set(node, endLine);
    children(node.head, (node.sections[0]?.span.line ?? endLine + 1) - 1);
    node.sections.forEach((section, index) =>
      children(section.children, (node.sections[index + 1]?.span.line ?? endLine + 1) - 1),
    );
  };
  children(records, fileEnd);
  return limits;
}

/** Inline and standalone conditions through field blocks; nested records own their own positions. */
export function conditionsIn(children: readonly ChildNode[]): FieldNode[] {
  const found: FieldNode[] = [];
  for (const child of children) {
    if (child.kind !== 'field') continue;
    if (child.when !== undefined || child.words[0] === 'when') found.push(child);
    found.push(...conditionsIn(child.children));
  }
  return found;
}
