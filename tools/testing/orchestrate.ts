import { qualificationPath } from '../shared/qualification-path.mjs';
import { parseOptions } from '../shared/args.mjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { randomUUID } from 'node:crypto';
import { readManifest, type TaskRecord } from './manifest.js';
import { currentPlatform, headCommit, type EvidenceSource, type GateEvidence } from './report.js';
import { runBounded } from './subprocess.js';
import { artifactDirectory } from './run.js';

/**
 * Schedules declared tasks through Nx, then labels each result as executed or restored for the
 * current-run gate. A cache miss is executed work; nothing here may omit a required task, and a
 * cache transport failure is never reported as a test failure.
 */

export const CACHE_SERVER_VARIABLE = 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER';
export const CACHE_TOKEN_VARIABLE = 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN';

export interface OrchestrationOptions {
  readonly tasks: readonly string[];
  /** Bypasses both local and remote reuse; scheduled and manual full runs use it. */
  readonly full?: boolean;
  /** Remote reuse is opt-in and additionally requires the server variable to be present. */
  readonly remote?: boolean;
  readonly timeoutMs?: number;
  /**
   * Collects evidence for exactly the requested tasks. Nx may rebuild a dependency inside this job;
   * publishing only the assignment keeps two jobs from claiming the same task variant at the gate.
   */
  readonly evidenceOut?: string;
  /**
   * How many of the requested tasks Nx may run at once. Absent, nx.json's `parallel` (1) holds and a shard runs its
   * tasks one after another, as the execution contract states; a dispatched experiment may set 2 to 4.
   */
  readonly parallel?: number;
}
export interface OrchestrationResult {
  readonly version: number;
  readonly platform: string;
  readonly requested: readonly string[];
  readonly executed: readonly string[];
  readonly restored: readonly string[];
  readonly missing: readonly string[];
  readonly remote: 'disabled' | 'enabled' | 'retired-after-transport-failure';
  readonly status: 'passed' | 'failed';
  readonly limitations: readonly string[];
}

/** Local cache entry names before a run, so a restoration can be attributed to local or remote reuse. */
function cacheEntries(root: string): ReadonlySet<string> {
  const directory = process.env['NX_CACHE_DIRECTORY'] ?? resolve(root, '.nx/cache');
  try {
    return new Set(readdirSync(resolve(root, directory)));
  } catch {
    return new Set();
  }
}

export function nxTargetsFor(root: string, ids: readonly string[]): readonly string[] {
  const tasks = readManifest(root).tasks ?? [];
  return ids.map((id) => {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw new Error(`Unknown task ${id}`);
    return task.id.replace(':', '-');
  });
}

function taskFor(root: string, id: string): TaskRecord {
  const task = (readManifest(root).tasks ?? []).find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function readEvidenceFile(path: string): GateEvidence | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GateEvidence;
  } catch {
    return undefined;
  }
}

/** The most tasks one shard may run at once in an experiment. */
export const MAX_PARALLEL = 4;

/** `--parallel` as given: an integer from 1 to MAX_PARALLEL, else a refusal naming the range. */
export function parallelOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > MAX_PARALLEL)
    throw new Error(`--parallel expects an integer from 1 to ${MAX_PARALLEL}`);
  return Number(value);
}

/** The `nx run-many` arguments for one invocation: `--parallel` only when an experiment set it. */
export function runManyArgs(targets: readonly string[], skipCache: boolean, parallel?: number): readonly string[] {
  return [
    'nx',
    'run-many',
    '--targets',
    targets.join(','),
    '--output-style',
    'stream',
    ...(skipCache ? ['--skip-nx-cache'] : []),
    ...(parallel === undefined ? [] : ['--parallel', String(parallel)]),
  ];
}

/*
 * The errors Nx 23.2.1's self-hosted remote cache client raises (nx/src/native/cache/errors.rs and
 * http_remote_cache.rs). A failed restore aborts Nx's whole run with the error as its last `NX` banner; a failed store
 * fails a task that passed, with the error as the task's output (nx/src/tasks-runner/task-orchestrator.js,
 * handleDiscreteWorkerFailure). Nx prints both at the start of a line, while every line a task prints as it runs
 * carries its project prefix under `--output-style stream`. A task restored from a cache replays its output without
 * that prefix, so the two generic phrases are tied to the cache: a failed request names the cache's URL path, and
 * a refused token counts only as Nx's banner.
 */

/** Errors that write nothing locally: a request that never completed, a refused token, an unexpected status, or a
 * response body that broke before anything was unpacked. */
const NX_REMOTE_REQUEST_ERROR =
  /^[ \t]*(?:NX[ \t]+Unauthorized:|(?:NX[ \t]+)?(?:Failed to send request: [^\n]*\/v1\/cache\/|Misconfigured remote cache endpoint:|Failed to read remote cache response body:))/m;

