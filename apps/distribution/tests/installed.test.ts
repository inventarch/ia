import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open, readInputs } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import {
  canonicalDistributionJson as json,
  generationDigest,
  installationWorkspace,
} from '@inventarch/db/distribution';
import type { ActivationPointer } from '@inventarch/db/distribution';
import { packDistribution } from '../src/pack.js';
import { resolveReleases } from '../src/resolve.js';
import {
  applyInstallation,
  cacheArchive,
  collectInstallationGarbage,
  planInstallation,
  recoverInstallation,
} from '../src/install.js';
import { buildArchive } from '../src/archive.js';
import { runNative } from '../src/native-command.js';
import { captureWorkspace, installedImplementationDigest } from '@inventarch/agent-composition-system';
import {
  captureResources,
  resourceOccurrences,
  resolveResources,
} from '@inventarch/agent-composition-system/resources';
import {
  claudeProseCatalog,
  codexProseCatalog,
  compileProjection,
} from '@inventarch/agent-composition-system/projections';
import { metadataDigest, sha256 } from '@inventarch/db/distribution';

const repository = resolve(import.meta.dirname, '../../..'),
  temporary = mkdtempSync(join(tmpdir(), 'ia-installed-read-'));
let packed: ReturnType<typeof packDistribution>,
  selected: ReturnType<typeof resolveReleases>,
  pointer: ActivationPointer,
  sequence = 0;
