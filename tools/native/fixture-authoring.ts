import { FLOOR_SYSTEM, KERNEL_DIGEST, LANGUAGE_VERSION } from '../../packages/language/src/index.js';
import { revisionOf } from '../../packages/graph/src/index.js';
import type { ClauseResult } from '../../packages/compliance/src/index.js';
import { checkNative } from './check.js';
import type { NativeInput } from './compile.js';

export const FOUNDATION_ADOPTER = 'workspace-system/definition/workspace/foundation-workspace';
export const FOUNDATION_CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract';
const owner = 'agent-system',
  folder = `.ia/src/systems/${owner}`;
const subjectPath = `${folder}/steward.ia`,
  subjectId = 'agent-system/binding/agent/agent-steward';
const workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia';
export type FoundationObservationId = 'input' | 'valid-native-record' | 'missing-required-field' | 'foreign-vocabulary';
export interface FoundationObservation extends ClauseResult {
  readonly id: FoundationObservationId;
}
export interface FoundationEvidence {
  readonly revision: string;
  readonly adopter: string;
  readonly observations: readonly FoundationObservation[];
}
type NativeResult = ReturnType<typeof checkNative>;
const result = (outcome: ClauseResult['outcome'], message: string): ClauseResult => ({ outcome, message });
const unavailable = (message: string): ClauseResult => result('not-evaluated', message);
const failures = (checked: NativeResult): string[] => [
  ...checked.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} at ${d.path}:${d.line}`),
  ...checked.assessments.filter((a) => a.outcome === 'fail').map((a) => `${a.check} ${a.scope}`),
];

/** Executes only the named structural source scenarios; see tools/native/SPEC.md. */
export function observeFoundationAuthoring(
  inputs: readonly NativeInput[],
  folders: readonly string[],
): FoundationEvidence {
  const baseline = checkNative(inputs, folders);
  const revision = revisionOf(baseline.registry, {
    sources: inputs,
    kernelDigest: KERNEL_DIGEST,
    languageVersion: LANGUAGE_VERSION,
  });
  const source = inputs.find((i) => i.path === subjectPath);
  const subject = baseline.records.find((r) => r.identity === subjectId && r.source.path === subjectPath);
  const observations: FoundationObservation[] = [];
  const observe = (id: FoundationObservationId, run: () => ClauseResult): void => {
    let value: ClauseResult;
    try {
      value = run();
    } catch (error) {
      value = unavailable(`Scenario unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    observations.push(Object.freeze({ id, ...value }));
  };

  observe('input', () => {
    const missing: string[] = [];
    if (source === undefined || subject === undefined) missing.push(`authored subject ${subjectPath}`);
    if (baseline.registry.registrations.get('agent')?.system !== owner || !folders.includes(owner))
      missing.push(`intended owner ${owner}`);
    if (!baseline.records.some((r) => r.identity === FOUNDATION_ADOPTER && r.source.path === workspacePath))
      missing.push('foundation-workspace adopter');
    const paths = new Set(inputs.map((i) => i.path));
    for (const name of folders)
      if (baseline.registry.systems.get(name)?.path !== `.ia/src/systems/${name}/system.ia`)
        missing.push(`direct declaration for ${name}`);
    for (const system of baseline.registry.systems.values()) {
      if (!paths.has(system.path)) missing.push(`system source ${system.path}`);
      if (system.path.startsWith('.ia/src/systems/') && !folders.includes(system.name))
        missing.push(`system folder ${system.name}`);
      for (const dependency of system.requires)
        if (dependency.name !== FLOOR_SYSTEM && !baseline.registry.systems.has(dependency.name))
          missing.push(`dependency ${dependency.name}`);
    }
    for (const schema of baseline.registry.schemas.values())
      if (!paths.has(schema.path)) missing.push(`schema source ${schema.path}`);
    const errors = baseline.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.code} at ${d.path}:${d.line}`);
    return missing.length || errors.length
      ? result('fail', `Incomplete or invalid authoring inputs: ${[...missing, ...errors].join('; ')}`)
      : result('pass', 'Authored subject, intended owner and native registry closure are supplied');
  });

  observe('valid-native-record', () => {
    const failed = failures(baseline);
    if (failed.length) return result('fail', `Native authoring validation failed: ${failed.join('; ')}`);
    const schema = baseline.assessments.find((a) => a.check === 'COMP-SCHEMA' && a.scope === subjectId);
    const system = baseline.assessments.find((a) => a.check === 'COMP-SYSTEM' && a.scope === folder);
    if (subject === undefined || schema === undefined || system === undefined || !baseline.ok)
      return unavailable('Passing subject schema and owner-system observations are unavailable');
    return result('pass', 'The owned agent record and native closure pass schema and system validation');
  });

  observe('missing-required-field', () => {
    const fields =
      subject?.sections
        .filter((s) => s.name === 'governance')
        .flatMap((s) => s.fields.filter((f) => 'key' in f && f.key === 'applies')) ?? [];
    if (source === undefined || fields.length !== 1)
      return unavailable('Need one authored governance.applies field to prepare the missing-field mutation');
    const span = fields[0]!.span;
    const lines = source.text.split(/\r?\n/);
    const text = lines
      .filter((_, i) => i + 1 < span.line || i + 1 > span.endLine)
      .join(source.text.includes('\r\n') ? '\r\n' : '\n');
    const mutated = checkNative(
      inputs.map((i) => (i === source ? { ...i, text } : i)),
      folders,
    );
    const assessment = mutated.assessments.find((a) => a.check === 'COMP-SCHEMA' && a.scope === subjectId);
    return !mutated.ok &&
      assessment?.outcome === 'fail' &&
      assessment.findings.some(
        (f) => f.code === 'IA-COMP-FIELD-MISSING' && f.path === subjectPath && f.message.includes('governance.applies'),
      )
      ? result('pass', 'Missing governance.applies refuses the subject with IA-COMP-FIELD-MISSING')
      : result('fail', 'Missing governance.applies did not produce the required subject schema refusal');
  });

  observe('foreign-vocabulary', () => {
    const workspace = inputs.find((i) => i.path === workspacePath);
    const path = `${folder}/records/foundation-adoption-foreign.ia`;
    if (
      workspace === undefined ||
      !baseline.records.some((r) => r.identity === FOUNDATION_ADOPTER && r.source.path === workspacePath)
    )
      return unavailable('Need the authored foundation-workspace to prepare the foreign-vocabulary mutation');
    if (inputs.some((i) => i.path === path)) return unavailable(`Mutation path is already occupied: ${path}`);
    const foreign = {
      ...workspace,
      path,
      text: workspace.text.replaceAll('foundation-workspace', 'foundation-adoption-foreign'),
    };
    const mutated = checkNative([...inputs, foreign], folders);
    const assessment = mutated.assessments.find((a) => a.check === 'COMP-SYSTEM' && a.scope === folder);
    return !mutated.ok &&
      assessment?.outcome === 'fail' &&
      assessment.findings.some((f) => f.code === 'IA-COMP-DISCRIMINATOR-FOREIGN' && f.path === path)
      ? result('pass', 'Foreign workspace vocabulary refuses the subject with IA-COMP-DISCRIMINATOR-FOREIGN')
      : result('fail', 'Foreign workspace vocabulary did not produce the required owner-system refusal');
  });
  return Object.freeze({ revision, adopter: FOUNDATION_ADOPTER, observations: Object.freeze(observations) });
}
