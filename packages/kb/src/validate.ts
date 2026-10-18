import { admitSourceCapture } from '@inventarch/workspace-runtime/sources';
import { resourceOccurrences, verifyResources } from '@inventarch/workspace-runtime/resources';
import { EditorSnapshot } from '@inventarch/db/editor';
import { readBody } from '@inventarch/runtime';
import { selectedEdges } from './edges.js';
import { parse, references } from '@inventarch/language';
import { digest, frozen, fail } from './format.js';
import type { KnowledgeFile, Provenance } from './format.js';
import { capture, nativeInput, requireFoundation } from './foundation.js';
import type { Foundation } from './foundation.js';
export interface PortableContent {
  readonly format: string;
  readonly provenance: Provenance;
  readonly files: readonly KnowledgeFile[];
  readonly digest: string;
}
const validated = new WeakSet<object>();
export const isValidated = (value: object): boolean => validated.has(value);
export function validateContent<T extends PortableContent>(portable: T, foundation: Foundation) {
  requireFoundation(foundation);
  const native = portable.files.filter((f) => f.path.startsWith('.ia/src/')),
    paths = new Set(native.map((f) => f.path));
  const sources = [
    ...foundation.capture.sources,
    ...native.map(({ path, text }) => ({
      path,
      text,
      location: {
        placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
        provenance: 'workspace' as const,
      },
    })),
  ];
  const folders = [
    ...new Set([
      ...foundation.capture.folders,
      ...native.flatMap((f) => {
        const m = /^\.ia\/src\/systems\/([^/]+)\//.exec(f.path);
        return m ? [m[1]!] : [];
      }),
    ]),
  ].sort();
  const c = capture({
    version: 1,
    id: portable.provenance.sourceId,
    sources,
    folders,
    floorOrigin: foundation.capture.floorOrigin,
    ...(foundation.capture.activation ? { activation: foundation.capture.activation } : {}),
  });
  const admission = admitSourceCapture(c);
  if (!admission.ok) fail('Native admission refused: ' + admission.diagnostics.map((d) => d.code).join(','));
  const reader = new EditorSnapshot(nativeInput(c)),
    base = new EditorSnapshot(nativeInput(foundation.capture));
  try {
    for (const r of base.records()) {
      const next = reader.get(r.identity);
      if (
        !next ||
        next.digest !== r.digest ||
        (portable.format !== 'iakb.portable.v1' &&
          (next.source.path !== r.source.path || digest(next.placement) !== digest(r.placement)))
      )
        fail('Native foundation override refused');
    }
    const nodes = reader.records().filter((r) => paths.has(r.source.path));
    if (nodes.some((r) => ['system', 'schema'].includes(r.discriminator)))
      fail('Portable custom systems/schema are outside this profile');
    if (!nodes.length || native.some((f) => !nodes.some((n) => n.source.path === f.path)))
      fail('Selected native file has no admitted records');
    for (const file of native) {
      for (const use of references(parse(file.text, file.path).ast)) {
        const resolved = reader.resolve(use.reference);
        if (!resolved.ok) throw new Error('Native reference closure refused: ' + resolved.code);
        if (resolved.fragment !== undefined) {
          const part = readBody(reader, resolved.identity + '#' + resolved.fragment, {
            read: () => fail('No document reads for native reference fragments'),
          });
          if (!part.ok) fail('Native reference fragment closure refused');
        }
      }
    }
    const scope = reader.resolveScope({ identities: nodes.map((n) => n.identity) }).token,
      selected = new Map(portable.files.map((f) => [f.path, f]));
    const records = nodes.map((node) => {
      const result = readBody(reader, node.identity, {
        within: scope,
        read: (path) => {
          const f = selected.get(path);
          if (!f || f.path.startsWith('.ia/')) return fail('Body resource not selected');
          return Buffer.from(f.text);
        },
      });
      if (!result.ok) return fail('Required document/body binding refused: ' + result.code);
      const source = selected.get(node.source.path)!;
      return {
        identity: node.identity,
        word: node.discriminator,
        sourcePath: source.path,
        line: node.source.line,
        endLine: node.source.endLine,
        recordText: source.text
          .split('\n')
          .slice(node.source.line - 1, node.source.endLine)
          .join('\n'),
        recordSha256: source.sha256,
        body: result.body.body,
        bodySha256: result.body.digest,
        bodyPath: result.body.path ?? null,
        certified: false as const,
        authority: 'inert' as const,
      };
    });
    const inventory = resourceOccurrences(c),
      associations = records
        .filter((r) => r.bodyPath !== null)
        .map((r) => {
          const owner = inventory.occurrences.find(
            (o) => o.identity === r.identity && o.path === r.sourcePath && o.source === c.id,
          );
          if (!owner) return fail('Native resource occurrence missing');
          return {
            owner,
            resources: [
              {
                key: { source: c.id, revision: c.revision, path: r.bodyPath! },
                role: 'body',
                order: 0,
                required: true,
                delivery: 'inline',
              },
            ],
          };
        })
        .sort((a, b) => {
          const key = (o: { source: string; revision: string; path: string; line: number; identity: string }) =>
            o.source + '@' + o.revision + ':' + o.path + ':' + o.line + ':' + o.identity;
          return key(a.owner) < key(b.owner) ? -1 : 1;
        });
    const bodyPaths = new Set(records.map((r) => r.bodyPath).filter(Boolean)),
      resources = portable.files
        .filter((f) => !f.path.startsWith('.ia/'))
        .map((f) => {
          if (!bodyPaths.has(f.path)) fail('Unassociated body resource in selection');
          return {
            key: { source: c.id, revision: c.revision, path: f.path },
            bytes: Buffer.byteLength(f.text),
            sha256: f.sha256,
            mediaType: f.path.endsWith('.md') ? 'text/markdown' : 'text/plain',
            encoding: 'utf8',
            content: f.text,
          };
        })
        .sort((a, b) => (a.key.path < b.key.path ? -1 : 1));
    const resourceBody = {
      format: 'ia.captured-resources.v1',
      sourceRevisions: inventory.sourceRevisions,
      nativeCaptureRevision: c.revision,
      files: resources,
      associations,
    };
    const capturedResources = verifyResources({ ...resourceBody, digest: digest(resourceBody) }, c);
    const value = frozen({
      portable,
      capture: c,
      resources: capturedResources,
      records,
      foundationPin: foundation.pin,
      nativeGraphRevision: reader.revision,
      edges: selectedEdges(
        reader,
        nodes.map((n) => n.identity),
      ),
      admission: { ...admission, meaning: 'structural-only; checks not evaluated are not passes' },
    });
    validated.add(value);
    return value;
  } finally {
    reader.close();
    base.close();
  }
}
