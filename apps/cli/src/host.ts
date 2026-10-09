/**
 * `ia host`: docs/specs/host-registration/README.md §4.
 *
 * One verb owns the managed host set of §5.1: the MCP entry and the workspace projection, plus the context element
 * §5.2's gate keeps unselected. It plans by default and never writes while planning — the payload's location is
 * computed, not created. `--apply` materializes the embedded payload once per user (§3.3), re-plans every
 * sub-transaction against the verified payload, then applies them in order — mcp, projection — and removal runs them
 * in reverse (§8). No cross-file atomicity is claimed: a rerun converges, and a pending journal refuses naming its
 * recovery. Nothing here reports that a server answered or a hook ran; `applied.observed` is always false (plan-0002
 * M5 exit).
 *
 * Milestone position-packet task replace-renderers (plan amendments B9, B11 and B12): the projection is the position
 * packet's consumer rendering, and `ia host` registers no steward guard. The projection element lists instead the
 * retirement of a guard an earlier release registered, which `applyHostProjection` (host-projection.ts) performs before
 * any projection file changes, the owned 1.x steward files it deletes and the foreign files it leaves. Task
 * ia-project-verb: `ia project` (project.ts) plans and applies that element alone, through the same planner
 * (`projectionElement`), re-plan (`replanProjection`) and writer, and its file rows (`projectionFileRows`).
 *
 * The plan asks the mechanisms themselves. `planHostFor` plans against the payload apply will materialize, described
 * from the pin without reading it (`expectedHostCache`), so a conflict in the preview is the service's own refusal —
 * its code and message unchanged (contract §4.1) — and is the refusal apply would raise.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { lifecycleProfile } from '@inventarch/workspace-runtime/lifecycle-profile';
import type { HostCacheTarget, HostPlan } from '@inventarch/distribution/host';
import { hostRow, WORKSPACE_HOSTS, workspaceRow } from '@inventarch/distribution/hosts';
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
import type { ProjectionAction } from '@inventarch/distribution/projection';
import type { HostOutput } from '@inventarch/runtime';
import { UsageError } from './args.js';
import { homeSrcRemedy, hostHome, located } from './home-remedy.js';
import type { Context, Result } from './consumer.js';
import { confirm, Interrupted, Refusal, refusalOf, requireRoot } from './consumer.js';
import type { HostName } from './host-projection.js';
import {
  applyHostProjection,
  checkAdmitted,
  planFiles,
  planRetirement,
  renderProjectionFor,
} from './host-projection.js';
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

/** The installation, not the workspace, is at fault; `ia doctor` names the channel a reinstall goes through. */
const DAMAGED =
  'The ia installation is damaged; run "ia doctor" for its install channel and reinstall @inventarch/cli through it, so assets/host travels with it.';

/** §5.1's elements. `ia host` registers no steward guard since milestone position-packet (B11), so none is `hooks`. */
export type ElementId = 'mcp' | 'context' | 'projection';
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
   * §4's plan actions. `none` is an element with nothing to do: the unselected context element, or a removal of an
   * element this workspace does not own.
   */
  readonly action: 'create' | 'update' | 'unchanged' | 'remove' | 'refused' | 'none';
  readonly paths: readonly string[];
  readonly capability: Capability;
  readonly conflict: Conflict | null;
  /**
   * The projection's per-file actions (B9). `remove` includes each 1.x steward file the state owns; `foreign` is a
   * `.claude/agents/*.md` file it does not own, marked or not: listed and never touched, so it is not a conflict.
   */
  readonly files?: readonly ProjectionAction[];
  /** The projection's B11 step: `retire` when the apply first removes a steward-guard registration this workspace owns. */
  readonly guard?: 'retire' | 'none';
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
    'These files are machine-local: .mcp.json, .claude/settings.local.json, .claude/rules/ia-workspace.md, .claude/skills/ia-authoring/ and .ia/distributions/. Do not commit them.',
  codex:
    'These files are machine-local: .codex/config.toml, AGENTS.md, .agents/skills/ia-authoring/ and .ia/distributions/. Do not commit them.',
};
/** §5.4: the MCP element's one fixed addition, from §2.3's host facts. */
export const MCP_APPROVAL = 'Claude Code asks for approval before starting a project MCP server.';
/**
 * Operator decision 2026-10-08 (plan amendment B11), said where the guard used to be registered, as operator decision
 * 2026-09-23 ("narrow + disclose") said what it refused: the guard is retired, so nothing it refused is refused now.
 */
