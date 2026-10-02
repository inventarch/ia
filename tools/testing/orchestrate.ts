import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { randomUUID } from 'node:crypto';
import { readManifest, type TaskRecord } from './inventory.js';
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

/**
 * A cache transport failure and a failing test are different events. Nx reports both through the
 * same exit code, so the transport signal is taken from its diagnostics, never from the test result.
 */
export function looksLikeCacheTransportFailure(output: string): boolean {
  // A test can itself fail with ETIMEDOUT/ECONNREFUSED or HTTP 401. Only cache-specific
  // diagnostics justify retrying the entire requested task set without the transport.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  return (
    /^\s*NX\s+Failed to unpack entry:/im.test(plain) ||
    /(?:failed|error|unable|cannot)[^\n]*(?:remote cache|cache server|NX_SELF_HOSTED_REMOTE_CACHE)|(?:remote cache|cache server|NX_SELF_HOSTED_REMOTE_CACHE)[^\n]*(?:failed|error|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|401|403)/i.test(
      plain,
    )
  );
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
    };
    if (!withRemote) {
      delete env[CACHE_SERVER_VARIABLE];
      delete env[CACHE_TOKEN_VARIABLE];
    }
    return runBounded(
      'npx',
      [
        'nx',
        'run-many',
        '--targets',
        targets.join(','),
        '--output-style',
        'stream',
        ...(skipCache ? ['--skip-nx-cache'] : []),
      ],
      {
        cwd: root,
        shell: true,
        timeoutMs: options.timeoutMs ?? 90 * 60_000,
        env,
        onStdout: (chunk) => process.stdout.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
      },
    );
  };

  let remote: OrchestrationResult['remote'] = remoteWanted ? 'enabled' : 'disabled';
  let result = await invoke(remoteWanted);
  // Nx can print a successful summary after an unpack failure while skipping dependants.
  // Retry once without either cache, including a partially unpacked local entry.
  if (!options.full && looksLikeCacheTransportFailure(`${result.stdout}\n${result.stderr}`)) {
    if (remoteWanted) remote = 'retired-after-transport-failure';
    console.error(
      'Cache restoration failed; retrying with all cache reuse disabled. The original diagnostics appear above.',
    );
    result = await invoke(false, true);
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
  const args = process.argv.slice(2),
    root = resolve(import.meta.dirname, '../..');
  const flag = (name: string): string | undefined => {
    const position = args.indexOf(name);
    return position < 0 ? undefined : args[position + 1];
  };
  const listed = flag('--tasks'),
    out = flag('--evidence-out');
  const known = ['--tasks', '--evidence-out', '--full', '--remote', '--json'];
  const valued = ['--tasks', '--evidence-out'];
  const stray = args.filter((arg, position) =>
    arg.startsWith('--') ? !known.includes(arg) : !(position > 0 && valued.includes(args[position - 1] ?? '')),
  );
  if (!listed || stray.length) {
    console.error(
      'Usage: pnpm tests:orchestrate --tasks "<id> <id>" [--evidence-out <directory>] [--remote] [--full] [--json]',
    );
    process.exitCode = 2;
  } else {
    orchestrate(root, {
      tasks: listed.split(/\s+/).filter(Boolean),
      full: args.includes('--full'),
      remote: args.includes('--remote'),
      ...(out === undefined ? {} : { evidenceOut: out }),
    })
      .then((result) => {
        if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
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
