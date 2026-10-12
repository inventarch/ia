import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
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
    copyPublicLanguageFixture(repository, root);
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
