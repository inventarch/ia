/**
 * The console's model of one workspace (consumer CLI contract §1.2), built from doctor checks only: the console has no health model of
 * its own. Which copy a row comes from is the row split: the six user-state rows and every row an extension declares
 * come from the running copy, which renders the plugin, refreshes the cache and carries the extension; every other row,
 * `marketplace` and any id added later included, comes from the workspace's own copy when it has one.
 *
 * Rows group into areas through `AREA_TABLE`, which is data, open to ids that do not exist yet: an id no row names lands
 * in the default area, Other, and is never dropped. Everything here is pure; collecting doctor rows reads the
 * filesystem and the clock, so `load.ts` does it with an injected collector.
 */
import type { Extension } from '../consumer.js';
import type { Check, CheckStatus } from '../doctor.js';
import type { ExtensionConsole } from '../doctor-extensions.js';
import type { Fix, Flow, WritesTo } from '../fix.js';
import type { LocalCli } from '../local-cli.js';
import type { PackageManager } from '../package-manager.js';

export type AreaStatus = 'fail' | 'warn' | 'unknown' | 'setup' | 'ok' | 'absent';
export interface ConsoleCheck extends Check {
  readonly from: 'running' | 'repo' | 'in-process';
  /** False for an id an area declares that no copy reported: it shows — and does not count. */
  readonly reported: boolean;
}
export interface Area {
  readonly id: string;
  readonly title: string;
  readonly status: AreaStatus;
  readonly summary: string;
  readonly checks: readonly ConsoleCheck[];
}
/** What the offers and recipes read besides the checks; local reads only. */
export interface ConsoleFacts {
  /** The IA home, or null when it cannot be resolved. */
  readonly home: string | null;
  /** The newest `@inventarch/cli` the update cache names, whatever this copy's version; null when none is cached. */
  readonly latest: string | null;
  /** The directory of the manifest that lists `@inventarch/cli`, or null when none does. */
  readonly manifestDir: string | null;
  readonly manager: PackageManager | null;
  /** The managers whose declarations or lockfiles disagree; empty when they agree. */
  readonly managerConflict: readonly string[];
  /** The workspace has an installed generation (`.ia/distributions/active.json`). */
  readonly generation: boolean;
  /** The IA home records a plugin installed from a marketplace. */
  readonly marketplace: boolean;
}
export interface ConsoleState {
  readonly root: string | null;
  readonly running: { readonly packageRoot: string; readonly version: string };
  /** The workspace's own copy as it was when the state was loaded; a display snapshot, never the copy a step runs. */
  readonly repo: LocalCli | null;
  readonly checks: readonly ConsoleCheck[];
  readonly areas: readonly Area[];
  /** Why the repo copy's doctor could not be read, or null. */
  readonly repoFailure: string | null;
  readonly tracked: boolean;
  readonly refreshNow: readonly string[] | null;
  readonly refreshNowWhy: string | null;
  readonly facts: ConsoleFacts;
}

/** The rows the running copy owns, exactly these six. */
export const RUNNING_ROWS: ReadonlySet<string> = new Set([
  'install-channel',
  'ia-home',
  'plugin-claude',
  'updates',
  'updates-account',
  'workspace-decision',
]);
/** Whether the running copy owns an id: one of the six, or one an extension declares or contributes under its token. */
export function runningOwner(extensions: readonly Extension[] = []): (id: string) => boolean {
  const declared = new Set(extensions.flatMap((extension) => extension.console?.areas.flatMap((a) => a.checks) ?? []));
  const tokens = extensions.filter((extension) => extension.console !== undefined).map((e) => `${e.token}-`);
  return (id) => RUNNING_ROWS.has(id) || declared.has(id) || tokens.some((token) => id.startsWith(token));
}

