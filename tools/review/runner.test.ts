import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runBounded } from '../testing/subprocess.js';
import {
  collectSubject,
  digest,
  evidenceCommit,
  evidenceFiles,
  githubClient,
  publishReview,
  renderReview,
  resolveRun,
  safeSource,
} from './runner.mjs';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const result = {
  id: '11111111-1111-4111-8111-111111111111',
  repository: 'test/repo',
  pr: 7,
  head,
  verdict: 'INCOMPLETE',
  mode: 'advisory',
  summary: 'Missing unchanged producer',
  findings: [],
  gaps: ['Missing source'],
  method: 'method',
  model: 'fixture',
  subject: 'digest',
  coverage: { stages: ['grounding'], filesRead: 1, fullUnchangedFiles: [] },
};
it('refuses stale or unrelated upstream runs before collecting any source', async () => {
  const run = {
    repository: { full_name: 'test/repo' },
    path: '.github/workflows/platform-quality.yml',
    event: 'pull_request',
    status: 'completed',
    head_sha: head,
    pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
  };
  const pr = { state: 'open', base: { sha: base, repo: { full_name: 'test/repo' } }, head: { sha: head } };
  const gh = async (path: string) => (path.includes('/actions/') ? run : pr);
  await expect(resolveRun(gh, 'test/repo', '123')).resolves.toMatchObject({ pr });
  pr.head.sha = 'c'.repeat(40);
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('stale');
  run.path = '.github/workflows/attacker.yml';
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('platform-quality.yml');
});

