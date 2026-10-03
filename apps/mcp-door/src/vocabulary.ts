/**
 * `ia_vocabulary` (SPEC.md M04c): the public words, their schemas and fields, from the catalogue shipped inside this
 * package at `assets/vocabulary.json`. `tools/native/public-vocabulary.ts` emits it byte-identical to the catalogue
 * `ia vocabulary` reads (apps/cli/src/vocabulary.ts) under the `vocabulary:check` drift gate. It never reads the
 * workspace, takes no scope token and writes nothing; the filters and JSON shape follow `ia vocabulary --json`.
 */
import { readFileSync } from 'node:fs';
import type { DoorResponse } from '@inventarch/runtime';

export const CATALOGUE_URL = new URL('../assets/vocabulary.json', import.meta.url);
export const LIMITS = { word: 64, search: 256, filters: 64 } as const;
const PARAMETERS = ['word', 'domain', 'kind', 'search', 'schema'];

interface Word {
  readonly word: string;
  readonly owner: string;
  readonly kind: string;
  readonly description: string;
  readonly schema: { readonly name: string; readonly path: string; readonly closed: boolean };
}
interface Catalogue {
  readonly version: number;
  readonly language: string;
  readonly status: string;
  readonly sourceDigest: string;
  readonly words: readonly Word[];
}

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new Refused('IA-RUNTIME-REQUEST-INVALID', message);
};
const bounded = (value: unknown, label: string, limit: number): string => {
  if (typeof value !== 'string') return invalid(`${label} must be a string`);
  if (value.length > limit) return invalid(`${label} exceeds ${limit} characters`);
  return value;
};
const list = (value: unknown, label: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid(`${label} must be an array of strings`);
  if (value.length > LIMITS.filters) return invalid(`${label} exceeds ${LIMITS.filters} entries`);
  return value.map((item) => bounded(item, label, LIMITS.word));
};

let cached: Catalogue | undefined;
function catalogue(): Catalogue {
  if (cached !== undefined) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CATALOGUE_URL, 'utf8'));
  } catch (error) {
    throw new Refused(
      'IA-VOCABULARY-UNAVAILABLE',
      `The shipped vocabulary catalogue could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { words?: unknown }).words))
    throw new Refused('IA-VOCABULARY-UNAVAILABLE', 'The shipped vocabulary catalogue has no words list');
  cached = parsed as Catalogue;
  return cached;
}

/** Answers one call; every failure is a named refusal, never a thrown error. */
export function vocabulary(params: Record<string, unknown>): DoorResponse {
  try {
    for (const key of Object.keys(params))
      if (!PARAMETERS.includes(key)) invalid(`Unknown parameter '${key}'; admitted: ${PARAMETERS.join(', ')}`);
    const requested =
      params['word'] === undefined ? undefined : bounded(params['word'], 'word', LIMITS.word).replace(/^@/, '');
    const domains = list(params['domain'], 'domain'),
      kinds = list(params['kind'], 'kind');
    const search =
      params['search'] === undefined ? undefined : bounded(params['search'], 'search', LIMITS.search).toLowerCase();
    if (params['schema'] !== undefined && typeof params['schema'] !== 'boolean') invalid('schema must be a boolean');
    const full = params['schema'] === true,
      shipped = catalogue();
    if (requested !== undefined && !shipped.words.some((word) => word.word === requested))
      throw new Refused(
        'IA-VOCABULARY-UNKNOWN-WORD',
        `Unknown word @${requested}; the shipped catalogue carries ${shipped.words.length} words. Call ia_vocabulary without word to list them.`,
      );
    const words = shipped.words.filter(
      (word) =>
        (requested === undefined || word.word === requested) &&
        (domains.length === 0 || domains.includes(word.owner)) &&
        (kinds.length === 0 || kinds.includes(word.kind)) &&
        (search === undefined ||
          word.word.toLowerCase().includes(search) ||
          word.description.toLowerCase().includes(search)),
    );
    const result = {
      version: shipped.version,
      language: shipped.language,
      status: shipped.status,
      sourceDigest: shipped.sourceDigest,
      words: words.map((word) =>
        full
          ? word
          : { ...word, schema: { name: word.schema.name, path: word.schema.path, closed: word.schema.closed } },
      ),
    };
    return { ok: true, result };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
