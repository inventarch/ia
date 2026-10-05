/**
 * `ia host`: docs/specs/host-registration/README.md §4.
 *
 * One verb owns the managed host set of §5.1: the MCP entry, the steward guard hook and the workspace projection,
 * plus the context element §5.2's gate keeps unselected. It plans by default and never writes while planning — the
 * payload's location is computed, not created. `--apply` materializes the embedded payload once per user (§3.3),
 * re-plans every sub-transaction against the verified payload, then applies them in order — mcp, hooks, projection —
 * and removal runs them in reverse (§8). No cross-file atomicity is claimed: a rerun converges, and a pending journal
 * refuses naming its recovery. Nothing here reports that a server answered or a hook ran; `applied.observed` is
 * always false (plan-0002 M5 exit).
 *
 * The plan asks the mechanisms themselves. `planHostFor` and `planGuardFor` plan against the payload apply will
 * materialize, described from the pin without reading it (`expectedHostCache`), so a conflict in the preview is the
 * service's own refusal — its code and message unchanged (contract §4.1) — and is the refusal apply would raise.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { lifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import { WORKSPACE_PROJECTION_MARKER } from '@inventarch/compliance';
import type { GuardPlan } from '@inventarch/distribution/guard-registration';
import {
  applyGuardRegistration,
  planGuardFor,
  planGuardRegistration,
} from '@inventarch/distribution/guard-registration';
import type { HostCacheTarget, HostPlan } from '@inventarch/distribution/host';
import { hostRow, workspaceRow } from '@inventarch/distribution/hosts';
import {
  applyHost,
  assertHostRegistrationIdle,
  expectedHostCache,
  HOST_REGISTRATION,
  planHost,
  planHostFor,
} from '@inventarch/distribution/host';
import {
  assertHomeOutsideWorkspace,
  hostPayloadPath,
  materializeHostPayload,
  readHostPin,
} from '@inventarch/distribution/host-home';
import { assertIaHomeUsable } from '@inventarch/distribution/ia-home';
import { readMaterializedPlugin } from '@inventarch/distribution/plugin-home';
import type { ProjectionAction, ProjectionPlan } from '@inventarch/distribution/projection';
import { applyProjection, planProjection } from '@inventarch/distribution/projection';
import { UsageError } from './args.js';
import { homeSrcRemedy, hostHome, located } from './home-remedy.js';
import type { Context, Result } from './consumer.js';
import { confirm, Interrupted, Refusal, refusalOf, requireRoot } from './consumer.js';
import type { Artifact, HostName } from './host-projection.js';
import { checkAdmitted, renderProjectionFor } from './host-projection.js';
import { codeOf } from './session.js';
import type { Capabilities, Field, SymbolName } from './render.js';
import {
  atom,
  blockSymbolWidth,
  commandFacts,
  document,
  entry,
  fieldRows,
  headerLine,
  indentOf,
  quote,
  sectionLabel,
  truncateDigest,
  words,
} from './render.js';
import { runUserHost } from './user-host.js';

const DAMAGED = 'The ia installation is damaged; reinstall @inventarch/cli so assets/host travels with it.';

export type ElementId = 'mcp' | 'hooks' | 'context' | 'projection';
/**
 * §5.4's four capabilities, plus `absent` for a removal row whose element this workspace does not own: claiming
 * `registered` for something that is not there would be a false report.
 */
export type Capability = 'registered' | 'not selected' | 'unsupported by host' | 'refused' | 'absent';
export interface Conflict {
  readonly code: string;
  readonly path: string;
  readonly reason: string;
}
export interface Element {
  readonly id: ElementId;
  /**
   * §4's plan actions. `none` is an element with nothing to do: the unselected context element, Codex hooks, or a
   * removal of an element this workspace does not own.
   */
  readonly action: 'create' | 'update' | 'unchanged' | 'remove' | 'refused' | 'none';
  readonly paths: readonly string[];
  readonly capability: Capability;
  readonly conflict: Conflict | null;
  /**
   * The projection's per-file actions. `unowned` is a marked steward file this workspace's projection state does
   * not list (§6.3 "stale files"): it is reported and never touched, so it is not a conflict.
   */
  readonly files?: readonly ProjectionAction[];
}
export interface HostView {
  readonly root: string;
  readonly host: HostName;
  readonly remove: boolean;
  readonly release: string;
  readonly home: string;
  readonly elements: readonly Element[];
  readonly undo: string;
  /** The exact command that applies this plan, rebuilt from the parsed arguments. */
  readonly invocation: string;
  /** Elements whose ownership state existed when planned; it decides which remedy a modified entry names. */
  readonly owned: ReadonlySet<ElementId>;
  /** Whether `--root` was given: every `ia host` command a next action names then carries it (`rootedNext`). */
  readonly rooted: boolean;
  /**
   * Host plugin distribution spec §7.1: for a host whose adapter row installs a user-level plugin (Claude), whether it
   * is materialized in the IA home, and the command that adds it. This verb only names that command; it never runs it.
   */
  readonly userPlugin: UserPlugin | null;
}
export interface UserPlugin {
  readonly installed: boolean;
  readonly command: string;
}
/** §7.1: the user-level command a workspace plan names when the plugin is missing. It takes no --root. */
export const USER_PLUGIN_COMMAND = 'ia host claude --user --apply';
export const USER_PLUGIN_MISSING = `The user-level plugin is not installed; run "${USER_PLUGIN_COMMAND}" to add it.`;

