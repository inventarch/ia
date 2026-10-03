import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readInputs, open } from '@inventarch/db';
import type { AdoptedSource } from '@inventarch/db';
import {
  INSTALL_PATHS,
  canonicalDistributionJson,
  decodeBundleManifest,
  decodeDistributionLock,
  deriveGenerationInputs,
  generationDigest,
  installationWorkspace,
  sha256,
} from '@inventarch/db/distribution';
import { stableSerialize } from '@inventarch/graph';
import { EditorWorkspace } from '../src/editor/workspace.js';
import { evaluateSteward } from '../src/index.js';
import { workspace, put } from './workspace.js';

function foundation(): AdoptedSource {
  const sources = readInputs(resolve(import.meta.dirname, '../../..'))
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  return { id: 'foundation', revision: createHash('sha256').update(stableSerialize(sources)).digest('hex'), sources };
}
function install(root: string, id: string, version: string): string {
  const files = foundation().sources.filter((s) => s.path.startsWith('.ia/src/systems/')),
    names = [...new Set(files.map((f) => f.path.split('/')[3]!))].sort();
  const manifest = decodeBundleManifest({
    formatVersion: 1,
    id,
    version,
    distribution: 'workspace-system/definition/distribution/foundation-distribution',
    engine: '^0.1.0',
    language: ['1.0'],
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
    license: 'UNLICENSED',
    description: 'Installed fixture',
    roots: ['workspace-system/definition/distribution/foundation-distribution'],
    systems: names.map((name) => ({ name, provider: 'fixture', version, path: `.ia/src/systems/${name}` })),
    dependencies: [],
    files: files.map((f) => ({
      path: f.path,
      bytes: Buffer.byteLength(f.text),
      sha256: sha256(f.text),
      role: 'source',
    })),
  });
  const archive = sha256(`archive:${id}`),
    manifestText = canonicalDistributionJson(manifest),
    manifestDigest = sha256(manifestText);
  const lock = decodeDistributionLock({
    formatVersion: 1,
    engine: '^0.1.0',
    requests: [{ id, range: `^${version}` }],
    packages: [{ id, version, archive, manifest: manifestDigest, location: `sha256:${archive}`, dependencies: [] }],
  });
  const bundles = new Map([[id, { manifest, archiveDigest: archive, manifestDigest }]]),
    inputs = deriveGenerationInputs(lock, bundles),
    text = installationWorkspace(lock, inputs, bundles)!,
    generation = generationDigest(lock, inputs, text);
  put(root, `${INSTALL_PATHS.store}/${archive}/distribution.json`, manifestText);
  for (const file of files) put(root, `${INSTALL_PATHS.store}/${archive}/${file.path}`, file.text);
  for (const [path, value] of [
    ['lock.json', canonicalDistributionJson(lock)],
    ['inputs.json', canonicalDistributionJson(inputs)],
    ['workspace.ia', text],
  ] as const)
    put(root, `${INSTALL_PATHS.generations}/${generation}/${path}`, value);
  put(root, INSTALL_PATHS.lock, canonicalDistributionJson(lock));
  put(
    root,
    INSTALL_PATHS.active,
    canonicalDistributionJson({ formatVersion: 1, generation, previous: null, counter: 1 }),
  );
  return archive;
}
it('reports installed distribution packages as dependencies and attributes local uses to them', () => {
  const root = workspace(null),
    archive = install(root, 'fixture/foundation', '1.2.3'),
    path = '.ia/src/systems/agent-system/records/project-author.ia';
  put(
    root,
    path,
    '#! ia 1.0\n@agent project-author\n  meaning\n    says "An author for this project."\n    answers "Who writes here?"\n  governance\n    applies []\n',
  );
  const editor = new EditorWorkspace(root);
  try {
    const composition = editor.composition(),
      author = editor.view().records.find((r) => r.name === 'project-author')!,
      prefix = `.ia/distributions/store/${archive}/`;
    expect(author.status).toBe('admitted');
    expect(composition.dependencies).toEqual([
      expect.objectContaining({
        kind: 'installed',
        id: 'fixture/foundation',
        version: '1.2.3',
        archive,
        prefix,
        access: 'installed-package',
        files: foundation().sources.filter((s) => s.path.startsWith('.ia/src/systems/')).length,
      }),
    ]);
    expect(composition.dependencies[0]!.records).toBe(
      editor.view().records.filter((r) => r.source.path.startsWith(prefix)).length,
    );
    expect(composition.dependencies[0]!.records).toBeGreaterThan(100);
    expect(composition.dependencies[0]!.systems).toContain('agent-system');
    expect(
      composition.uses.filter((u) => u.occurrence === author.occurrence).map((u) => [u.dependency, u.reason]),
    ).toEqual([
      ['fixture/foundation', 'schema'],
      ['fixture/foundation', 'registration'],
    ]);
    expect(composition.uses.every((u) => u.target.readOnly && u.target.path.startsWith(prefix))).toBe(true);
  } finally {
    editor.close();
  }
});
it('uses one captured system membership for reads, steward lookup, target discovery and project proposal validation', () => {
  const root = workspace(null),
    adopted = [foundation()],
    options = { adopted, writableSystems: ['agent-system'] };
  const path = '.ia/src/systems/agent-system/records/project-author.ia';
  put(
    root,
    path,
    '#! ia 1.0\n@agent project-author\n  meaning\n    says "An author for this project."\n    answers "Who writes here?"\n  governance\n    applies []\n    requires "Read pinned sources."\n',
  );
  const db = open(root, { ...options, cache: false });
  try {
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const author = db.records().find((r) => r.name === 'project-author')!;
    expect(author.source.path).toBe(path);
    expect(author.placement.band).toBe(100);
    const decision = evaluateSteward(db.records(), 'agent-system', { kind: 'operator' });
    expect(decision.allowed).toBe(true);
    expect(decision.steward!.path).toContain('/adopted/foundation/');
  } finally {
    db.close();
  }
  const editor = new EditorWorkspace(root, options);
  try {
    const composition = editor.composition(),
      author = editor.view().records.find((r) => r.name === 'project-author')!;
    expect(composition.dependencies).toEqual([
      expect.objectContaining({
        kind: 'adopted',
        id: 'foundation',
        revision: adopted[0]!.revision,
        access: 'captured-source',
        files: adopted[0]!.sources.length,
      }),
    ]);
    expect(composition.uses.filter((u) => u.occurrence === author.occurrence).map((u) => u.reason)).toEqual([
      'schema',
      'registration',
    ]);
    expect(
      composition.uses.every((u) => u.target.readOnly && u.target.path.startsWith(composition.dependencies[0]!.prefix)),
    ).toBe(true);
    const actualFoundation = new EditorWorkspace(resolve(import.meta.dirname, '../../..'), { adopted: [] });
    try {
      expect(actualFoundation.composition().localRevision).toBe(adopted[0]!.revision);
    } finally {
      actualFoundation.close();
    }
    expect(editor.draftShapes().some((s) => s.discriminator === 'agent')).toBe(true);
    expect(editor.draftShapes().some((s) => s.system === 'workspace-system')).toBe(false);
    const draft = editor.draft('agent', 'reviewer', {
      'meaning/says': 'A project reviewer.',
      'meaning/answers': 'Who reviews?',
      'governance/applies': '[]',
    });
    expect(
      editor.validateProposal([draft], editor.stamp(), { system: 'agent-system', discriminator: 'agent' }).allowed,
    ).toBe(true);
    expect(editor.sources.filter((s) => s.origin === 'adopted').every((s) => !s.writable)).toBe(true);
    expect(existsSync(resolve(root, '.ia/src/systems/agent-system/system.ia'))).toBe(false);
    expect(existsSync(resolve(root, '.ia/src/systems/agent-system/steward.ia'))).toBe(false);
    editor.update([{ path, text: editor.sourceText(path)! + '\n# unsaved edit\n', version: 1 }]);
    expect(editor.composition().localRevision).not.toBe(composition.localRevision);
    expect(() => editor.composition(composition.stamp)).toThrow('view changed');
  } finally {
    editor.close();
  }
});
it('refuses mutable mount bytes and portable aliases before corpus admission', () => {
  const root = workspace(null),
    mount = foundation();
  const altered = { ...mount, sources: mount.sources.map((s, i) => (i === 0 ? { ...s, text: s.text + '\n' } : s)) };
  expect(() => open(root, { adopted: [altered], cache: false })).toThrow('revision');
  const aliases = { ...mount, sources: [{ path: '.ia/src/CON.ia', text: '#! ia 1.0\n' }] };
  expect(() => open(root, { adopted: [aliases], cache: false })).toThrow('Unsafe');
});
