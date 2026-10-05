import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import {
  PLATFORMS,
  readManifest,
  type DeclaredSkip,
  type Manifest,
  type Mode,
  type Platform,
  type TaskRecord,
} from './inventory.js';

export const REPORT_VERSION = 1;
export type CaseStatus = 'passed' | 'failed' | 'skipped' | 'todo';
export type Outcome = 'executed' | 'restored';
export type EvidenceSource = 'execution' | 'local-cache' | 'remote-cache';

export interface RuntimeIdentity {
  readonly platform: Platform;
  readonly arch: string;
  readonly node: string;
  /** Node's ABI version; a native addon built for another ABI is not the same runtime. */
  readonly abi: string;
  readonly osRelease: string;
  readonly runnerImage: string | null;
  /** Absent on legacy reports; conditional skip evidence must not infer it. */
  readonly fileSymlinks?: boolean;
}
export interface ExecutionProvenance {
  readonly commit: string | null;
  readonly run: string | null;
  readonly startedAt: string;
  readonly runtime: RuntimeIdentity;
}
export interface CaseResult {
  readonly id: string;
  readonly file: string;
  readonly status: CaseStatus;
  readonly durationMs: number | null;
}
export interface TaskReport {
  readonly version: number;
  readonly task: string;
  readonly kind: TaskRecord['kind'];
  readonly profile: string;
  readonly inputProfile: string;
  readonly mode: Mode;
  readonly platform: Platform;
  readonly backend: string | null;
  readonly files: readonly string[];
  readonly cases: readonly CaseResult[];
  readonly counts: Readonly<Record<'total' | 'passed' | 'failed' | 'skipped' | 'todo', number>>;
  readonly allowedSkips: readonly DeclaredSkip[];
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly execution: ExecutionProvenance;
}
export interface GateEvidence {
  readonly version: number;
  readonly task: string;
  readonly platform: Platform;
  readonly outcome: Outcome;
  readonly source: EvidenceSource;
  readonly hash: string | null;
  /** Identifies the orchestration that executed this result; retained on cache restoration. */
  readonly orchestration?: string | null;
  readonly current: { readonly run: string | null; readonly commit: string | null };
  /** False when a restored report carries no original writer identity; never inferred as current. */
  readonly provenanceAvailable: boolean;
  readonly report: TaskReport;
}

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

export function writeEvidence(path: string, evidence: GateEvidence): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
}

