import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { serialize } from '@inventarch/graph';
import type { Graph } from '@inventarch/graph';
import { safePath } from './inputs.js';

export interface CacheObservation {
  readonly code: 'IA-DB-CACHE-UNAVAILABLE';
  readonly severity: 'warning';
  readonly path: string;
  readonly message: string;
}
export interface CacheStatus {
  readonly state: 'disabled' | 'hit' | 'written' | 'unavailable';
  readonly observations: readonly CacheObservation[];
}
export function publishCache(root: string, graph: Graph, enabled: boolean): CacheStatus {
  if (!enabled) return Object.freeze({ state: 'disabled', observations: Object.freeze([]) });
  const path = '.ia/.iadb/graph.json';
  let temporary: string | undefined;
  try {
    const bytes = JSON.stringify({ format: 'ia-graph-1', revision: graph.revision, graph: serialize(graph) }) + '\n';
    const target = safePath(root, path);
    try {
      if (readFileSync(target, 'utf8') === bytes)
        return Object.freeze({ state: 'hit', observations: Object.freeze([]) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(safePath(root, '.ia/.iadb'), { recursive: true });
    temporary = `.ia/.iadb/graph.${randomUUID()}.tmp`;
    writeFileSync(safePath(root, temporary), bytes, { encoding: 'utf8', flag: 'wx' });
    renameSync(safePath(root, temporary), safePath(root, path));
    temporary = undefined;
    return Object.freeze({ state: 'written', observations: Object.freeze([]) });
  } catch (error) {
    if (temporary !== undefined)
      try {
        unlinkSync(safePath(root, temporary));
      } catch {
        /* a disposable unpublished file cannot affect reads */
      }
    return Object.freeze({
      state: 'unavailable',
      observations: Object.freeze([
        {
          code: 'IA-DB-CACHE-UNAVAILABLE' as const,
          severity: 'warning' as const,
          path,
          message: `Cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]),
    });
  }
}
