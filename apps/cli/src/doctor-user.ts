/**
 * docs/specs/host-plugin-distribution/README.md §7.3: the rows that exist with or without a workspace —
 * install channel (§5), IA home (§3), the Claude plugin (§6.3) and the initialization decision (§9). Read-only, like
 * the rest of doctor: nothing here creates the IA home or writes under it, and the plugin row reports what was
 * written to the IA home without asking Claude whether it registered it (doctor never runs `claude`).
 *
 * §11's `updates` row reads only the cache in the IA home; it never asks npm or git, and never refreshes. When a refresh
 * is due it returns the `ia-distribution refresh-updates` argument vector as a fact, and the session hook starts it
 * detached, so doctor stays read-only. §7.3's `compatibility` row is local: the workspace's
 * `.ia/release.json` language versions against the versions this ia's parser reads.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sameFile } from '@inventarch/db';
import type { Decision } from '@inventarch/distribution/decisions';
import { decisionFor, DECISIONS, readDecisions } from '@inventarch/distribution/decisions';
import { HOME_MARKER, resolveIaHome } from '@inventarch/distribution/ia-home';
import { inspectMaterializedPlugin, MARKETPLACE_DIR } from '@inventarch/distribution/plugin-home';
import type { UpdateCheck } from '@inventarch/distribution/updates';
import {
  compareVersions,
  compatibility,
  kitEntry,
  kitEntryFresh,
  kitUnitKeys,
  readIaConfig,
  readUpdateCheck,
  refreshDue,
  updateCheckDisabled,
} from '@inventarch/distribution/updates';
import { localDate } from './briefing.js';
import type { Channel } from './channel.js';
import { describeChannel, detectChannel, updateInstruction } from './channel.js';
import type { Check, CheckStatus, Section } from './doctor.js';
import { committed, HANDOFF_FROM, NO_HANDOFF } from './handoff.js';
import { findLocalCli, readCliDependency } from './local-cli.js';
import { readMarketplaceRecord } from './marketplace-record.js';
import type { PackageManager } from './package-manager.js';
import {
  detectPackageManager,
  installArgv,
  installCommand,
  pinArgv,
  pinCommand,
  satisfies,
} from './package-manager.js';
import type { Fix, Remedy } from './fix.js';
import { externalFix, iaFix } from './fix.js';

export interface UserFacts {
  readonly channel: Channel;
  /** The resolved IA home, or null when IA_HOME is malformed. */
  readonly home: string | null;
  /** The materialized plugin when it could be read. */
  readonly plugin: { readonly cli: string; readonly version: string } | null;
  readonly decision: Decision | null;
  /** §8.2: the channel is a checkout and the workspace is that checkout. */
  readonly frameworkSource: boolean;
  /** §11: what the cache says is newer, or null when checks are off or nothing usable is cached; `latest` is null unless newer. */
  readonly updates: { readonly latest: string | null; readonly behind: number | null } | null;
  /** The refresh argument vector when one is due, else null. Doctor never runs it. */
  readonly refresh: readonly string[] | null;
  /** The newest version the cache names for this copy's channel, whether or not it is newer than this copy. */
  readonly cachedLatest: string | null;
  /** The explicit "Check for updates now" argv, forced for a workspace, whatever the cache's age; null with `refreshNowWhy`. */
  readonly refreshNow: readonly string[] | null;
  readonly refreshNowWhy: string | null;
}
/**
 * §11: the `ia-distribution refresh-updates` argv for this IA home and install channel, with `--root` for a workspace and
 * `--force` when asked. Null only when the IA home is unresolved or unusable, or the mechanism cannot be found.
 */
