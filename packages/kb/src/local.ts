import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspaceBytes } from '@inventarch/db';
import type { InputOptions } from '@inventarch/db';
import { EditorSnapshot } from '@inventarch/db/editor';
import { readInstalledGeneration } from '@inventarch/db/distribution';
import { captureWorkspace } from '@inventarch/workspace-runtime';
import type { Capture } from '@inventarch/workspace-runtime';
import { readBody } from '@inventarch/runtime';
import { parse, references } from '@inventarch/language';
import { selectedEdges } from './edges.js';
import type { KnowledgeEdge } from './edges.js';
import { nativeInput } from './foundation.js';
import { digest, fail, frozen, hash, LIMITS, selectedPath } from './format.js';
import { verifySelection } from './package.js';
import type { KnowledgeSelection } from './package.js';
import type { validateContent } from './validate.js';
export type KnowledgeRecord = ReturnType<typeof validateContent>['records'][number];
export interface KnowledgeSnapshot {
  readonly format: 'ia.kb.snapshot.v1';
  readonly sourceId: string;
  readonly digest: string;
  readonly nativeGraphRevision: string;
  readonly capture: Capture;
  readonly records: readonly KnowledgeRecord[];
  readonly edges: readonly KnowledgeEdge[];
  readonly unavailable: readonly { readonly identity: string; readonly code: string }[];
  readonly admission: {
    readonly ok: boolean;
    readonly unavailableChecks: readonly string[];
    readonly scope: 'selected-records';
    readonly checks: 'not-evaluated';
  };
}
export interface KnowledgeOptions {
  readonly identities?: readonly string[];
  readonly expectedRevision?: string;
  readonly input?: InputOptions;
  readonly selection?: KnowledgeSelection;
}
const snapshots = new WeakSet<KnowledgeSnapshot>();
export function requireSnapshot(value: KnowledgeSnapshot): void {
  if (!snapshots.has(value)) fail('Captured knowledge snapshot required');
}
/** Reads only bound resources of admitted, selected authored records; no index or directory creation. */
export function captureKnowledge(root: string, options: KnowledgeOptions = {}): KnowledgeSnapshot {
  const selector =
    options.selection ??
    (existsSync(join(root, '.ia/knowledge.json'))
      ? verifySelection(Buffer.from(readWorkspaceBytes(root, '.ia/knowledge.json', 64 * 1024)).toString('utf8'))
      : undefined);
  const selection = selector === undefined ? undefined : verifySelection(selector);
  if (
    options.identities !== undefined &&
    (!Array.isArray(options.identities) ||
      options.identities.length > 1000 ||
      options.identities.some((id) => typeof id !== 'string'))
  )
    fail('Invalid knowledge scope');
  const c = captureWorkspace(root, selection?.sourceId ?? 'workspace', options.input);
  const reader = new EditorSnapshot(nativeInput(c));
  try {
    if (options.expectedRevision !== undefined && reader.revision !== options.expectedRevision)
      fail('Native scope revision changed', 'IA-KB-SCOPE-STALE');
    const all = reader.records(),
      nodes = all.filter(
        (n) =>
          n.placement.kind === 'authored' &&
          n.source.path.startsWith('.ia/src/') &&
          !n.source.path.startsWith('.ia/src/floor/') &&
          (selection === undefined || selection.records.includes(n.identity)) &&
          (options.identities === undefined || options.identities.includes(n.identity)),
      );
    if (selection?.records.some((id) => !all.some((n) => n.identity === id)))
      fail('Knowledge selection contains unavailable records');
    const nativePaths = new Set(nodes.map((n) => n.source.path));
    let total = c.sources.filter((s) => nativePaths.has(s.path)).reduce((sum, s) => sum + Buffer.byteLength(s.text), 0);
    if (nativePaths.size > LIMITS.files || total > LIMITS.selectedBytes)
      fail('Knowledge selection exceeds capture budget');
    const files = new Map<string, Uint8Array>(),
      scope = reader.resolveScope({ identities: nodes.map((n) => n.identity) }).token;
    const selectedIds = new Set(nodes.map((n) => n.identity));
    const installedPaths = new Set(readInstalledGeneration(root)?.sources.map((source) => source.path) ?? []);
    const foundationNode = (node: (typeof all)[number]) =>
      node.placement.kind === 'floor' || installedPaths.has(node.source.path);
    const closureScope = reader.resolveScope({
      identities: all.filter((n) => selectedIds.has(n.identity) || foundationNode(n)).map((n) => n.identity),
    }).token;
    const unavailable: { identity: string; code: string }[] = [],
      records: KnowledgeRecord[] = [];
    for (const node of nodes) {
      const source = c.sources.find((s) => s.path === node.source.path)!;
      const recordText = source.text
        .split('\n')
        .slice(node.source.line - 1, node.source.endLine)
        .join('\n');
      const closure = references(parse('#! ia 1.0\n' + recordText, node.source.path).ast).every((use) => {
        try {
          const resolved = reader.resolve(use.reference, { within: closureScope });
          if (!resolved.ok) return false;
          return (
            resolved.fragment === undefined ||
            readBody(reader, resolved.identity + '#' + resolved.fragment, {
              within: closureScope,
              read: () => fail('Reference fragments do not read documents'),
            }).ok
          );
        } catch {
          return false;
        }
      });
      if (!closure) unavailable.push({ identity: node.identity, code: 'IA-KB-REFERENCE-UNAVAILABLE' });
      const result = readBody(reader, node.identity, {
        within: scope,
        read: (path) => {
          selectedPath(path);
          if (path.startsWith('.ia/') || (selection && !selection.resources.includes(path)))
            return fail('Body resource is outside selection');
          const prior = files.get(path);
          if (prior) return prior;
          if (nativePaths.size + files.size >= LIMITS.files) return fail('Knowledge file limit exceeded');
          const raw = readWorkspaceBytes(root, path, LIMITS.fileBytes);
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
          total += raw.length;
          if (total > LIMITS.selectedBytes) return fail('Knowledge byte limit exceeded');
          files.set(path, raw);
          return raw;
        },
      });
      if (!result.ok) {
        unavailable.push({ identity: node.identity, code: result.code });
        continue;
      }
      records.push({
        identity: node.identity,
        word: node.discriminator,
        sourcePath: source.path,
        line: node.source.line,
        endLine: node.source.endLine,
        recordText,
        recordSha256: hash(source.text),
        body: result.body.body,
        bodySha256: result.body.digest,
        bodyPath: result.body.path ?? null,
        certified: false,
        authority: 'inert',
      });
    }
    if (captureWorkspace(root, c.id, options.input).revision !== c.revision)
      fail('Native sources changed during capture', 'IA-KB-SNAPSHOT-CHANGED');
    for (const [path, bytes] of files)
      if (hash(readWorkspaceBytes(root, path, LIMITS.fileBytes)) !== hash(bytes))
        fail('Bound body changed during capture', 'IA-KB-SNAPSHOT-CHANGED');
    if (selection && options.identities === undefined && selection.resources.some((path) => !files.has(path)))
      fail('Unassociated or unavailable selected body resource');
    const edges = selectedEdges(
      reader,
      records.map((n) => n.identity),
    );
    // These records were admitted by the native reader. Whole-workspace checks
    // are not scoped knowledge results: even their absence can disclose excluded
    // records. Reference closure is reported separately above.
    const admission = {
      ok: true,
      unavailableChecks: [],
      scope: 'selected-records' as const,
      checks: 'not-evaluated' as const,
    };
    // Refusals expose selected records only; whole-workspace diagnostic paths are not copied to scoped responses.
    const base = {
      format: 'ia.kb.snapshot.v1' as const,
      sourceId: c.id,
      nativeGraphRevision: reader.revision,
      records,
      edges,
      unavailable,
    };
    const value = frozen({ ...base, digest: digest(base), capture: c, admission });
    snapshots.add(value);
    return value;
  } finally {
    reader.close();
  }
}