/** A download that broke while it was unpacked, which may leave a partly unpacked local entry. */
const NX_REMOTE_DOWNLOAD_ERROR =
  /^[ \t]*(?:NX[ \t]+)?(?:(?:Failed to unpack entry|Invalid entry path in cache artifact|Refusing to extract cache entry with unsafe path):|(?:Failed to read entr(?:y|ies) from tarball|Invalid exit code in cache artifact|Exit code not found in cache artifact)[ \t]*$)/m;

/** Older wording rule; it is not anchored to a line start. */
const CACHE_FAILURE_WORDING =
  /(?:failed|error|unable|cannot)[^\n]*(?:remote cache|cache server|NX_SELF_HOSTED_REMOTE_CACHE)|(?:remote cache|cache server|NX_SELF_HOSTED_REMOTE_CACHE)[^\n]*(?:failed|error|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|401|403)/i;

/**
 * A cache transport failure and a failing test are different events. Nx reports both through the
 * same exit code, so the transport signal is taken from its diagnostics, never from the test result.
 * Returns the first line that names the failure, without Nx's banner, and whether the local cache is still sound:
 * Nx keeps a finished task in the local cache before it uploads it, so only an unpacked download can spoil it.
 */
function cacheFailure(output: string): { readonly diagnostic: string; readonly keepLocal: boolean } | undefined {
  // A test can itself fail with ETIMEDOUT/ECONNREFUSED or HTTP 401. Only cache-specific
  // diagnostics justify retrying the entire requested task set without the transport.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const matches = [NX_REMOTE_REQUEST_ERROR, NX_REMOTE_DOWNLOAD_ERROR, CACHE_FAILURE_WORDING]
    .map((rule) => rule.exec(plain))
    .filter((match) => match !== null);
  if (!matches.length) return undefined;
  const first = Math.min(...matches.map((match) => match.index));
  const end = plain.indexOf('\n', first);
  return {
    diagnostic: plain
      .slice(plain.lastIndexOf('\n', first) + 1, end === -1 ? undefined : end)
      .trim()
      .replace(/^NX\s+/, ''),
    keepLocal: NX_REMOTE_REQUEST_ERROR.test(plain) && !NX_REMOTE_DOWNLOAD_ERROR.test(plain),
  };
}

export function looksLikeCacheTransportFailure(output: string): boolean {
  return cacheFailure(output) !== undefined;
}

