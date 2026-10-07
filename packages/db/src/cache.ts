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
export const cacheObservation = (path: string, message: string): CacheObservation =>
  Object.freeze({ code: 'IA-DB-CACHE-UNAVAILABLE' as const, severity: 'warning' as const, path, message });
/** D06/D08: the workspace-relative path of the derived file `name`. */
export const derivedPath = (name: string): string => `.ia/.iadb/${name}.json`;
/**
 * D06/D08: publish derived bytes at `derivedPath(name)`. Equal bytes are not rewritten; other bytes replace the
 * file through a unique same-directory temporary file, with containment rechecked at each access. Any failure is a
 * warning that leaves the in-memory state usable, and a disabled cache touches nothing.
 */
export function publishDerived(root: string, name: string, bytes: () => string, enabled: boolean): CacheStatus {
  if (!enabled) return Object.freeze({ state: 'disabled', observations: Object.freeze([]) });
  const path = derivedPath(name);
  let temporary: string | undefined;
  try {
    const content = bytes();
    const target = safePath(root, path);
    try {
      if (readFileSync(target, 'utf8') === content)
        return Object.freeze({ state: 'hit', observations: Object.freeze([]) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(safePath(root, '.ia/.iadb'), { recursive: true });
    temporary = `.ia/.iadb/${name}.${randomUUID()}.tmp`;
    writeFileSync(safePath(root, temporary), content, { encoding: 'utf8', flag: 'wx' });
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
        cacheObservation(path, `Cache unavailable: ${error instanceof Error ? error.message : String(error)}`),
      ]),
    });
  }
}
export function publishCache(root: string, graph: Graph, enabled: boolean): CacheStatus {
  return publishDerived(
    root,
    'graph',
    () => JSON.stringify({ format: 'ia-graph-1', revision: graph.revision, graph: serialize(graph) }) + '\n',
    enabled,
  );
}
