import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EditorWorkspace } from '@inventarch/runtime/editor';
import {
  children,
  dependencyRoot,
  localRecord,
  recordEntry,
  rootRecords,
  workspaceRoots,
} from '../src/workspace-tree.js';
import type { WorkspaceSnapshot } from '../src/workspace-tree.js';

let root: string, foundation: EditorWorkspace, project: EditorWorkspace, snapshots: WorkspaceSnapshot[];
beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), 'ia-tree-'));
  foundation = new EditorWorkspace(resolve(import.meta.dirname, '../../..'), { adopted: [] });
  const captured = foundation.sources
    .filter((s) => localRecord({ source: s }))
    .map(({ path, text }) => ({ path, text }));
  const put = (path: string, text: string): void => {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  for (const name of ['author', 'architect'])
    put(
      `.ia/src/systems/agent-system/records/${name}.ia`,
      `#! ia 1.0\n@agent ${name}\n  meaning\n    says "Help with this project."\n    answers "Who helps?"\n  governance\n    applies []\n`,
    );
  put(
    '.ia/src/systems/workspace-system/records/inspection.ia',
    '#! ia 1.0\n@workspace inspection\n  meaning\n    says "Inspect this workspace."\n    answers "What is composed?"\n  composition\n    systems [@system agent-system, @system workspace-system]\n  relationships\n    uses @agent author\n    uses @agent architect\n',
  );
  project = new EditorWorkspace(root, {
    adopted: [{ id: 'foundation', revision: foundation.composition().localRevision, sources: captured }],
  });
  snapshots = [
    { key: 'oss', label: 'ia-open-source', view: foundation.view(), composition: foundation.composition() },
    { key: 'api', label: 'ia-api', view: project.view(), composition: project.composition() },
  ];
});
afterAll(() => {
  project?.close();
  foundation?.close();
  if (root?.startsWith(resolve(tmpdir(), 'ia-tree-'))) rmSync(root, { recursive: true, force: true });
});

it('keeps three local records under the API root while retaining full adopted admission', () => {
  const roots = children(snapshots);
  expect(roots.map((r) => r.label)).toEqual(['ia-open-source', 'ia-api']);
  const api = roots[1]!,
    groups = children(snapshots, api);
  expect(groups.map((r) => r.label)).toEqual(['agent-system', 'workspace-system', 'Dependencies']);
  const local = groups.filter((g) => g.kind === 'system').flatMap((g) => children(snapshots, g));
  expect(local.map((r) => r.label).sort()).toEqual(['architect', 'author', 'inspection']);
  expect(local.every((r) => r.record?.status === 'admitted')).toBe(true);
  expect(snapshots[1]!.view.records.length).toBeGreaterThan(100);
  expect(snapshots[1]!.view.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  for (const record of local) expect(children(snapshots, record).map((d) => d.label)).toEqual(['foundation']);
  expect(children(snapshots, groups[2]!)).toHaveLength(1);
});
it('explains schema, registration and typed references using the shared resolver', () => {
  const composition = snapshots[1]!.composition,
    workspace = snapshots[1]!.view.records.find((r) => r.name === 'inspection')!;
  const uses = composition.uses.filter((u) => u.occurrence === workspace.occurrence);
  expect(uses.filter((u) => u.reason === 'reference')).toHaveLength(2);
  expect(new Set(uses.map((u) => u.reason))).toEqual(new Set(['schema', 'registration', 'reference']));
  expect(uses.every((u) => u.target.readOnly)).toBe(true);
  const dependency = composition.dependencies[0]!,
    target = dependencyRoot(snapshots, 'api', dependency.id)!;
  const schema = rootRecords(target, snapshots).find(
    (r) => r.source.path === uses.find((u) => u.reason === 'schema')!.target.path.slice(dependency.prefix.length),
  )!;
  expect(schema.discriminator).toBe('schema');
  const entry = recordEntry(target, schema, snapshots)!;
  expect(entry.parent?.parent?.root.key).toBe('oss');
});
it('uses a separate read-only pinned parent when no exact open revision is available', () => {
  const changed = [
    { ...snapshots[0]!, composition: { ...snapshots[0]!.composition, localRevision: 'f'.repeat(64) } },
    snapshots[1]!,
  ];
  const roots = workspaceRoots(changed);
  expect(roots).toHaveLength(3);
  const target = dependencyRoot(changed, 'api', 'foundation')!;
  expect(target.adoption?.id).toBe('foundation');
  expect(target.owner).toBe('api');
  expect(rootRecords(target, changed).length).toBe(snapshots[0]!.view.records.filter(localRecord).length);
  expect(rootRecords(target, changed).every((r) => r.source.readOnly)).toBe(true);
  expect(workspaceRoots([snapshots[1]!])).toHaveLength(2);
});
it('does not match workspace names or flatten adopted records when a provider disappears', () => {
  const misleading = {
    ...snapshots[0]!,
    label: 'foundation',
    composition: { ...snapshots[0]!.composition, localRevision: '0'.repeat(64) },
  };
  expect(dependencyRoot([misleading, snapshots[1]!], 'api', 'foundation')!.adoption).toBeDefined();
  expect(dependencyRoot(snapshots, 'api', 'unknown')).toBeUndefined();
  expect(
    rootRecords(workspaceRoots(snapshots)[0]!, snapshots).some((r) => r.source.path.startsWith('.ia/src/floor/')),
  ).toBe(false);
});
it('labels installed packages by version and never matches them to an open workspace revision', () => {
  const project = snapshots[1]!,
    adopted = project.composition.dependencies[0]!,
    id = 'inventarch/language';
  const dependency = {
    kind: 'installed' as const,
    id,
    version: '0.1.0',
    archive: snapshots[0]!.composition.localRevision,
    prefix: adopted.prefix,
    access: 'installed-package' as const,
    files: adopted.files,
    records: adopted.records,
    systems: adopted.systems,
  };
  const installed = [
    snapshots[0]!,
    {
      ...project,
      key: 'roadmap',
      label: 'roadmap',
      composition: {
        ...project.composition,
        dependencies: [dependency],
        uses: project.composition.uses.map((u) => ({ ...u, dependency: id })),
      },
    },
  ];
  expect(workspaceRoots(installed).map((r) => r.label)).toEqual([
    'ia-open-source',
    'roadmap',
    'inventarch/language · 0.1.0 installed',
  ]);
  const groups = children(installed, children(installed)[1]!);
  expect(groups.at(-1)!.label).toBe('Dependencies');
  for (const record of groups.filter((g) => g.kind === 'system').flatMap((g) => children(installed, g)))
    expect(children(installed, record).map((d) => d.label)).toEqual([id]);
  const target = dependencyRoot(installed, 'roadmap', id)!;
  expect(target.adoption?.kind).toBe('installed');
  expect(target.owner).toBe('roadmap');
  expect(rootRecords(target, installed)).toHaveLength(adopted.records);
});
