export const RUNTIME_CODES = [
  'IA-RUNTIME-REQUEST-INVALID',
  'IA-RUNTIME-BUDGET-INVALID',
  'IA-RUNTIME-MANDATE-MOVE',
  'IA-RUNTIME-MANDATE-WORD',
  'IA-RUNTIME-READ-UNADMITTED',
  'IA-RUNTIME-READ-FRAGMENT',
  'IA-RUNTIME-READ-UNREACHABLE',
  'IA-RUNTIME-READ-PLACEMENT',
  'IA-RUNTIME-NEXT-SEAT',
  'IA-RUNTIME-NEXT-NO-PLAN',
  'IA-RUNTIME-NEXT-AMBIGUOUS',
  'IA-RUNTIME-NEXT-CYCLE',
  'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
] as const;
export type RuntimeCode = (typeof RUNTIME_CODES)[number];
export const RUNTIME_ESCALATIONS = ['coordinate-incomplete', 'deny-wins-tie', 'no-candidate'] as const;
export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeError';
  }
}
