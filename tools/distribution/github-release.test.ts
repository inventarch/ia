import { expect, it, vi } from 'vitest';
import { githubRelease } from './github-release.mjs';

const sha = 'a'.repeat(40);
const tagSha = 'b'.repeat(40);
const options = {
  repository: 'inventarch/ia',
  version: '1.1.1',
  sha,
  token: 'test-token',
  notesFile: '/temporary/release notes.md',
  assets: ['/artifacts/ia-1.1.1.vsix', '/artifacts/npm-release.json', '/artifacts/system-compatibility.json'],
};
const reference = (target = sha, type = 'commit') => ({ ref: 'refs/tags/v1.1.1', object: { sha: target, type } });
const release = { id: 42, tag_name: 'v1.1.1' };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// gh api writes this JSON to stdout on a missing resource: it must never become an existing SHA.
const absent = () =>
  ok({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }, 404);
type Reply = () => Response;
const fixture = (overrides: Record<string, Reply> = {}) => {
  const routes: Record<string, Reply> = {
    'GET ': () => ok({ full_name: options.repository }),
    'GET /git/ref/tags/v1.1.1': absent,
    'GET /releases/tags/v1.1.1': absent,
    'POST /git/refs': () => ok(reference(), 201),
    ...overrides,
  };
  const writes: string[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).replace(`https://api.github.com/repos/${options.repository}`, '');
    const key = `${init?.method} ${path}`;
    if (init?.method !== 'GET') writes.push(key);
    const route = routes[key];
    if (!route) throw new Error(`Unexpected request: ${key}`);
    return route();
  });
  const run = vi.fn(() => Buffer.alloc(0));
  return { request, run, writes, invoke: () => githubRelease(options, { request, run }) };
};

it('creates exactly the absent tag and release after both 404 responses, retaining the release assets', async () => {
  const f = fixture();
  await expect(f.invoke()).resolves.toEqual({ tag: 'v1.1.1', tagCreated: true, releaseCreated: true });
  expect(f.request.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ['https://api.github.com/repos/inventarch/ia', 'GET'],
    ['https://api.github.com/repos/inventarch/ia/git/ref/tags/v1.1.1', 'GET'],
    ['https://api.github.com/repos/inventarch/ia/releases/tags/v1.1.1', 'GET'],
    ['https://api.github.com/repos/inventarch/ia/git/refs', 'POST'],
  ]);
  expect(JSON.parse(String(f.request.mock.calls[3]![1]!.body))).toEqual({ ref: 'refs/tags/v1.1.1', sha });
  expect(f.run).toHaveBeenCalledExactlyOnceWith(
    'gh',
    [
      'release',
      'create',
      'v1.1.1',
      '--repo',
      'inventarch/ia',
      '--verify-tag',
      '--title',
      'IA 1.1.1',
      '--notes-file',
      options.notesFile,
      ...options.assets,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
});

it('retains an exact existing lightweight tag and release without writes', async () => {
  const f = fixture({
    'GET /git/ref/tags/v1.1.1': () => ok(reference()),
    'GET /releases/tags/v1.1.1': () => ok(release),
  });
  await expect(f.invoke()).resolves.toEqual({ tag: 'v1.1.1', tagCreated: false, releaseCreated: false });
  expect(f.writes).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});

it('recovers a missing release on an exact existing tag without rewriting the tag', async () => {
  const f = fixture({ 'GET /git/ref/tags/v1.1.1': () => ok(reference()) });
  await f.invoke();
  expect(f.writes).toEqual([]);
  expect(f.run).toHaveBeenCalledOnce();
});

it('peels nested annotated tags to verify the commit instead of comparing the tag object SHA', async () => {
  const next = 'c'.repeat(40);
  const f = fixture({
    'GET /git/ref/tags/v1.1.1': () => ok(reference(tagSha, 'tag')),
    [`GET /git/tags/${tagSha}`]: () => ok({ sha: tagSha, object: { sha: next, type: 'tag' } }),
    [`GET /git/tags/${next}`]: () => ok({ sha: next, object: { sha, type: 'commit' } }),
    'GET /releases/tags/v1.1.1': () => ok(release),
  });
  await f.invoke();
  expect(f.writes).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});

for (const endpoint of ['GET ', 'GET /git/ref/tags/v1.1.1', 'GET /releases/tags/v1.1.1']) {
  for (const status of [401, 403, 409, 422, 429, 500, 503])
    it(`refuses ${endpoint} HTTP ${status} even if the error body looks like absence`, async () => {
      const f = fixture({ [endpoint]: () => ok({ message: 'Not Found', status: '404' }, status) });
      await expect(f.invoke()).rejects.toThrow(`HTTP ${status}`);
      expect(f.writes).toEqual([]);
      expect(f.run).not.toHaveBeenCalled();
    });
  for (const failure of ['network', 'timeout', 'invalid JSON', 'empty success', 'error JSON with HTTP 200'])
    it(`refuses ${endpoint} ${failure} without any writes`, async () => {
      const f = fixture({
        [endpoint]: () => {
          if (failure === 'network') throw new TypeError('fetch failed');
          if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
          if (failure === 'invalid JSON') return new Response('<html>upstream error</html>', { status: 200 });
          return ok(failure === 'empty success' ? null : { message: 'Not Found', status: '404' });
        },
      });
      await expect(f.invoke()).rejects.toThrow();
      expect(f.writes).toEqual([]);
      expect(f.run).not.toHaveBeenCalled();
    });
}

it('refuses a missing/inaccessible repository before interpreting resource 404s', async () => {
  const f = fixture({ 'GET ': absent });
  await expect(f.invoke()).rejects.toThrow('HTTP 404');
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.writes).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});