/** A GitHub Actions workflow command's message, escaped as the runner reads it. */
function workflowMessage(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export async function orchestrate(root: string, options: OrchestrationOptions): Promise<OrchestrationResult> {
  if (!options.tasks.length) throw new Error('Orchestration requires at least one task');
  const platform = currentPlatform(),
    orchestration = randomUUID();
  const targets = nxTargetsFor(root, options.tasks);
  const before = cacheEntries(root);
  const server = process.env[CACHE_SERVER_VARIABLE];
  const remoteWanted = options.remote === true && !options.full && !!server;
  if (!remoteWanted) {
    console.log(
      'Remote cache disabled:',
      options.full
        ? 'full verification requested'
        : !options.remote
          ? '--remote was not requested'
          : 'server URL is not configured',
    );
  } else if (!process.env[CACHE_TOKEN_VARIABLE]) {
    throw new Error('Remote caching requested without an access token');
  }

  const invoke = async (withRemote: boolean, skipCache = options.full === true) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: process.env['CI'] ?? '1',
      IA_TEST_ORCHESTRATION: orchestration,
      IA_QUALIFICATION_MANIFEST: qualificationPath(root, orchestration),
    };
    if (!withRemote) {
      delete env[CACHE_SERVER_VARIABLE];
      delete env[CACHE_TOKEN_VARIABLE];
    }
    return runBounded('npx', [...runManyArgs(targets, skipCache, options.parallel)], {
      cwd: root,
      shell: true,
      timeoutMs: options.timeoutMs ?? 90 * 60_000,
      env,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
  };

  let remote: OrchestrationResult['remote'] = remoteWanted ? 'enabled' : 'disabled';
  let result = await invoke(remoteWanted);
  // Nx can print a successful summary after an unpack failure while skipping dependants, and one failed remote
  // request aborts its whole run or fails a task that passed. Retry once without the remote cache. After a broken
  // download, retry without the local cache too, which may hold a partially unpacked entry; otherwise keep it, so
  // a long shard does not run its finished cacheable tasks twice.
  const failure = options.full ? undefined : cacheFailure(`${result.stdout}\n${result.stderr}`);
  if (failure !== undefined) {
    if (remoteWanted) remote = 'retired-after-transport-failure';
    // A test that runs this orchestrator inside an outer run streams these lines into that run's output, so the retry
    // line never pairs "remote cache" with a failure word, which the older wording rule would read as a diagnostic.
    // The annotation quotes Nx, so it can, for example for a 500.
    const retry = failure.keepLocal ? 'remote reuse disabled and the local cache kept' : 'all cache reuse disabled';
    console.error(`A cache transfer failed; retrying with ${retry}. The original diagnostics appear above.`);
    // A passing retry leaves the job green, so the reason goes to the run's annotations: a cache that keeps failing
    // then shows on the run page instead of only making every run slower.
    if (process.env['GITHUB_ACTIONS'] === 'true')
      console.log(
        `::warning title=Nx cache fallback::${workflowMessage(`Nx reported "${failure.diagnostic}"; running the requested tasks again with ${retry}.`)}`,
      );
    result = await invoke(false, !failure.keepLocal);
  }

  const after = cacheEntries(root);
  const executed: string[] = [],
    restored: string[] = [],
    missing: string[] = [];
  const commit = headCommit(root),
    run = process.env['GITHUB_RUN_ID'] ?? null;
  for (const id of options.tasks) {
    const task = taskFor(root, id),
      path = resolve(root, artifactDirectory(task), 'evidence.json');
    const evidence = readEvidenceFile(path);
    if (!evidence) {
      missing.push(id);
      continue;
    }
    // Wall clocks can move backwards; only the runner's invocation token identifies fresh work.
    // The token is deliberately absent from task hash inputs so identical work remains reusable.
    const ranHere = evidence.orchestration === orchestration;
    const hash = evidence.hash;
    const source: EvidenceSource = ranHere
      ? 'execution'
      : hash && before.has(hash)
        ? 'local-cache'
        : remote === 'disabled'
          ? 'local-cache'
          : 'remote-cache';
    if (!ranHere && hash && !before.has(hash) && !after.has(hash))
      missing.push(`${id}: restored without a recorded cache entry`);
    (ranHere ? executed : restored).push(id);
    const labelled: GateEvidence = {
      ...evidence,
      outcome: ranHere ? 'executed' : 'restored',
      source,
      provenanceAvailable: evidence.report.execution.commit !== null || evidence.report.execution.run !== null,
      current: { run, commit },
    };
    writeFileSync(path, JSON.stringify(labelled, null, 2) + '\n');
    if (options.evidenceOut !== undefined) {
      const collected = resolve(root, options.evidenceOut, id.replace(':', '-'));
      mkdirSync(collected, { recursive: true });
      writeFileSync(resolve(collected, 'evidence.json'), JSON.stringify(labelled, null, 2) + '\n');
      for (const file of ['output.log', 'vitest.json']) {
        const diagnostic = resolve(root, artifactDirectory(task), file);
        if (existsSync(diagnostic)) copyFileSync(diagnostic, resolve(collected, file));
      }
    }
  }
  return {
    version: 1,
    platform,
    requested: options.tasks,
    executed,
    restored,
    missing,
    remote,
    status: result.status === 0 && !missing.length ? 'passed' : 'failed',
    limitations: [
      'Execution attribution uses the runner orchestration token; older evidence without a token is treated as restored.',
      'Local and remote attribution uses the cache entries present before the run; a concurrent job can blur it.',
      'A passing orchestration is not the gate; the gate compares the received set against the required one.',
    ],
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..'),
    argv = process.argv.slice(2);
  let options: ReturnType<typeof parseOptions> | undefined,
    parallel: number | undefined,
    invalidParallel: string | undefined;
  try {
    // A trailing --parallel with no value is refused like a wrong one, never read as absent.
    if (argv.at(-1) === '--parallel') parallelOf('');
    options = parseOptions(argv, {
      values: ['tasks', 'evidence-out', 'parallel'],
      booleans: ['full', 'remote', 'json'],
      required: ['tasks'],
    });
    parallel = parallelOf(options.value('parallel'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('--parallel ')) invalidParallel = message;
    /* any other refusal is the usage below */
  }
  const listed = options?.value('tasks'),
    out = options?.value('evidence-out');
  if (invalidParallel === undefined && (!options || !listed)) {
    console.error(
      `Usage: pnpm tests:orchestrate --tasks "<id> <id>" [--evidence-out <directory>] [--remote] [--full] [--parallel 1-${MAX_PARALLEL}] [--json]`,
    );
    process.exitCode = 2;
  } else if (invalidParallel !== undefined || !options || !listed) {
    console.error(invalidParallel);
    process.exitCode = 2;
  } else {
    orchestrate(root, {
      tasks: listed.split(/\s+/).filter(Boolean),
      full: options.has('full'),
      remote: options.has('remote'),
      ...(out === undefined ? {} : { evidenceOut: out }),
      ...(parallel === undefined ? {} : { parallel }),
    })
      .then((result) => {
        if (options.has('json')) console.log(JSON.stringify(result, null, 2));
        else
          console.log(
            `Orchestration ${result.status}: ${result.executed.length} executed, ${result.restored.length} restored, remote ${result.remote}.${result.missing.length ? ` Missing: ${result.missing.join(', ')}` : ''}`,
          );
        if (result.status !== 'passed') process.exitCode = 1;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
