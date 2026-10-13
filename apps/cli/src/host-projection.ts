/**
 * Host registration spec §6: a workspace's projection for one host, rendered from its own admitted records.
 *
 * Milestone position-packet task replace-renderers (plan amendments B9, B11 and B12): the projection is the position
 * packet (`renderPacket`, runtime R19) rendered by the host's adapter for the consumer target (`renderHost`, R20), with
 * the command catalog this CLI tags (`packetCatalog`). One render feeds `ia host`, `ia doctor`'s projection rows and the
 * install/update/remove refresh, so no two of them can disagree about what the projection should contain.
 *
 * Milestone generation-binding task host-consumes-generated-set (plan amendments C4, C5, C9 and C12): the render also
 * holds the host set workspace-runtime generates from the workspace's authored records, computed once
 * (`generateHostSet`): the agent and skill files beside the packet's, the `@hook` declarations whose groups the writer
 * registers, the operation and harness definitions, and a row for each authored record the host does not take.
 *
 * `applyHostProjection` is the only writer of projection files and hook groups. Before any file changes it retires a
 * steward-guard registration an earlier release made (B11), then registers the hook groups of the authored `@hook`
 * records (distribution's guard-registration, owned by exact match through their own state), then applies the planned
 * files through `@inventarch/distribution/projection`, which owns packet and generated files alike through the
 * projection state, deletes the owned 1.x steward files and obsolete generated files and leaves foreign ones (B9), and
 * writes the receipt beside the projection state last (B12). Ownership is the states', never the receipt's.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathKey } from '@inventarch/db';
import { renderHost, renderPacket, PACKET_MARKER } from '@inventarch/runtime';
import type {
  HookGroupRow,
  HostFile,
  HostHookDeclaration,
  HostOutput,
  PacketDefinition,
  PacketReceipt,
  RemovedHookRow,
  UnsupportedRow,
} from '@inventarch/runtime';
import { ProjectionError } from '@inventarch/workspace-runtime/projections';
import { generateHostSet } from '@inventarch/workspace-runtime/internal/generate';
import type { GuardPlan, HookPlan } from '@inventarch/distribution/guard-registration';
import {
  applyGuardRegistration,
  applyHookRegistration,
  assertRetirableGuard,
  assertRemovableHooks,
  hookGroupDigest,
  hooksDisabledBy,
  planGuardRegistration,
  planHookRegistration,
  planHooksFor,
  observeHookRegistration,
  readHookRegistration,
} from '@inventarch/distribution/guard-registration';
import type { HostCacheTarget } from '@inventarch/distribution/host';
import {
  acquireHostRegistrationLock,
  assertHostRegistrationIdle,
  HOST_REGISTRATION,
  verifyHostCache,
} from '@inventarch/distribution/host';
import type { WorkspaceHost } from '@inventarch/distribution/hosts';
import type { ProjectionPlan } from '@inventarch/distribution/projection';
import { applyProjection, planProjection, projectionOwnable } from '@inventarch/distribution/projection';
import {
  DistributionError,
  json,
  readWorkspaceFile,
  readWorkspaceJson,
  replace,
  sha256,
} from '@inventarch/distribution/services';
import { packetCatalog } from './commands.js';
import { Refusal } from './consumer.js';
import type { HookRefusal } from './host.js';
import { refusedPath, SETTINGS, skillFolderOf, STATE } from './host.js';
import type { SessionGate } from './profile.js';
import type { Session } from './session.js';
import { codeOf, openSession } from './session.js';

export type HostName = WorkspaceHost;
export type Artifact = HostFile;

/** This CLI's id@version, which the receipt records and only the applying CLI knows (design item 12). */
const CLI = `@inventarch/cli@${
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
}`;

/**
 * §4: the target must admit — zero error findings — before anything is rendered or registered. The refusal is the
 * CLI's own classification of the target, so it is IA-CLI-CONFLICT and names the command that shows the findings.
 */
function requireAdmitted(session: Session, root: string): void {
  if (session.admission().status !== 'admitted')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The workspace does not admit; host registration needs a workspace with zero error findings',
      3,
      { path: root },
      'Run "ia validate" and fix the reported errors.',
    );
}

/**
 * A host-generation refusal (workspace-runtime's ProjectionError, which carries its code in `diagnostic`) as this CLI's
 * refusal: its IA-PROJECTION-* code and message, located at the workspace, naming the command that shows the records.
 * Generation reports a record it cannot render as an unsupported row, so this is a refusal of the whole render.
 */
