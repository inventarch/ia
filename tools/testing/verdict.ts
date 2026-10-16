import { isEntry } from '../entry/is-entry.mjs';

/**
 * The verdict a pull request's title or description edit reports instead of re-running every lane: the result of the
 * last full run of this workflow on the same head commit, whatever event started it. The verdict is copied, never invented. A copy passes only
 * when that run finished and succeeded; no full run, one still running and any other conclusion all fail.
 */

/** The Plan job step that copies a verdict. A run that executed it is a copy, so a later copy skips it. */
export const VERDICT_STEP = "Copy the verdict of this commit's last full run";

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
}

/** A cancelled or skipped run decided nothing; an earlier run on the same commit still did. */
const UNDECIDED = new Set(['cancelled', 'skipped']);

/** Whether a run copied a verdict: its Plan job ran the copy step, or is running it. Undecided counts as not a copy. */
function isCopy(jobs: readonly RunJob[]): boolean {
  const step = jobs.find((job) => job.name === 'Plan')?.steps?.find((candidate) => candidate.name === VERDICT_STEP);
  return step?.status === 'in_progress' || (step?.status === 'completed' && step.conclusion !== 'skipped');
}

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
    if (run.status !== 'completed') return { passed: false, reason: `${run.html_url} is still ${run.status}` };
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
      const verdict = await copiedVerdict(runs, Number(runId), async (run) => {
        const { jobs } = await github<{ jobs: RunJob[] }>(
          `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
        );
        return jobs;
      });
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
