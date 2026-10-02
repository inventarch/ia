import { createHash } from 'node:crypto';
import { canonicalPath } from '@ia/language';
import type { FrozenRegistry, Location } from '@ia/language';
import { assertLocation, canonicalRoot } from './paths.js';

export interface RevisionSource {
  readonly path: string;
  readonly text: string;
  readonly location: Location;
}
export interface RevisionInputs {
  readonly sources: readonly RevisionSource[];
  readonly languageVersion: string;
  readonly kernelDigest: string;
}
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Stable structured-data encoding. Collection tags keep maps, sets and arrays distinct. */
export function stableSerialize(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (item instanceof Map)
      return {
        $map: [...item]
          .map(([k, v]) => [ordered(k), ordered(v)])
          .sort((a, b) => compare(JSON.stringify(a[0]), JSON.stringify(b[0]))),
      };
    if (item instanceof Set)
      return { $set: [...item].map(ordered).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))) };
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object')
      return {
        $object: Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => compare(a, b))
          .map(([k, v]) => [k, ordered(v)]),
      };
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Cannot serialize a non-finite number');
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
      throw new TypeError('Expected structured serializable data');
    return item;
  };
  return JSON.stringify(ordered(value));
}
export function revisionOf(registry: FrozenRegistry, inputs: RevisionInputs): string {
  const sources = inputs.sources
    .map((source) => {
      assertLocation(source.location);
      return {
        path: canonicalPath(source.path),
        text: source.text,
        location: {
          ...source.location,
          placement: { ...source.location.placement, reach: canonicalRoot(source.location.placement.reach) },
        },
      };
    })
    .sort((a, b) => compare(a.path, b.path));
  if (new Set(sources.map((s) => s.path)).size !== sources.length)
    throw new TypeError('Revision sources have duplicate canonical paths');
  return createHash('sha256')
    .update(
      stableSerialize({
        sources,
        registry,
        languageVersion: inputs.languageVersion,
        kernelDigest: inputs.kernelDigest,
      }),
    )
    .digest('hex');
}
