import type { ReadHandle } from '@inventarch/db';
import { selects } from '@inventarch/graph';
import { RuntimeError } from './errors.js';
import type { RuntimeWhere } from './errors.js';
import {
  defaultActor,
  governingMandates,
  isAdmissionRefusal,
  profileRefusal,
  seatedWorkspace,
} from './mandate-modes.js';
import type { GoverningMandate, ProfileVerdict } from './mandate-modes.js';
import type { HostHookDeclaration } from './packet-host.js';
import type { HookCode } from './steward.js';
import { freeze } from './types.js';

/**
 * The `@mandate` edit guard (milestone generation-binding, plan amendment C10; operator decision OD4): whether one file
 * edit an authored `@hook` selects may proceed, decided from admitted records only. The caller (steward-hook's
 * `--hook` mode) owns the event, the path's safety, the managed-state protection and the hook record's admission as a
 * declaration; this module only reads the reader through the scope token, as evaluateSteward does for the retired
 * steward guard.
 *
 * - A hook decides an edit only when its `hook.paths` select the file and its `hook.tools` name the event's tool (C10).
 *   Any other edit is allowed. A workspace protects its governing records (the `.ia/src` sources of its hooks, mandates
 *   and profiles) by selecting them in a hook, such as `paths [".ia/src/**"]`.
 * - The actor (OD4) is resolved first: an event that carries `agent_id` is a subagent, which acts as the
 *   `composition.agent` of the one authored `@agent-profile` whose name is exactly its `agent_type`; a subagent no such
 *   profile names is refused at every path the hook selects, governed or not. Any other event is the main session, a
 *   session launched with `--agent` included: it acts as the default actor (OD1) of the workspace position seats the path
 *   in.
 * - The mandates that govern a decided edit are C1's (`governingMandates`) for the path and that workspace, so a mandate
 *   scoped to the workspace governs every path a hook selects in it, beside those whose `authority.covers` claims the path.
 *   With none, an established actor (and the main session) is allowed: a mandate only adds restrictions.
 * - The edit is allowed when C1's profile allows the author mode (Synthesis) for that actor: a governing mandate that binds
 *   it (its participant, or one that names no participant, which binds every established actor) grants Synthesis.
 *   Otherwise it is refused with the hook's message and the profile's one next command,
 *   `ia position --seat <mandate> --shape governance`.
 *
 * Excluded words are not judged: the guard sees file bytes, not records, and `ia author` and `ia preview` enforce them.
 * Paths are matched in the G06c dialect (`selects`): `!`, `[` and every other character but `*`, `?` and `/` are
 * literal. `fold` (db `pathKey`, which folds case on win32 and darwin whatever the volume) keys both a selection and
 * the path, for `hook.paths` and `authority.covers` alike.
 */
export interface MandateGuardRequest {
  /** The authored hook the registration names, as hook generation declares it. */
  readonly hook: Pick<HostHookDeclaration, 'identity' | 'tools' | 'paths' | 'message'>;
  /** The event's `tool_name`. */
  readonly tool: string;
  /** Every workspace-relative spelling the caller resolved for the edited file, the canonical one first. */
  readonly paths: readonly string[];
  /** The event's `agent_id`, as received; present marks a subagent. */
  readonly agentId?: unknown;
  /** The event's `agent_type`, as received. */
  readonly agentType?: unknown;
  /** A key applied to a selection and a path before they are matched: db `pathKey`, folding case on win32 and darwin. */
  readonly fold?: (text: string) => string;
  /**
   * The workspace root the registration names, so that a next command that cannot find the root itself carries it:
   * `ia report`, the version 1 machine route, opens its `--root` or the working directory, never an ancestor.
   */
  readonly root?: string;
}
export interface MandateGuardDecision {
  readonly allowed: boolean;
  /** Whether the hook decides the edit at all; an edit it does not select is allowed. */
  readonly selected: boolean;
  /** Present exactly when refused. */
  readonly code?: HookCode;
  readonly message: string;
  /** The `@agent` the edit acts as, once established. */
  readonly actor?: string;
  /** The one next command a refusal names. */
  readonly next?: string;
  /**
   * Present when an IA-HOOK-MANDATE-UNAVAILABLE refusal concerns one `@mandate`: where it is authored, as the resolver
   * located it (RuntimeError `where`).
   */
  readonly where?: RuntimeWhere;
}

