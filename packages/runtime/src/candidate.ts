import { createHash } from 'node:crypto';
import { EditorSnapshot } from '@inventarch/db/editor';
import type { InputSnapshot } from '@inventarch/db';
import { parse } from '@inventarch/language';
import { recordsIn } from '@inventarch/language/editor';
import { stableSerialize } from '@inventarch/graph';
import { sourcePath } from './authoring/index.js';
import { evaluateSteward } from './steward.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown): string => hash(stableSerialize(value));
// Wire digests use sorted plain JSON, matching the journal protocol without a reverse dependency.
const jsonDigest = (value: unknown): string => {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, item]) => [k, ordered(item)]),
          )
        : v;
  return hash(JSON.stringify(ordered(value)));
};
export interface CandidateEnvelope {
  version: 1;
  sourceSet: string;
  base: { revision: string; composition: { sourceSet: string; revision: string }[] };
  target: { system: string; discriminator: string };
  files: { path: string; text: string; digest: string }[];
  evidence: { path: string; digest: string; line: number; endLine: number }[];
}
/** Host-owned disclosure and target boundary. Supply only sources disclosed to this run. */
export interface CandidateScope {
  sourceSet: string;
  revision: string;
  composition: CandidateEnvelope['base']['composition'];
  systems: readonly string[];
  paths: readonly string[];
}
export interface CandidateValidation {
  allowed: boolean;
  candidateDigest: string;
  artifactDigest: string;
  diagnostics: { code: string; path: string | null; line: number | null }[];
  citations: string[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
/** Pure candidate admission over exact captured bytes. No host path is read or written. */
export function validateCandidate(input: InputSnapshot, value: unknown, scope: CandidateScope): CandidateValidation {
  const diagnostics: CandidateValidation['diagnostics'] = [];
  const deny = (code: string, path: string | null = null, line: number | null = null): void => {
    diagnostics.push({ code, path, line });
  };
  if (
    !closed(value, ['version', 'sourceSet', 'base', 'target', 'files', 'evidence']) ||
    value['version'] !== 1 ||
    typeof value['sourceSet'] !== 'string' ||
    !closed(value['base'], ['revision', 'composition']) ||
    !closed(value['target'], ['system', 'discriminator']) ||
    !Array.isArray(value['files']) ||
    !Array.isArray(value['evidence']) ||
    value['files'].length < 1 ||
    value['files'].length > 10 ||
    value['evidence'].length > 100 ||
    Buffer.byteLength(stableSerialize(value)) > 1024 * 1024
  ) {
    return {
      allowed: false,
      candidateDigest: '',
      artifactDigest: '',
      diagnostics: [{ code: 'IA-CANDIDATE-INVALID', path: null, line: null }],
      citations: [],
    };
  }
  const candidate = value as unknown as CandidateEnvelope;
  const result = (): CandidateValidation => ({
    allowed: diagnostics.length === 0,
    candidateDigest: jsonDigest(candidate),
    artifactDigest: jsonDigest(candidate.files),
    diagnostics: diagnostics.slice(0, 100),
    citations: [],
  });
  if (
    candidate.sourceSet !== scope.sourceSet ||
    candidate.base.revision !== scope.revision ||
    digest(candidate.base.composition) !== digest(scope.composition)
  )
    deny('IA-CANDIDATE-BASE-CHANGED');
  if (
    !scope.systems.includes(candidate.target.system) ||
    !/^[a-z][a-z0-9-]*$/.test(candidate.target.discriminator) ||
    ['system', 'schema'].includes(candidate.target.discriminator)
  )
    deny('IA-CANDIDATE-TARGET-DENIED');
  const paths = new Set<string>(),
    existing = new Set(input.sources.map((s) => s.path.toLowerCase()));
  for (const file of candidate.files) {
    if (
      !closed(file, ['path', 'text', 'digest']) ||
      typeof file.path !== 'string' ||
      !sourcePath(file.path) ||
      file.path !== file.path.normalize('NFC') ||
      typeof file.text !== 'string' ||
      Buffer.byteLength(file.text) > 256 * 1024 ||
      Buffer.from(file.text).toString('utf8') !== file.text ||
      !sha(file.digest) ||
      hash(file.text) !== file.digest
    ) {
      deny('IA-CANDIDATE-BYTES-INVALID');
      continue;
    }
    if (
      !scope.paths.includes(file.path) ||
      !file.path.startsWith(`.ia/src/systems/${candidate.target.system}/`) ||
      paths.has(file.path.toLowerCase()) ||
      existing.has(file.path.toLowerCase()) ||
      /\/(system|steward)\.ia$/.test(file.path) ||
      file.path.includes('/schemas/')
    )
      deny('IA-CANDIDATE-PATH-DENIED');
    paths.add(file.path.toLowerCase());
    const records = recordsIn(parse(file.text, file.path).ast);
    if (
      !records.length ||
      records.some((r) => r.discriminator !== candidate.target.discriminator || r.name.endsWith('-steward'))
    )
      deny('IA-CANDIDATE-TARGET-DENIED');
  }
  for (const ref of candidate.evidence) {
    if (!closed(ref, ['path', 'digest', 'line', 'endLine'])) {
      deny('IA-CANDIDATE-EVIDENCE-INVALID');
      continue;
    }
    const source = input.sources.find((s) => s.path === ref.path);
    if (
      !source ||
      hash(source.text) !== ref.digest ||
      !Number.isSafeInteger(ref.line) ||
      !Number.isSafeInteger(ref.endLine) ||
      ref.line < 1 ||
      ref.endLine < ref.line ||
      ref.endLine > source.text.split('\n').length
    )
      deny('IA-CANDIDATE-EVIDENCE-INVALID');
  }
  if (diagnostics.length) return result();
  const before = new EditorSnapshot(input);
  let after: EditorSnapshot | undefined;
  try {
    const view = before.inspect(),
      registration = view.graph.registry.registrations.get(candidate.target.discriminator);
    if (
      registration?.system !== candidate.target.system ||
      !evaluateSteward(before.records(), candidate.target.system, { kind: 'operator' }).allowed
    ) {
      deny('IA-CANDIDATE-OWNER-UNAVAILABLE');
      return result();
    }
    // Build only from the disclosed snapshot. Candidate overlay helpers consult local aliases;
    // this remote-safe read boundary must not inspect a server's working directory.
    after = new EditorSnapshot({
      ...input,
      sources: [
        ...input.sources,
        ...candidate.files.map((f) => ({
          path: f.path,
          text: f.text,
          location: {
            placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
            provenance: 'workspace' as const,
          },
        })),
      ],
      folders: [...new Set([...input.folders, candidate.target.system])],
      fingerprint: digest({ base: input.fingerprint, candidate }),
    });
    const next = after.inspect(),
      oldErrors = new Set(view.report.findings.filter((f) => f.severity === 'error').map((f) => digest(f)));
    for (const finding of next.report.findings.filter((f) => f.severity === 'error' && !oldErrors.has(digest(f)))) {
      // Diagnostic prose can contain other identities. Return codes and candidate locations only.
      const local = paths.has(finding.path.toLowerCase());
      deny(finding.code, local ? finding.path : null, local ? finding.line : null);
    }
    const admitted = new Set(after.records().map((r) => digest([r.identity, r.source.path])));
    if (before.records().some((r) => !admitted.has(digest([r.identity, r.source.path]))))
      deny('IA-CANDIDATE-SHADOWS-SOURCE');
    for (const file of candidate.files)
      if (!after.records().some((r) => r.source.path === file.path)) deny('IA-CANDIDATE-NOT-ADMITTED', file.path);
    const response = result();
    if (response.allowed)
      response.citations = candidate.evidence.map(
        (e) => `${scope.sourceSet}@${scope.revision}:${e.path}#${e.line}-${e.endLine}`,
      );
    return response;
  } finally {
    after?.close();
    before.close();
  }
}
