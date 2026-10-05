import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { PLATFORMS, readManifest, type Manifest, type Platform, type TaskRecord } from './inventory.js';
import { readEvidence } from './report.js';

/**
 * Deterministic shard assignment. Placement uses historical duration, which is scheduling metadata:
 * it changes which runner executes a task and never what the task is, so rebalancing cannot
 * invalidate a cached result.
 */

export const SCHEDULE_VERSION = 1;
export const LANES = ['build', 'static', 'tests', 'emitted'] as const;
export type Lane = (typeof LANES)[number];

export interface Schedule {
  readonly version: number;
  /** Observed seconds per task per platform, from executed runs only. */
  readonly platforms: Readonly<Record<Platform, Readonly<Record<string, number>>>>;
}
export interface Shard {
  readonly index: number;
  readonly resourceClass: 'native-heavy' | 'general';
  readonly tasks: readonly string[];
  readonly estimateSeconds: number;
}
export interface ShardPlan {
  readonly version: number;
  readonly platform: Platform;
  readonly lanes: Readonly<Record<Lane, readonly string[]>>;
  readonly shards: readonly Shard[];
  readonly estimated: {
    readonly totalSeconds: number;
    readonly longestShardSeconds: number;
    readonly unknownTasks: readonly string[];
    /** The platform whose durations, scaled by `borrowedRatio`, placed the tasks this one has not recorded; null when none. */
    readonly borrowedFrom: Platform | null;
    readonly borrowedTasks: readonly string[];
    readonly borrowedRatio: number;
  };
  readonly limitations: readonly string[];
}

/** A task with no history is assumed at least as expensive as the slowest known one, and always runs. */
export const CONSERVATIVE_ESTIMATE_SECONDS = 600;
/** A task a platform has not recorded is placed by this platform's duration for it, scaled, until `--record` gives it its own. */
export const BORROWED_PLATFORM: Platform = 'linux';
/** Test shards per platform. Platforms differ in cost as well as speed: hosted macOS minutes bill at a multiple of Linux's. */
export type PlatformCounts = Readonly<Record<Platform, number>>;

export function emptySchedule(): Schedule {
  return {
    version: SCHEDULE_VERSION,
    platforms: Object.fromEntries(PLATFORMS.map((platform) => [platform, {}])) as Schedule['platforms'],
  };
}

export function readSchedule(root: string): Schedule {
  const path = resolve(root, 'tools/testing/schedule.json');
  if (!existsSync(path)) return emptySchedule();
  const value = JSON.parse(readFileSync(path, 'utf8')) as Schedule;
  if (value?.version !== SCHEDULE_VERSION) throw new Error(`schedule.json: expected version ${SCHEDULE_VERSION}`);
  return value;
}

/**
 * A task another task depends on is produced once in the build lane, which every other source lane
 * waits for, so dependants restore it instead of repeating it on each runner.
 */
export function laneOf(task: TaskRecord, prerequisite = false): Lane {
  if (task.mode === 'emitted') return 'emitted';
  if (prerequisite || task.id.endsWith(':build')) return 'build';
  return task.kind === 'vitest' ? 'tests' : 'static';
}

const observed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The factor that turns the borrowed platform's durations into this platform's: the median of this platform's duration
 * over the borrowed one's across the tasks both have recorded, or 1 while they share none. Only this platform's own record
 * and the borrowed platform's enter it, and the borrowed platform never borrows, so recording a borrowing platform never
 * moves another platform's plan; recording the borrowed one moves the estimates it lends.
 */
export function borrowedRatio(schedule: Schedule, platform: Platform): number {
  if (platform === BORROWED_PLATFORM) return 1;
  const own = schedule.platforms?.[platform] ?? {},
    lent = schedule.platforms?.[BORROWED_PLATFORM] ?? {};
  const ratios = Object.entries(own)
    .flatMap(([id, seconds]) => {
      const base = lent[id];
      return observed(seconds) && observed(base) && base > 0 ? [seconds / base] : [];
    })
    .sort((a, b) => a - b);
  if (!ratios.length) return 1;
  const middle = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
}

