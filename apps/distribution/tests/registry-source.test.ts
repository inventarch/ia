import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openRegistry, parseRegistryBase, registryBudget } from '../src/registry-source.js';
import { serveDirectory } from './registry-fixture.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-registry-src-'));
  made.push(p);
  return p;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const info = (name = 'Fixture') => JSON.stringify({ format: 'ia.registry.v1', name });
const index = (id: string) => JSON.stringify({ format: 'ia.registry-package.v1', id, releases: [] });
const registryDir = () => {
  const dir = temp();
  put(dir, 'ia-registry.json', info());
  put(dir, 'packages/acme/tools.json', index('acme/tools'));
  return dir;
};
const refusal = (code: string, message: RegExp) => ({
  code: `IA-DIST-${code}`,
  message: expect.stringMatching(message),
});
const MiB4 = 4 * 1024 * 1024;
/** A fetch stub answering every request with `respond()`. */
const stub = (respond: () => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    return respond();
  });
/** A body stream that records cancellation; `chunks` are served one per pull, then `after` runs (default: close). */
function body(chunks: Uint8Array[], after?: () => Promise<void>) {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      const next = chunks.shift();
      if (next) c.enqueue(next);
      else if (after) await after();
      else c.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

it('reads info and indexes from a directory and from HTTPS with the same results', async () => {
  const dir = registryDir();
  const local = await openRegistry(parseRegistryBase(dir, dir));
  expect(local.info).toEqual({ format: 'ia.registry.v1', name: 'Fixture' });
  expect((await local.index('acme/tools')).id).toBe('acme/tools');
  put(dir, `artifacts/${'a'.repeat(64)}.ia.tgz`, 'bytes');
  expect(local.artifactBytes('a'.repeat(64)).toString()).toBe('bytes');
  expect(() => local.artifactBytes('b'.repeat(64))).toThrow(
    expect.objectContaining(
      refusal('ARTIFACT-UNAVAILABLE', new RegExp(`^Registry .+ has no artifacts/${'b'.repeat(64)}\.ia\.tgz$`)),
    ),
  );
  linkSync(join(dir, 'artifacts', `${'a'.repeat(64)}.ia.tgz`), join(dir, 'alias.tgz'));
  expect(() => local.artifactBytes('a'.repeat(64))).toThrow(
    expect.objectContaining(refusal('PATH-UNSAFE', /unaliased/)),
  );
  expect(() => local.artifactUrl('a'.repeat(64))).toThrow(/no artifact URL/);
  const requested = serveDirectory(dir);
  const remote = await openRegistry(parseRegistryBase('https://registry.test/base', dir));
  expect(remote.info.name).toBe('Fixture');
  expect((await remote.index('acme/tools')).releases).toEqual([]);
  expect(requested).toEqual([
    'https://registry.test/base/ia-registry.json',
    'https://registry.test/base/packages/acme/tools.json',
  ]);
  expect(remote.artifactUrl('a'.repeat(64))).toBe(`https://registry.test/base/artifacts/${'a'.repeat(64)}.ia.tgz`);
  expect(() => remote.artifactUrl('A'.repeat(64))).toThrow(/digest/);
  expect(() => remote.artifactBytes('a'.repeat(64))).toThrow(/no artifact path/);
});
it('reads a missing package index as an empty index and never caches indexes', async () => {
  const dir = registryDir(),
    budget = registryBudget(10);
  const local = await openRegistry(parseRegistryBase(dir, dir), { budget });
  expect(await local.index('acme/none')).toEqual({ format: 'ia.registry-package.v1', id: 'acme/none', releases: [] });
  put(
    dir,
    'packages/acme/none.json',
    JSON.stringify({
      format: 'ia.registry-package.v1',
      id: 'acme/none',
      releases: [
        {
          version: '1.0.0',
          archive: 'a'.repeat(64),
          manifest: 'b'.repeat(64),
          engine: '^0.1.0',
          language: ['1.0'],
          dependencies: [],
          withdrawn: false,
          access: 'licensed',
        },
      ],
    }),
  );
  expect((await local.index('acme/none')).releases).toHaveLength(1);
  expect(budget.remaining).toBe(7);
  const requested = serveDirectory(dir),
    remote = await openRegistry(parseRegistryBase('https://registry.test/base/', dir));
  expect(await remote.index('acme/other')).toEqual({
    format: 'ia.registry-package.v1',
    id: 'acme/other',
    releases: [],
  });
  await remote.index('acme/tools');
  await remote.index('acme/tools');
  expect(requested.filter((u) => u.endsWith('/tools.json'))).toHaveLength(2);
  await expect(remote.index('../x')).rejects.toThrow(/provider\/name/);
});
it('parses HTTPS and directory bases and refuses other schemes, credentials, queries and fragments', () => {
  const from = temp();
  expect(parseRegistryBase('https://registry.test/a/b', from)).toEqual({
    kind: 'https',
    url: 'https://registry.test/a/b/',
  });
  expect(parseRegistryBase('https://Registry.Test/a/./c/', from)).toEqual({
    kind: 'https',
    url: 'https://registry.test/a/c/',
  });
  expect(parseRegistryBase('mirror', from)).toEqual({ kind: 'dir', path: resolve(from, 'mirror') });
  expect(parseRegistryBase(resolve(from, 'abs'), '/elsewhere')).toEqual({ kind: 'dir', path: resolve(from, 'abs') });
  expect(() => parseRegistryBase('http://registry.test/', from)).toThrow(/must be HTTPS/);
  expect(() => parseRegistryBase('file:///registry', from)).toThrow(/must be HTTPS/);
  expect(() => parseRegistryBase('ftp:registry', from)).toThrow(/must be HTTPS/);
  for (const bad of [
    'https://u:p@registry.test/',
    'https://u@registry.test/',
    'https://@registry.test/',
    'https://registry.test/?a=1',
    'https://registry.test/?',
    'https://registry.test/#x',
    'https://registry.test/#',
  ])
    expect(() => parseRegistryBase(bad, from), bad).toThrow(/credential-free, without query or fragment/);
  expect(() => parseRegistryBase('https://', from)).toThrow(/not a valid URL/);
  expect(() => parseRegistryBase('', from)).toThrow(/must not be empty/);
  for (const padded of [' https://registry.test/', 'https://registry.test/ ', ' mirror', 'mirror\t', '\n'])
    expect(() => parseRegistryBase(padded, from), JSON.stringify(padded)).toThrow(
      /^Registry base must not have surrounding whitespace$/,
    );
});
it('refuses bases that are not registries and names the base', async () => {
  const dir = temp();
  await expect(openRegistry(parseRegistryBase('absent', dir))).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: .*absent is not a directory$/),
  );
  put(dir, 'file', 'x');
  await expect(openRegistry(parseRegistryBase('file', dir))).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: .*file is not a directory$/),
  );
  await expect(openRegistry(parseRegistryBase(dir, dir))).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: .* has no ia-registry\.json$/),
  );
  put(dir, 'ia-registry.json', JSON.stringify({ format: 'ia.registry.v2', name: 'x' }));
  await expect(openRegistry(parseRegistryBase(dir, dir))).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: .*: Not an ia\.registry\.v1 registry$/),
  );
  put(dir, 'ia-registry.json', info());
  put(dir, 'packages/acme/tools.json', index('acme/other'));
  const reg = await openRegistry(parseRegistryBase(dir, dir));
  await expect(reg.index('acme/tools')).rejects.toMatchObject(
    refusal('INPUT-INVALID', /different package than acme\/tools: .*tools\.json$/),
  );
  serveDirectory(temp());
  await expect(openRegistry(parseRegistryBase('https://registry.test/base/', dir))).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: https:\/\/registry\.test\/base\/ has no ia-registry\.json$/),
  );
});
it('hands only a missing info file to the missing hook, with the base location', async () => {
  const dir = temp(),
    seen: string[] = [];
  const missing = (location: string): never => {
    seen.push(location);
    throw new Error('missing hook');
  };
  await expect(openRegistry(parseRegistryBase(dir, dir), { missing })).rejects.toThrow(/^missing hook$/);
  expect(seen).toEqual([dir]);
  put(dir, 'ia-registry.json', JSON.stringify({ format: 'ia.registry.v2', name: 'x' }));
  await expect(openRegistry(parseRegistryBase(dir, dir), { missing })).rejects.toMatchObject(
    refusal('INPUT-INVALID', /^Not a registry: .*: Not an ia\.registry\.v1 registry$/),
  );
  await expect(openRegistry(parseRegistryBase('absent', dir), { missing })).rejects.toMatchObject(
    refusal('INPUT-INVALID', /is not a directory$/),
  );
  expect(seen).toEqual([dir]);
});
it('shares one read budget across registries and refuses when it is exhausted', async () => {
  const dir = registryDir(),
    budget = registryBudget(3);
  const a = await openRegistry(parseRegistryBase(dir, dir), { budget }),
    b = await openRegistry(parseRegistryBase(dir, dir), { budget });
  await a.index('acme/tools');
  expect(budget.remaining).toBe(0);
  await expect(b.index('acme/tools')).rejects.toMatchObject(
    refusal('RESOLUTION-LIMIT', /^Resolution exceeded 3 registry reads$/),
  );
  await expect(openRegistry(parseRegistryBase(dir, dir), { budget })).rejects.toMatchObject({
    code: 'IA-DIST-RESOLUTION-LIMIT',
  });
  expect(registryBudget()).toEqual({ total: 256, remaining: 256 });
  const reg = await openRegistry(parseRegistryBase(dir, dir));
  for (let i = 0; i < 255; i += 1) await reg.index('acme/tools');
  await expect(reg.index('acme/tools')).rejects.toMatchObject(
    refusal('RESOLUTION-LIMIT', /^Resolution exceeded 256 registry reads$/),
  );
});
it('maps HTTPS statuses and network failures to the URL and keeps caller aborts', async () => {
  const base = parseRegistryBase('https://registry.test/base/', temp());
  stub(() => new Response('down', { status: 503 }));
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal(
      'ARTIFACT-UNAVAILABLE',
      /^Registry request https:\/\/registry\.test\/base\/ia-registry\.json returned 503$/,
    ),
  );
  let calls = 0;
  stub(() => ((calls += 1) === 1 ? new Response(info()) : new Response('gone', { status: 410 })));
  const reg = await openRegistry(base);
  await expect(reg.index('acme/tools')).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', /https:\/\/registry\.test\/base\/packages\/acme\/tools\.json returned 410$/),
  );
  const network = new TypeError('fetch failed');
  stub(() => {
    throw network;
  });
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal(
      'ARTIFACT-UNAVAILABLE',
      /^Registry request https:\/\/registry\.test\/base\/ia-registry\.json failed: fetch failed$/,
    ),
  );
  stub(() => {
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  });
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal(
      'ARTIFACT-UNAVAILABLE',
      /^Registry request https:\/\/registry\.test\/base\/ia-registry\.json failed: fetch failed \(unexpected redirect\)$/,
    ),
  );
  stub(() => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    });
  });
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', /failed: fetch failed \(connect ECONNREFUSED 127\.0\.0\.1:443\)$/),
  );
  stub(() => {
    throw new TypeError('fetch failed', { cause: 'not an error' });
  });
  await expect(openRegistry(base)).rejects.toMatchObject(refusal('ARTIFACT-UNAVAILABLE', /failed: fetch failed$/));
  const broken = body([], async () => {
    throw new TypeError('terminated');
  });
  stub(() => new Response(broken.stream));
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal('ARTIFACT-UNAVAILABLE', /ia-registry\.json failed: terminated$/),
  );
  const aborted = new AbortController();
  aborted.abort();
  let fetched = false;
  stub(() => {
    fetched = true;
    return new Response(info());
  });
  await expect(openRegistry(base, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetched).toBe(false);
});
it('bounds HTTPS documents by declared length and while streaming, cancelling the body', async () => {
  const base = parseRegistryBase('https://registry.test/base/', temp());
  const declared = body([new TextEncoder().encode(info())]);
  stub(() => new Response(declared.stream, { headers: { 'content-length': String(MiB4 + 1) } }));
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal('LIMIT-EXCEEDED', /exceeds 4 MiB: https:\/\/registry\.test\/base\/ia-registry\.json$/),
  );
  expect(declared.state.cancelled).toBe(true);
  const malformed = body([new TextEncoder().encode(info())]);
  stub(() => new Response(malformed.stream, { headers: { 'content-length': '12x' } }));
  await expect(openRegistry(base)).rejects.toMatchObject({ code: 'IA-DIST-LIMIT-EXCEEDED' });
  const streamed = body([new Uint8Array(MiB4), new Uint8Array(1), new Uint8Array(1)]);
  stub(() => new Response(streamed.stream));
  await expect(openRegistry(base)).rejects.toMatchObject(
    refusal('LIMIT-EXCEEDED', /grew beyond 4 MiB: https:\/\/registry\.test\/base\/ia-registry\.json$/),
  );
  expect(streamed.state.cancelled).toBe(true);
  // Exactly 4 MiB is accepted, declared or streamed: valid JSON padded with trailing whitespace to the byte bound.
  const full = (): Uint8Array => {
    const bytes = new Uint8Array(MiB4).fill(0x20);
    bytes.set(new TextEncoder().encode(info()));
    return bytes;
  };
  const exactDeclared = body([full()]);
  stub(() => new Response(exactDeclared.stream, { headers: { 'content-length': String(MiB4) } }));
  expect((await openRegistry(base)).info.name).toBe('Fixture');
  const whole = full(),
    exactStreamed = body([whole.subarray(0, MiB4 - 1), whole.subarray(MiB4 - 1), new Uint8Array(0)]);
  stub(() => new Response(exactStreamed.stream));
  expect((await openRegistry(base)).info.name).toBe('Fixture');
});
it('cancels an HTTPS body when the caller aborts mid-stream and keeps the abort', async () => {
  const controller = new AbortController();
  const stalled = body([new TextEncoder().encode('{"format":')], async () => {
    controller.abort();
    await new Promise(() => {});
  });
  stub(() => new Response(stalled.stream));
  await expect(
    openRegistry(parseRegistryBase('https://registry.test/base/', temp()), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(stalled.state.cancelled).toBe(true);
});
it('reports the 30 s timeout as a network failure naming the URL, and a caller abort as an abort', async () => {
  // The timeout signal is injected by spying on AbortSignal.timeout (no fake timers), so the test fires it on demand.
  const base = parseRegistryBase('https://registry.test/base/', temp()),
    timeouts: { ms: number; controller: AbortController }[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    timeouts.push({ ms, controller });
    return controller.signal;
  });
  const honoring = (onStart: () => void) =>
    vi.stubGlobal(
      'fetch',
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.redirect).toBe('error');
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
          onStart();
        }),
    );
  try {
    honoring(() =>
      timeouts.at(-1)!.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    await expect(openRegistry(base)).rejects.toMatchObject(
      refusal(
        'ARTIFACT-UNAVAILABLE',
        /^Registry request https:\/\/registry\.test\/base\/ia-registry\.json failed: The operation was aborted due to timeout$/,
      ),
    );
    expect(timeouts.map((t) => t.ms)).toEqual([30_000]);
    const caller = new AbortController(),
      reason = new DOMException('stop', 'AbortError');
    honoring(() => caller.abort(reason));
    await expect(openRegistry(base, { signal: caller.signal })).rejects.toBe(reason);
  } finally {
    vi.restoreAllMocks();
  }
});
it('bounds directory documents and refuses links, junctions and hard links', async () => {
  const dir = registryDir();
  put(dir, 'packages/acme/big.json', ' '.repeat(MiB4 + 1));
  const reg = await openRegistry(parseRegistryBase(dir, dir));
  await expect(reg.index('acme/big')).rejects.toMatchObject(
    refusal('LIMIT-EXCEEDED', /exceeds 4194304 bytes: packages\/acme\/big\.json/),
  );
  const outside = temp(),
    junctioned = temp();
  put(outside, 'tools.json', index('acme/tools'));
  put(junctioned, 'ia-registry.json', info());
  symlinkSync(outside, join(junctioned, 'packages'), 'junction');
  const viaJunction = await openRegistry(parseRegistryBase(junctioned, junctioned));
  await expect(viaJunction.index('acme/tools')).rejects.toMatchObject(
    refusal('PATH-UNSAFE', /Link\/junction is not allowed/),
  );
  const parent = temp();
  symlinkSync(dir, join(parent, 'reg'), 'junction');
  await expect(openRegistry(parseRegistryBase('reg', parent))).rejects.toMatchObject(
    refusal('PATH-UNSAFE', /Link\/junction is not allowed/),
  );
  const hard = temp();
  put(hard, 'original.json', info());
  linkSync(join(hard, 'original.json'), join(hard, 'ia-registry.json'));
  await expect(openRegistry(parseRegistryBase(hard, hard))).rejects.toMatchObject(
    refusal('PATH-UNSAFE', /Expected unaliased regular file: ia-registry\.json/),
  );
});