export const GUARD_SCOPE =
  'ia host registers no steward guard, and applying the projection retires one an earlier release registered: with no per-system steward subagents left, it would deny every edit under .ia/src/systems/<name>/. Until a later release re-keys the guard to @mandate scope, nothing blocks those edits.';
/** §5.1's files, exported once so `ia doctor` names the same ones. */
export const MCP_PATH: Readonly<Record<HostName, string>> = { claude: '.mcp.json', codex: '.codex/config.toml' };
export const SETTINGS = '.claude/settings.local.json';
export const HOSTS_AREA = '.ia/distributions/hosts';
/**
 * §5.1's state files. Their presence says whether this workspace owns an element; their content is the mechanisms'.
 * `hooks` is a steward-guard registration an earlier release made, which the projection apply retires (B11), and
 * `receipt` the receipt it writes beside the projection state (B12).
 */
export const STATE = {
  mcp: (host: HostName): string => `${HOSTS_AREA}/${host}-${HOST_REGISTRATION}.json`,
  hooks: `${HOSTS_AREA}/claude-guard-${HOST_REGISTRATION}.json`,
  projection: (host: HostName): string => `${HOSTS_AREA}/${host}-projection.json`,
  receipt: (host: HostName): string => `${HOSTS_AREA}/${host}-receipt.json`,
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
  if (path === STATE.projection(host) || path === STATE.receipt(host)) return `Delete ${path}, then run "${rerun}".`;
  return null;
}
/**
 * The repair for an owned entry changed by hand. Apply refuses it and removal refuses it too, so it goes first; then
 * removal clears the ownership state and registration starts over. Each step was exercised against the verb.
 */
export function modifiedRepair(host: HostName, elements: readonly ('mcp' | 'hooks')[]): string {
  const owned = elements.map((element) => (element === 'mcp' ? OWNED_MCP[host] : OWNED_GUARD)).join(' and ');
  return `Delete ${owned}, then run "ia host ${host} --remove --apply" and register again.`;
}
/** §8: each pending journal names its own recovery on the distribution binary. `ia doctor` reports the same ones. */
export const JOURNALS: readonly (readonly [string, string])[] = [
  [`${HOSTS_AREA}/pending.json`, 'recover-host'],
  [`${HOSTS_AREA}/guard-pending.json`, 'recover-guard'],
  [`${HOSTS_AREA}/lifecycle-pending.json`, 'recover-lifecycle'],
];
/** §8: the lock every host sub-transaction holds while it writes (`acquireHostRegistrationLock`). */
export const HOST_LOCK = `${HOSTS_AREA}/lock.json`;
/**
 * The close of a remedy whose follow-up is the refused command itself, run again as typed, so the recovery before it
 * is the one command named (design row 27). `ia init --host` cannot simply be run again once it has initialized, so it
 * names `ia host` instead of such a remedy.
 */
export const THEN_RERUN = ', then rerun.';
/** A recovery on the distribution binary, rooted and quoted as every printed root is. */
export const recoverCommand = (command: string, root: string): string =>
  `ia-distribution ${command} --root ${quote(root)}`;
/**
 * §8 "or refuses naming a recovery": a held host lock is another run or a killed one, and nothing here can tell
 * which, so the next action names the recovery that decides it — `recoverHost` takes the lock in recovery mode,
 * which clears a dead holder's lock and refuses a live one. It names no `ia host` command, so `--root` needs no rewrite.
 */
export const lockNext = (root: string): string =>
  `Another ia host run holds the host lock, or a killed run left it: run "${recoverCommand('recover-host', root)}" (it clears a dead holder's lock and refuses a live one)${THEN_RERUN}`;
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

/**
 * §4: the target must be initialized and admit; anything else names ia init or ia validate. `named` is the root as the
 * init it names spells it: `ia host` names the resolved root, and `ia project` the root as its invocation typed it.
 */
export function requireInitialized(root: string, named: string = root): void {
  if (!existsSync(resolve(root, '.ia/release.json')))
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The target is not an initialized workspace: .ia/release.json is absent',
      3,
      { path: root },
      `Run "ia init ${quote(named)}" first.`,
    );
}
/** The journal a failed transaction left behind, if any, with the command that recovers it. */
export const pendingJournal = (root: string): readonly [string, string] | undefined =>
  JOURNALS.find(([path]) => existsSync(resolve(root, path)));
