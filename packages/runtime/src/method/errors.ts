/**
 * A method refusal: the `{ error: { code, message, candidates?, key? } }` payload the `ia` plugin's resolver prints, so a
 * host that reads one reads the other.
 */
export class MethodError extends Error {
  readonly code: string;
  readonly candidates?: readonly unknown[];
  readonly key?: string;
  readonly pinnedRoot?: string;
  constructor(
    message: string,
    code: string,
    extra: { readonly candidates?: readonly unknown[]; readonly key?: string; readonly pinnedRoot?: string } = {},
  ) {
    super(message);
    this.code = code;
    if (extra.candidates !== undefined) this.candidates = extra.candidates;
    if (extra.key !== undefined) this.key = extra.key;
    if (extra.pinnedRoot !== undefined) this.pinnedRoot = extra.pinnedRoot;
  }
}

export interface MethodRefusal {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly candidates?: readonly unknown[];
    readonly key?: string;
  };
}

/** The refusal payload for any thrown value; a value without a code is `IA-CORE-ERROR`. */
export function methodRefusal(error: unknown): MethodRefusal {
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'IA-CORE-ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const extra = error instanceof MethodError ? error : undefined;
  return {
    error: {
      code,
      message,
      ...(extra?.candidates === undefined ? {} : { candidates: extra.candidates }),
      ...(extra?.key === undefined ? {} : { key: extra.key }),
    },
  };
}

/** A JSON object member as a plain record, or undefined. */
export const objectAt = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
