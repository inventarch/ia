/**
 * The participant's mandate refusal profile for a consumer command: milestone generation-binding plan amendments C1 and
 * C19, and the continuation's lane C. One helper, so every gated mode judges the same way.
 *
 * The acting `@agent` is the one `--actor` names, which must be an authored participant of the repository's
 * `@workspace` (a mandate scoped to it names the agent as its participant, or the workspace names it as its
 * `composition.steward`); else the workspace's default actor (operator decision OD1). Naming an actor is a local
 * declaration, not authentication: it resolves a choice the workspace leaves open and never lifts a restriction, since the
 * chosen actor's mandates are judged exactly as the default actor's would be. The mandates that govern there (the
 * workspace's, and those whose `authority.covers` claims the command's target path) are judged for the mode's move and,
 * when the command authors or previews a word, for that word's exclusion (runtime `profileRefusal`).
 *
 * Every refusal names one next command that runs in the state that caused it: the command again with an `--actor` whose
 * mandates allow it, or the governance position of the mandate or workspace concerned. `ia position` is never gated,
 * so a position is always a command that runs. With no governing mandate nothing is restricted and the profile carries
 * the runtime's notice instead. While an authored `@mandate` fails admission (lane D), every gated command refuses at
 * that record, workspace-wide, and names the admission report (`ia report --root <root>`, a machine route no mandate
 * gates): a position cannot seat at a record admission refused.
 *
 * Read (`ia read`, `ia next`), validate (`ia validate`, `ia preview`), author (`ia author`) and effect (`ia capture`, its
 * `ia compile` alias, `ia project`) are gated; `ia position` is not, and neither is a command outside those modes. A gated
 * command's profile stays on the invocation's gate, so a refusal it raises later names only a command the same actor may
 * run there (`gatedNext`): one the profile refuses is replaced by the governance position, and one that needs the
 * actor named by `--actor` carries it.
 */
import type { ReadHandle } from '@inventarch/db';
import { pathKey } from '@inventarch/db';
import { defaultActor, governingMandates, MODE_MOVES, profileRefusal, RuntimeError } from '@inventarch/runtime';
import type { GoverningMandate, Mode, ProfileVerdict } from '@inventarch/runtime';
import type { Context } from './consumer.js';
import { findCommand } from './commands.js';
import { Refusal, respell } from './consumer.js';
import { quote } from './render.js';
import type { Session } from './session.js';

/**
 * The gated commands and their modes; every other command, `ia position` included, is never gated, and `ia host` is
 * gated only as a workspace `--apply` (`hostMode`).
 */
export const GATED_MODES: Readonly<Record<string, Mode>> = Object.freeze({
  read: 'read',
  next: 'read',
  validate: 'validate',
  preview: 'validate',
  author: 'author',
  capture: 'effect',
  compile: 'effect',
  project: 'effect',
});
/**
 * Review C2-R7: `ia host <host> --apply` for a workspace is the effect mode; its plan, `--remove` and `--user` are never
 * gated.
 */
const hostMode = (argv: readonly string[]): Mode | undefined =>
  argv.includes('--apply') && !argv.includes('--remove') && !argv.includes('--user') ? 'effect' : undefined;
/** What a gated command's profile leaves on its invocation for the refusals it raises later. */
export interface GateState {
  readonly workspace?: string;
  readonly actor?: string;
  readonly by?: Profile['by'];
  /** The mandates that govern at the workspace for the actor, whatever path the command targets. */
  readonly mandates: readonly GoverningMandate[];
  /** ` --root <root>` as the invocation gave it, or nothing. */
  readonly rooted: string;
}
/** One invocation's gate: empty until a gated command's profile allows it. */
export interface Gate {
  state?: GateState;
}

