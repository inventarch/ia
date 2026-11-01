import { createHash } from 'node:crypto';
import { canonicalPath } from '@inventarch/language';
import type { CompiledChild, CompiledRecord, FrozenRegistry, Location } from '@inventarch/language';
import { digest } from './codec.js';
import { isFrozen } from './immutable.js';
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

/**
 * Stable structured-data encoding. Collection tags keep maps, sets and arrays distinct. It counts what it holds as it
 * goes, a string its length and every item 32 more, for the ordered copy of it, and past `limit` of that it throws a
 * RangeError, having written nothing.
 */
export function stableSerialize(value: unknown, limit = Number.POSITIVE_INFINITY): string {
  let size = 0;
  const ordered = (item: unknown): unknown => {
    size += typeof item === 'string' ? item.length + 32 : 32;
    if (size > limit) throw new RangeError(`Past ${limit} to serialize`);
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
      // Each field is read as its turn comes, so that a limit is reached before an accessor later in the order is read.
      return {
        $object: Object.keys(item)
          .sort(compare)
          .flatMap((key) => {
            const field = (item as Record<string, unknown>)[key];
            return field === undefined ? [] : [[key, ordered(field)]];
          }),
      };
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Cannot serialize a non-finite number');
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
      throw new TypeError('Expected structured serializable data');
    return item;
  };
  return JSON.stringify(ordered(value));
}
/** Every source in canonical form, sorted by path; a malformed location or a duplicate canonical path throws. */
function canonicalSources(inputs: RevisionInputs): readonly RevisionSource[] {
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
  return sources;
}
const hashOf = (registry: FrozenRegistry, inputs: RevisionInputs, sources: readonly RevisionSource[]): string =>
  createHash('sha256')
    .update(
      stableSerialize({
        sources,
        registry,
        languageVersion: inputs.languageVersion,
        kernelDigest: inputs.kernelDigest,
      }),
    )
    .digest('hex');
/**
 * A revision by the inputs it hashed, so that a view rebuilt pass by pass, phase by phase, hashes its sources once. Only
 * for an array and a registry `frozen` made, which cannot change: of anything else it hashes what it is given each time.
 */
const revisions = new WeakMap<readonly RevisionSource[], WeakMap<FrozenRegistry, Map<string, string>>>();
function known(registry: FrozenRegistry, inputs: RevisionInputs, kind: unknown, hash: () => string): string {
  if (!isFrozen(inputs.sources) || !isFrozen(registry)) return hash();
  let byRegistry = revisions.get(inputs.sources);
  if (byRegistry === undefined) {
    byRegistry = new WeakMap();
    revisions.set(inputs.sources, byRegistry);
  }
  let held = byRegistry.get(registry);
  if (held === undefined) {
    held = new Map();
    byRegistry.set(registry, held);
  }
  const key = JSON.stringify([kind, inputs.languageVersion, inputs.kernelDigest]);
  let revision = held.get(key);
  if (revision === undefined) {
    revision = hash();
    held.set(key, revision);
  }
  return revision;
}
export function revisionOf(registry: FrozenRegistry, inputs: RevisionInputs): string {
  return known(registry, inputs, 'whole', () => hashOf(registry, inputs, canonicalSources(inputs)));
}
/**
 * The authored revision (G01a): `revisionOf` over the same inputs without the sources at runtime placement (band 0),
 * so runtime-band evidence, admitted below authored, moves it no more than it moves what agents are given. A
 * runtime-placed input whose path `derived` names stays: a derived revision-only input that no record compiles from,
 * such as db's `.ia/.db-inputs.json` (its folder inventory, floor origin, authored roots and activation), so those
 * still move it. The registry, language version and kernel digest stay as `revisionOf` hashes them, and every source
 * is checked as `revisionOf` checks it. With no other source at runtime placement it is `revisionOf(registry, inputs)`
 * itself. It is no `load` input: a graph's `revision` stays `revisionOf`'s, and `load` still needs every record's
 * source among the full inputs.
 */
export function authoredRevisionOf(
  registry: FrozenRegistry,
  inputs: RevisionInputs,
  derived: readonly string[] = [],
): string {
  const kept = new Set(derived.map(canonicalPath));
  return known(registry, inputs, ['authored', ...kept], () =>
    hashOf(
      registry,
      inputs,
      canonicalSources(inputs).filter(
        (source) => source.location.placement.kind !== 'runtime' || kept.has(source.path),
      ),
    ),
  );
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
