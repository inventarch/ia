import {
  compareVersions,
  decodeDistributionLock,
  decodeDistributionRequests,
  deriveGenerationInputs,
  DISTRIBUTION_LIMITS,
  satisfies,
} from '@inventarch/db/distribution';
import type { BundleMetadata, Dependency, DistributionLock, GenerationInputs } from '@inventarch/db/distribution';
import type { VerifiedArchive } from './archive.js';
import { fail } from './files.js';

/** `release` is a verified archive by default; resolution reads only its manifest-level metadata, so a caller may hold just that. */
export interface ReleaseCandidate<R extends BundleMetadata = VerifiedArchive> {
  readonly release: R;
  readonly location: string;
  readonly withdrawn: boolean;
}
export interface Resolution<R extends BundleMetadata = VerifiedArchive> {
  readonly lock: DistributionLock;
  readonly releases: ReadonlyMap<string, R>;
  readonly inputs: GenerationInputs;
  readonly assignments: number;
}
export const generationInputs = deriveGenerationInputs;
/** One candidate view the search needs; archives and registry metadata both provide it. */
export interface Choice {
  readonly id: string;
  readonly version: string;
  readonly engine: string;
  readonly dependencies: readonly Dependency[];
  readonly archive: string;
  readonly withdrawn: boolean;
}
export type MetadataCandidate = Choice;
const archiveChoice = (c: ReleaseCandidate<BundleMetadata>): Choice => ({
  id: c.release.manifest.id,
  version: c.release.manifest.version,
  engine: c.release.manifest.engine,
  dependencies: c.release.manifest.dependencies,
  archive: c.release.archiveDigest,
  withdrawn: c.withdrawn,
});
/**
 * Registry spec §5.2: the one search shared by metadata selection and archive resolution. The existing pin sorts
 * first, then the highest version. `accept` sees each complete leaf and returns true, or a reason that is recorded
 * before the search backtracks; anything it throws propagates.
 */
function searchChoices<C>(
  requests: readonly Dependency[],
  candidates: readonly C[],
  view: (c: C) => Choice,
  engine: string,
  preferred: ReadonlyMap<string, string>,
  accept: (selected: ReadonlyMap<string, C>, assignments: number) => true | string,
): ReadonlyMap<string, C> {
  let assignments = 0;
  const reasons = new Set<string>(),
    views = new Map(candidates.map((c) => [c, view(c)])),
    see = (c: C): Choice => views.get(c)!;
  const search = (
    selected: ReadonlyMap<string, C>,
    constraints: readonly (Dependency & { by: string })[],
  ): ReadonlyMap<string, C> | undefined => {
    for (const [id, c] of selected)
      if (constraints.some((k) => k.id === id && !satisfies(see(c).version, k.range))) return undefined;
    const unresolved = [...new Set(constraints.map((k) => k.id))].filter((id) => !selected.has(id)).sort();
    if (!unresolved.length) {
      const verdict = accept(selected, assignments);
      if (verdict === true) return selected;
      reasons.add(verdict);
      return undefined;
    }
    const id = unresolved[0]!,
      needed = constraints.filter((k) => k.id === id),
      old = preferred.get(id);
    const options = candidates
      .filter((c) => {
        const v = see(c);
        return (
          v.id === id &&
          !v.withdrawn &&
          satisfies(engine, v.engine) &&
          needed.every((n) => satisfies(v.version, n.range))
        );
      })
      .sort(
        (a, b) =>
          Number(see(b).archive === old) - Number(see(a).archive === old) ||
          compareVersions(see(a).version, see(b).version),
      ); // rcompare: highest first
    if (!options.length) reasons.add(`${id}: ${needed.map((k) => `${k.range} from ${k.by}`).join('; ')}`);
    for (const c of options) {
      if (++assignments > DISTRIBUTION_LIMITS.assignments)
        fail('RESOLUTION-LIMIT', 'Dependency solving exceeded 1000 candidate assignments');
      const next = new Map(selected);
      next.set(id, c);
      const result = search(next, [
        ...constraints,
        ...see(c).dependencies.map((d) => ({ ...d, by: `${id}@${see(c).version}` })),
      ]);
      if (result) return result;
    }
    return undefined;
  };
  const result = search(
    new Map(),
    requests.map((r) => ({ ...r, by: 'direct request' })),
  );
  if (!result) fail('CONFLICT', `No compatible complete release set: ${[...reasons].slice(0, 30).join(' | ')}`);
  return result;
}
/** Deterministic finite search; no channels, fetches or mutation occur here. */
export function resolveReleases<R extends BundleMetadata = VerifiedArchive>(
  requestsInput: readonly Dependency[],
  catalog: readonly ReleaseCandidate<R>[],
  engine: string,
  existing?: DistributionLock,
): Resolution<R> {
  const requests = decodeDistributionRequests(requestsInput);
  if (catalog.length > 1000) fail('LIMIT-EXCEEDED', 'Release catalog exceeds 1000 candidates');
  const seen = new Map<string, ReleaseCandidate<R>>();
  for (const candidate of [...catalog].sort((a, b) =>
    a.location < b.location ? -1 : a.location > b.location ? 1 : 0,
  )) {
    const key = `${candidate.release.manifest.id}@${candidate.release.manifest.version}`,
      prior = seen.get(key);
    if (
      prior &&
      (prior.release.archiveDigest !== candidate.release.archiveDigest || prior.withdrawn !== candidate.withdrawn)
    )
      fail('CONFLICT', `Immutable release identity has different bytes/status: ${key}`);
    if (!prior) seen.set(key, candidate);
  }
  const unique = [...seen.values()],
    pins = new Map<string, string>();
  for (const p of existing?.packages ?? []) if (!pins.has(p.id)) pins.set(p.id, p.archive);
  let built: Resolution<R> | undefined;
  searchChoices(requests, unique, archiveChoice, engine, pins, (selected, assignments) => {
    const entries = [...selected].sort(([a], [b]) => (a < b ? -1 : 1)),
      releases = new Map(entries.map(([id, c]) => [id, c.release]));
    const lock = decodeDistributionLock({
      formatVersion: 1,
      engine,
      requests,
      packages: entries.map(([id, c]) => ({
        id,
        version: c.release.manifest.version,
        archive: c.release.archiveDigest,
        manifest: c.release.manifestDigest,
        location: c.location,
        dependencies: c.release.manifest.dependencies.map((d) => d.id),
      })),
    });
    try {
      built = { lock, releases, inputs: generationInputs(lock, releases), assignments };
      return true;
    } catch (error) {
      return String(error);
    }
  });
  return built!;
}
/** Selects a complete release set from registry metadata alone; the caller fetches only the chosen archives. `preferred` maps id to the pinned archive. */
export function selectReleases(
  requestsInput: readonly Dependency[],
  candidates: readonly MetadataCandidate[],
  engine: string,
  preferred: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, MetadataCandidate> {
  const requests = decodeDistributionRequests(requestsInput);
  if (candidates.length > 1000) fail('LIMIT-EXCEEDED', 'Release catalog exceeds 1000 candidates');
  return searchChoices(
    requests,
    candidates,
    (c) => c,
    engine,
    preferred,
    () => true,
  );
}
