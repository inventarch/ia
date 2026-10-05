/**
 * `ia host <host> --user`: docs/specs/host-plugin-distribution/README.md §6.3 (amended, item 5) and §7.1.
 *
 * Needs no workspace. Plans by default and writes nothing while planning; `--apply` renders the plugin, swaps it into
 * the IA home's marketplace directory, then runs Claude's own `claude plugin …` commands. Without `claude` it
 * materializes and prints the commands. It never reads or edits Claude's settings files. A service refusal keeps its
 * code and message (contract §4.1) and gains the next action the CLI can supply, as `ia host` does.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderClaudePlugin } from '@inventarch/compliance';
import type { PluginFile } from '@inventarch/compliance';
import { nodeCommand } from '@inventarch/distribution/host';
import { hostRow } from '@inventarch/distribution/hosts';
import { assertIaHomeUsable } from '@inventarch/distribution/ia-home';
import {
  MARKETPLACE_DIR,
  materializeMarketplace,
  readMaterializedPlugin,
  removeMarketplace,
} from '@inventarch/distribution/plugin-home';
import { UsageError } from './args.js';
import { detectChannel, updateInstruction } from './channel.js';
import type { Channel } from './channel.js';
import type { ClaudeRunner } from './claude-cli.js';
import { claudeRunner, observeClaude, registrationCommands, removalCommands } from './claude-cli.js';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, refusalOf } from './consumer.js';
import { homeSrcRemedy, hostHome, located } from './home-remedy.js';
import type { Capabilities } from './render.js';
import { blockSymbolWidth, commandFacts, document, entry, headerLine, indentOf, quote, words } from './render.js';

export interface UserHostView {
  readonly host: 'claude';
  readonly remove: boolean;
  readonly home: string;
  readonly marketplace: string;
  readonly plugin: { readonly version: string; readonly cli: string; readonly channel: Channel['kind'] };
  /** The plugin already materialized in the IA home, read from its own metadata; null when absent or unreadable. */
  readonly installed: { readonly version: string } | null;
  /** Whether `claude` can be run. Without it the commands are printed, not run. */
  readonly claude: boolean;
  /** Claude CLI argument vectors, in the order apply runs them. */
  readonly commands: readonly (readonly string[])[];
  readonly files: readonly PluginFile[];
}

/**
 * §6.2 (amended): the digest is of the files rendered with a placeholder version, so it changes whenever the renderer's
 * output does, including when the recorded Node changes. `node` is the Node that runs the hook (#436).
 */
export function buildClaudePlugin(input: {
  readonly cliVersion: string;
  readonly channel: Channel;
  readonly entry: string;
  readonly node: string;
}): {
  readonly version: string;
  readonly files: readonly PluginFile[];
} {
  const base = {
    cliVersion: input.cliVersion,
    channel: input.channel.kind,
    entry: input.entry,
    install: updateInstruction(input.channel),
    node: input.node,
  };
  const draft = renderClaudePlugin({ ...base, version: '0.0.0' });
  const digest = createHash('sha256')
    .update(draft.map((file) => `${file.path}\0${file.text}`).join('\0'))
    .digest('hex');
  const version = `${input.cliVersion}+${digest.slice(0, 12)}`;
  return { version, files: renderClaudePlugin({ ...base, version }) };
}

/** The rerun a next action names; the only user-level host is Claude. */
const rerunOf = (remove: boolean): string => `ia host claude --user${remove ? ' --remove' : ''} --apply`;
/** A Claude command as a reader can paste it back. */
export const claudeCommand = (command: readonly string[]): string => ['claude', ...command].map(quote).join(' ');

/**
 * §7.1's plan. It reads the IA home and asks `claude` what it lists; it writes nothing. `claude` is first run (the
 * availability probe) only after every usage check and refusal has passed, so a class-2 invocation does no work
 * (contract §3). The runner is returned so apply reuses it instead of probing again.
 */
