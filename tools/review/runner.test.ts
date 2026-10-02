import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
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