/** Design row 27: the recovery is the one command named; the refused command is simply run again after it. */
export const recoverNext = (root: string, command: string): string =>
  `Run "${recoverCommand(command, root)}"${THEN_RERUN}`;
/**
 * A next action of this verb made runnable from any cwd: every quoted `ia host <host>` or `ia project <host>` command
 * it names, and the `ia validate` a workspace that does not admit names (host-projection.ts), gains `--root <root>`.
 * `ia init --host` uses it, because its `<directory>` may not be the cwd a rerun discovers from, and so do `ia project`
 * and `ia doctor`. Every such command opens with `"ia host <host>`, `"ia project <host>` or `"ia validate`, and one
 * that names `--root` itself is left as it is, so the rewrite reaches each one and nothing else.
 */
export const rootedNext = (next: string, host: HostName, root: string): string =>
  next.replace(
    new RegExp(`"ia (?:host ${host}|project ${host}|validate)(?! --root\\b)`, 'g'),
    (command) => `${command} --root ${quote(root)}`,
  );
/** A next action as printed: with `--root` given, each `ia host <host>` command in it carries the root. */
export const hostNext = (text: string, host: HostName, root: string, rooted: boolean): string =>
  rooted ? rootedNext(text, host, root) : text;
/** The file a mechanism located its refusal at (`locate` in @inventarch/distribution's files.ts), or null. */
export const refusedPath = (error: unknown): string | null =>
  error !== null && typeof error === 'object' && 'path' in error && typeof error.path === 'string' ? error.path : null;
/**
 * §6.3: the repair for a projection refusal with `code` located at `path`. The ownership state has its own repair; a
 * guard group the retirement (B11) refuses as changed is deleted by hand, after which the retirement removes the
 * ownership state alone, and settings it cannot read are fixed; any other file is never replaced or adopted, so it is
 * moved or deleted first. `ia host`, `ia doctor` and the install refresh all name it this way.
 */
export const projectionRepair = (host: HostName, path: string, rerun: string, code?: string): string =>
  stateRepair(host, path, rerun) ??
  (path !== SETTINGS
    ? `Move or delete ${path}, then run "${rerun}".`
    : code === undefined || code === 'IA-DIST-LOCAL-MODIFICATION'
      ? `Delete ${OWNED_GUARD}, then run "${rerun}".`
      : `Fix ${path}, then run "${rerun}".`);
/**
 * Host registration spec §4: the hosts whose projection this workspace owns, by their projection state's presence, as
 * `ia host`, `ia doctor` and the install refresh decide it, a projection `ia project` wrote without a registration
 * included.
 */
export const projectedHosts = (root: string): readonly HostName[] =>
  WORKSPACE_HOSTS.filter((host) => existsSync(resolve(root, STATE.projection(host))));
/**
 * The apply that repairs `host`'s projection, which `ia doctor` and the install refresh both name (task
 * ia-project-verb): `ia host <host> --apply` for a registered host, and `ia project <host> --apply` for a projection
 * `ia project` wrote without a registration, which `ia host` would also register an MCP server for.
 */
export const projectionRerun = (root: string, host: HostName): string =>
  existsSync(resolve(root, STATE.mcp(host))) ? `ia host ${host} --apply` : `ia project ${host} --apply`;
