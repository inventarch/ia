import { canonicalPath } from '../../packages/language/src/index.js';
import type { CompiledRecord } from '../../packages/language/src/index.js';

export interface ArchitectureFinding {
  readonly code:
    | 'IA-NATIVE-EXAMPLE-PLACEMENT'
    | 'IA-NATIVE-WORK-PLACEMENT'
    | 'IA-NATIVE-RELEASE-POLICY-SOURCE'
    | 'IA-NATIVE-RELEASE-POLICY-STATUS'
    | 'IA-NATIVE-RELEASE-WORKFLOW';
  readonly severity: 'error';
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

const WORK_INSTANCES = new Set(['plan', 'milestone', 'task', 'decision']);
function value(record: CompiledRecord, key: string) {
  const field = record.sections
    .filter((section) => section.name === 'work')
    .flatMap((section) => section.fields)
    .find((field) => 'key' in field && field.key === key);
  return field !== undefined && 'key' in field ? field.value : undefined;
}
function text(record: CompiledRecord, key: string): string | undefined {
  const field = value(record, key);
  return field !== undefined && 'text' in field ? field.text : undefined;
}
function source(record: CompiledRecord): string | undefined {
  const field = record.sections
    .filter((section) => section.name === 'work')
    .flatMap((section) => section.fields)
    .find((field) => 'key' in field && field.key === 'source');
  if (field === undefined || !('key' in field) || !('text' in field.value)) return undefined;
  return canonicalPath(field.value.text.split('#')[0]!.replace(/:\d+(?::\d+)?$/, '')).toLowerCase();
}

/** This repository's library boundary; it is deliberately separate from generic IA admission. */
export function checkRepositoryArchitecture(records: readonly CompiledRecord[]): readonly ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  for (const record of records) {
    const path = canonicalPath(record.source.path).toLowerCase();
    const location = {
      identity: record.identity,
      path: record.source.path,
      line: record.source.line,
      severity: 'error' as const,
    };
    if (path.startsWith('.ia/src/') && /^(?:example|minimal)-/.test(record.name))
      findings.push({
        ...location,
        code: 'IA-NATIVE-EXAMPLE-PLACEMENT',
        message:
          'Neutral examples belong in examples/public-language and its explicit test corpus, outside the live repository records.',
      });
    if (path.startsWith('.ia/src/systems/') && WORK_INSTANCES.has(record.discriminator))
      findings.push({
        ...location,
        code: 'IA-NATIVE-WORK-PLACEMENT',
        message:
          'Repository plans, milestones, tasks and decisions belong in workspace-authored records, outside reusable vocabulary system payloads.',
      });
  }
  const policy = records.find((record) => record.discriminator === 'decision' && record.name === 'npm-release-policy');
  if (policy === undefined || source(policy) !== 'releases/current.json')
    findings.push({
      code: 'IA-NATIVE-RELEASE-POLICY-SOURCE',
      severity: 'error',
      identity: 'work-system/definition/decision/npm-release-policy',
      path: policy?.source.path ?? '.ia/src/records/npm-release.ia',
      line: policy?.source.line ?? 1,
      message:
        'The current release policy decision must read releases/current.json; removing its source must not bypass release freshness checks.',
    });
  if (policy !== undefined && text(policy, 'status') !== 'made')
    findings.push({
      code: 'IA-NATIVE-RELEASE-POLICY-STATUS',
      severity: 'error',
      identity: policy.identity,
      path: policy.source.path,
      line: policy.source.line,
      message:
        'The maintained current release policy must remain a made decision; a withdrawn policy cannot remain the current workflow prerequisite.',
    });
  const plan = records.find((record) => record.discriminator === 'plan' && record.name === 'npm-release-hygiene');
  const qualification = records.find(
    (record) => record.discriminator === 'task' && record.name === 'npm-release-hygiene-checks',
  );
  const review = records.find(
    (record) => record.discriminator === 'task' && record.name === 'npm-release-publication-review',
  );
  const milestone = records.find(
    (record) => record.discriminator === 'milestone' && record.name === 'npm-release-prepared',
  );
  const references = (record: CompiledRecord | undefined, key: string, target: CompiledRecord | undefined): boolean => {
    if (record === undefined || target === undefined) return false;
    const reference = value(record, key);
    return (
      reference?.kind === 'ref' &&
      reference.discriminator === target.discriminator &&
      reference.name === target.name &&
      reference.fragment === undefined
    );
  };
  const requires = (record: CompiledRecord | undefined, target: CompiledRecord | undefined): boolean =>
    record !== undefined &&
    target !== undefined &&
    record.edges.some(
      (edge) =>
        edge.predicate === 'require' &&
        edge.direction === 'out' &&
        edge.target === target.identity &&
        (edge.condition === undefined || edge.condition.length === 0),
    );
  if (
    plan === undefined ||
    source(plan) !== 'releases/current.json' ||
    !references(milestone, 'plan', plan) ||
    !references(qualification, 'milestone', milestone) ||
    !references(review, 'milestone', milestone) ||
    !requires(qualification, policy) ||
    !requires(review, qualification)
  )
    findings.push({
      code: 'IA-NATIVE-RELEASE-WORKFLOW',
      severity: 'error',
      identity: plan?.identity ?? 'work-system/definition/plan/npm-release-hygiene',
      path: plan?.source.path ?? '.ia/src/records/npm-release.ia',
      line: plan?.source.line ?? 1,
      message:
        'The maintained release plan must read current.json and contain the qualification milestone with both tasks. Qualification must unconditionally require the current policy, and publication review must unconditionally require qualification evidence.',
    });
  return findings;
}
