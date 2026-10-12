import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registryAddCollection } from '../src/registry-build.js';
import { decodeCollectionIndex, workspaceRevision } from '../src/registry-collections.js';
import { openRegistry, registryBudget } from '../src/registry-source.js';
import { planAdoption, applyAdoption } from '../src/adoption.js';
import * as fileOperations from '../src/files.js';
import { snapshotFixture } from './snapshot-fixture.js';
import { adoptedBindings } from '@inventarch/db';

const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), 'ia-collections-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const files = [{ path: '.ia/src/work.ia', text: '#! ia 1.0\n' }];
const workspace = {
  format: 'ia.registry-workspace.v1' as const,
  id: 'example/workspace',
  releases: [{ version: '1.0.0', withdrawn: false, revision: workspaceRevision(files), files }],
};
const kit = {
  format: 'ia.registry-kit.v1' as const,
  id: 'example/kit',
  releases: [{ version: '1.0.0', withdrawn: false, distributions: [{ id: 'inventarch/language', range: '2.0.0' }] }],
};

it('indexes kits and source workspaces beside release indexes under the shared budget', async () => {
  const root = temporary();
  registryAddCollection(root, 'kit', kit);
  registryAddCollection(root, 'workspace', workspace);
  const budget = registryBudget(5),
    registry = await openRegistry({ kind: 'dir', path: root }, { budget });
  expect(await registry.index('kit', 'example/kit')).toEqual(kit);
  expect(await registry.index('workspace', 'example/workspace')).toEqual(workspace);
  expect((await registry.index('release', 'example/absent')).releases).toEqual([]);
  expect((await registry.index('kit', 'example/absent')).releases).toEqual([]);
  await expect(registry.index('workspace', 'example/absent')).rejects.toThrow(/registry reads/);
});

it('refuses republished metadata, native revision substitution and executable authority', () => {
  const root = temporary();
  registryAddCollection(root, 'kit', kit);
  expect(() =>
    registryAddCollection(root, 'kit', {
      ...kit,
      releases: [{ ...kit.releases[0]!, distributions: [{ id: 'example/other', range: '*' }] }],
    }),
  ).toThrow(/append-only/);
  expect(() =>
    decodeCollectionIndex(
      JSON.stringify({ ...workspace, releases: [{ ...workspace.releases[0], revision: 'f'.repeat(64) }] }),
      'workspace',
      workspace.id,
    ),
  ).toThrow(/revision/);
  for (const path of ['.ia/registries.json', '.claude/settings.json', 'handler.js', '../outside.md']) {
    const files = [{ path, text: '{}' }];
    expect(() =>
      decodeCollectionIndex(
        JSON.stringify({
          ...workspace,
          releases: [{ ...workspace.releases[0], files, revision: workspaceRevision(files) }],
        }),
        'workspace',
        workspace.id,
      ),
    ).toThrow();
  }
  for (const word of ['mandate', 'agent-profile', 'execution-binding', 'hook', 'capability', 'check']) {
    const files = [
      { path: '.ia/src/injection.ia', text: `#! ia 1.0\n@${word} injected\n  meaning\n    says "No authority"\n` },
    ];
    expect(() =>
      decodeCollectionIndex(
        JSON.stringify({
          ...workspace,
          releases: [{ ...workspace.releases[0], files, revision: workspaceRevision(files) }],
        }),
        'workspace',
        workspace.id,
      ),
    ).toThrow(/authority/);
  }
});

it('rejects unexpected credential/config fields and traversing collection identities', async () => {
  const root = temporary();
  mkdirSync(join(root, 'kits/example/kit'), { recursive: true });
  writeFileSync(join(root, 'ia-registry.json'), JSON.stringify({ format: 'ia.registry.v1', name: 'fixture' }));
  writeFileSync(
    join(root, 'kits/example/kit/index.json'),
    JSON.stringify({ ...kit, credentials: 'remote-credential' }),
  );
  const registry = await openRegistry({ kind: 'dir', path: root });
  await expect(registry.index('kit', 'example/kit')).rejects.toThrow();
  await expect(registry.index('workspace', '../escape')).rejects.toThrow();
});

it('keeps the declaration and binding unchanged when adoption publication fails', () => {
  const fixture = snapshotFixture();
  try {
    const root = fixture.target();
    const sources = fixture.input.sources
      .filter((source) => !source.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text }));
    for (const source of sources) fixture.put(root, `vendor/public/${source.path}`, source.text);
    fixture.put(
      root,
      '.ia/workspace.json',
      JSON.stringify({
        version: 1,
        adopted: [{ id: 'public', path: 'vendor/public', revision: workspaceRevision(sources) }],
      }),
    );
    fixture.put(root, '.ia/src/workspace.ia', '#! ia 1.0\n');
    writeFileSync(
      join(root, '.ia/src/workspace.ia'),
      '#! ia 1.0\n@workspace fixture\n  meaning\n    says "An adoption fixture"\n    answers "Which workspace?"\n  composition\n    systems []\n    sources [".ia/src @authored"]\n',
    );
    const release = workspace.releases[0]!;
    const plan = planAdoption(root, workspace.id, release);
    expect(plan.authored).not.toBeNull();
    const declaration = join(root, plan.authored!.path);
    const original = readFileSync(declaration, 'utf8');
    const replace = fileOperations.replace;
    const injected = vi.spyOn(fileOperations, 'replace').mockImplementation((root, path, content, mode) => {
      if (path === '.ia/workspace.json') throw new Error('injected manifest publication failure');
      return replace(root, path, content, mode);
    });
    try {
      expect(() => applyAdoption(plan)).toThrow(/injected/);
    } finally {
      injected.mockRestore();
    }
    expect(readFileSync(declaration, 'utf8')).toBe(original);
    expect(adoptedBindings(root)).toHaveLength(1);
    expect(existsSync(join(root, '.ia/adoption.lock'))).toBe(false);
    applyAdoption(plan);
    expect(adoptedBindings(root)).toHaveLength(2);
    expect(() =>
      planAdoption(root, workspace.id, {
        ...release,
        revision: workspaceRevision([{ path: '.ia/src/work.ia', text: '#! ia 1.0\n# different pin\n' }]),
        files: [{ path: '.ia/src/work.ia', text: '#! ia 1.0\n# different pin\n' }],
      }),
    ).toThrow(/already pinned/);
    writeFileSync(join(root, plan.tree, '.ia/src/work.ia'), '#! ia 1.0\n# tampered\n');
    expect(() => planAdoption(root, workspace.id, release)).toThrow();
  } finally {
    fixture.close();
  }
});

it('hashes native source order canonically and does not incorporate documentation into native revision', () => {
  const first = { path: '.ia/src/a.ia', text: '#! ia 1.0\n' },
    last = { path: '.ia/src/z.ia', text: '#! ia 1.0\n' };
  expect(workspaceRevision([last, first])).toBe(workspaceRevision([first, last]));
  expect(workspaceRevision([first, { path: 'README.md', text: 'Documentation' }])).toBe(workspaceRevision([first]));
});