export interface AreaRow {
  /** The area id; null maps the ids to no area (diagnostics only), which is not the default. */
  readonly area: string | null;
  readonly title?: string;
  readonly ids: readonly string[];
  readonly prefixes: readonly string[];
  readonly except?: readonly string[];
}
/** The check → area table, in area order; first match wins, ids exact, prefixes by start. */
export const AREA_TABLE: readonly AreaRow[] = [
  {
    area: 'cli',
    title: 'CLI',
    ids: ['cli-version', 'install-channel', 'node', 'support-target', 'vocabulary', 'package-manager'],
    prefixes: [],
  },
  {
    area: 'records',
    title: 'Records',
    ids: ['root', 'records', 'source-bindings', 'source-protection', 'implementations', 'joins'],
    prefixes: ['source-'],
  },
  { area: 'kits', title: 'Kits', ids: ['kits'], prefixes: ['kit-update:', 'registry-'] },
  { area: 'updates', title: 'Updates', ids: ['updates', 'updates-account', 'compatibility'], prefixes: [] },
  { area: 'lock', title: 'Lock', ids: ['generation', 'pending', 'install-lock', 'cache'], prefixes: [] },
  {
    area: 'host',
    title: 'Host',
    ids: ['host'],
    prefixes: ['host-', 'projection-', 'join-'],
    except: ['host-plugin'],
  },
  { area: 'plugin', title: 'Plugin', ids: ['plugin-claude', 'ia-home'], prefixes: ['ia-home-moved-'] },
  { area: 'marketplace', title: 'Marketplace', ids: ['marketplace'], prefixes: [] },
  { area: null, ids: ['workspace-decision'], prefixes: [] },
];
export const DEFAULT_AREA = 'other';
const DEFAULT_TITLE = 'Other';

const matches = (row: AreaRow, id: string): boolean =>
  !(row.except ?? []).includes(id) && (row.ids.includes(id) || row.prefixes.some((prefix) => id.startsWith(prefix)));
/** The area of a check id: a table row, then an extension's declared ids, then the default; null only when mapped so. */
export function areaOf(
  id: string,
  extensions: readonly ExtensionConsole[] = [],
  table: readonly AreaRow[] = AREA_TABLE,
): string | null {
  const row = table.find((entry) => matches(entry, id));
  if (row !== undefined) return row.area;
  for (const extension of extensions) for (const area of extension.areas) if (area.checks.includes(id)) return area.id;
  return DEFAULT_AREA;
}

export type DoctorRun = { readonly status: number | null; readonly stdout: string; readonly timedOut?: boolean };
export type DoctorReport =
  | { readonly ok: true; readonly checks: readonly Check[] }
  | { readonly ok: false; readonly why: string };
export const DOCTOR_TIMEOUT_MS = 20_000;

const STATUSES: readonly CheckStatus[] = ['ok', 'warn', 'fail', 'unknown', 'info'];
const FLOWS: readonly Flow[] = ['preview-apply', 'preview-flag', 'confirm', 'immediate'];
const WRITES: readonly WritesTo[] = ['none', 'repo', 'user', 'machine'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * A fix as another copy emitted it, kept only when it has the shape this copy runs. `external` is kept as emitted: it
 * names a program that is not `ia` (a package manager, say), which does not depend on which copy runs it, so the console
 * runs it as the program, on PATH, never as one of the copies. The flow is the emitting copy's own: contract §2.12 makes
 * an `external` fix `confirm` there, and that copy has already run, so this copy does not re-check it.
 */
function readFix(value: unknown): Fix | null {
  if (!isRecord(value)) return null;
  const { program, argv, flow, writesTo } = value;
  if (
    (program !== 'ia' && program !== 'external') ||
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((part) => typeof part === 'string') ||
    !FLOWS.includes(flow as Flow) ||
    !WRITES.includes(writesTo as WritesTo)
  )
    return null;
  return { program, argv: [...(argv as string[])], flow: flow as Flow, writesTo: writesTo as WritesTo };
}
/**
 * A repo copy's `doctor --json` run as a report, or as a failed copy with its cause. Doctor exits 1 with a valid report
 * when a check fails, so exit 0 or 1 with JSON of the version 1 shape is a report; anything else is a failure, never
 * mistaken for "no local copy".
 */
export function readDoctorReport(run: DoctorRun): DoctorReport {
  if (run.status === null)
    return { ok: false, why: run.timedOut === true ? 'timed out after 20 s' : 'ended by a signal' };
  if (run.status !== 0 && run.status !== 1) return { ok: false, why: `exit ${run.status}` };
  let value: unknown;
  try {
    value = JSON.parse(run.stdout);
  } catch {
    return { ok: false, why: 'no JSON' };
  }
  const unrecognised = { ok: false, why: 'unrecognised output' } as const;
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['checks'])) return unrecognised;
  const checks: Check[] = [];
  for (const row of value['checks'] as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row['id'] !== 'string' ||
      !STATUSES.includes(row['status'] as CheckStatus) ||
      typeof row['detail'] !== 'string'
    )
      return unrecognised;
    checks.push({
      id: row['id'],
      section: 'Environment',
      title: typeof row['title'] === 'string' ? row['title'] : row['id'],
      status: row['status'] as CheckStatus,
      detail: row['detail'],
      remedy: typeof row['remedy'] === 'string' ? row['remedy'] : null,
      fix: readFix(row['fix']),
    });
  }
  return { ok: true, checks };
}

