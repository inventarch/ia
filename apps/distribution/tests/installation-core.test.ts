import { afterAll, beforeAll, expect, it } from 'vitest';
import { open, readInputs } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import { buildArchive, verifyArchive } from '../src/archive.js';
import { applyInstallation, cacheArchive, planInstallation } from '../src/install.js';
import { planInstallationSnapshot, revalidateInstallationSnapshot } from '../src/installation-core.js';
import { distributionSnapshot } from '../src/snapshot.js';
import { resolveReleases } from '../src/resolve.js';
import { snapshotFixture, sourceInput } from './snapshot-fixture.js';

let fixture: ReturnType<typeof snapshotFixture>;
beforeAll(() => {
  fixture = snapshotFixture();
});
afterAll(() => {
  fixture?.close();
});
function input() {
  const target = fixture.target(),
    base = distributionSnapshot(sourceInput(readInputs(target, { candidateInstallation: null })));
  const selected = resolveReleases(
    [{ id: fixture.packed.manifest.id, range: '^0.1.0' }],
    [{ release: fixture.packed, location: `sha256:${fixture.packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  return {
    target,
    request: {
      base,
      current: null,
      lock: selected.lock,
      archives: new Map([[fixture.packed.archiveDigest, fixture.packed.bytes]]),
      operation: 'install' as const,
    },
  };
}

it('produces the same generation and native read view as the local installer', () => {
  const { target, request } = input(),
    core = planInstallationSnapshot(request);
  cacheArchive(target, fixture.packed.bytes);
  const local = planInstallation(target, request.lock, 'install');
  expect(core.pointer).toEqual(local.pointer);
  expect(core.changes).toEqual(local.changes);
  expect(core.lock).toEqual(local.lock);
  expect(revalidateInstallationSnapshot(core, request)).toEqual(core);
  const captured = new EditorSnapshot({
    root: '',
    ...request.base,
    sources: [...request.base.sources, ...core.installedSources],
    folders: [...new Set([...request.base.folders, ...core.inputs.systems.map((system) => system.name)])].sort(),
    activation: core.pointer,
  });
  applyInstallation(local);
  const physical = open(target, { cache: false });
  try {
    expect(captured.records().map((record) => [record.identity, record.source.path])).toEqual(
      physical.records().map((record) => [record.identity, record.source.path]),
    );
    expect(captured.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  } finally {
    captured.close();
    physical.close();
  }
});

it('refuses archive substitution, missing bytes and conflicting authored authority', () => {
  const { request } = input();
  expect(() => planInstallationSnapshot({ ...request, archives: new Map() })).toThrow();
  expect(() =>
    planInstallationSnapshot({
      ...request,
      archives: new Map([[fixture.packed.archiveDigest, Buffer.from('forged')]]),
    }),
  ).toThrow();
  const path = '.ia/src/systems/workspace-system/system.ia',
    text = fixture.packed.files
      .get(path)!
      .toString()
      .replace(/^  version "[^"]+"$/m, '  version "9.0.0"');
  const base = distributionSnapshot({
    sources: [
      ...request.base.sources,
      { path, text, location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' } },
    ],
    folders: ['workspace-system'],
    floorOrigin: request.base.floorOrigin,
  });
  expect(() => planInstallationSnapshot({ ...request, base })).toThrow(/ADMISSION|admission|provider|version/i);
});

it('requires a new approved plan after source, current activation or plan content changes', () => {
  const { request } = input(),
    plan = planInstallationSnapshot(request);
  const base = distributionSnapshot({
    sources: [
      ...request.base.sources,
      {
        path: '.ia/src/note.ia',
        text: '#! ia 1.0\n# newer draft\n',
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      },
    ],
    folders: request.base.folders,
    floorOrigin: request.base.floorOrigin,
  });
  expect(() => revalidateInstallationSnapshot(plan, { ...request, base })).toThrow(/bindings changed/i);
  expect(() =>
    revalidateInstallationSnapshot(plan, { ...request, current: { pointer: plan.pointer, lock: plan.lock } }),
  ).toThrow(/bindings changed/i);
  expect(() => revalidateInstallationSnapshot({ ...plan, installedSources: [] }, request)).toThrow();
});

it('keeps the prior generation unchanged until an explicit compatible upgrade is applied', () => {
  const { request } = input(),
    previous = planInstallationSnapshot(request),
    saved = JSON.stringify(previous);
  const bytes = buildArchive({ ...fixture.packed.manifest, version: '0.1.1' }, fixture.packed.files),
    release = verifyArchive(bytes);
  const resolved = resolveReleases(
    request.lock.requests,
    [{ release, location: `sha256:${release.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  const updated = planInstallationSnapshot({
    ...request,
    current: { pointer: previous.pointer, lock: previous.lock },
    lock: resolved.lock,
    archives: new Map([[release.archiveDigest, bytes]]),
    operation: 'update',
  });
  expect(updated.pointer.counter).toBe(2);
  expect(updated.pointer.previous).toBe(previous.pointer.generation);
  expect(updated.changes.updated).toEqual([fixture.packed.manifest.id]);
  expect(JSON.stringify(previous)).toBe(saved);
  expect(previous.lock.packages[0]!.version).toBe('0.1.0');
});

const AUTHORED = {
  placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
  provenance: 'workspace' as const,
};
const CANON_LAW = `#! ia 1.0

@law placement-law
  meaning
    says "Test law placement-law."
    answers "What does test law placement-law require?"
  governance
    severity blocking
  relationships
    enforced-by @check placement-check

@check placement-check
  meaning
    says "Test check placement-check."
    answers "What does test check placement-check evaluate?"
  check
    runs CANON-WORK-PLACEMENT
    scope "*"
`;
const OFFENDING_SPEC = `#! ia 1.0

@spec offending-spec
  meaning
    says "A specification inside a system folder."
    answers "Which specification sits in a system folder?"
  work
    title "Offending"
    status draft
`;
const withSources = (base: ReturnType<typeof input>['request']['base'], sources: { path: string; text: string }[]) =>
  distributionSnapshot({
    sources: [...base.sources, ...sources.map((source) => ({ ...source, location: AUTHORED }))],
    folders: base.folders,
    floorOrigin: base.floorOrigin,
  });

it('installs a closure whose only errors are canon findings, and still refuses any other admission error', () => {
  const { target, request } = input();
  // Task 13e ruling: a canon finding fails validate and preview, never an installation.
  const sources = [
    { path: '.ia/src/laws.ia', text: CANON_LAW },
    { path: '.ia/src/systems/work-system/records/offending-spec.ia', text: OFFENDING_SPEC },
  ];
  const plan = planInstallationSnapshot({ ...request, base: withSources(request.base, sources) });
  const reader = new EditorSnapshot({
    root: '',
    ...request.base,
    sources: [...withSources(request.base, sources).sources, ...plan.installedSources],
    folders: [...new Set([...request.base.folders, ...plan.inputs.systems.map((system) => system.name)])].sort(),
    activation: plan.pointer,
  });
  try {
    expect(reader.report.findings.filter((finding) => finding.severity === 'error').map((f) => f.code)).toEqual([
      'IA-COMP-CANON-WORK-PLACEMENT',
    ]);
  } finally {
    reader.close();
  }
  // The local installer stages and activates the same closure.
  for (const { path, text } of sources) fixture.put(target, path, text);
  cacheArchive(target, fixture.packed.bytes);
  expect(applyInstallation(planInstallation(target, request.lock, 'install')).status).toBe('installed');

  const bad = {
    path: '.ia/src/bad.ia',
    text: '#! ia 1.0\n\n@law bad-law\n  meaning\n    says "A law whose severity is not one."\n    answers "Which law has a bad severity?"\n  governance\n    severity sideways\n',
  };
  expect(() => planInstallationSnapshot({ ...request, base: withSources(request.base, [...sources, bad]) })).toThrow(
    expect.objectContaining({
      code: 'IA-DIST-ADMISSION-FAILED',
      message: expect.stringContaining('IA-GRAPH-DIMENSION-UNKNOWN'),
    }),
  );
});