const LIMIT = 512;
const governance = (seat: string): string => `ia position --seat ${seat} --shape governance`;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether the hook decides the edit: its tools name the tool and its paths select a spelling of the file (C10). */
export function mandateGuardSelects(request: MandateGuardRequest): boolean {
  const fold = request.fold ?? ((text: string) => text);
  if (!request.hook.tools.includes(request.tool as 'Write')) return false;
  return request.paths.some((path) => request.hook.paths.some((selection) => selects(fold(selection), fold(path))));
}

type Acting =
  | { readonly agent?: string; readonly as: string; readonly refusal?: undefined }
  | { readonly refusal: string; readonly next?: string; readonly subagent: boolean };

/** OD4's actor, through the scope token `within`; `workspace` is the workspace position seats the path in, if one. */
function acting(
  reader: ReadHandle,
  within: string,
  request: MandateGuardRequest,
  workspace: string | undefined,
): Acting {
  const { agentId, agentType } = request;
  if (agentId !== undefined) {
    if (typeof agentId !== 'string' || agentId === '' || agentId.length > LIMIT)
      return { refusal: 'the subagent event carries a malformed agent_id', subagent: true };
    if (typeof agentType !== 'string' || agentType === '' || agentType.length > LIMIT)
      return { refusal: 'the subagent event names no agent_type', subagent: true };
    const profiles = reader
      .records({ within })
      .filter((node) => node.discriminator === 'agent-profile' && node.band === 100 && node.name === agentType);
    if (profiles.length !== 1)
      return {
        refusal: `subagent ${agentType} matches no single authored @agent-profile of that name`,
        subagent: true,
      };
    const profile = profiles[0]!.identity;
    const agents = reader
      .directedView(profile, { within })
      .filter(
        (row) =>
          row.kind === 'field-ref' &&
          row.direction === 'out' &&
          row.field === 'composition.agent' &&
          reader.get(row.counterpart, { within })?.discriminator === 'agent',
      )
      .map((row) => row.counterpart);
    if (agents.length !== 1) return { refusal: `${profile} names no admitted composition.agent`, subagent: true };
    return { agent: agents[0]!, as: `subagent ${agentType} acts as ${agents[0]!} (${profile})` };
  }
  if (workspace === undefined) return { as: 'the main session has no default actor: no @workspace holds this path' };
  const fallback = defaultActor(reader, within, workspace);
  if (fallback.refusal !== undefined)
    return { refusal: fallback.refusal.message, next: fallback.refusal.next, subagent: false };
  return fallback.actor === undefined
    ? { as: `the main session has no default actor: ${fallback.reason!}` }
    : { agent: fallback.actor, as: `the main session acts as ${fallback.actor}` };
}

/**
 * Decide one edit (see the module comment). A mandate whose authority cannot be read refuses a selected edit as
 * IA-HOOK-MANDATE-UNAVAILABLE, naming its governance position; so, while any authored `@mandate` fails admission (lane
 * D), does every selected edit, whoever acts, naming the mandate's `path:line` and `ia report` (`root` spelled when the
 * request carries it). An edit the hook does not select is still allowed.
 */