/** §5.3's sentence, verbatim, per host. Every element — the projection included — is machine-local. */
export const MACHINE_LOCAL: Readonly<Record<HostName, string>> = {
  claude:
    'These files are machine-local: .mcp.json, .claude/settings.local.json, .claude/rules/ia-workspace.md, .claude/skills/ia-authoring/, the projected .claude/agents/*.md files and .ia/distributions/. Do not commit them.',
  codex:
    'These files are machine-local: .codex/config.toml, AGENTS.md, .agents/skills/ia-authoring/ and .ia/distributions/. Do not commit them.',
};
/** §5.4: the MCP element's one fixed addition, from §2.3's host facts. */
export const MCP_APPROVAL = 'Claude Code asks for approval before starting a project MCP server.';
/**
 * Operator decision 2026-09-23 ("narrow + disclose"): what the registered steward guard refuses, said where it is registered.
 * #540: the routes it judges and the paths it cannot see.
 */
export const GUARD_SCOPE =
  "The steward guard denies changes to the files ia host owns and to records under .ia/src/systems/<name>/ unless they come from that system's steward subagent (<name>-steward). It checks file-tool edits and the writes a Bash or PowerShell command's own text shows, inline code included; it cannot see paths a program works out while it runs.";
/** §5.1's files, exported once so `ia doctor` names the same ones. */
export const MCP_PATH: Readonly<Record<HostName, string>> = { claude: '.mcp.json', codex: '.codex/config.toml' };
export const SETTINGS = '.claude/settings.local.json';
export const HOSTS_AREA = '.ia/distributions/hosts';
/** §5.1's state files. Their presence says whether this workspace owns an element; their content is the mechanisms'. */
export const STATE = {
  mcp: (host: HostName): string => `${HOSTS_AREA}/${host}-${HOST_REGISTRATION}.json`,
  hooks: `${HOSTS_AREA}/claude-guard-${HOST_REGISTRATION}.json`,
  projection: (host: HostName): string => `${HOSTS_AREA}/${host}-projection.json`,
} as const;

/**
 * What one host's MCP element owns, named so a user can find and delete exactly it. Codex's is a marked block
 * (`reconcileConfig` in `@inventarch/distribution`), so the markers themselves are part of it: a leftover marker makes the
 * next plan refuse the block as unowned.
 */
const OWNED_MCP: Readonly<Record<HostName, string>> = {
  claude: 'the ia-workspace entry in .mcp.json',
  codex:
    `the IA block in .codex/config.toml, from "# BEGIN IA PROJECTION host-${HOST_REGISTRATION}" ` +
    `through "# END IA PROJECTION host-${HOST_REGISTRATION}", markers included`,
};
const OWNED_GUARD = `the IA guard group in ${SETTINGS}`;
/**
 * The repair for an ownership state file that cannot be read, or null when `path` is not one. The mechanisms refuse
 * every plan until the file goes, and deleting it alone would leave what it owned looking unmanaged, so the repair
 * deletes both. `ia host` and `ia doctor` both print it, so the two cannot word it differently.
 */
export function stateRepair(host: HostName, path: string, rerun: string): string | null {
  if (path === STATE.mcp(host)) return `Delete ${path} and ${OWNED_MCP[host]}, then run "${rerun}".`;
  if (host === 'claude' && path === STATE.hooks) return `Delete ${path} and ${OWNED_GUARD}, then run "${rerun}".`;
  if (path === STATE.projection(host)) return `Delete ${path}, then run "${rerun}".`;
  return null;
}
/**
 * The repair for an owned entry changed by hand. Apply refuses it and removal refuses it too, so it goes first; then
 * removal clears the ownership state and registration starts over. Each step was exercised against the verb.
 */
export function modifiedRepair(host: HostName, elements: readonly ('mcp' | 'hooks')[]): string {
  const owned = elements.map((element) => (element === 'mcp' ? OWNED_MCP[host] : OWNED_GUARD)).join(' and ');
  return `Delete ${owned}, then run "ia host ${host} --remove --apply" and "ia host ${host} --apply".`;
}
/** §8: each pending journal names its own recovery on the distribution binary. `ia doctor` reports the same ones. */
export const JOURNALS: readonly (readonly [string, string])[] = [
  [`${HOSTS_AREA}/pending.json`, 'recover-host'],
  [`${HOSTS_AREA}/guard-pending.json`, 'recover-guard'],
  [`${HOSTS_AREA}/lifecycle-pending.json`, 'recover-lifecycle'],
];
/** §8: the lock every host sub-transaction holds while it writes (`acquireHostRegistrationLock`). */
export const HOST_LOCK = `${HOSTS_AREA}/lock.json`;
/** A recovery on the distribution binary, rooted and quoted as every printed root is. */
export const recoverCommand = (command: string, root: string): string =>
  `ia-distribution ${command} --root ${quote(root)}`;
