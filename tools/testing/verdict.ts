import { isEntry } from '../entry/is-entry.mjs';

/**
 * The verdict a pull request's title or description edit reports instead of re-running every lane: the result of the
 * last full run of this workflow on the same head commit, whatever event started it. The verdict is copied, never
 * invented. A copy passes only when that run finished and succeeded. While it is still running the copy waits for it,
 * for a bounded time; no full run, one still running at the bound and any other conclusion all fail.
 */

/** The Plan job step that copies a verdict. */
export const VERDICT_STEP = "Copy the verdict of this commit's last full run";
/**
 * The Plan job's first step in a copy run, before anything that can fail. A run that ran it is a copy whatever it did
 * next, so a later copy never mistakes a copy that failed early (an audit or install error) for a failed full run.
 */
export const COPY_MARK = 'Mark this run as a copied verdict';
/** How long a copy waits for a full run that is still going, and how often it looks again; inside the Plan job's 20 minutes. */
export const WAIT_MS = 15 * 60_000;
export const POLL_MS = 30_000;

export interface WorkflowRun {
  readonly id: number;
  readonly created_at: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}
export interface RunJob {
  readonly name: string;
  readonly steps?: readonly { readonly name: string; readonly status: string; readonly conclusion: string | null }[];
}
export interface Verdict {
  readonly passed: boolean;
  readonly reason: string;
  /** The newest full run has not finished: its result may still come. */
  readonly pending?: boolean;
}

/** A cancelled or skipped run decided nothing; an earlier run on the same commit still did. */
const UNDECIDED = new Set(['cancelled', 'skipped']);

/** Whether a run's Plan job ran the named step, or is running it. A step not reached yet counts as not run. */
export function ranStep(jobs: readonly RunJob[], name: string): boolean {
  const step = jobs.find((job) => job.name === 'Plan')?.steps?.find((candidate) => candidate.name === name);
  return step?.status === 'in_progress' || (step?.status === 'completed' && step.conclusion !== 'skipped');
}
/** Whether a run copied a verdict: it ran the copy mark, its first step. */
const isCopy = (jobs: readonly RunJob[]): boolean => ranStep(jobs, COPY_MARK);

/** The verdict of the newest full run among `runs`, other than `current`. Jobs are read newest first, until one is full. */
export async function copiedVerdict(
  runs: readonly WorkflowRun[],
  current: number,
  jobsOf: (run: number) => Promise<readonly RunJob[]>,
): Promise<Verdict> {
  const candidates = runs
    .filter((run) => run.id !== current && !UNDECIDED.has(run.conclusion ?? ''))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const run of candidates) {
    if (isCopy(await jobsOf(run.id))) continue;
    if (run.status !== 'completed')
      return { passed: false, pending: true, reason: `${run.html_url} is still ${run.status}` };
    return run.conclusion === 'success'
      ? { passed: true, reason: `${run.html_url} passed` }
      : { passed: false, reason: `${run.html_url} finished as ${run.conclusion ?? 'no conclusion'}` };
  }
  return { passed: false, reason: 'no full run of this workflow has finished on this head commit' };
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Every edit adds a run on the head commit; past this many, the lookup fails rather than read without bound. */
const MAX_RUN_PAGES = 10;

async function github<T>(path: string): Promise<T> {
  const token = process.env['GH_TOKEN'];
  if (!token) throw new Error('GH_TOKEN is not set');
  const response = await fetch(`${process.env['GITHUB_API_URL'] ?? 'https://api.github.com'}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
    // Fails the step, and with it the copy, instead of holding the Plan job to its timeout.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const [repository, workflow, runId, head] = ['--repo', '--workflow', '--run-id', '--head-sha'].map(flag);
  if (!repository || !workflow || !runId || !/^[0-9]+$/.test(runId) || !head || args.length !== 8) {
    console.error('Usage: pnpm tests:verdict --repo <owner/name> --workflow <file> --run-id <id> --head-sha <sha>');
    process.exitCode = 2;
  } else
    try {
      const deadline = Date.now() + WAIT_MS;
      let verdict: Verdict;
      for (;;) {
        // Every event's runs: the release PR's required check comes from a dispatched run on its head.
        const runs: WorkflowRun[] = [];
        for (let page = 1; ; page += 1) {
          if (page > MAX_RUN_PAGES) throw new Error(`more than ${MAX_RUN_PAGES * 100} runs on ${head}`);
          const { workflow_runs: found } = await github<{ workflow_runs: WorkflowRun[] }>(
            `/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${head}&per_page=100&page=${page}`,
          );
          runs.push(...found);
          if (found.length < 100) break;
        }
        verdict = await copiedVerdict(runs, Number(runId), async (run) => {
          const { jobs } = await github<{ jobs: RunJob[] }>(
            `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
          );
          return jobs;
        });
        // A full run whose gate rows already exist would otherwise be outlived by this copy's failed rows.
        if (!verdict.pending || Date.now() + POLL_MS > deadline) break;
        console.error(`Head commit ${head}: ${verdict.reason}; looking again in ${POLL_MS / 1000} s.`);
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
      console.error(`Head commit ${head}: ${verdict.reason}.`);
      if (verdict.passed) console.log('verdict=success');
      else {
        console.error(
          'A title or description edit reports the last full run and runs nothing; push or re-run to verify.',
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
