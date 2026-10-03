/**
 * `ia install`, `ia update`, `ia remove`, `ia restore`:
 * docs/specs/consumer-cli-contract/README.md §§2.8–2.11.
 *
 * One shape, one set of flags, one plan/apply rule. Without `--apply` the command plans and renders; with
 * `--apply` it plans and applies in one invocation and the installer re-checks every input between the two.
 * Planning and applying are two functions here for the reason §2.8 rule 3 gives: on a terminal without `--yes`
 * the change summary is shown and one question is asked between them, and a declined answer leaves the plan
 * unapplied at exit 0. The other half of rule 3 — `--apply` with no terminal and no `--yes`, and `--apply --json`
 * without `--yes`, are usage errors — is enforced at parse time in consumer.ts, which is what keeps §3's promise
 * that an exit 2 read nothing and wrote nothing. By the time a handler runs, an unconfirmable apply is already
 * gone, so reaching the question here means the question can be both asked and answered.
 *
 * The change table is a join the renderer performs: `changes` is four arrays of package ids and nothing else, so
 * the version, digest and origin columns come from the plan's own lock, and an id in neither lock prints an em
 * dash rather than a guess.
 *
 * Sources: docs/specs/registry/README.md §§4–6. Without `--catalog` or `--offline`, `install` and `update`
 * resolve from registries. One chooser per command picks each id's registry by §4's precedence — `--registry`,
 * `IA_REGISTRY`, `.ia/registries.json`, the user's `registries.json`, the built-in default — and reads that
 * configuration once; its inputs are the host's environment and cwd, never the process's. `--offline` without
 * `--catalog` resolves from the workspace's cached archives, reaching only the requested and locked ids and their
 * dependencies (§5.4). `update` without `--to` keeps the request's range and drops only that id's pin from the
 * preference, so the newest release in range wins (§6.2). `restore`, online and without `--catalog`, asks each locked
 * package's registry whether its release was withdrawn before it re-acquires anything (§6.3). `remove` reads only
 * the lock and never chooses a registry.
 *
 * Registered host projections (docs/specs/host-registration/README.md §4, "install, update, remove"):
 * a workspace that owns a projection for a host — its `<host>-projection.json` state exists — lists installed
 * distributions in it, so a change to the installed set changes the projection. `--apply` refuses before anything is
 * acquired or written when an owned projection file was edited by hand, because the refresh would refuse it, and
 * re-renders each registered projection after the install commits. MCP and hook entries do not depend on the
 * installed set and are not touched. `restore` reinstalls the locked generation, whose admitted systems are
 * unchanged, so it neither checks nor refreshes. A refresh that fails after the install committed cannot undo the
 * install, and it is not hidden either: like `ia init --host` after initialization, the command refuses at class 3
 * with the service's code, message and file, and its next action opens "The installation is applied." before the
 * repair, so a script sees the failure and a reader sees what did happen. `ia doctor` reports the drift until then.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORKSPACE_PROJECTION_MARKER } from '@inventarch/compliance';
import {
  canonicalDistributionJson,
  decodeDistributionRequests,
  DISTRIBUTION_ENGINE_VERSION,
  INSTALL_PATHS,
} from '@inventarch/db/distribution';
import type { Dependency, DistributionLock } from '@inventarch/db/distribution';
import { ARCHIVE_CACHE, applyInstallation, planInstallation } from '@inventarch/distribution/install';
import type { InstallationPlan } from '@inventarch/distribution/install';
import type { ProjectionDrift } from '@inventarch/distribution/projection';
import { applyProjection, observeProjection, planProjection } from '@inventarch/distribution/projection';
import {
  registryChooser,
  registryLocation,
  registryWithdrawals,
  resolveFromRegistries,
  unpublishedPins,
} from '@inventarch/distribution/registry';
import type { RegistryChoice, RegistryLevel } from '@inventarch/distribution/registry';
import { resolveReleases } from '@inventarch/distribution/resolve';
import { WORKSPACE_HOSTS } from '@inventarch/distribution/hosts';
import type { BundleMetadata, ReleaseCandidate } from '@inventarch/distribution/services';
import {
  acquireArtifact,
  cachedCandidates,
  planRestore,
  pruneLockRequest,
  readInstalledState,
  readWorkspaceJson,
  readWorkspaceLock,
  resolveCatalog,
  writeWorkOutput,
} from '@inventarch/distribution/services';
import { UsageError } from './args.js';
import type { Context, Host, Result } from './consumer.js';
import { confirm, Refusal, refusalOf, requireRoot } from './consumer.js';
import type { HostName } from './host-projection.js';
import { renderProjectionFor } from './host-projection.js';
import { hostNext, lockRefusal, projectionRepair, refusedPath, STATE } from './host.js';
import { codeOf } from './session.js';
import type { Capabilities, SymbolName } from './render.js';
import {
  atom,
  commandFacts,
  document,
  entry,
  fieldRows,
  headerLine,
  quote,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';

export type Operation = 'install' | 'update' | 'remove' | 'restore';
/** §2.8: the id grammar is `provider/name`, and a positional may pin it with `@<range>`. */
export const REQUEST = /^([a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*)(?:@(.+))?$/;
/** A positional with no range asks for whatever the source offers; nothing in the tree supplies another default. */
export const ANY_VERSION = '*';

export interface Applied {
  readonly status: string;
  readonly generation: string;
  readonly counter: number;
  readonly host: string;
}
export interface ChangeRow {
  readonly kind: 'added' | 'removed' | 'updated' | 'shadowed';
  readonly id: string;
  readonly version: string;
  readonly archive: string | null;
  readonly origin: string;
}
/**
 * Registry spec §6.1: the registry that answered for one provider — its HTTPS URL or absolute directory — and the §4
 * level that chose it (`flag`, `env`, `workspace`, `user` or `default`).
 */
export interface RegistrySource {
  readonly provider: string;
  readonly base: string;
  readonly level: RegistryLevel;
}
export interface PlanView {
  readonly operation: Operation;
  readonly root: string;
  readonly plan: InstallationPlan;
  readonly rows: readonly ChangeRow[];
  readonly applied: Applied | null;
  /** Accepted withdrawn releases: bare ids from a catalog restore, `id@version` pins from a registry restore. */
  readonly withdrawn: readonly string[];
  /** The registries this command read, one per provider, sorted; empty when a catalog or the cache was the source. */
  readonly registries: readonly RegistrySource[];
  /** The exact command that would apply this plan; §7.6's `\` breaks are chosen here, not by the wrapper. */
  readonly invocation: string;
  readonly planOut: string | null;
  /** Hosts whose projection this workspace owns; `applyPlan` refreshes each after the install commits. */
  readonly refresh: readonly HostName[];
  /** Whether `--root` was given, so every `ia host` command printed carries it (`rootedNext`). */
  readonly rooted: boolean;
}

const SYMBOL: Readonly<Record<ChangeRow['kind'], SymbolName>> = {
  added: 'added',
  removed: 'removed',
  updated: 'updated',
  shadowed: 'info',
};

/** §2.8's join. `changes` carries ids; every other column is looked up, and an absent value is never invented. */
export function changeRows(plan: InstallationPlan, previous: DistributionLock | undefined): readonly ChangeRow[] {
  const rows: ChangeRow[] = [];
  const direct = new Set(plan.lock.requests.map((request) => request.id));
  for (const kind of ['added', 'removed', 'updated', 'shadowed'] as const)
    for (const id of plan.changes[kind]) {
      const locked = plan.lock.packages.find((pkg) => pkg.id === id) ?? previous?.packages.find((pkg) => pkg.id === id);
      const required = plan.lock.packages
        .filter((pkg) => pkg.dependencies.includes(id))
        .map((pkg) => pkg.id)
        .sort()[0];
      rows.push({
        kind,
        id,
        version: locked?.version ?? '—',
        archive: locked?.archive ?? null,
        origin: direct.has(id) ? 'direct' : required === undefined ? 'no longer required' : `required by ${required}`,
      });
    }
  return rows;
}

/**
 * Acquisition is the only phase that can reach class 4, so it is the only phase wrapped. A DistributionError keeps
 * its own code (§4.1). The service reports a transport failure — DNS, TLS, or its own 30-second timeout — as
 * IA-DIST-ARTIFACT-UNAVAILABLE naming the URL (registry spec §6.4); anything that still arrives without an IA code
 * is reported as a CLI failure at class 4 rather than relabelled with a service code the service never raised.
 *
 * The next action depends on the route the failure arrived on, because the repair does. On the catalog route the
 * archive remedy applies: retry, or name the archive in a local catalog entry and resolve from that catalog offline.
 * On the registry route — the default since registry discovery — a catalog-only remedy is wrong twice over: `--offline`
 * without `--catalog` reads no catalog, and the failure is the registry's. Registry-route failures therefore name the
 * registry sources, whether the failure was an index, `ia-registry.json` ("Registry request …") or an artifact fetched
 * from an HTTPS registry ("Artifact request …"). The other registry failures each have their own remedy: the built-in
 * default that is not available ("The default registry …"), a document over the 4 MiB bound ("Registry document …",
 * a limit a retry cannot fix), and a directory registry that lists a release whose artifact file it lacks. All of
 * these stay class 4: remote or registry content the user cannot fix in the workspace. Two registry refusals are
 * class 3 and carry the remedy §4 and §7 name for them: an unmapped provider, and a request only a licensed release
 * satisfies.
 *
 * Every other refusal passes through with its code and class, located at the file it names when the service located
 * it (`.path`, e.g. `.ia/registries.json`), so §4.3's `where` is null only when there is genuinely no location.
 */
export type Route = 'catalog' | 'registry';
const RETRY =
  'Retry when the host is reachable, or add the archive to a local catalog entry {"path":"...","withdrawn":false} and re-run with --catalog <file> --offline.';
const REGISTRY_RETRY =
  'Check network access to the registry named above, or pass --registry <url|dir>, map the provider in .ia/registries.json, or use --catalog <file>.';
const DEFAULT_RETRY =
  'Pass --registry <url|dir>, map the provider to a registry in .ia/registries.json, or install from a local catalog with --catalog <file>.';
const OVERSIZE =
  'The registry named above serves a document over the 4 MiB limit, and retrying will not change that. Choose another registry with --registry <url|dir> or .ia/registries.json, or use --catalog <file>.';
const INCOMPLETE =
  'That registry directory is incomplete: it lists a release whose artifact file is missing. Re-add the release with "ia-distribution registry add --registry <dir> --archive <file>", or choose another registry with --registry <url|dir> or .ia/registries.json.';
/** Registry spec §4's remedy for an unmapped provider; `ia doctor` names the same one. */
export const UNMAPPED =
  "Every requested and locked package's provider needs a registry. Map the provider to an HTTPS URL or a workspace directory in .ia/registries.json, or pass --registry <url|dir>.";
const LICENSED =
  'This CLI has no licensed acquisition path. Obtain the archive through its licensed channel, then install it from a local catalog with --catalog <file>.';
const REMOTE_LIMIT = /^(?:Remote archive|Registry document) /;
const SERVICE_CODE = /^IA-[A-Z]+-[A-Z-]+$/;
/** The repair for a cached archive that does not verify: the cache holds copies, and the consumer has no verb that cleans it. */
const deleteCached = (path: string): string =>
  `Delete ${path}, then re-run the command; a published archive is fetched again from its registry or catalog.`;
function unavailable(message: string, route: Route): string {
  if (message.startsWith('The default registry ')) return DEFAULT_RETRY;
  if (message.startsWith('Registry document ')) return OVERSIZE;
  if (message.startsWith('Registry request ')) return REGISTRY_RETRY;
  if (/^Registry .+ has no artifacts\//.test(message)) return INCOMPLETE;
  return route === 'registry' ? REGISTRY_RETRY : RETRY;
}
async function acquiring<T>(run: () => Promise<T>, where: string | null, route: Route): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = codeOf(error, ''),
      message = error instanceof Error ? error.message : String(error);
    // Only a service refusal (an IA code, §4.1) is located at the file it names. A Node error also carries `.path`, but
    // its code is not one the envelope may carry, so it is left to `refusalOf`, which reports it as IA-CLI-FAILED.
    const own = SERVICE_CODE.test(code) ? refusedPath(error) : null;
    const located = own ?? where;
    const at = located === null ? null : { path: located };
    // A refusal located at a cached archive (a corrupt cached lock pin, registry spec §5.1) is repaired by deleting it.
    const cachedFile = own !== null && own.startsWith(`${ARCHIVE_CACHE}/`) ? own : null;
    if (code === 'IA-DIST-ARTIFACT-UNAVAILABLE' || (code === 'IA-DIST-LIMIT-EXCEEDED' && REMOTE_LIMIT.test(message)))
      throw new Refusal(
        code,
        message,
        4,
        at,
        cachedFile !== null ? deleteCached(cachedFile) : unavailable(message, route),
      );
    if (code === '')
      throw new Refusal(
        'IA-CLI-FAILED',
        `Artifact transport failed: ${message}`,
        4,
        at,
        route === 'registry' ? REGISTRY_RETRY : RETRY,
      );
    if (code === 'IA-DIST-REGISTRY-UNMAPPED') throw new Refusal(code, message, 3, at, UNMAPPED);
    if (code === 'IA-DIST-LICENSE-REQUIRED') throw new Refusal(code, message, 3, at, LICENSED);
    // A service refusal the service located keeps its code and class 3, and gains its location (§4.3).
    if (!(error instanceof Refusal) && own !== null)
      throw new Refusal(code, message, 3, at, cachedFile !== null ? deleteCached(cachedFile) : null);
    throw error;
  }
}
/**
 * Registry spec §5.4: `--offline` without `--catalog` resolves from the workspace cache, reaching only the ids this
 * command can need — its requests, the lock's packages and their dependencies — so an unrelated stale duplicate in
 * the cache never reaches resolution. A cached file that cannot be read is located, and its repair is to delete it:
 * the cache holds copies, and the consumer has no verb that cleans it. A cache over its bound names the directory
 * and the two online sources.
 */
