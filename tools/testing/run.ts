import '../temp/physical-temp.mjs';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { readManifest, type TaskRecord } from './inventory.js';
import {
  buildReport,
  currentPlatform,
  headCommit,
  readVitestResults,
  writeEvidence,
  type CaseResult,
  type GateEvidence,
} from './report.js';
import { profileFor, vitestBounds, vitestEnvironment } from './timeouts.js';
import { runBounded } from './subprocess.js';

/**
 * Executes one declared task and writes its evidence. This runner always executes; restoration is
 * the scheduler's concern, and a runner that cannot execute refuses rather than reporting success.
 */

export function artifactDirectory(task: TaskRecord): string {
  const declared = task.outputs.find((output) => output.startsWith('artifacts/tests/'));
  if (!declared) throw new Error(`${task.id}: declares no artifacts/tests output to report into`);
  return declared;
}

export function taskTimeoutMs(root: string, task: TaskRecord): number {
  const profile = profileFor(root, task.profile);
  // A file can contain many serial cases and explicit longer journey bounds.
  const budget = task.taskTimeoutMs ?? profile.taskTimeoutMs;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 90 * 60_000)
    throw new Error(task.id + ': invalid whole-task timeout');
  return budget;
}

async function executeVitest(
  root: string,
  task: TaskRecord & { kind: 'vitest' },
): Promise<{ cases: readonly CaseResult[]; passed: boolean; durationMs: number }> {
  const profile = profileFor(root, task.profile),
    bounds = vitestBounds(profile, task.workerLimit);
  const cwd = resolve(root, task.project),
    config = task.project === '.' ? 'vitest.tools.config.mts' : 'vitest.config.mts';
  const temporary = mkdtempSync(resolve(tmpdir(), 'ia-task-report-'));
  const output = resolve(temporary, 'vitest.json');
  try {
    const result = await runBounded(
      process.execPath,
      [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--testTimeout',
        String(bounds.testTimeout),
        '--hookTimeout',
        String(bounds.hookTimeout),
        '--maxWorkers',
        String(bounds.maxWorkers),
        '--no-file-parallelism',
        '--retry',
        '0',
        '--reporter',
        'default',
        '--reporter',
        'json',
        '--outputFile.json',
        output,
        ...task.files,
      ],
      {
        cwd,
        timeoutMs: taskTimeoutMs(root, task),
        env: vitestEnvironment(profile),
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
      },
    );
    const diagnostics = resolve(root, artifactDirectory(task));
    mkdirSync(diagnostics, { recursive: true });
    writeFileSync(resolve(diagnostics, 'output.log'), result.stdout + '\n' + result.stderr);
    if (existsSync(output)) copyFileSync(output, resolve(diagnostics, 'vitest.json'));
    if (result.timedOut)
      throw new Error(`${task.id}: exceeded its ${taskTimeoutMs(root, task)}ms ceiling\n${result.stderr.slice(-4000)}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(output, 'utf8')) as unknown;
    } catch {
      throw new Error(`${task.id}: produced no machine-readable result\n${result.stderr.slice(-4000)}`);
    }
    const parsed = readVitestResults(root, task.project, raw);
    return { cases: parsed.cases, passed: parsed.success && result.status === 0, durationMs: result.durationMs };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function executeCommand(
  root: string,
  task: TaskRecord & { kind: 'command' },
): Promise<{ cases: readonly CaseResult[]; passed: boolean; durationMs: number; log: string }> {
  const result = await runBounded(task.command, [], {
    cwd: resolve(root, task.project),
    timeoutMs: taskTimeoutMs(root, task),
    shell: true,
    env: { ...process.env, CI: process.env['CI'] ?? '1' },
  });
  const passed = !result.timedOut && result.status === 0;
  if (!passed) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  return {
    cases: [
      {
        id: `${task.id} > ${task.command}`,
        file: task.project,
        status: passed ? 'passed' : 'failed',
        durationMs: result.durationMs,
      },
    ],
    passed,
    durationMs: result.durationMs,
    log: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

export async function runTask(root: string, id: string): Promise<GateEvidence> {
  const manifest = readManifest(root),
    task = (manifest.tasks ?? []).find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown task ${id}`);
  const platform = currentPlatform();
  if (!task.platforms.includes(platform)) throw new Error(`${id} does not run on ${platform}`);
  const startedAt = new Date().toISOString();
  const outcome =
    task.kind === 'vitest'
      ? { ...(await executeVitest(root, task)), log: undefined }
      : await executeCommand(root, task);
  const report = buildReport(task, {
    ...outcome,
    startedAt,
    commit: headCommit(root),
    run: process.env['GITHUB_RUN_ID'] ?? null,
  });
  const evidence: GateEvidence = {
    version: report.version,
    task: task.id,
    platform,
    outcome: 'executed',
    source: 'execution',
    hash: process.env['NX_TASK_HASH'] ?? process.env['IA_TASK_HASH'] ?? null,
    orchestration: process.env['IA_TEST_ORCHESTRATION'] ?? null,
    current: { run: process.env['GITHUB_RUN_ID'] ?? null, commit: headCommit(root) },
    provenanceAvailable: true,
    report,
  };
  const directory = resolve(root, artifactDirectory(task));
  mkdirSync(directory, { recursive: true });
  writeEvidence(resolve(directory, 'evidence.json'), evidence);
  if (outcome.log !== undefined) writeFileSync(resolve(directory, 'output.log'), outcome.log);
  return evidence;
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2),
    index = args.indexOf('--task');
  const id = index < 0 ? undefined : args[index + 1];
  if (!id || args.length !== 2) {
    console.error('Usage: pnpm tests:run --task <id>');
    process.exitCode = 2;
  } else {
    const root = resolve(import.meta.dirname, '../..');
    runTask(root, id)
      .then((evidence) => {
        const { counts, status, durationMs } = evidence.report;
        console.log(`${id}: ${status} (${counts.passed}/${counts.total} cases, ${Math.round(durationMs / 1000)}s)`);
        if (status !== 'passed') process.exitCode = 1;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