export function refreshCommand(
  input: {
    readonly home: string | null;
    readonly unusable: boolean;
    readonly channel: Channel;
    readonly current: string;
    readonly root: string | undefined;
  },
  options: { readonly force: boolean },
): readonly string[] | null {
  if (input.home === null || input.unusable) return null;
  const bin = distributionBin();
  if (bin === null) return null;
  const { channel } = input;
  return [
    process.execPath,
    bin,
    'refresh-updates',
    '--home',
    input.home,
    '--channel',
    channel.kind,
    '--current',
    input.current,
    ...(channel.kind === 'npm' ? ['--name', channel.name] : []),
    ...(channel.kind === 'checkout' ? ['--checkout', channel.root] : []),
    ...(input.root === undefined ? [] : ['--root', input.root]),
    ...(options.force && input.root !== undefined ? ['--force'] : []),
  ];
}
/** A recorded time as the rows print it: `YYYY-MM-DD HH:MM UTC`, the same on every machine. */
export const utcMinute = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
/**
 * §7.3 `kits` and one `kit-update:<id>` row per unit behind. A unit is current when its key's entry is under a week
 * old and names a version no newer than the installed one; behind when it names a newer one; unknown when it has no
 * key (an unmapped registry, say), no entry, no version or an entry a week old. A known update outranks an unknown
 * unit, and a collection whose identity is unknown outranks both, with a reinstall as its fix.
 */
export function kitRows(kits: ReturnType<typeof kitUnitKeys> | null, stored: UpdateCheck | null, now: Date): Check[] {
  const kitsRow = (status: CheckStatus, detail: string, remedy: Remedy | null = null): Check =>
    row('kits', 'Environment', 'Kits', status, detail, remedy);
  if (kits === null) return [kitsRow('unknown', 'Not checked; the installed kits could not be read')];
  const problems = kits.problems.length === 0 ? '' : `; ${kits.problems.join('; ')}`;
  const unknownIds = kits.unknownCollections.map((collection) => collection.id);
  if (kits.units.length === 0 && unknownIds.length === 0)
    return [
      kits.problems.length > 0
        ? kitsRow('unknown', `Not checked; ${kits.problems.join('; ')}`)
        : kitsRow('info', 'no kits installed'),
    ];
  const read = kits.units.map(({ unit, key, why }) => {
    const entry = key === null ? undefined : kitEntry(stored, key);
    const age = entry === undefined ? Number.NaN : now.getTime() - Date.parse(entry.checkedAt);
    const latest = entry?.latest ?? null;
    const state =
      latest !== null && compareVersions(latest, unit.version) > 0
        ? 'behind'
        : entry === undefined || latest === null || !(age < WEEK)
          ? 'unknown'
          : 'current';
    return { unit, entry, latest, state, why };
  });
  const behind = read.filter((row) => row.state === 'behind'),
    unread = read.filter((row) => row.state === 'unknown');
  const times = read.flatMap((row) => (row.entry === undefined ? [] : [row.entry.checkedAt])).sort();
  const checked = times.length === 0 ? '' : ` · checked ${utcMinute(times[0]!)}`;
  const total = plural(read.length, 'kit');
  const reasons = unread.flatMap((row) => (row.why === null ? [] : [`${row.unit.id}: ${row.why}`]));
  const updates =
    behind.length === 0 ? '' : `${behind.length} of ${total} ${behind.length === 1 ? 'has an update' : 'have updates'}`;
  const updateRows = behind.map(({ unit, latest }) =>
    row(
      `kit-update:${unit.id}`,
      'Environment',
      'Kit update',
      'warn',
      `${unit.id} ${unit.version} → ${latest} (${unit.source.kind})`,
      unit.source.kind === 'package'
        ? iaFix(['install', '--package', `${unit.source.name}@${latest}`], 'repo')
        : unit.source.kind === 'collection'
          ? iaFix(['install', `${unit.id}@${latest}`], 'repo')
          : // The remedy keeps the `ia update <id>` form. A release's request keeps its range unless --to replaces
            // it, and a pin's range admits only itself, so the fix the console runs names the version.
            {
              remedy: iaFix(['update', unit.id], 'repo').remedy,
              fix: iaFix(['update', unit.id, '--to', latest!], 'repo').fix,
            },
    ),
  );
  let summary: Check;
  if (unknownIds.length > 0)
    summary = kitsRow(
      'warn',
      `collection identity unknown: ${unknownIds.join(', ')}${updates === '' ? '' : `; ${updates}`}${checked}${problems}`,
      iaFix(['install', ...unknownIds], 'repo'),
    );
  else if (behind.length > 0) summary = kitsRow('warn', `${updates}${checked}${problems}`);
  else if (unread.length > 0)
    summary = kitsRow(
      'unknown',
      `not checked: ${unread.length} of ${total}${times.length === 0 ? '' : ` (oldest check ${utcMinute(times[0]!)})`}${reasons.length === 0 ? '' : `; ${reasons.join('; ')}`}${problems}`,
    );
  else summary = kitsRow('ok', `${total}, all current${checked}${problems}`);
  return [summary, ...updateRows];
}
/**
 * §7.3 `marketplace`: which marketplace and plugin the IA home's record names, the ia that installed it and when the
 * marketplace was last consulted, as recorded; it repeats nothing the plugin row judges.
 */
