import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { SUPPORTED_VERSIONS } from '@inventarch/language';
import { withHomeLock } from './home-lock.js';
import { readHomeFile, writeHomeFile } from './ia-home.js';
import { fail } from './files.js';
import { installedUnits } from './kit-inventory.js';
import type { InstalledUnit, InstalledUnits } from './kit-inventory.js';
import { registryChooser } from './registry-config.js';
import { openRegistry, parseRegistryBase, registryBudget, registryLocation } from './registry-source.js';
import { findProgram, programEnv, programHome, windowsShell, windowsShellArgs } from './program.js';

/** Host plugin distribution spec §11. Public layer only: `account` is written by the private layer and kept as found; `nudgedOn` lives in the hook's plugin data, never here. */
export const UPDATE_CHECK = 'state/update-check.json';
/** The store lock every write of the cache holds (home-lock.ts), so two refreshes never drop each other's entries. */
export const UPDATE_CHECK_LOCK = 'state/update-check.json.lock';
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
  /**
   * The installed units' newest versions, one entry per `(registry, kind, id)` key, each with the time it was fetched.
   * An older reader keeps only `checked: false` and ignores the rest.
   */
  readonly packages: { readonly checked: boolean; readonly entries?: readonly KitUpdateEntry[] };
  readonly account?: { readonly notices?: readonly string[] };
}
export interface KitUpdateEntry {
  readonly registry: string;
  readonly kind: 'package' | 'collection' | 'release';
  readonly id: string;
  /** The newest non-withdrawn version, or null when its source could not answer. */
  readonly latest: string | null;
  readonly checkedAt: string;
}
const KINDS: readonly KitUpdateEntry['kind'][] = ['package', 'collection', 'release'];
/** One cache entry, or null when it cannot be read; such an entry is dropped. */
function kitUpdateEntry(value: unknown): KitUpdateEntry | null {
  if (!record(value)) return null;
  const { registry, kind, id, latest, checkedAt } = value;
  if (
    typeof registry !== 'string' ||
    !KINDS.includes(kind as KitUpdateEntry['kind']) ||
    typeof id !== 'string' ||
    (latest !== null && typeof latest !== 'string') ||
    typeof checkedAt !== 'string' ||
    Number.isNaN(Date.parse(checkedAt))
  )
    return null;
  return { registry, kind: kind as KitUpdateEntry['kind'], id, latest: latest as string | null, checkedAt };
}
const DAY = 24 * 3600 * 1000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** `packages` in its older `{checked: false}` form or with entries; an entry that cannot be read is dropped. */
function packagesOf(value: unknown): UpdateCheck['packages'] {
  if (!record(value) || !Array.isArray(value['entries'])) return { checked: false };
  const entries = value['entries'].map(kitUpdateEntry).filter((entry): entry is KitUpdateEntry => entry !== null);
  return entries.length === 0 ? { checked: false } : { checked: value['checked'] === true, entries };
}
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
      packages: packagesOf(value['packages']),
      ...(account === undefined ? {} : { account: notices === undefined ? {} : { notices } }),
    };
  } catch {
    return null;
  }
}
/**
 * `~/.ia/config.json`, or null when it is absent or unreadable. Never throws and never writes. Its booleans:
 * `updateCheck` (default true) and `accountOffer` (default true; false suppresses the `ia` plugin's once-per-session
 * account offer for this IA home).
 */