/**
 * The rows the console shows, each with the copy it came from:
 * - no repo copy (or none to run): every non-running row from the in-process collection;
 * - a report with `cli-version`: every non-running row from the report;
 * - a report without it (a copy that predates it): the report's rows as they are, plus only `cli-version`, computed
 *   in-process with that copy as `packageRoot`; ids it did not report get no row;
 * - a failed copy: each non-running id of the in-process collection as `unknown`, its detail the failure.
 * Running-owned rows always come from `running`, whatever the report says.
 */
export function assembleRows(input: {
  readonly running: readonly Check[];
  readonly inProcess: readonly Check[];
  readonly repo: DoctorReport | null;
  readonly repoCopy: LocalCli | null;
  readonly cliVersion: (copy: LocalCli) => Check;
  readonly owned?: (id: string) => boolean;
}): { readonly checks: readonly ConsoleCheck[]; readonly repoFailure: string | null } {
  const owned = input.owned ?? ((id: string) => RUNNING_ROWS.has(id));
  const tag = (row: Check, from: ConsoleCheck['from']): ConsoleCheck => ({ ...row, from, reported: true });
  const running = input.running.map((row) => tag(row, 'running'));
  const local = input.inProcess.filter((row) => !owned(row.id));
  if (input.repoCopy === null || input.repo === null)
    return { checks: [...local.map((row) => tag(row, 'in-process')), ...running], repoFailure: null };
  const repo = input.repo;
  if (!repo.ok)
    return {
      checks: [
        ...local.map(
          (row): ConsoleCheck => ({
            ...row,
            status: 'unknown',
            detail: `doctor failed: ${repo.why}`,
            remedy: null,
            fix: null,
            from: 'repo',
            reported: true,
          }),
        ),
        ...running,
      ],
      repoFailure: repo.why,
    };
  const reported = repo.checks.filter((row) => !owned(row.id)).map((row) => tag(row, 'repo'));
  const cliVersion = reported.some((row) => row.id === 'cli-version')
    ? []
    : [tag(input.cliVersion(input.repoCopy), 'in-process')];
  return { checks: [...cliVersion, ...reported, ...running], repoFailure: null };
}

const RANK: Readonly<Record<Exclude<AreaStatus, 'absent'>, number>> = { fail: 0, warn: 1, unknown: 2, setup: 3, ok: 4 };
const statusOf = (row: ConsoleCheck, setupIds: ReadonlySet<string>): Exclude<AreaStatus, 'absent'> =>
  row.status === 'info' ? (setupIds.has(row.id) ? 'setup' : 'ok') : row.status;
/**
 * Short summaries: an area's representative row, shortened. A settled area (its worst row ok or not set up) is summarised
 * from that row; a troubled one from its worst row, shortened when it is the representative. Otherwise the worst row's
 * detail.
 */