/** §8: a pending journal refuses the whole verb and names the recovery that clears it. `ia project` shares it. */
export function requireIdle(root: string, supplied: string): void {
  try {
    assertHostRegistrationIdle(root);
  } catch (error) {
    const refusal = refusalOf(error);
    const [journal, command] = pendingJournal(root) ?? JOURNALS[0]!;
    throw new Refusal(refusal.code, refusal.message, 3, { path: journal }, recoverNext(supplied, command));
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
function registrationElement(path: string, owned: boolean, remove: boolean, plan: () => HostPlan): Element {
  if (remove && !owned) return { id: 'mcp', action: 'none', paths: [path], capability: 'absent', conflict: null };
  try {
    return { id: 'mcp', action: actionOf(plan()), paths: [path], capability: 'registered', conflict: null };
  } catch (error) {
    return { id: 'mcp', action: 'refused', paths: [path], capability: 'refused', conflict: conflictOf(error, path) };
  }
}
/**
 * §5.2: the context element. Claude reports it `not selected` until the gate lifts; Codex reports it `unsupported by
 * host`, because it is delivered through lifecycle hooks and Codex hooks are unavailable, so both hosts carry the
 * same three rows.
 */
const contextElement = (host: HostName): Element => ({
  id: 'context',
  action: 'none',
  paths: [],
  capability: host === 'claude' ? 'not selected' : 'unsupported by host',
  conflict: null,
});
/**
 * §5.1 `projection`, planned by the real planners: B11's retirement of an owned guard registration, then the file plan
 * (B9). Both read only the workspace, so the plan is exactly apply's. A retirement is a change, and so is a missing
 * receipt, which every apply writes (B12), so a projection whose files are unchanged is then an update; a removal that
 * finds only a guard registration or a receipt removes them. `ia project` plans with it, and both verbs' applies
 * re-plan with it (`replanProjection`), so no two of them can plan the projection differently.
 */
export function projectionElement(root: string, host: HostName, rendered: HostOutput | null): Element {
  const refused = (conflict: Conflict): Element => ({
    id: 'projection',
    action: 'refused',
    paths: [],
    capability: 'refused',
    conflict,
  });
  let guard: 'retire' | 'none';
  try {
    guard = planRetirement(root, host) === null ? 'none' : 'retire';
  } catch (error) {
    return refused(conflictOf(error, SETTINGS));
  }
  try {
    const files = planFiles(root, host, rendered).actions;
    const touched = files.filter((file) => file.action !== 'foreign'),
      changes = guard === 'retire',
      receipt = existsSync(resolve(root, STATE.receipt(host)));
    const action: Element['action'] =
      rendered === null
        ? touched.some((file) => file.action === 'remove') || changes || receipt
          ? 'remove'
          : 'none'
        : touched.every((file) => file.action === 'unchanged') && !changes && receipt
          ? 'unchanged'
          : touched.every((file) => file.action === 'create') && !changes
            ? 'create'
            : 'update';
    return {
      id: 'projection',
      action,
      paths: touched.map((file) => file.path),
      capability: action === 'none' ? 'absent' : 'registered',
      conflict: null,
      files,
      guard,
    };
  } catch (error) {
    return refused(conflictOf(error, STATE.projection(host)));
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
  if (row === undefined) {
    // Raised before the root is resolved, so the command names the root as it was typed.
    const typed = args.value('root');
    throw new Refusal(
      'IA-DIST-HOST-UNSUPPORTED',
      `${hostRow(given)!.label} support is planned; nothing was written`,
      3,
      null,
      `Run "ia host claude${typed === undefined ? '' : ` --root ${quote(typed)}`}" to plan a supported host; Codex is supported too.`,
    );
  }
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
      `Run "ia host ${name}" to plan the registration without the context element.`,
    );
  // The mechanisms record the real path (files.ts `workspace()`), so the plan works on the same one.
  const root = realpathSync(supplied);
  // Every IA home remedy ends by planning this invocation again; `runHost` adds `--root` as it does to every next action.
  const plan = `ia host ${name}${remove ? ' --remove' : ''}`;
  const home = hostHome(host.env, plan);
  // §3.3: neither may contain the other; the service raises IA-DIST-PATH-UNSAFE.
  located(supplied, `Move the workspace, or set IA_HOME to an absolute directory outside it; then run "${plan}".`, () =>
    assertHomeOutsideWorkspace(home, root),
  );
  // §3: refuse a home that itself looks like a workspace at plan time, before any payload write is attempted.
  located(null, homeSrcRemedy(home, plan), () => assertIaHomeUsable(home));
  const { pin: bundled } = bundledPin(host.packageRoot);
  requireIdle(root, supplied);
  // §4: zero error findings. A removal renders nothing, so it checks admission alone.
  let rendered: HostOutput | null = null;
  if (remove) checkAdmitted(root);
  else rendered = renderProjectionFor(root, name);
  // A host home reached through a symbolic link or junction is refused by the mechanism (IA-DIST-PATH-UNSAFE), because
  // the payload it verifies must be the one the registration names; the remedy is a home with no link in its path.
  const expected: HostCacheTarget = located(
    null,
    `Set IA_HOME to a directory path with no links, or unset it; then run "${plan}".`,
    () => expectedHostCache(hostPayloadPath(home, bundled.release), bundled.release),
  );
  const owned = new Set<ElementId>();
  if (existsSync(resolve(root, STATE.mcp(name)))) owned.add('mcp');
  const mcp = registrationElement(MCP_PATH[name], owned.has('mcp'), remove, () =>
    remove ? planHostFor(root, name, null, HOST_REGISTRATION) : planHostFor(root, name, expected),
  );
  return {
    root: supplied,
    host: name,
    remove,
    release: bundled.release,
    home,
    elements: [mcp, contextElement(name), projectionElement(root, name, rendered)],
    undo: `ia host ${name} --remove --apply`,
    invocation: invocationOf(context, name, remove),
    owned,
    rooted: context.args.value('root') !== undefined,
    userPlugin:
      row.user === 'plugin' ? { installed: readMaterializedPlugin(home) !== null, command: USER_PLUGIN_COMMAND } : null,
  };
}

/** One applied element; the projection's also says whether it retired a steward-guard registration first (B11). */
export interface AppliedElement {
  readonly id: ElementId;
  readonly status: string;
  readonly guard?: 'retired' | 'none';
}
export interface HostApplied {
  readonly status: 'host-registered' | 'host-removed';
  readonly elements: readonly AppliedElement[];
  readonly observed: false;
}
/** What an apply that retired the steward guard (B11) says it did. */
export const GUARD_RETIRED =
  'Retired the steward guard an earlier release registered: its group in .claude/settings.local.json and its ownership state are removed.';
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
  if (conflict.code === 'IA-DIST-LOCAL-MODIFICATION' && id === 'mcp') {
    // Owned: removal tolerates a deleted entry, so deleting it and re-registering converges. Unowned: §5.3's wording,
    // made exact for Codex, where the collision can be any ia-workspace table or a file that no longer parses.
    if (view.owned.has('mcp')) return modifiedRepair(view.host, ['mcp']);
    return view.host === 'codex'
      ? 'Remove any ia-workspace server outside the IA block from .codex/config.toml and make sure the file parses as TOML, then run "ia host codex --apply".'
      : `Remove that entry, then run "ia host ${view.host} --apply".`;
  }
  if (id === 'projection') return projectionRepair(view.host, conflict.path, rerun, conflict.code);
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
 * Apply's re-plan of the projection, shared by `ia host --apply` and `ia project --apply`: the projection element
 * planned against the rendering the apply writes, so a conflict either of its planners finds (the guard retirement or
 * the file plan) is raised, worded by the verb's `refuse`, before anything is written. `applyHostProjection` plans
 * both again before its first write.
 */
export function replanProjection(
  root: string,
  host: HostName,
  rendered: HostOutput | null,
  refuse: (conflict: Conflict) => Refusal,
): void {
  const { conflict } = projectionElement(root, host, rendered);
  if (conflict !== null) throw refuse(conflict);
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
  located(null, say(view, homeSrcRemedy(view.home, `ia host ${view.host} --apply`)), () =>
    assertIaHomeUsable(view.home),
  );
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
 * §8: mcp, projection in order; removal in reverse. The payload is materialized, then every sub-transaction is
 * re-planned with the verifying planners before any is applied — the projection's guard retirement (B11) and file plan
 * included — so a refusal any planner can find is raised before the workspace changes; each apply then re-plans under
 * the host lock and refuses a plan that went stale. The projection is applied through `applyHostProjection`, the one
 * writer of projection files, which retires an owned steward guard before any projection file changes and reports it
 * as the element's `guard`. Cancellation is observed between sub-transactions. A failure after an element was written
 * names the rerun that finishes the set, or the recovery a pending journal needs. `checkpoint` runs after each element
 * completes, which is where an interruption test cuts.
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
  const done: AppliedElement[] = [];
  const skipped = (id: ElementId): AppliedElement => ({
    id,
    status: view.elements.find((element) => element.id === id)!.capability,
  });
  const step = (id: ElementId, run: () => Omit<AppliedElement, 'id'>): void => {
    if (signal?.aborted) throw new Interrupted(say(view, `Run "${rerun}" to finish.`));
    let applied: Omit<AppliedElement, 'id'>;
    try {
      applied = run();
    } catch (error) {
      const refusal = refusalOf(error),
        journal = pendingJournal(root);
      if (journal !== undefined)
        throw new Refusal(
          refusal.code,
          refusal.message,
          3,
          { path: journal[0] },
          say(view, recoverNext(view.root, journal[1])),
        );
      const busy = lockRefusal(error, view.root);
      if (busy !== null) throw busy;
      if (done.length > 0)
        throw new Refusal(refusal.code, refusal.message, 3, refusal.where, say(view, `Run "${rerun}" to finish.`));
      throw error;
    }
    done.push({ id, ...applied });
    checkpoint(id);
  };
  const project = (rendered: HostOutput | null) => (): Omit<AppliedElement, 'id'> => {
    const { status, guard } = applyHostProjection(root, host, rendered);
    return { status, guard };
  };
  if (!view.remove) {
    const cache = materialize(view, packageRoot);
    const mcp = replan(view, 'mcp', MCP_PATH[host], () => planHost(root, host, cache));
    const rendered = renderProjectionFor(root, host);
    replanProjection(root, host, rendered, (conflict) => refusalFor(view, 'projection', conflict));
    step('mcp', () => ({ status: applyHost(mcp).status }));
    done.push(skipped('context'));
    step('projection', project(rendered));
    return { status: 'host-registered', elements: done, observed: false };
  }
  // A removal plans only what the view found owned; `none` means there is nothing of that element to remove.
  const absent = (id: ElementId): boolean => view.elements.find((element) => element.id === id)!.action === 'none';
  replanProjection(root, host, null, (conflict) => refusalFor(view, 'projection', conflict));
  const mcp = absent('mcp')
    ? null
    : replan(view, 'mcp', MCP_PATH[host], () => planHost(root, host, null, HOST_REGISTRATION));
  step('projection', project(null));
  done.push(skipped('context'));
  step('mcp', () => ({ status: mcp === null ? 'absent' : applyHost(mcp).status }));
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
  foreign: 'info',
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
    if (element.id === 'context' && element.capability === 'unsupported by host')
      facts.push(CODEX_HOOKS.replace(/\.$/, ''));
    if (element.guard === 'retire') facts.push(GUARD_RETIRE);
    if (element.conflict !== null) facts.push(`${element.conflict.code} ${element.conflict.reason}`);
    return {
      symbol: elementSymbol(element),
      label: element.id,
      value: words(facts.join('; ')),
      action: element.conflict === null ? null : words(nextFor(view, element.id, element.conflict)),
    };
  });
}
/** A projection plan's B11 step as its plan says it, in `ia host` and `ia project` alike. */
export const GUARD_RETIRE = `first retires the steward guard registered in ${SETTINGS}`;
/**
 * Each projected file with its action, at `column`; a foreign steward file says why it is left alone. `ia host` nests
 * the rows under its projection element and `ia project` lists them as its file plan, so both word them alike.
 */