function generationRefusal(error: unknown, root: string): unknown {
  if (!(error instanceof ProjectionError)) return error;
  return new Refusal(
    error.diagnostic.code,
    error.diagnostic.message,
    3,
    { path: root },
    'Correct the record the message names, then run "ia validate".',
  );
}
/**
 * §6.1: the packet over the whole workspace, through the session's own scope, rendered by `host`'s adapter for the
 * consumer target, and the host set generated from the workspace's authored records through the same scope: the
 * packet's files, then the generated agent and skill files, each carrying `PACKET_MARKER`; the `@hook` declarations
 * (`hooks`, claude only); and the receipt the render fills (B12), whose `files` list every file with its SHA-256,
 * `generated` the generated ones with their records, `definitions` the operation and harness definitions and
 * `unsupported` each authored record the host does not take. Its `hooks` rows are the applying caller's. `gate`, when given,
 * judges the session before anything is read from it (review C2-N3).
 */
export function renderProjectionFor(root: string, host: HostName, gate?: SessionGate): HostOutput {
  const session = openSession(root);
  try {
    gate?.(session);
    requireAdmitted(session, root);
    const within = session.reader.resolveScope().token;
    const { packet, digest, hostNote } = renderPacket(session.reader, within, packetCatalog());
    const output = renderHost(host, packet, digest, hostNote, 'consumer');
    let set: ReturnType<typeof generateHostSet>;
    try {
      set = generateHostSet(session.reader, within, host);
    } catch (error) {
      throw generationRefusal(error, root);
    }
    const generated = set.files.map(({ identity, word, path, text }) => ({
      identity,
      word,
      path,
      sha256: sha256(text),
    }));
    return Object.freeze({
      files: Object.freeze([...output.files, ...set.files.map(({ path, text }) => Object.freeze({ path, text }))]),
      receipt: Object.freeze({
        ...output.receipt,
        files: Object.freeze([...output.receipt.files, ...generated.map(({ path, sha256 }) => ({ path, sha256 }))]),
        generated: Object.freeze(generated),
        definitions: set.definitions,
        unsupported: set.unsupported,
      }),
      hooks: set.hooks,
    });
  } finally {
    session.close();
  }
}

/**
 * Where hook groups run from (plan amendment C9): the payload `ia host` materialized and verified (`verified`), the one
 * it is about to (`expected`, for a plan), or none (null), when the caller registers no host: `ia project`, the install
 * refresh and a migration then keep the groups an earlier `ia host` registration owns in step with the records, against
 * the payload that registration recorded, and register none themselves.
 */
export type HookCache = { readonly verified: string } | { readonly expected: HostCacheTarget } | null;
/** The step's plan, or null when there is nothing to register or remove, and the hooks it cannot register. */
export interface HookStep {
  readonly plan: HookPlan | null;
  readonly unregistered: readonly UnsupportedRow[];
}
/**
 * Why an obsolete owned group is still in the settings (review finding F1): with hooks disabled, the groups kept beside it
 * are re-planned against the payload they were registered against, and that payload is gone.
 */
export const HOOK_KEPT =
  'Kept: no registrable hook claims this group any more, but it stays until hooks are back on or the payload it was registered against is materialized again';
/**
 * The records a host does not take, one row per identity (review finding N3): generation's rows, then the hook step's;
 * where both report an identity (an unsupported authored hook whose group is kept), one row carries both reasons.
 */
export function notTaken(
  generated: readonly UnsupportedRow[],
  step: readonly UnsupportedRow[],
): readonly UnsupportedRow[] {
  const rows = new Map(generated.map((row) => [`${row.word} ${row.identity}`, row]));
  for (const row of step) {
    const key = `${row.word} ${row.identity}`,
      first = rows.get(key);
    rows.set(key, first === undefined ? row : { ...first, reason: `${first.reason}; ${row.reason}` });
  }
  return [...rows.values()];
}
/** Why a declared hook is not registered when no host payload is known: `ia host` materializes one. */
export const HOOKS_NEED_HOST =
  'Not registered: a hook group runs the guard in the host payload "ia host claude --apply" materializes; run it to register this hook';
/**
 * The hook groups `rendered` declares, planned for `host` (claude only; Codex hooks are unsupported, C12): with no
 * declared hook, the removal of every owned group; else their registration against `cache`, or against the payload the
 * owned registration recorded; with neither, none, and each declared hook comes back unregistered. A removal
 * (`rendered` null) removes every owned group. Reads only.
 */
