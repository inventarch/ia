/**
 * `ia host <claude|codex|copilot> --commit`: the committed bootstrap (distribution bootstrap.ts). It writes only
 * committable files, the instruction block that names `ia_session` and the three lanes and the `ia` MCP server that
 * launches `npx -y -p @inventarch/mcp-door@<this CLI's version> -p @inventarch/public-kits@<version> ia-mcp-door
 * --kits-package @inventarch/public-kits`, so a fresh clone, a new worktree or a cloud agent reaches IA with the
 * default kits. The kits package is recorded as one `package` entry in `.ia/distributions.lock.json` (contract C7,
 * dec-122): the version the lock already pins, else `--kits-package-version`, else npm's `latest`, with the integrity
 * and kits `npm view` reports for it. Nothing is vendored. It writes nothing under the IA home and no machine-local
 * registration; `ia host <host>` without `--commit` keeps doing that. A plan writes nothing; `--apply` is the effect
 * mode under the participant's mandate profile. A removal removes the bootstrap files and keeps the lock entry.
 */
import { INSTALL_PATHS } from '@inventarch/db/distribution';
import type { DistributionLock, PackageEntry } from '@inventarch/db/distribution';
import { applyBootstrap, planBootstrap } from '@inventarch/distribution/bootstrap';
import type { BootstrapFile, BootstrapPlan } from '@inventarch/distribution/bootstrap';
import { bootstrapRow, BOOTSTRAP_HOSTS } from '@inventarch/distribution/hosts';
import type { BootstrapHost } from '@inventarch/distribution/hosts';
import { applyInstallation, planInstallation } from '@inventarch/distribution/install';
import type { InstallationPlan } from '@inventarch/distribution/install';
import { readWorkspaceLock } from '@inventarch/distribution/services';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './args.js';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, refusalOf, requireRoot } from './consumer.js';
import { requireInitialized } from './host.js';
import { sessionGate } from './profile.js';
import type { Capabilities, SymbolName } from './render.js';
import { document, entry, quote, words } from './render.js';
import { openSession } from './session.js';
import { requireProjectionsClean } from './distribute.js';
import { applyHostProjection, renderProjectionFor } from './host-projection.js';
import { projectedHosts } from './host.js';
import { DEFAULT_KITS_PACKAGE, lockWithPackage, npmView, sameLock, viewKitsPackage } from './kits-package.js';

export const COMMIT_CONFIRMATION = 'Write this committed bootstrap? [y/N] ';
const SYMBOL: Readonly<Record<BootstrapFile['action'], SymbolName>> = {
  create: 'added',
  update: 'updated',
  remove: 'removed',
  unchanged: 'info',
};
/** What the plan says once: the bootstrap is for committing, and what it does not hold. */
export const COMMITTABLE =
  'Commit these files and .ia/distributions.lock.json: they hold no machine-local path. The door entry runs "npx -y -p @inventarch/mcp-door@<version> -p @inventarch/public-kits@<version> ia-mcp-door --kits-package @inventarch/public-kits" from the project folder; on native Windows a host that cannot start npx directly needs it wrapped in "cmd /c".';

