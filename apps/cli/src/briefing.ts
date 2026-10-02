/**
 * docs/specs/host-plugin-distribution/README.md §8.2: what the session hook tells the model and the user.
 * A pure function of facts `ia doctor` already gathered, so every row of §8.2 is a unit test. At most one notice:
 * version skew, then an interrupted installation or a stale or missing host, then a decline reminder, then an update.
 * Dates are the user's local calendar date, as the `declined-today` expiry is (§9.1).
 *
 * `nextActions` is §7.3's `[{intent, argv, host}]`: `host` is the adapter row's own invocation where §4's table
 * declares one (Claude's `/ia:init`), otherwise the plain command. The Claude plugin is a Claude concern, so its version
 * skew is reported only to a host whose row installs a plugin; a host with no workspace set (§4, Cursor) is never told
 * its registration is missing, because `ia host` would refuse to write one. When doctor could not observe the host set
 * (an interrupted installation, or installed state it could not read) the briefing says so, for every host, and never
 * suggests `ia host`, which would refuse until recovery runs.
 *
 * One report has one root. Given `--root`, doctor reports that directory literally, so every command the briefing
 * names carries it the way its verb takes a directory: `ia host <host> --root <root>`, and `ia init <root>` (init takes
 * its target as a positional and refuses `--root`). A host's own invocation runs in the session's project directory,
 * so it is used only without `--root`. `ia host <host> --user` belongs to no workspace and refuses `--root`, so it
 * never carries one. A supplied directory that is not itself a workspace but lies inside one is neither offered
 * initialization nor described: the briefing names the enclosing workspace and the command that reports it.
 */
import type { Decision } from '@ia/distribution/decisions';
import type { Intent } from '@ia/distribution/hosts';
import { hostRow, invocation, workspaceRow } from '@ia/distribution/hosts';
import type { Channel } from './channel.js';
import { describeChannel, updateInstruction } from './channel.js';
import { quote } from './render.js';

export interface NextAction {
  readonly intent: Intent;
  readonly argv: readonly string[];
  /** The host's own invocation when its adapter row declares one and no --root was given; otherwise the plain command. */
  readonly host: string;
}
export interface Session {
  /** Lines for the model (§8.1 step 3's `additionalContext`). */
  readonly context: readonly string[];
  /** The one line the user sees, or null in the §8.2 states where the user sees nothing. */
  readonly notice: string | null;
  /** 'update' when the notice is an update nudge, which the hook shows at most once per local day (Amendment item 4). */
  readonly nudge: 'update' | null;
  /** The argument vector the hook starts detached to refresh the update cache, or null when none is due (Amendment item 4). */
  readonly refresh: readonly string[] | null;
}
export interface BriefInput {
  readonly host: string;
  readonly version: string;
  readonly channel: Channel;
  /** The CLI version the materialized Claude plugin records, or null when it is absent or unreadable. */
  readonly plugin: { readonly cli: string } | null;
  /** The workspace root, or undefined when there is no workspace. */
  readonly root: string | undefined;
  /** The `--root` doctor was given, or undefined when it discovered the root from the working directory. */
  readonly supplied: string | undefined;
  /** The workspace a supplied non-workspace directory lies inside, or null. */
  readonly enclosing: string | null;
  readonly frameworkSource: boolean;
  readonly decision: Decision | null;
  /** The records row's detail, or null when records were not read. */
  readonly records: string | null;
  /** 'unknown' when doctor could not observe the host set; 'absent' only when it observed none for this host. */
  readonly hostStatus: 'registered' | 'stale' | 'absent' | 'unknown';
  /** Why the host is stale, or why it was not observed: the failing rows' details, for the model. */
  readonly hostDetail: string | null;
  /** The pending row's remedy when an interrupted installation needs recovery, else null. */
  readonly recovery: string | null;
  readonly updates: { readonly latest: string | null; readonly behind: number | null } | null;
  readonly refresh: readonly string[] | null;
}
/** An argument vector as one printable command, each argument quoted the way doctor's rows quote a root. */
const command = (argv: readonly string[]): string => argv.map(quote).join(' ');
/**
 * The host as every notice and context line names it: `Claude`, `Codex`, `Cursor`. The adapter row's label is the
 * product name ("Claude Code"); these lines name the host the way §8.2's own wording does.
 */
const named = (host: string): string => host.charAt(0).toUpperCase() + host.slice(1);
/** A timestamp as the user's local calendar date, YYYY-MM-DD. */
export const localDate = (at: string): string => new Date(at).toLocaleDateString('en-CA');

