import { isAbsolute, relative } from 'node:path';
import { EditorSnapshot } from '@inventarch/db/editor';
import { portablePath } from '@inventarch/workspace-runtime/resource-format';
import type { ResourceAssociation } from '@inventarch/workspace-runtime/resources';
import {
  closed,
  commitId,
  data,
  digest,
  fail,
  frozen,
  selectedPath,
  sha,
  slug,
  verifyFiles,
  LIMITS,
} from './format.js';
import type { KnowledgeFile, Provenance } from './format.js';
import { nativeInput, requireFoundation } from './foundation.js';
import type { Foundation, NativeProfile } from './foundation.js';
import { validateContent } from './validate.js';
import { committedReader } from './git.js';

export interface KnowledgeSelection {
  readonly format: 'ia.kb.selection.v1';
  readonly sourceId: string;
  readonly records: readonly string[];
  readonly resources: readonly string[];
}
export interface KnowledgePackage {
  readonly format: 'ia.kb.package.v1';
  readonly provenance: Provenance;
  readonly foundation: NativeProfile & { readonly capture: string; readonly grammar: string; readonly engine: string };
  readonly selection: KnowledgeSelection;
  readonly files: readonly (KnowledgeFile & { readonly bytes: number })[];
  readonly associations: readonly ResourceAssociation[];
  readonly digest: string;
}
export function verifySelection(input: unknown): KnowledgeSelection {
  const s = closed<KnowledgeSelection>(data(input, 64 * 1024), ['format', 'sourceId', 'records', 'resources']);
  if (s.format !== 'ia.kb.selection.v1') fail('Invalid knowledge selection format');
  slug(s.sourceId);
  if (
    !Array.isArray(s.records) ||
    !s.records.length ||
    s.records.length > 1000 ||
    s.records.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*){3}$/.test(id))
  )
    fail('Full native record identities required');
  if (
    !Array.isArray(s.resources) ||
    s.resources.length > LIMITS.files ||
    s.resources.some((path) => typeof path !== 'string' || path.startsWith('.ia/') || selectedPath(path) !== path)
  )
    fail('Explicit body resource paths required');
  if (
    new Set(s.records).size !== s.records.length ||
    new Set(s.resources.map((p) => p.toLowerCase())).size !== s.resources.length
  )
    fail('Duplicate selection');
  return frozen(s);
}
const profile = (f: Foundation) => ({ ...f.native, capture: f.capture.revision, grammar: f.grammar, engine: f.engine });
export function verifyPackage(input: unknown): KnowledgePackage {
  const p = closed<KnowledgePackage>(data(input), [
    'format',
    'provenance',
    'foundation',
    'selection',
    'files',
    'associations',
    'digest',
  ]);
  if (p.format !== 'ia.kb.package.v1') fail('Invalid knowledge package format');
  closed(p.provenance, ['sourceId', 'commit', 'verification']);
  slug(p.provenance.sourceId);
  commitId(p.provenance.commit);
  if (p.provenance.verification !== 'unverified') fail('Invalid provenance claim');
  closed(p.foundation, ['id', 'version', 'archive', 'manifest', 'capture', 'grammar', 'engine']);
  sha(p.foundation.archive);
  sha(p.foundation.manifest);
  sha(p.foundation.capture);
  verifySelection(p.selection);
  if (p.selection.sourceId !== p.provenance.sourceId) fail('Source selection mismatch');
  verifyFiles(p.files, false, true);
  if (!Array.isArray(p.associations) || p.associations.length > 1000) fail('Invalid resource associations');
  const { digest: pin, ...body } = p;
  if (digest(body) !== pin) fail('Knowledge package digest mismatch');
  return frozen(p);
}
export function validatePackage(input: unknown, foundation: Foundation) {
  requireFoundation(foundation);
  const p = verifyPackage(input);
  if (digest(p.foundation) !== digest(profile(foundation))) fail('Knowledge foundation profile mismatch');
  const view = validateContent(p, foundation);
  if (digest([...p.selection.records].sort()) !== digest(view.records.map((r) => r.identity).sort()))
    fail('Mixed or unselected native records in package');
  if (
    digest([...p.selection.resources].sort()) !==
    digest(
      p.files
        .filter((f) => !f.path.startsWith('.ia/'))
        .map((f) => f.path)
        .sort(),
    )
  )
    fail('Body selection mismatch');
  if (digest(p.associations) !== digest(view.resources.associations)) fail('Resource association mismatch');
  return view;
}
export interface PackageRequest {
  readonly repository: string;
  readonly commit: string;
  readonly selection: string;
  readonly foundation: Foundation;
  readonly gitTimeoutMs?: number;
}
export function packageFromCommit(request: PackageRequest): KnowledgePackage {
  const { repository, commit, foundation } = request;
  requireFoundation(foundation);
  const git = committedReader(repository, commit, request.gitTimeoutMs);
  const selectionPath = isAbsolute(request.selection)
    ? relative(repository, request.selection).replaceAll('\\', '/')
    : request.selection;
  portablePath(selectionPath);
  const selection = verifySelection(git.read(selectionPath).text);
  let total = 0;
  const native = git.nativePaths().map((path) => {
    const file = git.read(path);
    total += file.bytes;
    if (total > 16 * 1024 * 1024) fail('Native discovery byte limit exceeded');
    return file;
  });
  const sources = [
    ...foundation.capture.sources,
    ...native.map((f) => ({
      path: f.path,
      text: f.text,
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
  const reader = new EditorSnapshot({
    ...nativeInput(foundation.capture),
    sources,
    folders,
    fingerprint: digest(sources),
  });
  let selected: Set<string>;
  try {
    const nodes = selection.records.map((id) => {
      const node = reader.get(id);
      if (!node || !native.some((f) => f.path === node.source.path))
        return fail('Selected native record unavailable: ' + id);
      return node;
    });
    selected = new Set(nodes.map((n) => n.source.path));
    if (reader.records().some((n) => selected.has(n.source.path) && !selection.records.includes(n.identity)))
      fail('Mixed native file includes unselected records');
  } finally {
    reader.close();
  }
  const files = [
    ...native.filter((f) => selected.has(f.path)),
    ...selection.resources.map((path) => git.read(path)),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  verifyFiles(files, false, true);
  const base = {
    format: 'ia.kb.package.v1' as const,
    provenance: { sourceId: selection.sourceId, commit, verification: 'unverified' as const },
    foundation: profile(foundation),
    selection,
    files,
  };
  const validated = validateContent({ ...base, digest: digest(base) }, foundation);
  const body = { ...base, associations: validated.resources.associations };
  const result = verifyPackage({ ...body, digest: digest(body) });
  validatePackage(result, foundation);
  return result;
}
