import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registryAddCollection } from '../src/registry-build.js';
import { decodeCollectionIndex, workspaceRevision } from '../src/registry-collections.js';
import { openRegistry, registryBudget } from '../src/registry-source.js';
import { planAdoption, applyAdoption } from '../src/adoption.js';
import * as fileOperations from '../src/files.js';
import { snapshotFixture } from './snapshot-fixture.js';
import { adoptedBindings, readInputs } from '@inventarch/db';
import { runBounded } from '@tools/testing/subprocess.js';

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

function adoptionFixture() {
  const fixture = snapshotFixture(),
    root = fixture.target();
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
  fixture.put(
    root,
    '.ia/src/workspace.ia',
    '#! ia 1.0\n@workspace fixture\n  meaning\n    says "An adoption fixture"\n    answers "Which workspace?"\n  composition\n    systems []\n    sources [".ia/src @authored"]\n',
  );
  return { ...fixture, root };
}

it.each(['.ia/src/unlisted.ia', 'notes.md', 'unlisted/owner.txt'])(
  'refuses an unlisted destination entry %s without publishing or deleting owner bytes',
  (extra) => {
    const fixture = adoptionFixture();
    try {
      const release = workspace.releases[0]!;
      const plan = planAdoption(fixture.root, workspace.id, release);
      const declaration = readFileSync(join(fixture.root, plan.authored!.path));
      const manifest = readFileSync(join(fixture.root, '.ia/workspace.json'));
      const owner = `${plan.tree}/${extra}`;
      fixture.put(fixture.root, owner, '#! ia 1.0\n# owner bytes\n');
      const before = readInputs(fixture.root).fingerprint;
      expect(() => planAdoption(fixture.root, workspace.id, release)).toThrow(/Unlisted adoption entry/);
      expect(() => applyAdoption(plan)).toThrow(/Unlisted adoption entry/);
      expect(readInputs(fixture.root).fingerprint).toBe(before);
      expect(readFileSync(join(fixture.root, plan.authored!.path))).toEqual(declaration);
      expect(readFileSync(join(fixture.root, '.ia/workspace.json'))).toEqual(manifest);
      expect(readFileSync(join(fixture.root, owner), 'utf8')).toBe('#! ia 1.0\n# owner bytes\n');
      expect(adoptedBindings(fixture.root)).toHaveLength(1);
      expect(existsSync(join(fixture.root, plan.tree, '.ia/src/work.ia'))).toBe(false);
      expect(existsSync(join(fixture.root, '.ia/adoption.lock'))).toBe(false);
    } finally {
      fixture.close();
    }
  },
);

it.each(['unlisted', 'modified'])('rechecks %s destination bytes written during apply before publishing', (kind) => {
  const fixture = adoptionFixture();
  try {
    const plan = planAdoption(fixture.root, workspace.id, workspace.releases[0]!);
    const declaration = readFileSync(join(fixture.root, plan.authored!.path));
    const manifest = readFileSync(join(fixture.root, '.ia/workspace.json'));
    const target = `${plan.tree}/.ia/src/${kind === 'unlisted' ? 'unlisted' : 'work'}.ia`;
    const create = fileOperations.createFile;
    const injected = vi.spyOn(fileOperations, 'createFile').mockImplementation((root, path, content, mode) => {
      create(root, path, content, mode);
      fixture.put(root, target, '#! ia 1.0\n# concurrent owner bytes\n');
    });
    try {
      expect(() => applyAdoption(plan)).toThrow(/Unlisted adoption entry|Adopted file differs/);
    } finally {
      injected.mockRestore();
    }
    expect(readFileSync(join(fixture.root, target), 'utf8')).toBe('#! ia 1.0\n# concurrent owner bytes\n');
    expect(readFileSync(join(fixture.root, plan.authored!.path))).toEqual(declaration);
    expect(readFileSync(join(fixture.root, '.ia/workspace.json'))).toEqual(manifest);
    expect(adoptedBindings(fixture.root)).toHaveLength(1);
    expect(() => readInputs(fixture.root)).not.toThrow();
    expect(existsSync(join(fixture.root, '.ia/adoption.lock'))).toBe(false);
  } finally {
    fixture.close();
  }
});

