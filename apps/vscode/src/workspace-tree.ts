import type { EditorComposition, EditorDependency, EditorView, RecordSummary } from '@inventarch/runtime/editor';

export interface WorkspaceSnapshot {
  readonly key: string;
  readonly label: string;
  readonly view: EditorView;
  readonly composition: EditorComposition;
}
export interface WorkspaceRoot {
  readonly key: string;
  readonly label: string;
  readonly owner: string;
  readonly adoption?: EditorDependency;
}
export interface Entry {
  readonly id: string;
  readonly kind: 'workspace' | 'system' | 'record' | 'dependencies' | 'dependency';
  readonly label: string;
  readonly root: WorkspaceRoot;
  readonly parent?: Entry;
  readonly system?: string;
  readonly record?: RecordSummary;
  readonly dependency?: EditorDependency;
}
export const localRecord = (record: { readonly source: { readonly path: string } }): boolean =>
  record.source.path.startsWith('.ia/src/') && !record.source.path.startsWith('.ia/src/floor/');
const localRoot = (snapshot: WorkspaceSnapshot): WorkspaceRoot => ({
  key: snapshot.key,
  label: snapshot.label,
  owner: snapshot.key,
});
const pinnedRoot = (snapshot: WorkspaceSnapshot, adoption: EditorDependency): WorkspaceRoot => ({
  key: JSON.stringify([snapshot.key, adoption.prefix]),
  label:
    adoption.kind === 'installed'
      ? `${adoption.id} · ${adoption.version} installed`
      : `${adoption.id} · pinned ${adoption.revision.slice(0, 8)}`,
  owner: snapshot.key,
  adoption,
});

/** Equality is a navigation hint for captured local source only; never use this for hosted contract access. */
export function dependencyRoot(
  snapshots: readonly WorkspaceSnapshot[],
  owner: string,
  id: string,
): WorkspaceRoot | undefined {
  const snapshot = snapshots.find((s) => s.key === owner),
    adoption = snapshot?.composition.dependencies.find((d) => d.id === id);
  if (!snapshot || !adoption) return undefined;
  const match =
    adoption.kind === 'installed'
      ? undefined
      : snapshots.find((s) => s.key !== owner && s.composition.localRevision === adoption.revision);
  return match ? localRoot(match) : pinnedRoot(snapshot, adoption);
}
export function workspaceRoots(snapshots: readonly WorkspaceSnapshot[]): WorkspaceRoot[] {
  const roots = snapshots.map(localRoot);
  for (const snapshot of snapshots)
    for (const adoption of snapshot.composition.dependencies) {
      const target = dependencyRoot(snapshots, snapshot.key, adoption.id)!;
      if (!roots.some((root) => root.key === target.key)) roots.push(target);
    }
  return roots;
}
export const rootEntry = (root: WorkspaceRoot): Entry => ({ id: root.key, kind: 'workspace', label: root.label, root });
export function rootRecords(root: WorkspaceRoot, snapshots: readonly WorkspaceSnapshot[]): readonly RecordSummary[] {
  const records = snapshots.find((s) => s.key === root.owner)?.view.records ?? [];
  return records.filter((r) => (root.adoption ? r.source.path.startsWith(root.adoption.prefix) : localRecord(r)));
}
export function children(snapshots: readonly WorkspaceSnapshot[], parent?: Entry): Entry[] {
  if (!parent) return workspaceRoots(snapshots).map(rootEntry);
  const { root } = parent,
    snapshot = snapshots.find((s) => s.key === root.owner);
  if (!snapshot) return [];
  const entry = (kind: Entry['kind'], label: string, key: string, rest: Partial<Entry> = {}): Entry => ({
    id: JSON.stringify([parent.id, key]),
    kind,
    label,
    root,
    parent,
    ...rest,
  });
  const records = rootRecords(root, snapshots);
  if (parent.kind === 'workspace')
    return [
      ...[...new Set(records.map((r) => r.system ?? 'Unadmitted sources'))]
        .sort()
        .map((system) => entry('system', system, system, { system })),
      ...(!root.adoption && snapshot.composition.dependencies.length
        ? [entry('dependencies', 'Dependencies', 'dependencies')]
        : []),
    ];
  if (parent.kind === 'system')
    return records
      .filter((r) => (r.system ?? 'Unadmitted sources') === parent.system)
      .map((record) => entry('record', record.name, record.occurrence, { record }));
  if (parent.kind === 'dependencies' || (parent.kind === 'record' && !root.adoption)) {
    const used = new Set(
      snapshot.composition.uses.filter((u) => u.occurrence === parent.record?.occurrence).map((u) => u.dependency),
    );
    return snapshot.composition.dependencies
      .filter((d) => parent.kind === 'dependencies' || used.has(d.id))
      .map((dependency) => entry('dependency', dependency.id, dependency.prefix, { dependency }));
  }
  return [];
}
export function recordEntry(
  root: WorkspaceRoot,
  record: RecordSummary,
  snapshots: readonly WorkspaceSnapshot[],
): Entry | undefined {
  const system = children(snapshots, rootEntry(root)).find((e) => e.system === (record.system ?? 'Unadmitted sources'));
  return system ? children(snapshots, system).find((e) => e.record?.occurrence === record.occurrence) : undefined;
}
