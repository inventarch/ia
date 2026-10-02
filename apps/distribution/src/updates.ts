import { spawnSync } from 'node:child_process';
import { SUPPORTED_VERSIONS } from '@ia/language';
import { readHomeFile, writeHomeFile } from './ia-home.js';

/** Host plugin distribution spec §11 and Amendment item 4. Public layer only: `account` is written by the private layer and kept as found; `nudgedOn` lives in the hook's plugin data, never here. */
export const UPDATE_CHECK = 'state/update-check.json';
export const IA_CONFIG = 'config.json';
export type UpdateChannel = 'checkout' | 'npm' | 'unknown';
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['checkout', 'npm', 'unknown'];
export interface UpdateCheck {
  readonly schema: 'ia.update-check.v1';
  readonly checkedAt: string;
  readonly cli: {
    readonly channel: string;
    readonly current: string;
    readonly latest: string | null;
    readonly behind: number | null;
    readonly checked: boolean;
  };
  readonly packages: { readonly checked: false };
  readonly account?: { readonly notices?: readonly string[] };
}
const DAY = 24 * 3600 * 1000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** The cached check, or null when it is absent, unreadable or not this schema. Never throws and never writes. */
export function readUpdateCheck(home: string): UpdateCheck | null {
  try {
    const text = readHomeFile(home, UPDATE_CHECK),
      value: unknown = text === null ? null : JSON.parse(text);
    if (
      !record(value) ||
      value['schema'] !== 'ia.update-check.v1' ||
      typeof value['checkedAt'] !== 'string' ||
      Number.isNaN(Date.parse(value['checkedAt'])) ||
      !record(value['cli'])
    )
      return null;
    const cli = value['cli'],
      account = record(value['account']) ? value['account'] : undefined,
      notices =
        account !== undefined && Array.isArray(account['notices'])
          ? account['notices'].filter((n): n is string => typeof n === 'string')
          : undefined;
    if (typeof cli['channel'] !== 'string' || typeof cli['current'] !== 'string' || typeof cli['checked'] !== 'boolean')
      return null;
    return {
      schema: 'ia.update-check.v1',
      checkedAt: value['checkedAt'],
      cli: {
        channel: cli['channel'],
        current: cli['current'],
        latest: typeof cli['latest'] === 'string' ? cli['latest'] : null,
        behind:
          typeof cli['behind'] === 'number' && Number.isInteger(cli['behind']) && cli['behind'] >= 0
            ? cli['behind']
            : null,
        checked: cli['checked'],
      },
      packages: { checked: false },
      ...(account === undefined ? {} : { account: notices === undefined ? {} : { notices } }),
    };
  } catch {
    return null;
  }
}
/** `~/.ia/config.json`, or null when it is absent or unreadable. Never throws and never writes. */
export function readIaConfig(home: string): { readonly updateCheck?: boolean } | null {
  try {
    const text = readHomeFile(home, IA_CONFIG),
      value: unknown = text === null ? null : JSON.parse(text);
    return record(value)
      ? typeof value['updateCheck'] === 'boolean'
        ? { updateCheck: value['updateCheck'] }
        : {}
      : null;
  } catch {
    return null;
  }
}
/** §11.1: at most once per 24 h. A timestamp that does not parse, or lies in the future, is due. */
export const refreshDue = (check: Pick<UpdateCheck, 'checkedAt'> | null, now: Date): boolean => {
  if (check === null) return true;
  const age = now.getTime() - Date.parse(check.checkedAt);
  return !(age >= 0 && age < DAY);
};
/** §11.1: `IA_NO_UPDATE_CHECK=1`, a non-empty `CI`, or `updateCheck: false` in the IA home's config.json. */
export const updateCheckDisabled = (
  env: Readonly<Record<string, string | undefined>>,
  config: { readonly updateCheck?: boolean } | null,
): boolean => env['IA_NO_UPDATE_CHECK'] === '1' || (env['CI'] ?? '') !== '' || config?.updateCheck === false;
export interface Sources {
  readonly npm: (name: string) => string | null;
  readonly git: (cwd: string, args: readonly string[]) => string | null;
}
/** npm's package-name grammar; the name reaches a shell on Windows, so anything else is never looked up. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const liveSources: Sources = {
  // One command string with `shell: true`: npm is npm.cmd on Windows, and an argument array beside a shell is DEP0190.
  npm: (name) => {
    if (!NPM_NAME.test(name)) return null;
    const r = spawnSync(`npm view ${name} dist-tags.latest --json`, {
      shell: true,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    try {
      const v: unknown = r.status === 0 ? JSON.parse(r.stdout) : null;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  },
  git: (cwd, args) => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 0 ? r.stdout.trim() : null;
  },
};
export interface RefreshInput {
  readonly home: string;
  readonly channel: UpdateChannel;
  readonly current: string;
  readonly name: string | null;
  readonly checkout: string | null;
  readonly now: Date;
}
/** §11.1: one refresh. npm is asked only for the npm channel; a checkout is counted against its upstream as of the last fetch, and nothing fetches. An unavailable source is `checked: false`, never "up to date". Packages wait for the registry. */
export function refreshUpdates(input: RefreshInput, sources: Sources = liveSources): UpdateCheck {
  let latest: string | null = null,
    behind: number | null = null;
  if (input.channel === 'npm' && input.name !== null) latest = sources.npm(input.name);
  if (input.channel === 'checkout' && input.checkout !== null) {
    const count = sources.git(input.checkout, ['rev-list', '--count', 'HEAD..@{upstream}']);
    behind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  }
  const previous = readUpdateCheck(input.home);
  const check: UpdateCheck = {
    schema: 'ia.update-check.v1',
    checkedAt: input.now.toISOString(),
    cli: {
      channel: input.channel,
      current: input.current,
      latest,
      behind,
      checked: latest !== null || behind !== null,
    },
    packages: { checked: false },
    ...(previous?.account === undefined ? {} : { account: previous.account }),
  };
  writeHomeFile(input.home, UPDATE_CHECK, JSON.stringify(check, null, 2) + '\n');
  return check;
}
const NUMERIC = /^\d+$/;
const split = (v: string): { readonly core: number[]; readonly pre: string[] | null } => {
  const bare = v.split('+')[0]!,
    dash = bare.indexOf('-'),
    core = dash < 0 ? bare : bare.slice(0, dash);
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: dash < 0 ? null : bare.slice(dash + 1).split('.'),
  };
};
const comparePart = (a: string, b: string): number =>
  NUMERIC.test(a) && NUMERIC.test(b)
    ? Number(a) - Number(b)
    : NUMERIC.test(a)
      ? -1
      : NUMERIC.test(b)
        ? 1
        : a < b
          ? -1
          : a > b
            ? 1
            : 0;
