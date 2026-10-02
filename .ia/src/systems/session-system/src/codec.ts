import { createHash } from 'node:crypto';
import type { Json } from './types.js';

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}
export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new SessionError(code, message);
}
export function canonical(value: unknown): string {
  const visit = (item: unknown, depth: number): Json => {
    requireValue(depth <= 64, 'IA-SESSION-LIMIT-EXCEEDED', 'Structured data nesting exceeds 64');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((v: unknown) => visit(v, depth + 1));
    if (
      typeof item === 'object' &&
      item !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)
    ) {
      const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
      for (const key of Object.keys(item).sort()) {
        requireValue(
          !['__proto__', 'prototype', 'constructor'].includes(key),
          'IA-SESSION-INPUT-INVALID',
          'Unsafe object key',
        );
        out[key] = visit((item as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    }
    throw new SessionError('IA-SESSION-INPUT-INVALID', 'Expected finite JSON data');
  };
  return JSON.stringify(visit(value, 0));
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function copy<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
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
