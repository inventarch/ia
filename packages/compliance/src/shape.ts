/** Internal shape, digest and redaction helpers shared by the catalog, obligation and evidence modules (C25-C28). Not exported from the package. */
import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = <K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
export function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableSerialize(value)).digest('hex')}`;
}
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
/** True for JSON data only: null, booleans, finite numbers, strings, arrays and plain objects, acyclic and at most 64 deep. */
export function jsonData(value: unknown, depth = 0, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 64 || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !jsonData(descriptor.value, depth + 1, seen))
      return false;
  }
  seen.delete(value);
  return true;
}
/** A deeply frozen structural copy of JSON data; callers check jsonData first. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Credential keys: a whole `[A-Za-z0-9_.-]+` token containing one of these words anywhere, e.g. GITHUB_TOKEN,
 * AWS_SECRET_ACCESS_KEY, x-auth, private_key. Keys are matched only from a token boundary and the keyword is tested on
 * the matched token afterwards, so no pattern has overlapping unbounded classes (linear in line length).
 */
const KEYWORD = /token|secret|password|passwd|api[_-]?key|credential|auth|private[_-]?key/i;
const KEY = '(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+';
const ASSIGNMENT = new RegExp(`(${KEY})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`, 'g');
const QUOTED_KEY = /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}\]]+)/g;
const SPACED_QUOTED = new RegExp(`(${KEY})(\\s+)("[^"]*"|'[^']*')`, 'g');
const BEARER = /\bbearer\s+[^\s"',;]+/gi;
const KEYED = new RegExp(`(${KEY})["']?\\s*[:=]`, 'g');
const secretish = (text: string): boolean =>
  /\bbearer\s/i.test(text) || [...text.matchAll(KEYED)].some((m) => KEYWORD.test(m[1]!));
/** Redaction scans at most this many characters of a line; output keeps at most MAX_DIAGNOSTIC_LENGTH of them. */
const REDACTION_WINDOW = 4096;
const CONTROL = /[\x00-\x1F\x7F]/g;
/** Printable single-line ASCII, bounded, with no credential assignment. Used for reasons, ids and echoed text. */
export function sanitized(text: unknown, max = 200): text is string {
  return (
    typeof text === 'string' && text.length > 0 && text.length <= max && /^[\x20-\x7E]+$/.test(text) && !secretish(text)
  );
}
/** Echo text only when it is sanitized; otherwise a fixed placeholder. */
export const echo = (text: unknown, max = 160): string => (sanitized(text, max) ? text : '<unprintable>');
/**
 * Redact one diagnostic line: control characters become spaces first (so supplied secrets are compared in the same
 * normal form), then supplied secret values, bearer tokens, quoted credential keys, KEY=value assignments and
 * `key 'value'` forms are replaced by [redacted].
 */
// A non-credential assignment keeps its key but its value is scanned again, so `a=token=x` still redacts `token=x`.
function assignment(_match: string, key: string, gap: string, value: string): string {
  return KEYWORD.test(key) ? `${key}${gap}[redacted]` : `${key}${gap}${value.replace(ASSIGNMENT, assignment)}`;
}
export function redact(line: string, secrets: readonly string[]): string {
  let clean = line.replace(CONTROL, ' ');
  // Supplied secrets are replaced over the whole line (linear), before windowing, so none straddles the window edge.
  for (const secret of secrets
    .map((s) => s.replace(CONTROL, ' '))
    .filter((s) => s.trim().length > 0)
    .sort((a, b) => b.length - a.length))
    clean = clean.replaceAll(secret, '[redacted]');
  clean = clean.slice(0, REDACTION_WINDOW);
  return clean
    .replace(BEARER, 'Bearer [redacted]')
    .replace(QUOTED_KEY, (all, quote: string, key: string, gap: string) =>
      KEYWORD.test(key) ? `${quote}${key}${quote}${gap}"[redacted]"` : all,
    )
    .replace(ASSIGNMENT, assignment)
    .replace(SPACED_QUOTED, (all, key: string, gap: string) => (KEYWORD.test(key) ? `${key}${gap}'[redacted]'` : all));
}
export const MAX_DIAGNOSTICS = 20,
  MAX_DIAGNOSTIC_LENGTH = 240;
/** At most 20 lines (sliced before filtering) of at most 240 characters, each redacted before truncation. */
export function bounded(lines: unknown, secrets: readonly string[] = []): readonly string[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, MAX_DIAGNOSTICS)
    .filter((l): l is string => typeof l === 'string')
    .map((line) => {
      // Redact the whole line before truncating so no secret straddles the cut; refuse to scan pathological lines.
      const clean = line.length > 65536 ? '[diagnostic line exceeded 65536 characters]' : redact(line, secrets);
      return clean.length > MAX_DIAGNOSTIC_LENGTH ? `${clean.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...` : clean;
    });
}
