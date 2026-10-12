import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { adoptedBindings, open, readInputs } from '@inventarch/db';
import { registryAddCollection } from '@inventarch/distribution/registry-build';
import { workspaceRevision, planAdoption, applyAdoption } from '@inventarch/distribution/registry';
import { captureWorkspace, Corpus } from '@inventarch/workspace-runtime';
import { resourceOccurrences } from '@inventarch/workspace-runtime/resources';
import { cleanup, nextArgv, run, scratch } from './workspace-fixture.js';
import * as captureService from '../src/capture.js';
import * as projectionService from '../src/host-projection.js';
import { buildFixtureRegistry } from './registry-fixture.js';

afterEach(cleanup);
const native = (title: string) =>
  `#! ia 1.0\n@plan shared-plan\n  meaning\n    says "Shared work"\n    answers "What is planned?"\n  work\n    title "${title}"\n    status open\n    owner "example"\n`;
function registry(label = 'adoption-registry') {
  const root = scratch(label),
    files = [{ path: '.ia/src/work.ia', text: native('Adopted plan') }];
  const release = { version: '1.0.0', withdrawn: false, revision: workspaceRevision(files), files };
  registryAddCollection(root, 'workspace', {
    format: 'ia.registry-workspace.v1',
    id: 'example/reference',
    releases: [release],
  });
  return { root, release };
}
it('init --adopt previews without writes, pins an offline source mount and admits at band 50', async () => {
  const fixture = registry(),
    root = join(scratch('adoption-init'), 'demo');
  const args = ['init', root, '--adopt', 'example/reference@1.0.0', '--registry', fixture.root, '--json'];
  const preview = await run(args);
  expect(preview.exitCode, preview.stderr || preview.stdout).toBe(0);
  expect(existsSync(root)).toBe(false);
  const applied = await run([...args, '--apply', '--yes']);
  expect(applied.exitCode, applied.stderr || applied.stdout).toBe(0);
  expect(adoptedBindings(root)[0]?.placement).toBe('open');
  const source = readInputs(root).sources.find((source) => source.path.includes('/work.ia'))!;
  expect(source.location.placement.band).toBe(50);
  expect(readFileSync(join(root, '.ia/src/workspace.ia'), 'utf8')).toContain('@open');
  const capture = captureWorkspace(root);
  const corpus = new Corpus(capture);
  expect(corpus.records().some((record) => record.name === 'shared-plan' && record.band === 50)).toBe(true);
  corpus.close();
  const occurrences = resourceOccurrences(capture);
  expect(occurrences.occurrences.find((row) => row.identity.endsWith('/shared-plan'))?.source).toBe(
    adoptedBindings(root)[0]?.id,
  );
  const reader = open(root, { cache: false });
  try {
    expect(reader.refused).toEqual([]);
  } finally {
    reader.close();
  }
  writeFileSync(join(root, '.ia/src/override.ia'), native('Locally authored plan'));
  const local = open(root, { cache: false });
  try {
    const record = local.records().find((record) => record.identity.endsWith('/shared-plan'))!;
    expect(record.band).toBe(100);
  } finally {
    local.close();
  }
});

it('adopt refreshes the registered packet and refuses a changed input after planning', async () => {
  const fixture = registry(),
    root = join(scratch('adoption-existing'), 'demo');
  const init = await run(['init', root, '--apply', '--yes', '--json']);
  expect(init.exitCode, init.stdout).toBe(0);
  const project = await run(['project', 'codex', '--root', root, '--apply', '--yes', '--json']);
  expect(project.exitCode, project.stdout).toBe(0);
  const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const beforeInputs = readInputs(root).fingerprint;
  const preview = await run(['adopt', 'example/reference', '--root', root, '--registry', fixture.root, '--json']);
  expect(preview.exitCode, preview.stdout).toBe(0);
  expect(readInputs(root).fingerprint).toBe(beforeInputs);
  expect(adoptedBindings(root)).toEqual([]);
  const result = await run([
    'adopt',
    'example/reference',
    '--root',
    root,
    '--registry',
    fixture.root,
    '--apply',
    '--yes',
    '--json',
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).not.toBe(before);
  expect(JSON.parse(result.stdout).projections).toHaveLength(1);
  const doctor = await run(['doctor', '--root', root, '--json']);
  expect(
    JSON.parse(doctor.stdout).checks.some(
      (row: { title: string; detail: string }) => row.title === 'Source mount' && row.detail.includes('band 50'),
    ),
  ).toBe(true);
  const planned = planAdoption(root, 'example/reference', fixture.release);
  writeFileSync(join(root, '.ia/src/new.ia'), '#! ia 1.0\n# changed\n');
  expect(() => applyAdoption(planned)).toThrow(/changed/);
});

it('ia install resolves a kit to its distributions and preserves ordinary install semantics', async () => {
  const registry = buildFixtureRegistry([{ id: 'example/foundation', version: '1.0.0' }]);
  registryAddCollection(registry, 'kit', {
    format: 'ia.registry-kit.v1',
    id: 'example/starter',
    releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'example/foundation', range: '1.0.0' }] }],
  });
  const root = scratch('kit-install');
  const result = await run([
    'install',
    'example/starter',
    '--root',
    root,
    '--registry',
    registry,
    '--apply',
    '--yes',
    '--json',
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).plan.lock.requests).toEqual([{ id: 'example/foundation', range: '1.0.0' }]);
});

it.each(['capture', 'projection'] as const)(
  'prints one pinned adoption retry that completes a failed %s effect',
  async (effect) => {
    const fixture = registry('adoption registry'),
      root = join(scratch('adoption recovery'), 'workspace with spaces');
    expect((await run(['init', root, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    expect((await run(['project', 'codex', '--root', root, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const injected =
      effect === 'capture'
        ? vi.spyOn(captureService, 'collectCapture').mockImplementationOnce(() => {
            throw new Error('temporary capture write failure');
          })
        : vi.spyOn(projectionService, 'applyHostProjection').mockImplementationOnce(() => {
            throw new Error('temporary projection write failure');
          });
    let refused;
    try {
      refused = await run([
        'adopt',
        'example/reference',
        '--registry',
        fixture.root,
        '--root',
        root,
        '--apply',
        '--yes',
        '--json',
      ]);
    } finally {
      injected.mockRestore();
    }
    expect(refused.exitCode).toBe(3);
    const body = JSON.parse(refused.stdout) as { code: string; next: string };
    expect(body.code).toBe('IA-CLI-ADOPTION-APPLIED');
    const pin = adoptedBindings(root);
    expect(pin).toHaveLength(1);
    const args = nextArgv(body.next);
    expect(args).toEqual([
      'adopt',
      'example/reference@1.0.0',
      '--registry',
      fixture.root,
      '--root',
      root,
      '--apply',
      '--yes',
    ]);
    const restored = await run([...args, '--json']);
    expect(restored.exitCode, restored.stdout).toBe(0);
    expect(JSON.parse(restored.stdout).projections).toHaveLength(1);
    expect(JSON.parse(restored.stdout).capture).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).not.toBe(before);
    expect(adoptedBindings(root)).toEqual(pin);
  },
);