export function marketplaceRow(home: string | null): Check {
  const marketplace = (status: CheckStatus, detail: string, remedy: Remedy | null = null): Check =>
    row('marketplace', 'Environment', 'Marketplace', status, detail, remedy);
  if (home === null) return marketplace('unknown', 'Not checked; the IA home could not be resolved');
  const recorded = readMarketplaceRecord(home);
  if (recorded.state === 'absent') return marketplace('info', 'no plugin installed from a marketplace', USER_APPLY);
  if (recorded.state === 'invalid')
    return marketplace(
      'warn',
      `The marketplace install record ${join(home, 'claude', 'marketplace-install.json')} cannot be read (${recorded.reason})`,
      USER_APPLY,
    );
  return marketplace(
    'ok',
    `${recorded.marketplace} · ${recorded.plugin} · installed by ia ${recorded.cli} · last checked${recorded.checkedAt === null ? ': not recorded' : ` ${utcMinute(recorded.checkedAt)}`}`,
  );
}
const realOrGiven = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
/** The installed units' cache keys, or null when they cannot be read; local configuration only, never thrown. */
function unitKeys(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  userHome: string,
): ReturnType<typeof kitUnitKeys> | null {
  try {
    return kitUnitKeys(root, { env, userHome });
  } catch {
    return null;
  }
}
/** A row whose remedy is advice text has no fix; one given as a `Remedy` carries its own. */
const row = (
  id: string,
  section: Section,
  title: string,
  status: CheckStatus,
  detail: string,
  remedy: string | Remedy | null = null,
): Check => ({
  id,
  section,
  title,
  status,
  detail,
  remedy: typeof remedy === 'object' && remedy !== null ? remedy.remedy : remedy,
  fix: typeof remedy === 'object' && remedy !== null ? remedy.fix : null,
});
/** The user-level plugin needs no workspace; it writes to the user's Claude configuration and the IA home. */
const USER_APPLY = iaFix(['host', 'claude', '--user', '--apply'], 'user');
const WEEK = 7 * 24 * 3600 * 1000;
/**
 * The installed mechanism binary: `@inventarch/distribution`'s own `bin` entry, read from its package.json. Resolving the
 * `./updates` export only locates the package, because the file it lands on depends on the active conditions: under a
 * `development` condition (vitest's config, or `node --conditions=development`) it is `src/updates.ts`, and a
 * sibling `cli.js` would name a `src/cli.js` that does not exist, whose detached spawn then fails silently. The `bin`
 * entry (`dist/cli.js`) is the same under every condition. Null when the package or its `bin` cannot be read, so a
 * missing mechanism costs the refresh, never the report.
 */
const distributionBin = (): string | null => {
  try {
    for (
      let directory = dirname(createRequire(import.meta.url).resolve('@inventarch/distribution/updates'));
      ;
      directory = dirname(directory)
    ) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const found = JSON.parse(readFileSync(manifest, 'utf8')) as {
          readonly name?: unknown;
          readonly bin?: Record<string, unknown>;
        };
        if (found.name === '@inventarch/distribution') {
          const bin = found.bin?.['ia-distribution'];
          return typeof bin === 'string' ? resolve(directory, bin) : null;
        }
      }
      if (dirname(directory) === directory) return null;
    }
  } catch {
    return null;
  }
};
/** §7.3: the language versions `.ia/release.json` records, or why none could be read. */
const workspaceLanguages = (root: string): { readonly languages: readonly string[] } | { readonly why: string } => {
  let text: string;
  try {
    text = readFileSync(resolve(root, '.ia/release.json'), 'utf8');
  } catch (error) {
    return {
      why:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '.ia/release.json is absent'
          : '.ia/release.json cannot be read',
    };
  }
  try {
    const languages = (JSON.parse(text) as { readonly language?: unknown }).language;
    return Array.isArray(languages) &&
      languages.length > 0 &&
      languages.every((value) => typeof value === 'string' && value !== '')
      ? { languages: languages as string[] }
      : { why: '.ia/release.json names no language version' };
  } catch {
    return { why: '.ia/release.json is not valid JSON' };
  }
};