export function planHooks(root: string, host: HostName, rendered: HostOutput | null, cache: HookCache): HookStep {
  if (host !== 'claude') return { plan: null, unregistered: [] };
  if (rendered === null) assertRemovableHooks(root);
  const rows = (rendered?.hooks ?? []).map(({ identity, tools, paths }) => ({ identity, tools, paths }));
  const prior = readHookRegistration(root);
  if (rows.length === 0)
    return {
      plan: prior === null ? null : planHookRegistration(root, { remove: HOST_REGISTRATION }),
      unregistered: [],
    };
  // Hooks turned off by disableAllHooks: no group is registered, each declared hook is reported, and every other part of
  // the host applies as it does without hooks (review finding H-N12). Groups already owned stay as they are.
  const disabled = hooksDisabledBy(root);
  if (disabled !== null) {
    // Review finding A-F1: a group owned for a hook still declared stays as registered, and is no unsupported row; an
    // obsolete owned group is removed; a hook with no group is reported, naming the file.
    const owned = new Map((prior?.groups ?? []).map((group) => [group.hook, group.paths])),
      declared = new Set(rows.map((row) => row.identity));
    // A group changed or duplicated by hand refuses, and so does one deleted by hand whose hook is still declared, as
    // with hooks on (H-R1); a deleted group of a hook no longer declared only loses its ownership (review finding N4).
    const drift = prior === null ? [] : observeHookRegistration(root);
    const handEditedRow = drift.find(
      (row) => row.drift === 'modified' || (row.drift === 'missing' && declared.has(row.hook)),
    );
    if (handEditedRow !== undefined) throw handEdited(handEditedRow);
    const gone = new Set(drift.filter((row) => row.drift === 'missing').map((row) => row.hook));
    const kept = rows
      .filter((row) => owned.has(row.identity))
      .map((row) => ({ ...row, paths: owned.get(row.identity)! }));
    const unregistered = rows
      .filter((row) => !owned.has(row.identity))
      .map((row) => ({
        identity: row.identity,
        word: 'hook' as const,
        reason: `Not registered: hooks are disabled by disableAllHooks in ${disabled}`,
      }));
    if (prior === null || kept.length === owned.size) return { plan: null, unregistered };
    if (kept.length === 0) return { plan: planHookRegistration(root, { remove: HOST_REGISTRATION }), unregistered };
    // The kept groups are re-planned as recorded, so nothing is written for them. That needs the payload they were
    // registered against: the one this apply materializes when it is that payload (review finding N1, so a plan and its
    // apply agree), else the recorded one, which must still verify. Without it nothing is planned: the obsolete groups
    // stay, reported as kept rather than listed as registered, and a group already deleted by hand is no kept group but
    // stays owned until such a plan runs (review finding F1), which doctor reports as a missing group.
    // The same directory is the same payload however its path is spelled (review finding F2: an IA_HOST_HOME in another
    // letter case), compared as the volume compares names; the kept groups are planned against the recorded spelling, so
    // their bytes are the ones registered and the dry run and the apply agree.
    const given = cache === null ? undefined : 'expected' in cache ? cache.expected.directory : cache.verified;
    if (cache !== null && given !== undefined && pathKey(resolve(given)) === pathKey(resolve(prior.cache)))
      return {
        plan:
          'expected' in cache
            ? planHooksFor(
                root,
                { ...cache.expected, directory: prior.cache, launcher: join(prior.cache, 'scripts/ia.mjs') },
                kept,
              )
            : planHookRegistration(root, { cache: prior.cache, hooks: kept }),
        unregistered,
      };
    try {
      verifyHostCache(prior.cache);
    } catch {
      return {
        plan: null,
        unregistered: [
          ...unregistered,
          ...[...owned.keys()]
            .filter((hook) => !declared.has(hook) && !gone.has(hook))
            .map((hook) => ({ identity: hook, word: 'hook' as const, reason: HOOK_KEPT })),
        ],
      };
    }
    return { plan: planHookRegistration(root, { cache: prior.cache, hooks: kept }), unregistered };
  }
  if (cache !== null && 'expected' in cache)
    return { plan: planHooksFor(root, cache.expected, rows), unregistered: [] };
  const directory = cache?.verified ?? prior?.cache;
  if (directory === undefined)
    return {
      plan: null,
      unregistered: rows.map((row) => ({ identity: row.identity, word: 'hook' as const, reason: HOOKS_NEED_HOST })),
    };
  if (cache === null && prior !== null) {
    // Against the payload the registration recorded (review finding H-R4): with the same hooks and selections owned,
    // nothing is written and that payload is not read, so its absence never blocks an unrelated apply; a change needs it,
    // and a payload gone or changed refuses there, naming `ia host`, which materializes one and registers against it.
    const owned = new Map(prior.groups.map((group) => [group.hook, json(group.paths)]));
    if (owned.size === rows.length && rows.every((row) => owned.get(row.identity) === json(row.paths))) {
      // Still a group deleted, changed or duplicated by hand refuses, as a registration would (H-R1, H-R3).
      const drift = observeHookRegistration(root).find((row) => row.drift !== 'foreign');
      if (drift !== undefined) throw handEdited(drift);
      return { plan: null, unregistered: [] };
    }
    try {
      verifyHostCache(directory);
    } catch (error) {
      throw Object.assign(
        new DistributionError(
          codeOf(error, 'IA-DIST-ARTIFACT-UNAVAILABLE'),
          `The host payload the hook registration recorded cannot be used: ${error instanceof Error ? error.message : String(error)}`,
          directory,
        ),
        { hookRefusal: { payload: directory } satisfies HookRefusal },
      );
    }
  }
  return { plan: planHookRegistration(root, { cache: directory, hooks: rows }), unregistered: [] };
}
/**
 * The hook groups the workspace owns now, as a receipt lists them: one row per `@hook`, keyed by identity, with the
 * tools the hook declares (every group matches every edit tool, so its matcher does not say them) and the group's digest.
 */