export function evaluateMandateGuard(
  reader: ReadHandle,
  within: string,
  request: MandateGuardRequest,
): MandateGuardDecision {
  const { hook } = request,
    paths = [...new Set(request.paths)];
  if (!mandateGuardSelects({ ...request, paths }))
    return freeze({ allowed: true, selected: false, message: `${hook.identity} does not select this edit` });
  const deny = (code: HookCode, why: string, next: string, actor?: string): MandateGuardDecision =>
    freeze({
      allowed: false,
      selected: true,
      code,
      message: `${hook.message} (${hook.identity}: ${why}) Next: ${next}`,
      next,
      ...(actor === undefined ? {} : { actor }),
    });
  try {
    const workspace = seatedWorkspace(reader, within, paths[0]!);
    // C1 for the path and its workspace, over every spelling of the file; one row per mandate.
    const locate = (actor?: string): readonly GoverningMandate[] => {
      const found = new Map<string, GoverningMandate>();
      for (const path of paths)
        for (const mandate of governingMandates(reader, within, {
          path,
          ...(workspace === undefined ? {} : { workspace }),
          ...(request.fold === undefined ? {} : { fold: request.fold }),
          ...(actor === undefined ? {} : { actor }),
        }))
          if (!found.has(mandate.identity)) found.set(mandate.identity, mandate);
      return [...found.values()].sort((a, b) => order(a.identity, b.identity));
    };
    // The actor before anything else: an unknown subagent is refused at every selected path, governed or not.
    const actor = acting(reader, within, request, workspace),
      governing = locate(),
      seat = governing[0]?.identity ?? workspace;
    const first = seat === undefined ? 'ia position --shape governance' : governance(seat);
    if (actor.refusal !== undefined && actor.subagent)
      return deny('IA-HOOK-IDENTITY-UNAVAILABLE', actor.refusal, first);
    if (governing.length === 0)
      return freeze({
        allowed: true,
        selected: true,
        message: `no authored @mandate governs ${paths[0]}, so ${hook.identity} restricts nothing there`,
        ...(actor.refusal === undefined && actor.agent !== undefined ? { actor: actor.agent } : {}),
      });
    if (actor.refusal !== undefined) return deny('IA-HOOK-IDENTITY-UNAVAILABLE', actor.refusal, actor.next ?? first);
    let verdict: ProfileVerdict;
    if (actor.agent === undefined) {
      // No actor to bind: a mandate that names a participant cannot be satisfied, and only participant-less ones judge.
      const named = governing.find((mandate) => mandate.participant !== undefined);
      if (named !== undefined)
        return deny(
          'IA-HOOK-IDENTITY-UNAVAILABLE',
          `${actor.as}; ${named.identity} binds ${named.participant}`,
          governance(named.identity),
        );
      verdict = profileRefusal(governing, 'author');
    } else verdict = profileRefusal(locate(actor.agent), 'author');
    if (verdict.refusal !== undefined)
      return deny('IA-HOOK-NOT-MANDATED', `${actor.as}; ${verdict.refusal.message}`, verdict.refusal.next, actor.agent);
    return freeze({
      allowed: true,
      selected: true,
      message: `${actor.as}, which a governing mandate allows to author here`,
      ...(actor.agent === undefined ? {} : { actor: actor.agent }),
    });
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    // Review D-R2: by its cause. A refused record a mandate resolution reads is shown by the admission report, not a
    // position, which cannot seat at a refused record (or would seat at an admitted one of another band sharing its
    // identity); `ia validate` and every other mandate-gated command refuse in that state. An admitted mandate whose
    // authority the resolver cannot read is shown by its governance position.
    const where = error.where,
      report = admissionReport(request.root),
      next = !isAdmissionRefusal(error) && where?.identity !== undefined ? governance(where.identity) : report.command,
      spelled = next === report.command && report.fromRoot ? `${next}, run from the workspace root` : next;
    return freeze({
      allowed: false,
      selected: true,
      code: 'IA-HOOK-MANDATE-UNAVAILABLE',
      message: `${hook.message} (${hook.identity}: the mandates that govern this edit cannot be read: ${error.message}) Next: ${spelled}`,
      next,
      ...(where === undefined ? {} : { where }),
    });
  }
}
/** Characters a printed root may hold and stay inert unquoted in sh, PowerShell and cmd: letters, digits, `._-/:`. */
const INERT_ROOT = /^[\p{L}\p{N}._\-/:]+$/u;
/**
 * Lane D, review findings D-R1 and D-N2: the admission report command (`ia report`, the version 1 machine route no
 * mandate gates) for a workspace root, spelled so no shell reads anything in it. `root` is printed, with forward slashes
 * on win32, only when every character is inert unquoted (`INERT_ROOT`); otherwise no path is printed and `fromRoot` says
 * the command is run from the workspace root, where `ia report` opens the working directory. A root is never wrapped in
 * double quotes, where `$` and backticks stay live.
 */
export function admissionReport(root?: string): { readonly command: string; readonly fromRoot: boolean } {
  const spelled = root === undefined ? undefined : process.platform === 'win32' ? root.replaceAll('\\', '/') : root;
  return spelled !== undefined && INERT_ROOT.test(spelled)
    ? freeze({ command: `ia report --root ${spelled}`, fromRoot: false })
    : freeze({ command: 'ia report', fromRoot: true });
}
