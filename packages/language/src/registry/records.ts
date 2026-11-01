import type { ChildNode, FieldNode, FileNode, RecordNode, Span } from '../ast.js';
import { append } from '../bounded.js';
import type { Diagnostic } from '../diagnostics.js';

export interface RecordSource {
  readonly record: RecordNode;
  /** Structural boundary, including trailing refused lines omitted by the accepted AST span. */
  readonly endLine: number;
  /** Parser errors owned by this record, excluding its nested declarations. */
  readonly errors: readonly Diagnostic[];
}

const byLine = (a: { readonly line: number }, b: { readonly line: number }): number => a.line - b.line;
/** The index of the first item at or past `line`, in items in line order. */
function firstAt(items: readonly { readonly line: number }[], line: number): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.line < line) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** Whether an error in `errors`, in line order, falls on the lines of `span`. */
export const errorWithin = (errors: readonly Diagnostic[], span: Span): boolean =>
  (errors[firstAt(errors, span.line)]?.line ?? Number.POSITIVE_INFINITY) <= span.endLine;
/** The errors on a record's lines that no span opened below its header covers; `errors` and `spans` are in line order. */
function ownErrors(
  errors: readonly Diagnostic[],
  spans: readonly Span[],
  line: number,
  endLine: number,
): readonly Diagnostic[] {
  const own: Diagnostic[] = [];
  let next = firstAt(spans, line + 1),
    covered = 0;
  for (let at = firstAt(errors, line); at < errors.length && errors[at]!.line <= endLine; at++) {
    const error = errors[at]!;
    for (; next < spans.length && spans[next]!.line <= error.line; next++)
      covered = Math.max(covered, spans[next]!.endLine);
    if (error.line > covered) own.push(error);
  }
  return own;
}

/** Every record once in source order, with its own parser faults. Structural children alias `nested`. */
export function recordsIn(ast: FileNode, parserDiagnostics: readonly Diagnostic[]): readonly RecordSource[] {
  const errors = parserDiagnostics.filter((d) => d.path === ast.path && d.severity === 'error');
  let fileEnd = 1;
  for (const record of ast.records) fileEnd = Math.max(fileEnd, record.span.endLine);
  for (const error of errors) fileEnd = Math.max(fileEnd, error.endLine ?? error.line);
  const limits = recordLimits(ast.records, fileEnd);
  if (ast.syntaxRecordSpans !== undefined) {
    const ends = new Map(ast.syntaxRecordSpans.map((span) => [span.line, span.endLine]));
    const ordered = [...errors].sort(byLine),
      spans = [...ast.syntaxRecordSpans].sort(byLine);
    return [...limits].map(([record, fallback]) => {
      const endLine = ends.get(record.span.line) ?? fallback;
      return { record, endLine, errors: ownErrors(ordered, spans, record.span.line, endLine) };
    });
  }
  // JSON serialization copies the derived `nested` entries, so ownership cannot depend on aliases.
  const endsByLine = new Map([...limits].map(([record, endLine]) => [record.span.line, endLine]));
  return [...limits].map(([record, endLine]) => ({
    record,
    endLine,
    errors: errors
      .filter(
        (d) =>
          d.line >= record.span.line &&
          d.line <= endLine &&
          !record.nested.some((nested) => d.line >= nested.span.line && d.line <= endsByLine.get(nested.span.line)!),
      )
      .sort(byLine),
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
    append(found, conditionsIn(child.children));
  }
  return found;
}
