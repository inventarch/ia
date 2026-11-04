/**
 * The all-workspaces view's state (consumer CLI contract §1.2): one row per tracked workspace, each loaded the way the
 * single-repo view loads its own (load.ts), so each workspace's rows come from that workspace's own copy and the
 * user-state and extension rows from the running copy. The copies' doctor runs go in parallel, at most `limit` at once
 * (4 by default), each bounded at 30 s; a row reports as soon as its result arrives. A quit aborts the runs still going
 * and starts no more.
 *
 * A row's class comes from the statuses its own checks report, never from its offers: a failure whose remedy is advice
 * (no fix, so no offer) still needs attention. The running copy's rows are the same for every workspace, so they shape
 * the summary, not a row's class.
 */
import { compareVersions } from '@inventarch/distribution/updates';
import type { Extension } from '../consumer.js';
import type { DoctorRequest, DoctorView } from '../doctor.js';
import type { Env } from '../program.js';
import type { TrackedWorkspace } from '../tracked.js';
import { trackedState } from '../tracked.js';
import type { SpawnDoctor } from './load.js';
import { loadState } from './load.js';
import type { Offer } from './offers.js';
import { offersFor } from './offers.js';
import type { ConsoleState } from './state.js';

export interface RepoRow {
  readonly tracked: TrackedWorkspace;
  readonly state: 'loading' | 'missing' | 'ready' | 'failed';
  readonly console: ConsoleState | null;
  readonly offers: readonly Offer[];
  /** Why the workspace's copy could not report (or the row could not load), or null. */
  readonly failure: string | null;
}
export type RepoClass = 'loading' | 'missing' | 'failed' | 'failing' | 'warning' | 'unchecked' | 'healthy';

/** The parallel doctor runs at once. */
export const DOCTOR_LIMIT = 4;
/** The bound on each workspace copy's doctor run. */
export const WORKSPACE_DOCTOR_TIMEOUT_MS = 30_000;

export const loadingRow = (tracked: TrackedWorkspace): RepoRow => ({
  tracked,
  state: 'loading',
  console: null,
  offers: [],
  failure: null,
});

/** One class per row, from its reported, workspace-owned check statuses only. */
export function classify(row: RepoRow): RepoClass {
  if (row.state === 'loading' || row.state === 'missing' || row.state === 'failed') return row.state;
  const statuses = (row.console?.checks ?? [])
    .filter((check) => check.reported && check.from !== 'running')
    .map((check) => check.status);
  if (statuses.includes('fail')) return 'failing';
  if (statuses.includes('warn')) return 'warning';
  if (statuses.includes('unknown')) return 'unchecked';
  return 'healthy';
}

/**
 * Loads every tracked row through its own copy, reporting each through `onRow` as it arrives. A row whose root is gone
 * or holds no `.ia/src` is `missing` at once and never loaded. Resolves when every started load has settled; after the
 * signal aborts, the loads still going are aborted with it, no new one starts and nothing more is reported.
 */
export async function loadAll(input: {
  readonly tracked: readonly TrackedWorkspace[];
  readonly env: Env;
  readonly packageRoot: string;
  readonly version: string;
  readonly limit?: number;
  readonly signal: AbortSignal;
  readonly onRow: (index: number, row: RepoRow) => void;
  readonly collect: (request: DoctorRequest) => DoctorView;
  readonly spawnDoctor?: SpawnDoctor;
  readonly extensions?: readonly Extension[];
}): Promise<void> {
  const { signal } = input;
  const extensions = input.extensions ?? [];
  const consoles = extensions.flatMap((extension) => (extension.console === undefined ? [] : [extension.console]));
  const queue: number[] = [];
  input.tracked.forEach((row, index) => {
    if (trackedState(row) === 'missing') input.onRow(index, { ...loadingRow(row), state: 'missing' });
    else queue.push(index);
  });
  const one = async (index: number): Promise<void> => {
    const tracked = input.tracked[index]!;
    let row: RepoRow;
    try {
      const state = await loadState({
        cwd: tracked.root,
        env: input.env,
        packageRoot: input.packageRoot,
        version: input.version,
        collect: input.collect,
        extensions,
        signal,
        timeoutMs: WORKSPACE_DOCTOR_TIMEOUT_MS,
        ...(input.spawnDoctor === undefined ? {} : { spawnDoctor: input.spawnDoctor }),
      });
      row = {
        tracked,
        state: state.repoFailure === null ? 'ready' : 'failed',
        console: state,
        offers: offersFor(state, consoles),
        failure: state.repoFailure,
      };
    } catch (error) {
      row = {
        ...loadingRow(tracked),
        state: 'failed',
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    if (!signal.aborted) input.onRow(index, row);
  };
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined && !signal.aborted; next = queue.shift()) await one(next);
  };
  const limit = Math.max(1, input.limit ?? DOCTOR_LIMIT);
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export interface Summary {
  readonly latest: string | null;
  readonly global: string;
  readonly behind: boolean;
  readonly tracked: number;
  readonly healthy: number;
  /** failing + warning. */
  readonly attention: number;
  readonly failing: number;
  readonly warning: number;
  readonly missing: number;
  readonly failed: number;
  readonly unchecked: number;
  readonly loading: number;
}
/** The summary panel: the cached latest release, the running version, and how many rows fall in each class. */
export function summarize(
  rows: readonly RepoRow[],
  updates: { readonly latest: string | null },
  version: string,
): Summary {
  const count = (kind: RepoClass): number => rows.filter((row) => classify(row) === kind).length;
  const failing = count('failing'),
    warning = count('warning');
  let behind = false;
  try {
    behind = updates.latest !== null && compareVersions(updates.latest, version) > 0;
  } catch {
    behind = false;
  }
  return {
    latest: updates.latest,
    global: version,
    behind,
    tracked: rows.length,
    healthy: count('healthy'),
    attention: failing + warning,
    failing,
    warning,
    missing: count('missing'),
    failed: count('failed'),
    unchecked: count('unchecked'),
    loading: count('loading'),
  };
}
