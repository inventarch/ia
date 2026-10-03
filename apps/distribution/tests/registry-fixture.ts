import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, vi } from 'vitest';
import { readInputs } from '@inventarch/db';
import { distributionSnapshot, packSnapshot } from '../src/snapshot.js';
import type { DistributionSnapshot } from '../src/snapshot.js';
import { descriptor, repository, sourceInput } from './snapshot-fixture.js';

/** Serves a registry directory at `base` through a stubbed global fetch; every request must refuse redirects. Returns the requested URLs. */
export function serveDirectory(dir: string, base = 'https://registry.test/base/'): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    expect(init?.redirect).toBe('error');
    if (!url.startsWith(base)) return new Response('no', { status: 404 });
    try {
      return new Response(readFileSync(join(dir, decodeURIComponent(url.slice(base.length)))));
    } catch {
      return new Response('missing', { status: 404 });
    }
  });
  return requested;
}

export interface FixtureReleaseSpec {
  id: string;
  version: string;
  dependencies?: { id: string; range: string }[];
  withdrawn?: boolean;
  licensed?: boolean;
  repository?: string | null;
  engine?: string;
}
export interface FixtureRelease {
  id: string;
  version: string;
  archive: string;
  manifest: string;
  bytes: Buffer;
}
let foundation: { snapshot: DistributionSnapshot; systems: string[] } | undefined;
/** The admitted foundation workspace `snapshot-fixture.ts` packs, captured once per process; its temporary copy is removed at once. */
function foundationSnapshot(): { snapshot: DistributionSnapshot; systems: string[] } {
  if (foundation) return foundation;
  const root = mkdtempSync(join(tmpdir(), 'ia-registry-source-'));
  try {
    for (const path of [
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
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), readFileSync(join(repository, path)));
    }
    const snapshot = distributionSnapshot(sourceInput(readInputs(root)));
    const systems = packSnapshot(snapshot, { ...descriptor, assets: [] }, new Map())
      .manifest.systems.map((s) => s.name)
      .filter((name) => name !== 'workspace-system')
      .sort();
    return (foundation = { snapshot, systems });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/**
 * A real archive that installs: the admitted foundation distribution packed under the spec's id and version. A release
 * with dependencies takes its non-workspace systems from them (split across the dependencies), so the installed
 * closure is the foundation's and passes native admission. Source provenance is `https://fixture.example/<id>`
 * unless `repository` is null (an unpublished local pack).
 */
export function fixtureArchive(spec: FixtureReleaseSpec): FixtureRelease {
  const { snapshot, systems } = foundationSnapshot(),
    dependencies = spec.dependencies ?? [];
  const source =
    spec.repository === null
      ? { ...descriptor.source, repository: null, commit: null }
      : { ...descriptor.source, repository: spec.repository ?? `https://fixture.example/${spec.id}` };
  const external = dependencies.map((d, k) => ({
    ...d,
    systems: systems.filter((_, n) => n % dependencies.length === k),
  }));
  const packed = packSnapshot(
    snapshot,
    {
      ...descriptor,
      id: spec.id,
      version: spec.version,
      engine: spec.engine ?? descriptor.engine,
      assets: [],
      dependencies: external,
      source,
      description: 'Original registry fixture',
    },
    new Map(),
  );
  return {
    id: spec.id,
    version: spec.version,
    archive: packed.archiveDigest,
    manifest: packed.manifestDigest,
    bytes: Buffer.from(packed.bytes),
  };
}
/** A registry directory holding real packed archives, written directly in the `ia.registry.v1` layout (spec §3); licensed releases get no artifact file. */
export async function buildFixtureRegistry(
  specs: readonly FixtureReleaseSpec[],
): Promise<{ dir: string; releases: FixtureRelease[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'ia-registry-fixture-')),
    releases: FixtureRelease[] = [],
    indexes = new Map<string, unknown[]>();
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  put('ia-registry.json', JSON.stringify({ format: 'ia.registry.v1', name: 'Fixture' }));
  for (const spec of specs) {
    const release = fixtureArchive(spec),
      licensed = spec.licensed === true;
    releases.push(release);
    if (!licensed) put(`artifacts/${release.archive}.ia.tgz`, release.bytes);
    const entry = {
      version: spec.version,
      archive: release.archive,
      manifest: release.manifest,
      engine: spec.engine ?? descriptor.engine,
      language: ['1.0'],
      dependencies: [...(spec.dependencies ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
      withdrawn: spec.withdrawn === true,
      access: licensed ? 'licensed' : 'public',
      ...(licensed ? {} : { artifact: `artifacts/${release.archive}.ia.tgz` }),
    };
    indexes.set(spec.id, [...(indexes.get(spec.id) ?? []), entry]);
  }
  for (const [id, entries] of indexes)
    put(`packages/${id}.json`, JSON.stringify({ format: 'ia.registry-package.v1', id, releases: entries }));
  return { dir, releases };
}