/**
 * §8 "or refuses naming a recovery": a held host lock is another run or a killed one, and nothing here can tell
 * which, so the next action names the recovery that decides it — `recoverHost` takes the lock in recovery mode,
 * which clears a dead holder's lock and refuses a live one. It names no `ia host` command, so `--root` needs no rewrite.
 */
export const lockNext = (root: string): string =>
  `Another ia host run holds the host lock, or a killed run left it: run "${recoverCommand('recover-host', root)}" (it clears a dead holder's lock and refuses a live one), then rerun.`;
/**
 * The refusal for a held host lock, located at the lock and naming its recovery, or null for any other error. Every
 * mechanism an `ia host` apply or an install's projection refresh runs raises IA-DIST-INSTALL-BUSY only from that
 * lock, so there the code alone identifies it.
 */
export function lockRefusal(error: unknown, root: string): Refusal | null {
  const refusal = refusalOf(error);
  return refusal.code === 'IA-DIST-INSTALL-BUSY'
    ? new Refusal(refusal.code, refusal.message, 3, { path: HOST_LOCK }, lockNext(root))
    : null;
}
/** lifecycle-profile.ts: Codex's hooks are unavailable, and the profile says why. */
const CODEX_HOOKS = lifecycleProfile('codex', '0.116.0').reason ?? 'Codex hooks are unavailable.';

/** §3.3 step 1, through the service: a missing or malformed pin or archive is IA-DIST-ARTIFACT-UNAVAILABLE. */
const bundledPin = (packageRoot: string): ReturnType<typeof readHostPin> =>
  located(null, DAMAGED, () => readHostPin(packageRoot));
/** The running installation's payload release, or null with the code that kept it from being read. */
export type Pinned = { readonly release: string } | { readonly release: null; readonly code: string };
/**
 * §7: the release `ia doctor` and `ia inspect` observe hosts against. An installation that carries no payload is not
 * an error there: the release comparison is skipped, and doctor says why with the code.
 */
export function pinnedRelease(packageRoot: string): Pinned {
  try {
    return { release: readHostPin(packageRoot).pin.release };
  } catch (error) {
    return { release: null, code: codeOf(error, 'IA-DIST-ARTIFACT-UNAVAILABLE') };
  }
}

/** §4: the target must be initialized and admit; anything else names ia init or ia validate. */
function requireInitialized(root: string): void {
  if (!existsSync(resolve(root, '.ia/release.json')))
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The target is not an initialized workspace: .ia/release.json is absent',
      3,
      { path: root },
      'Run "ia init" first.',
    );
}
/** The journal a failed transaction left behind, if any, with the command that recovers it. */
const pendingJournal = (root: string): readonly [string, string] | undefined =>
  JOURNALS.find(([path]) => existsSync(resolve(root, path)));
const recoverNext = (root: string, command: string, host: HostName): string =>
  `Run "${recoverCommand(command, root)}", then rerun "ia host ${host}".`;
/**
 * A next action of this verb made runnable from any cwd: every quoted `ia host <host>` command it names gains
 * `--root <root>`. `ia init --host` uses it, because its `<directory>` may not be the cwd a rerun discovers from.
 * Every command this file prints opens with `"ia host <host>` and none names `--root` itself, so the rewrite reaches
 * each command and nothing else.
 */
export const rootedNext = (next: string, host: HostName, root: string): string =>
  next.replace(new RegExp(`"ia host ${host}(?! --root\\b)`, 'g'), () => `"ia host ${host} --root ${quote(root)}`);
/** A next action as printed: with `--root` given, each `ia host <host>` command in it carries the root. */
export const hostNext = (text: string, host: HostName, root: string, rooted: boolean): string =>
  rooted ? rootedNext(text, host, root) : text;
/** The file a mechanism located its refusal at (`locate` in @inventarch/distribution's files.ts), or null. */
export const refusedPath = (error: unknown): string | null =>
  error !== null && typeof error === 'object' && 'path' in error && typeof error.path === 'string' ? error.path : null;
/**
 * §6.3: the repair for a projection refusal located at `path`. The ownership state has its own repair; any other file
 * is never replaced or adopted, so it is moved or deleted first. `ia host`, `ia doctor` and the install refresh all
 * name it this way.
 */
export const projectionRepair = (host: HostName, path: string, rerun: string): string =>
  stateRepair(host, path, rerun) ?? `Move or delete ${path}, then run "${rerun}".`;