function cached(root: string, reach: readonly string[]): readonly ReleaseCandidate<BundleMetadata>[] {
  try {
    return cachedCandidates({ root, reach });
  } catch (error) {
    const refusal = refusalOf(error),
      path = refusedPath(error);
    if (path !== null && path.startsWith(`${ARCHIVE_CACHE}/`))
      throw new Refusal(refusal.code, refusal.message, 3, { path }, deleteCached(path));
    if (refusal.code === 'IA-DIST-LIMIT-EXCEEDED')
      throw new Refusal(
        refusal.code,
        refusal.message,
        3,
        null,
        `Remove archives this workspace no longer needs from ${ARCHIVE_CACHE}/, or resolve online with --registry <url|dir> or --catalog <file> instead of --offline.`,
      );
    throw error;
  }
}
/** §6.1's registry rows: one per provider and base, in provider order, so the plan reads the same on every run. */
function registrySources(choices: Iterable<RegistryChoice>): readonly RegistrySource[] {
  const unique = new Map<string, RegistrySource>();
  for (const choice of choices) {
    const base = registryLocation(choice.base);
    unique.set(`${choice.provider}\n${base}\n${choice.level}`, {
      provider: choice.provider,
      base,
      level: choice.level,
    });
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...unique.values()].sort(
    (a, b) => order(a.provider, b.provider) || order(a.base, b.base) || order(a.level, b.level),
  );
}
/**
 * Remote entries are acquired one at a time before the catalog is resolved, so a failure names the artifact it was
 * reaching for rather than the file that listed it. The acquisition is the installer's own and the resolution that
 * follows reads the same bytes back from the cache it filled; nothing here decides what a catalog entry means.
 */