export function collectUserHost(
  context: Context,
  runnerFor: (env: Readonly<Record<string, string | undefined>>) => ClaudeRunner = claudeRunner,
): { readonly view: UserHostView; readonly runner: ClaudeRunner } {
  const { args, host } = context;
  const name = args.positionals[0] ?? '';
  // §4: the adapter table decides. Unknown is usage, and so is --root (§7.1); both precede every read.
  const row = hostRow(name);
  if (row === undefined) throw new UsageError(`ia host takes claude, codex or cursor; got ${name}`);
  if (args.value('root') !== undefined)
    throw new UsageError('--root does not apply with --user; the user-level entry point belongs to no workspace');
  // §4: a row without a user-level entry point — Codex (partial) and Cursor (planned) — refuses naming the host.
  if (row.user === 'none')
    throw new Refusal(
      'IA-DIST-HOST-UNSUPPORTED',
      `${row.label} has no user-level entry point in this release; nothing was written`,
      3,
      null,
      'Run "ia host claude --user".',
    );
  const home = hostHome(host.env);
  // Host plugin distribution spec §3: refuse a home that looks like a workspace now, before apply attempts a write.
  located(null, homeSrcRemedy(home), () => assertIaHomeUsable(home));
  const channel = detectChannel(host.packageRoot);
  // #436: on macOS and Linux the hook runs under the Node running this command, recorded by its own absolute path (a
  // Homebrew keg's stable opt link), not a version manager's shim; the Windows rendering keeps `node` by name.
  const plugin = buildClaudePlugin({
    cliVersion: host.version,
    channel,
    entry: resolve(host.packageRoot, 'dist/main.js'),
    node: nodeCommand(),
  });
  const marketplace = resolve(home, MARKETPLACE_DIR);
  const remove = args.flag('remove');
  const installed = readMaterializedPlugin(home);
  const runner = runnerFor(host.env);
  const view: UserHostView = {
    host: 'claude',
    remove,
    home,
    marketplace,
    plugin: { version: plugin.version, cli: host.version, channel: channel.kind },
    installed: installed === null ? null : { version: installed.version },
    claude: runner.available,
    // §2.3: registration is idempotent and needs no observation; removal asks claude what exists.
    commands: remove ? removalCommands(observeClaude(runner)) : registrationCommands(marketplace),
    files: plugin.files,
  };
  return { view, runner };
}

/**
 * A marketplace refusal from `@inventarch/distribution/plugin-home`, its code and message kept, located at the IA home's
 * `claude` directory (which holds the marketplace and its lock) and given a next action. Anything without an IA-DIST
 * code is not the service's refusal and passes through unchanged.
 */
function marketplaceRefusal(error: unknown, view: UserHostView): unknown {
  const refusal = refusalOf(error);
  if (!refusal.code.startsWith('IA-DIST-')) return error;
  const directory = join(view.home, 'claude'),
    rerun = rerunOf(view.remove);
  const next =
    refusal.code === 'IA-DIST-INSTALL-BUSY'
      ? // Two causes share the code: files held open during a rename, and another run holding the lock.
        `Wait for any other "ia host --user" run to finish and close Claude Code sessions, editors or terminals using ${directory}; if no run is active, delete ${join(directory, '.lock')}; then rerun "${rerun}".`
      : refusal.code === 'IA-DIST-RECOVERY-REQUIRED'
        ? `Rerun "${rerun}".`
        : refusal.code === 'IA-DIST-PATH-UNSAFE' && existsSync(join(view.home, 'src'))
          ? homeSrcRemedy(view.home)
          : refusal.code === 'IA-DIST-INPUT-INVALID'
            ? `Check the permissions of ${directory}, then rerun "${rerun}".`
            : refusal.next;
  return new Refusal(refusal.code, refusal.message, 3, refusal.where ?? { path: directory }, next);
}
function marketplaceStep<T>(view: UserHostView, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw marketplaceRefusal(error, view);
  }
}

export interface UserHostApplied {
  /** `plugin-directory-removed`: a removal without `claude`, so only the directory went and the commands are printed. */
  readonly status: 'plugin-registered' | 'plugin-materialized' | 'plugin-removed' | 'plugin-directory-removed';
  /** The Claude commands that ran and exited 0, in order. Empty when `claude` was unavailable. */
  readonly ran: readonly (readonly string[])[];
}
/**
 * §6.3: materialize, then register through `claude`; removal runs `claude` first and deletes the directory last, so a
 * failed uninstall leaves the marketplace Claude still points at. A failing command refuses naming itself and the
 * rerun, and the commands before it have run. A rerun converges: registration repeats two idempotent commands, and
 * removal asks claude again what is left (§2.3).
 */
export function applyUserHost(view: UserHostView, runner: ClaudeRunner): UserHostApplied {
  if (!view.remove) marketplaceStep(view, () => materializeMarketplace(view.home, view.files));
  const ran: string[][] = [];
  if (view.claude)
    for (const command of view.commands) {
      const result = runner.run(command);
      if (result.status !== 0)
        throw new Refusal(
          'IA-CLI-HOST-COMMAND-FAILED',
          `${claudeCommand(command)} exited ${result.status ?? 'without a status'}: ${result.output || 'no output'}`,
          3,
          null,
          `Run "${claudeCommand(command)}" yourself to see why, then rerun "${rerunOf(view.remove)}".`,
        );
      ran.push([...command]);
    }
  if (view.remove) marketplaceStep(view, () => removeMarketplace(view.home));
  const status = view.remove
    ? view.claude
      ? 'plugin-removed'
      : 'plugin-directory-removed'
    : view.claude
      ? 'plugin-registered'
      : 'plugin-materialized';
  return { status, ran };
}