/** §8: a pending journal refuses the whole verb and names the recovery that clears it. */
function requireIdle(root: string, host: HostName, supplied: string): void {
  try {
    assertHostRegistrationIdle(root);
  } catch (error) {
    const refusal = refusalOf(error);
    const [journal, command] = pendingJournal(root) ?? JOURNALS[0]!;
    throw new Refusal(refusal.code, refusal.message, 3, { path: journal }, recoverNext(supplied, command, host));
  }
}

/** A mechanism's refusal as an element conflict: the service's code and message, located at its file. */
function conflictOf(error: unknown, path: string): Conflict {
  const refusal = refusalOf(error);
  return { code: refusal.code, path: refusedPath(error) ?? path, reason: refusal.message };
}
const pin = (text: string | null): string | null =>
  text === null ? null : createHash('sha256').update(text).digest('hex');
/** A registration plan's action, from the bytes it would write against the bytes it read. */
const actionOf = (plan: {
  readonly before: { readonly config: string | null; readonly state: string | null };
  readonly after: { readonly config: string | null; readonly state: string | null };
}): Element['action'] =>
  plan.after.state === null
    ? 'remove'
    : plan.before.state === null
      ? 'create'
      : pin(plan.after.config) === plan.before.config && pin(plan.after.state) === plan.before.state
        ? 'unchanged'
        : 'update';
/** One registration element, planned by its mechanism; `none` when a removal finds nothing owned. */
function registrationElement(
  id: 'mcp' | 'hooks',
  path: string,
  owned: boolean,
  remove: boolean,
  plan: () => HostPlan | GuardPlan,
): Element {
  if (remove && !owned) return { id, action: 'none', paths: [path], capability: 'absent', conflict: null };
  try {
    return { id, action: actionOf(plan()), paths: [path], capability: 'registered', conflict: null };
  } catch (error) {
    return { id, action: 'refused', paths: [path], capability: 'refused', conflict: conflictOf(error, path) };
  }
}
/**
 * §5.2: the context element. Claude reports it `not selected` until the gate lifts; Codex reports it `unsupported by
 * host`, because it is delivered through lifecycle hooks and Codex hooks are unavailable — the same reason the
 * hooks element gives — so both hosts carry the same four rows.
 */
const contextElement = (host: HostName): Element => ({
  id: 'context',
  action: 'none',
  paths: [],
  capability: host === 'claude' ? 'not selected' : 'unsupported by host',
  conflict: null,
});
/** §5.1 `projection`, planned by the real planner: it reads only the workspace, so the plan is exactly apply's. */
function projectionElement(root: string, host: HostName, artifacts: readonly Artifact[]): Element {
  try {
    const files = planProjection({ root, host, artifacts, marker: WORKSPACE_PROJECTION_MARKER }).actions;
    const touched = files.filter((file) => file.action !== 'unowned');
    const action: Element['action'] =
      artifacts.length === 0
        ? touched.some((file) => file.action === 'remove')
          ? 'remove'
          : 'none'
        : touched.every((file) => file.action === 'unchanged')
          ? 'unchanged'
          : touched.every((file) => file.action === 'create')
            ? 'create'
            : 'update';
    return {
      id: 'projection',
      action,
      paths: touched.map((file) => file.path),
      capability: action === 'none' ? 'absent' : 'registered',
      conflict: null,
      files,
    };
  } catch (error) {
    return {
      id: 'projection',
      action: 'refused',
      paths: [],
      capability: 'refused',
      conflict: conflictOf(error, STATE.projection(host)),
    };
  }
}

/** The invocation is rebuilt from the parsed arguments, so the printed command is the one that was understood. */
function invocationOf(context: Context, host: HostName, remove: boolean): string {
  const root = context.args.value('root');
  return [
    `ia host ${host}`,
    ...(remove ? ['--remove'] : []),
    ...(root === undefined ? [] : ['--root', quote(root)]),
  ].join(' ');
}

