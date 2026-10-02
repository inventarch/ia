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
  constructor(
    readonly code: DbCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DbError';
  }
}