/**
 * A task's estimate on one platform: its own recorded duration; otherwise the borrowed platform's duration for that task,
 * scaled by `borrowedRatio`; otherwise the conservative estimate. Borrowing is per task, so a partial record (a `--record`
 * from a run that restored some results) never leaves the platform's other tasks sharing one conservative estimate.
 */
export function estimateFor(
  schedule: Schedule,
  platform: Platform,
  id: string,
): { readonly seconds: number; readonly known: boolean; readonly borrowed: boolean } {
  const own = schedule.platforms?.[platform] ?? {},
    mine = own[id];
  if (observed(mine)) return { seconds: mine, known: true, borrowed: false };
  const ratio = borrowedRatio(schedule, platform),
    lent = platform === BORROWED_PLATFORM ? {} : (schedule.platforms?.[BORROWED_PLATFORM] ?? {}),
    theirs = lent[id];
  if (observed(theirs)) return { seconds: theirs * ratio, known: true, borrowed: true };
  const known = [...Object.values(own), ...Object.values(lent).map((seconds) => seconds * ratio)].filter(observed);
  return { seconds: Math.max(CONSERVATIVE_ESTIMATE_SECONDS, ...known), known: false, borrowed: false };
}

/** `N` for every platform, or `linux=N,windows=N,macos=N` naming each platform exactly once. */
export function platformCounts(value: string, flag: string): PlatformCounts {
  const usage = `${flag} expects N or ${PLATFORMS.map((platform) => `${platform}=N`).join(',')}`;
  if (/^[0-9]+$/.test(value))
    return Object.fromEntries(PLATFORMS.map((platform) => [platform, Number(value)])) as PlatformCounts;
  const counts = new Map<string, number>();
  for (const pair of value.split(',')) {
    const match = /^([a-z]+)=([0-9]+)$/.exec(pair);
    if (!match || !(PLATFORMS as readonly string[]).includes(match[1]!) || counts.has(match[1]!))
      throw new Error(usage);
    counts.set(match[1]!, Number(match[2]));
  }
  if (counts.size !== PLATFORMS.length) throw new Error(usage);
  return Object.fromEntries(counts) as PlatformCounts;
}

export interface PlanOptions {
  readonly platform: Platform;
  /** Total test shards for this platform, including the reserved native-heavy shards. */
  readonly shards: number;
  readonly nativeShards?: number;
}

