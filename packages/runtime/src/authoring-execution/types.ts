import type { Handle, DraftPreview } from '@ia/db';
import type { Node } from '@ia/graph';

export const EXEC_CODES = [
  'IA-EXEC-INPUT-INVALID',
  'IA-EXEC-OPERATION-UNAVAILABLE',
  'IA-EXEC-BINDING-MISMATCH',
  'IA-EXEC-VALIDATION-FAILED',
  'IA-EXEC-TEMPLATE-INVALID',
  'IA-EXEC-OUTPUT-UNSAFE',
  'IA-EXEC-OUTPUT-EXISTS',
  'IA-EXEC-SOURCE-CHANGED',
] as const;
export type ExecCode = (typeof EXEC_CODES)[number];
export class ExecutionError extends Error {
  constructor(
    readonly code: ExecCode,
    message: string,
    readonly diagnostics: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}
export interface Artifact {
  readonly path: string;
  readonly text: string;
}
export interface Context {
  readonly db: Pick<Handle, keyof Handle>;
  readonly records: readonly Node[];
}
export interface Product {
  readonly artifacts: readonly Artifact[];
  readonly preview?: DraftPreview;
  readonly candidateRevision?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
export type Handler = (context: Context, input: unknown) => Product;
export interface Success {
  readonly ok: true;
  readonly operation: string;
  readonly owner: string;
  readonly steward: string;
  readonly baseRevision: string;
  readonly candidateRevision?: string;
  readonly effects: 'read-only' | 'draft-only';
  readonly artifacts: readonly Artifact[];
  readonly evidence: Readonly<Record<string, unknown>>;
}
export interface Failure {
  readonly ok: false;
  readonly code: ExecCode;
  readonly message: string;
  readonly diagnostics: readonly unknown[];
}
export type Result = Success | Failure;
