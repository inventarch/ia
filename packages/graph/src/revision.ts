import { createHash } from 'node:crypto';
import { canonicalPath } from '@inventarch/language';
import type { CompiledChild, CompiledRecord, FrozenRegistry, Location } from '@inventarch/language';
import { digest } from './codec.js';
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
/**
 * Compiled fields and items without their spans, one row each in authored order: its `path` of indexes among its
 * parents' children, then its key, value and `when` words, or its item. Rows keep nested blocks in the form while its
 * depth stays bounded however deeply they nest, so every compiled record fits the codec's nesting limit.
 */
function authored(children: readonly CompiledChild[], parent: readonly number[] = []): unknown[] {
  return children.flatMap((child, index) => {
    const path = [...parent, index];
    return 'item' in child
      ? [{ path, item: child.item }]
      : [
          { path, key: child.key, value: child.value, ...(child.when === undefined ? {} : { when: child.when }) },
          ...authored(child.fields ?? [], path),
        ];
  });
}
/**
 * G13: the per-record digest, the codec `digest` of what a record says with where it was read left out. It covers the
 * identity slots, `parent`, head and section fields with their nested blocks, each compiled edge's predicate,
 * direction, spelling, reference, fragment and condition, cells, selectors, variants, requirements and `schema`. It
 * omits `source`, every span, `placement` and `provenance` (both supplied by the loader from the source's location;
 * capture membership carries root and band) and each edge's compile-time `target`, which resolves against the other
 * records of its file. Moving a record to another file or placement, or shifting its lines, leaves the digest unchanged
 * while its text compiles the same way. It is not a `revisionOf` input.
 */
export function recordDigest(record: CompiledRecord): string {
  const condition = (product: { readonly condition?: unknown }) =>
    product.condition === undefined ? {} : { condition: product.condition };
  return digest({
    identity: record.identity,
    system: record.system,
    kind: record.kind,
    facet: record.facet,
    name: record.name,
    displayName: record.displayName,
    discriminator: record.discriminator,
    parent: record.parent ?? null,
    head: authored(record.head),
    sections: record.sections.map((section) => ({ name: section.name, fields: authored(section.fields) })),
    edges: record.edges.map((edge) => ({
      predicate: edge.predicate,
      direction: edge.direction,
      spelling: edge.spelling,
      reference: edge.reference,
      ...(edge.fragment === undefined ? {} : { fragment: edge.fragment }),
      ...condition(edge),
    })),
    cells: record.cells.map((cell) => ({
      phase: cell.phase,
      primitive: cell.primitive,
      primary: cell.primary,
      text: cell.text,
      ...condition(cell),
    })),
    selectors: record.selectors,
    variants: record.variants.map((variant) => ({ key: variant.key, value: variant.value, ...condition(variant) })),
    requirements: record.requirements.map((requirement) => ({
      id: requirement.id,
      kind: requirement.kind,
      text: requirement.text,
      ...condition(requirement),
    })),
    schema: record.schema,
  });
}