export interface Profile {
  /** The repository's `@workspace`, when the workspace authors one. */
  readonly workspace?: string;
  /** The acting `@agent`; absent when the workspace names none and the command did not. */
  readonly actor?: string;
  /** What chose the actor: `--actor`, the workspace's `composition.steward`, or its one participant. */
  readonly by?: 'actor' | 'steward' | 'participant';
  /** The governing mandates the profile judged, by identity. */
  readonly mandates: readonly string[];
  /** The first governing mandate that binds the actor and grants the mode's move, by identity; absent when none governs. */
  readonly grantedBy?: string;
  /** Present when no mandate governs, so nothing is restricted. */
  readonly notice?: string;
}
export interface ProfileRequest {
  /** The open workspace; any reader, an editor snapshot included. */
  readonly reader: ReadHandle;
  /** A scope token of the whole workspace; it need not be clean. */
  readonly within: string;
  /** The invocation, so a next command carries what it supplied (design row 27). */
  readonly context: Pick<Context, 'command' | 'args' | 'gate'>;
  readonly mode: Mode;
  /** The words the command authors or previews: excluded words apply to them. */
  readonly words?: readonly string[];
  /** The workspace-relative path the command targets: a mandate whose `authority.covers` claims it governs there. */
  readonly path?: string;
}

const rootedOf = (context: Pick<Context, 'args'>): string => {
  const supplied = context.args.value('root');
  return supplied === undefined ? '' : ` --root ${quote(supplied)}`;
};
/** The repository's own `@workspace`: the record position seats the repository root at, when it is one. */
export function repositoryWorkspace(reader: ReadHandle, within: string): string | undefined {
  const seat = reader.resolveSeat('', { within }).seat;
  return seat !== undefined && reader.get(seat, { within })?.discriminator === 'workspace' ? seat : undefined;
}
/** The `@agent` an `--actor` value names: a canonical identity, `@agent <name>`, or a bare name. */
function namedAgent(reader: ReadHandle, within: string, spelled: string): string | undefined {
  const value = spelled.trim();
  if (value.includes('/'))
    return reader.records({ within }).some((node) => node.identity === value && node.discriminator === 'agent')
      ? value
      : undefined;
  const name = value.startsWith('@agent ') ? value.slice('@agent '.length).trim() : value;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) return undefined;
  const resolved = reader.resolve({ kind: 'ref', discriminator: 'agent', name }, { within });
  return resolved.ok ? resolved.identity : undefined;
}
/** The seat a runtime mandate refusal's next command (`ia position --seat <seat> --shape governance`) names. */
const seatOf = (next: string): string | undefined => /--seat (\S+)/.exec(next)?.[1];
/** Whether `identity` is an admitted `@mandate` of the scope; a read that refuses is no admission. */
function admittedMandate(reader: ReadHandle, within: string, identity: string): boolean {
  try {
    return reader.get(identity, { within })?.discriminator === 'mandate';
  } catch {
    return false;
  }
}

/**
 * A mandate the runtime cannot read refuses the command rather than failing it (IA-RUNTIME-REQUEST-INVALID, exit 1),
 * located where the runtime located it (`RuntimeError.where`; no message is parsed for it):
 * - An authored `@mandate` that failed admission (lane D, operator ruling 2026-10-12): every gated command fails closed,
 *   workspace-wide, since the record's scope, covers and participant cannot be trusted. No in-tool repair exists, as
 *   `ia preview` and `ia author` cannot target a record admission refused, so the message says a hand edit corrects it.
 *   The next command is the admission report, the version 1 machine route `ia report`, which no mandate gates and whose
 *   findings show the refused mandate's: `ia validate` is gated, and a position cannot seat at a record admission
 *   refused. It always carries `--root`, the invocation's or else the root the session opened, because that route opens
 *   its `--root` or the working directory, never an ancestor.
 * - An admitted mandate whose authority the resolver cannot read (a child under one of its `authority` fields, which
 *   admission admits): its governance position, never gated, shows that authority.
 */
function unreadable(
  error: RuntimeError,
  reader: ReadHandle,
  within: string,
  workspace: string | undefined,
  rooted: string,
) {
  const message = error.message.replace(/^IA-RUNTIME-[A-Z-]+: /, ''),
    where = error.where;
  if (where !== undefined && (where.identity === undefined || !admittedMandate(reader, within, where.identity))) {
    const root = rooted === '' ? ` --root ${quote(printedRoot(reader.root))}` : rooted;
    return new Refusal(
      error.code,
      `The mandate profile cannot be read: ${message}; correct it by hand in ${where.path}, since ia preview and ia author cannot target a record admission refused`,
      1,
      where,
      `Run "ia report${root}" for the admission findings, the refused @mandate's among them; correct its source by hand, then run this command again.`,
    );
  }
  const seat = where?.identity ?? workspace;
  return new Refusal(
    error.code,
    `The mandate profile cannot be read: ${message}`,
    1,
    where ?? (seat === undefined ? null : { identity: seat }),
    seat === undefined
      ? `Run "ia position${rooted}" for the repository's position and the mandates it reads.`
      : `Run "ia position --seat ${seat} --shape governance${rooted}" to see the mandate authority the profile cannot read; correct it, then run this command again.`,
  );
}
/**
 * A root the session opened, as a printed command spells it: with forward slashes on win32, where both separators work,
 * so it is not a token `inertNext` withholds for its backslashes.
 */
