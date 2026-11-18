import type { ChildNode, FieldNode, FileNode, RecordNode, Span } from '../ast.js';
import type { Diagnostic } from '../diagnostics.js';

export interface RecordSource {
  readonly record: RecordNode;
  /** Structural boundary, including trailing refused lines omitted by the accepted AST span. */
  readonly endLine: number;
  /** Parser errors owned by this record, excluding its nested declarations. */
  readonly errors: readonly Diagnostic[];
}

interface OrderedError {
  readonly diagnostic: Diagnostic;
  readonly order: number;
}

function lowerBoundError(errors: readonly OrderedError[], line: number): number {
  let low = 0;
  let high = errors.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (errors[mid]!.diagnostic.line >= line) high = mid;
    else low = mid + 1;
  }
  return low;
}

function firstSpanAfter(spans: readonly Span[], line: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (spans[mid]!.line > line) high = mid;
    else low = mid + 1;
  }
  return low;
}

function selectRecordErrors(
  sortedErrors: readonly OrderedError[],
  orderedInput: boolean,
  startLine: number,
  endLine: number,
  nestedSpans: readonly Span[],
  nestedStart = 0,
): readonly Diagnostic[] {
  const start = lowerBoundError(sortedErrors, startLine);
  if (start >= sortedErrors.length || sortedErrors[start]!.diagnostic.line > endLine) return [];
  const matched: OrderedError[] = [];
  let spanIdx = nestedStart;
  let maxNestedEnd = -1;
  for (let i = start; i < sortedErrors.length; i++) {
    const entry = sortedErrors[i]!;
    const line = entry.diagnostic.line;
    if (line > endLine) break;
    while (spanIdx < nestedSpans.length && nestedSpans[spanIdx]!.line <= line) {
      const end = nestedSpans[spanIdx]!.endLine;
      if (end > maxNestedEnd) maxNestedEnd = end;
      spanIdx++;
    }
    if (line > maxNestedEnd) matched.push(entry);
  }
  if (!orderedInput && matched.length > 1) matched.sort((a, b) => a.order - b.order);
  return matched.map((entry) => entry.diagnostic);
}

/** Every record once in source order, with its own parser faults. Structural children alias `nested`. */
export function recordsIn(ast: FileNode, parserDiagnostics: readonly Diagnostic[]): readonly RecordSource[] {
  const errors: OrderedError[] = [];
  let orderedInput = true;
  let prevLine = -Infinity;
  for (const d of parserDiagnostics) {
    if (d.path !== ast.path || d.severity !== 'error') continue;
    if (d.line < prevLine) orderedInput = false;
    prevLine = d.line;
    errors.push({ diagnostic: d, order: errors.length });
  }
  const sortedErrors = orderedInput
    ? errors
    : [...errors].sort((a, b) => a.diagnostic.line - b.diagnostic.line || a.order - b.order);
  let fileEnd = 1;
  for (const r of ast.records) if (r.span.endLine > fileEnd) fileEnd = r.span.endLine;
  for (const { diagnostic } of sortedErrors) {
    const end = diagnostic.endLine ?? diagnostic.line;
    if (end > fileEnd) fileEnd = end;
  }
  const limits = recordLimits(ast.records, fileEnd);
  if (ast.syntaxRecordSpans !== undefined) {
    const ends = new Map(ast.syntaxRecordSpans.map((span) => [span.line, span.endLine]));
    const spans = [...ast.syntaxRecordSpans].sort((a, b) => a.line - b.line || b.endLine - a.endLine);
    return [...limits].map(([record, fallback]) => {
      const endLine = ends.get(record.span.line) ?? fallback;
      const nestedStart = firstSpanAfter(spans, record.span.line);
      return {
        record,
        endLine,
        errors: selectRecordErrors(sortedErrors, orderedInput, record.span.line, endLine, spans, nestedStart),
      };
    });
  }
  // JSON serialization copies the derived `nested` entries, so ownership cannot depend on aliases.
  const endsByLine = new Map([...limits].map(([record, endLine]) => [record.span.line, endLine]));
  return [...limits].map(([record, endLine]) => {
    const nestedSpans = record.nested
      .map((nested) => ({ line: nested.span.line, endLine: endsByLine.get(nested.span.line)! }))
      .sort((a, b) => a.line - b.line || b.endLine - a.endLine);
    return {
      record,
      endLine,
      errors: selectRecordErrors(sortedErrors, orderedInput, record.span.line, endLine, nestedSpans),
    };
  });
}

/** Structural boundaries include refused trailing lines that accepted AST spans omit. */
function recordLimits(records: readonly RecordNode[], fileEnd: number): ReadonlyMap<RecordNode, number> {
  const limits = new Map<RecordNode, number>();
  const stack: { readonly nodes: readonly ChildNode[]; index: number; readonly endLine: number }[] = [
    { nodes: records, index: 0, endLine: fileEnd },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.index >= top.nodes.length) {
      stack.pop();
      continue;
    }
    const idx = top.index++;
    const node = top.nodes[idx]!;
    const end = (top.nodes[idx + 1]?.span.line ?? top.endLine + 1) - 1;
    if (node.kind === 'record') {
      limits.set(node, end);
      for (let s = node.sections.length - 1; s >= 0; s--) {
        const sectionEnd = (node.sections[s + 1]?.span.line ?? end + 1) - 1;
        if (node.sections[s]!.children.length > 0)
          stack.push({ nodes: node.sections[s]!.children, index: 0, endLine: sectionEnd });
      }
      const headEnd = (node.sections[0]?.span.line ?? end + 1) - 1;
      if (node.head.length > 0) stack.push({ nodes: node.head, index: 0, endLine: headEnd });
    } else if (node.kind === 'field' && node.children.length > 0) {
      stack.push({ nodes: node.children, index: 0, endLine: end });
    }
  }
  return limits;
}

/** Inline and standalone conditions through field blocks; nested records own their own positions. */
export function conditionsIn(children: readonly ChildNode[]): FieldNode[] {
  const found: FieldNode[] = [];
  const stack: { readonly nodes: readonly ChildNode[]; index: number }[] = [{ nodes: children, index: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.index >= top.nodes.length) {
      stack.pop();
      continue;
    }
    const child = top.nodes[top.index++]!;
    if (child.kind !== 'field') continue;
    if (child.when !== undefined || child.words[0] === 'when') found.push(child);
    if (child.children.length > 0) stack.push({ nodes: child.children, index: 0 });
  }
  return found;
}