/** §4's plan. It reads the workspace and the package's pin and writes nothing, the payload included. */
export function collectHost(context: Context): HostView {
  const { args, host } = context;
  // Host plugin distribution spec §4: the adapter table decides. An unknown host is usage, and so is --context with
  // Codex; both precede every read (§3). A known row without the workspace set (Cursor, planned) refuses.
  const given = args.positionals[0] ?? '';
  if (hostRow(given) === undefined) throw new UsageError(`ia host takes claude, codex or cursor; got ${given}`);
  const row = workspaceRow(given);
  if (row === undefined)
    throw new Refusal(
      'IA-DIST-HOST-UNSUPPORTED',
      `${hostRow(given)!.label} support is planned; nothing was written`,
      3,
      null,
      'Run "ia host claude" or "ia host codex".',
    );
  const name: HostName = row.id;
  const remove = args.flag('remove'),
    selected = args.value('context');
  if (selected !== undefined && name === 'codex')
    throw new UsageError('--context applies to claude only; Codex hooks are unavailable');
  const supplied = requireRoot(context);
  requireInitialized(supplied);
  // Spec §5.2's gate: until the binding's coordinate, bootstrap and policy are derived and one context run from a v2
  // payload is observed generating, the context element refuses. The spec fixes this code for the gate.
  if (selected !== undefined)
    throw new Refusal(
      'IA-DIST-HOST-UNSUPPORTED',
      'The lifecycle context element is not qualified in this release',
      3,
      { path: supplied },
      `Run "ia host ${name}" without --context.`,
    );
  // The mechanisms record the real path (files.ts `workspace()`), so the plan works on the same one.
  const root = realpathSync(supplied);
  const home = hostHome(host.env);
  // §3.3: neither may contain the other; the service raises IA-DIST-PATH-UNSAFE.
  located(supplied, 'Move the workspace, or set IA_HOME to an absolute directory outside it.', () =>
    assertHomeOutsideWorkspace(home, root),
  );
  // §3: refuse a home that itself looks like a workspace at plan time, before any payload write is attempted.
  located(null, homeSrcRemedy(home), () => assertIaHomeUsable(home));
  const { pin: bundled } = bundledPin(host.packageRoot);
  requireIdle(root, name, supplied);
  // §4: zero error findings. A removal renders nothing, so it checks admission alone.
  let artifacts: readonly Artifact[] = [];
  if (remove) checkAdmitted(root);
  else artifacts = renderProjectionFor(root, name, 'all'); // this run registers the current guard matcher (#540)
  // A host home reached through a symbolic link or junction is refused by the mechanism (IA-DIST-PATH-UNSAFE), because
  // the payload it verifies must be the one the registration names; the remedy is a home with no link in its path.
  const expected: HostCacheTarget = located(null, 'Set IA_HOME to a directory path with no links, or unset it.', () =>
    expectedHostCache(hostPayloadPath(home, bundled.release), bundled.release),
  );
  const owned = new Set<ElementId>();
  if (existsSync(resolve(root, STATE.mcp(name)))) owned.add('mcp');
  if (name === 'claude' && existsSync(resolve(root, STATE.hooks))) owned.add('hooks');
  const mcp = registrationElement('mcp', MCP_PATH[name], owned.has('mcp'), remove, () =>
    remove ? planHostFor(root, name, null, HOST_REGISTRATION) : planHostFor(root, name, expected),
  );
  const hooks: Element =
    name === 'codex'
      ? { id: 'hooks', action: 'none', paths: [], capability: 'unsupported by host', conflict: null }
      : registrationElement('hooks', SETTINGS, owned.has('hooks'), remove, () =>
          remove ? planGuardRegistration(root, { remove: HOST_REGISTRATION }) : planGuardFor(root, expected),
        );
  return {
    root: supplied,
    host: name,
    remove,
    release: bundled.release,
    home,
    elements: [mcp, hooks, contextElement(name), projectionElement(root, name, artifacts)],
    undo: `ia host ${name} --remove --apply`,
    invocation: invocationOf(context, name, remove),
    owned,
    rooted: context.args.value('root') !== undefined,
    userPlugin:
      row.user === 'plugin' ? { installed: readMaterializedPlugin(home) !== null, command: USER_PLUGIN_COMMAND } : null,
  };
}

export interface HostApplied {
  readonly status: 'host-registered' | 'host-removed';
  readonly elements: readonly { readonly id: ElementId; readonly status: string }[];
  readonly observed: false;
}
/** A next action of this verb as printed: with `--root` given, each `ia host` command in it carries the root. */
const say = (view: Pick<HostView, 'host' | 'root' | 'rooted'>, text: string): string =>
  hostNext(text, view.host, view.root, view.rooted);
/** The next action a conflict renders, and the one its refusal carries, rooted when `--root` was given. */
const nextFor = (view: HostView, id: ElementId, conflict: Conflict): string =>
  say(view, conflictNext(view, id, conflict));
