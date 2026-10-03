import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { fetchBounded } from './bounded-fetch.js';
import { bytes, fail, workspace } from './files.js';
import { cacheArchive } from './install.js';
import type { ReleaseCandidate } from './resolve.js';

export interface ArtifactRequest {
  readonly root: string;
  readonly url: string;
  readonly digest: string;
  readonly offline?: boolean;
  readonly signal?: AbortSignal | undefined;
}
/** Bounded transport only: no verification/readiness claim and no cache writes. */
export async function readArtifactBytes(request: ArtifactRequest): Promise<Buffer> {
  request.signal?.throwIfAborted();
  const { url, digest } = request;
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('INPUT-INVALID', 'Expected immutable artifact digest');
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== url ||
    !parsed.pathname.endsWith(`/${digest}.ia.tgz`)
  )
    fail('INPUT-INVALID', 'Expected immutable credential-free HTTPS artifact URL');
  const root = workspace(request.root);
  const cached = bytes(root, `.ia/distributions/cache/${digest}.ia.tgz`, DISTRIBUTION_LIMITS.compressed);
  if (cached) return cached;
  if (request.offline === true) fail('RESTORE-REQUIRED', `Offline cache lacks ${digest}`);
  // §6.4: every transport refusal names the artifact URL; the "Remote archive" prefix is what the consumer CLI maps to class 4.
  const content = await fetchBounded({
    url,
    signal: request.signal,
    limit: DISTRIBUTION_LIMITS.compressed,
    label: 'Artifact request',
    oversize: (grew) => `Remote archive ${grew ? 'grew beyond' : 'exceeds'} its byte ceiling: ${url}`,
  });
  return content!;
}

/** One immutable HTTPS archive: verified independently before any cache write. */
export async function acquireArtifact(request: ArtifactRequest): Promise<ReleaseCandidate> {
  const content = await readArtifactBytes(request);
  request.signal?.throwIfAborted();
  return {
    release: cacheArchive(workspace(request.root), content, request.digest),
    location: request.url,
    withdrawn: false,
  };
}
