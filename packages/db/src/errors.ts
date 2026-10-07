export const DB_CODES = [
  'IA-DB-ROOT-INVALID',
  'IA-DB-PATH-UNSAFE',
  'IA-DB-SOURCE-UNAVAILABLE',
  'IA-DB-SOURCE-CHANGED',
  'IA-DB-SCOPE-UNAVAILABLE',
  'IA-DB-SCOPE-MISMATCH',
  'IA-DB-STALE',
  'IA-DB-CLOSED',
  'IA-DB-OUT-OF-SCOPE',
  'IA-DB-CACHE-UNAVAILABLE',
  'IA-DB-DRAFT-INVALID',
  'IA-DB-SNAPSHOT-UNAVAILABLE',
  'IA-DB-SOURCES-INVALID',
] as const;
export type DbCode = (typeof DB_CODES)[number];
/** The source a refusal is about, when it has one: a root-relative path, a 1-based line and the record there. */
export interface DbErrorLocation {
  readonly path: string;
  readonly line: number;
  readonly identity?: string;
}
export class DbError extends Error {
  constructor(
    readonly code: DbCode,
    message: string,
    /** Set when the refusal is about one authored source line (IA-DB-SOURCES-INVALID); otherwise undefined. */
    readonly where?: DbErrorLocation,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DbError';
  }
}