/** The unrooted next action for a conflict. §5.3 fixes the unowned MCP entry's wording. */
function conflictNext(view: HostView, id: ElementId, conflict: Conflict): string {
  const rerun = `ia host ${view.host}${view.remove ? ' --remove' : ''} --apply`;
  // An unreadable ownership state: the mechanisms locate the refusal at the state file itself.
  const unreadable = stateRepair(view.host, conflict.path, rerun);
  if (unreadable !== null) return unreadable;
  if (conflict.code === 'IA-DIST-LOCAL-MODIFICATION' && id === 'hooks' && view.owned.has('hooks'))
    return modifiedRepair(view.host, ['hooks']);
  if (conflict.code === 'IA-DIST-LOCAL-MODIFICATION' && id === 'mcp') {
    // Owned: removal tolerates a deleted entry, so deleting it and re-registering converges. Unowned: §5.3's wording,
    // made exact for Codex, where the collision can be any ia-workspace table or a file that no longer parses.
    if (view.owned.has('mcp')) return modifiedRepair(view.host, ['mcp']);
    return view.host === 'codex'
      ? 'Remove any ia-workspace server outside the IA block from .codex/config.toml and make sure the file parses as TOML, then run "ia host codex --apply".'
      : `Remove that entry, then run "ia host ${view.host} --apply".`;
  }
  if (conflict.code === 'IA-DIST-HOST-UNSUPPORTED' && id === 'hooks')
    return `Remove disableAllHooks from the Claude settings, then run "${rerun}".`;
  if (id === 'projection') return projectionRepair(view.host, conflict.path, rerun);
  return `Fix ${conflict.path}, then run "${rerun}".`;
}
const refusalFor = (view: HostView, id: ElementId, conflict: Conflict): Refusal =>
  new Refusal(conflict.code, conflict.reason, 3, { path: conflict.path }, nextFor(view, id, conflict));
/** Apply's re-plan against the verified payload. A refusal found here is raised before any workspace write. */
function replan<T>(view: HostView, id: ElementId, path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw refusalFor(view, id, conflictOf(error, path));
  }
}
/**
 * §3.3 steps 3-4. A payload directory that fails verification is named by the mechanism and the remedy is to delete
 * it; nothing overwrites it. Any other failure is the bundled payload's own, which only a reinstall repairs.
 */
function materialize(view: HostView, packageRoot: string): string {
  const { pin: bundled, archive, archivePath } = bundledPin(packageRoot);
  const payload = hostPayloadPath(view.home, bundled.release);
  // Re-checked explicitly rather than inferred from a caught refusal's message: verifyNaming's own PATH-UNSAFE
  // wrapping ("... at <payload>; delete that directory") also names a path under view.home, so pattern-matching the
  // message would misroute a real corrupt-payload refusal into this remedy.
  located(null, homeSrcRemedy(view.home), () => assertIaHomeUsable(view.home));
  try {
    return materializeHostPayload({ home: view.home, archive: archive(), pin: bundled }).directory;
  } catch (error) {
    const refusal = refusalOf(error),
      corrupt = refusal.message.includes(payload);
    throw new Refusal(
      refusal.code,
      refusal.message,
      3,
      { path: corrupt ? payload : archivePath },
      corrupt ? say(view, `Delete ${payload}, then run "ia host ${view.host} --apply".`) : DAMAGED,
    );
  }
}

/**
 * §8: mcp, hooks, projection in order; removal in reverse. The payload is materialized, then every sub-transaction is
 * re-planned with the verifying planners before any is applied, so a refusal any planner can find is raised before
 * the workspace changes; each apply then re-plans under the host lock and refuses a plan that went stale.
 * Cancellation is observed between sub-transactions. A failure after an element was written names the rerun that
 * finishes the set, or the recovery a pending journal needs. `checkpoint` runs after each element completes, which
 * is where an interruption test cuts.
 */
export function applyHostSet(
  view: HostView,
  packageRoot: string,
  signal?: AbortSignal,
  checkpoint: (id: ElementId) => void = () => {},
): HostApplied {
  const refused = view.elements.find((element) => element.conflict !== null);
  if (refused !== undefined) throw refusalFor(view, refused.id, refused.conflict!);
  const root = realpathSync(view.root),
    host = view.host;
  const rerun = `ia host ${host}${view.remove ? ' --remove' : ''} --apply`;
  const done: { id: ElementId; status: string }[] = [];
  const skipped = (id: ElementId): { id: ElementId; status: string } => ({
    id,
    status: view.elements.find((element) => element.id === id)!.capability,
  });
  const step = (id: ElementId, run: () => string): void => {
    if (signal?.aborted) throw new Interrupted(say(view, `Run "${rerun}" to finish.`));
    let status: string;
    try {
      status = run();
    } catch (error) {
      const refusal = refusalOf(error),
        journal = pendingJournal(root);
      if (journal !== undefined)
        throw new Refusal(
          refusal.code,
          refusal.message,
          3,
          { path: journal[0] },
          say(view, recoverNext(view.root, journal[1], host)),
        );
      const busy = lockRefusal(error, view.root);
      if (busy !== null) throw busy;
      if (done.length > 0)
        throw new Refusal(refusal.code, refusal.message, 3, refusal.where, say(view, `Run "${rerun}" to finish.`));
      throw error;
    }
    done.push({ id, status });
    checkpoint(id);
  };
  if (!view.remove) {
    const cache = materialize(view, packageRoot);
    const mcp = replan(view, 'mcp', MCP_PATH[host], () => planHost(root, host, cache));
    const hooks =
      host === 'claude' ? replan(view, 'hooks', SETTINGS, () => planGuardRegistration(root, { cache })) : null;
    const artifacts = renderProjectionFor(root, host, 'all'); // the hooks step of this run registers the current matcher (#540)
    const projection: ProjectionPlan = replan(view, 'projection', STATE.projection(host), () =>
      planProjection({ root, host, artifacts, marker: WORKSPACE_PROJECTION_MARKER }),
    );
    step('mcp', () => applyHost(mcp).status);
    if (hooks === null) done.push(skipped('hooks'));
    else step('hooks', () => applyGuardRegistration(hooks).status);
    done.push(skipped('context'));
    step('projection', () => applyProjection(projection).status);
    return { status: 'host-registered', elements: done, observed: false };
  }
  // A removal plans only what the view found owned; `none` means there is nothing of that element to remove.
  const absent = (id: ElementId): boolean => view.elements.find((element) => element.id === id)!.action === 'none';
  const projection = replan(view, 'projection', STATE.projection(host), () =>
    planProjection({ root, host, artifacts: [], marker: WORKSPACE_PROJECTION_MARKER }),
  );
  const hooks =
    host === 'claude' && !absent('hooks')
      ? replan(view, 'hooks', SETTINGS, () => planGuardRegistration(root, { remove: HOST_REGISTRATION }))
      : null;
  const mcp = absent('mcp')
    ? null
    : replan(view, 'mcp', MCP_PATH[host], () => planHost(root, host, null, HOST_REGISTRATION));
  step('projection', () => (applyProjection(projection).removed > 0 ? 'projection-removed' : 'absent'));
  done.push(skipped('context'));
  if (host === 'codex') done.push(skipped('hooks'));
  else step('hooks', () => (hooks === null ? 'absent' : applyGuardRegistration(hooks).status));
  step('mcp', () => (mcp === null ? 'absent' : applyHost(mcp).status));
  return { status: 'host-removed', elements: done, observed: false };
}