function put(root: string, path: string, content: string | Buffer): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
interface Fixture {
  readonly packed: typeof packed;
  readonly selected: typeof selected;
  readonly pointer: ActivationPointer;
}
function fixture(name: string, sources: Readonly<Record<string, string>> = {}): Fixture {
  const root = join(temporary, name);
  mkdirSync(root);
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
  put(root, 'guide.md', '# Original installed guide\n');
  for (const [path, text] of Object.entries(sources)) put(root, path, text);
  const packed = packDistribution(root, {
    formatVersion: 1,
    id: 'test/foundation',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/public-language',
    engine: '^0.1.0',
    language: ['1.0'],
    dependencies: [],
    assets: [{ path: 'guide.md', role: 'documentation' }],
    source: { repository: 'https://example.com/fixture', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 0 },
    license: 'UNLICENSED',
    description: 'Original fixture',
  });
  const selected = resolveReleases(
    [{ id: 'test/foundation', range: '^0.1.0' }],
    [{ release: packed, location: `sha256:${packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
  return {
    packed,
    selected,
    pointer: {
      formatVersion: 1,
      generation: generationDigest(
        selected.lock,
        selected.inputs,
        installationWorkspace(selected.lock, selected.inputs, selected.releases),
      ),
      previous: null,
      counter: 1,
    },
  };
}
beforeAll(() => {
  ({ packed, selected, pointer } = fixture('source'));
}, 30000);
afterAll(() => {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-installed-read-'))
    throw Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});
const current = (): Fixture => ({ packed, selected, pointer });
function install({ packed, selected, pointer }: Fixture = current()): string {
  const root = join(temporary, `workspace ${sequence++}`);
  mkdirSync(root);
  const store = `.ia/distributions/store/${packed.archiveDigest}`,
    generation = `.ia/distributions/generations/${pointer.generation}`;
  for (const [path, bytes] of packed.files) put(root, `${store}/${path}`, bytes);
  put(root, `${store}/distribution.json`, json(packed.manifest));
  put(root, `${generation}/lock.json`, json(selected.lock));
  put(root, `${generation}/inputs.json`, json(selected.inputs));
  put(root, `${generation}/workspace.ia`, installationWorkspace(selected.lock, selected.inputs, selected.releases)!);
  put(root, '.ia/distributions.lock.json', json(selected.lock));
  put(root, '.ia/distributions/active.json', json(pointer));
  return root;
}
it('admits installed physical sources, native install edges and immutable editor navigation', () => {
  const root = install(),
    reader = open(root, { cache: false });
  try {
    expect(reader.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const records = reader.records(),
      installed = records.find((r) => r.name === 'installed-distributions')!;
    expect(installed.edges.some((e) => e.reference.kind === 'ref' && e.reference.name === 'public-language')).toBe(
      true,
    );
    expect(records.find((r) => r.name === 'public-workspace-system-steward')!.placement.band).toBe(90);
    const snapshot = new EditorSnapshot(readInputs(root));
    expect(
      snapshot.sources
        .filter((s) => s.path.startsWith('.ia/distributions/'))
        .every((s) => s.origin === 'installed' && !s.writable),
    ).toBe(true);
    expect(() => snapshot.candidate([{ path: installed.source.path, text: '#! ia 1.0\n', version: 1 }])).toThrow();
    snapshot.close();
    put(root, '.ia/distributions/store/inactive/junk', 'invisible');
    expect(readInputs(root).fingerprint).toBe(readInputs(root).fingerprint);
  } finally {
    reader.close();
  }
});
it('preserves old handles and invalidates scope tokens after activation and rollback counters', () => {
  const root = install(),
    reader = open(root, { cache: false }),
    token = reader.resolveScope().token,
    revision = reader.revision;
  try {
    put(root, '.ia/distributions/active.json', json({ ...pointer, previous: pointer.generation, counter: 2 }));
    expect(reader.records({ within: token }).length).toBeGreaterThan(100);
    expect(reader.revision).toBe(revision);
    reader.refresh();
    expect(reader.revision).not.toBe(revision);
    expect(() => reader.records({ within: token })).toThrow('previous source generation');
    const next = reader.resolveScope().token;
    put(root, '.ia/distributions/active.json', json({ ...pointer, counter: 3 }));
    reader.refresh();
    expect(() => reader.records({ within: next })).toThrow();
    expect(reader.revision).not.toBe(revision);
  } finally {
    reader.close();
  }
});
it('refuses missing activation, lock drift, pending recovery and mutated source/assets without repair', () => {
  for (const mode of ['missing', 'drift', 'pending', 'source', 'extra']) {
    const root = install();
    if (mode === 'missing') rmSync(join(root, '.ia/distributions/active.json'));
    if (mode === 'drift') put(root, '.ia/distributions.lock.json', json({ ...selected.lock, engine: '*' }));
    if (mode === 'pending') put(root, '.ia/distributions/pending.json', '{}');
    if (mode === 'source')
      put(root, `.ia/distributions/store/${packed.archiveDigest}/${packed.manifest.files[0]!.path}`, 'changed');
    if (mode === 'extra') put(root, `.ia/distributions/store/${packed.archiveDigest}/extra`, 'extra');
    expect(() => open(root, { cache: false })).toThrow(/restore-required|lock-drift|recovery-required|corrupt-state/);
  }
});
it('admits only an explicitly selected staged candidate without changing active or authored state', () => {
  const root = install();
  rmSync(join(root, '.ia/distributions/active.json'));
  const candidate = open(root, { cache: false, candidateInstallation: pointer });
  expect(candidate.records().some((r) => r.name === 'installed-distributions')).toBe(true);
  candidate.close();
  expect(
    readInputs(root, { candidateInstallation: null }).sources.every((s) => !s.path.startsWith('.ia/distributions/')),
  ).toBe(true);
  expect(() => open(root, { cache: false })).toThrow('restore-required');
});
function fresh(): string {
  const root = join(temporary, `fresh ${sequence++}`);
  mkdirSync(root);
  cacheArchive(root, packed.bytes);
  return root;
}
it('plans without source writes, installs, removes the final package and restores offline after relocation', () => {
  const root = fresh(),
    plan = planInstallation(root, selected.lock, 'install');
  expect(existsSync(join(root, '.ia/distributions/active.json'))).toBe(false);
  expect(plan.changes.added).toEqual(['test/foundation']);
  expect(applyInstallation(plan).status).toBe('installed');
  const reader = open(root, { cache: false });
  expect(reader.records().some((r) => r.name === 'installed-distributions')).toBe(true);
  reader.close();
  const relocated = fresh();
  put(relocated, '.ia/distributions.lock.json', json(selected.lock));
  expect(applyInstallation(planInstallation(relocated, selected.lock, 'restore')).generation).toBe(
    plan.pointer.generation,
  );
  const empty = { formatVersion: 1, engine: '0.1.0', requests: [], packages: [] };
  const removed = applyInstallation(planInstallation(root, empty, 'remove'));
  expect(removed.counter).toBe(2);
  const current = open(root, { cache: false });
  expect(current.records().some((r) => r.name === 'installed-distributions')).toBe(false);
  current.close();
  const rolledBack = applyInstallation(planInstallation(root, selected.lock, 'rollback'));
  expect(rolledBack.counter).toBe(3);
  expect(rolledBack.generation).toBe(plan.pointer.generation);
  expect(existsSync(join(root, '.ia/src'))).toBe(false);
});
it('refuses stale plans and concurrent installers while preserving unrelated files', () => {
  const root = fresh(),
    plan = planInstallation(root, selected.lock, 'install');
  put(root, '.ia/src/local.ia', '#! ia 1.0\n# changed\n');
  expect(() => applyInstallation(plan)).toThrow('bindings changed');
  const next = planInstallation(root, selected.lock, 'install');
  put(root, 'keep.txt', 'untouched');
  applyInstallation(next, {
    checkpoint: (name) => {
      if (name === 'pending') {
        expect(() => applyInstallation(next)).toThrow('Another installer');
        expect(() => open(root, { cache: false })).toThrow('recovery-required');
      }
    },
  });
  expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('untouched');
});
it('recovers every transaction commit boundary and interrupted recovery to the exact old/new state', () => {
  for (const point of ['generation:lock.json', 'pending', 'portable-lock', 'active', 'complete']) {
    const root = fresh(),
      plan = planInstallation(root, selected.lock, 'install');
    expect(() =>
      applyInstallation(plan, {
        checkpoint: (name) => {
          if (name === point) throw Error('injected');
        },
      }),
    ).toThrow('injected');
    if (['pending', 'portable-lock', 'active'].includes(point))
      expect(() => open(root, { cache: false })).toThrow('recovery-required');
    if (point === 'portable-lock')
      expect(() =>
        recoverInstallation(root, {
          checkpoint: () => {
            throw Error('interrupted recovery');
          },
        }),
      ).toThrow('interrupted recovery');
    recoverInstallation(root);
    const reader = open(root, { cache: false });
    expect(reader.records().some((r) => r.name === 'installed-distributions')).toBe(
      ['active', 'complete'].includes(point),
    );
    reader.close();
    expect(recoverInstallation(root)).toEqual({ status: 'current' });
  }
}, 90000);
it('refuses recovery of unknown edits and detects changed immutable store content before commit', () => {
  const root = fresh(),
    plan = planInstallation(root, selected.lock, 'install');
  expect(() =>
    applyInstallation(plan, {
      checkpoint: (name) => {
        if (name === 'portable-lock') {
          put(root, `.ia/distributions/store/${packed.archiveDigest}/${packed.manifest.files[0]!.path}`, 'changed');
        }
      },
    }),
  ).toThrow('differs');
  recoverInstallation(root);
  expect(existsSync(join(root, '.ia/distributions/active.json'))).toBe(false);
  const other = fresh(),
    next = planInstallation(other, selected.lock, 'install');
  expect(() =>
    applyInstallation(next, {
      checkpoint: (name) => {
        if (name === 'pending') throw Error('injected');
      },
    }),
  ).toThrow();
  put(other, '.ia/distributions.lock.json', json({ formatVersion: 1, engine: '*', requests: [], packages: [] }));
  expect(() => recoverInstallation(other)).toThrow('Unknown edited');
});
it('allows explicit matching authored system authority and refuses incompatible provider/version', () => {
  const root = install(),
    path = '.ia/src/systems/workspace-system/system.ia',
    text = packed.files.get(path)!.toString();
  put(root, path, text);
  const reader = open(root, { cache: false });
  expect(reader.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  reader.close();
  put(root, path, text.replace(/^  version "[^"]+"$/m, '  version "9.0.0"'));
  expect(() => open(root, { cache: false })).toThrow(/provider\/version|registry|source/i);
});
it('resolves exact installed resources and compiles both host products with activation-bound pins', () => {
  const root = install(),
    capture = captureWorkspace(root),
    inventory = resourceOccurrences(capture),
    owner = inventory.occurrences.find((o) => o.identity.endsWith('/example-method'))!;
  const content = packed.files.get('guide.md')!,
    key = { source: owner.source, revision: owner.revision, path: 'guide.md' },
    use = { key, role: 'body' as const, required: true, order: 0, delivery: 'inline' as const };
  const resources = captureResources(capture, {
    roots: [
      {
        source: owner.source,
        revision: owner.revision,
        root: join(root, '.ia/distributions/store', packed.archiveDigest),
      },
    ],
    files: [{ key, bytes: content.length, sha256: sha256(content), mediaType: 'text/markdown', encoding: 'utf8' }],
    associations: [{ owner, resources: [use] }],
  });
  const reader = open(root, { cache: false }),
    within = reader.resolveScope().token;
  try {
    expect(owner.source).toMatch(/^installed-/);
    expect(
      resolveResources(resources, capture, {
        reader,
        within,
        owners: [owner],
        allowedResources: [key],
        expectedDigest: resources.digest,
        maxBytes: 1000,
      }).items[0]!.file.content,
    ).toBe(content.toString());
    for (const host of [claudeProseCatalog, codexProseCatalog])
      for (const product of ['workspace', 'plugin'] as const) {
        const catalog = host(installedImplementationDigest(), {
          models: [{ id: 'inherit', name: 'inherit' }],
          tools: [],
          inputFields: [],
        });
        const body = {
          format: 'ia.projection-descriptor.v1',
          sourceRevisions: inventory.sourceRevisions,
          product,
          profiles: [catalog.profile],
          resourcesDigest: resources.digest,
          inventoryDigest: sha256('installed-fixture'),
          exports: [
            {
              id: 'author',
              outputName: 'installed-author',
              profile: catalog.profile.id,
              required: true,
              description: 'Use the admitted authoring method.',
              requirements: [],
              target: owner,
              resources: [use],
              presentation: { kind: 'command', invocation: 'explicit', arguments: [], body: [owner] },
            },
          ],
        };
        const result = compileProjection(capture, { ...body, digest: metadataDigest(body) }, resources, {
          reader,
          within,
          allowedResources: [key],
          expectedResourcesDigest: resources.digest,
          inventoryDigest: body.inventoryDigest,
          catalog,
          name: 'installed-foundation',
          version: '0.1.0',
        });
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'compiled' });
      }
    put(root, '.ia/distributions/active.json', json({ ...pointer, counter: 2 }));
    reader.refresh();
    expect(captureWorkspace(root).revision).not.toBe(capture.revision);
    expect(() =>
      resolveResources(resources, capture, {
        reader,
        within: reader.resolveScope().token,
        owners: [owner],
        allowedResources: [key],
        expectedDigest: resources.digest,
        maxBytes: 1000,
      }),
    ).toThrow();
  } finally {
    reader.close();
  }
});
it('executes the native CLI command boundary through plan/apply/list/remove/restore with explicit roots', async () => {
  const root = fresh();
  put(root, 'release.ia.tgz', packed.bytes);
  put(root, 'catalog.json', json([{ path: 'release.ia.tgz', withdrawn: false }]));
  put(root, 'requests.json', json(selected.lock.requests));
  await runNative([
    'plan',
    'install',
    '--root',
    root,
    '--catalog',
    'catalog.json',
    '--requests',
    'requests.json',
    '--out',
    '.ia/work/install.json',
  ]);
  expect((await runNative(['apply', '--root', root, '--plan', '.ia/work/install.json']))!.result).toMatchObject({
    status: 'installed',
  });
  expect((await runNative(['list', '--root', root]))!.result).toMatchObject({ status: 'installed' });
  const removal = (await runNative(['plan', 'remove', '--root', root, '--id', 'test/foundation']))!;
  applyInstallation(removal.result);
  put(root, '.ia/distributions.lock.json', json(selected.lock));
  expect((await runNative(['restore', '--root', root, '--offline']))!.result).toMatchObject({ status: 'installed' });
  await expect(
    runNative([
      'plan',
      'install',
      '--root',
      root,
      '--catalog',
      'catalog.json',
      '--requests',
      'requests.json',
      '--unknown',
      'value',
    ]),
  ).rejects.toThrow();
});
it('updates a requested compatible range, reports withdrawal and retains exact offline restoration', async () => {
  const root = fresh();
  applyInstallation(planInstallation(root, selected.lock, 'install'));
  const next = buildArchive({ ...packed.manifest, version: '0.1.1' }, packed.files);
  put(root, 'next.ia.tgz', next);
  put(root, 'catalog.json', json([{ path: 'next.ia.tgz', withdrawn: false }]));
  const planned = (await runNative([
    'plan',
    'update',
    '--root',
    root,
    '--catalog',
    'catalog.json',
    '--id',
    'test/foundation',
    '--to',
    '^0.1.0',
  ]))!.result;
  expect(planned).toMatchObject({
    changes: { updated: ['test/foundation'] },
    lock: { packages: [{ version: '0.1.1' }] },
  });
  applyInstallation(planned);
  put(root, 'catalog.json', json([{ path: 'next.ia.tgz', withdrawn: true }]));
  await expect(runNative(['restore', '--root', root, '--catalog', 'catalog.json'])).rejects.toThrow(
    '--allow-withdrawn',
  );
  expect(
    (await runNative(['restore', '--root', root, '--catalog', 'catalog.json', '--allow-withdrawn']))!.result,
  ).toMatchObject({ status: 'installed', withdrawn: ['test/foundation'] });
  expect((await runNative(['restore', '--root', root, '--offline']))!.result).toMatchObject({ status: 'installed' });
});
it('collects only verified orphan archives and preserves every retained generation and unrelated file', () => {
  const root = fresh();
  applyInstallation(planInstallation(root, selected.lock, 'install'));
  const orphan = cacheArchive(root, buildArchive({ ...packed.manifest, version: '0.1.1' }, packed.files));
  put(root, 'keep.txt', 'keep');
  expect(collectInstallationGarbage(root)).toMatchObject({
    status: 'planned',
    archives: [orphan.archiveDigest],
    retainedGenerations: [pointer.generation],
  });
  expect(existsSync(join(root, `.ia/distributions/cache/${orphan.archiveDigest}.ia.tgz`))).toBe(true);
  expect(collectInstallationGarbage(root, true).archives).toEqual([orphan.archiveDigest]);
  expect(existsSync(join(root, `.ia/distributions/cache/${packed.archiveDigest}.ia.tgz`))).toBe(true);
  expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  expect(collectInstallationGarbage(root, true).archives).toEqual([]);
});
it('reads and collects an installation a Mac wrote Finder and AppleDouble files into, and still refuses any other extra file (#323)', () => {
  const root = install(),
    clean = readInputs(root).fingerprint,
    store = `.ia/distributions/store/${packed.archiveDigest}`,
    generation = `.ia/distributions/generations/${pointer.generation}`;
  for (const path of [
    `${store}/.DS_Store`,
    `${store}/._guide.md`,
    `${generation}/.DS_Store`,
    `${generation}/._lock.json`,
    '.ia/distributions/generations/.DS_Store',
    '.ia/distributions/cache/._archive.ia.tgz',
  ])
    put(root, path, 'written by the platform');
  expect(readInputs(root).fingerprint).toBe(clean);
  expect(collectInstallationGarbage(root)).toMatchObject({
    status: 'planned',
    archives: [],
    retainedGenerations: [pointer.generation],
  });
  const stored = install();
  put(stored, `${store}/notes.txt`, 'mine');
  expect(() => open(stored, { cache: false })).toThrow(/Extra installed file: notes.txt/);
  const generated = install();
  put(generated, `${generation}/notes.txt`, 'mine');
  expect(() => open(generated, { cache: false })).toThrow(/Extra generation files/);
  const retained = install();
  put(retained, '.ia/distributions/generations/notes.txt', 'mine');
  expect(() => collectInstallationGarbage(retained)).toThrow(/Unrecognized generation entry/);
  const cached = install();
  put(cached, '.ia/distributions/cache/notes.txt', 'mine');
  expect(() => collectInstallationGarbage(cached)).toThrow(/Unrecognized cache entry/);
});
it('still refuses another dotfile, and a directory or link named like a Mac file (#323)', () => {
  const store = `.ia/distributions/store/${packed.archiveDigest}`,
    generation = `.ia/distributions/generations/${pointer.generation}`;
  const dotfile = install();
  put(dotfile, `${store}/.npmrc`, 'registry=https://example.invalid\n');
  expect(() => open(dotfile, { cache: false })).toThrow(/Extra installed file: \.npmrc/);
  const folder = install();
  mkdirSync(join(folder, generation, '.DS_Store'));
  expect(() => open(folder, { cache: false })).toThrow(/Extra generation files/);
  const retained = install();
  mkdirSync(join(retained, '.ia/distributions/generations/._x'));
  expect(() => collectInstallationGarbage(retained)).toThrow(/Unrecognized generation entry/);
  if (process.platform === 'win32') return;
  const linked = install();
  mkdirSync(join(linked, '.ia/distributions/cache'));
  symlinkSync(join(linked, '.ia/distributions.lock.json'), join(linked, '.ia/distributions/cache/.DS_Store'));
  expect(() => collectInstallationGarbage(linked)).toThrow(/Unrecognized cache entry/);
});
it('verifies a pinned installed file named like a Mac file, and refuses it once it changes (#323)', () => {
  const path = '.ia/src/systems/governance-system/records/._pinned.ia',
    text = readFileSync(
      join(repository, 'examples/conformance/native/systems/governance-system/records/sample-convention.ia'),
      'utf8',
    ).replace('@convention sample-convention', '@convention pinned-debris-name');
  const pinned = fixture('pinned source', { [path]: text }),
    root = install(pinned);
  expect(pinned.packed.manifest.files.map((file) => file.path)).toContain(path);
  open(root, { cache: false }).close();
  put(
    root,
    `.ia/distributions/store/${pinned.packed.archiveDigest}/${path}`,
    text.replace('pinned-debris-name', 'pinned-debris-nome'),
  );
  expect(() => open(root, { cache: false })).toThrow(/Installed content differs: .*\._pinned\.ia/);
}, 30000);
it('removes an orphan store directory together with the Finder and AppleDouble files in it, and refuses one holding another file (#323)', () => {
  const orphaned = (extra: readonly string[]): { root: string; directory: string; archive: string } => {
    const root = fresh();
    applyInstallation(planInstallation(root, selected.lock, 'install'));
    const orphan = cacheArchive(root, buildArchive({ ...packed.manifest, version: '0.1.1' }, packed.files)),
      directory = `.ia/distributions/store/${orphan.archiveDigest}`;
    for (const [path, bytes] of orphan.files) put(root, `${directory}/${path}`, bytes);
    put(root, `${directory}/distribution.json`, json(orphan.manifest));
    for (const path of extra) put(root, `${directory}/${path}`, 'written by the platform');
    return { root, directory, archive: orphan.archiveDigest };
  };
  const debris = orphaned(['.DS_Store', '.ia/.DS_Store', '._guide.md']);
  expect(collectInstallationGarbage(debris.root, true).archives).toEqual([debris.archive]);
  expect(existsSync(join(debris.root, debris.directory))).toBe(false);
  const mine = orphaned(['notes.txt']);
  expect(() => collectInstallationGarbage(mine.root, true)).toThrow(/Extra installed file: notes.txt/);
  expect(existsSync(join(mine.root, mine.directory, 'notes.txt'))).toBe(true);
});
