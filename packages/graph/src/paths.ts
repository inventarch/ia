import { BAND_OF, canonicalPath, isPlacementKind, isProvenance } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { GraphUsageError } from './diagnostics.js';

export function canonicalRoot(value: string): string {
  if (/^(?:[A-Za-z]:|[\\/])/.test(value))
    throw new GraphUsageError('IA-GRAPH-SCOPE-INVALID', `Scope root '${value}' must be corpus-relative`);
  try {
    const path = canonicalPath(value === '' ? '__root__' : `${value}/__root__`);
    if (path.startsWith('../') || /^[A-Za-z]:/.test(path)) throw new Error('Root must stay within the corpus');
    return path === '__root__' ? '' : path.slice(0, -'/__root__'.length);
  } catch (error) {
    throw new GraphUsageError('IA-GRAPH-SCOPE-INVALID', `Invalid scope root '${value}': ${String(error)}`);
  }
}
export function reaches(reach: string, location: string): boolean {
  const from = canonicalRoot(reach);
  const to = canonicalRoot(location);
  return from === '' || from === to || to.startsWith(`${from}/`);
}
export function assertLocation(location: Location): void {
  if (
    !isPlacementKind(location.placement.kind) ||
    BAND_OF[location.placement.kind] !== location.placement.band ||
    !isProvenance(location.provenance)
  )
    throw new TypeError('Location must have a valid placement kind/band pair and provenance');
  canonicalRoot(location.placement.reach);
}