function hookRows(root: string, declared: readonly HostHookDeclaration[]): readonly HookGroupRow[] {
  const tools = new Map(declared.map((hook) => [hook.identity, hook.tools]));
  // Only the groups of declared hooks are registered ones: an obsolete group kept while hooks are disabled is reported
  // as kept instead (review finding F1).
  return (readHookRegistration(root)?.groups ?? [])
    .filter(({ hook }) => tools.has(hook))
    .map(({ hook, group }) => ({
      identity: hook,
      tools: [...tools.get(hook)!],
      sha256: hookGroupDigest(group),
    }));
}

/**
 * B11: whether this workspace holds a steward-guard registration an earlier release made, which the projection apply
 * retires. Only Claude ever registered one; its ownership state is the registration, as `ia host` and `ia doctor`
 * decide it.
 */
export const ownsGuard = (root: string, host: HostName): boolean =>
  host === 'claude' && existsSync(resolve(root, STATE.hooks));
/**
 * B11: the removal of the steward-guard registration this workspace owns, or null when it owns none. A refusal the
 * mechanism does not locate at a file concerns the guard group in the settings file — a group changed by hand, or
 * settings that do not parse — except a pending host journal, which is the journal's.
 */
export function planRetirement(root: string, host: HostName): GuardPlan | null {
  try {
    if (host === 'claude') assertRetirableGuard(root);
    if (!ownsGuard(root, host)) return null;
    return planGuardRegistration(root, { remove: HOST_REGISTRATION });
  } catch (error) {
    const code = codeOf(error, '');
    if (
      error instanceof Error &&
      /^IA-/.test(code) &&
      code !== 'IA-DIST-RECOVERY-REQUIRED' &&
      refusedPath(error) === null
    )
      throw new DistributionError(code, error.message, SETTINGS);
    throw error;
  }
}
/** The file plan `applyHostProjection` applies for `rendered`, or the removal of the owned set for null. */
export const planFiles = (root: string, host: HostName, rendered: HostOutput | null): ProjectionPlan => {
  preflightReceipt(root, host);
  return planProjection({ root, host, artifacts: rendered?.files ?? [], marker: PACKET_MARKER });
};
/** Check every destination ancestor and the opened destination without changing bytes. */
export function preflightReceipt(root: string, host: HostName): void {
  for (const path of [STATE.receipt(host), pendingPath(host)]) {
    const parts = path.split('/'),
      ancestors: { stat: BigIntStats }[] = [];
    const unsafe = (relative = path): DistributionError =>
      new DistributionError(
        'IA-DIST-PATH-UNSAFE',
        'Expected an unaliased receipt file and directory ancestors',
        relative,
      );
    for (let i = 1; i < parts.length; i++) {
      const relative = parts.slice(0, i).join('/'),
        absolute = resolve(root, relative);
      let stat: BigIntStats;
      try {
        stat = lstatSync(absolute, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(relative);
      ancestors.push({ stat });
      accessSync(absolute, constants.W_OK);
    }
    const checkAncestors = (): void => {
      for (let i = 1; i < parts.length; i++) {
        const relative = parts.slice(0, i).join('/'),
          current = lstatSync(resolve(root, relative), { bigint: true, throwIfNoEntry: false }),
          before = ancestors[i - 1]?.stat;
        if (!current) {
          if (before) throw unsafe(relative);
          break;
        }
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          (before && (current.dev !== before.dev || current.ino !== before.ino))
        )
          throw unsafe(relative);
      }
    };
    const absolute = resolve(root, path);
    let fd: number;
    try {
      // No pathname precheck: validate the handle actually opened. O_NOFOLLOW protects the leaf where supported;
      // the identity checks below also cover Windows and ancestor replacement. No creation or truncation occurs.
      fd = openSync(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      // A bad kind may itself prevent opening (directories on Windows, or a dangling link). Preserve its path remedy.
      const named = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
      if (named && (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n)) throw unsafe();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !named) {
        checkAncestors();
        continue;
      }
      throw error;
    }
    try {
      // Windows file IDs can exceed Number.MAX_SAFE_INTEGER; retain every bit when comparing identities.
      const opened = fstatSync(fd, { bigint: true }),
        named = lstatSync(absolute, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino
      )
        throw unsafe();
      checkAncestors();
    } finally {
      closeSync(fd);
    }
  }
  readPending(root, host);
}

const pendingPath = (host: HostName): string => `.ia/distributions/hosts/${host}-receipt-pending.json`;
interface PendingReceipt {
  readonly format: 'ia.packet-receipt-pending.v1';
  readonly host: HostName;
  readonly guard: boolean;
  readonly receipt?: string;
  readonly removed: readonly { readonly path: string; readonly sha256: string }[];
  /** The hook groups this apply removes, by `@hook` and last group digest; present only when there are any (H-R5). */
  readonly removedHooks?: readonly RemovedHookRow[];
}
/** Rows `{identity, sha256}` of removed hook groups, each identity once. */
const hookDigests = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      typeof (row as { identity?: unknown }).identity === 'string' &&
      HEX.test(String((row as { sha256?: unknown }).sha256)),
  ) &&
  new Set(value.map((row: { identity: string }) => row.identity)).size === value.length;