it('admits only the configured upstream workflow path when a host names another quality workflow', async () => {
  const run = {
    repository: { full_name: 'test/repo' },
    path: '.github/workflows/quality.yml',
    event: 'pull_request',
    status: 'completed',
    head_sha: head,
    pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
  };
  const pr = { state: 'open', base: { sha: base, repo: { full_name: 'test/repo' } }, head: { sha: head } };
  const gh = async (path: string) => (path.includes('/actions/') ? run : pr);
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('platform-quality.yml');
  await expect(resolveRun(gh, 'test/repo', '123', '.github/workflows/quality.yml')).resolves.toMatchObject({ pr });
  for (const bad of ['quality.yml', '.github/workflows/../quality.yml', 'https://attacker.test/quality.yml'])
    await expect(resolveRun(gh, 'test/repo', '123', bad)).rejects.toThrow('Upstream workflow path');
});
it('suppresses stale-head delivery and retries the same retained result without duplicate review', async () => {
  const writes: unknown[] = [];
  let current = head,
    delivered = false;
  const gh = async (path: string, options?: { body?: unknown }) => {
    if (options?.body) {
      writes.push(options.body);
      delivered = true;
      return { id: 88 };
    }
    if (path.includes('/reviews'))
      return delivered
        ? [{ id: 88, user: { login: 'github-actions[bot]' }, commit_id: head, body: renderReview(result) }]
        : [];
    return { state: 'open', head: { sha: current } };
  };
  expect(await publishReview(gh, 'test/repo', result)).toMatchObject({ reviewId: '88', duplicate: false });
  expect(await publishReview(gh, 'test/repo', result)).toMatchObject({ reviewId: '88', duplicate: true });
  expect(writes).toEqual([{ commit_id: head, event: 'COMMENT', body: renderReview(result) }]);
  current = 'c'.repeat(40);
  expect(await publishReview(gh, 'test/repo', result)).toEqual({ skipped: 'stale-head' });
  expect(writes).toHaveLength(1);
});
it('recovers an empty GitHub run association only from a unique current commit, repository and branch match', async () => {
  const run = {
    repository: { full_name: 'test/repo' },
    path: '.github/workflows/platform-quality.yml',
    event: 'pull_request',
    status: 'completed',
    head_sha: head,
    head_branch: 'feature',
    head_repository: { full_name: 'fork/repo' },
    pull_requests: [],
  };
  const pr = {
    number: 7,
    state: 'open',
    base: { sha: base, repo: { full_name: 'test/repo' } },
    head: { sha: head, ref: 'feature', repo: { full_name: 'fork/repo' } },
  };
  let candidates = [pr];
  const gh = async (path: string) => (path.includes('/actions/') ? run : path.includes('/commits/') ? candidates : pr);
  await expect(resolveRun(gh, 'test/repo', '123')).resolves.toMatchObject({ pr });
  candidates = [pr, { ...pr, number: 8 }];
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('exactly one');
  candidates = [pr];
  pr.state = 'closed';
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('exactly one');
  pr.state = 'open';
  pr.head.repo.full_name = 'other/repo';
  await expect(resolveRun(gh, 'test/repo', '123')).rejects.toThrow('exactly one');
});
it('discloses only source paths, excluding credentials, symlinks/traversal and generated dependencies', () => {
  for (const path of ['src/auth.ts', 'docs/spec.md', '.github/workflows/quality.yml'])
    expect(safeSource(path)).toBe(true);
  for (const path of [
    '.env',
    '.env.local',
    'secret.json',
    'config/secrets.json',
    'vendor/a.ts',
    '../x.ts',
    'a\\x.ts',
    '/x.ts',
    'key.pem',
    'pnpm-lock.yaml',
    'a\n.ts',
  ])
    expect(safeSource(path)).toBe(false);
});
it('requires the advisory enum and neutralizes unsolicited mentions/HTML in review content', () => {
  expect(renderReview({ ...result, summary: '<script>@everyone</script>' })).toContain('&lt;script&gt;@\u200beveryone');
  expect(() => renderReview({ ...result, mode: 'binding' })).toThrow();
});
it('rejects redirecting GitHub fetches and keeps the privileged workflow on trusted default-branch code', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const gh = githubClient('fixture', async (url, options) => {
    calls.push({ url: String(url), options: options ?? {} });
    return new Response('{}', { status: 200 });
  });
  await gh('/repos/test/repo');
  expect(calls[0]?.options.redirect).toBe('error');
  await expect(gh('https://attacker.test')).rejects.toThrow();
  const workflow = readFileSync('.github/workflows/inventarch-review.yml', 'utf8');
  expect(workflow).toContain('ref: $' + '{{ github.event.repository.default_branch }}');
  expect(workflow).toContain('persist-credentials: false');
  expect(workflow).not.toContain('pnpm install');
  expect(workflow).not.toContain('pull_request_target');
});
it.each(['valid', 'tampered-blob', 'moving-head', 'truncated-tree'])(
  'collects immutable source with %s boundary evidence',
  async (mode) => {
    const mergeBase = 'c'.repeat(40),
      calls: string[] = [];
    const blob = (content: string, path: string) => ({
      path,
      content,
      type: 'blob',
      mode: '100644',
      size: Buffer.byteLength(content),
      sha: createHash('sha1')
        .update(`blob ${Buffer.byteLength(content)}\0${content}`)
        .digest('hex'),
    });
    const before = blob('export const allowed = false;\n', 'src/auth.ts');
    const after = blob('export const allowed = true;\n', 'src/auth.ts');
    const consumer = blob('import { allowed } from "./auth.js";\n', 'src/consumer.ts');
    const secret = blob('never disclose', 'secrets.json');
    const pr = {
      number: 7,
      title: 'Change allowed behavior',
      body: 'Fixes #8',
      changed_files: 1,
      state: 'open',
      base: { sha: base, ref: 'main', repo: { full_name: 'test/repo' } },
      head: { sha: head },
    };
    let prReads = 0;
    const gh = async (path: string) => {
      calls.push(path);
      if (path === '/repos/test/repo/actions/runs/123')
        return {
          id: 123,
          run_attempt: 1,
          repository: { full_name: 'test/repo' },
          path: '.github/workflows/platform-quality.yml',
          event: 'pull_request',
          status: 'completed',
          conclusion: 'success',
          head_sha: head,
          pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
        };
      if (path === '/repos/test/repo/pulls/7') {
        prReads++;
        return mode === 'moving-head' && prReads > 1 ? { ...pr, head: { sha: 'd'.repeat(40) } } : pr;
      }
      if (path.includes('/compare/')) return { merge_base_commit: { sha: mergeBase } };
      if (path.includes('/pulls/7/files?')) return [{ filename: 'src/auth.ts', status: 'modified' }];
      if (path.includes('/git/trees/'))
        return {
          truncated: mode === 'truncated-tree',
          tree: path.includes(mergeBase)
            ? [before]
            : [after, consumer, secret, { ...consumer, path: 'src/link.ts', mode: '120000' }],
        };
      if (path.includes('/git/blobs/')) {
        const found = [before, after, consumer, secret].find((b) => path.endsWith(b.sha));
        if (!found) throw new Error('Unexpected blob');
        return {
          encoding: 'base64',
          content: Buffer.from(mode === 'tampered-blob' ? 'x'.repeat(found.size) : found.content).toString('base64'),
        };
      }
      if (path.endsWith('/issues/8')) return { title: 'Acceptance', body: 'Preserve authorization.' };
      if (path.includes('/jobs?'))
        return { jobs: [{ name: 'quality', conclusion: 'success', steps: [{ name: 'test', conclusion: 'success' }] }] };
      if (path.endsWith('/protection')) return { required_status_checks: { contexts: ['quality'] } };
      if (path.includes('/rules/branches/')) return [];
      throw new Error(`Unexpected fixture endpoint ${path}`);
    };
    const collecting = collectSubject(gh, 'test/repo', '123');
    if (mode !== 'valid') {
      await expect(collecting).rejects.toThrow(
        mode === 'tampered-blob'
          ? 'identity mismatch'
          : mode === 'moving-head'
            ? 'changed during collection'
            : 'truncated',
      );
      return;
    }
    const subject = await collecting;
    expect(subject).toMatchObject({
      base: mergeBase,
      head,
      obligations: [{ source: 'test/repo#8', text: 'Acceptance\nPreserve authorization.' }],
      environment: { protection: 'observed', checks: 'unknown' },
      omissions: ['Quality evidence artifacts unavailable'],
    });
    expect(subject['files']).toEqual([
      { path: after.path, side: 'head', content: after.content, digest: digest(after.content) },
      { path: before.path, side: 'base', content: before.content, digest: digest(before.content) },
      { path: consumer.path, side: 'head', content: consumer.content, digest: digest(consumer.content) },
    ]);
    expect(calls.some((p) => p.endsWith(secret.sha))).toBe(false);
    expect(prReads).toBe(2);
  },
);
it('binds synthetic merge execution to both PR parents and refuses stale or conflicting evidence', async () => {
  const merge = 'e'.repeat(40),
    reports = (commit: string) => [{ content: JSON.stringify({ current: { commit } }) }];
  const calls: string[] = [];
  const parents = [{ sha: base }, { sha: head }];
  const gh = async (path: string) => {
    calls.push(path);
    return { sha: merge, parents };
  };
  expect(await evidenceCommit(gh, 'test/repo', reports(head), head, base, head)).toBe(head);
  expect(calls).toHaveLength(0);
  expect(await evidenceCommit(gh, 'test/repo', reports(merge), head, base, head)).toBe(merge);
  expect(calls).toEqual([`/repos/test/repo/git/commits/${merge}`]);
  parents[0] = { sha: 'f'.repeat(40) };
  await expect(evidenceCommit(gh, 'test/repo', reports(merge), head, base, head)).rejects.toThrow('current PR');
  await expect(
    evidenceCommit(gh, 'test/repo', [...reports(head), ...reports(merge)], head, base, head),
  ).rejects.toThrow('disagree');
});
it('reads nested task evidence from the actual gate artifact layout without mistaking raw test output for provenance', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-review-evidence-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    mkdirSync(resolve(root, 'task'));
    const content = JSON.stringify({ current: { commit: head }, task: 'test:fixture' });
    writeFileSync(resolve(root, 'task/evidence.json'), content);
    writeFileSync(resolve(root, 'task/vitest.json'), '{"numFailedTests":0}');
    writeFileSync(resolve(root, 'task/output.log'), 'not JSON');
    const omissions: string[] = [];
    expect(evidenceFiles(root, omissions)).toEqual([{ name: 'task/evidence.json', content, digest: digest(content) }]);
    expect(omissions).toEqual([]);
    writeFileSync(resolve(root, 'task/evidence.json'), ' '.repeat(600001));
    expect(evidenceFiles(root, omissions)).toEqual([]);
    expect(omissions).toContain('Evidence omitted by disclosure bound: task/evidence.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('omits linked and too-deep evidence, skips other entries and admits reports up to each bound', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-review-evidence-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    const put = (path: string, content: string) => {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), content);
    };
    // A JSON string of exactly `bytes` bytes.
    const report = (bytes: number) => JSON.stringify('x'.repeat(bytes - 2));
    put('a/evidence.json', report(600000)); // at the per-report bound
    put('a/vitest.json', '{"numFailedTests":0}');
    put('b/evidence.json', report(200000)); // brings the total to its bound
    put('c/evidence.json', '0'); // one byte past the total
    put('f/evidence.json/inner.txt', 'a directory named like a report is listed, not read');
    put('g/h/i/j/evidence.json', '{}');
    symlinkSync(resolve(root, 'a'), resolve(root, 'linked'), 'junction');
    const omitted = ['Evidence omitted by disclosure bound: c/evidence.json'];
    // File links need a privilege on Windows, which has no FIFOs.
    if (process.platform !== 'win32') {
      mkdirSync(resolve(root, 'e'));
      symlinkSync(resolve(root, 'a/evidence.json'), resolve(root, 'e/evidence.json'));
      mkdirSync(resolve(root, 'k'));
      expect((await runBounded('mkfifo', [resolve(root, 'k/evidence.json')], { timeoutMs: 10_000 })).status).toBe(0);
      omitted.push('Evidence symlink omitted: e/evidence.json');
    }
    omitted.push('Evidence nesting omitted: g/h/i/j', 'Evidence symlink omitted: linked');
    const omissions: string[] = [];
    expect(
      evidenceFiles(root, omissions).map(({ name, content, digest: hash }) => [name, content.length, hash]),
    ).toEqual([
      ['a/evidence.json', 600000, digest(report(600000))],
      ['b/evidence.json', 200000, digest(report(200000))],
    ]);
    expect(omissions).toEqual(omitted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses unparsable or too many evidence entries and a missing, linked or non-directory evidence root', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-review-evidence-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    const omissions: string[] = [];
    expect(evidenceFiles(resolve(root, 'missing'), omissions)).toEqual([]);
    expect(omissions).toEqual(['Quality evidence artifacts unavailable']);
    writeFileSync(resolve(root, 'file'), '{}');
    expect(() => evidenceFiles(resolve(root, 'file'), [])).toThrow('Evidence must be a real directory');
    mkdirSync(resolve(root, 'evidence/task'), { recursive: true });
    symlinkSync(resolve(root, 'evidence'), resolve(root, 'linked'), 'junction');
    expect(() => evidenceFiles(resolve(root, 'linked'), [])).toThrow('Evidence must be a real directory');
    writeFileSync(resolve(root, 'evidence/task/evidence.json'), 'not JSON');
    expect(() => evidenceFiles(resolve(root, 'evidence'), [])).toThrow(SyntaxError);
    rmSync(resolve(root, 'evidence/task/evidence.json'));
    for (let index = 0; index < 1999; index++) writeFileSync(resolve(root, 'evidence/task', `log-${index}.txt`), '');
    // The task directory and 1,999 logs are 2,000 entries: at the bound, with no report to disclose.
    const atBound: string[] = [];
    expect(evidenceFiles(resolve(root, 'evidence'), atBound)).toEqual([]);
    expect(atBound).toEqual(['No task-level execution evidence disclosed']);
    writeFileSync(resolve(root, 'evidence/task/log-1999.txt'), '');
    expect(() => evidenceFiles(resolve(root, 'evidence'), [])).toThrow('Evidence inventory exceeds disclosure bound');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/** A completed upstream run, its open pull request and a GitHub reader that records each path it is asked for. */
function upstream() {
  const paths: string[] = [];
  const run = {
    repository: { full_name: 'test/repo' },
    path: '.github/workflows/platform-quality.yml',
    event: 'pull_request',
    status: 'completed',
    head_sha: head,
    pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
  };
  const pr = { state: 'open', base: { sha: base, repo: { full_name: 'test/repo' } }, head: { sha: head } };
  const gh = async (path: string) => {
    paths.push(path);
    return path.includes('/actions/') ? run : pr;
  };
  return { gh, paths };
}
it('accepts only positive decimal run identifiers and requests each as validated', async () => {
  const { gh, paths } = upstream();
  for (const bad of ['0', '00', '-1', '1.5', '', '1e3', ' 1', '0x10'])
    await expect(resolveRun(gh, 'test/repo', bad)).rejects.toThrow('Positive identifier required');
  expect(paths).toEqual([]);
  await resolveRun(gh, 'test/repo', 123 as unknown as string);
  await resolveRun(gh, 'test/repo', '007');
  expect(paths).toEqual([
    '/repos/test/repo/actions/runs/123',
    '/repos/test/repo/pulls/7',
    '/repos/test/repo/actions/runs/007',
    '/repos/test/repo/pulls/7',
  ]);
});
it('requests the run identifier it tested even from a value that spells itself differently each time', async () => {
  const { gh, paths } = upstream();
  let spellings = 0;
  const shifting = { toString: () => (spellings++ === 0 ? '123' : '123/../../../other/repo') };
  await resolveRun(gh, 'test/repo', shifting as unknown as string);
  expect(paths[0]).toBe('/repos/test/repo/actions/runs/123');
});