const ATTRIBUTES = '.ia/open/.gitattributes';
it('keeps adopted bytes through a checkout that converts line endings', async () => {
  const fixture = adoptionFixture();
  try {
    const plan = planAdoption(fixture.root, workspace.id, workspace.releases[0]!);
    applyAdoption(plan);
    const path = `${plan.tree}/${files[0]!.path}`,
      pinned = readFileSync(join(fixture.root, path), 'utf8');
    expect(pinned).toContain('\n');
    const git = async (...args: string[]) => {
      const run = await runBounded('git', ['-C', fixture.root, '-c', 'core.autocrlf=true', ...args], {
        timeoutMs: 30_000,
      });
      expect(run.status, run.stderr).toBe(0);
    };
    await git('init', '--quiet');
    fixture.put(fixture.root, '.gitattributes', '* text eol=crlf filter=convert ident working-tree-encoding=UTF-16\n');
    const attributes = await runBounded('git', ['-C', fixture.root, 'check-attr', '-a', '--', path], {
      timeoutMs: 30_000,
    });
    expect(attributes.stdout).toContain(`${path}: text: unset`);
    expect(attributes.stdout).toContain(`${path}: filter: unset`);
    expect(attributes.stdout).toContain(`${path}: ident: unset`);
    expect(attributes.stdout).toContain(`${path}: working-tree-encoding: unset`);
    rmSync(join(fixture.root, '.gitattributes'));
    await git('add', '--', '.ia/open');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Adopted');
    rmSync(join(fixture.root, path));
    await git('checkout', '--', path);
    expect(readFileSync(join(fixture.root, path), 'utf8')).toBe(pinned);
  } finally {
    fixture.close();
  }
});

it('keeps a regular attributes file of any size that is already there', () => {
  const fixture = adoptionFixture(),
    owned = '*.ia -text\n' + '# note\n'.repeat(12_000);
  try {
    fixture.put(fixture.root, ATTRIBUTES, owned);
    applyAdoption(planAdoption(fixture.root, workspace.id, workspace.releases[0]!));
    expect(readFileSync(join(fixture.root, ATTRIBUTES), 'utf8')).toBe(owned);
  } finally {
    fixture.close();
  }
});

it('refuses an attributes path it could neither keep nor create before writing a mount', () => {
  const directory = adoptionFixture(),
    link = adoptionFixture(),
    late = adoptionFixture();
  try {
    directory.put(directory.root, `${ATTRIBUTES}/nested`, 'x');
    expect(() => planAdoption(directory.root, workspace.id, workspace.releases[0]!)).toThrow(
      `Expected a regular file: ${ATTRIBUTES}`,
    );
    mkdirSync(join(link.root, 'elsewhere'));
    mkdirSync(join(link.root, '.ia/open'), { recursive: true });
    symlinkSync(
      join(link.root, 'elsewhere'),
      join(link.root, ATTRIBUTES),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => planAdoption(link.root, workspace.id, workspace.releases[0]!)).toThrow('Link/junction is not allowed');
    const plan = planAdoption(late.root, workspace.id, workspace.releases[0]!);
    late.put(late.root, `${ATTRIBUTES}/nested`, 'x');
    expect(() => applyAdoption(plan)).toThrow(`Expected a regular file: ${ATTRIBUTES}`);
    expect(existsSync(join(late.root, plan.tree))).toBe(false);
  } finally {
    directory.close();
    link.close();
    late.close();
  }
});

it('resumes an exact partial tree and retries a complete pin with readable native membership', () => {
  const fixture = adoptionFixture();
  try {
    const selected = [files[0]!, { path: 'docs/README.md', text: 'Selected documentation' }];
    const release = { ...workspace.releases[0]!, files: selected, revision: workspaceRevision(selected) };
    const plan = planAdoption(fixture.root, workspace.id, release);
    fixture.put(fixture.root, `${plan.tree}/${selected[0]!.path}`, selected[0]!.text);
    applyAdoption(plan);
    const first = readInputs(fixture.root);
    expect(first.sources.find((source) => source.path === `${plan.tree}/${selected[0]!.path}`)?.text).toBe(
      selected[0]!.text,
    );
    expect(readFileSync(join(fixture.root, plan.tree, 'docs/README.md'), 'utf8')).toBe(selected[1]!.text);
    applyAdoption(planAdoption(fixture.root, workspace.id, release));
    expect(readInputs(fixture.root).fingerprint).toBe(first.fingerprint);
  } finally {
    fixture.close();
  }
});

it.each(['dist', 'nested/DiSt', 'node_modules', 'nested/NODE_MODULES', '.git', 'nested/.GiT', 'FLOOR'])(
  'rejects registry native paths hidden from physical capture: %s',
  (directory) => {
    const selected = [{ path: `.ia/src/${directory}/reference.ia`, text: '#! ia 1.0\n' }];
    expect(() =>
      decodeCollectionIndex(
        JSON.stringify({
          ...workspace,
          releases: [{ ...workspace.releases[0]!, files: selected, revision: workspaceRevision(selected) }],
        }),
        'workspace',
        workspace.id,
      ),
    ).toThrow(/excluded from capture|native sources/);
  },
);