function readPending(root: string, host: HostName): PendingReceipt | null {
  const path = pendingPath(host);
  if (!existsSync(resolve(root, path))) return null;
  let value: PendingReceipt & { digest?: string };
  try {
    value = readWorkspaceJson({ root, path }) as typeof value;
  } catch (error) {
    throw new DistributionError(
      codeOf(error, 'IA-CLI-FAILED'),
      error instanceof Error ? error.message : String(error),
      path,
    );
  }
  const { digest, ...body } = value ?? {};
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.format !== 'ia.packet-receipt-pending.v1' ||
    value.host !== host ||
    typeof value.guard !== 'boolean' ||
    !digests(value.removed) ||
    value.removed.some((file) => !projectionOwnable(host, file.path)) ||
    (value.receipt !== undefined && !HEX.test(value.receipt)) ||
    (value.removedHooks !== undefined && (!hookDigests(value.removedHooks) || value.removedHooks.length === 0)) ||
    Object.keys(body).sort().join(',') !==
      [
        'format',
        'guard',
        'host',
        ...(value.receipt === undefined ? [] : ['receipt']),
        'removed',
        ...(value.removedHooks === undefined ? [] : ['removedHooks']),
      ].join(',') ||
    digest !== sha256(json(body))
  )
    throw new DistributionError('IA-DIST-INPUT-INVALID', 'Invalid pending projection receipt evidence', path);
  // The receipt committed but a kill left the pending cleanup undone: that was a successful last apply.
  if (
    value.receipt !== undefined &&
    existsSync(resolve(root, STATE.receipt(host))) &&
    sha256(readWorkspaceFile({ root, path: STATE.receipt(host) })) === value.receipt
  )
    return null;
  return body;
}

/** Verified deletion provenance shared by projection apply and a migration's durable effect plan. */
export function projectionEvidence(
  root: string,
  host: HostName,
  actions: readonly { readonly action: string; readonly path: string }[],
  retirement: boolean,
  previous?: PacketReceipt,
  hookRemovals: readonly RemovedHookRow[] = [],
): PendingReceipt {
  if (
    previous !== undefined &&
    (JSON.stringify(readReceipt(root, host)) !== JSON.stringify(previous) ||
      !previous.files.every((file) => sha256(readWorkspaceFile({ root, path: file.path })) === file.sha256) ||
      !previous.removed.every((file) => !existsSync(resolve(root, file.path))))
  )
    throw new DistributionError(
      'IA-DIST-LOCAL-MODIFICATION',
      'Completed projection differs from its receipt',
      STATE.receipt(host),
    );
  const removed = actions.flatMap((action) =>
    action.action === 'remove' && existsSync(resolve(root, action.path))
      ? [{ path: action.path, sha256: sha256(readWorkspaceFile({ root, path: action.path })) }]
      : [],
  );
  const pending = readPending(root, host);
  const prior: Pick<PendingReceipt, 'guard' | 'removed' | 'removedHooks'> | null =
    pending ??
    (previous === undefined
      ? null
      : {
          guard: previous.guard === 'retired',
          removed: previous.removed,
          ...(previous.removedHooks === undefined ? {} : { removedHooks: previous.removedHooks }),
        });
  for (const file of removed) {
    const recorded = prior?.removed.find((row) => row.path === file.path);
    if (recorded !== undefined && recorded.sha256 !== file.sha256)
      throw new DistributionError(
        'IA-DIST-LOCAL-MODIFICATION',
        'Pending removal evidence differs from the current owned bytes',
        file.path,
      );
  }
  // A hook group an interrupted earlier apply removed stays listed with the digest it recorded then (H-R5).
  const removedHooks = [
    ...new Map(
      [...hookRemovals, ...(prior?.removedHooks ?? [])].map((row) => [
        row.identity,
        { identity: row.identity, sha256: row.sha256 },
      ]),
    ).values(),
  ].sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  return {
    format: 'ia.packet-receipt-pending.v1',
    host,
    guard: prior?.guard === true || retirement,
    removed: [...new Map([...(prior?.removed ?? []), ...removed].map((file) => [file.path, file])).values()],
    ...(removedHooks.length === 0 ? {} : { removedHooks }),
  };
}

