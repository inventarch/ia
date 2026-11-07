import { commonRange, decodeDistributionRequests, DISTRIBUTION_LIMITS, satisfies } from '@inventarch/db/distribution';
import type { BundleMetadata, Dependency, DistributionLock } from '@inventarch/db/distribution';
import { acquireArtifact, readArtifactBytes } from './acquire.js';
import { inspectArchiveMetadata, verifyArchive } from './archive.js';
import type { VerifiedArchive } from './archive.js';
import { bytes, DistributionError, fail, workspace } from './files.js';
import { cacheArchive, cachePath, cacheSelectedArchiveClosure } from './install.js';
import type { ExpandedCollection } from './kit-collections.js';
import type { RegistryChoice } from './registry-config.js';
import { relabel } from './registry-layout.js';
import { matchRegistryRelease as matches } from './registry-admission.js';
import type { PackageIndex, RegistryRelease } from './registry-layout.js';
import { openRegistry, registryBudget, registryLocation } from './registry-source.js';
import type { Registry, RegistryBudget } from './registry-source.js';
import { selectCollectionRelease } from './registry-collections.js';
import { resolveReleases, selectReleases } from './resolve.js';
import type { MetadataCandidate, ReleaseCandidate } from './resolve.js';

/** Registry spec §7: delivers the exact bytes of a licensed release into the workspace cache and returns its sha256 location. */
export interface Acquirer {
  acquire(
    release: { id: string; version: string; archive: string; manifest: string },
    signal?: AbortSignal,
  ): Promise<{ location: `sha256:${string}` }>;
}
export interface RegistryResolveRequest {
  readonly allowKits?: boolean;
  readonly root: string;
  readonly requests: readonly Dependency[];
  readonly engine: string;
  /** The lock to prefer and to check against (§3 append-only rule). */
  readonly previous?: DistributionLock | undefined;
  /** §6.2 `update <id>`: this id's pin is dropped from the preference, so the newest satisfying release wins. It is always named. */
  readonly preferredExcept?: string | undefined;
  /**
   * §5.1: the ids the command names — `install`'s arguments, `update`'s id. Their indexes are always read. Absent, every
   * request id is named, which reads every request's index.
   */
  readonly named?: readonly string[] | undefined;
  /** One command's read-once chooser (`registryChooser`). */
  readonly choose: (id: string) => RegistryChoice;
  readonly acquirer?: Acquirer | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * The member ids the collection record keeps for each installed collection (and, for one whose identity is unknown,
   * both sides' members). When `allowKits` re-expands such a collection, its recorded members leave the requests first,
   * so the new members replace them instead of conflicting with them; a member another collection here still lists
   * stays, unless the same command expands that collection too.
   */
  readonly collectionMembers?: ReadonlyMap<string, readonly string[]> | undefined;
  /**
   * Lock requests the user named in an earlier command (the collection record's `named`, and any request no recorded
   * collection lists). They count as named here as well: re-expanding a collection keeps them, and a member range that
   * differs conflicts with them rather than narrowing them.
   */
  readonly direct?: readonly string[] | undefined;
}
/**
 * `candidates` are exactly the selected releases, admitted. A selected cached lock pin retains its manifest-level
 * metadata and the lock's own location. `sources` names the registry each selected id came from; a kept lock pin came
 * from none.
 */
export interface RegistryResolution {
  readonly expandedRequests?: readonly Dependency[];
  /** With `allowKits`: each collection the requests named, as it was expanded, for the collection record. */
  readonly expandedCollections?: readonly ExpandedCollection[];
  /**
   * With `allowKits`: the installed collections, not expanded here, whose member's range this command narrowed. Each
   * still accepts the member wherever it lands, so its row should be recorded again at the new pin rather than dropped.
   */
  readonly sharedHolders?: readonly string[];
  readonly candidates: readonly ReleaseCandidate<BundleMetadata>[];
  readonly sources: ReadonlyMap<string, RegistryChoice>;
}
/**
 * A kit's member range cannot be satisfied together with the range another installed collection left for that member:
 * no release both accept exists. The install refuses rather than move a member the other collection still lists.
 * `holders` are those collections, whose ranges re-expanding them together with the kit replaces.
 */
export class CollectionConflictError extends DistributionError {
  constructor(
    message: string,
    readonly member: string,
    readonly holders: readonly string[],
  ) {
    super('IA-DIST-CONFLICT', message);
    this.name = 'CollectionConflictError';
  }
}
type LockedPackage = DistributionLock['packages'][number];
/**
 * Registry spec §5.1: a locked package whose exact archive is in the workspace cache, passes byte-integrity checks against its digest, and
 * carries the manifest digest, id and version the lock pins. `unpublished` marks a null-provenance archive
 * (`source.repository === null`), which no registry can list (§8). A pin is usable only when its engine range also
 * admits the running engine (`usable`).
 */
interface CachedPin {
  readonly locked: LockedPackage;
  readonly release: BundleMetadata;
  readonly unpublished: boolean;
}
/** A cache file that exists but does not verify as its name says; a refusal that follows is located at it. */
interface CorruptPin {
  readonly corrupt: string;
}
const isRefusal = (error: unknown): error is Error & { code: string } =>
  error instanceof DistributionError ||
  (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('IA-'));
/**
 * The locked package's cached pin; `{ corrupt }` when the cache file exists but cannot be read or verified; undefined
 * when it is absent, or verifies but is not the release the lock pins (the lock, not the cache, is then the question).
 */
function inspectPin(root: string, locked: LockedPackage): CachedPin | CorruptPin | undefined {
  const path = cachePath(locked.archive);
  let archive: BundleMetadata;
  try {
    const content = bytes(root, path, DISTRIBUTION_LIMITS.compressed);
    if (content === null) return undefined;
    archive = inspectArchiveMetadata(content, locked.archive).pending;
  } catch (error) {
    if (isRefusal(error)) return { corrupt: path };
    throw error;
  }
  const { manifest, archiveDigest, manifestDigest } = archive;
  if (manifestDigest !== locked.manifest || manifest.id !== locked.id || manifest.version !== locked.version)
    return undefined;
  return Object.freeze({
    locked,
    release: Object.freeze({ manifest, archiveDigest, manifestDigest }),
    unpublished: manifest.source.repository === null,
  });
}
const isPin = (state: CachedPin | CorruptPin | undefined): state is CachedPin =>
  state !== undefined && 'locked' in state;
/** Registry spec §6.3: the locked ids whose cached archive is unpublished, so restore consults no registry for them. */
export function unpublishedPins(root: string, lock: DistributionLock): ReadonlySet<string> {
  const at = workspace(root);
  return new Set(
    lock.packages
      .filter((locked) => {
        const state = inspectPin(at, locked);
        return isPin(state) && state.unpublished;
      })
      .map((locked) => locked.id),
  );
}
interface Indexed {
  readonly choice: RegistryChoice;
  readonly registry: Registry;
  readonly index: PackageIndex;
}
/**
 * Registry spec §6.4 and §3: a configured base without `ia-registry.json` stays "Not a registry" (INPUT-INVALID), but
 * the built-in default that has not been provisioned is an unavailable resource, not a wrong URL.
 */
function open(choice: RegistryChoice, budget: RegistryBudget, signal: AbortSignal | undefined): Promise<Registry> {
  const missing =
    choice.level === 'default'
      ? (where: string): never =>
          fail(
            'ARTIFACT-UNAVAILABLE',
            `The default registry ${where} is not available; pass --registry, map the provider in .ia/registries.json, or use --catalog`,
          )
      : undefined;
  return openRegistry(choice.base, { budget, signal, missing });
}
/** One command's registries: each distinct base is opened once, and every read draws on one shared budget (§5.1). */
function registries(
  choose: (id: string) => RegistryChoice,
  signal: AbortSignal | undefined,
): (id: string) => Promise<Indexed> {
  const budget: RegistryBudget = registryBudget(),
    opened = new Map<string, Registry>();
  return async (id) => {
    const choice = choose(id),
      key = registryLocation(choice.base);
    let registry = opened.get(key);
    if (registry === undefined) {
      registry = await open(choice, budget, signal);
      opened.set(key, registry);
    }
    return { choice, registry, index: await registry.index(id) };
  };
}
const pin = (id: string, version: string): string => `${id}@${version}`;
/** §3: a version's digests never change. */
function unchanged(id: string, release: RegistryRelease, locked: { archive: string; manifest: string }): void {
  if (release.archive !== locked.archive || release.manifest !== locked.manifest)
    fail('CONFLICT', `Registry changed the bytes of a published release: ${pin(id, release.version)}`);
}
/** §7: a licensed release through the acquirer, which must cache exactly the named archive and return its sha256 location. */
async function acquired(
  root: string,
  acquirer: Acquirer,
  id: string,
  entry: RegistryRelease,
  signal: AbortSignal | undefined,
): Promise<{ release: VerifiedArchive; location: string }> {
  const { version, archive, manifest } = entry,
    at = pin(id, version);
  let result: unknown;
  try {
    result = await acquirer.acquire({ id, version, archive, manifest }, signal);
  } catch (error) {
    // A caller abort and a coded refusal pass through; anything else is the acquirer failing to deliver.
    if (
      signal?.aborted === true ||
      error instanceof DistributionError ||
      (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('IA-'))
    )
      throw error;
    return fail(
      'ARTIFACT-UNAVAILABLE',
      `Acquirer failed for ${at}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const location =
    result !== null && typeof result === 'object' ? (result as { location?: unknown }).location : undefined;
  if (location !== `sha256:${archive}`)
    fail('INTEGRITY-MISMATCH', `Acquirer did not return sha256:${archive} for ${at}`);
  const content = bytes(root, cachePath(archive), DISTRIBUTION_LIMITS.compressed);
  if (content === null) fail('ARTIFACT-UNAVAILABLE', `Acquirer did not cache ${at} (${archive})`);
  return { release: relabel(() => verifyArchive(content, archive), `${at}: `), location };
}
/**
 * Registry spec §5.1-5.3: reads the metadata closure, selects on metadata with the shared search, then fetches and
 * verifies only the selected archives. Feeding `candidates` to the unchanged `resolveReleases` reproduces the selection.
 */
export async function resolveFromRegistries(request: RegistryResolveRequest): Promise<RegistryResolution> {
  request.signal?.throwIfAborted();
  const root = workspace(request.root),
    verified = new Map<string, CachedPin>(),
    corrupt: string[] = [];
  for (const locked of request.previous?.packages ?? []) {
    const state = inspectPin(root, locked);
    if (isPin(state)) verified.set(locked.id, state);
    else if (state !== undefined) corrupt.push(state.corrupt);
  }
  // A corrupt cached pin falls back to a registry lookup. If that fails too, the refusal is located at the corrupt cache
  // file, whose repair (delete it) is what a user can do; a refusal already located elsewhere keeps its location.
  try {
    return await resolveWithPins(request, root, verified);
  } catch (error) {
    if (corrupt.length === 0 || !isRefusal(error) || (error as { path?: unknown }).path !== undefined) throw error;
    throw new DistributionError(error.code, error.message, corrupt[0]);
  }
}
async function resolveWithPins(
  request: RegistryResolveRequest,
  root: string,
  verified: ReadonlyMap<string, CachedPin>,
): Promise<RegistryResolution> {
  const { signal, engine, previous, acquirer } = request;
  const requests = [...decodeDistributionRequests(request.requests)],
    read = registries(request.choose, signal);
  // §5.1: a usable cached pin is a verified cached lock pin whose engine range admits the running engine; each is a
  // candidate at the lock's own location. One the engine no longer admits is looked up like an uncached pin.
  const pins = new Map([...verified].filter(([, pin]) => satisfies(engine, pin.release.manifest.engine)));
  const named = new Set([
    ...(request.named ?? requests.map((r) => r.id)),
    ...(request.preferredExcept === undefined ? [] : [request.preferredExcept]),
  ]);
  // The ids the caller says the command itself names (`request.named` as given, and `preferredExcept`, which is always
  // named; never the index-lookup default above, which reads every request's index and says nothing about who asked for
  // it), the requests an earlier command named (`request.direct`), and the member ids each expansion in this command
  // introduces: none is a request an earlier expansion merely left behind.
  const explicit = new Set([
      ...(request.named ?? []),
      ...(request.preferredExcept === undefined ? [] : [request.preferredExcept]),
      ...(request.direct ?? []),
    ]),
    introduced = new Set<string>();
  // §5.2: the closure follows only releases selection could pick for some known constraint: not withdrawn, admitted by the
  // engine, and inside a range a request or a followed release places on the id. A locked version counts as known, so the
  // pin stays selectable and preferred. Licensed releases are followed too, so a licensed-only need can be named (§7).
  const known = new Map<string, { readonly ranges: Set<string>; readonly pinned: Set<string> }>(),
    indexed = new Map<string, Indexed>();
  const expanded: { readonly id: string; readonly version: string; readonly registry: string; members: string[] }[] =
    [];
  // A kit that is a member of a kit this command expands is expanded in its turn; its members are recorded on that
  // outer collection in its place, so a row names only ids the lock holds.
  const nestedIn = new Map<string, (typeof expanded)[number]>();
  // Installed collections whose member this command narrowed, for `sharedHolders`.
  const narrowed = new Set<string>();
  const pending: string[] = [],
    queued = new Set<string>(),
    followed = new Set<RegistryRelease>(),
    followedPins = new Set<string>();
  // §5.1: an id's index is read when the command names it, when it has no usable cached pin, or once a known range
  // excludes the pin's version. Otherwise the pin answers for it and no registry is consulted.
  const mustRead = (id: string, ranges: ReadonlySet<string>): boolean => {
    const pin = pins.get(id);
    return pin === undefined || named.has(id) || [...ranges].some((r) => !satisfies(pin.locked.version, r));
  };
  const need = (id: string, range: string | null, version: string | null): void => {
    let entry = known.get(id),
      grew = entry === undefined;
    if (entry === undefined) {
      entry = { ranges: new Set(), pinned: new Set() };
      known.set(id, entry);
    }
    if (range !== null && !entry.ranges.has(range)) {
      entry.ranges.add(range);
      grew = true;
    }
    if (version !== null && !entry.pinned.has(version)) {
      entry.pinned.add(version);
      grew = true;
    }
    // An index already read is re-scanned for the new constraint, as before.
    if (grew && !queued.has(id) && (indexed.has(id) || mustRead(id, entry.ranges))) {
      queued.add(id);
      pending.push(id);
    }
    // A cached pin is a candidate, so its own dependencies join the closure (once).
    const pin = pins.get(id);
    if (pin !== undefined && !followedPins.has(id)) {
      followedPins.add(id);
      for (const d of pin.release.manifest.dependencies) need(d.id, d.range, null);
    }
  };
  const admissible = (id: string, release: RegistryRelease): boolean => {
    const entry = known.get(id);
    return (
      entry !== undefined &&
      !release.withdrawn &&
      satisfies(engine, release.engine) &&
      (entry.pinned.has(release.version) || [...entry.ranges].some((r) => satisfies(release.version, r)))
    );
  };
  // The range that says what two collections sharing a member both accept, or null when no release both accept exists:
  // a real release that selection could pick (or a pin it could keep) has to answer, since ranges that merely overlap
  // would otherwise reach the search and refuse without naming a holder. The index read here is the one the command's
  // naming of this member reads anyway, and it is queued so its releases are followed.
  const sharedRange = async (id: string, left: string, right: string): Promise<string | null> => {
    const common = commonRange(left, right);
    if (common === null) return null;
    const source = indexed.get(id) ?? (await read(id));
    indexed.set(id, source);
    if (!queued.has(id)) {
      queued.add(id);
      pending.push(id);
    }
    const { releases } = source.index,
      both = (version: string): boolean => satisfies(version, left) && satisfies(version, right),
      pin = pins.get(id);
    const answered =
      releases.some((r) => !r.withdrawn && satisfies(engine, r.engine) && both(r.version)) ||
      (pin !== undefined &&
        both(pin.locked.version) &&
        !releases.some((r) => r.archive === pin.locked.archive && r.withdrawn));
    return answered ? common : null;
  };
  for (const r of requests) need(r.id, r.range, null);
  for (const p of previous?.packages ?? []) need(p.id, null, p.version);
  while (pending.length) {
    const id = pending.shift()!;
    queued.delete(id);
    // Each index is read once per command; a new range for an id re-scans the index already held.
    let entry = indexed.get(id);
    if (entry === undefined) {
      entry = await read(id);
      indexed.set(id, entry);
    }
    // An explicit install may name a kit only when no release index owns that id.
    // Members remain ordinary verified distributions; a kit grants no execution or registry credentials.
    const direct = requests.findIndex((item) => item.id === id);
    if (request.allowKits && direct >= 0 && named.has(id) && entry.index.releases.length === 0) {
      const kitIndex = await entry.registry.index('kit', id);
      if (kitIndex.releases.length) {
        const kit = selectCollectionRelease(kitIndex, requests[direct]!.range);
        requests.splice(direct, 1);
        // Re-expanding a collection replaces the member requests its earlier expansion left: they leave the requests
        // (one the new release no longer lists stays locked only while something depends on it), so a changed range is
        // not a conflict. A request this command names itself, or one another collection's expansion in this command
        // introduced, is not inherited and stays. So does a member another installed collection still lists, unless this
        // command expands that collection too (it is expanded already, or its id is still a request waiting to be): one
        // collection's install never drops another's constraint. A request the user named conflicts on any other range;
        // a member a collection left takes the range both accept, and conflicts only when no release satisfies both.
        // A member an installed collection still waiting to be expanded recorded leaves as well: that expansion would
        // drop it anyway, so its old range never constrains this kit's.
        const recorded = new Set(request.collectionMembers?.get(id) ?? []);
        const held = new Map<string, string[]>();
        for (const [other, members] of request.collectionMembers ?? [])
          if (other === id || expanded.some((collection) => collection.id === other)) continue;
          else if (requests.some((item) => item.id === other)) for (const member of members) recorded.add(member);
          else for (const member of members) held.set(member, [...(held.get(member) ?? []), other].sort());
        for (let at = requests.length - 1; at >= 0; at -= 1) {
          const member = requests[at]!.id;
          if (recorded.has(member) && !explicit.has(member) && !introduced.has(member) && !held.has(member))
            requests.splice(at, 1);
        }
        const outer = explicit.has(id) ? undefined : nestedIn.get(id),
          ids = kit.distributions.map((member) => member.id);
        const row = outer ?? { id, version: kit.version, registry: registryLocation(entry.registry.base), members: [] };
        if (outer === undefined) expanded.push(row);
        row.members = [...new Set([...row.members.filter((member) => member !== id), ...ids])].sort();
        for (const member of ids) nestedIn.set(member, row);
        for (const member of kit.distributions) {
          const existing = requests.find((item) => item.id === member.id);
          const holders = held.get(member.id);
          if (existing && existing.range !== member.range) {
            const left = !explicit.has(member.id) && (holders !== undefined || introduced.has(member.id)),
              common = left ? await sharedRange(member.id, existing.range, member.range) : null;
            if (common === null && holders !== undefined && !explicit.has(member.id))
              throw new CollectionConflictError(
                `Kit ${id} ${kit.version} lists ${member.id} ${member.range}, but installed ${holders.length === 1 ? 'collection' : 'collections'} ${holders.join(', ')} ${holders.length === 1 ? 'lists' : 'list'} it at ${existing.range}`,
                member.id,
                holders,
              );
            if (common === null) fail('CONFLICT', `Kit conflicts with direct request ${member.id}`);
            requests[requests.indexOf(existing)] = { id: member.id, range: common };
            for (const holder of holders ?? []) narrowed.add(holder);
          }
          if (!existing) requests.push(member);
          named.add(member.id);
          need(member.id, member.range, null);
        }
        // Only after the loop: `introduced` asks whether an earlier expansion left a member, not this kit.
        for (const member of kit.distributions) introduced.add(member.id);
        // A request set is sorted by id, which members appended after other requests would break.
        requests.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
    }
    for (const release of entry.index.releases)
      if (!followed.has(release) && admissible(id, release)) {
        followed.add(release);
        for (const d of release.dependencies) need(d.id, d.range, null);
      }
  }
  // §3: a pinned version whose digests changed is a conflict; an absent one is not, since the id may have been re-resolved.
  // An unpublished cached pin is exempt: no registry can list it, so a same-version entry is some other release.
  for (const locked of previous?.packages ?? []) {
    if (verified.get(locked.id)?.unpublished === true) continue;
    const release = indexed.get(locked.id)?.index.releases.find((r) => r.version === locked.version);
    if (release) unchanged(locked.id, release, locked);
  }
  const expandedResult = (): Pick<RegistryResolution, 'expandedRequests' | 'expandedCollections' | 'sharedHolders'> =>
    request.allowKits
      ? {
          expandedRequests: requests,
          expandedCollections: expanded,
          sharedHolders: [...narrowed].filter((id) => !expanded.some((row) => row.id === id)).sort(),
        }
      : {};
  // §5.2: only admissible releases reach the search, which would drop the rest anyway, so its 1,000-candidate bound counts real options.
  type Origin =
    | { readonly kind: 'registry'; readonly entry: RegistryRelease; readonly source: Indexed }
    | { readonly kind: 'pin'; readonly pin: CachedPin };
  const origin = new Map<MetadataCandidate, Origin>();
  const registryLocationOf = (source: Indexed, entry: RegistryRelease): string | undefined =>
    entry.access !== 'public'
      ? undefined
      : source.registry.base.kind === 'https'
        ? source.registry.artifactUrl(entry.archive)
        : `sha256:${entry.archive}`;
  // §5.1: one candidate per cached pin the closure reached. A registry release naming the same archive is the same
  // release: the registry's candidate is kept only when its location equals the lock's, otherwise the pin (and its
  // location) is. A pin is withdrawn only when its id's index was read and marks that archive withdrawn.
  const pinned = new Map<string, { readonly pin: CachedPin; readonly withdrawn: boolean }>();
  for (const [id, pin] of pins) {
    if (!known.has(id)) continue;
    const source = indexed.get(id),
      entry = source?.index.releases.find((r) => r.archive === pin.locked.archive);
    if (
      source !== undefined &&
      entry !== undefined &&
      admissible(id, entry) &&
      registryLocationOf(source, entry) === pin.locked.location
    )
      continue;
    pinned.set(id, { pin, withdrawn: entry?.withdrawn ?? false });
  }
  // Pins come first. The search orders by preference, then version, and is otherwise stable, so the one tie left — an
  // unpublished pin and a registry release of the same version with other bytes (a published pin with that tie is an
  // append-only conflict, §3) — keeps the pin, even for the id `update` names (§5.1).
  const view = (licensed: boolean): MetadataCandidate[] => [
    ...[...pinned].map(([id, { pin, withdrawn }]) => {
      const { manifest } = pin.release;
      const candidate: MetadataCandidate = {
        id,
        version: manifest.version,
        engine: manifest.engine,
        dependencies: manifest.dependencies,
        archive: pin.locked.archive,
        withdrawn,
      };
      origin.set(candidate, { kind: 'pin', pin });
      return candidate;
    }),
    ...[...indexed].flatMap(([id, source]) =>
      source.index.releases
        .filter(
          (r) =>
            (r.access === 'public' || licensed) &&
            admissible(id, r) &&
            pinned.get(id)?.pin.locked.archive !== r.archive,
        )
        .map((entry) => {
          const candidate: MetadataCandidate = {
            id,
            version: entry.version,
            engine: entry.engine,
            dependencies: entry.dependencies,
            archive: entry.archive,
            withdrawn: entry.withdrawn,
          };
          origin.set(candidate, { kind: 'registry', entry, source });
          return candidate;
        }),
    ),
  ];
  const licensedPick = (c: MetadataCandidate): boolean => {
    const found = origin.get(c)!;
    return found.kind === 'registry' && found.entry.access === 'licensed';
  };
  const preferred = new Map(
    (previous?.packages ?? []).filter((p) => p.id !== request.preferredExcept).map((p) => [p.id, p.archive]),
  );
  let selected: ReadonlyMap<string, MetadataCandidate>;
  try {
    selected = selectReleases(requests, view(acquirer !== undefined), engine, preferred);
  } catch (error) {
    if (acquirer !== undefined || !(error instanceof DistributionError) || error.code !== 'IA-DIST-CONFLICT')
      throw error;
    // §7: rerun with licensed releases admitted. If that succeeds, name each licensed pick that is individually necessary:
    // with that id's licensed releases removed (everything else, licensed included, kept), selection fails with CONFLICT.
    // One re-selection per licensed pick. When none is individually necessary (only a set of them is), name them all.
    let licensed: MetadataCandidate[];
    try {
      licensed = [...selectReleases(requests, view(true), engine, preferred).values()].filter(licensedPick);
    } catch {
      throw error;
    }
    if (!licensed.length) throw error;
    const necessary = licensed.filter((pick) => {
      try {
        selectReleases(
          requests,
          view(true).filter((c) => c.id !== pick.id || !licensedPick(c)),
          engine,
          preferred,
        );
        return false;
      } catch (without) {
        if (without instanceof DistributionError && without.code === 'IA-DIST-CONFLICT') return true;
        throw error;
      }
    });
    const needed = (necessary.length ? necessary : licensed).map((c) => pin(c.id, c.version)).sort();
    return fail(
      'LICENSE-REQUIRED',
      `${needed.join(', ')} ${needed.length === 1 ? 'is available only as a licensed release' : 'are available only as licensed releases'}; this CLI has no licensed acquisition path`,
    );
  }
  // Public selection obtains all bounded bytes before contextual admission or any new cache effects.
  // The legacy licensed callback has cache effects by contract; it keeps its standalone path below.
  if (![...selected.values()].some(licensedPick)) {
    const pending: ReleaseCandidate<BundleMetadata>[] = [],
      archives = new Map<string, Uint8Array>();
    const sources = new Map<string, RegistryChoice>();
    let total = 0;
    for (const [id, chosen] of [...selected].sort(([a], [b]) => (a < b ? -1 : 1))) {
      signal?.throwIfAborted();
      const found = origin.get(chosen)!;
      let content: Buffer, location: string, release: BundleMetadata;
      if (found.kind === 'pin') {
        content =
          bytes(root, cachePath(found.pin.locked.archive), DISTRIBUTION_LIMITS.compressed) ??
          fail('RESTORE-REQUIRED', `Missing selected cache archive ${found.pin.locked.archive}`);
        release = inspectArchiveMetadata(content, found.pin.locked.archive).pending;
        if (release.manifestDigest !== found.pin.locked.manifest)
          fail('INTEGRITY-MISMATCH', 'Selected cache manifest changed');
        location = found.pin.locked.location;
      } else {
        const { entry, source } = found;
        location =
          source.registry.base.kind === 'https'
            ? source.registry.artifactUrl(entry.archive)
            : `sha256:${entry.archive}`;
        content =
          source.registry.base.kind === 'https'
            ? await readArtifactBytes({ root, url: location, digest: entry.archive, signal })
            : source.registry.artifactBytes(entry.archive);
        release = matches(id, entry, inspectArchiveMetadata(content, entry.archive).pending);
        sources.set(id, source.choice);
      }
      total += content.length;
      if (total > DISTRIBUTION_LIMITS.expanded)
        fail('LIMIT-EXCEEDED', 'Combined registry archive selection exceeds its ceiling');
      archives.set(release.archiveDigest, content);
      pending.push({ release, location, withdrawn: false });
    }
    const resolved = resolveReleases(requests, pending, engine);
    signal?.throwIfAborted();
    const admitted = cacheSelectedArchiveClosure(root, resolved.lock, archives);
    return {
      ...expandedResult(),
      candidates: pending.map((candidate) => ({ ...candidate, release: admitted.get(candidate.release.manifest.id)! })),
      sources,
    };
  }
  // §5.3: only the selected archives are fetched and verified, in id order.
  const candidates: ReleaseCandidate<BundleMetadata>[] = [],
    sources = new Map<string, RegistryChoice>();
  for (const [id, chosen] of [...selected].sort(([a], [b]) => (a < b ? -1 : 1))) {
    signal?.throwIfAborted();
    const found = origin.get(chosen)!;
    // A kept lock pin on the legacy licensed path must pass standalone admission; it keeps the lock's location and came from no registry.
    if (found.kind === 'pin') {
      const content =
        bytes(root, cachePath(found.pin.locked.archive), DISTRIBUTION_LIMITS.compressed) ??
        fail('RESTORE-REQUIRED', 'Missing selected cached pin');
      const release = verifyArchive(content, found.pin.locked.archive);
      candidates.push({ release, location: found.pin.locked.location, withdrawn: false });
      continue;
    }
    const { entry, source } = found,
      { archive } = entry;
    let release: VerifiedArchive, location: string;
    if (entry.access === 'licensed') ({ release, location } = await acquired(root, acquirer!, id, entry, signal));
    else if (source.registry.base.kind === 'https')
      ({ release, location } = await acquireArtifact({
        root,
        url: source.registry.artifactUrl(archive),
        digest: archive,
        signal,
      }));
    else {
      release = cacheArchive(root, source.registry.artifactBytes(archive), archive);
      location = `sha256:${archive}`;
    }
    candidates.push({ release: matches(id, entry, release), location, withdrawn: entry.withdrawn });
    sources.set(id, source.choice);
  }
  return {
    candidates,
    sources,
    ...expandedResult(),
  };
}
/**
 * Registry spec §6.3: reads each locked package's index and returns the `id@version` pins it marks withdrawn. A locked
 * version the index no longer lists, or lists with different digests, is a conflict. A locked package whose cached
 * archive is unpublished (null provenance) is skipped: no registry lists it, so none can withdraw it. A package that is
 * not cached (a fresh clone) is read like any other.
 */
export async function registryWithdrawals(
  root: string,
  lock: DistributionLock,
  choose: (id: string) => RegistryChoice,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  const at = workspace(root);
  const read = registries(choose, signal),
    withdrawn: string[] = [];
  for (const locked of lock.packages) {
    const state = inspectPin(at, locked);
    if (isPin(state) && state.unpublished) continue;
    const release = (await read(locked.id)).index.releases.find((r) => r.version === locked.version);
    if (release === undefined)
      fail('CONFLICT', `Registry no longer lists the locked release: ${pin(locked.id, locked.version)}`);
    unchanged(locked.id, release, locked);
    if (release.withdrawn) withdrawn.push(pin(locked.id, locked.version));
  }
  return withdrawn;
}