/** The `version` of the `package.json` in `directory`, or null when it cannot be read. */
const versionAt = (directory: string): string | null => {
  try {
    const version = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown })
      .version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
};

/**
 * §7.3 `cli-version`: which `@inventarch/cli` copy runs for the workspace, the CLI dependency its nearest manifest
 * lists, and whether the installed copy satisfies it (consumer-cli-contract §1.2). Local reads only. The remedy is the
 * package manager's own command, and none when the manager is undeclared or its lockfiles disagree.
 */
export function cliVersionRow(input: {
  readonly root: string;
  readonly packageRoot: string;
  readonly version: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--host` was given: doctor answers itself and never hands off (dec-007). */
  readonly host: boolean;
  /** Whether git tracks the installed copy (handoff.ts); injected by tests. */
  readonly committed?: (packageRoot: string) => boolean;
}): Check {
  const { root, version, env } = input;
  const dependency = readCliDependency(root);
  const local = dependency === null ? null : findLocalCli(root, dirname(dependency.manifest));
  const managed = dependency === null ? root : dirname(dependency.manifest);
  const { manager, conflict } = detectPackageManager(managed);
  // The remedy keeps the text it has always had; the fix names the manifest's directory explicitly, since the console
  // runs it at the workspace root, which an ancestor manifest is not (host-plugin-distribution §7.3).
  const manage = (
    command: (manager: PackageManager) => string,
    argv: (manager: PackageManager) => readonly string[],
  ): { readonly remedy: string | null; readonly fix: Fix | null } =>
    manager === null
      ? { remedy: null, fix: null }
      : { remedy: command(manager), fix: externalFix(argv(manager), 'repo').fix };
  const install = manage(installCommand, (m) => installArgv(m, managed, root));
  const suffix =
    conflict.length > 0
      ? `; package managers disagree: ${conflict.join(', ')}`
      : manager === null
        ? '; no package manager declared or locked'
        : '';
  const cli = (
    status: CheckStatus,
    detail: string,
    action: { readonly remedy: string | null; readonly fix: Fix | null } = { remedy: null, fix: null },
  ): Check => ({
    ...row('cli-version', 'Environment', 'CLI version', status, detail + suffix, action.remedy),
    fix: action.fix,
  });
  if (dependency === null)
    return cli(
      'info',
      `no @inventarch/cli dependency; running ${version}`,
      manage(
        (m) => pinCommand(m, version, managed),
        (m) => pinArgv(m, version, managed, root),
      ),
    );
  if (local === null) {
    const path = relative(root, dependency.manifest);
    const shown = path === '' || path.startsWith('..') || isAbsolute(path) ? dependency.manifest : path;
    return cli(
      'warn',
      `${shown.replaceAll('\\', '/')} lists @inventarch/cli ${dependency.range}, which is not installed between the workspace and it; running ${version}`,
      install,
    );
  }
  const satisfied = satisfies(local.version, dependency.range);
  if (satisfied === false)
    return cli('warn', `installed ${local.version} does not satisfy ${dependency.range}`, install);
  if (!sameFile(local.packageRoot, input.packageRoot)) {
    const why =
      env[NO_HANDOFF] === '1'
        ? `${NO_HANDOFF} is set`
        : input.host
          ? 'doctor --host does not hand off'
          : (input.committed ?? committed)(local.packageRoot)
            ? 'the repository commits that copy, so it never runs on a typed command'
            : null;
    return why === null
      ? cli('warn', `running ${version}; this workspace's copy is ${local.version}`)
      : cli('info', `running ${version}, not this workspace's ${local.version} (${why})`);
  }
  const from = env[HANDOFF_FROM] ?? '';
  const global = from === '' ? null : versionAt(from);
  return cli(
    'ok',
    `this workspace's copy ${local.version}, CLI dependency ${dependency.range}` +
      (satisfied === null ? ' (range not evaluated)' : '') +
      (global === null ? '' : `; global ${global} handed off`),
  );
}