/** Semver order: `+build` is ignored; dotted core parts compare numerically (a non-number counts as 0); a prerelease ranks below its release; two prereleases compare their dot parts, numbers numerically and below words, words lexically. */
export const compareVersions = (a: string, b: string): number => {
  const x = split(a),
    y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++)
    if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = comparePart(p, q);
    if (c !== 0) return c;
  }
  return 0;
};
/** §11.2: local only. A workspace language newer than anything this ia reads fails; an older one it no longer reads warns. */
export function compatibility(
  workspace: readonly string[],
  supported: readonly string[] = SUPPORTED_VERSIONS,
): { readonly status: 'ok' | 'warn' | 'fail'; readonly detail: string } {
  const detail = `Workspace language ${workspace.join(', ')}; this ia reads ${supported.join(', ')}`;
  const missing = workspace.filter((v) => !supported.includes(v));
  if (missing.length === 0) return { status: 'ok', detail };
  const newest = supported.slice().sort(compareVersions).at(-1) ?? '0',
    newer = missing.filter((v) => compareVersions(v, newest) > 0);
  return newer.length > 0
    ? { status: 'fail', detail: `${detail}; ${newer.join(', ')} is newer than this ia can read` }
    : { status: 'warn', detail: `${detail}; ${missing.join(', ')} is no longer read by this ia` };
}
