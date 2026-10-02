import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureWorkspace, compileHarness } from '@ia/agent-composition-system';
import * as resources from '@ia/agent-composition-system/resources';
import {
  createInstalledSourcePolicy,
  createSourcePolicy,
  homeSourceCapture,
} from '@ia/agent-composition-system/sources';
import { readInputs } from '@ia/db';
import { EditorSnapshot } from '@ia/db/editor';
import { exampleCatalog } from '../../../tools/native/public-language.js';
import { planInstallationSnapshot } from '../src/installation-core.js';
import { resolveReleases } from '../src/resolve.js';
import { distributionSnapshot } from '../src/snapshot.js';
import { packDistribution } from '../src/pack.js';
import { descriptor, snapshotFixture, sourceInput } from './snapshot-fixture.js';

const revisions = vi.hoisted(() => [] as string[]);
vi.mock('@ia/db/editor', async (original) => {
  const actual = await original<typeof import('@ia/db/editor')>();
  return {
    ...actual,
    EditorSnapshot: class extends actual.EditorSnapshot {
      constructor(input: ConstructorParameters<typeof actual.EditorSnapshot>[0]) {
        super(input);
        revisions.push(this.revision);
      }
    },
  };
});

let fixture: ReturnType<typeof snapshotFixture>, definitions: ReturnType<typeof homeSourceCapture>;
beforeAll(() => {
  fixture = snapshotFixture();
  const path = '.ia/src/systems/workspace-system/records/repository-distribution.ia';
  fixture.put(
    fixture.root,
    path,
    readFileSync(join(fixture.root, path), 'utf8').replace(
      'records [@workspace example-workspace, @workspace example-module, @workspace example-interface]',
      'records [@workspace example-workspace, @workspace example-module, @workspace example-interface, @harness example-harness]',
    ),
  );
  fixture.packed = packDistribution(fixture.root, descriptor);
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
  definitions = homeSourceCapture(
    'installed-definitions',
    [],
    createInstalledSourcePolicy(base, {
      pointer: plan.pointer,
      lock: plan.lock,
      inputs: plan.inputs,
      bundles: selected.releases,
    }),
  );
});
afterAll(() => fixture?.close());
it('compiles executable definitions from the real packed installed activation without losing authority', () => {
  const snapshot = new EditorSnapshot({
    root: '.',
    sources: definitions.sources,
    folders: definitions.folders,
    floorOrigin: definitions.floorOrigin,
    fingerprint: definitions.revision,
    ...(definitions.activation ? { activation: definitions.activation } : {}),
  });
  const expectedView = snapshot.revision;
  snapshot.close();
  revisions.length = 0;
  const result = compileHarness(captureWorkspace(fixture.root, 'task'), {
    definitions,
    harness: 'example-harness',
    entry: 'example-entry',
    catalog: exampleCatalog(),
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(revisions).toEqual([expectedView]);
  if (result.ok)
    expect(
      result.manifest.provenance.sources.some((s) =>
        s.path.startsWith(`.ia/distributions/store/${fixture.packed.archiveDigest}/`),
      ),
    ).toBe(true);
});
it('exposes the single source-qualified path resolver for actual installed occurrences', () => {
  const occurrence = resources
    .resourceOccurrences(definitions)
    .occurrences.find((o) => o.identity.endsWith('/example-harness'))!;
  expect(occurrence).toBeDefined();
  expect(resources.nativeResourcePath(definitions, occurrence)).toContain(
    `.ia/distributions/store/${fixture.packed.archiveDigest}/`,
  );
});