/** Reads every evidence file under a directory tree. Unreadable or mistyped files are reported, never skipped. */
export function readEvidence(directory: string): {
  readonly evidence: readonly GateEvidence[];
  readonly failures: readonly string[];
} {
  const evidence: GateEvidence[] = [],
    failures: string[] = [];
  const walk = (path: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'evidence.json') continue;
      try {
        const value = JSON.parse(readFileSync(child, 'utf8')) as GateEvidence;
        if (
          value?.version !== REPORT_VERSION ||
          typeof value.task !== 'string' ||
          value.report?.version !== REPORT_VERSION
        )
          throw new Error('unsupported evidence version');
        evidence.push(value);
      } catch (error) {
        failures.push(`${child}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  walk(directory);
  return {
    evidence: evidence.sort((a, b) => a.task.localeCompare(b.task) || a.platform.localeCompare(b.platform)),
    failures,
  };
}

export interface ExpectedTask {
  readonly task: string;
  readonly platform: Platform;
  readonly kind: TaskRecord['kind'];
}

/** The complete task/variant set the planner requires for this checkout. */
export function expectedTasks(manifest: Manifest, platforms: readonly Platform[] = PLATFORMS): readonly ExpectedTask[] {
  const expected: ExpectedTask[] = [];
  for (const task of manifest.tasks ?? [])
    for (const platform of task.platforms ?? []) {
      if (platforms.includes(platform)) expected.push({ task: task.id, platform, kind: task.kind });
    }
  return expected.sort((a, b) => a.task.localeCompare(b.task) || a.platform.localeCompare(b.platform));
}

/**
 * Compares received evidence against the exact expected set. A cache miss is executed work, so a
 * missing entry is always a failure; it is never permission to omit a task.
 */
export function gateFindings(
  expected: readonly ExpectedTask[],
  received: readonly GateEvidence[],
  readFailures: readonly string[] = [],
): readonly string[] {
  const findings = [...readFailures.map((failure) => `Unreadable evidence: ${failure}`)];
  const key = (task: string, platform: string): string => `${task}@${platform}`;
  const byKey = new Map<string, GateEvidence[]>();
  for (const entry of received) {
    const group = byKey.get(key(entry.task, entry.platform)) ?? [];
    group.push(entry);
    byKey.set(key(entry.task, entry.platform), group);
  }
  const wanted = new Set(expected.map((entry) => key(entry.task, entry.platform)));
  for (const entry of expected) {
    const group = byKey.get(key(entry.task, entry.platform)) ?? [];
    if (!group.length) {
      findings.push(`${entry.task} (${entry.platform}): no result reached the gate`);
      continue;
    }
    if (group.length > 1)
      findings.push(`${entry.task} (${entry.platform}): ${group.length} results claim the same task variant`);
    for (const evidence of group) {
      const label = `${entry.task} (${entry.platform})`;
      if (evidence.report.status !== 'passed') findings.push(`${label}: reported ${evidence.report.status}`);
      if (evidence.report.counts.failed > 0) findings.push(`${label}: ${evidence.report.counts.failed} failed cases`);
      if (evidence.report.platform !== entry.platform)
        findings.push(`${label}: report claims platform ${evidence.report.platform}`);
      if (evidence.outcome === 'restored' && !evidence.hash)
        findings.push(`${label}: restored without a computation hash`);
      if (evidence.outcome === 'restored' && evidence.source === 'execution')
        findings.push(`${label}: restored result labelled as execution`);
      if (evidence.outcome === 'executed' && evidence.source !== 'execution')
        findings.push(`${label}: executed result labelled as ${evidence.source}`);
      if (entry.kind === 'vitest') {
        if (evidence.report.counts.total === 0) findings.push(`${label}: a test task that ran no case cannot pass`);

        // A conditional skip requires the original execution's observed capability.
        const scoped = evidence.report.allowedSkips.filter(
          (skip) => !skip.platforms || skip.platforms.includes(entry.platform),
        );
        const applicable = scoped.filter((skip) => {
          if (skip.when === undefined) return true;
          if (skip.when !== 'file-symlink-unavailable') {
            findings.push(label + ': unknown skip condition ' + String(skip.when));
            return false;
          }
          const available = evidence.report.execution.runtime.fileSymlinks;
          if (typeof available !== 'boolean') {
            findings.push(label + ': ' + skip.case + ' requires file-symlink capability evidence');
            return false;
          }
          return !available;
        });
        const allowed = new Map(applicable.map((skip) => [skip.case, skip]));
        for (const result of evidence.report.cases) {
          if (
            (result.status === 'skipped' || result.status === 'todo') &&
            (!allowed.has(result.id) || (result.status === 'todo' && allowed.get(result.id)?.when !== undefined))
          )
            findings.push(label + ': unexpected skip ' + result.id);
        }
        for (const skip of scoped) {
          const observed = evidence.report.cases.find((result) => result.id === skip.case);
          if (!observed) findings.push(label + ': declared skip ' + skip.case + ' was not observed');
          else if (
            skip.when === 'file-symlink-unavailable' &&
            evidence.report.execution.runtime.fileSymlinks === true &&
            observed.status !== 'passed'
          )
            findings.push(label + ': ' + skip.case + ' must pass when file symlinks are available');
          else if (
            applicable.includes(skip) &&
            observed.status !== 'skipped' &&
            (skip.when !== undefined || observed.status !== 'todo')
          )
            findings.push(
              label +
                ': ' +
                skip.case +
                ' is declared skipped on ' +
                entry.platform +
                ' but reported ' +
                observed.status,
            );
        }
      }
    }
  }
  for (const entry of received) {
    if (!wanted.has(key(entry.task, entry.platform)))
      findings.push(`${entry.task} (${entry.platform}): result for a task the planner did not require`);
  }
  return [...new Set(findings)].sort();
}

export interface GateResult {
  readonly version: number;
  readonly expected: number;
  readonly received: number;
  readonly executed: number;
  readonly restored: number;
  readonly unavailableProvenance: number;
  readonly findings: readonly string[];
  readonly limitations: readonly string[];
}

export function runGate(root: string, directory: string, platforms?: readonly Platform[]): GateResult {
  const manifest = readManifest(root),
    expected = expectedTasks(manifest, platforms);
  const { evidence, failures } = readEvidence(resolve(root, directory));
  return {
    version: REPORT_VERSION,
    expected: expected.length,
    received: evidence.length,
    executed: evidence.filter((entry) => entry.outcome === 'executed').length,
    restored: evidence.filter((entry) => entry.outcome === 'restored').length,
    unavailableProvenance: evidence.filter((entry) => !entry.provenanceAvailable).length,
    findings: gateFindings(expected, evidence, failures),
    limitations: [
      'The gate checks the received task set, not whether a restored result was computed from complete inputs.',
      'A restored report keeps its original execution provenance; that commit is not this run.',
      'Evidence is trusted only as far as the cache boundary that produced it is qualified.',
    ],
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2),
    root = resolve(import.meta.dirname, '../..');
  const directoryFlag = args.indexOf('--evidence'),
    platformFlag = args.indexOf('--platform');
  const known = new Set(['--json', '--evidence', '--platform']);
  const stray = args.filter((arg, index) =>
    arg.startsWith('--') ? !known.has(arg) : !(index > 0 && ['--evidence', '--platform'].includes(args[index - 1]!)),
  );
  if (stray.length) {
    console.error(`Usage: pnpm tests:gate [--evidence <directory>] [--platform <${PLATFORMS.join('|')}>] [--json]`);
    process.exitCode = 2;
  } else
    try {
      const directory = directoryFlag < 0 ? 'artifacts/tests' : (args[directoryFlag + 1] ?? '');
      const platform = platformFlag < 0 ? undefined : [args[platformFlag + 1] as Platform];
      if (platform && !PLATFORMS.includes(platform[0]!)) throw new Error(`Unknown platform ${String(platform[0])}`);
      const result = runGate(root, directory, platform);
      if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
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