/** What `applyHostProjection` did. */
export interface HostProjectionApplied {
  /** `projected` after a render; after a removal `projection-removed`, or `absent` when it removed no file. */
  readonly status: 'projected' | 'projection-removed' | 'absent';
  /** B11: `retired` when a steward-guard registration was removed before any projection file changed. */
  readonly guard: 'retired' | 'none';
  /** The receipt written (B12); null after a removal, which deletes it. */
  readonly receipt: PacketReceipt | null;
}

/**
 * The one writer of projection files: B11, then the files, then B12. `rendered` is `renderProjectionFor`'s output,
 * or null to remove the owned set. Both the guard retirement and the file plan are planned before anything is written,
 * so a refusal either planner finds changes nothing; then the guard registration is removed (its group in
 * `.claude/settings.local.json` and its ownership state), and only then are the files written and the owned 1.x
 * steward files deleted. A failure past the retirement so leaves the guard retired and never the steward files
 * deleted with the guard still registered; a rerun converges. The receipt (`<host>-receipt.json` beside the
 * projection state) describes the files as an apply left them, so it is deleted, under the host lock, before any of
 * them changes: an interrupted apply leaves none, which `ia doctor` reports as unknown, never as a hand edit. It is
 * written last, under the host lock, with the legacy files deleted (`removed`), the foreign files left in place, the
 * retirement, this CLI's id@version and the time; a removal leaves it deleted. `checkpoint` runs after the retirement
 * (`guard`), at each of `applyProjection`'s own stages and after the receipt (`receipt`), which is where an
 * interruption test cuts. A migration may supply its verified previous receipt to refresh host notes while retaining
 * that operation's retirement and deletion evidence; ordinary applies omit it and keep last-apply semantics.
 */
export function applyHostProjection(
  root: string,
  host: HostName,
  rendered: HostOutput | null,
  checkpoint: (stage: string) => void = () => {},
  previous?: PacketReceipt,
  cache: HookCache = null,
): HostProjectionApplied {
  // A pending host journal refuses every host write, as it refuses the plan (§8).
  assertHostRegistrationIdle(root);
  const retirement = planRetirement(root, host),
    hooks = planHookStep(root, host, rendered, cache),
    plan = planFiles(root, host, rendered);
  const writeEvidence = (path: string, value: unknown | null): void => {
    const unlock = acquireHostRegistrationLock(root);
    try {
      replace(root, path, value === null ? null : Buffer.from(json(value)));
    } finally {
      unlock();
    }
  };
  // The groups this apply removes, each with the digest the ownership state recorded for it (H-R5).
  const recorded = new Map(
    (readHookRegistration(root)?.groups ?? []).map((row) => [row.hook, hookGroupDigest(row.group)]),
  );
  const hookRemovals = (hooks.plan?.hooks ?? [])
    .filter((row) => row.action === 'remove' && recorded.has(row.hook))
    .map((row) => ({ identity: row.hook, sha256: recorded.get(row.hook)! }));
  const evidence = projectionEvidence(root, host, plan.actions, retirement !== null, previous, hookRemovals);
  // Evidence precedes retirement and every deletion; it survives failure and the projection state's collapse.
  writeEvidence(pendingPath(host), { ...evidence, digest: sha256(json(evidence)) });
  checkpoint('evidence');
  if (retirement !== null) applyGuardRegistration(retirement);
  checkpoint('guard');
  // The hook groups next, through their own journal and lock; a plan that changes nothing writes nothing. A retirement
  // rewrote the settings the first plan read, so the groups are planned again against what it left: the first plan
  // only refused, before anything was written, what this one would.
  const registration = retirement === null ? hooks : planHookStep(root, host, rendered, cache);
  if (registration.plan !== null) applyHookRegistration(registration.plan);
  checkpoint('hooks');
  // The last apply's receipt goes before any projection file changes (B12).
  writeEvidence(STATE.receipt(host), null);
  const result = applyProjection(plan, checkpoint),
    guard = evidence.guard ? 'retired' : 'none';
  // The groups owned now, and those removed: this apply's and an interrupted earlier one's, not registered again (H-R5).
  const owned = host === 'claude' && rendered !== null ? hookRows(root, rendered.hooks ?? []) : [],
    registered = new Set(owned.map((row) => row.identity));
  const receipt: PacketReceipt | null =
    rendered === null
      ? null
      : {
          ...rendered.receipt,
          cli: CLI,
          removed: evidence.removed.filter((file) => !existsSync(resolve(root, file.path))),
          foreign: plan.actions.filter((action) => action.action === 'foreign').map((action) => action.path),
          guard,
          ...(host === 'claude'
            ? {
                hooks: owned,
                removedHooks: (evidence.removedHooks ?? []).filter((row) => !registered.has(row.identity)),
              }
            : {}),
          ...(rendered.receipt.definitions === undefined
            ? {}
            : { definitions: appliedDefinitions(rendered.receipt.definitions, rendered.receipt.files, registered) }),
          unsupported: notTaken(rendered.receipt.unsupported ?? [], registration.unregistered),
          writtenAt: new Date().toISOString(),
        };
  if (receipt !== null) {
    const completed = { ...evidence, receipt: sha256(json(receipt)) };
    writeEvidence(pendingPath(host), { ...completed, digest: sha256(json(completed)) });
  }
  writeEvidence(STATE.receipt(host), receipt);
  writeEvidence(pendingPath(host), null);
  checkpoint('receipt');
  return {
    status: rendered !== null ? 'projected' : result.removed > 0 ? 'projection-removed' : 'absent',
    guard,
    receipt,
  };
}