export function planShards(manifest: Manifest, schedule: Schedule, options: PlanOptions): ShardPlan {
  const { platform } = options;
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
  if (!Number.isSafeInteger(options.shards) || options.shards < 1)
    throw new Error('A plan needs at least one test shard');
  const nativeShards = options.nativeShards ?? 1;
  if (!Number.isSafeInteger(nativeShards) || nativeShards < 0 || nativeShards >= options.shards)
    throw new Error('Reserved native shards must leave at least one general shard');

  const applicable = (manifest.tasks ?? []).filter((task) => task.platforms.includes(platform));
  const prerequisites = new Set(applicable.flatMap((task) => task.dependsOn));
  const laneFor = (task: TaskRecord): Lane => laneOf(task, prerequisites.has(task.id));
  const lanes = { build: [], static: [], tests: [], emitted: [] } as Record<Lane, string[]>;
  for (const task of applicable) lanes[laneFor(task)].push(task.id);
  for (const lane of LANES) lanes[lane].sort();

  const shards: { index: number; resourceClass: Shard['resourceClass']; tasks: string[]; estimateSeconds: number }[] =
    [];
  for (let index = 1; index <= options.shards; index += 1)
    shards.push({
      index,
      resourceClass: index <= nativeShards ? 'native-heavy' : 'general',
      tasks: [],
      estimateSeconds: 0,
    });

  const unknown: string[] = [],
    borrowed: string[] = [];
  const weighted = applicable
    .filter((task) => laneFor(task) === 'tests')
    .map((task) => {
      const estimate = estimateFor(schedule, platform, task.id);
      if (!estimate.known) unknown.push(task.id);
      if (estimate.borrowed) borrowed.push(task.id);
      return { task, seconds: estimate.seconds };
    })
    .sort(
      (a, b) =>
        (nativeShards > 0
          ? Number(b.task.resourceClass === 'native-heavy') - Number(a.task.resourceClass === 'native-heavy')
          : 0) ||
        b.seconds - a.seconds ||
        a.task.id.localeCompare(b.task.id),
    );

  for (const entry of weighted) {
    // Place constrained work first, then let general work fill spare capacity on any shard.
    // Tasks within a shard still execute serially; this does not increase native concurrency.
    const compatible =
      entry.task.resourceClass === 'native-heavy' && nativeShards > 0
        ? shards.filter((shard) => shard.resourceClass === 'native-heavy')
        : shards;
    const target = compatible.reduce((best, shard) =>
      shard.estimateSeconds < best.estimateSeconds ||
      (shard.estimateSeconds === best.estimateSeconds && shard.index < best.index)
        ? shard
        : best,
    );
    target.tasks.push(entry.task.id);
    target.estimateSeconds += entry.seconds;
  }
  const placed = shards.map((shard) => ({
    ...shard,
    tasks: [...shard.tasks].sort(),
    estimateSeconds: Math.round(shard.estimateSeconds),
  }));
  return {
    version: SCHEDULE_VERSION,
    platform,
    lanes,
    shards: placed,
    estimated: {
      totalSeconds: placed.reduce((total, shard) => total + shard.estimateSeconds, 0),
      longestShardSeconds: Math.max(0, ...placed.map((shard) => shard.estimateSeconds)),
      unknownTasks: unknown.sort(),
      borrowedFrom: borrowed.length ? BORROWED_PLATFORM : null,
      borrowedTasks: borrowed.sort(),
      borrowedRatio: borrowedRatio(schedule, platform),
    },
    limitations: [
      'Estimates place tasks; they are not a promise of wall time and never enter a task identity.',
      'A single long indivisible task sets the shortest possible critical path whatever the shard count is.',
      'Reserved native shards assume the declared resource classes are accurate.',
    ],
  };
}

/** Hosted runner labels. macOS is pinned to a versioned arm64 image (the declared support target) and bumped deliberately. */
export const RUNNERS: Readonly<Record<Platform, string>> = {
  linux: 'ubuntu-latest',
  windows: 'windows-latest',
  macos: 'macos-26',
};

/** Pull requests targeting main qualify every supported platform before merge. */
export const PULL_REQUEST_PLATFORMS: readonly Platform[] = PLATFORMS;

/** Every workflow event qualifies the same supported platforms. */
export function eventPlatforms(event: string | undefined): readonly Platform[] {
  return event === 'pull_request' ? PULL_REQUEST_PLATFORMS : PLATFORMS;
}

/**
 * Whether a CI run has anything to verify. A scheduled run has nothing new when main's head is the commit the last
 * successful scheduled run verified, so every job after the plan skips; an unknown head or verified commit runs. Every
 * other event always runs, a dispatched full run included.
 */
export function runNeeded(event: string | undefined, head: string | undefined, verified: string | undefined): boolean {
  return !(event === 'schedule' && !!head && head === verified);
}

/** Distinct known platforms, in `PLATFORMS` order; an empty, unknown or repeated platform is refused. */
export function selectedPlatforms(platforms: readonly string[]): readonly Platform[] {
  const unknown = platforms.filter((platform) => !(PLATFORMS as readonly string[]).includes(platform));
  if (unknown.length) throw new Error(`Unknown platform ${unknown.join(', ')}`);
  if (!platforms.length || new Set(platforms).size !== platforms.length)
    throw new Error(`Planning needs distinct platforms from ${PLATFORMS.join(', ')}`);
  return PLATFORMS.filter((platform) => platforms.includes(platform));
}

