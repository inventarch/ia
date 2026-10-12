export const RUNTIME_CODES = [
  'IA-RUNTIME-REQUEST-INVALID',
  'IA-RUNTIME-BUDGET-INVALID',
  'IA-RUNTIME-MANDATE-MOVE',
  'IA-RUNTIME-MANDATE-WORD',
  'IA-RUNTIME-MANDATE-ACTOR',
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
/** Where in the workspace's sources a refusal is located: a path, its line, and the record's identity when known. */
export interface RuntimeWhere {
  readonly path: string;
  readonly line: number;
  readonly identity?: string;
}
export class RuntimeError extends Error {
  /** The one command to run after the refusal (design row 27), when the code refusing names one; else absent. */
  declare readonly next?: string;
  /**
   * Where the refusal is located, frozen, when it concerns one source record (a `@mandate` whose authority cannot be
   * read, or one that failed admission): a caller locates it from this, never from the message. Absent otherwise.
   */
  declare readonly where?: RuntimeWhere;
  constructor(
    readonly code: RuntimeCode,
    message: string,
    next?: string,
    where?: RuntimeWhere,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeError';
    if (next !== undefined) this.next = next;
    if (where !== undefined)
      this.where = Object.freeze({
        path: where.path,
        line: where.line,
        ...(where.identity === undefined ? {} : { identity: where.identity }),
      });
  }
}