/** §4 `--json`: the plan always, and `applied` only after an apply. */
const hostEnvelope = (view: HostView, applied: HostApplied | null): unknown => ({
  version: 1,
  command: 'host',
  root: view.root,
  host: view.host,
  apply: applied !== null,
  plan: {
    release: view.release,
    home: view.home,
    elements: view.elements,
    undo: view.undo,
    ...(view.userPlugin === null ? {} : { userPlugin: view.userPlugin }),
  },
  ...(applied === null ? {} : { applied }),
});

const FILE_SYMBOL: Readonly<Record<ProjectionAction['action'], SymbolName>> = {
  create: 'added',
  update: 'updated',
  unchanged: 'info',
  remove: 'removed',
  unowned: 'warning',
};
const elementSymbol = (element: Element): SymbolName =>
  element.conflict !== null
    ? 'error'
    : element.action === 'none' || element.action === 'unchanged'
      ? 'info'
      : 'success';
function elementFields(view: HostView): readonly Field[] {
  return view.elements.map((element) => {
    const facts = [element.action, element.capability, ...(element.id === 'projection' ? [] : element.paths)];
    if (element.id === 'hooks' && element.capability === 'unsupported by host')
      facts.push(CODEX_HOOKS.replace(/\.$/, ''));
    if (element.conflict !== null) facts.push(`${element.conflict.code} ${element.conflict.reason}`);
    return {
      symbol: elementSymbol(element),
      label: element.id,
      value: words(facts.join('; ')),
      action: element.conflict === null ? null : words(nextFor(view, element.id, element.conflict)),
    };
  });
}
/** Each projected file with its action; an unowned steward file says why it is left alone. */
const fileBlock = (view: HostView, caps: Capabilities): readonly string[] =>
  (view.elements.find((element) => element.id === 'projection')?.files ?? []).flatMap((file) =>
    entry(
      [
        [
          atom(file.path, 'cyan', 0),
          ...words(
            file.action === 'unowned'
              ? "unowned; marked but not listed in this workspace's projection state, left untouched"
              : file.action,
            null,
            2,
          ),
        ],
      ],
      // Nested at the elements block's content column (§6.4 rule 3), so each file sits under the element it belongs to.
      {
        column: indentOf(1) + blockSymbolWidth(view.elements.map(elementSymbol), caps.ascii) + 2,
        symbol: FILE_SYMBOL[file.action],
      },
      caps,
    ),
  );
const headerBlock = (view: HostView, caps: Capabilities): readonly string[] => [
  ...headerLine(
    'Plan',
    `host ${view.host}${view.remove ? ' --remove' : ''}`,
    [{ text: `release ${truncateDigest(view.release, caps.ascii)}`, column: 35 }],
    caps,
  ),
  ...headerLine('Root', view.root, [], caps),
  ...headerLine('Home', view.home, [], caps),
];
const elementsBlock = (view: HostView, caps: Capabilities): readonly string[] => [
  sectionLabel('Elements', caps),
  ...fieldRows(elementFields(view), { depth: 1 }, caps),
  ...fileBlock(view, caps),
];
/**
 * §5.3's machine-local sentence and, for a Claude registration, §5.4's approval note and the guard's scope (the
 * hooks element is registered only for Claude). `ia init --host` prints the same blocks after its host step, so the
 * two verbs cannot word them differently.
 */