export interface GateEntry {
  readonly os: string;
  readonly platform: Platform;
}
/** One gate row per planned platform on its runner: the gate job's matrix comes from the same selection as the lanes it compares. */
export function gateMatrix(platforms: readonly Platform[]): { readonly include: readonly GateEntry[] } {
  return { include: selectedPlatforms(platforms).map((platform) => ({ os: RUNNERS[platform], platform })) };
}

export interface LaneEntry {
  readonly os: string;
  readonly platform: Platform;
  readonly tasks: string;
}
export interface ShardEntry extends LaneEntry {
  readonly shard: number;
  readonly class: string;
}
export interface CiMatrices {
  readonly tests: { readonly include: readonly ShardEntry[] };
  readonly build: { readonly include: readonly LaneEntry[] };
  readonly static: { readonly include: readonly LaneEntry[] };
  readonly emitted: { readonly include: readonly LaneEntry[] };
}

/**
 * Every planned platform in one shape, because GitHub needs a single matrix per job: all of them unless `platforms`
 * narrows the set. Lane membership and shard placement are scheduling decisions; the task identities they carry are not.
 */
export function ciMatrices(
  manifest: Manifest,
  schedule: Schedule,
  options: {
    readonly shards: number | PlatformCounts;
    readonly nativeShards?: number | PlatformCounts;
    readonly platforms?: readonly Platform[];
  },
): CiMatrices {
  const tests: ShardEntry[] = [],
    build: LaneEntry[] = [],
    statics: LaneEntry[] = [],
    emitted: LaneEntry[] = [];
  const byLane: Readonly<Record<'build' | 'static' | 'emitted', LaneEntry[]>> = { build, static: statics, emitted };
  for (const platform of selectedPlatforms(options.platforms ?? PLATFORMS)) {
    const count = (value: number | PlatformCounts): number => (typeof value === 'number' ? value : value[platform]);
    const plan = planShards(manifest, schedule, {
      platform,
      shards: count(options.shards),
      ...(options.nativeShards === undefined ? {} : { nativeShards: count(options.nativeShards) }),
    });
    for (const shard of plan.shards) {
      if (!shard.tasks.length) continue;
      tests.push({
        os: RUNNERS[platform],
        platform,
        shard: shard.index,
        class: shard.resourceClass,
        tasks: shard.tasks.join(' '),
      });
    }
    for (const lane of ['build', 'static', 'emitted'] as const) {
      if (plan.lanes[lane].length)
        byLane[lane].push({ os: RUNNERS[platform], platform, tasks: plan.lanes[lane].join(' ') });
    }
  }
  return {
    tests: { include: tests },
    build: { include: build },
    static: { include: statics },
    emitted: { include: emitted },
  };
}

