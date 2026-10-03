import type { Diagnostic } from '@inventarch/language';
export const GRAPH_CODES = [
  'IA-GRAPH-IDENTITY-TIE',
  'IA-GRAPH-TARGET-MISSING',
  'IA-GRAPH-TARGET-AMBIGUOUS',
  'IA-GRAPH-EDGE-UNCONSENTED',
  'IA-GRAPH-DIMENSION-UNKNOWN',
  'IA-GRAPH-COORDINATE-VALUE-UNKNOWN',
  'IA-GRAPH-VERB-UNKNOWN',
  'IA-GRAPH-TRAVERSAL-INVALID',
  'IA-GRAPH-VARIANT-AMBIGUOUS',
  'IA-GRAPH-SCOPE-INVALID',
] as const;
export type GraphCode = (typeof GRAPH_CODES)[number];
export interface GraphDiagnostic extends Omit<Diagnostic, 'code'> {
  readonly code: GraphCode;
}
export class GraphUsageError extends Error {
  constructor(
    readonly code: GraphCode,
    message: string,
  ) {
    super(message);
    this.name = 'GraphUsageError';
  }
}
export function graphDiagnostic(
  code: GraphCode,
  path: string,
  line: number,
  message: string,
  warning = false,
): GraphDiagnostic {
  return { code, path, line, severity: warning ? 'warning' : 'error', message: `${path}:${line}: ${message}` };
}
