import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectionManifest, ProjectionResult } from '@inventarch/workspace-runtime/projections';
import {
  canonicalJson,
  bytes,
  contained,
  digest as metadataDigest,
  fail,
  json,
  object,
  portable,
  replace,
  sha256,
  syncDirectory,
  utf8,
  workspace,
} from './files.js';
import { reconcileConfig } from './config.js';

const area = '.ia/distributions/projections',
  pendingPath = `${area}/pending.json`,
  lockPath = `${area}/lock.json`;
const ceiling = 64 * 1024 * 1024;
type Compiled = Extract<ProjectionResult, { status: 'compiled' }>;
interface Owned {
  path: string;
  sha256: string;
  bytes: number;
  config: string | null;
}
interface State {
  format: 'ia.projection-publication.v1';
  id: string;
  manifest: ProjectionManifest;
  files: Owned[];
}
interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
interface Pending {
  format: 'ia.projection-pending.v1';
  id: string;
  before: string | null;
  after: string;
  changes: Change[];
}
export interface PublicationOptions {
  readonly checkpoint?: (name: string) => void;
  readonly fresh?: () => void;
}
export interface PublicationReport {
  readonly status: 'current' | 'stale' | 'published' | 'recovered' | 'removed';
  readonly id: string;
  readonly paths: readonly string[];
  readonly manifestDigest?: string;
}
const identifier = (id: string): string => {
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(id)) fail('INPUT-INVALID', 'Invalid publication id');
  return id;
};
const statePath = (id: string): string => `${area}/${identifier(id)}.json`;
function outputPath(path: string): string {
  portable(path);
  if (
    !/^(?:\.claude\/(?:agents|skills|commands)\/|\.codex\/agents\/|\.agents\/skills\/|(?:agents|skills|commands|resources)\/)/.test(
      path,
    ) &&
    !['.codex/config.toml', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'].includes(path)
  )
    fail('PATH-UNSAFE', `Not a projection output: ${path}`);
  return path;
}
const encoded = (value: Buffer | null): string | null => value?.toString('base64') ?? null;
function decoded(value: unknown): Buffer | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > ceiling)
    fail('INPUT-INVALID', 'Malformed recovery bytes');
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value) fail('INPUT-INVALID', 'Noncanonical recovery bytes');
  return content;
}
function state(content: Buffer | null, id: string): State | null {
  if (content === null) return null;
  const row = object(canonicalJson(content), ['format', 'id', 'manifest', 'files']);
  if (
    row['format'] !== 'ia.projection-publication.v1' ||
    row['id'] !== id ||
    !Array.isArray(row['files']) ||
    row['files'].length > 256
  )
    fail('INPUT-INVALID', 'Malformed projection publication state');
  const seen = new Set<string>();
  let total = 0;
  for (const value of row['files']) {
    const f = object(value, ['path', 'sha256', 'bytes', 'config']);
    if (
      typeof f['path'] !== 'string' ||
      typeof f['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f['sha256']) ||
      !Number.isSafeInteger(f['bytes']) ||
      (f['bytes'] as number) < 0 ||
      (f['bytes'] as number) > 1024 * 1024 ||
      !(
        f['config'] === null ||
        (typeof f['config'] === 'string' &&
          f['path'] === '.codex/config.toml' &&
          Buffer.byteLength(f['config']) <= 1024 * 1024)
      )
    )
      fail('INPUT-INVALID', 'Malformed owned output');
    const key = outputPath(f['path']).toLowerCase();
    if (seen.has(key)) fail('PATH-UNSAFE', 'Aliased owned outputs');
    seen.add(key);
    total += f['bytes'] as number;
  }
  if (total > 16 * 1024 * 1024) fail('LIMIT-EXCEEDED', 'Owned output ceiling exceeded');
  const manifest = row['manifest'];
  if (manifest === null || typeof manifest !== 'object' || !('digest' in manifest))
    fail('INPUT-INVALID', 'Missing projection manifest');
  const { digest, ...body } = manifest;
  if (digest !== metadataDigest(body)) fail('INTEGRITY-MISMATCH', 'Stored projection manifest digest differs');
  return row as unknown as State;
}
function noPending(root: string): void {
  if (bytes(root, pendingPath, ceiling) !== null)
    fail('RECOVERY-REQUIRED', 'Run recover-projection with this explicit output root before continuing');
}
function lock(root: string, recover: boolean): () => void {
  const target = contained(root, lockPath);
  mkdirSync(dirname(target), { recursive: true });
  if (recover && existsSync(target)) {
    const row = object(canonicalJson(bytes(root, lockPath, 4096)!), ['pid']);
    if (!Number.isSafeInteger(row['pid']) || (row['pid'] as number) <= 0)
      fail('INSTALL-BUSY', 'Invalid publication lock; manual reconciliation required');
    try {
      process.kill(row['pid'] as number, 0);
      fail('INSTALL-BUSY', 'Publication lock belongs to a live process');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    unlinkSync(target);
  }
  let fd: number;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('INSTALL-BUSY', 'Another projection publication holds the output lock');
    throw error;
  }
  try {
    writeFileSync(fd, json({ pid: process.pid }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    unlinkSync(target);
    syncDirectory(dirname(target));
  };
}
function current(root: string, id: string): { content: Buffer | null; value: State | null } {
  const content = bytes(root, statePath(id), ceiling);
  return { content, value: state(content, id) };
}
function aliases(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    let parent = '';
    for (const part of path.split('/')) {
      const folder = contained(root, parent);
      if (existsSync(folder))
        for (const name of readdirSync(folder))
          if (name.toLowerCase() === part.toLowerCase() && name !== part)
            fail('PATH-UNSAFE', `Output has a case alias: ${path}`);
      parent = parent ? `${parent}/${part}` : part;
    }
  }
}
function prepare(
  root: string,
  id: string,
  result: Compiled | null,
): { before: Buffer | null; after: Buffer; changes: Change[] } {
  noPending(root);
  const previous = current(root, id),
    old = new Map(previous.value?.files.map((f) => [f.path, f]) ?? []);
  const next = new Map(result?.files.map((f) => [outputPath(f.path), f]) ?? []);
  if (!result && !previous.value) fail('INPUT-INVALID', 'Projection is not installed');
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort();
  aliases(root, paths);
  if (new Set(paths.map((p) => p.toLowerCase())).size !== paths.length)
    fail('PATH-UNSAFE', 'Projection output aliases collide');
  const changes: Change[] = [],
    files: Owned[] = [];
  for (const path of paths) {
    const before = bytes(root, path),
      prior = old.get(path),
      file = next.get(path);
    const content = file ? Buffer.from(file.content, file.encoding) : null;
    if (file && (content!.length !== file.bytes || sha256(content!) !== file.sha256))
      fail('INTEGRITY-MISMATCH', 'Compiler file bytes differ');
    let after = content;
    if (path === '.codex/config.toml') {
      const nextBlock = content === null ? null : utf8(content);
      after = Buffer.from(reconcileConfig(before === null ? '' : utf8(before), id, prior?.config ?? null, nextBlock));
      if (after.length > 1024 * 1024) fail('LIMIT-EXCEEDED', 'Codex configuration exceeds 1 MiB');
      if (file) files.push({ path, sha256: sha256(after), bytes: after.length, config: nextBlock });
      // Empty created configurations can be removed; authored content is retained.
      if (!file && after.length === 0) after = null;
    } else {
      if (prior && (before === null || sha256(before) !== prior.sha256 || before.length !== prior.bytes))
        fail('LOCAL-MODIFICATION', `Owned output changed or disappeared: ${path}`);
      if (!prior && before !== null) fail('LOCAL-MODIFICATION', `Unmanaged output already exists: ${path}`);
      if (file) files.push({ path, sha256: file.sha256, bytes: file.bytes, config: null });
    }
    if (encoded(before) !== encoded(after)) changes.push({ path, before: encoded(before), after: encoded(after) });
  }
  const manifest = result?.manifest ?? previous.value!.manifest;
  const after = Buffer.from(json({ format: 'ia.projection-publication.v1', id, manifest, files } satisfies State));
  state(after, id);
  return { before: previous.content, after, changes };
}
export function checkProjection(outputRoot: string, id: string, result: Compiled): PublicationReport {
  const root = workspace(outputRoot),
    product = prepare(root, identifier(id), result);
  // Configuration digest may vary with unrelated user settings; compare only owned block/outputs.
  const previous = state(product.before, id);
  return {
    status: product.changes.length === 0 && previous?.manifest.digest === result.manifest.digest ? 'current' : 'stale',
    id,
    paths: product.changes.map((c) => c.path),
    manifestDigest: result.manifest.digest,
  };
}
function transact(root: string, id: string, result: Compiled | null, options: PublicationOptions): PublicationReport {
  const release = lock(root, false);
  try {
    const plan = prepare(root, id, result);
    options.fresh?.();
    const pending: Pending = {
      format: 'ia.projection-pending.v1',
      id,
      before: encoded(plan.before),
      after: plan.after.toString('base64'),
      changes: plan.changes,
    };
    const journal = Buffer.from(json(pending));
    if (journal.length > ceiling) fail('LIMIT-EXCEEDED', 'Recovery journal exceeds its ceiling');
    replace(root, pendingPath, journal);
    options.checkpoint?.('pending');
    for (const [index, change] of plan.changes.entries()) {
      if (encoded(bytes(root, change.path)) !== change.before)
        fail('LOCAL-MODIFICATION', `Output changed during publication: ${change.path}`);
      replace(root, change.path, decoded(change.after));
      options.checkpoint?.(`output:${index}`);
    }
    options.fresh?.();
    for (const change of plan.changes)
      if (encoded(bytes(root, change.path)) !== change.after)
        fail('LOCAL-MODIFICATION', `Published output changed before commit: ${change.path}`);
    if (encoded(bytes(root, statePath(id), ceiling)) !== encoded(plan.before))
      fail('RECOVERY-REQUIRED', 'Publication state changed before commit');
    replace(root, statePath(id), plan.after);
    options.checkpoint?.('commit');
    replace(root, pendingPath, null);
    options.checkpoint?.('complete');
    return {
      status: result ? 'published' : 'removed',
      id,
      paths: plan.changes.map((c) => c.path),
      ...(result ? { manifestDigest: result.manifest.digest } : {}),
    };
  } finally {
    release();
  }
}
export function publishProjection(
  outputRoot: string,
  id: string,
  result: Compiled,
  options: PublicationOptions = {},
): PublicationReport {
  return transact(workspace(outputRoot), identifier(id), result, options);
}
export function removeProjection(outputRoot: string, id: string, options: PublicationOptions = {}): PublicationReport {
  return transact(workspace(outputRoot), identifier(id), null, options);
}
export function recoverProjection(outputRoot: string, options: PublicationOptions = {}): PublicationReport {
  const root = workspace(outputRoot),
    release = lock(root, true);
  try {
    const content = bytes(root, pendingPath, ceiling);
    if (content === null) return { status: 'current', id: '', paths: [] };
    const row = object(canonicalJson(content), ['format', 'id', 'before', 'after', 'changes']);
    if (
      row['format'] !== 'ia.projection-pending.v1' ||
      typeof row['id'] !== 'string' ||
      typeof row['after'] !== 'string' ||
      !Array.isArray(row['changes']) ||
      row['changes'].length > 512
    )
      fail('INPUT-INVALID', 'Malformed pending publication');
    const id = identifier(row['id']),
      before = decoded(row['before']),
      after = decoded(row['after']);
    const oldState = state(before, id),
      newState = state(after, id)!;
    const paths = new Set([...(oldState?.files ?? []), ...newState.files].map((f) => f.path)),
      seen = new Set<string>();
    const changes = row['changes'].map((value): Change => {
      const c = object(value, ['path', 'before', 'after']);
      if (typeof c['path'] !== 'string' || !paths.has(c['path']) || seen.has(c['path']))
        fail('INPUT-INVALID', 'Unexpected recovery output');
      seen.add(c['path']);
      outputPath(c['path']);
      for (const field of ['before', 'after'] as const)
        if ((decoded(c[field])?.length ?? 0) > 1024 * 1024) fail('LIMIT-EXCEEDED', 'Recovery output exceeds limit');
      return c as unknown as Change;
    });
    const active = encoded(bytes(root, statePath(id), ceiling));
    if (active !== encoded(before) && active !== encoded(after))
      fail('RECOVERY-REQUIRED', 'Publication state matches neither recorded generation');
    const committed = active === encoded(after);
    // Complete preflight prevents partial rollback when any output was edited.
    for (const c of changes) {
      const actual = encoded(bytes(root, c.path));
      if (actual !== c.before && actual !== c.after)
        fail('LOCAL-MODIFICATION', `Recovery would overwrite a local edit: ${c.path}`);
    }
    for (const [index, c] of changes.entries()) {
      replace(root, c.path, decoded(committed ? c.after : c.before));
      options.checkpoint?.(`recover:${index}`);
    }
    replace(root, statePath(id), committed ? after : before);
    replace(root, pendingPath, null);
    return { status: 'recovered', id, paths: changes.map((c) => c.path) };
  } finally {
    release();
  }
}