async function warm(root: string, entries: unknown, offline: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (offline || !Array.isArray(entries)) return;
  for (const row of entries as readonly { readonly url?: unknown; readonly digest?: unknown }[]) {
    if (row === null || typeof row !== 'object' || typeof row.url !== 'string' || typeof row.digest !== 'string')
      continue;
    const url = row.url,
      digest = row.digest;
    await acquiring(() => acquireArtifact({ root, url, digest, signal }), url, 'catalog');
  }
}

export interface PlanRequest {
  readonly signal?: AbortSignal | undefined;
  readonly root: string;
  readonly operation: Operation;
  readonly ids: readonly string[];
  readonly requestsFile: string | undefined;
  readonly catalog: string | undefined;
  readonly offline: boolean;
  readonly to: string | undefined;
  readonly allowWithdrawn: boolean;
  readonly planOut: string | undefined;
  readonly invocation: string;
  /** Whether the invocation named `--root`; commands printed for a registered projection then carry it. */
  readonly rooted?: boolean;
  /** The registered projections, when the caller already found them; otherwise they are found here. */
  readonly refresh?: readonly HostName[];
  /**
   * Registry spec §4: the command's one chooser (`registryChooser`), which reads the configuration once. It is needed
   * only when registries are the source — `install` and `update` without `--catalog` or `--offline`, and `restore`
   * online without `--catalog` — and the caller builds it from the host, because this function never reads the process.
   */
  readonly choose?: ((id: string) => RegistryChoice) | undefined;
}
/** A plan that resolves from registries without a chooser is a caller defect, not a user's refusal. */
function chooserOf(request: PlanRequest): (id: string) => RegistryChoice {
  if (request.choose === undefined)
    throw new Refusal(
      'IA-CLI-FAILED',
      `ia ${request.operation} resolves from registries but was given no registry chooser`,
      3,
    );
  return request.choose;
}