/** The lock half of a committed bootstrap: the package entry, and the installation that records it, if it changes. */
interface LockPlan {
  readonly entry: PackageEntry;
  readonly action: 'create' | 'update' | 'unchanged';
  readonly installation: InstallationPlan | null;
}
function envelope(plan: BootstrapPlan, lock: LockPlan | null, applied: boolean): unknown {
  return {
    version: 1,
    command: 'host',
    host: plan.host,
    mode: 'commit',
    remove: plan.remove,
    door: `@inventarch/mcp-door@${plan.version}`,
    ...(lock === null
      ? {}
      : {
          kitsPackage: {
            name: lock.entry.name,
            version: lock.entry.version,
            integrity: lock.entry.integrity,
            kits: lock.entry.kits.map((kit) => kit.id),
          },
        }),
    files: [
      ...plan.files.map(({ path, kind, action }) => ({ path, kind, action })),
      ...(lock === null ? [] : [{ path: INSTALL_PATHS.lock, kind: 'lock', action: lock.action }]),
    ],
    applied,
  };
}
function render(
  plan: BootstrapPlan,
  lock: LockPlan | null,
  applied: boolean,
  caps: Capabilities,
  rooted: string,
): string {
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
      ...(lock === null
        ? []
        : [
            entry(
              [
                words(
                  `${INSTALL_PATHS.lock}: ${lock.action} (package entry ${lock.entry.name}@${lock.entry.version}: ${lock.entry.kits.map((kit) => kit.id).join(', ')})`,
                ),
              ],
              { depth: 1, symbol: SYMBOL[lock.action] },
              caps,
            ),
          ]),
      entry([words(COMMITTABLE, 'dim')], { depth: 0 }, caps),
      ...(applied
        ? []
        : [
            entry(
              [
                words(
                  `Apply with "ia host ${plan.host} --commit${plan.remove ? ' --remove' : ''}${lock === null || plan.remove ? '' : ` --kits-package-version ${lock.entry.version}`} --apply --yes${rooted}".`,
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
  const pinned = args.value('kits-package-version');
  const again = `ia host ${name} --commit${rooted}`;
  let lock: LockPlan | null = null;
  if (!remove) {
    const current = existsSync(join(root, INSTALL_PATHS.lock)) ? readWorkspaceLock({ root }) : undefined;
    const recorded = current?.entries?.find((row) => row.name === DEFAULT_KITS_PACKAGE);
    // The version the lock already pins needs no registry; a new pin is what npm reports for it.
    const chosen =
      recorded !== undefined && (pinned === undefined || pinned === recorded.version)
        ? recorded
        : viewKitsPackage(npmView(host.env), { ...(pinned === undefined ? {} : { version: pinned }), again });
    lock = planLock(root, current, chosen, again);
  }
  let plan: BootstrapPlan;
  try {
    plan = planBootstrap(
      root,
      name as BootstrapHost,
      host.version,
      remove,
      lock === null ? null : { name: lock.entry.name, version: lock.entry.version },
    );
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
    stdout: json ? JSON.stringify(envelope(plan, lock, applied)) + '\n' : render(plan, lock, applied, caps, rooted),
    stderr: '',
  });
  if (!args.flag('apply')) return print(false);
  // A lock change makes a new installed generation, so registered projections are refreshed as an install's are, and
  // one that would refuse is refused before anything is written.
  const refresh = lock?.installation ? projectedHosts(root) : [];
  requireProjectionsClean(root, refresh, supplied !== undefined);
  if (!remove) {
    const session = openSession(root);
    try {
      sessionGate(context, 'effect')(session);
    } finally {
      session.close();
    }
  }
  if (
    !args.flag('yes') &&
    !(await confirm(host.interaction, render(plan, lock, false, caps, rooted), COMMIT_CONFIRMATION))
  )
    return {
      exitCode: 0,
      stdout: document([entry([words('Nothing was written.')], { depth: 0, symbol: 'info' }, caps)], {
        leadingBlank: true,
      }),
      stderr: '',
    };
  try {
    // The lock entry first: a bootstrap whose door starts the kits package is committed only beside the entry naming it.
    if (lock?.installation) applyInstallation(lock.installation);
    for (const registered of refresh) applyHostProjection(root, registered, renderProjectionFor(root, registered));
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

/**
 * The installation that writes `entry` into the lock, or none when the lock already holds it. A lock entry joins the
 * installed generation, so it goes through the installer like any lock change; a workspace whose installation needs
 * restoring is refused with the restore to run first.
 */
function planLock(root: string, current: DistributionLock | undefined, entry: PackageEntry, again: string): LockPlan {
  const next = lockWithPackage(current, entry);
  if (sameLock(current, next)) return { entry, action: 'unchanged', installation: null };
  try {
    return {
      entry,
      action: current === undefined ? 'create' : 'update',
      installation: planInstallation(root, next, current === undefined ? 'install' : 'update'),
    };
  } catch (error) {
    const refusal = refusalOf(error);
    throw new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      { path: INSTALL_PATHS.lock },
      `Restore the installation this lock records first: run "ia restore${again.includes(' --root ') ? again.slice(again.indexOf(' --root ')) : ''} --apply --yes".`,
    );
  }
}