export const projectionFileRows = (
  files: readonly ProjectionAction[],
  column: number,
  caps: Capabilities,
): readonly string[] =>
  files.flatMap((file) =>
    entry(
      [
        [
          atom(file.path, 'cyan', 0),
          ...words(
            file.action === 'foreign'
              ? "foreign; not this workspace's projection to write or delete, left in place"
              : file.action,
            null,
            2,
          ),
        ],
      ],
      { column, symbol: FILE_SYMBOL[file.action] },
      caps,
    ),
  );
/** Each projected file, nested at the elements block's content column (§6.4 rule 3), under the element it belongs to. */
const fileBlock = (view: HostView, caps: Capabilities): readonly string[] =>
  projectionFileRows(
    view.elements.find((element) => element.id === 'projection')?.files ?? [],
    indentOf(1) + blockSymbolWidth(view.elements.map(elementSymbol), caps.ascii) + 2,
    caps,
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
 * §5.3's machine-local sentence and, for a Claude registration, §5.4's approval note and the guard's retirement (only
 * Claude ever registered the guard, B11). `ia init --host` prints the same blocks after its host step, so the two verbs
 * cannot word them differently.
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
              ...(applied.elements.some((element) => element.guard === 'retired') ? [words(GUARD_RETIRED)] : []),
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
    // Refusals raised before a view exists — the --context gate, a pending journal — name `ia host` commands too. A
    // root that is not a directory is requireRoot's own refusal, whose next action already spells the whole invocation.
    const supplied = args.value('root'),
      name = args.positionals[0];
    const given = supplied === undefined ? undefined : resolve(host.cwd, supplied);
    if (
      !(error instanceof Refusal) ||
      error.next === null ||
      given === undefined ||
      !statSync(given, { throwIfNoEntry: false })?.isDirectory() ||
      (name !== 'claude' && name !== 'codex')
    )
      throw error;
    // The real path requireRoot resolved, which succeeded before any of these refusals could be raised.
    throw new Refusal(
      error.code,
      error.message,
      error.exit,
      error.where,
      rootedNext(error.next, name, realpathSync(given)),
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
