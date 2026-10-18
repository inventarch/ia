import { mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DeclaredSkip, Mode, Platform, TaskRecord } from './manifest.js';

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
