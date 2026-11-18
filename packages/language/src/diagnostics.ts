/** Closed diagnostic inventory from spec section 11 and the colocated semantic contract. */
export const LANG_CODES = [
  'IA-LANG-PRAGMA-MISSING',
  'IA-LANG-VERSION-UNSUPPORTED',
  'IA-LANG-INDENT-TAB',
  'IA-LANG-INDENT-STEP',
  'IA-LANG-STRING-UNTERMINATED',
  'IA-LANG-PROSE-TRAILING',
  'IA-LANG-PROSE-UNTERMINATED',
  'IA-LANG-LIST-UNTERMINATED',
  'IA-LANG-HEADER-MALFORMED',
  'IA-LANG-HEAD-FIELD-AFTER-SECTION',
  'IA-LANG-TOPLEVEL-UNEXPECTED',
  'IA-LANG-DISCRIMINATOR-UNREGISTERED',
  'IA-LANG-FACET-UNDECLARED',
  'IA-LANG-IDENTITY-COLLISION',
  'IA-LANG-KEYWORD-RESERVED',
  'IA-LANG-SYSTEM-CYCLE',
  'IA-LANG-REGISTRATION-INCOMPLETE',
  'IA-LANG-KIND-UNKNOWN',
  'IA-LANG-CATEGORY-UNKNOWN',
  'IA-LANG-PREDICATE-UNKNOWN',
  'IA-LANG-SCHEMA-MISSING',
  'IA-LANG-SCHEMA-KIND-MISMATCH',
  'IA-LANG-DISCRIMINATOR-CONFLICT',
  'IA-LANG-SCHEMA-EDGE-AS-FIELD',
  'IA-LANG-SYSTEM-MISSING',
  'IA-LANG-SCHEMA-MALFORMED',
  'IA-LANG-CELL-MALFORMED',
  'IA-LANG-SELECTOR-MALFORMED',
  'IA-LANG-SELECTOR-AXIS-UNKNOWN',
  'IA-LANG-SELECTOR-VALUE-UNKNOWN',
  'IA-LANG-VERB-UNKNOWN',
  'IA-LANG-EDGE-MALFORMED',
  'IA-LANG-EDGE-TARGET-MISSING',
  'IA-LANG-EDGE-TARGET-AMBIGUOUS',
  'IA-LANG-EDGE-UNCONSENTED',
  'IA-LANG-CONDITION-TERM-UNKNOWN',
  'IA-LANG-CONDITION-MALFORMED',
  'IA-LANG-CONDITION-VALUE-UNKNOWN',
  'IA-LANG-CONDITION-MISPLACED',
  'IA-LANG-VARIANT-DUPLICATE',
  'IA-LANG-REQUIREMENT-DUPLICATE',
  'IA-LANG-REQUIREMENT-MALFORMED',
  'IA-LANG-CONTRACT-UNBOUND',
  'IA-LANG-CONTRACT-BINDS-RETIRED',
  'IA-LANG-CONTRACT-SCHEMA-SECTION',
  'IA-LANG-CASE-UNBOUND',
  'IA-LANG-CASE-MALFORMED',
  'IA-LANG-FORMAT-LOSSY',
  'IA-LANG-VALUE-TRAILING',
  'IA-LANG-LIST-MALFORMED',
  'IA-LANG-REF-MALFORMED',
  'IA-LANG-FIELD-KEY-MISSING',
] as const;

export type LangCode = (typeof LANG_CODES)[number];
export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly code: LangCode;
  readonly severity: Severity;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  readonly message: string;
  readonly identity?: string;
}

export interface DiagOptions {
  readonly severity?: Severity;
  readonly endLine?: number;
  readonly identity?: string;
}

/** Build a diagnostic. Severity defaults to error; a construct that produced one produced nothing else. */
export function diag(
  code: LangCode,
  path: string,
  line: number,
  message: string,
  options: DiagOptions = {},
): Diagnostic {
  return {
    code,
    severity: options.severity ?? 'error',
    path,
    line,
    ...(options.endLine === undefined ? {} : { endLine: options.endLine }),
    message,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  };
}

export function isError(d: Diagnostic): boolean {
  return d.severity === 'error';
}

/** Append items without spreading into Array.prototype.push, which overflows the call stack on large inputs. */
export function pushAll<T>(target: T[], items: readonly T[]): void {
  for (let i = 0; i < items.length; i++) target.push(items[i]!);
}

const MAX_DIAGNOSTIC_LIST_ITEMS = 32;
const MAX_DIAGNOSTIC_LIST_CHARS = 512;
const MAX_DIAGNOSTIC_ITEM_CHARS = 128;

function truncateDiagnosticItem(raw: string): string {
  return raw.length > MAX_DIAGNOSTIC_ITEM_CHARS ? `${raw.slice(0, MAX_DIAGNOSTIC_ITEM_CHARS)}...` : raw;
}

/**
 * Render a diagnostic list (`visible`, `visible systems`, collision peers) identically for ordinary corpora while
 * bounding pathological item counts and multi-kilobyte names so repeated diagnostics never explode heap memory.
 */
export function summarizeList(items: readonly string[], separator = ', '): string {
  if (items.length <= MAX_DIAGNOSTIC_LIST_ITEMS) {
    const full = items.join(separator);
    if (full.length <= MAX_DIAGNOSTIC_LIST_CHARS) return full;
  }
  const shown: string[] = [];
  let chars = 0;
  for (let i = 0; i < items.length && shown.length < MAX_DIAGNOSTIC_LIST_ITEMS; i++) {
    const item = truncateDiagnosticItem(items[i]!);
    const added = (shown.length > 0 ? separator.length : 0) + item.length;
    if (shown.length > 0 && chars + added > MAX_DIAGNOSTIC_LIST_CHARS) break;
    shown.push(item);
    chars += added;
  }
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(separator)}${separator}... (${rest} more)` : shown.join(separator);
}

/** Render `labels` excluding `excludeIndex` in O(1) work per caller even when `labels` holds thousands of peers. */
export function summarizeOthers(labels: readonly string[], excludeIndex: number): string {
  const peerCount = labels.length - (excludeIndex >= 0 && excludeIndex < labels.length ? 1 : 0);
  if (peerCount <= MAX_DIAGNOSTIC_LIST_ITEMS) {
    const peers: string[] = [];
    for (let i = 0; i < labels.length; i++) if (i !== excludeIndex) peers.push(labels[i]!);
    return summarizeList(peers);
  }
  const shown: string[] = [];
  let chars = 0;
  for (let i = 0; i < labels.length && shown.length < MAX_DIAGNOSTIC_LIST_ITEMS; i++) {
    if (i === excludeIndex) continue;
    const item = truncateDiagnosticItem(labels[i]!);
    const added = (shown.length > 0 ? 2 : 0) + item.length;
    if (shown.length > 0 && chars + added > MAX_DIAGNOSTIC_LIST_CHARS) break;
    shown.push(item);
    chars += added;
  }
  const rest = peerCount - shown.length;
  return rest > 0 ? `${shown.join(', ')}, ... (${rest} more)` : shown.join(', ');
}