export function brief(input: BriefInput): { readonly session: Session; readonly nextActions: readonly NextAction[] } {
  const context = [`ia ${input.version} (${describeChannel(input.channel)}).`];
  const actions: NextAction[] = [];
  const rooted = input.supplied !== undefined;
  const action = (intent: Intent, argv: readonly string[]): NextAction => ({
    intent,
    argv,
    host: rooted ? command(argv) : invocation(input.host, intent, argv),
  });
  let notice: string | null = null,
    nudge: Session['nudge'] = null;
  const first = (text: string): void => {
    if (notice === null) notice = text;
  };
  // §8.2 row 2: the plugin the user runs was rendered by another ia; re-rendering it is the whole remedy.
  if (hostRow(input.host)?.user === 'plugin' && input.plugin !== null && input.plugin.cli !== input.version) {
    const user = ['ia', 'host', input.host, '--user', '--apply'];
    first(`IA: the plugin was installed by ia ${input.plugin.cli} but ia is ${input.version}; run ${command(user)}`);
    context.push(
      `The ${named(input.host)} plugin was installed by ia ${input.plugin.cli}; this is ia ${input.version}. Run ${command(user)}.`,
    );
    actions.push(action('host-user', user));
  }
  if (input.frameworkSource) {
    context.push(
      `This is the InventArch framework source (${input.root}). Use its CLAUDE.md and pnpm gates; consumer workspace advice does not apply here.`,
    );
  } else if (input.root === undefined && input.enclosing !== null) {
    // The report is about the supplied directory, not the workspace above it; name that workspace and stop.
    context.push(
      `${input.supplied} is inside InventArch workspace ${input.enclosing}; run ${command(['ia', 'doctor', '--root', input.enclosing])} for its state.`,
    );
  } else if (input.root === undefined) {
    const decision = input.decision;
    if (decision?.decision === 'declined-forever') {
      const on = localDate(decision.at);
      first(`IA not installed in ${decision.path}; declined by user ${on}`);
      context.push(
        `The user declined InventArch here permanently on ${on}. Do not offer initialization. "ia init" still works if the user asks for it explicitly.`,
      );
    } else if (decision?.decision === 'declined-today') {
      context.push('The user declined initialization here today. Do not offer it again.');
    } else {
      // §8.3: an instruction to the model, not a mechanical guarantee.
      const init = action('init', ['ia', 'init', input.supplied ?? '.']);
      context.push(
        `${rooted ? `${input.supplied} is` : 'This directory is'} not an InventArch workspace. Do not search the filesystem for other .ia trees or IA tooling. Offer initialization only if the user's request involves InventArch, .ia records or their governance; then use ${init.host === command(init.argv) ? `"${init.host}"` : init.host}.`,
      );
      actions.push(init);
    }
  } else {
    context.push(`InventArch workspace ${input.root}: ${input.records ?? 'records not read'}.`);
    const label = named(input.host);
    const apply = [
      'ia',
      'host',
      input.host,
      ...(input.supplied === undefined ? [] : ['--root', input.supplied]),
      '--apply',
    ];
    if (input.hostStatus === 'unknown') {
      // Every ia host plan refuses until recovery runs, so recovery is the only command worth naming, for any host.
      if (input.recovery !== null) first(`IA: an interrupted installation needs recovery; run ${input.recovery}`);
      context.push(
        `Host ${label}: not checked${input.hostDetail === null ? '' : ` (${input.hostDetail})`}.${input.recovery === null ? '' : ` An interrupted installation needs recovery first: ${input.recovery}.`} Do not run ia host until ia doctor reports the host set.`,
      );
    } else if (workspaceRow(input.host) === undefined)
      context.push(`Host ${label} has no workspace registration in this ia.`);
    else if (input.hostStatus === 'registered') context.push(`Host ${label}: registered.`);
    else {
      if (input.hostStatus === 'stale') {
        first(`IA: the ${label} host registration for this workspace is stale; run ${command(apply)}`);
        context.push(
          `Host ${label}: stale${input.hostDetail === null ? '' : ` — ${input.hostDetail}`}. Run ${command(apply)}.`,
        );
      } else {
        first(`IA: this workspace has no ${label} host registration; run ${command(apply)}`);
        context.push(`Host ${label}: not registered. Run ${command(apply)}.`);
      }
      actions.push(action('host', apply));
    }
  }
  // §8.2 last row and §11: only from the cache doctor already read; the hook, not doctor, limits it to once a day.
  const updates = input.updates;
  const newer = updates !== null && updates.latest !== null && updates.latest !== input.version;
  if (updates !== null && (newer || (updates.behind ?? 0) > 0)) {
    const what = newer
      ? `ia ${updates.latest} is available (you have ${input.version})`
      : `your checkout is ${updates.behind} commits behind its upstream`;
    context.push(`Update: ${what}. ${updateInstruction(input.channel)}.`);
    if (notice === null) {
      notice = `IA: ${what}. ${updateInstruction(input.channel)}`;
      nudge = 'update';
    }
  }
  return { session: { context, notice, nudge, refresh: input.refresh }, nextActions: actions };
}
