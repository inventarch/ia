import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { parseOptions } from '../shared/args.mjs';
import { PLATFORMS, type Platform, type TaskRecord } from './manifest.js';
import { REPORT_VERSION, type RuntimeIdentity, type CaseStatus, type CaseResult, type TaskReport } from './evidence.js';
import { runGate } from './gate.js';
export * from './evidence.js';
export * from './gate.js';

export function currentPlatform(value: NodeJS.Platform = process.platform): Platform {
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  if (value === 'darwin') return 'macos';
  throw new Error(`Unsupported test platform ${value}; results never substitute across platforms`);
}

/** Probe the fixture's file-symlink operation; only Windows EPERM means unavailable. */
export function fileSymlinksAvailable(): boolean {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(resolve(parent, 'ia-file-symlink-capability-'));
  try {
    const target = resolve(directory, 'target.txt');
    writeFileSync(target, 'probe');
    try {
      symlinkSync(target, resolve(directory, 'link.txt'), 'file');
      return true;
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
      throw error;
    }
  } finally {
    if (dirname(directory) !== parent) throw new Error('Unexpected capability probe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runtimeIdentity(): RuntimeIdentity {
  return {
    platform: currentPlatform(),
    arch: process.arch,
    node: process.version,
    abi: process.versions.modules,
    osRelease: release(),
    runnerImage: process.env['ImageOS'] ?? process.env['RUNNER_IMAGE'] ?? null,
    fileSymlinks: fileSymlinksAvailable(),
  };
}

export function headCommit(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim() || null;
  } catch {
    return null;
  }
}

interface VitestAssertion {
  readonly fullName?: unknown;
  readonly status?: unknown;
  readonly duration?: unknown;
}
interface VitestFile {
  readonly name?: unknown;
  readonly assertionResults?: unknown;
}
interface VitestJson {
  readonly testResults?: unknown;
  readonly success?: unknown;
}

const CASE_STATUS: Readonly<Record<string, CaseStatus>> = {
  passed: 'passed',
  failed: 'failed',
  pending: 'skipped',
  skipped: 'skipped',
  todo: 'todo',
};

/** Converts Vitest's JSON reporter output into the versioned task report the gate consumes. */
export function readVitestResults(
  root: string,
  projectDirectory: string,
  json: unknown,
): { readonly cases: readonly CaseResult[]; readonly success: boolean } {
  const value = json as VitestJson;
  if (!Array.isArray(value?.testResults)) throw new Error('Vitest produced no file results');
  const base = resolve(root, projectDirectory),
    cases: CaseResult[] = [];
  for (const entry of value.testResults as readonly VitestFile[]) {
    if (typeof entry?.name !== 'string' || !Array.isArray(entry.assertionResults))
      throw new Error('Malformed Vitest file result');
    const file = resolve(entry.name)
      .slice(base.length + 1)
      .replaceAll('\\', '/');
    for (const assertion of entry.assertionResults as readonly VitestAssertion[]) {
      const status = CASE_STATUS[String(assertion?.status)];
      if (typeof assertion?.fullName !== 'string' || !status)
        throw new Error(`Malformed Vitest case result in ${file}`);
      cases.push({
        id: `${file} > ${assertion.fullName}`,
        file,
        status,
        durationMs: typeof assertion.duration === 'number' ? assertion.duration : null,
      });
    }
  }
  return { cases: cases.sort((a, b) => a.id.localeCompare(b.id)), success: value.success === true };
}

export function buildReport(
  task: TaskRecord,
  input: {
    readonly cases: readonly CaseResult[];
    readonly passed: boolean;
    readonly durationMs: number;
    readonly startedAt: string;
    readonly commit: string | null;
    readonly run: string | null;
    readonly backend?: string | null;
  },
): TaskReport {
  const counts = { total: input.cases.length, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const entry of input.cases) counts[entry.status] += 1;
  return {
    version: REPORT_VERSION,
    task: task.id,
    kind: task.kind,
    profile: task.profile,
    inputProfile: task.inputProfile,
    mode: task.mode,
    platform: currentPlatform(),
    backend: input.backend ?? null,
    files: task.kind === 'vitest' ? [...task.files].sort() : [],
    cases: input.cases,
    counts,
    allowedSkips: task.skips ?? [],
    status: input.passed && counts.failed === 0 ? 'passed' : 'failed',
    durationMs: input.durationMs,
    execution: { commit: input.commit, run: input.run, startedAt: input.startedAt, runtime: runtimeIdentity() },
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..');
  let options: ReturnType<typeof parseOptions> | undefined;
  try {
    options = parseOptions(process.argv.slice(2), { values: ['evidence', 'platform'], booleans: ['json'] });
  } catch (error) {
    console.error(
      'Usage: pnpm tests:gate [--evidence <directory>] [--platform <' + PLATFORMS.join('|') + '>] [--json]',
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options)
    try {
      const directory = options.value('evidence') ?? 'artifacts/tests';
      const platform = options.has('platform') ? [options.value('platform') as Platform] : undefined;
      if (platform && !PLATFORMS.includes(platform[0]!)) throw new Error(`Unknown platform ${String(platform[0])}`);
      const result = runGate(root, directory, platform);
      if (options.has('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `Gate: ${result.received}/${result.expected} required task results, ${result.executed} executed and ${result.restored} restored.`,
        );
        for (const finding of result.findings) console.error(finding);
        console.log(
          result.findings.length
            ? `FAIL: ${result.findings.length} findings.`
            : 'PASS: the received results cover the required task set exactly.',
        );
      }
      if (result.findings.length) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
