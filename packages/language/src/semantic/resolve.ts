import type { CompiledRecord } from '../compile/compile.js';
import { renderIdentity } from '../identity.js';
import { canonicalPath } from '../paths.js';
import type { FrozenRegistry } from '../registry/types.js';
import type { EdgeReference } from './types.js';

/** Identity discovery can resolve before the record's semantic arrays have been finalized. */
export type ResolutionCandidate = Pick<
  CompiledRecord,
  'identity' | 'system' | 'kind' | 'facet' | 'name' | 'discriminator' | 'source'
>;
export type Resolution<T extends ResolutionCandidate = ResolutionCandidate> = (
  | { readonly kind: 'missing' }
  | { readonly kind: 'resolved'; readonly target: T }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly T[] }
) & { readonly fragment?: string };

/** Caller contract, not a source diagnostic. Deliberately does not select bands or deduplicate. */
export function validatePool(
  registry: FrozenRegistry,
  pool: readonly ResolutionCandidate[],
  excludedPath?: string,
): void {
  for (const candidate of pool) {
    const registration = registry.registrations.get(candidate.discriminator);
    if (
      !registration ||
      registry.blocked.has(candidate.discriminator) ||
      registration.system !== candidate.system ||
      registration.kind !== candidate.kind ||
      !registration.facets.includes(candidate.facet) ||
      !/^[a-z][a-z0-9-]*$/.test(candidate.name) ||
      candidate.identity !== renderIdentity(candidate.system, candidate.kind, candidate.facet, candidate.name)
    ) {
      throw new TypeError(
        `Candidate ${candidate.identity} at ${candidate.source.path}:${candidate.source.line} is inconsistent with the registry or its identity slots.`,
      );
    }
    if (excludedPath !== undefined && canonicalPath(candidate.source.path) === canonicalPath(excludedPath))
      throw new TypeError(`The external pool must exclude current source ${excludedPath}.`);
  }
}

/** Exact cardinality matching. Fragments are addresses whose existence belongs to compliance. */
export function resolveTarget<T extends ResolutionCandidate>(
  reference: EdgeReference,
  registry: FrozenRegistry,
  pool: readonly T[],
): Resolution<T> {
  validatePool(registry, pool);
  const fragment = reference.fragment === undefined ? {} : { fragment: reference.fragment };
  const registration = reference.kind === 'ref' ? registry.registrations.get(reference.discriminator) : undefined;
  const candidates = pool.filter((candidate) =>
    reference.kind === 'identity'
      ? candidate.identity === reference.identity
      : registration !== undefined &&
        candidate.discriminator === reference.discriminator &&
        candidate.system === registration.system &&
        candidate.kind === registration.kind &&
        candidate.facet === registration.facets[0] &&
        candidate.name === reference.name.toLowerCase(),
  );
  if (candidates.length === 0) return { kind: 'missing', ...fragment };
  if (candidates.length === 1) return { kind: 'resolved', target: candidates[0]!, ...fragment };
  candidates.sort(
    (a, b) =>
      compare(a.identity, b.identity) ||
      compare(a.source.path, b.source.path) ||
      a.source.line - b.source.line ||
      compare(a.discriminator, b.discriminator) ||
      a.source.endLine - b.source.endLine,
  );
  return { kind: 'ambiguous', candidates, ...fragment };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Per-compilation index. Validate the complete pool once, preserving duplicates and exact cardinality. */
export function indexedResolver<T extends ResolutionCandidate>(
  registry: FrozenRegistry,
  pool: readonly T[],
): (reference: EdgeReference) => Resolution<T> {
  validatePool(registry, pool);
  const identities = new Map<string, T[]>(),
    names = new Map<string, T[]>();
  for (const candidate of pool) {
    const sameIdentity = identities.get(candidate.identity) ?? [];
    sameIdentity.push(candidate);
    identities.set(candidate.identity, sameIdentity);
    const sameName = names.get(candidate.name) ?? [];
    sameName.push(candidate);
    names.set(candidate.name, sameName);
  }
  return (reference) =>
    resolveTarget(
      reference,
      registry,
      (reference.kind === 'identity' ? identities.get(reference.identity) : names.get(reference.name.toLowerCase())) ??
        [],
    );
}
