import { resolveTarget } from '@inventarch/language';
import type { EdgeReference, FrozenRegistry, ResolutionCandidate } from '@inventarch/language';

export type Resolution =
  | { readonly ok: true; readonly identity: string; readonly fragment?: string }
  | { readonly ok: false; readonly code: 'IA-GRAPH-TARGET-MISSING' | 'IA-GRAPH-TARGET-AMBIGUOUS' };
export function resolve(
  reference: EdgeReference,
  pool: readonly ResolutionCandidate[],
  registry: FrozenRegistry,
): Resolution {
  const result = resolveTarget(reference, registry, pool);
  if (result.kind !== 'resolved')
    return { ok: false, code: result.kind === 'missing' ? 'IA-GRAPH-TARGET-MISSING' : 'IA-GRAPH-TARGET-AMBIGUOUS' };
  return {
    ok: true,
    identity: result.target.identity,
    ...(result.fragment === undefined ? {} : { fragment: result.fragment }),
  };
}
export function referenceKey(reference: EdgeReference): string {
  return reference.kind === 'identity'
    ? reference.identity
    : `@${reference.discriminator} ${reference.name.toLowerCase()}`;
}
