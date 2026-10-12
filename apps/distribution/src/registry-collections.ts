import { createHash } from 'node:crypto';
import { stableSerialize } from '@inventarch/graph';
import { parse } from '@inventarch/language';
import {
  compareVersions,
  decodeDistributionJson,
  packageId,
  range,
  satisfies,
  version,
} from '@inventarch/db/distribution';
import { fail, object, portable } from './files.js';
import type { Registry } from './registry-source.js';

export type RegistryKind = 'release' | 'kit' | 'workspace';
export interface KitRelease {
  readonly version: string;
  readonly withdrawn: boolean;
  readonly distributions: readonly { readonly id: string; readonly range: string }[];
}
export interface WorkspaceFile {
  readonly path: string;
  readonly text: string;
}
export interface WorkspaceRelease {
  readonly version: string;
  readonly withdrawn: boolean;
  readonly revision: string;
  readonly files: readonly WorkspaceFile[];
}
export interface CollectionIndex<K extends 'kit' | 'workspace'> {
  readonly format: `ia.registry-${K}.v1`;
  readonly id: string;
  readonly releases: readonly (K extends 'kit' ? KitRelease : WorkspaceRelease)[];
}
export const collectionIndexPath = (kind: 'kit' | 'workspace', id: string): string =>
  `${kind === 'kit' ? 'kits' : 'workspaces'}/${packageId(id)}/index.json`;

/** Source-only registry workspaces cannot generate host instructions or authorize execution. */
const AUTHORITY = new Set(['mandate', 'agent-profile', 'execution-binding', 'hook', 'capability', 'check']);
export function workspaceRevision(files: readonly WorkspaceFile[]): string {
  return createHash('sha256')
    .update(
      stableSerialize(
        files
          .filter((file) => file.path.endsWith('.ia'))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    )
    .digest('hex');
}
export function workspaceFiles(value: unknown): readonly WorkspaceFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000)
    fail('INPUT-INVALID', 'Workspace needs 1 to 1000 source/document files');
  const seen = new Set<string>();
  let size = 0;
  const files = value
    .map((entry) => {
      const row = object(entry, ['path', 'text']);
      if (typeof row['path'] !== 'string' || typeof row['text'] !== 'string')
        fail('INPUT-INVALID', 'Invalid workspace source file');
      const path = row['path'],
        text = row['text'];
      portable(path);
      const native =
        path.startsWith('.ia/src/') && !path.toLowerCase().startsWith('.ia/src/floor/') && path.endsWith('.ia');
      const document = !path.startsWith('.') && /\.(?:md|txt)$/.test(path);
      if ((!native && !document) || seen.has(path.toLowerCase()) || Buffer.from(text).toString('utf8') !== text)
        fail('INPUT-INVALID', 'Workspace files must be distinct native sources or portable text documentation');
      seen.add(path.toLowerCase());
      const bytes = Buffer.byteLength(text);
      if (bytes > 1024 * 1024 || (size += bytes) > 3 * 1024 * 1024)
        fail('LIMIT-EXCEEDED', 'Workspace source content exceeds its byte limit');
      if (native) {
        // These directory names are excluded at every depth by the physical DB source reader.
        if (
          path
            .split('/')
            .slice(2, -1)
            .some((part) => ['node_modules', 'dist', '.git'].includes(part.toLowerCase()))
        )
          fail('INPUT-INVALID', `Native source directory is excluded from capture: ${path}`);
        const parsed = parse(text, path);
        if (parsed.diagnostics.length) fail('INPUT-INVALID', `Workspace source does not parse: ${path}`);
        const inspect = (records: typeof parsed.ast.records): void => {
          for (const record of records) {
            if (AUTHORITY.has(record.discriminator))
              fail(
                'AUTHORITY-REQUIRED',
                `Registry workspace cannot confer @${record.discriminator} authority; author and review it locally`,
              );
            inspect(record.nested);
          }
        };
        inspect(parsed.ast.records);
      }
      return Object.freeze({ path, text });
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((file) => file.path.endsWith('.ia'))) fail('INPUT-INVALID', 'Workspace has no native source');
  return Object.freeze(files);
}
export function decodeCollectionIndex<K extends 'kit' | 'workspace'>(
  content: string,
  kind: K,
  expected: string,
): CollectionIndex<K> {
  const row = object(decodeDistributionJson(content), ['format', 'id', 'releases']);
  const id = packageId(expected),
    format = `ia.registry-${kind}.v1` as const;
  if (row['format'] !== format || row['id'] !== id || !Array.isArray(row['releases']) || row['releases'].length > 1000)
    fail('INPUT-INVALID', `Invalid ${kind} index for ${id}`);
  const versions = new Set<string>();
  const releases = row['releases'].map((entry) => {
    const r = object(
      entry,
      kind === 'kit' ? ['version', 'withdrawn', 'distributions'] : ['version', 'withdrawn', 'revision', 'files'],
    );
    const v = version(r['version']);
    if (versions.has(v) || typeof r['withdrawn'] !== 'boolean')
      fail('INPUT-INVALID', `Invalid/duplicate ${kind} version`);
    versions.add(v);
    if (kind === 'kit') {
      if (!Array.isArray(r['distributions']) || !r['distributions'].length || r['distributions'].length > 128)
        fail('INPUT-INVALID', 'Kit needs 1 to 128 distributions');
      const ids = new Set<string>();
      const distributions = r['distributions'].map((entry) => {
        const d = object(entry, ['id', 'range']),
          dependency = packageId(d['id']);
        if (ids.has(dependency)) fail('INPUT-INVALID', 'Duplicate kit distribution');
        ids.add(dependency);
        return Object.freeze({ id: dependency, range: range(d['range']) });
      });
      return Object.freeze({ version: v, withdrawn: r['withdrawn'], distributions: Object.freeze(distributions) });
    }
    const files = workspaceFiles(r['files']),
      revision = workspaceRevision(files);
    if (r['revision'] !== revision) fail('INTEGRITY-MISMATCH', 'Workspace source revision differs');
    return Object.freeze({ version: v, withdrawn: r['withdrawn'], revision, files });
  });
  return Object.freeze({ format, id, releases: Object.freeze(releases) }) as CollectionIndex<K>;
}
export async function selectCollection<K extends 'kit' | 'workspace'>(
  registry: Registry,
  kind: K,
  id: string,
  requested: string,
): Promise<CollectionIndex<K>['releases'][number]> {
  const index = await registry.index(kind, id);
  return selectCollectionRelease(index, requested);
}
export function selectCollectionRelease<K extends 'kit' | 'workspace'>(
  index: CollectionIndex<K>,
  requested: string,
): CollectionIndex<K>['releases'][number] {
  range(requested);
  const selected = index.releases
    .filter((release) => !release.withdrawn && satisfies(release.version, requested))
    .sort((a, b) => compareVersions(a.version, b.version))[0];
  return selected ?? fail('NO-SOLUTION', `Registry has no available collection ${index.id}@${requested}`);
}
