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
] as const;
export type DbCode = (typeof DB_CODES)[number];
export class DbError extends Error {
  /** The root-relative path the error is about, when one entry is at fault; absent otherwise, as in 1.x. */
  declare readonly path?: string;
  constructor(
    readonly code: DbCode,
    message: string,
    path?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DbError';
    if (path !== undefined) this.path = path;
  }
}