/** Folds executed durations into the schedule. Restored results carry no execution time, so they are ignored. */
export function updateSchedule(schedule: Schedule, evidenceDirectory: string): Schedule {
  const { evidence } = readEvidence(evidenceDirectory);
  const platforms: Record<string, Record<string, number>> = Object.fromEntries(
    PLATFORMS.map((platform) => [platform, { ...schedule.platforms?.[platform] }]),
  );
  for (const entry of evidence) {
    if (entry.outcome !== 'executed' || entry.report.status !== 'passed') continue;
    platforms[entry.platform]![entry.task] = Math.round(entry.report.durationMs / 1000);
  }
  return { version: SCHEDULE_VERSION, platforms: platforms as Schedule['platforms'] };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2),
    root = resolve(import.meta.dirname, '../..');
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const known = [
    '--platform',
    '--shards',
    '--native-shards',
    '--matrix',
    '--ci-matrix',
    '--event',
    '--head-sha',
    '--verified-sha',
    '--json',
    '--record',
    '--record-out',
  ];
  const stray = args.filter((arg, index) =>
    arg.startsWith('--') ? !known.includes(arg) : !(index > 0 && known.includes(args[index - 1]!)),
  );
  if (stray.length) {
    console.error(
      `Usage: pnpm tests:plan [--platform <${PLATFORMS.join('|')}>] [--shards N|${PLATFORMS.map((platform) => `${platform}=N`).join(',')}] [--native-shards (the same)] [--matrix|--ci-matrix [--event <GitHub event> --head-sha <sha> --verified-sha <sha>]|--json] [--record <evidence directory> [--record-out <output file>]]`,
    );
    process.exitCode = 2;
  } else
    try {
      const record = flag('--record');
      if (args.includes('--record-out') && (!record || !flag('--record-out')))
        throw new Error('--record-out requires --record <evidence directory> and an output file');
      if (args.includes('--ci-matrix')) {
        // The triggering event selects the platforms, and for a scheduled run whether there is anything new to verify.
        const event = flag('--event'),
          platforms = eventPlatforms(event);
        const matrices = ciMatrices(readManifest(root), readSchedule(root), {
          shards: platformCounts(flag('--shards') ?? '4', '--shards'),
          ...(flag('--native-shards') === undefined
            ? {}
            : { nativeShards: platformCounts(flag('--native-shards')!, '--native-shards') }),
          platforms,
        });
        for (const lane of ['tests', 'build', 'static', 'emitted'] as const)
          console.log(`${lane}=${JSON.stringify(matrices[lane])}`);
        console.log(`gate=${JSON.stringify(gateMatrix(platforms))}`);
        console.log(`platforms=${JSON.stringify(platforms)}`);
        console.log(`run=${runNeeded(event, flag('--head-sha'), flag('--verified-sha'))}`);
        // No process.exit(): output a slow reader has not taken yet is still queued here, and exiting would drop it.
      } else if (record !== undefined) {
        const updated = updateSchedule(readSchedule(root), resolve(root, record));
        const output = resolve(root, flag('--record-out') ?? 'tools/testing/schedule.json');
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, JSON.stringify(updated, null, 2) + '\n');
        console.log(
          `Recorded durations for ${Object.values(updated.platforms).reduce((total, entry) => total + Object.keys(entry).length, 0)} task variants.`,
        );
      } else {
        const platform = (flag('--platform') ?? '') as Platform;
        if (!PLATFORMS.includes(platform)) throw new Error(`Planning requires --platform <${PLATFORMS.join('|')}>`);
        const plan = planShards(readManifest(root), readSchedule(root), {
          platform,
          shards: platformCounts(flag('--shards') ?? '4', '--shards')[platform],
          ...(flag('--native-shards') === undefined
            ? {}
            : { nativeShards: platformCounts(flag('--native-shards')!, '--native-shards')[platform] }),
        });
        if (args.includes('--matrix'))
          console.log(
            JSON.stringify({
              include: plan.shards.map((shard) => ({
                shard: shard.index,
                class: shard.resourceClass,
                tasks: shard.tasks.join(' '),
              })),
            }),
          );
        else if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
        else {
          console.log(
            `Plan for ${platform}: ${plan.lanes.build.length} build, ${plan.lanes.static.length} static, ${plan.lanes.tests.length} test and ${plan.lanes.emitted.length} emitted tasks.`,
          );
          for (const shard of plan.shards)
            console.log(
              `  shard ${shard.index} (${shard.resourceClass}): ${shard.tasks.length} tasks, ~${shard.estimateSeconds}s`,
            );
          if (plan.estimated.borrowedFrom)
            console.log(
              `  ${plan.estimated.borrowedTasks.length} tasks have no recorded ${platform} duration, so ${plan.estimated.borrowedFrom} durations scaled by ${plan.estimated.borrowedRatio.toFixed(2)} placed them.`,
            );
          if (plan.estimated.unknownTasks.length)
            console.log(
              `  ${plan.estimated.unknownTasks.length} tasks have no recorded duration and used the conservative estimate.`,
            );
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
