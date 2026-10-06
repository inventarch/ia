import { createHash } from 'node:crypto';

/** Finite JSON data: the only shape the canonical form admits. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A canonical-form refusal. The `code` is the stable contract; a package that re-exports this codec may subclass
 * the error to keep its own name (session-system's `SessionError` does), and the codes are unchanged by that.
 */
export class CodecError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodecError';
  }
}
const NESTING_LIMIT = 64;
const UNSAFE_KEYS = ['__proto__', 'prototype', 'constructor'];
function refuse(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CodecError(code, message);
}
/**
 * The canonical JSON text of finite structured data: keys sorted, prototypes and unsafe keys refused, nesting
 * bounded. Two values with the same canonical text have the same digest; this is the digest contract that release
 * assessment, captured compositions and session journals share. It is distinct from `stableSerialize`, which tags
 * maps and sets and feeds workspace revisions; neither form replaces the other.
 */
export function canonical(value: unknown): string {
  const visit = (item: unknown, depth: number): Json => {
    refuse(depth <= NESTING_LIMIT, 'IA-SESSION-LIMIT-EXCEEDED', `Structured data nesting exceeds ${NESTING_LIMIT}`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((entry: unknown) => visit(entry, depth + 1));
    if (
      typeof item === 'object' &&
      item !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)
    ) {
      const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
      for (const key of Object.keys(item).sort()) {
        refuse(!UNSAFE_KEYS.includes(key), 'IA-SESSION-INPUT-INVALID', 'Unsafe object key');
        out[key] = visit((item as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    }
    throw new CodecError('IA-SESSION-INPUT-INVALID', 'Expected finite JSON data');
  };
  return JSON.stringify(visit(value, 0));
}
/** SHA-256 of the canonical text, as lowercase hex. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** A deep copy through the canonical form: plain data only, every prototype dropped. */
export function copy<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}
