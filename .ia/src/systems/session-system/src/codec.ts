import { CodecError, canonical as canonicalData, copy as copyData, digest as digestData } from '@inventarch/graph';

export { CodecError };
/**
 * The session refusal. The canonical codec itself lives in @inventarch/graph (`canonical`, `digest`, `copy` and
 * `CodecError`); this package re-exports graph's `CodecError` class itself and wraps the three functions so their
 * refusals are `SessionError`, which extends it. Every caller that matches on `SessionError` keeps working,
 * `instanceof CodecError` holds across both packages, and the codes are the ones the graph codec throws.
 */
export class SessionError extends CodecError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'SessionError';
  }
}
export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new SessionError(code, message);
}
const asSession = <T>(run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof CodecError && !(error instanceof SessionError))
      throw new SessionError(error.code, error.message);
    throw error;
  }
};
export const canonical = (value: unknown): string => asSession(() => canonicalData(value));
export const digest = (value: unknown): string => asSession(() => digestData(value));
export function copy<T>(value: T): T {
  return asSession(() => copyData(value));
}
export function identifier(value: string): string {
  requireValue(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
      !['__proto__', 'prototype', 'constructor'].includes(value),
    'IA-SESSION-INPUT-INVALID',
    'Expected a safe operational identifier',
  );
  return value;
}