/**
 * The definitions as this apply left them (review finding H-R7): each harness registers only the agent and skill files
 * the receipt lists and the hook groups the workspace owns after the apply, so a hook an apply did not register (no host
 * payload known, or disabled hooks) is never listed as registered.
 */
function appliedDefinitions(
  definitions: readonly PacketDefinition[],
  files: readonly { readonly path: string }[],
  registered: ReadonlySet<string>,
): readonly PacketDefinition[] {
  const written = new Set(files.map((file) => file.path));
  return definitions.map((row) =>
    row.word !== 'harness'
      ? row
      : {
          ...row,
          definition: {
            ...row.definition,
            registrations: {
              agents: row.definition.registrations.agents.filter((agent) => written.has(agent.path)),
              skills: row.definition.registrations.skills.filter((skill) => written.has(skill.path)),
              hooks: row.definition.registrations.hooks.filter((hook) => registered.has(hook.identity)),
            },
          },
        },
  );
}
/** `planHooks`, a refusal it does not locate at a file located at the settings the hook groups live in. */
export function planHookStep(root: string, host: HostName, rendered: HostOutput | null, cache: HookCache): HookStep {
  try {
    return planHooks(root, host, rendered, cache);
  } catch (error) {
    if (error instanceof DistributionError && 'unownedHook' in error) {
      const unowned = error.unownedHook as { hook: string; path: string };
      throw Object.assign(error, {
        hookRefusal: { drift: 'foreign', hook: unowned.hook, path: unowned.path } satisfies HookRefusal,
      });
    }
    const code = codeOf(error, '');
    if (
      error instanceof Error &&
      /^IA-/.test(code) &&
      code !== 'IA-DIST-RECOVERY-REQUIRED' &&
      refusedPath(error) === null
    ) {
      const located = new DistributionError(code, error.message, SETTINGS),
        hookRefusal = code === 'IA-DIST-LOCAL-MODIFICATION' ? handEditedGroup(root) : undefined;
      throw hookRefusal === undefined ? located : Object.assign(located, { hookRefusal });
    }
    throw error;
  }
}
/** An owned hook group's drift as the hook planner refuses it, with the planner's own wording (guard review G-N2). */
function handEdited(drift: ReturnType<typeof observeHookRegistration>[number]): DistributionError {
  return new DistributionError(
    'IA-DIST-LOCAL-MODIFICATION',
    drift.drift === 'missing'
      ? `Owned hook group for ${drift.hook} was deleted by hand; remove the registration ("ia host claude --remove --apply") and register it again`
      : `Owned hook group for ${drift.hook} changed or was duplicated; delete only that group from ${SETTINGS}, then remove the registration ("ia host claude --remove --apply") and register it again`,
  );
}
/**
 * What the hook step of a later apply would refuse, found before anything is written (review finding H-R3): an install,
 * update or remove checks it before its first install write, and a migration before it plans. With a hook registration
 * owned, the step is planned against the workspace's current records when they render: a group deleted, changed or
 * duplicated by hand refuses with the recovery doctor names, and so does a recorded payload a change of hooks would need.
 * When the records do not render, only a changed or duplicated group is refused, since a removal refuses it too.
 */
