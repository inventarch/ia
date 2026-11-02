import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { adoptedBindings, open, readInputs } from '@inventarch/db';
import type { AdoptedSource } from '@inventarch/db';
import { parse } from '@inventarch/language';
import { packageId } from '@inventarch/db/distribution';
import { bytes, contained, createFile, fail, replace, workspace } from './files.js';
import { workspaceFiles, workspaceRevision } from './registry-collections.js';
import type { WorkspaceFile, WorkspaceRelease } from './registry-collections.js';

/** Pinned bytes must survive checkout: any converted byte changes the revision and refuses the workspace. */
export const OPEN_ATTRIBUTES = '.ia/open/.gitattributes';
const OPEN_ATTRIBUTES_TEXT = '* -text -filter -ident -working-tree-encoding\n';
/** Refuses what adoption could neither keep nor create; a regular file already there stays its owner's. */
function attributesMissing(root: string): boolean {
  const stat = lstatSync(contained(root, OPEN_ATTRIBUTES), { throwIfNoEntry: false });
  if (stat && !stat.isFile()) fail('LOCAL-MODIFICATION', `Expected a regular file: ${OPEN_ATTRIBUTES}`);
  return !stat;
}
export interface AdoptionPlan {
  readonly root: string;
  readonly id: string;
  readonly tree: string;
  readonly release: WorkspaceRelease;
  readonly fingerprint: string;
  readonly manifest: string | null;
  readonly nextManifest: string;
  readonly authored: { readonly path: string; readonly before: string; readonly after: string } | null;
}
/** A provider-qualified identity maps to a collision-resistant portable binding id. */
export function adoptionId(id: string): string {
  packageId(id);
  return `registry-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}
const MANIFEST = '.ia/workspace.json';
/** Validate the destination itself: unpublished mount bytes are outside the workspace input fingerprint. */
function verifyAdoptionTree(root: string, tree: string, files: readonly WorkspaceFile[], complete: boolean): void {
  const expected = new Map(files.map((file) => [file.path, Buffer.from(file.text)]));
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split('/');
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
  }
  const base = contained(root, tree),
    stat = lstatSync(base, { throwIfNoEntry: false });
  if (!stat) {
    if (complete) fail('LOCAL-MODIFICATION', `Adoption tree disappeared: ${tree}`);
    return;
  }
  if (!stat.isDirectory()) fail('LOCAL-MODIFICATION', `Adoption tree is not a directory: ${tree}`);
  const found = new Set<string>();
  const visit = (directory: string): void => {
    const path = directory ? `${tree}/${directory}` : tree;
    for (const entry of readdirSync(contained(root, path), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      const child = `${tree}/${relative}`;
      if (entry.isDirectory() && directories.has(relative)) visit(relative);
      else {
        const content = expected.get(relative);
        if (!entry.isFile() || !content) fail('LOCAL-MODIFICATION', `Unlisted adoption entry: ${child}`);
        if (!bytes(root, child, 1024 * 1024)?.equals(content))
          fail('LOCAL-MODIFICATION', `Adopted file differs: ${child}`);
        found.add(relative);
      }
    }
  };
  visit('');
  if (complete) {
    if (found.size !== expected.size) fail('LOCAL-MODIFICATION', `Adoption tree is incomplete: ${tree}`);
    // Use the same physical discovery as workspace bindings, including its directory exclusions and path spelling.
    const native = readInputs(base, { adopted: [], candidateInstallation: null })
      .sources.filter((source) => !source.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text }));
    if (workspaceRevision(native) !== workspaceRevision(files))
      fail('INTEGRITY-MISMATCH', `Adoption tree does not capture the selected native source bytes: ${tree}`);
  }
}
export function planAdoption(
  directory: string,
  id: string,
  selected: WorkspaceRelease,
  updateWorkspace = true,
): AdoptionPlan {
  const root = workspace(directory),
    files = workspaceFiles(selected.files);
  if (workspaceRevision(files) !== selected.revision) fail('INTEGRITY-MISMATCH', 'Workspace revision changed');
  const release = Object.freeze({ ...selected, files });
  const bindings = adoptedBindings(root),
    bindingId = adoptionId(id),
    tree = `.ia/open/${bindingId}/${release.revision}`;
  verifyAdoptionTree(root, tree, files, false);
  attributesMissing(root);
  const existing = bindings.find((binding) => binding.id === bindingId);
  if (existing && (existing.revision !== release.revision || existing.placement !== 'open'))
    fail(
      'CONFLICT',
      'Adoption is already pinned to another revision; remove its binding explicitly before replacing it',
    );
  const manifest = bytes(root, MANIFEST, 65536)?.toString('utf8') ?? null;
  const next = manifest === null ? { version: 1, adopted: [], open: [] } : JSON.parse(manifest);
  next.open ??= [];
  if (!existing) next.open.push({ id: bindingId, path: tree, revision: release.revision, reach: '' });
  if (bindings.length >= 16 && !existing) fail('LIMIT-EXCEEDED', 'At most 16 source bindings are supported');
  const snapshot = readInputs(root);
  const mounts: AdoptedSource[] = bindings.map((binding) => ({
    id: binding.id,
    revision: binding.revision,
    sources: snapshot.sources
      .filter((source) => source.path.startsWith(`${binding.tree}/`))
      .map((source) => ({ path: source.path.slice(binding.tree.length + 1), text: source.text })),
    ...(binding.placement === 'open' ? { placement: 'open' as const, reach: binding.reach ?? '' } : {}),
  }));
  if (!existing)
    mounts.push({
      id: bindingId,
      revision: release.revision,
      placement: 'open',
      reach: '',
      sources: files.filter((file) => file.path.endsWith('.ia')),
    });
  const candidate = open(root, { adopted: mounts, cache: false });
  try {
    if (candidate.refused.length || candidate.report.findings.some((finding) => finding.severity === 'error'))
      fail('CLOSURE-INVALID', 'Workspace adoption fails native admission');
  } finally {
    candidate.close();
  }
  let authored: AdoptionPlan['authored'] = null;
  if (updateWorkspace) {
    const candidates = snapshot.sources
      .filter((source) => source.path.startsWith('.ia/src/'))
      .flatMap((source) =>
        parse(source.text, source.path)
          .ast.records.filter((record) => record.discriminator === 'workspace')
          .map((record) => ({ source, record })),
      );
    if (candidates.length !== 1) fail('INPUT-INVALID', 'Adoption needs exactly one authored @workspace');
    const { source, record } = candidates[0]!;
    const field = record.sections
      .find((section) => section.name === 'composition')
      ?.children.find((child) => child.kind === 'field' && child.key === 'sources');
    if (!field || field.kind !== 'field' || field.value.kind !== 'list')
      fail('INPUT-INVALID', 'Workspace needs composition.sources');
    const entry = `${tree}/.ia/src @open`;
    if (!field.value.items.some((item) => 'text' in item && item.text === entry)) {
      const lines = source.text.split('\n'),
        first = lines[field.span.line - 1]!;
      const values = field.value.items.map((item) => {
        if (item.kind !== 'string') fail('INPUT-INVALID', 'Workspace sources must be strings');
        return item.text;
      });
      values.push(entry);
      lines.splice(
        field.span.line - 1,
        field.span.endLine - field.span.line + 1,
        `${/^\s*/.exec(first)![0]}sources [${values.map((value) => JSON.stringify(value)).join(', ')}]`,
      );
      authored = Object.freeze({ path: source.path, before: source.text, after: lines.join('\n') });
    }
  }
  return Object.freeze({
    root,
    id,
    tree,
    release,
    fingerprint: snapshot.fingerprint,
    manifest,
    nextManifest: JSON.stringify(next, null, 2) + '\n',
    authored,
  });
}
/** Immutable mounts are written first. A binding is published only after exact input revalidation under a local lock. */
export function applyAdoption(plan: AdoptionPlan): void {
  const lock = contained(plan.root, '.ia/adoption.lock');
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch {
    return fail('CONFLICT', 'An adoption is already in progress');
  }
  try {
    if (
      readInputs(plan.root).fingerprint !== plan.fingerprint ||
      (bytes(plan.root, MANIFEST, 65536)?.toString('utf8') ?? null) !== plan.manifest
    )
      fail('CONFLICT', 'Workspace changed after adoption was planned');
    verifyAdoptionTree(plan.root, plan.tree, plan.release.files, false);
    if (attributesMissing(plan.root)) createFile(plan.root, OPEN_ATTRIBUTES, Buffer.from(OPEN_ATTRIBUTES_TEXT));
    for (const file of plan.release.files) {
      const path = `${plan.tree}/${file.path}`,
        content = Buffer.from(file.text),
        current = bytes(plan.root, path, 1024 * 1024);
      if (current !== null && !current.equals(content)) fail('LOCAL-MODIFICATION', `Adopted file differs: ${path}`);
      if (current === null) createFile(plan.root, path, content);
    }
    if (
      readInputs(plan.root).fingerprint !== plan.fingerprint ||
      (bytes(plan.root, MANIFEST, 65536)?.toString('utf8') ?? null) !== plan.manifest
    )
      fail('CONFLICT', 'Workspace changed while adoption files were written');
    verifyAdoptionTree(plan.root, plan.tree, plan.release.files, true);
    if (plan.authored) {
      if (bytes(plan.root, plan.authored.path, 1024 * 1024)?.toString('utf8') !== plan.authored.before)
        fail('CONFLICT', 'Workspace declaration changed after adoption was planned');
      replace(plan.root, plan.authored.path, Buffer.from(plan.authored.after));
    }
    try {
      replace(plan.root, MANIFEST, Buffer.from(plan.nextManifest));
    } catch (error) {
      if (plan.authored && bytes(plan.root, plan.authored.path, 1024 * 1024)?.toString('utf8') === plan.authored.after)
        replace(plan.root, plan.authored.path, Buffer.from(plan.authored.before));
      throw error;
    }
  } finally {
    closeSync(fd!);
    unlinkSync(lock);
  }
}
