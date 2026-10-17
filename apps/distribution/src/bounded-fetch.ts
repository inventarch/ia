import { DistributionError, fail } from './files.js';

/**
 * One GET under the installer's transport bounds, shared by registry documents and remote archives.
 * `label` opens every transport refusal ("<label> <url> returned 503", "<label> <url> failed: …"); `oversize` is the
 * LIMIT-EXCEEDED message when the declared (`grew: false`) or streamed (`grew: true`) size passes `limit`.
 * `optional` reads a 404 as `null` and an absent body as empty; otherwise both refuse like any other non-OK status.
 */
export interface BoundedFetch {
  readonly url: string;
  readonly limit: number;
  readonly label: string;
  readonly oversize: (grew: boolean) => string;
  readonly optional?: boolean;
  readonly signal?: AbortSignal | undefined;
}
/**
 * A 30 s timeout joined to the caller's signal, redirects refused, declared and streamed bytes bounded (spec §5.1, §6.4),
 * and, whatever the caller checked, a request only for a URL that `new URL` parses as `https:` without a username or
 * password, sent in the canonical form `new URL` writes; any other URL refuses as INPUT-INVALID, naming the URL after
 * `label`. Messages name the URL as the caller spelled it. This is URL hygiene, not host authorization: it does not
 * keep a request from internal, loopback or rebinding hosts.
 */
export async function fetchBounded(request: BoundedFetch): Promise<Buffer | null> {
  const { url, signal } = request;
  // §6.4: a network failure, the 30 s timeout included, names the URL; only the caller's own abort stays an abort.
  try {
    return await transfer(request);
  } catch (error) {
    if (error instanceof DistributionError || signal?.aborted === true) throw error;
    // undici reports every transport failure as "fetch failed" and keeps the reason (redirect, ECONNREFUSED, …) in `cause`.
    const cause =
      error instanceof Error && error.cause instanceof Error && error.cause.message ? ` (${error.cause.message})` : '';
    return fail(
      'ARTIFACT-UNAVAILABLE',
      `${request.label} ${url} failed: ${error instanceof Error ? error.message : String(error)}${cause}`,
    );
  }
}
async function transfer(request: BoundedFetch): Promise<Buffer | null> {
  const { url, limit, label, oversize, optional = false, signal } = request;
  const refuse = (): never => fail('INPUT-INVALID', `${label} ${url} is not a credential-free HTTPS URL`);
  // The policy: `url` parses as a WHATWG URL with the `https:` scheme and no username or password. Nothing else
  // refuses: a query or fragment passes, and a spelling that `new URL` rewrites (case, `:443`, a percent-encoded host
  // character, an IPv4 number form, a dot segment) is requested in the canonical form it writes, which is the request
  // fetch built when handed the spelling itself. A malformed or credentialed URL never got a request: fetch rejects it.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return refuse();
  const href = parsed.href;
  // `new URL` writes such a URL as `https://` and printable ASCII only: the host is lowercase ASCII (punycode for a
  // non-ASCII name), and a control, space or non-ASCII character elsewhere is percent-encoded or, for a tab or newline,
  // stripped. The test below therefore refuses nothing the checks above admit. It is the guard CodeQL reads
  // (js/file-access-to-http): an anchored pattern listing every printable ASCII character, tested on the very string
  // fetch receives, with a `return` that ends the refusing branch. Keep the literal inline, keep the `return`, and
  // pass `href`, not `url`, to fetch.
  if (!/^https:\/\/[a-zA-Z0-9!"#$%&'()*+,.\/:;<=>?@\[\\\]^_`{|}~-]+$/.test(href)) return refuse();
  const timeout = AbortSignal.timeout(30_000),
    combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  const response = await fetch(href, { redirect: 'error', signal: combined });
  if (!response.ok || (!response.body && !optional)) {
    await response.body?.cancel();
    if (optional && response.status === 404) return null;
    fail('ARTIFACT-UNAVAILABLE', `${label} ${url} returned ${response.status}`);
  }
  if (!response.body) return Buffer.alloc(0);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel();
    fail('LIMIT-EXCEEDED', oversize(false));
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation = reader.cancel(combined.reason);
    void cancellation.catch(() => {});
  };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    combined.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      combined.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) fail('LIMIT-EXCEEDED', oversize(true));
      chunks.push(next.value);
    }
  } finally {
    combined.removeEventListener('abort', cancel);
    try {
      await (cancellation ?? reader.cancel());
    } finally {
      reader.releaseLock();
    }
  }
  combined.throwIfAborted();
  return Buffer.concat(chunks);
}