const printedRoot = (root: string): string => (process.platform === 'win32' ? root.replaceAll('\\', '/') : root);

/** An `ia author` form's `--digest`: the target file's sha256 as 64 lowercase hex digits. */
export const DIGEST = /^[0-9a-f]{64}$/;
/** Whether an `ia author` form's `--digest` can be checked: 64 lowercase hex digits, or absent for a starter system. */
function usableDigest(args: Context['args']): boolean {
  const digest = args.value('digest');
  if (digest !== undefined) return DIGEST.test(digest);
  return !args.flag('relate') && !args.flag('set') && args.positionals[0] === 'system';
}
/** The profile `request.mode` meets for its actor, or the refusal it gives (exit 1, IA-RUNTIME-MANDATE-*). */
export function requireProfile(request: ProfileRequest): Profile {
  const { reader, within, context, mode } = request,
    words = request.words ?? [],
    rooted = rootedOf(context),
    workspace = repositoryWorkspace(reader, within);
  // The CLI's one call of governingMandates (review C-RC1): the profile, the gate state and every next command it judges
  // read the mandates through it, so an option the runtime adds is passed here once. `fold` is db's `pathKey`, as the
  // edit guard passes it, which folds case on win32 and darwin whatever the volume: there a `covers` selection claims
  // the target path in any letter case, a directory not made yet and a selection cased otherwise than the directory on
  // disk included; on other platforms case is significant.
  const governing = (actor: string | undefined, path: string | undefined): readonly GoverningMandate[] =>
    governingMandates(reader, within, {
      ...(actor === undefined ? {} : { actor }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(path === undefined ? {} : { path, fold: pathKey }),
    });
  const judge = (actor: string | undefined): { mandates: readonly GoverningMandate[]; verdict: ProfileVerdict } => {
    const mandates = governing(actor, request.path);
    return { mandates, verdict: profileRefusal(mandates, mode, words) };
  };
  /**
   * Review C3-R2: an `ia author` form without a usable `--digest` (absent, unless it writes a starter system, or not 64
   * lowercase hex digits) would refuse again when named as it is, so an actor choice names its preview, which prints the
   * digest: the actor must be allowed that preview too.
   */
  const previewFirst = context.command.name === 'author' && !usableDigest(context.args);
  const allows = (actor: string | undefined): boolean =>
    judge(actor).verdict.refusal === undefined &&
    (!previewFirst || profileRefusal(governing(actor, request.path), 'validate', words).refusal === undefined);
  /** This command, or for `previewFirst` its preview, with `--actor` set to `actor` or dropped. */
  const rerun = (actor: readonly string[]): string =>
    previewFirst
      ? respell({ command: findCommand('preview')!, args: context.args }, { options: { actor } })
      : respell(context, { options: { actor } });
  /** The next command after an open or refused actor choice: this one as the first participant allowed to run it. */
  const choose = (participants: readonly string[]): string => {
    const allowed = participants.find(allows);
    if (allowed !== undefined)
      return previewFirst
        ? `Run "${rerun([allowed])}" as ${allowed}, a participant whose mandates allow it here, for the candidate and the digest ia author needs.`
        : `Run "${rerun([allowed])}" to act as ${allowed}, a participant whose mandates allow it here.`;
    return workspace === undefined
      ? `Run "${rerun([])}" without naming an actor; this repository authors no @workspace.`
      : `Run "ia position --seat ${workspace} --shape governance${rooted}" for the workspace's participants and the mandates that bind them; none of them may run this command here.`;
  };
  /**
   * The next command after an `--actor` that names no participant (review C-N1): where the workspace's default actor may
   * run this command, the command without `--actor`; where it may not, the governance position; only where the choice
   * is open, the first participant allowed (`choose`).
   */
  const mistyped = (participants: readonly string[]): string => {
    const fallback = workspace === undefined ? undefined : defaultActor(reader, within, workspace);
    if (fallback?.actor !== undefined)
      return allows(fallback.actor)
        ? `Run "${rerun([])}" as the workspace's default actor, ${fallback.actor}.`
        : `Run "ia position --seat ${workspace} --shape governance${rooted}" for the workspace's participants and the mandates that bind them.`;
    if (participants.length > 0) return choose(participants);
    // Review C2-N7: with no participant the command runs without an actor, so that profile is judged before it is named.
    if (allows(undefined)) return `Run "${rerun([])}" without naming an actor.`;
    return workspace === undefined
      ? `Run "ia position${rooted}" for the repository's position and the mandates that govern it.`
      : `Run "ia position --seat ${workspace} --shape governance${rooted}" for the mandates that govern here; none of them allows this command without an actor.`;
  };
  try {
    const spelled = context.args.value('actor');
    let actor: string | undefined, by: Profile['by'];
    if (spelled !== undefined) {
      const participants = workspace === undefined ? [] : defaultActor(reader, within, workspace).actors,
        named = namedAgent(reader, within, spelled);
      if (named === undefined || !participants.includes(named))
        throw new Refusal(
          'IA-RUNTIME-MANDATE-ACTOR',
          `${named ?? spelled} is not an authored participant of ${workspace ?? 'this repository, which authors no @workspace'}${
            participants.length === 0 ? '' : `; its participants are ${participants.join(', ')}`
          }`,
          1,
          workspace === undefined ? null : { identity: workspace },
          mistyped(participants),
        );
      actor = named;
      by = 'actor';
    } else if (workspace !== undefined) {
      const fallback = defaultActor(reader, within, workspace);
      if (fallback.refusal !== undefined)
        throw new Refusal(
          fallback.refusal.code,
          `${fallback.refusal.message}, or name the acting participant`,
          1,
          { identity: workspace },
          choose(fallback.actors),
        );
      if (fallback.actor !== undefined) {
        actor = fallback.actor;
        by = fallback.by;
      }
    }
    const { mandates, verdict } = judge(actor);
    if (verdict.refusal !== undefined) {
      // The runtime names the governance position of the mandate concerned (design §11); the CLI spells that command
      // itself, with the root this invocation gave.
      const seat = seatOf(verdict.refusal.next) ?? workspace;
      const unbound = verdict.refusal.code === 'IA-RUNTIME-MANDATE-ACTOR' && by !== 'actor' && workspace !== undefined;
      throw new Refusal(
        verdict.refusal.code,
        verdict.refusal.message,
        1,
        seat === undefined ? null : { identity: seat },
        unbound
          ? choose(defaultActor(reader, within, workspace).actors.filter((participant) => participant !== actor))
          : seat === undefined
            ? `Run "ia position${rooted}" for the repository's position and the mandates that govern it.`
            : `Run "ia position --seat ${seat} --shape governance${rooted}" for the mandates that govern here and what they allow.`,
      );
    }
    const move = MODE_MOVES[mode],
      granted = mandates.find(
        (mandate) => mandate.binds !== false && (mandate.moves === undefined || mandate.moves.includes(move)),
      );
    if (context.gate !== undefined)
      context.gate.state = Object.freeze({
        ...(workspace === undefined ? {} : { workspace }),
        ...(actor === undefined ? {} : { actor }),
        ...(by === undefined ? {} : { by }),
        mandates: request.path === undefined ? mandates : governing(actor, undefined),
        rooted,
      });
    return Object.freeze({
      ...(workspace === undefined ? {} : { workspace }),
      ...(actor === undefined ? {} : { actor }),
      ...(by === undefined ? {} : { by }),
      mandates: mandates.map((mandate) => mandate.identity),
      ...(granted === undefined ? {} : { grantedBy: granted.identity }),
      ...(verdict.notice === undefined ? {} : { notice: verdict.notice }),
    });
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'IA-RUNTIME-REQUEST-INVALID')
      throw unreadable(error, reader, within, workspace, rooted);
    throw error;
  }
}