/** §7.1 `--json`: the plan always, and `applied` only after an apply. The rendered files are not part of it. */
const envelope = (view: UserHostView, applied: UserHostApplied | null): unknown => ({
  version: 1,
  command: 'host',
  user: true,
  host: view.host,
  apply: applied !== null,
  plan: {
    remove: view.remove,
    home: view.home,
    marketplace: view.marketplace,
    plugin: view.plugin,
    installed: view.installed,
    claude: view.claude,
    commands: view.commands,
  },
  ...(applied === null ? {} : { applied }),
});
const DONE: Readonly<Record<UserHostApplied['status'], string>> = {
  'plugin-registered':
    'Registered: the plugin is written and each claude command exited 0. Claude Code loads it at its next session start.',
  'plugin-materialized': 'Written; not registered with Claude.',
  'plugin-removed': 'Removed: each claude command exited 0 and the plugin directory is deleted.',
  'plugin-directory-removed': 'Deleted the plugin directory; not removed from Claude.',
};
const unavailable = (view: UserHostView, applied: boolean): string =>
  applied
    ? 'claude could not be run: run the claude commands above by hand.'
    : `claude could not be run: apply ${view.remove ? 'deletes the directory' : 'writes the plugin'}, and the claude commands above must then be run by hand.`;
/** The content column of a depth-1 step (§6.4 rule 2), so a wrapped command breaks within the width. */
const STEP_COLUMN = (caps: Capabilities): number => indentOf(1) + blockSymbolWidth(['step'], caps.ascii) + 2;
const summary = (view: UserHostView, context: Context, applied = false): readonly (readonly string[])[] => {
  const { caps } = context;
  return [
    [
      ...headerLine('Plan', `host claude --user${view.remove ? ' --remove' : ''}`, [], caps),
      ...headerLine('Home', view.home, [], caps),
    ],
    [
      ...(view.remove
        ? []
        : entry(
            [words(`Write the plugin ${view.plugin.version} to ${view.marketplace}`)],
            { depth: 1, symbol: 'step' },
            caps,
          )),
      ...view.commands.flatMap((command) =>
        entry(
          commandFacts('', claudeCommand(command), '', STEP_COLUMN(caps), caps),
          { depth: 1, symbol: 'step' },
          caps,
        ),
      ),
      ...(view.remove ? entry([words(`Delete ${view.marketplace}`)], { depth: 1, symbol: 'step' }, caps) : []),
    ],
    ...(view.claude ? [] : [entry([words(unavailable(view, applied))], { depth: 1, symbol: 'warning' }, caps)]),
  ];
};
function render(view: UserHostView, applied: UserHostApplied | null, context: Context): string {
  const { caps } = context;
  const [header, ...rest] = summary(view, context, applied !== null);
  return document(
    [
      header!,
      applied === null
        ? entry([words('This is a preview. Nothing has been written.')], { depth: 1 }, caps)
        : entry([words(DONE[applied.status])], { depth: 1, symbol: 'success' }, caps),
      ...rest,
      ...(applied === null
        ? [
            entry(
              commandFacts('Apply with "', `${rerunOf(view.remove)} --yes`, '".', 3, caps),
              { depth: 0, symbol: 'step' },
              caps,
            ),
          ]
        : []),
    ],
    { leadingBlank: true },
  );
}
const CONFIRMATION = 'Install the InventArch plugin? [y/N] ';
const REMOVAL_CONFIRMATION = 'Remove the InventArch plugin? [y/N] ';

export async function runUserHost(context: Context): Promise<Result> {
  const { args, caps, host, json } = context;
  const { view, runner } = collectUserHost(context);
  const done = (applied: UserHostApplied | null): Result =>
    json
      ? { exitCode: 0, stdout: JSON.stringify(envelope(view, applied)) + '\n', stderr: '' }
      : { exitCode: 0, stdout: render(view, applied, context), stderr: '' };
  if (!args.flag('apply')) return done(null);
  // §2.8 rule 3. Parsing has already refused every --apply whose question cannot be asked or answered.
  if (
    !args.flag('yes') &&
    !(await confirm(
      host.interaction,
      document(summary(view, context), { leadingBlank: true }),
      view.remove ? REMOVAL_CONFIRMATION : CONFIRMATION,
    ))
  )
    return {
      exitCode: 0,
      stdout: document([entry([words('Nothing was applied.')], { depth: 0, symbol: 'info' }, caps)], {
        leadingBlank: true,
      }),
      stderr: '',
    };
  host.signal?.throwIfAborted();
  return done(applyUserHost(view, runner));
}
