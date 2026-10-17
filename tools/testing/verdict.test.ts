import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { COPY_MARK, VERDICT_STEP, copiedVerdict, type RunJob, type WorkflowRun } from './verdict.js';
import { workflowJobs } from './workflow.js';

const CURRENT = 100;
const run = (id: number, created: string, status: string, conclusion: string | null): WorkflowRun => ({
  id,
  created_at: created,
  status,
  conclusion,
  html_url: `https://github.com/inventarch/ia/actions/runs/${id}`,
});
/** A full run's Plan job skips the copy mark, its first step; a copy run's Plan job runs it. */
const plan = (mark: { status: string; conclusion: string | null }): readonly RunJob[] => [
  {
    name: 'Plan',
    steps: [
      { name: COPY_MARK, ...mark },
      { name: 'Assign tasks to shards', status: 'completed', conclusion: 'success' },
    ],
  },
  { name: 'Build (ubuntu-latest)', steps: [] },
];
const full = plan({ status: 'completed', conclusion: 'skipped' }),
  copy = plan({ status: 'completed', conclusion: 'success' });
const verdict = (runs: readonly WorkflowRun[], jobs: Readonly<Record<number, readonly RunJob[]>>) =>
  copiedVerdict(runs, CURRENT, async (id) => {
    const found = jobs[id];
    if (!found) throw new Error(`no jobs fixture for run ${id}`);
    return found;
  });

it('fails when no other run exists for the head commit', async () => {
  const result = await verdict([run(CURRENT, '2026-10-16T10:00:00Z', 'in_progress', null)], {});
  expect(result.passed).toBe(false);
  expect(result.reason).toContain('no full run');
});

it('copies a pass from the last full run on the head commit', async () => {
  const result = await verdict([run(1, '2026-10-16T09:00:00Z', 'completed', 'success')], { 1: full });
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
});

it('fails when the last full run failed, even if an earlier one passed', async () => {
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'completed', 'failure')],
    { 1: full, 2: full },
  );
  expect(result).toEqual({ passed: false, reason: expect.stringContaining('runs/2 finished as failure') });
});

it('treats a timed-out or otherwise unfinished full run as no pass', async () => {
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required', 'neutral', null]) {
    const result = await verdict([run(1, '2026-10-16T09:00:00Z', 'completed', conclusion)], { 1: full });
    expect(result.passed).toBe(false);
  }
});

it('fails while the last full run is still running, and names it', async () => {
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'in_progress', null)],
    { 1: full, 2: full },
  );
  // Pending, so the command waits for it rather than outlive its gate rows with failed ones.
  expect(result).toEqual({
    passed: false,
    pending: true,
    reason: expect.stringContaining('runs/2 is still in_progress'),
  });
});

it('knows a copy that failed before its copy step for a copy, never for a failed full run', async () => {
  // Run 2 marked itself, then its audit failed, so its copy step was skipped: still a copy, and run 1 decides.
  const early: readonly RunJob[] = [
    {
      name: 'Plan',
      steps: [
        { name: COPY_MARK, status: 'completed', conclusion: 'success' },
        { name: 'Check dependency advisories', status: 'completed', conclusion: 'failure' },
        { name: VERDICT_STEP, status: 'completed', conclusion: 'skipped' },
      ],
    },
  ];
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'completed', 'failure')],
    { 1: full, 2: early },
  );
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
});

it('skips cancelled runs and earlier copies, so a copy never copies a copy', async () => {
  // Newest first: a cancelled full run, a copy that failed while run 1 was still going, then run 1, which passed.
  const runs = [
    run(1, '2026-10-16T08:00:00Z', 'completed', 'success'),
    run(2, '2026-10-16T08:30:00Z', 'completed', 'failure'),
    run(3, '2026-10-16T09:00:00Z', 'completed', 'cancelled'),
    run(CURRENT, '2026-10-16T10:00:00Z', 'in_progress', null),
  ];
  const result = await verdict(runs, { 1: full, 2: copy });
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
  // A copy whose step is still running is a copy too.
  expect(
    (
      await verdict([runs[0]!, run(2, '2026-10-16T08:30:00Z', 'in_progress', null)], {
        1: full,
        2: plan({ status: 'in_progress', conclusion: null }),
      })
    ).passed,
  ).toBe(true);
});

it('counts a run whose copy step has not been decided yet as a full run, so it cannot pass', async () => {
  // Its Plan job has not reached the step, so nothing says it is a copy; a full run that is still running cannot pass.
  const pending = plan({ status: 'queued', conclusion: null });
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'in_progress', null)],
    { 1: full, 2: pending },
  );
  expect(result.passed).toBe(false);
  // A run with no Plan job at all is not a copy either.
  expect((await verdict([run(1, '2026-10-16T08:00:00Z', 'completed', 'failure')], { 1: [] })).passed).toBe(false);
});

it("names the workflow's copy step and copy mark exactly as the classifier reads them, the mark first", () => {
  const text = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/platform-quality.yml'), 'utf8');
  const plan = workflowJobs(text).get('plan')!;
  expect(plan).toContain(`- name: ${VERDICT_STEP}\n`);
  // The mark is the Plan job's first step, on the same condition as the reuse plan and the edit concurrency group.
  expect(plan).toMatch(
    new RegExp(
      `^steps:\\n- name: ${COPY_MARK}\\nif: github\\.event\\.action == 'edited' && !github\\.event\\.changes\\.base\\n`,
      'm',
    ),
  );
});