/** §2.8: a positional adds or repins one direct request; `--requests` supplies the whole set the native path reads. */
export function mergeRequests(previous: DistributionLock | undefined, ids: readonly string[]): readonly Dependency[] {
  const requests = new Map((previous?.requests ?? []).map((request) => [request.id, request.range]));
  for (const supplied of ids) {
    const match = REQUEST.exec(supplied);
    if (match === null) throw new UsageError(`Expected <provider/name>[@<range>]; got ${supplied}`);
    requests.set(match[1]!, match[2] ?? ANY_VERSION);
  }
  return [...requests].map(([id, range]) => ({ id, range })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * `update <id>` names one direct request. `--to` repins its range; without `--to` the request keeps its range and
 * only the preference changes (registry spec §6.2). Either way an id that is not a direct request is refused.
 */
function repin(previous: DistributionLock | undefined, id: string, to: string | undefined): readonly Dependency[] {
  if (previous === undefined)
    throw new Refusal(
      'IA-DIST-INPUT-INVALID',
      'Update requires an existing installation',
      3,
      null,
      'Run "ia install <id>[@<range>]" first, or "ia doctor" for the installed state.',
    );
  if (!previous.requests.some((request) => request.id === id))
    throw new Refusal(
      'IA-DIST-INPUT-INVALID',
      `${id} is not a direct request of this installation`,
      3,
      null,
      'Run "ia inspect" for the installed generation and name one of its direct requests.',
    );
  return to === undefined
    ? previous.requests
    : previous.requests.map((request) => (request.id === id ? { id, range: to } : request));
}

/**
 * Host registration spec §4: the hosts whose projection this workspace owns. Ownership is the state file's presence,
 * as `ia host` and `ia doctor` decide it. `restore` changes no admitted system, so it has none to refresh.
 */
export const registeredProjections = (root: string, operation: Operation): readonly HostName[] =>
  operation === 'restore' ? [] : WORKSPACE_HOSTS.filter((host) => existsSync(resolve(root, STATE.projection(host))));

/**
 * Host registration spec §4: `--apply` refuses before any install write when a registered projection would refuse.
 * A hand edit to an owned file is the refusal the refresh would raise (§6.3), so it is found here, before
 * acquisition, the saved plan or the lock is touched; the remedy is the one `ia host` and `ia doctor` name for it.
 * Missing, outdated and unowned files do not block: the refresh rewrites the first two and never touches the third.
 * A file the mechanism cannot read — an unreadable ownership state, an aliased or oversized managed file — would
 * refuse the refresh too, so it is refused here, located at that file, with the repair `ia host` names for it.
 */
export function requireProjectionsClean(root: string, hosts: readonly HostName[], rooted: boolean): void {
  for (const host of hosts) {
    const rerun = `ia host ${host} --apply`;
    let drifts: readonly ProjectionDrift[];
    try {
      drifts = observeProjection({ root, host, artifacts: null, marker: WORKSPACE_PROJECTION_MARKER });
    } catch (error) {
      const refusal = refusalOf(error),
        path = refusedPath(error) ?? STATE.projection(host);
      throw new Refusal(
        refusal.code,
        refusal.message,
        3,
        { path },
        hostNext(projectionRepair(host, path, rerun), host, root, rooted),
      );
    }
    const changed = drifts.find((drift) => drift.drift === 'changed');
    if (changed !== undefined)
      throw new Refusal(
        'IA-DIST-LOCAL-MODIFICATION',
        `Managed file was edited by hand: ${changed.path}`,
        3,
        { path: changed.path },
        hostNext(projectionRepair(host, changed.path, rerun), host, root, rooted),
      );
  }
}

/**
 * Host registration spec §4: after the install committed, a registered projection is re-rendered from the records and
 * the new lock and applied through the projection mechanism, which re-checks every file itself. A refusal comes back
 * rather than being thrown, so every registered host is attempted before the command refuses. A file the mechanism
 * located gets `ia host`'s repair for it; a held host lock names the recovery that clears a dead holder's; a CLI
 * refusal (the workspace no longer admits, the renderer refused) keeps its own next action; anything else names the
 * rerun.
 */
function refreshed(view: PlanView, host: HostName): Refusal | null {
  try {
    const artifacts = renderProjectionFor(view.root, host);
    applyProjection(planProjection({ root: view.root, host, artifacts, marker: WORKSPACE_PROJECTION_MARKER }));
    return null;
  } catch (error) {
    const busy = lockRefusal(error, view.root);
    if (busy !== null) return busy;
    const refusal = refusalOf(error),
      path = refusedPath(error),
      rerun = `ia host ${host} --apply`;
    const next = path !== null ? projectionRepair(host, path, rerun) : (refusal.next ?? `Run "${rerun}" to finish.`);
    return new Refusal(
      refusal.code,
      refusal.message,
      3,
      path === null ? refusal.where : { path },
      hostNext(next, host, view.root, view.rooted),
    );
  }
}

/**
 * The installed lock is the previous state for every operation; a fresh workspace simply has none. A committed lock
 * with no active installation (a fresh clone) or one that drifted from it is what `restore` exists to repair, so for
 * `restore` those two states are no previous state at all, as the installer's own restore planning reads them
 * (apps/distribution/src/install.ts `planInstallation`). Every other operation, and every other state, still refuses.
 */
const RESTORABLE = new Set(['restore-required', 'lock-drift']);
function installedLock(root: string, operation: Operation): DistributionLock | undefined {
  try {
    return readInstalledState({ root }).lock;
  } catch (error) {
    const reason = error !== null && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
    if (operation === 'restore' && typeof reason === 'string' && RESTORABLE.has(reason)) return undefined;
    throw error;
  }
}

export async function collectPlan(request: PlanRequest): Promise<PlanView> {
  request.signal?.throwIfAborted();
  const { root, operation } = request;
  const previous = installedLock(root, operation);
  let plan: InstallationPlan;
  let withdrawn: readonly string[] = [];
  let registries: readonly RegistrySource[] = [];
  const withdrawnRefusalPrefix = 'Explicit --allow-withdrawn is required for';
  if (operation === 'restore') {
    // One lock is read, and the withdrawal check and the plan both use that same object (registry spec §6.3).
    const lock = readWorkspaceLock({ root });
    if (request.catalog === undefined && !request.offline) {
      const choose = chooserOf(request);
      const restored = await acquiring(
        async () => {
          const pins = await registryWithdrawals(root, lock, choose, request.signal);
          return planRestore({
            root,
            signal: request.signal,
            lock,
            offline: false,
            allowWithdrawn: request.allowWithdrawn,
            withdrawnRefusalPrefix,
            withdrawn: pins,
          });
        },
        null,
        'registry',
      );
      plan = restored.plan;
      withdrawn = restored.withdrawn;
      // The registries asked: every locked package's except an unpublished cached pin, which no registry lists (§6.3).
      const unpublished = unpublishedPins(root, lock);
      registries = registrySources(
        lock.packages.filter((pkg) => !unpublished.has(pkg.id)).map((pkg) => choose(pkg.id)),
      );
    } else {
      const entries = request.offline ? undefined : readWorkspaceJson({ root, path: request.catalog! });
      await warm(root, entries, request.offline, request.signal);
      const restored = await acquiring(
        () =>
          planRestore({
            root,
            signal: request.signal,
            lock,
            offline: request.offline,
            allowWithdrawn: request.allowWithdrawn,
            withdrawnRefusalPrefix,
            ...(request.offline ? {} : { catalog: entries }),
          }),
        request.catalog ?? null,
        'catalog',
      );
      plan = restored.plan;
      withdrawn = restored.withdrawn;
    }
  } else if (operation === 'remove') {
    plan = planInstallation(
      root,
      pruneLockRequest({ lock: readWorkspaceLock({ root }), id: request.ids[0]! }),
      'remove',
    );
  } else {
    const updated = operation === 'update' ? request.ids[0]! : undefined;
    const requests =
      updated !== undefined
        ? repin(previous, updated, request.to)
        : request.requestsFile === undefined
          ? mergeRequests(previous, request.ids)
          : decodeDistributionRequests(readWorkspaceJson({ root, path: request.requestsFile }));
    let choices: readonly ReleaseCandidate<BundleMetadata>[];
    if (request.catalog !== undefined) {
      const entries = readWorkspaceJson({ root, path: request.catalog });
      await warm(root, entries, request.offline, request.signal);
      choices = await acquiring(
        () => resolveCatalog({ root, entries, offline: request.offline, signal: request.signal }),
        request.catalog,
        'catalog',
      );
    } else if (request.offline) {
      choices = cached(root, [
        ...requests.map((dependency) => dependency.id),
        ...(previous?.packages ?? []).map((pkg) => pkg.id),
      ]);
    } else {
      // Registry spec §5: metadata selection, then only the selected archives are fetched and verified. Only the ids the
      // command names are looked up (§5.1): update's id; install's positionals; for a --requests file, the ids whose
      // request is new or whose range changed, since an unchanged request changes nothing. Any other locked package whose
      // exact archive is cached answers for itself, so no registry is asked about it.
      const named =
        updated !== undefined
          ? [updated]
          : request.requestsFile === undefined
            ? request.ids.map((supplied) => REQUEST.exec(supplied)![1]!)
            : requests
                .filter(
                  (dependency) =>
                    !previous?.requests.some((prior) => prior.id === dependency.id && prior.range === dependency.range),
                )
                .map((dependency) => dependency.id);
      const choose = chooserOf(request);
      const resolution = await acquiring(
        () =>
          resolveFromRegistries({
            root,
            requests,
            engine: DISTRIBUTION_ENGINE_VERSION,
            previous,
            preferredExcept: updated,
            named,
            choose,
            signal: request.signal,
          }),
        null,
        'registry',
      );
      choices = resolution.candidates;
      registries = registrySources(resolution.sources.values());
    }
    // An update drops its own package from the preference, so a repinned range is not held to the old choice and an
    // unchanged range takes the newest release in it (registry spec §6.2).
    const preference =
      updated !== undefined && previous !== undefined
        ? { ...previous, packages: previous.packages.filter((pkg) => pkg.id !== updated) }
        : previous;
    request.signal?.throwIfAborted();
    plan = planInstallation(
      root,
      resolveReleases(requests, choices, DISTRIBUTION_ENGINE_VERSION, preference).lock,
      operation,
    );
  }
  request.signal?.throwIfAborted();
  const planOut =
    request.planOut === undefined
      ? null
      : writeWorkOutput({
          root,
          path: request.planOut,
          content: () => Buffer.from(canonicalDistributionJson(plan)),
          refusal: 'A saved plan is written to a new file under .ia/work/',
        });
  return {
    operation,
    root,
    plan,
    rows: changeRows(plan, previous),
    applied: null,
    withdrawn,
    registries,
    invocation: request.invocation,
    planOut,
    refresh: request.refresh ?? registeredProjections(root, operation),
    rooted: request.rooted ?? false,
  };
}

/**
 * §2.8 rule 2's second half, separated from the first so rule 3's question can sit between them. `collectPlan`
 * never writes installation state; this is the only call in the consumer that does, and `applyInstallation`
 * re-runs the installer's own staleness check before it writes anything. Host registration spec §4 then refreshes
 * each registered projection; that writes only the projection's own files and state, never installation state. A
 * refused refresh is class 3 naming the first refusal, and the count when more than one host refused (file comment).
 */
export function applyPlan(view: PlanView): PlanView {
  const applied: PlanView = { ...view, applied: applyInstallation(view.plan) as Applied };
  const refused = view.refresh
    .map((host) => refreshed(applied, host))
    .filter((refusal): refusal is Refusal => refusal !== null);
  const [first] = refused;
  if (first !== undefined) {
    const count =
      refused.length > 1 ? ` ${refused.length} registered host projections were not refreshed; this is the first.` : '';
    throw new Refusal(first.code, first.message, 3, first.where, `The installation is applied.${count} ${first.next}`);
  }
  return applied;
}

/**
 * The `--json` envelope (§2.8): `{version: 1, command, plan, applied?, refresh?, registries?, withdrawn?, planOut?}`.
 *
 * - `plan` is the planner's own value, unchanged.
 * - `registries` (registry spec §6.1) is present only when registries were the source: one `{provider, base, level}`
 *   per provider, sorted by provider, then base. `base` is the HTTPS URL or the absolute directory; `level` is the §4
 *   level that chose it, `flag`, `env`, `workspace`, `user` or `default`. For `restore` it names the registries asked
 *   whether a locked release was withdrawn. A package's registry is the entry for its provider.
 * - `withdrawn` lists the withdrawn releases `--allow-withdrawn` accepted, and its entries differ by source: a catalog
 *   restore names bare package ids, as it always has; a registry restore names `id@version` pins (§6.3).
 */
export function planEnvelope(view: PlanView): unknown {
  return {
    version: 1,
    command: view.operation,
    plan: view.plan,
    // `applied` is applyInstallation's return, its `host: 'pending'` literal included (§2.8).
    ...(view.applied === null ? {} : { applied: view.applied }),
    // Host registration spec §4: the registered projections an apply refreshes.
    ...(view.refresh.length === 0 ? {} : { refresh: view.refresh }),
    ...(view.registries.length === 0 ? {} : { registries: view.registries }),
    ...(view.withdrawn.length === 0 ? {} : { withdrawn: view.withdrawn }),
    ...(view.planOut === null ? {} : { planOut: view.planOut }),
  };
}

const headerBlock = (view: PlanView, caps: Capabilities): readonly string[] => [
  ...headerLine(
    'Plan',
    view.operation,
    [
      { text: `format ${view.plan.formatVersion}`, column: 23 },
      { text: `engine ${view.plan.engine}`, column: 35 },
      { text: `digest ${truncateDigest(view.plan.digest, caps.ascii)}`, column: 51 },
    ],
    caps,
  ),
  ...headerLine('Root', view.root, [], caps),
  ...registryLines(view, caps),
];
/**
 * Registry spec §6.1: one "Registry" row per base, naming the level that chose it and the providers it answered for,
 * so every package in the change table can be traced to the registry it came from.
 */
function registryLines(view: PlanView, caps: Capabilities): readonly string[] {
  const rows = new Map<
    string,
    { readonly base: string; readonly level: RegistryLevel; readonly providers: string[] }
  >();
  for (const source of view.registries) {
    const key = `${source.base}\n${source.level}`;
    const row = rows.get(key) ?? { base: source.base, level: source.level, providers: [] };
    row.providers.push(source.provider);
    rows.set(key, row);
  }
  return [...rows.values()].flatMap((row) =>
    headerLine('Registry', row.base, [{ text: `for ${row.providers.join(', ')} (${row.level})` }], caps),
  );
}
const changesBlock = (view: PlanView, caps: Capabilities): readonly string[] => {
  const { changes } = view.plan;
  const counts = `${changes.added.length} added, ${changes.removed.length} removed, ${changes.updated.length} updated, ${changes.shadowed.length} shadowed.`;
  return [
    sectionLabel('Changes', caps),
    ...(view.rows.length === 0
      ? entry(
          [words('No package changes; the resolved set already matches the lock.')],
          { depth: 1, symbol: 'info' },
          caps,
        )
      : fieldRows(
          view.rows.map((row) => ({
            symbol: SYMBOL[row.kind],
            label: row.id,
            value: [
              atom(row.version),
              atom(row.archive === null ? 'sha256 —' : `sha256 ${truncateDigest(row.archive, caps.ascii)}`, null, 2),
              atom(row.origin, null, 2),
            ],
          })),
          { depth: 1 },
          caps,
        )),
    ...entry([words(counts, 'dim')], { depth: 1 }, caps),
  ];
};
/** The warning prints the accepted releases as the source named them: bare ids from a catalog, `id@version` from a registry. */
const withdrawnBlocks = (view: PlanView, caps: Capabilities): readonly (readonly string[])[] =>
  view.withdrawn.length === 0
    ? []
    : [
        entry(
          [words(`Withdrawn releases accepted with --allow-withdrawn: ${view.withdrawn.join(', ')}.`)],
          { depth: 1, symbol: 'warning' },
          caps,
        ),
      ];
/** §2.8 rule 4's closed path set, which is what makes "only install state" a checkable claim rather than a promise. */
const wouldWriteBlocks = (view: PlanView, caps: Capabilities): readonly (readonly string[])[] => {
  const { plan } = view;
  const paths = [
    ...plan.lock.packages.map((pkg) => `${INSTALL_PATHS.store}/${pkg.archive}/`),
    `${INSTALL_PATHS.generations}/${plan.pointer.generation}/`,
    INSTALL_PATHS.lock,
    INSTALL_PATHS.active,
  ];
  return [
    [
      sectionLabel('Would write', caps),
      ...paths.flatMap((path) => entry([[atom(path, 'cyan', 0)]], { depth: 1, symbol: 'info' }, caps)),
    ],
    entry([words('Authored sources under .ia/src are not touched.')], { depth: 1 }, caps),
    ...projectionsBlocks(view, caps),
  ];
};

/** Host registration spec §4: the plan says which registered projections the apply re-renders. */
const projectionsBlocks = (view: PlanView, caps: Capabilities): readonly (readonly string[])[] =>
  view.refresh.length === 0
    ? []
    : [
        entry(
          [words(`Registered host projections (${view.refresh.join(', ')}) are refreshed after apply.`)],
          { depth: 1, symbol: 'info' },
          caps,
        ),
      ];
/**
 * What an applied plan says about hosts. `applied.host` is applyInstallation's literal and is never presented as
 * configured (§2.8): with no registered projection the installer's host state is "not reported"; with one, the line
 * names what this command refreshed — a refused refresh never reaches here — and points at doctor for the rest.
 */
const hostLine = (view: PlanView): string =>
  view.refresh.length === 0
    ? 'Host state is not reported by the installer; run "ia doctor" for it.'
    : `Registered host projections (${view.refresh.join(', ')}) were refreshed; run "ia doctor" for host state.`;

export function renderPlan(view: PlanView, caps: Capabilities): string {
  const blocks: (readonly string[])[] = [
    headerBlock(view, caps),
    view.applied === null
      ? entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps)
      : entry(
          [
            words(
              `Installed generation ${truncateDigest(view.applied.generation, caps.ascii)}, counter ${view.applied.counter}.`,
            ),
            words(hostLine(view)),
          ],
          { depth: 1, symbol: 'success' },
          caps,
        ),
    changesBlock(view, caps),
    ...withdrawnBlocks(view, caps),
    ...(view.applied === null ? wouldWriteBlocks(view, caps) : []),
    ...(view.planOut === null
      ? []
      : [
          entry(
            [[...words('Plan saved to', null, 0), atom(view.planOut, 'cyan', 1)]],
            { depth: 1, symbol: 'info' },
            caps,
          ),
        ]),
    entry(
      view.applied === null
        ? [
            ...commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps),
            words(`Save the plan for review with --plan-out .ia/work/${view.operation}-plan.json.`),
          ]
        : [words('Run "ia validate" to check the installed workspace, or "ia doctor" for the installed state.')],
      { depth: 0, symbol: 'step' },
      caps,
    ),
  ];
  return document(blocks, { leadingBlank: true });
}