const SUMMARISERS: Readonly<Record<string, { readonly id: string; readonly text: (detail: string) => string | null }>> =
  {
    records: {
      id: 'records',
      text: (detail) => {
        const counts = /^(\d+) records, (\d+) errors, (\d+) warnings/.exec(detail);
        if (counts === null) return null;
        const [, records, errors, warnings] = counts;
        return [
          `${records} records`,
          ...(errors === '0' ? [] : [`${errors} errors`]),
          ...(warnings === '0' ? [] : [`${warnings} warn`]),
        ].join(' · ');
      },
    },
    cli: {
      id: 'cli-version',
      text: (detail) => {
        const copy = /^this workspace's copy (\S+), CLI dependency/.exec(detail);
        return copy === null ? null : `${copy[1]} repo`;
      },
    },
  };
export const UNREPORTED = 'not reported';
function summarise(
  area: string,
  worst: ConsoleCheck,
  counted: readonly ConsoleCheck[],
  status: Exclude<AreaStatus, 'absent'>,
): string {
  const summariser = SUMMARISERS[area];
  if (summariser === undefined) return worst.detail;
  const subject =
    worst.id === summariser.id
      ? worst
      : RANK[status] >= RANK.setup
        ? counted.find((row) => row.id === summariser.id)
        : undefined;
  return (subject === undefined ? null : summariser.text(subject.detail)) ?? worst.detail;
}

/**
 * The areas, in the table's order, then Other, then each extension area. A table area is shown when a row maps to it,
 * or, once a repo copy reported, always (so a row an older copy does not report shows —); Other only when a row lands
 * there; an extension area whenever its extension is present, its declared ids that no copy reported shown —. An area
 * with no reported row is `absent`. Status is the worst reported row's: fail, warn, unknown, then `setup` for an `info`
 * row with a set-up offer, then ok; an `info` row without one counts as ok.
 */
export function areasOf(
  checks: readonly ConsoleCheck[],
  setupIds: ReadonlySet<string>,
  extensions: readonly ExtensionConsole[] = [],
  table: readonly AreaRow[] = AREA_TABLE,
): readonly Area[] {
  const grouped = new Map<string, ConsoleCheck[]>();
  for (const row of checks) {
    const area = areaOf(row.id, extensions, table);
    if (area === null) continue;
    grouped.set(area, [...(grouped.get(area) ?? []), row]);
  }
  const repoReported = checks.some((row) => row.from === 'repo');
  const build = (id: string, title: string, rows: readonly ConsoleCheck[]): Area => {
    const counted = rows.filter((row) => row.reported);
    if (counted.length === 0) return { id, title, status: 'absent', summary: UNREPORTED, checks: rows };
    let worst = counted[0]!;
    for (const row of counted) if (RANK[statusOf(row, setupIds)] < RANK[statusOf(worst, setupIds)]) worst = row;
    return {
      id,
      title,
      status: statusOf(worst, setupIds),
      summary: summarise(id, worst, counted, statusOf(worst, setupIds)),
      checks: rows,
    };
  };
  const areas: Area[] = [];
  const seen = new Set<string>();
  for (const row of table) {
    if (row.area === null || seen.has(row.area)) continue;
    seen.add(row.area);
    const rows = grouped.get(row.area) ?? [];
    if (rows.length > 0 || repoReported) areas.push(build(row.area, row.title ?? row.area, rows));
  }
  const other = grouped.get(DEFAULT_AREA) ?? [];
  if (!seen.has(DEFAULT_AREA) && other.length > 0) areas.push(build(DEFAULT_AREA, DEFAULT_TITLE, other));
  for (const extension of extensions)
    for (const area of extension.areas) {
      if (seen.has(area.id)) continue;
      seen.add(area.id);
      const rows = grouped.get(area.id) ?? [];
      const missing = area.checks
        .filter((id) => !rows.some((row) => row.id === id))
        .map(
          (id): ConsoleCheck => ({
            id,
            section: 'Environment',
            title: id,
            status: 'unknown',
            detail: UNREPORTED,
            remedy: null,
            fix: null,
            from: 'running',
            reported: false,
          }),
        );
      areas.push(build(area.id, area.title, [...rows, ...missing]));
    }
  return areas;
}
