import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureWorkspace } from '@inventarch/workspace-runtime';
import { resourceOccurrences } from '@inventarch/workspace-runtime/resources';
import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import {
  admitSourceCapture,
  createInstalledSourcePolicy,
  createSourcePolicy,
  homeSourceCapture,
  mountSourceCapture,
} from '@inventarch/workspace-runtime/sources';
import { readInputs } from '@inventarch/db';
import { planInstallationSnapshot } from '../src/installation-core.js';
import { resolveReleases } from '../src/resolve.js';
import { distributionSnapshot } from '../src/snapshot.js';
import { snapshotFixture, sourceInput } from './snapshot-fixture.js';

let fixture: ReturnType<typeof snapshotFixture>;
beforeAll(() => {
  fixture = snapshotFixture();
});
afterAll(() => {
  fixture?.close();
});

it('admits a real packed foundation as the hosted dependency view and replaces exact old baseline copies', () => {
  const target = fixture.target(),
    base = createSourcePolicy(fixture.root, { validator: 'a'.repeat(64) });
  const selected = resolveReleases(
    [{ id: fixture.packed.manifest.id, range: '^0.1.0' }],
    [{ release: fixture.packed, location: `sha256:${fixture.packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  const plan = planInstallationSnapshot({
    base: distributionSnapshot(sourceInput(readInputs(target))),
    current: null,
    lock: selected.lock,
    archives: new Map([[fixture.packed.archiveDigest, fixture.packed.bytes]]),
    operation: 'install',
  });
  const policy = createInstalledSourcePolicy(base, {
    pointer: plan.pointer,
    lock: plan.lock,
    inputs: plan.inputs,
    bundles: selected.releases,
  });
  const home = homeSourceCapture('owned', [{ path: '.ia/src/note.ia', text: '#! ia 1.0\n# Owned note.\n' }], policy);
  expect(admitSourceCapture(home).ok).toBe(true);
  const project = captureWorkspace(fixture.root, 'project'),
    mounted = mountSourceCapture(project, home, 'b'.repeat(64), policy);
  expect(admitSourceCapture(mounted).ok).toBe(true);
  expect(resourceOccurrences(mounted).sourceRevisions.some((source) => source.source === 'workspace')).toBe(true);
  expect(mounted.activation).toEqual(plan.pointer);
  expect(mounted.sources.some((source) => source.path.startsWith('.ia/src/systems/'))).toBe(false);
  expect(
    mounted.sources.some((source) =>
      source.path.startsWith(`.ia/distributions/store/${fixture.packed.archiveDigest}/`),
    ),
  ).toBe(true);
  const nativeRevision = createHash('sha256')
    .update(stableSerialize([{ path: '.ia/src/note.ia', text: '#! ia 1.0\n# Owned note.\n' }]))
    .digest('hex');
  expect(
    mounted.sources.some((source) => source.path === `.ia/adopted/workspace/${nativeRevision}/.ia/src/note.ia`),
  ).toBe(true);
  expect(mounted.sources.some((source) => source.path.startsWith('.ia/adopted/foundation/'))).toBe(false);
  const unproven = { ...project, activation: { ...plan.pointer, generation: 'c'.repeat(64) } };
  expect(() => mountSourceCapture(unproven, home, 'b'.repeat(64), policy)).toThrow();
});