export const hostNotes = (host: HostName, caps: Capabilities, remove = false): readonly (readonly string[])[] => [
  entry([words(MACHINE_LOCAL[host])], { depth: 1, symbol: 'warning' }, caps),
  ...(host === 'claude' && !remove
    ? [
        entry([words(MCP_APPROVAL)], { depth: 1, symbol: 'info' }, caps),
        entry([words(GUARD_SCOPE)], { depth: 1, symbol: 'info' }, caps),
      ]
    : []),
];
/**
 * §7.1: a registration plan also names the missing user-level plugin's command. It is printed as is, never through
 * `say`: that command belongs to no workspace, so it never carries --root.
 */
const notesBlocks = (view: HostView, caps: Capabilities): readonly (readonly string[])[] => [
  ...hostNotes(view.host, caps, view.remove),
  ...(view.userPlugin !== null && !view.userPlugin.installed && !view.remove
    ? [entry([words(USER_PLUGIN_MISSING)], { depth: 1, symbol: 'info' }, caps)]
    : []),
];

export function renderHostPlan(view: HostView, applied: HostApplied | null, caps: Capabilities): string {
  const conflicted = view.elements.some((element) => element.conflict !== null);
  return document(
    [
      headerBlock(view, caps),
      applied === null
        ? entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps)
        : entry(
            [
              words(
                applied.status === 'host-registered'
                  ? 'Registered: written; not observed answering.'
                  : 'Removed the owned host set.',
              ),
            ],
            { depth: 1, symbol: 'success' },
            caps,
          ),
      elementsBlock(view, caps),
      ...notesBlocks(view, caps),
      entry(
        [
          ...(applied === null && !conflicted
            ? commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps)
            : []),
          // `plan.undo` stays unrooted (§4 `--json`); the printed command carries --root when it was given.
          ...(view.remove ? [] : commandFacts('Undo with "', say(view, `"${view.undo}"`).slice(1, -1), '".', 3, caps)),
          ...(applied !== null && !view.remove ? [words('Run "ia doctor" for the observed host state.')] : []),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}
/** §2.8 rule 3's summary: what the preview shows, without its note or footer, because the question is the action. */
const renderHostSummary = (view: HostView, caps: Capabilities): string =>
  document([headerBlock(view, caps), elementsBlock(view, caps), ...notesBlocks(view, caps)], { leadingBlank: true });
export const CONFIRMATION = 'Apply this host registration? [y/N] ';
const REMOVAL_CONFIRMATION = 'Remove this host registration? [y/N] ';

export async function runHost(context: Context): Promise<Result> {
  const { args, caps, host, json } = context;
  // Host plugin distribution spec §7.1: `--user` is the user-level entry point, which needs no workspace.
  if (args.flag('user')) return runUserHost(context);
  let view: HostView;
  try {
    view = collectHost(context);
  } catch (error) {
    // Refusals raised before a view exists — the --context gate, a pending journal — name `ia host` commands too.
    const supplied = args.value('root'),
      name = args.positionals[0];
    if (
      !(error instanceof Refusal) ||
      error.next === null ||
      supplied === undefined ||
      (name !== 'claude' && name !== 'codex')
    )
      throw error;
    // The real path requireRoot resolved, which succeeded before any of these refusals could be raised.
    throw new Refusal(
      error.code,
      error.message,
      error.exit,
      error.where,
      rootedNext(error.next, name, realpathSync(resolve(host.cwd, supplied))),
      error.at,
    );
  }
  const rendered = (applied: HostApplied | null): Result =>
    json
      ? { exitCode: 0, stdout: JSON.stringify(hostEnvelope(view, applied)) + '\n', stderr: '' }
      : { exitCode: 0, stdout: renderHostPlan(view, applied, caps), stderr: '' };
  // §4: a plan with a conflict is a successful report; only --apply refuses it.
  if (!args.flag('apply')) return rendered(null);
  // §2.8 rule 3. Parsing has already refused every --apply whose question cannot be asked or answered.
  if (
    !args.flag('yes') &&
    !(await confirm(host.interaction, renderHostSummary(view, caps), view.remove ? REMOVAL_CONFIRMATION : CONFIRMATION))
  )
    return {
      exitCode: 0,
      stdout: document(
        [
          entry([words('Nothing was applied.')], { depth: 0, symbol: 'info' }, caps),
          entry(
            commandFacts('Apply with "', `${view.invocation} --apply --yes`, '".', 3, caps),
            { depth: 0, symbol: 'step' },
            caps,
          ),
        ],
        { leadingBlank: true },
      ),
      stderr: '',
    };
  host.signal?.throwIfAborted();
  return rendered(applyHostSet(view, host.packageRoot, host.signal));
}