export function readIaConfig(home: string): { readonly updateCheck?: boolean; readonly accountOffer?: boolean } | null {
  try {
    const text = readHomeFile(home, IA_CONFIG),
      value: unknown = text === null ? null : JSON.parse(text);
    return record(value)
      ? {
          ...(typeof value['updateCheck'] === 'boolean' ? { updateCheck: value['updateCheck'] } : {}),
          ...(typeof value['accountOffer'] === 'boolean' ? { accountOffer: value['accountOffer'] } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
/** The account offer is on unless the IA home's config.json sets `accountOffer` to false. */
export const accountOfferEnabled = (config: { readonly accountOffer?: boolean } | null): boolean =>
  config?.accountOffer !== false;
/** §11: at most once per 24 h. A timestamp that does not parse, or lies in the future, is due. */
export const refreshDue = (check: Pick<UpdateCheck, 'checkedAt'> | null, now: Date): boolean => {
  if (check === null) return true;
  const age = now.getTime() - Date.parse(check.checkedAt);
  return !(age >= 0 && age < DAY);
};
/** §11: `IA_NO_UPDATE_CHECK=1`, a non-empty `CI`, or `updateCheck: false` in the IA home's config.json. */
export const updateCheckDisabled = (
  env: Readonly<Record<string, string | undefined>>,
  config: { readonly updateCheck?: boolean } | null,
): boolean => env['IA_NO_UPDATE_CHECK'] === '1' || (env['CI'] ?? '') !== '' || config?.updateCheck === false;
export interface Sources {
  readonly npm: (name: string) => string | null;
  readonly git: (cwd: string, args: readonly string[]) => string | null;
  /** A unit's newest version: npm for a package, the registry's kit or release index otherwise (`liveKitSource`). */
  readonly kit?: (unit: KitUnitKey) => Promise<string | null>;
}
/** npm's package-name grammar; the name reaches cmd.exe on Windows, so anything else is never looked up. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/**
 * npm and git are found on qualified PATH entries only and run by absolute path from the home directory, with
 * only those entries in their PATH (src/program.ts), so a refresh run by hand from a repository cannot start a program
 * planted there. npm is npm.cmd on Windows, run through cmd.exe named by its path; the name has passed NPM_NAME, so it
 * holds no character cmd.exe would read.
 */
const run = (name: string, args: readonly string[], timeout: number): SpawnSyncReturns<string> | null => {
  const options = {
    cwd: programHome(),
    env: programEnv(process.env),
    encoding: 'utf8' as const,
    timeout,
    windowsHide: true,
  };
  const program = findProgram(name, process.env);
  if (program !== null) return spawnSync(program, args, options);
  const script = findProgram(name, process.env, 'script');
  return script === null
    ? null
    : spawnSync(windowsShell(process.env), windowsShellArgs(script, args), {
        ...options,
        windowsVerbatimArguments: true,
      });
};
export const liveSources: Sources = {
  npm: (name) => {
    if (!NPM_NAME.test(name)) return null;
    const r = run('npm', ['view', name, 'dist-tags.latest', '--json'], 15000);
    try {
      const v: unknown = r !== null && r.status === 0 ? JSON.parse(r.stdout) : null;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  },
  // git is looked up as a program only (git.com or git.exe on Windows), never as a script through cmd.exe: its
  // arguments carry the --checkout path, which nothing screens for cmd.exe.
  git: (cwd, args) => {
    const git = findProgram('git', process.env);
    if (git === null) return null;
    const r = spawnSync(git, ['--no-optional-locks', '-C', cwd, ...args], {
      cwd: programHome(),
      env: programEnv(process.env),
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
  /** The workspace whose installed units (`installedUnits`) are looked up; without it no kit entry changes. */
  readonly root?: string | undefined;
  /** Look up every unit of `root`, however fresh its entry; needs `root`. */
  readonly force?: boolean | undefined;
  /** The environment registry selection reads (`registryChooser`); the process's by default. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The user's home directory, for the per-user registry file. */
  readonly userHome?: string | undefined;
  /** How long to wait for the store lock; `HOME_LOCK_WAIT_MS` by default. */
  readonly lockWaitMs?: number | undefined;
  /** Runs after the lookups and before the store lock is taken; tests interleave another refresh here. */
  readonly afterFetch?: (() => void | Promise<void>) | undefined;
}
/** A unit's cache key: `registry` is `npm` for a package, else the location of the registry chosen for its id. */
export interface KitUnitKey {
  readonly registry: string;
  readonly kind: KitUpdateEntry['kind'];
  readonly id: string;
}
const sameKey = (a: KitUnitKey, b: KitUnitKey): boolean =>
  a.registry === b.registry && a.kind === b.kind && a.id === b.id;
/** §11: the cached entry for `key`, or undefined. */
export const kitEntry = (check: UpdateCheck | null, key: KitUnitKey): KitUpdateEntry | undefined =>
  check?.packages.entries?.find((entry) => sameKey(entry, key));
/** An entry fetched within the last 24 hours; any other is due. */
export const kitEntryFresh = (entry: KitUpdateEntry | undefined, now: Date): boolean => {
  if (entry === undefined) return false;
  const age = now.getTime() - Date.parse(entry.checkedAt);
  return age >= 0 && age < DAY;
};
/**
 * Each installed unit of `root` with its cache key, or the reason none can be named (an unmapped provider, say). Local
 * configuration only: the chooser reads the workspace, environment and user registry files, never a registry.
 */
export function kitUnitKeys(
  root: string,
  options: { readonly env: Readonly<Record<string, string | undefined>>; readonly userHome?: string | undefined },
): {
  readonly units: readonly {
    readonly unit: InstalledUnit;
    readonly key: KitUnitKey | null;
    readonly why: string | null;
  }[];
  readonly unknownCollections: InstalledUnits['unknownCollections'];
  readonly problems: readonly string[];
} {
  const installed = installedUnits(root);
  const choose = registryChooser({
    root,
    env: options.env,
    cwd: root,
    ...(options.userHome === undefined ? {} : { home: options.userHome }),
  });
  return {
    units: installed.units.map((unit) => {
      if (unit.source.kind === 'package')
        return { unit, key: { registry: 'npm', kind: 'package', id: unit.id }, why: null };
      try {
        const registry = registryLocation(choose(unit.id).base);
        return { unit, key: { registry, kind: unit.source.kind, id: unit.id }, why: null };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { unit, key: null, why: typeof code === 'string' ? code : String(error) };
      }
    }),
    unknownCollections: installed.unknownCollections,
    problems: installed.problems,
  };
}
const LOOKUP_TIMEOUT_MS = 15_000,
  MAX_LOOKUPS = 20,
  ENTRY_TTL = 30 * DAY;
/** The newest non-withdrawn version, by explicit comparison: an index's order is never relied on. */
export const newestVersion = (
  releases: readonly { readonly version: string; readonly withdrawn: boolean }[],
): string | null =>
  releases
    .filter((release) => !release.withdrawn)
    .map((release) => release.version)
    .sort((a, b) => compareVersions(b, a))[0] ?? null;
/** The live kit source: npm for a package, the registry's kit index for a collection, its release index for a release. */
export function liveKitSource(sources: Pick<Sources, 'npm'>): NonNullable<Sources['kit']> {
  const budget = registryBudget();
  return async (unit) => {
    if (unit.kind === 'package') return sources.npm(unit.id);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const registry = await openRegistry(parseRegistryBase(unit.registry, unit.registry), {
        budget,
        signal: controller.signal,
      });
      const index =
        unit.kind === 'collection' ? await registry.index('kit', unit.id) : await registry.index('release', unit.id);
      return newestVersion(index.releases);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
/** A lookup bounded by the 15 s per-unit timeout, whatever the source does; a failure or a timeout is null. */
async function bounded(lookup: () => Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup().catch(() => null),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * §11: one refresh. npm is asked only for the npm channel; a checkout is counted against its upstream as of the last
 * fetch, and nothing fetches. An unavailable source is `checked: false`, never "up to date". With `root`, each installed
 * unit whose entry is missing or older than 24 hours (every unit, with `force`) is looked up, at most 20 per run, and a
 * failed lookup records `latest: null` for that key only. The lookups hold no lock; the write re-reads the cache under
 * the store lock and merges, so a refresh for another workspace that finished meanwhile keeps its entries. Throws
 * `HomeLockedError`, writing nothing, when the store lock stays held.
 */
export async function refreshUpdates(input: RefreshInput, sources: Sources = liveSources): Promise<UpdateCheck> {
  if (input.force === true && input.root === undefined)
    fail('INPUT-INVALID', 'Forcing a refresh needs a workspace root');
  // §11: `IA_NO_UPDATE_CHECK=1` is the offline signal: even a forced refresh makes no network lookup, npm's or a
  // registry's. A checkout's count against its upstream is local (it fetches nothing), so it still runs; any other
  // refresh has nothing left to do, writes nothing and returns the cache as it stands.
  const offline = (input.env ?? process.env)['IA_NO_UPDATE_CHECK'] === '1';
  if (offline && !(input.channel === 'checkout' && input.checkout !== null))
    return (
      readUpdateCheck(input.home) ?? {
        schema: 'ia.update-check.v1',
        checkedAt: input.now.toISOString(),
        cli: { channel: input.channel, current: input.current, latest: null, behind: null, checked: false },
        packages: { checked: false },
      }
    );
  let latest: string | null = null,
    behind: number | null = null;
  if (!offline && input.channel === 'npm' && input.name !== null) latest = sources.npm(input.name);
  if (input.channel === 'checkout' && input.checkout !== null) {
    const count = sources.git(input.checkout, ['rev-list', '--count', 'HEAD..@{upstream}']);
    behind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  }
  const checkedAt = input.now.toISOString();
  const fetched: KitUpdateEntry[] = [];
  if (!offline && input.root !== undefined) {
    const stored = readUpdateCheck(input.home),
      kit = sources.kit ?? liveKitSource(sources);
    const keys = kitUnitKeys(input.root, { env: input.env ?? process.env, userHome: input.userHome })
      .units.flatMap((row) => (row.key === null ? [] : [row.key]))
      .filter((key) => input.force === true || !kitEntryFresh(kitEntry(stored, key), input.now))
      .slice(0, MAX_LOOKUPS);
    for (const key of keys) fetched.push({ ...key, latest: await bounded(() => kit(key)), checkedAt });
  }
  await input.afterFetch?.();
  const cli: UpdateCheck['cli'] = {
    channel: input.channel,
    current: input.current,
    latest,
    behind,
    checked: latest !== null || behind !== null,
  };
  return withHomeLock(
    input.home,
    UPDATE_CHECK_LOCK,
    () => {
      const previous = readUpdateCheck(input.home);
      // A stamp later than the clock at this merge was not written by a refresh that finished meanwhile: it lies in
      // the future (the clock stepped back after it was written), so it is replaced or dropped, never kept.
      const start = input.now.getTime(),
        merged = Math.max(start, Date.now());
      const future = (stamp: string): boolean => Date.parse(stamp) > merged;
      // The CLI fields and the global stamp are this run's unless a refresh that finished meanwhile is newer.
      const newer = previous !== null && Date.parse(previous.checkedAt) > start && !future(previous.checkedAt);
      const entries = [...(previous?.packages.entries ?? [])];
      for (const entry of fetched) {
        const at = entries.findIndex((stored) => sameKey(stored, entry));
        if (at === -1) entries.push(entry);
        else if (Date.parse(entries[at]!.checkedAt) < start || future(entries[at]!.checkedAt)) entries[at] = entry;
      }
      const kept = entries.filter(
        (entry) => start - Date.parse(entry.checkedAt) < ENTRY_TTL && !future(entry.checkedAt),
      );
      const check: UpdateCheck = {
        schema: 'ia.update-check.v1',
        checkedAt: newer ? previous.checkedAt : checkedAt,
        cli: newer ? previous.cli : cli,
        packages: { checked: kept.length > 0, ...(kept.length === 0 ? {} : { entries: kept }) },
        ...(previous?.account === undefined ? {} : { account: previous.account }),
      };
      writeHomeFile(input.home, UPDATE_CHECK, JSON.stringify(check, null, 2) + '\n');
      return check;
    },
    input.lockWaitMs === undefined ? {} : { waitMs: input.lockWaitMs },
  );
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
/** §7.3: local only. A workspace language newer than anything this ia reads fails; an older one it no longer reads warns. */
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
