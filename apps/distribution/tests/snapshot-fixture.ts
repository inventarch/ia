import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readInputs, type InputSnapshot } from '@inventarch/db';
import { packDistribution } from '../src/pack.js';

export const repository = resolve(import.meta.dirname, '../../..');
export const descriptor = {
  formatVersion: 1,
  id: 'fixture/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/definition/distribution/public-language',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  assets: [{ path: 'LICENSE', role: 'license' }],
  source: {
    repository: 'https://fixture.example/source-workspaces/foundation',
    commit: 'a'.repeat(64),
    recipe: 'ustar-v1',
    epoch: 1_700_000_000,
  },
  license: 'UNLICENSED',
  description: 'Original bounded snapshot qualification fixture',
};
export const sourceInput = (input: InputSnapshot) => ({
  sources: input.sources,
  folders: input.folders,
  floorOrigin: input.floorOrigin,
  ...(input.activation ? { activation: input.activation } : {}),
});

export function snapshotFixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'ia-snapshot-core-')),
    root = join(temporary, 'source');
  mkdirSync(root);
  const put = (directory: string, path: string, content: string | Uint8Array) => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const path of [
    '.ia/src/systems/workspace-system/records/system-packages.ia',
    '.ia/src/floor/artifact-set.ia',
    '.ia/src/floor/axis.ia',
    '.ia/src/floor/cardinality.ia',
    '.ia/src/floor/category.ia',
    '.ia/src/floor/dimension.ia',
    '.ia/src/floor/floor.schema.ia',
    '.ia/src/floor/intent-shape.ia',
    '.ia/src/floor/kernel.schema.ia',
    '.ia/src/floor/kind.ia',
    '.ia/src/floor/lane.ia',
    '.ia/src/floor/move.ia',
    '.ia/src/floor/phase.ia',
    '.ia/src/floor/placement.ia',
    '.ia/src/floor/predicate.ia',
    '.ia/src/floor/primitive.ia',
    '.ia/src/floor/taxonomy.system.ia',
    '.ia/src/floor/value-type.ia',
    '.ia/src/systems/agent-system/system.ia',
    '.ia/src/systems/agent-system/schemas/agent.schema.ia',
    '.ia/src/systems/agent-system/schemas/mandate.schema.ia',
    '.ia/src/systems/compliance-system/system.ia',
    '.ia/src/systems/compliance-system/schemas/case.schema.ia',
    '.ia/src/systems/compliance-system/schemas/check.schema.ia',
    '.ia/src/systems/compliance-system/schemas/contract.schema.ia',
    '.ia/src/systems/workspace-system/system.ia',
    '.ia/src/systems/workspace-system/schemas/distribution.schema.ia',
    '.ia/src/systems/workspace-system/schemas/workspace.schema.ia',
    '.ia/src/systems/governance-system/system.ia',
    '.ia/src/systems/governance-system/schemas/convention.schema.ia',
    '.ia/src/systems/governance-system/schemas/law.schema.ia',
    '.ia/src/systems/governance-system/schemas/playbook.schema.ia',
    '.ia/src/systems/governance-system/schemas/principle.schema.ia',
    '.ia/src/systems/session-system/system.ia',
    '.ia/src/systems/session-system/schemas/run.schema.ia',
    '.ia/src/systems/authoring-system/system.ia',
    '.ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia',
    '.ia/src/systems/authoring-system/schemas/operation.schema.ia',
    '.ia/src/systems/agent-composition-system/system.ia',
    '.ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/capability.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/harness.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/voice.schema.ia',
    '.ia/src/systems/template-system/system.ia',
    '.ia/src/systems/template-system/schemas/template.schema.ia',
    '.ia/src/systems/hook-authoring-system/system.ia',
    '.ia/src/systems/hook-authoring-system/schemas/hook.schema.ia',
    '.ia/src/systems/learning-system/system.ia',
    '.ia/src/systems/learning-system/schemas/improvement.schema.ia',
    '.ia/src/systems/learning-system/schemas/observation.schema.ia',
    '.ia/src/systems/work-system/system.ia',
    '.ia/src/systems/work-system/schemas/decision.schema.ia',
    '.ia/src/systems/work-system/schemas/milestone.schema.ia',
    '.ia/src/systems/work-system/schemas/plan.schema.ia',
    '.ia/src/systems/work-system/schemas/task.schema.ia',
    '.ia/src/systems/work-system/schemas/spec.schema.ia',
    '.ia/src/systems/agent-composition-system/records/composition.ia',
    '.ia/src/systems/workspace-system/records/quality.ia',
    '.ia/src/systems/workspace-system/records/architecture.ia',
    '.ia/src/systems/learning-system/records/evidence.ia',
    '.ia/src/systems/workspace-system/records/language.ia',
    '.ia/src/systems/work-system/records/work.ia',
    '.ia/src/systems/authoring-system/operations/validate-ia.ia',
    '.ia/src/systems/authoring-system/operations/format-ia.ia',
    '.ia/src/systems/template-system/operations/render-template.ia',
    '.ia/src/systems/workspace-system/records/repository-distribution.ia',
  ])
    put(root, path, readFileSync(join(repository, path)));
  const license = Buffer.from('Original fixture only; no external publication.\r\n');
  put(root, 'LICENSE', license);
  const packed = packDistribution(root, descriptor),
    input = readInputs(root);
  let serial = 0;
  return {
    root,
    input,
    packed,
    license,
    put,
    target() {
      const target = join(temporary, `target-${serial++}`);
      mkdirSync(target);
      return target;
    },
    close() {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-snapshot-core-'))
        throw new Error('Unsafe fixture cleanup');
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}