for (const value of [
  reference(tagSha),
  reference(sha, 'tree'),
  reference(''),
  {},
  [],
  { ...reference(), ref: 'refs/tags/v1.1.10' },
])
  it(`refuses a conflicting or malformed tag: ${JSON.stringify(value)}`, async () => {
    const f = fixture({ 'GET /git/ref/tags/v1.1.1': () => ok(value) });
    await expect(f.invoke()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });

for (const reply of [
  absent,
  () => ok({ sha: tagSha, object: { sha: tagSha, type: 'tag' } }),
  () => ok({ sha: tagSha, object: { sha: 'c'.repeat(40), type: 'commit' } }),
  () => ok({ sha: 'c'.repeat(40), object: { sha, type: 'commit' } }),
])
  it('refuses broken, cyclic, conflicting or mismatched annotated tags without replacing them', async () => {
    const f = fixture({
      'GET /git/ref/tags/v1.1.1': () => ok(reference(tagSha, 'tag')),
      [`GET /git/tags/${tagSha}`]: reply,
    });
    await expect(f.invoke()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });

for (const value of [{ ...release, tag_name: 'v1.1.10' }, { tag_name: 'v1.1.1' }, { ...release, id: 0 }])
  it('refuses a malformed or wrong release before creating the missing tag', async () => {
    const f = fixture({ 'GET /releases/tags/v1.1.1': () => ok(value) });
    await expect(f.invoke()).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });

for (const status of [401, 403, 404, 409, 422, 500])
  it(`does not create a release after tag creation fails with HTTP ${status}, including a race`, async () => {
    const f = fixture({ 'POST /git/refs': () => ok({ message: 'Reference already exists' }, status) });
    await expect(f.invoke()).rejects.toThrow(`HTTP ${status}`);
    expect(f.writes).toEqual(['POST /git/refs']);
    expect(f.run).not.toHaveBeenCalled();
  });

it('refuses an unexpected tag creation response without updating it or creating a release', async () => {
  const f = fixture({ 'POST /git/refs': () => ok(reference(tagSha), 201) });
  await expect(f.invoke()).rejects.toThrow('does not name the published commit');
  expect(f.writes).toEqual(['POST /git/refs']);
  expect(f.run).not.toHaveBeenCalled();
});

it('propagates release creation failure so the workflow cannot dispatch its successor', async () => {
  const f = fixture();
  f.run.mockImplementation(() => {
    throw new Error('release upload failed');
  });
  await expect(f.invoke()).rejects.toThrow('release upload failed');
  expect(f.run).toHaveBeenCalledOnce();
});

it('bounds authenticated requests and refuses redirects instead of following them', async () => {
  const f = fixture({
    'GET ': () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
  });
  await expect(f.invoke()).rejects.toThrow('HTTP 302');
  expect(f.request.mock.calls[0]![1]).toMatchObject({
    redirect: 'error',
    headers: { Authorization: 'Bearer test-token' },
    signal: expect.any(AbortSignal),
  });
  expect(f.writes).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});
