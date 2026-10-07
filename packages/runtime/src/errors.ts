export const RUNTIME_CODES = [
  'IA-RUNTIME-REQUEST-INVALID',
  'IA-RUNTIME-BUDGET-INVALID',
  'IA-RUNTIME-MANDATE-MOVE',
  'IA-RUNTIME-MANDATE-WORD',
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