/** §2.8 rule 3's one question, asked once and only where an answer can arrive. */
export const CONFIRMATION = 'Apply these changes? [y/N] ';
/**
 * The change summary rule 3 requires the question to show: what the preview shows about what would change, without
 * the preview's "nothing has been written" note or its next-action footer, because the question *is* the action.
 * It is the same blocks the preview builds, so a column the preview prints and this one does not cannot exist.
 */
export const renderSummary = (view: PlanView, caps: Capabilities): string =>
  document(
    [
      headerBlock(view, caps),
      changesBlock(view, caps),
      ...withdrawnBlocks(view, caps),
      ...wouldWriteBlocks(view, caps),
    ],
    {
      leadingBlank: true,
    },
  );
/**
 * A declined question is an answer, not a failure: §2.8 rule 3 asked, the user said no, and the command reports
 * that and exits 0. The summary was on stderr, so what stdout carries is the outcome and the way to get the other
 * one. `--plan-out` was already written, because a declined apply is exactly the plan-only run rule 1 describes.
 */
export const renderDeclined = (view: PlanView, caps: Capabilities): string =>
  document(
    [
      entry([words('Nothing was applied.')], { depth: 0, symbol: 'info' }, caps),
      entry(
        commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps),
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );

/** The invocation is rebuilt from the parsed arguments, so the printed command is the one that was understood. */
function invocationOf(context: Context, operation: Operation): string {
  const { args } = context;
  const parts = [`ia ${operation}`, ...args.positionals.map(quote)];
  for (const name of ['to', 'requests', 'registry', 'catalog', 'plan-out'] as const) {
    const value = args.value(name);
    if (value !== undefined) parts.push(`--${name}`, quote(value));
  }
  for (const name of ['offline', 'allow-withdrawn'] as const) if (args.flag(name)) parts.push(`--${name}`);
  const root = args.value('root');
  if (root !== undefined) parts.push('--root', quote(root));
  return parts.join(' ');
}

/**
 * Registry spec §4: the one chooser a command builds, from the host rather than the process, so every verb that
 * reports or uses registry routing (`install`, `update`, `restore`, `doctor`) picks the same base for an id. A
 * relative `--registry` or `IA_REGISTRY` directory is the caller's (`host.cwd`), and the user file is found from the
 * host's environment: `IA_CONFIG_HOME`, else the per-OS directory under the home `os.homedir()` would use —
 * `USERPROFILE` on Windows, `HOME` elsewhere — and, when that variable is unset, `os.homedir()` itself. Construction
 * reads nothing: the configuration is read on first use, once per command.
 */
export function hostRegistryChooser(
  host: Pick<Host, 'env' | 'cwd'>,
  root: string,
  flag?: string,
): (id: string) => RegistryChoice {
  const home = (process.platform === 'win32' ? host.env['USERPROFILE'] : host.env['HOME']) || undefined;
  return registryChooser({
    root,
    env: host.env,
    cwd: host.cwd,
    platform: process.platform,
    ...(home === undefined ? {} : { home }),
    ...(flag === undefined ? {} : { flag }),
  });
}

export function runDistribute(operation: Operation): (context: Context) => Promise<Result> {
  return async (context: Context): Promise<Result> => {
    const { args, caps, host, json } = context;
    const catalog = args.value('catalog'),
      offline = args.flag('offline'),
      registry = args.value('registry');
    const root = requireRoot(context),
      rooted = args.value('root') !== undefined;
    const choose = operation === 'remove' ? undefined : hostRegistryChooser(host, root, registry);
    // Host registration spec §4: a registered projection that would refuse is refused before any install write —
    // before acquisition, the saved plan and the question too, so nothing is fetched for an apply that cannot finish.
    const refresh = registeredProjections(root, operation);
    if (args.flag('apply')) requireProjectionsClean(root, refresh, rooted);
    const planned = await collectPlan({
      signal: host.signal,
      root,
      operation,
      ids: args.positionals,
      requestsFile: args.value('requests'),
      catalog,
      offline,
      to: args.value('to'),
      allowWithdrawn: args.flag('allow-withdrawn'),
      planOut: args.value('plan-out'),
      invocation: invocationOf(context, operation),
      rooted,
      refresh,
      choose,
    });
    const rendered = (view: PlanView): Result =>
      json
        ? { exitCode: 0, stdout: JSON.stringify(planEnvelope(view)) + '\n', stderr: '' }
        : { exitCode: 0, stdout: renderPlan(view, caps), stderr: '' };
    host.signal?.throwIfAborted();
    if (!args.flag('apply')) return rendered(planned);
    // §2.8 rule 3. Parsing has already refused every `--apply` whose question could not be asked or answered —
    // no terminal, or `--json` — so the only two states left here are "answer it" and "`--yes` says skip it".
    // A declined answer therefore cannot occur under `--json`, which is why there is no JSON shape for one.
    if (!args.flag('yes') && !(await confirm(host.interaction, renderSummary(planned, caps), CONFIRMATION)))
      return { exitCode: 0, stdout: renderDeclined(planned, caps), stderr: '' };
    host.signal?.throwIfAborted();
    return rendered(applyPlan(planned));
  };
}
