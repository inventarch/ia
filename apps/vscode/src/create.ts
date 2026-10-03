import * as vscode from 'vscode';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProposalValidation } from '@inventarch/runtime/editor';

export interface CreationOutcome {
  readonly created: readonly string[];
  readonly saved: readonly string[];
  readonly failed: readonly string[];
}
/** Host-side defense immediately before a no-overwrite WorkspaceEdit. Runtime owns admission. */
export function assertCreatePath(root: string, path: string): void {
  const parts = path.split('/');
  if (
    !path.startsWith('.ia/src/systems/') ||
    !path.endsWith('.ia') ||
    parts.length < 5 ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[\\\u0000-\u001f<>:"|?*]|[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(`Unsafe target path: ${path}`);
  let current = root;
  for (const part of parts) {
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())
        throw new Error('Source parent is not a regular directory');
      const alias = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase() && name !== part);
      if (alias !== undefined) throw new Error(`Case alias already exists: ${alias}`);
    }
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Source aliases cannot be created through');
  }
  if (existsSync(current)) throw new Error(`File already exists: ${path}`);
}
export async function createFiles(
  root: string,
  review: ProposalValidation,
  revalidate: () => Promise<ProposalValidation>,
): Promise<CreationOutcome> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating files');
  if (!review.allowed) throw new Error('Resolve proposal findings before creating files');
  const fresh = await revalidate();
  if (
    !fresh.allowed ||
    fresh.stamp.ownerSession !== review.stamp.ownerSession ||
    fresh.stamp.viewRevision !== review.stamp.viewRevision ||
    JSON.stringify(fresh.files) !== JSON.stringify(review.files)
  )
    throw new Error('The proposal or its dependencies changed. Review the updated validation.');
  if (
    vscode.workspace.textDocuments.some(
      (d) =>
        d.isDirty &&
        d.uri.scheme === 'file' &&
        d.uri.fsPath.startsWith(root + requireSeparator()) &&
        d.uri.fsPath.endsWith('.ia'),
    )
  )
    throw new Error('Save or discard changed IA dependencies before creating files');
  const edit = new vscode.WorkspaceEdit(),
    created: string[] = [],
    saved: string[] = [],
    failed: string[] = [];
  for (const file of fresh.files) {
    assertCreatePath(root, file.path);
    const uri = vscode.Uri.file(resolve(root, file.path));
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString().toLowerCase() === uri.toString().toLowerCase()))
      throw new Error(`Target is already open: ${file.path}`);
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(file.text, 'utf8') });
  }
  const applied = await vscode.workspace.applyEdit(edit);
  for (const file of fresh.files) {
    const uri = vscode.Uri.file(resolve(root, file.path));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (readFileSync(uri.fsPath, 'utf8') !== file.text) {
        failed.push(file.path);
        continue;
      }
      created.push(file.path);
      if (await doc.save()) saved.push(file.path);
      else failed.push(file.path);
    } catch {
      failed.push(file.path);
    }
  }
  if (!applied && failed.length === 0)
    failed.push('WorkspaceEdit reported a partial or refused operation; inspect the new files.');
  return { created, saved, failed };
}
function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
