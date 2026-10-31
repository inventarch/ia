/**
 * `ia host <claude|codex|copilot> --commit`: the committed bootstrap (distribution bootstrap.ts). It writes only
 * committable files, the instruction block that names `ia_session` and the three lanes and the `ia` MCP server that
 * launches `npx -y @inventarch/mcp-door@<this CLI's version>`, so a fresh clone, a new worktree or a cloud agent reaches
 * IA. It writes nothing under the IA home and no machine-local registration; `ia host <host>` without `--commit` keeps
 * doing that. A plan writes nothing; `--apply` is the effect mode under the participant's mandate profile.
 */
import { applyBootstrap, planBootstrap } from '@inventarch/distribution/bootstrap';
import type { BootstrapFile, BootstrapPlan } from '@inventarch/distribution/bootstrap';
import { bootstrapRow, BOOTSTRAP_HOSTS } from '@inventarch/distribution/hosts';
import type { BootstrapHost } from '@inventarch/distribution/hosts';
import { UsageError } from './args.js';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, refusalOf, requireRoot } from './consumer.js';
import { requireInitialized } from './host.js';
import { sessionGate } from './profile.js';
import type { Capabilities, SymbolName } from './render.js';
import { document, entry, quote, words } from './render.js';
import { openSession } from './session.js';

export const COMMIT_CONFIRMATION = 'Write this committed bootstrap? [y/N] ';
const SYMBOL: Readonly<Record<BootstrapFile['action'], SymbolName>> = {
  create: 'added',
  update: 'updated',
  remove: 'removed',
  unchanged: 'info',
};
/** What the plan says once: the bootstrap is for committing, and what it does not hold. */
export const COMMITTABLE =
  'Commit these files: they hold no machine-local path. The door entry runs "npx -y @inventarch/mcp-door@<version>" from the project folder; on native Windows a host that cannot start npx directly needs it wrapped in "cmd /c".';

function envelope(plan: BootstrapPlan, applied: boolean): unknown {
  return {
    version: 1,
    command: 'host',
    host: plan.host,
    mode: 'commit',
    remove: plan.remove,
    door: `@inventarch/mcp-door@${plan.version}`,
    files: plan.files.map(({ path, kind, action }) => ({ path, kind, action })),
    applied,
  };
}
function render(plan: BootstrapPlan, applied: boolean, caps: Capabilities, rooted: string): string {
  const verb = applied ? 'Wrote' : 'Would write';
  return document(
    [
      entry(
        [
          words(
            `${verb} the committed IA bootstrap for ${bootstrapRow(plan.host)!.label}${plan.remove ? ' (removal)' : ''}.`,
          ),
        ],
        { depth: 0, symbol: 'info' },
        caps,
      ),
      ...plan.files.map((file) =>
        entry([words(`${file.path}: ${file.action} (${file.kind})`)], { depth: 1, symbol: SYMBOL[file.action] }, caps),
      ),
      entry([words(COMMITTABLE, 'dim')], { depth: 0 }, caps),
      ...(applied
        ? []
        : [
            entry(
              [
                words(
                  `Apply with "ia host ${plan.host} --commit${plan.remove ? ' --remove' : ''} --apply --yes${rooted}".`,
                ),
              ],
              { depth: 0, symbol: 'step' },
              caps,
            ),
          ]),
    ],
    { leadingBlank: true },
  );
}

export async function runCommitHost(context: Context): Promise<Result> {
  const { args, caps, host, json } = context;
  const name = args.positionals[0] ?? '';
  if (!(BOOTSTRAP_HOSTS as readonly string[]).includes(name))
    throw new UsageError(`ia host --commit takes ${BOOTSTRAP_HOSTS.join(', ')}; got ${name}`);
  const supplied = args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`;
  const root = requireRoot(context);
  requireInitialized(root);
  const remove = args.flag('remove');
  let plan: BootstrapPlan;
  try {
    plan = planBootstrap(root, name as BootstrapHost, host.version, remove);
  } catch (error) {
    const refusal = refusalOf(error);
    throw new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      { path: root },
      `Repair the file the message names, then run "ia host ${name} --commit${rooted}".`,
    );
  }
  const print = (applied: boolean): Result => ({
    exitCode: 0,
    stdout: json ? JSON.stringify(envelope(plan, applied)) + '\n' : render(plan, applied, caps, rooted),
    stderr: '',
  });
  if (!args.flag('apply')) return print(false);
  if (!remove) {
    const session = openSession(root);
    try {
      sessionGate(context, 'effect')(session);
    } finally {
      session.close();
    }
  }
  if (!args.flag('yes') && !(await confirm(host.interaction, render(plan, false, caps, rooted), COMMIT_CONFIRMATION)))
    return {
      exitCode: 0,
      stdout: document([entry([words('Nothing was written.')], { depth: 0, symbol: 'info' }, caps)], {
        leadingBlank: true,
      }),
      stderr: '',
    };
  try {
    applyBootstrap(plan);
  } catch (error) {
    const refusal = refusalOf(error);
    throw new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      { path: root },
      `Run "ia host ${name} --commit${rooted}" again for a fresh plan.`,
    );
  }
  return print(true);
}
