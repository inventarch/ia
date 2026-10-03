/**
 * docs/specs/host-plugin-distribution/README.md §7.3: the rows that exist with or without a workspace —
 * install channel (§5), IA home (§3), the Claude plugin (§6.3) and the initialization decision (§9). Read-only, like
 * the rest of doctor: nothing here creates the IA home or writes under it, and the plugin row reports what was
 * written to the IA home without asking Claude whether it registered it (doctor never runs `claude`).
 *
 * §11's `updates` row reads only the cache in the IA home; it never asks npm or git, and never refreshes. When a refresh
 * is due it returns the `ia-distribution refresh-updates` argument vector as a fact, and the session hook starts it
 * detached (Amendment item 4), so doctor stays read-only. §11.2's `compatibility` row is local: the workspace's
 * `.ia/release.json` language versions against the versions this ia's parser reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { sameFile } from '@inventarch/db';
import type { Decision } from '@inventarch/distribution/decisions';
import { decisionFor, DECISIONS, readDecisions } from '@inventarch/distribution/decisions';
import { HOME_MARKER, resolveIaHome } from '@inventarch/distribution/ia-home';
import { inspectMaterializedPlugin, MARKETPLACE_DIR } from '@inventarch/distribution/plugin-home';
import type { UpdateCheck } from '@inventarch/distribution/updates';
import {
  compareVersions,
  compatibility,
  readIaConfig,
  readUpdateCheck,
  refreshDue,
  updateCheckDisabled,
} from '@inventarch/distribution/updates';
import { localDate } from './briefing.js';
import type { Channel } from './channel.js';
import { describeChannel, detectChannel, updateInstruction } from './channel.js';
import type { Check, CheckStatus, Section } from './doctor.js';
import { quote } from './render.js';

export interface UserFacts {
  readonly channel: Channel;
  /** The resolved IA home, or null when IA_HOME is malformed. */
  readonly home: string | null;
  /** The materialized plugin when it could be read. */
  readonly plugin: { readonly cli: string; readonly version: string } | null;
  readonly decision: Decision | null;
  /** §8.2: the channel is a checkout and the workspace is that checkout. */
  readonly frameworkSource: boolean;
  /** §11.1: what the cache says is newer, or null when checks are off or nothing usable is cached; `latest` is null unless newer. */
  readonly updates: { readonly latest: string | null; readonly behind: number | null } | null;
  /** Amendment item 4: the refresh argument vector when one is due, else null. Doctor never runs it. */
  readonly refresh: readonly string[] | null;
}
const row = (
  id: string,
  section: Section,
  title: string,
  status: CheckStatus,
  detail: string,
  remedy: string | null = null,
): Check => ({ id, section, title, status, detail, remedy });
const USER_APPLY = 'ia host claude --user --apply';
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
/** §11.2: the language versions `.ia/release.json` records, or why none could be read. */
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

export function userRows(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory; the IA home is resolved from it when IA_HOME is unset. */
  readonly home: string;
  readonly packageRoot: string;
  readonly version: string;
  /** The directory a decision is keyed from (§9.1) when there is no workspace. */
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

  // §6.3 and §7.3 `plugin-<host>`: what the IA home holds. Registration with Claude is Claude's state, never read.
  let plugin: UserFacts['plugin'] = null;
  if (home === null)
    checks.push(
      row('plugin-claude', 'Environment', 'Claude plugin', 'unknown', 'Not checked; the IA home could not be resolved'),
    );
  else {
    const directory = join(home, MARKETPLACE_DIR),
      materialized = inspectMaterializedPlugin(home);
    if (materialized.state === 'absent')
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
        materialized.cli === input.version
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
              `${materialized.version} was rendered by ia ${materialized.cli}; this is ia ${input.version}`,
              USER_APPLY,
            ),
      );
    }
  }

  // §11.1: the cache only. A cache written for another channel or another ia version is not about this one, so it counts
  // as none and a refresh is due. Newer means newer: a cached `latest` at or below this version is not an update.
  const disabled = updateCheckDisabled(input.env, home === null ? null : readIaConfig(home));
  const stored = home === null ? null : readUpdateCheck(home);
  const cached: UpdateCheck | null =
    stored !== null && stored.cli.channel === channel.kind && stored.cli.current === input.version ? stored : null;
  const latest = cached?.cli.latest ?? null,
    newer = latest !== null && compareVersions(latest, input.version) > 0 ? latest : null,
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
        `ia ${newer} is available; this is ${input.version} (checked ${checkedOn})`,
        updateInstruction(channel),
      ),
    );
  else if ((behind ?? 0) > 0)
    checks.push(
      updatesRow(
        'warn',
        `${behind} commits behind upstream as of the last fetch (checked ${checkedOn})`,
        updateInstruction(channel),
      ),
    );
  // §7.3: a check older than a week means the background refresh keeps failing to finish.
  else if (!(input.now.getTime() - Date.parse(cached.checkedAt) < WEEK))
    checks.push(updatesRow('warn', `Last checked ${checkedOn}; no background check has completed since`));
  else if (cached.cli.checked) checks.push(updatesRow('ok', `Up to date as of ${checkedOn}`));
  else
    checks.push(
      updatesRow(
        'unknown',
        channel.kind === 'unknown'
          ? 'Not checked; an unknown install has no update source'
          : `Not checked; the last check (${checkedOn}) could not reach its source`,
      ),
    );
  // §11.3: the private layer's notices, shown through the same section; read here, never fetched.
  if (!disabled)
    for (const notice of stored?.account?.notices ?? [])
      checks.push(row('updates-account', 'Environment', 'Account', 'info', notice));
  // A home holding src/ fails the ia-home row, and refresh-updates would refuse to write it, so nothing is started.
  const unusable = home !== null && existsSync(join(home, 'src'));
  const bin = disabled || home === null || unusable || !refreshDue(cached, input.now) ? null : distributionBin();
  const refresh =
    bin === null || home === null
      ? null
      : [
          process.execPath,
          bin,
          'refresh-updates',
          '--home',
          home,
          '--channel',
          channel.kind,
          '--current',
          input.version,
          ...(channel.kind === 'npm' ? ['--name', channel.name] : []),
          ...(channel.kind === 'checkout' ? ['--checkout', channel.root] : []),
        ];

  // §11.2: only for a workspace this report describes.
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

  // §9.2: only where no workspace was found; an unreadable file reads as empty and is a warning naming it.
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
            decision === null
              ? null
              : `ia init ${input.supplied === undefined ? '' : `${quote(input.supplied)} `}--forget-decline`,
          ),
    );
  }
  // The same directory on disk, however either path is spelled (#315).
  const frameworkSource = channel.kind === 'checkout' && input.root !== undefined && sameFile(input.root, channel.root);
  const updates = disabled || cached === null ? null : { latest: newer, behind };
  return { checks, facts: { channel, home, plugin, decision, frameworkSource, updates, refresh } };
}
