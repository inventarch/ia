import { closed, commitId, data, digest, fail, frozen, slug, verifyFiles, selectedPath, LIMITS } from './format.js';
import { committedReader } from './git.js';
import type { LegacyPortable } from './format.js';
import type { Foundation } from './foundation.js';
import { validateContent } from './validate.js';
import { requireFoundation } from './foundation.js';
const caches = new WeakMap<
  Foundation,
  { entries: Map<string, { value: ReturnType<typeof validateContent<LegacyPortable>>; bytes: number }>; bytes: number }
>();
export { createLegacyFoundation } from './foundation.js';
export type { LegacyPortable } from './format.js';
/** Frozen v1 decoder. New selections must use the new package writer. */
export function verifyPortable(input: unknown): LegacyPortable {
  const p = closed<LegacyPortable>(data(input), ['format', 'provenance', 'files', 'digest']);
  if (p.format !== 'iakb.portable.v1') fail('Invalid portable format');
  closed(p.provenance, ['sourceId', 'commit', 'verification']);
  slug(p.provenance.sourceId);
  commitId(p.provenance.commit);
  if (p.provenance.verification !== 'unverified') fail('Invalid provenance claim');
  verifyFiles(p.files, true);
  const { digest: pin, ...body } = p;
  if (digest(body) !== pin) fail('Portable digest mismatch');
  return frozen(p);
}
export function validatePortable(input: unknown, foundation: Foundation) {
  requireFoundation(foundation);
  const portable = verifyPortable(input);
  let cache = caches.get(foundation);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(foundation, cache);
  }
  const prior = cache.entries.get(portable.digest);
  if (prior) {
    cache.entries.delete(portable.digest);
    cache.entries.set(portable.digest, prior);
    return prior.value;
  }
  const value = validateContent(portable, foundation),
    bytes = Buffer.byteLength(JSON.stringify(value)),
    max = 32 * 1024 * 1024;
  if (bytes <= max) {
    while (cache.entries.size >= 8 || cache.bytes + bytes > max) {
      const key = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(key)!.bytes;
      cache.entries.delete(key);
    }
    cache.entries.set(portable.digest, { value, bytes });
    cache.bytes += bytes;
  }
  return value;
}

export interface LegacyPackageRequest {
  readonly repository: string;
  readonly commit: string;
  readonly paths: readonly string[];
  readonly sourceId: string;
  readonly gitTimeoutMs?: number;
}
/** Compatibility writer: unchanged v1 data shape, with isolated committed Git reads. */
export function packageFromCommit(request: LegacyPackageRequest): LegacyPortable {
  slug(request.sourceId);
  if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > LIMITS.files)
    fail('Explicit selected paths required');
  const selected = request.paths.map((path) => selectedPath(path, true)).sort();
  if (new Set(selected.map((p) => p.toLowerCase())).size !== selected.length) fail('Aliased selected path');
  const git = committedReader(request.repository, request.commit, request.gitTimeoutMs);
  const files = selected.map((path) => {
    const { bytes: _bytes, ...file } = git.read(path);
    return file;
  });
  const body = {
    format: 'iakb.portable.v1' as const,
    provenance: { sourceId: request.sourceId, commit: request.commit, verification: 'unverified' as const },
    files,
  };
  return verifyPortable({ ...body, digest: digest(body) });
}