export function preflightHooks(root: string, host: HostName, given?: HostOutput | null): void {
  if (host !== 'claude' || readHookRegistration(root) === null) return;
  let rendered: HostOutput | null;
  try {
    rendered = given === undefined ? renderProjectionFor(root, host) : given;
  } catch {
    // Records that do not render refuse the refresh itself, with their own next action.
    rendered = null;
  }
  if (rendered !== null) {
    planHookStep(root, host, rendered, null);
    return;
  }
  const changed = observeHookRegistration(root).find((row) => row.drift === 'modified');
  if (changed !== undefined)
    throw Object.assign(new DistributionError('IA-DIST-LOCAL-MODIFICATION', handEdited(changed).message, SETTINGS), {
      hookRefusal: { drift: 'modified', hook: changed.hook } satisfies HookRefusal,
    });
}
/**
 * What a refresh's file plan would refuse, and its hook step, found before an install, update or remove writes anything
 * (review finding F4, the H-R3 class): the files are planned against the current records, rendered once, so a generated
 * skill refused at a populated folder of the user's refuses here (any other file refusal is left to the refresh, as
 * before); then `preflightHooks` runs on the same render.
 */
export function preflightProjection(root: string, host: HostName): void {
  let rendered: HostOutput | null;
  try {
    rendered = renderProjectionFor(root, host);
  } catch {
    // Records that do not render refuse the refresh itself, with their own next action.
    rendered = null;
  }
  // Only the populated skill folder refuses here: every other file refusal stays the refresh's after the install
  // commits, naming the applied install (host registration §6.3), as before.
  if (rendered !== null)
    try {
      planFiles(root, host, rendered);
    } catch (error) {
      if (skillFolderOf(error) !== undefined) throw error;
    }
  preflightHooks(root, host, rendered);
}
/**
 * The owned hook group a hook-registration refusal concerns, by its drift (review finding H-R1), so the refusal names the
 * recovery `hookRepair` words: a changed or duplicated group first, else a deleted one. Undefined when no owned group
 * drifted (an unmanaged identical one), which the settings repair covers.
 */
function handEditedGroup(root: string): HookRefusal | undefined {
  let drift: ReturnType<typeof observeHookRegistration>;
  try {
    drift = observeHookRegistration(root);
  } catch {
    return undefined;
  }
  const found = drift.find((row) => row.drift === 'modified') ?? drift.find((row) => row.drift === 'missing');
  return found === undefined ? undefined : { drift: found.drift as 'missing' | 'modified', hook: found.hook };
}

const HEX = /^[a-f0-9]{64}$/;
const digests = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      typeof (row as { path?: unknown }).path === 'string' &&
      HEX.test(String((row as { sha256?: unknown }).sha256)),
  );
/**
 * B12: the receipt `applyHostProjection` wrote for `host`, or null when there is none — a 1.x registration, or one
 * whose receipt was deleted. A receipt that cannot be read, or that lacks the fields `ia doctor` checks, refuses at
 * its own path.
 */
export function readReceipt(root: string, host: HostName): PacketReceipt | null {
  const path = STATE.receipt(host);
  if (!existsSync(resolve(root, path))) return null;
  let value: unknown;
  try {
    value = readWorkspaceJson({ root, path });
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      throw new DistributionError(error.code, error.message, path);
    throw error;
  }
  const row = value as Partial<Record<keyof PacketReceipt, unknown>> | null;
  if (
    row === null ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.format !== 'ia.packet-receipt.v1' ||
    row.host !== host ||
    !HEX.test(String(row.packetDigest)) ||
    !digests(row.files) ||
    !digests(row.removed) ||
    !Array.isArray(row.foreign) ||
    !row.foreign.every((item) => typeof item === 'string') ||
    (row.generated !== undefined &&
      (!digests(row.generated) ||
        !(row.generated as unknown[]).every(
          (item) =>
            typeof (item as { identity?: unknown }).identity === 'string' &&
            ['agent-profile', 'playbook'].includes(String((item as { word?: unknown }).word)),
        ))) ||
    (row.hooks !== undefined &&
      (!Array.isArray(row.hooks) ||
        !(row.hooks as unknown[]).every(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as { identity?: unknown }).identity === 'string' &&
            Array.isArray((item as { tools?: unknown }).tools) &&
            HEX.test(String((item as { sha256?: unknown }).sha256)),
        ))) ||
    (row.removedHooks !== undefined && !hookDigests(row.removedHooks)) ||
    (row.unsupported !== undefined && !Array.isArray(row.unsupported)) ||
    (row.definitions !== undefined && !Array.isArray(row.definitions))
  )
    throw new DistributionError('IA-DIST-INPUT-INVALID', 'Invalid projection receipt', path);
  return row as PacketReceipt;
}
