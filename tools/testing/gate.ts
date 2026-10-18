import { resolve } from 'node:path';
import { PLATFORMS, readManifest, type Manifest, type Platform, type TaskRecord } from './manifest.js';
import { REPORT_VERSION, readEvidence, type GateEvidence } from './evidence.js';

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