/**
 * Review C2-N3: a gate a command's own session runs as soon as it is open, before the service reads anything else from
 * it, so the profile and the verdict or effect are read from one snapshot, through one session: `ia project --apply` and
 * `ia host --apply` write the rendering their gated plan session made rather than render again (review C3-N2).
 */
export type SessionGate = (session: Session) => void;
export const sessionGate =
  (context: Context, mode: Mode): SessionGate =>
  (session) => {
    requireProfile({ reader: session.reader, within: session.reader.resolveScope().token, context, mode });
  };

/**
 * Review C-R2: the characters a printed command may repeat from caller or authored input and stay inert pasted into sh,
 * PowerShell or cmd, inside the double quotes `quote()` adds for a space. A token opening with `~` is not one: pwsh expands
 * it even double-quoted when the command runs through an npm-style .ps1 shim, so it is never repeated (review F4).
 */
const INERT = /^(?!~)[A-Za-z0-9@+=:,./_~#\- ]*$/;
/**
 * Review C2-R8: a token as a printed command spells it. One with a space, or one opening a comment (`#`) or a PowerShell
 * splat (`@`), is double-quoted, which keeps those literal in sh, PowerShell and cmd; so is one holding a comma (a
 * PowerShell array) or a tilde anywhere past its start (an expansion after `=` or `:` in some shells; review C3-N1).
 * INERT has already kept every character double quotes leave live out of it. The quotes are JSON's, as `quote()` spells
 * every printed argument, so the command parses as design row 27's other commands do.
 */
const spelled = (token: string): string => (/^[#@]|[,~]/.test(token) ? JSON.stringify(token) : quote(token));
/** The word a preview or author form names: a new record's word, or the owned record's `@word` or identity facet. */
function wordOf(args: Context['args']): string | undefined {
  const first = args.positionals[0] ?? '';
  if (!args.flag('relate') && !args.flag('set')) return /^[a-z][a-z0-9-]*$/.test(first) ? first : undefined;
  const reference = /^@([a-z][a-z0-9-]*)/.exec(first)?.[1],
    facet = first.split('/')[2];
  return reference ?? (facet !== undefined && /^[a-z][a-z0-9-]*$/.test(facet) ? facet : undefined);
}
/**
 * Review C-R2: a refusal of `ia preview` or `ia author`, or a mandate refusal of any command, whose next command would
 * repeat a value holding shell syntax (`$(...)`, a backtick, `%`, a quote, `;` and the like) names an inert command in its
 * place: the word's preview, keeping an `--actor` the command named, or else the repository's position. The `--root` value
 * is the invocation's own and is repeated as every command repeats it: only that value, as the option before any `--`, is
 * exempt (review C2-R8). Every token the command keeps is spelled by `spelled`, so a bare `#` or `@` token is quoted; one opening with `~` is never repeated.
 */
export function inertNext(refusal: Refusal, context: Pick<Context, 'command' | 'args'>): Refusal {
  const verb = context.command.name;
  if (
    refusal.next === null ||
    (verb !== 'preview' && verb !== 'author' && !refusal.code.startsWith('IA-RUNTIME-MANDATE-'))
  )
    return refusal;
  const match = QUOTED.exec(refusal.next);
  if (match === null) return refusal;
  const argv = argumentsOf(match[1]!);
  const supplied = context.args.value('root'),
    end = argv.indexOf('--'),
    own = (index: number): boolean =>
      supplied !== undefined && argv[index - 1] === '--root' && (end === -1 || index < end) && argv[index] === supplied;
  if (argv.every((arg, index) => own(index) || INERT.test(arg))) {
    const command = argv.map((arg, index) => (own(index) ? quote(arg) : spelled(arg))).join(' ');
    return command === match[1]
      ? refusal
      : new Refusal(
          refusal.code,
          refusal.message,
          refusal.exit,
          refusal.where,
          refusal.next.replace(match[0], `"${command}"`),
          refusal.at,
        );
  }
  const rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`,
    at = argv.indexOf('--actor'),
    actor = at !== -1 && INERT.test(argv[at + 1] ?? '-') ? ` --actor ${spelled(argv[at + 1]!)}` : '',
    word = verb === 'preview' || verb === 'author' ? wordOf(context.args) : undefined;
  return new Refusal(
    refusal.code,
    refusal.message,
    refusal.exit,
    refusal.where,
    word === undefined
      ? `Run "ia position${rooted}" for the repository's position; the command this refusal names would repeat a value that holds shell syntax, so it is not printed.`
      : `Run "ia preview ${word}${actor}${rooted}" for what a @${word} record holds; the command this refusal names would repeat a value that holds shell syntax, so it is not printed.`,
    refusal.at,
  );
}

const QUOTED = /"(ia(?: (?:"(?:[^"\\]|\\.)*"|[^\s"]+))*)"/;
/**
 * The arguments of a next command's body, its `"…"` JSON strings decoded and its bare `[^\s"]+` tokens as written, in
 * one pass. QUOTED matched the body, so every quoted token closes. A global regex would retry its quoted branch at every
 * quote, which is quadratic on a value full of `\"` (CodeQL js/polynomial-redos).
 */
function argumentsOf(body: string): string[] {
  const argv: string[] = [];
  let at = 0;
  while (at < body.length) {
    if (/\s/.test(body[at]!)) {
      at += 1;
    } else if (body[at] === '"') {
      let end = at + 1;
      while (end < body.length && body[end] !== '"') end += body[end] === '\\' ? 2 : 1;
      argv.push(JSON.parse(body.slice(at, end + 1)) as string);
      at = end + 1;
    } else {
      let end = at;
      while (end < body.length && body[end] !== '"' && !/\s/.test(body[end]!)) end += 1;
      argv.push(body.slice(at, end));
      at = end;
    }
  }
  return argv;
}
/**
 * Design row 27 under the profile: the next action a gated command printed, a refusal's or (review C2-N11) its own after
 * a success, judged by the profile that let the command run. A next command of a gated mode the profile refuses (its
 * move, or for `ia preview` and `ia author` the word it names) becomes the governance position, which is never gated;
 * one the profile allows carries `--actor`, the participant it resolved, when the command named its actor so. A next
 * action printed before any profile, or naming an ungated command, is returned as it is.
 */
export function judgedNext(next: string, gate: Gate | undefined): string {
  const state = gate?.state;
  if (state === undefined) return next;
  const match = QUOTED.exec(next);
  if (match === null) return next;
  const argv = argumentsOf(match[1]!);
  const verb = argv[1] ?? '',
    mode = verb === 'host' ? hostMode(argv) : GATED_MODES[verb];
  if (mode === undefined) return next;
  const word =
    (verb === 'preview' || verb === 'author') && !argv.includes('--relate') && !argv.includes('--set')
      ? argv.slice(2).find((token) => !token.startsWith('-'))
      : undefined;
  const verdict = profileRefusal(state.mandates, mode, word === undefined ? [] : [word]);
  if (verdict.refusal !== undefined) {
    const seat = seatOf(verdict.refusal.next) ?? state.workspace;
    const why = `${verb} needs ${MODE_MOVES[mode]}${word === undefined ? '' : ` and @${word}`}, which they do not grant${state.actor === undefined ? '' : ` ${state.actor}`}`;
    return seat === undefined
      ? `Run "ia position${state.rooted}" for the repository's position and the mandates that govern it; ${why}.`
      : `Run "ia position --seat ${seat} --shape governance${state.rooted}" for what the mandates that govern here allow; ${why}.`;
  }
  if (state.by !== 'actor' || state.actor === undefined || argv.includes('--actor')) return next;
  const actor = ` --actor ${quote(state.actor)}`;
  const command = match[1]!.includes(' -- ') ? match[1]!.replace(' -- ', `${actor} -- `) : `${match[1]}${actor}`;
  return next.replace(match[0], `"${command}"`);
}
/** A refusal a gated command raised, its next command judged by `judgedNext`. */
export function gatedNext(refusal: Refusal, gate: Gate | undefined): Refusal {
  if (refusal.next === null) return refusal;
  const next = judgedNext(refusal.next, gate);
  return next === refusal.next
    ? refusal
    : new Refusal(refusal.code, refusal.message, refusal.exit, refusal.where, next, refusal.at);
}