export function userRows(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory; the IA home is resolved from it when IA_HOME is unset. */
  readonly home: string;
  readonly packageRoot: string;
  readonly version: string;
  /** The directory a decision is keyed from (§7.2) when there is no workspace. */
  readonly directory: string;
  /** The `--root` doctor was given, so the decision's remedy names the same directory; undefined for the cwd. */
  readonly supplied: string | undefined;
  /** The workspace root, or undefined when there is no workspace. */
  readonly root: string | undefined;
  /** The workspace a supplied non-workspace directory lies inside; a decision is not recorded for such a directory. */
  readonly enclosing: string | undefined;
  readonly now: Date;
  /** The channel as observed; detected from `packageRoot` when not supplied. */
  readonly channel?: Channel | undefined;
  /** doctor's `--host` was given, so the `cli-version` row reports that no hand-off happened. */
  readonly host?: boolean | undefined;
  /** The channel of the copy that handed off; detected from `IA_HANDOFF_FROM` when not supplied. */
  readonly handingChannel?: Channel | undefined;
}): { readonly checks: readonly Check[]; readonly facts: UserFacts } {
  const checks: Check[] = [];
  // §5: the filesystem and local git only.
  const channel = input.channel ?? detectChannel(input.packageRoot);
  checks.push(
    row(
      'install-channel',
      'Environment',
      'Install channel',
      channel.kind === 'unknown' ? 'warn' : 'ok',
      describeChannel(channel),
    ),
  );
  if (input.root !== undefined)
    checks.push(
      cliVersionRow({
        root: input.root,
        packageRoot: input.packageRoot,
        version: input.version,
        env: input.env,
        host: input.host === true,
      }),
    );

  // §3: absent is a note, because the first `ia host` or `ia init --decline` creates it; src/ is the one failure.
  let home: string | null = null;
  try {
    const resolved = resolveIaHome(input.env, input.home);
    home = resolved.home;
    const marked = existsSync(join(home, HOME_MARKER)),
      src = existsSync(join(home, 'src'));
    checks.push(
      src
        ? row(
            'ia-home',
            'Environment',
            'IA home',
            'fail',
            `${home} contains src/; it must never look like a workspace`,
            `Move ${join(home, 'src')} out of the IA home`,
          )
        : resolved.source === 'IA_HOST_HOME'
          ? row(
              'ia-home',
              'Environment',
              'IA home',
              'warn',
              `${home}, set through IA_HOST_HOME, which is deprecated`,
              'Set IA_HOME instead of IA_HOST_HOME',
            )
          : row(
              'ia-home',
              'Environment',
              'IA home',
              marked ? 'ok' : 'info',
              marked ? home : `${home} (not created yet)`,
            ),
    );
  } catch (error) {
    checks.push(
      row(
        'ia-home',
        'Environment',
        'IA home',
        'fail',
        error instanceof Error ? error.message : String(error),
        'Set IA_HOME to an absolute directory, or unset it',
      ),
    );
  }

  // dec-007: the plugin and the update cache belong to the copy that renders the one and refreshes the other. Neither
  // `ia host claude --user` nor the session hook hands off, so after a hand-off that is the copy that handed off, and
  // both rows are judged against its version whenever its package.json reads. The update cache is also keyed by that
  // copy's channel, so the version and the channel always come from the same copy.
  const from = input.env[HANDOFF_FROM] ?? '';
  const handing = from === '' ? null : versionAt(from);
  const userVersion = handing ?? input.version;
  const updateChannel = handing === null ? channel : (input.handingChannel ?? detectChannel(from));

  // §6.3 and §7.3 `plugin-<host>`: what the IA home holds. Registration with Claude is Claude's state, never read.
  let plugin: UserFacts['plugin'] = null;
  if (home === null)
    checks.push(
      row('plugin-claude', 'Environment', 'Claude plugin', 'unknown', 'Not checked; the IA home could not be resolved'),
    );
  else {
    const directory = join(home, MARKETPLACE_DIR),
      materialized = inspectMaterializedPlugin(home);
    const recorded = materialized.state === 'absent' ? readMarketplaceRecord(home) : { state: 'absent' as const };
    if (materialized.state === 'absent' && recorded.state === 'present') {
      // A marketplace install: Claude holds the plugin, and the IA home's record says which and by which ia.
      plugin = { cli: recorded.cli, version: `${recorded.plugin} from ${recorded.marketplace}` };
      checks.push(
        recorded.cli === userVersion
          ? row(
              'plugin-claude',
              'Environment',
              'Claude plugin',
              'ok',
              `${recorded.plugin}, installed from ${recorded.marketplace}; registration with Claude is not checked`,
            )
          : row(
              'plugin-claude',
              'Environment',
              'Claude plugin',
              'warn',
              `${recorded.plugin} was installed from ${recorded.marketplace} by ia ${recorded.cli}; this is ia ${userVersion}`,
              USER_APPLY,
            ),
      );
    } else if (materialized.state === 'absent' && recorded.state === 'invalid')
      checks.push(
        row(
          'plugin-claude',
          'Environment',
          'Claude plugin',
          'warn',
          `The marketplace install record ${join(home, 'claude', 'marketplace-install.json')} cannot be read (${recorded.reason})`,
          USER_APPLY,
        ),
      );
    else if (materialized.state === 'absent')
      checks.push(row('plugin-claude', 'Environment', 'Claude plugin', 'info', 'Not installed', USER_APPLY));
    else if (materialized.state === 'invalid')
      checks.push(
        row(
          'plugin-claude',
          'Environment',
          'Claude plugin',
          'warn',
          `The plugin under ${directory} cannot be read (${materialized.reason})`,
          USER_APPLY,
        ),
      );
    else {
      plugin = { cli: materialized.cli, version: materialized.version };
      checks.push(
        materialized.cli === userVersion
          ? row(
              'plugin-claude',
              'Environment',
              'Claude plugin',
              'ok',
              `${materialized.version}, written to ${directory}; registration with Claude is not checked`,
            )
          : row(
              'plugin-claude',
              'Environment',
              'Claude plugin',
              'warn',
              `${materialized.version} was rendered by ia ${materialized.cli}; this is ia ${userVersion}`,
              USER_APPLY,
            ),
      );
    }
  }

  // §11: the cache only. A cache written for another channel or another ia version is not about this one, so it counts
  // as none and a refresh is due. Newer means newer: a cached `latest` at or below this version is not an update.
  const disabled = updateCheckDisabled(input.env, home === null ? null : readIaConfig(home));
  const stored = home === null ? null : readUpdateCheck(home);
  const cached: UpdateCheck | null =
    stored !== null && stored.cli.channel === updateChannel.kind && stored.cli.current === userVersion ? stored : null;
  const latest = cached?.cli.latest ?? null,
    newer = latest !== null && compareVersions(latest, userVersion) > 0 ? latest : null,
    behind = cached?.cli.behind ?? null,
    checkedOn = cached === null ? '' : localDate(cached.checkedAt);
  const updatesRow = (status: CheckStatus, detail: string, remedy: string | null = null): Check =>
    row('updates', 'Environment', 'Updates', status, detail, remedy);
  if (disabled)
    checks.push(
      updatesRow(
        'info',
        'Update checks are turned off (IA_NO_UPDATE_CHECK, CI, or updateCheck in the IA home config.json)',
      ),
    );
  else if (home === null) checks.push(updatesRow('unknown', 'Not checked; the IA home could not be resolved'));
  else if (cached === null) checks.push(updatesRow('unknown', 'Not checked yet; a check runs in the background'));
  else if (newer !== null)
    checks.push(
      updatesRow(
        'warn',
        `ia ${newer} is available; this is ${userVersion} (checked ${checkedOn})`,
        updateInstruction(updateChannel),
      ),
    );
  else if ((behind ?? 0) > 0)
    checks.push(
      updatesRow(
        'warn',
        `${behind} commits behind upstream as of the last fetch (checked ${checkedOn})`,
        updateInstruction(updateChannel),
      ),
    );
  // §11: a check older than a week means the background refresh keeps failing to finish.
  else if (!(input.now.getTime() - Date.parse(cached.checkedAt) < WEEK))
    checks.push(updatesRow('warn', `Last checked ${checkedOn}; no background check has completed since`));
  else if (cached.cli.checked) checks.push(updatesRow('ok', `Up to date as of ${checkedOn}`));
  else
    checks.push(
      updatesRow(
        'unknown',
        updateChannel.kind === 'unknown'
          ? 'Not checked; an unknown install has no update source'
          : `Not checked; the last check (${checkedOn}) could not reach its source`,
      ),
    );
  // §11: the private layer's notices, shown through the same section; read here, never fetched.
  if (!disabled)
    for (const notice of stored?.account?.notices ?? [])
      checks.push(row('updates-account', 'Environment', 'Account', 'info', notice));
  // A home holding src/ fails the ia-home row, and refresh-updates would refuse to write it, so nothing is started.
  const unusable = home !== null && existsSync(join(home, 'src'));
  // The workspace at its real path, as the mechanism opens it: a root reached through a link reads the same.
  const realRoot = input.root === undefined ? undefined : realOrGiven(input.root);
  const command = (force: boolean): readonly string[] | null =>
    refreshCommand({ home, unusable, channel: updateChannel, current: userVersion, root: realRoot }, { force });
  // §11: due when the global stamp is a day old, or when an installed unit's own entry is missing or a day old.
  const kits = realRoot === undefined ? null : unitKeys(realRoot, input.env, input.home);
  const kitsDue =
    kits !== null &&
    kits.units.some((unit) => unit.key !== null && !kitEntryFresh(kitEntry(stored, unit.key), input.now));
  const refresh = disabled || !(refreshDue(cached, input.now) || kitsDue) ? null : command(false);
  // "Check for updates now": an explicit request outranks `updateCheck: false` and the day's freshness, but not the
  // offline signal, and it refetches every installed unit.
  const refreshNowWhy =
    input.env['IA_NO_UPDATE_CHECK'] === '1'
      ? 'IA_NO_UPDATE_CHECK=1 is set'
      : home === null
        ? 'the IA home could not be resolved'
        : unusable
          ? `${join(home, 'src')} makes the IA home unusable`
          : null;
  const refreshNow = refreshNowWhy === null ? command(input.root !== undefined) : null;

  // §7.3: the installed kits against the per-registry cache, and the marketplace the plugin came from; local reads only.
  if (input.root !== undefined) {
    checks.push(...kitRows(kits, stored, input.now));
    checks.push(marketplaceRow(home));
  }

  // §7.3: only for a workspace this report describes.
  if (input.root !== undefined) {
    const found = workspaceLanguages(input.root);
    if ('why' in found)
      checks.push(row('compatibility', 'Workspace', 'Compatibility', 'unknown', `Not checked; ${found.why}`));
    else {
      const result = compatibility(found.languages);
      checks.push(
        row(
          'compatibility',
          'Workspace',
          'Compatibility',
          result.status,
          result.detail,
          result.status === 'fail' ? updateInstruction(channel) : null,
        ),
      );
    }
  }

  // §7.3 and §9: only where no workspace was found; an unreadable file reads as empty and is a warning naming it.
  let decision: Decision | null = null;
  if (input.root === undefined && input.enclosing === undefined && home !== null) {
    const file = readDecisions(home),
      path = join(home, DECISIONS);
    decision = file.invalid ? null : decisionFor(home, input.directory, input.now);
    checks.push(
      file.invalid
        ? row(
            'workspace-decision',
            'Workspace',
            'Initialization decision',
            'warn',
            `${path} cannot be read (${file.reason ?? 'unknown'})`,
            `Fix or delete ${path}`,
          )
        : row(
            'workspace-decision',
            'Workspace',
            'Initialization decision',
            'info',
            decision === null
              ? 'None recorded'
              : decision.decision === 'declined-forever'
                ? `Declined permanently on ${localDate(decision.at)}`
                : 'Declined for today',
            // Forgetting a decline writes only the IA home, never the repository.
            decision === null
              ? null
              : iaFix(['init', ...(input.supplied === undefined ? [] : [input.supplied]), '--forget-decline'], 'user'),
          ),
    );
  }
  // The same directory on disk, however either path is spelled.
  const frameworkSource = channel.kind === 'checkout' && input.root !== undefined && sameFile(input.root, channel.root);
  const updates = disabled || cached === null ? null : { latest: newer, behind };
  return {
    checks,
    facts: {
      channel,
      home,
      plugin,
      decision,
      frameworkSource,
      updates,
      cachedLatest: cached?.cli.latest ?? null,
      refresh,
      refreshNow,
      refreshNowWhy: refreshNow === null ? (refreshNowWhy ?? 'the update mechanism could not be found') : null,
    },
  };
}
