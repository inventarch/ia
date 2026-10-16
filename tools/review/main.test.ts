import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { runBounded } from '../testing/subprocess.js';

// main() runs as the workflow runs it, `node tools/review/runner.mjs` in a fresh working directory, with every GitHub,
// OIDC and review API response supplied by main-fixture.mjs, a preload that replaces fetch and the clock.
const runner = realpathSync(fileURLToPath(new URL('./runner.mjs', import.meta.url)));
const preload = pathToFileURL(realpathSync(fileURLToPath(new URL('./main-fixture.mjs', import.meta.url)))).href;
const bound = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const STARTED = 'abcdef12-3456-4789-8abc-def012345678',
  OTHER = 'fedcba98-7654-4321-8fed-cba987654321',
  BINDING = '44444444-4444-4444-8444-444444444444';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const api = 'https://review.test',
  github = 'https://api.github.com/repos/test/repo';
const result = {
  id: STARTED,
  repository: 'test/repo',
  pr: 7,
  head,
  verdict: 'CONDITIONAL',
  mode: 'advisory',
  summary: 'One follow-up',
  findings: [],
  gaps: [],
  method: 'method',
  model: 'fixture',
  subject: 'digest',
  coverage: { stages: ['grounding'], filesRead: 0, fullUnchangedFiles: [] },
};
const pr = {
  number: 7,
  title: 'Fixture change',
  body: '',
  changed_files: 0,
  state: 'open',
  base: { sha: base, ref: 'main', repo: { full_name: 'test/repo' } },
  head: { sha: head },
};
interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}
interface Script {
  /** The first receipt, which starts or reuses the review. */
  readonly started: unknown;
  /** The advance receipts, one per advance, or one receipt for every advance. */
  readonly advances?: Reply | Reply[];
  /** The PR as the delivery reads it; the run and collection read `pr`. */
  readonly delivered?: unknown;
  /** The PR's existing reviews as the delivery lists them. */
  readonly reviews?: unknown[];
}
interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly redirect: string | null;
  readonly body: Record<string, unknown> | null;
}
function routes(script: Script): Record<string, Reply | Reply[]> {
  const tree = { body: { truncated: false, tree: [] } };
  return {
    [`GET ${github}/actions/runs/123`]: {
      body: {
        id: 123,
        run_attempt: 1,
        repository: { full_name: 'test/repo' },
        path: '.github/workflows/platform-quality.yml',
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        head_sha: head,
        pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
      },
    },
    // Read when the run is resolved, after collection and before delivery.
    [`GET ${github}/pulls/7`]: [{ body: pr }, { body: pr }, { body: script.delivered ?? pr }],
    [`GET ${github}/compare/${base}...${head}`]: { body: { merge_base_commit: { sha: base } } },
    [`GET ${github}/pulls/7/files`]: { body: [] },
    [`GET ${github}/git/trees/${base}`]: tree,
    [`GET ${github}/git/trees/${head}`]: tree,
    [`GET ${github}/actions/runs/123/attempts/1/jobs`]: { body: { jobs: [] } },
    [`GET ${github}/branches/main/protection`]: { status: 404 },
    [`GET ${github}/pulls/7/reviews`]: { body: script.reviews ?? [] },
    [`POST ${github}/pulls/7/reviews`]: { body: { id: 99 } },
    'GET https://oidc.test/token': { body: { value: 'oidc-token' } },
    [`POST ${api}/v1/reviews/exchange`]: { body: { access_token: 'review-token' } },
    [`PUT ${api}/v1/reviews/artifacts/*`]: { body: {} },
    [`POST ${api}/v1/reviews`]: { body: script.started },
    // Only the started review has these routes; a request for any other id is answered 599 and stays in the log.
    [`POST ${api}/v1/reviews/${STARTED}/advance`]: script.advances ?? [],
    [`POST ${api}/v1/reviews/${STARTED}/cancel`]: { body: { state: 'cancelled' } },
    [`POST ${api}/v1/reviews/${STARTED}/delivery`]: { body: {} },
  };
}
async function runMain(script: Script) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-review-main-'));
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
  try {
    const log = resolve(root, 'requests.jsonl'),
      summaryFile = resolve(root, 'summary.md'),
      event = resolve(root, 'event.json'),
      fixture = resolve(root, 'fixture.json'),
      retainedFile = resolve(root, 'artifacts/review/result.json');
    writeFileSync(event, JSON.stringify({ workflow_run: { id: 123 } }));
    writeFileSync(fixture, JSON.stringify({ log, routes: routes(script) }));
    const run = await runBounded(process.execPath, ['--import', preload, runner], {
      cwd: root,
      timeoutMs: bound,
      // Every variable main() reads is set here, so none is inherited from a CI job.
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'test/repo',
        GITHUB_EVENT_PATH: event,
        IA_REVIEW_RUN_ID: '',
        IA_REVIEW_UPSTREAM_WORKFLOW: '',
        GH_TOKEN: 'github-token',
        IA_REVIEW_API: `${api}/`,
        IA_REVIEW_BINDING: BINDING,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        IA_REVIEW_EVIDENCE: '',
        GITHUB_STEP_SUMMARY: summaryFile,
        IA_REVIEW_MAIN_FIXTURE: fixture,
      },
    });
    expect(run.timedOut).toBe(false);
    const calls: Call[] = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : [];
    const reviewCalls = calls.filter((call) => call.url.startsWith(`${api}/`) && !call.url.endsWith('/exchange'));
    return {
      status: run.status,
      stderr: run.stderr,
      calls,
      /** The review API requests after the identity exchange, as `<method> <path>`, the subject digest elided. */
      review: reviewCalls.map(
        (call) =>
          `${call.method} ${new URL(call.url).pathname.replace(/\/artifacts\/[a-f0-9]{64}$/, '/artifacts/<digest>')}`,
      ),
      reviewCalls,
      prReads: calls.filter((call) => call.method === 'GET' && call.url === `${github}/pulls/7`).length,
      comments: calls.filter((call) => call.method === 'POST' && call.url === `${github}/pulls/7/reviews`),
      summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : undefined,
      retained: existsSync(retainedFile) ? (JSON.parse(readFileSync(retainedFile, 'utf8')) as unknown) : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const SETUP = ['PUT /v1/reviews/artifacts/<digest>', 'POST /v1/reviews'];
const advance = `POST /v1/reviews/${STARTED}/advance`,
  delivery = `POST /v1/reviews/${STARTED}/delivery`;
const settle = bound + 5_000;

it(
  'runs main() offline from a completed first receipt to a delivered review summarized by the started id',
  async () => {
    const run = await runMain({ started: { id: STARTED, state: 'completed', result } });
    expect(run.stderr).not.toContain('could not complete');
    expect(run.status).toBe(0);
    expect(run.review).toEqual([...SETUP, delivery]);
    // The subject is addressed by its SHA-256, and the review keyed by run, attempt and head.
    const [upload, start, delivered] = run.reviewCalls;
    const content = String(upload?.body?.['content']),
      subjectDigest = createHash('sha256').update(content).digest('hex');
    expect(upload?.url).toBe(`${api}/v1/reviews/artifacts/${subjectDigest}`);
    expect(start?.body).toEqual({ key: `github:123:1:${head}`, digest: subjectDigest });
    expect(JSON.parse(content)).toMatchObject({ repository: 'test/repo', pr: 7, base, head });
    expect(delivered?.body).toEqual({ reviewId: '99', head });
    // The OIDC token for the API's audience is exchanged under the binding, and the session token carries each request.
    expect(run.calls[0]?.url).toBe(`${github}/actions/runs/123`);
    const oidc = run.calls.find((call) => call.url.startsWith('https://oidc.test/'));
    expect(oidc?.url).toBe(`https://oidc.test/token?audience=${encodeURIComponent(`${api}/v1/reviews`)}`);
    expect(oidc?.authorization).toBe('Bearer request-token');
    expect(run.calls.find((call) => call.url.endsWith('/exchange'))?.body).toEqual({
      binding: BINDING,
      token: 'oidc-token',
    });
    expect(run.reviewCalls.every((call) => call.authorization === 'Bearer review-token')).toBe(true);
    expect(run.calls.every((call) => call.redirect === 'error')).toBe(true);
    expect(run.comments).toHaveLength(1);
    expect(run.comments[0]?.body).toMatchObject({ commit_id: head, event: 'COMMENT' });
    expect(String(run.comments[0]?.body?.['body'])).toContain(`<!-- inventarch-review:${STARTED} -->`);
    expect(run.retained).toEqual(result);
    expect(run.summary).toBe(`InventArch review ${STARTED}: CONDITIONAL (advisory). Review comment delivered.\n`);
  },
  settle,
);

it(
  'advances only the review it started, through running and queued receipts, until its result is delivered',
  async () => {
    const run = await runMain({
      started: { id: STARTED, state: 'queued' },
      advances: [
        { body: { id: STARTED, state: 'running' } },
        { body: { id: STARTED, state: 'queued' } },
        { body: { id: STARTED, state: 'completed', result: { ...result, verdict: 'APPROVE' } } },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.review).toEqual([...SETUP, advance, advance, advance, delivery]);
    expect(run.comments).toHaveLength(1);
    expect(run.summary).toBe(`InventArch review ${STARTED}: APPROVE (advisory). Review comment delivered.\n`);
  },
  settle,
);

it(
  'cancels the review it started when no result arrives by the CI deadline, with no comment, delivery or summary',
  async () => {
    const run = await runMain({
      started: { id: STARTED, state: 'running' },
      advances: { body: { id: STARTED, state: 'running' } },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Review exceeded CI deadline');
    const advances = run.review.slice(SETUP.length, -1);
    expect(run.review.slice(0, SETUP.length)).toEqual(SETUP);
    // One advance every three seconds of the virtual clock until 15 minutes have passed.
    expect(advances.length).toBeGreaterThanOrEqual(290);
    expect(advances.length).toBeLessThanOrEqual(300);
    expect(advances.every((request) => request === advance)).toBe(true);
    expect(run.review.at(-1)).toBe(`POST /v1/reviews/${STARTED}/cancel`);
    expect(run.comments).toEqual([]);
    expect(run.summary).toBeUndefined();
    expect(run.retained).toBeUndefined();
  },
  settle,
);

it.each([
  ['a traversal', { id: '../x', state: 'queued' }],
  ['a request path', { id: `${STARTED}/cancel`, state: 'queued' }],
  ['an uppercase id with its result', { id: STARTED.toUpperCase(), state: 'completed', result }],
  ['no id, with a result', { state: 'completed', result }],
])(
  'refuses a first receipt with %s before any request for it, any comment or summary',
  async (_, started) => {
    const run = await runMain({ started, advances: { body: { id: STARTED, state: 'completed', result } } });
    // What was requested and written comes first, so a failure shows any request made for another id.
    expect(run.review).toEqual(SETUP);
    expect(run.comments).toEqual([]);
    expect(run.summary).toBeUndefined();
    expect(run.retained).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Review receipt identity required');
  },
  settle,
);

it.each([
  ['another review with its result', { id: OTHER, state: 'completed', result: { ...result, id: OTHER } }],
  ['another review still running', { id: OTHER, state: 'running' }],
  ['a malformed id with a result', { id: '../x', state: 'completed', result }],
])(
  'refuses an advance that returns %s before any further request, comment or summary',
  async (_, receipt) => {
    const run = await runMain({
      started: { id: STARTED, state: 'queued' },
      advances: [{ body: receipt }, { body: { id: STARTED, state: 'completed', result } }],
    });
    expect(run.review).toEqual([...SETUP, advance]);
    expect(run.comments).toEqual([]);
    expect(run.summary).toBeUndefined();
    expect(run.retained).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Review receipt identity required');
  },
  settle,
);

it(
  'binds its requests and summary to the started receipt id when the retained result names another review',
  async () => {
    // The receipt's id, not its result's, is the review the caller requests and reports. The result's own id only marks
    // the comment rendered from it.
    const run = await runMain({
      started: { id: STARTED, state: 'queued' },
      advances: [{ body: { id: STARTED, state: 'completed', result: { ...result, id: OTHER } } }],
    });
    expect(run.status).toBe(0);
    expect(run.review).toEqual([...SETUP, advance, delivery]);
    expect(run.reviewCalls.some((call) => call.url.includes(OTHER))).toBe(false);
    expect(String(run.comments[0]?.body?.['body'])).toContain(`<!-- inventarch-review:${OTHER} -->`);
    expect(run.retained).toMatchObject({ id: OTHER });
    expect(run.summary).toBe(`InventArch review ${STARTED}: CONDITIONAL (advisory). Review comment delivered.\n`);
  },
  settle,
);

it(
  'suppresses stale delivery: no comment and no delivery request, and a summary that says so',
  async () => {
    const run = await runMain({
      started: { id: STARTED, state: 'completed', result },
      delivered: { ...pr, head: { sha: 'c'.repeat(40) } },
    });
    expect(run.status).toBe(0);
    expect(run.review).toEqual(SETUP);
    expect(run.prReads).toBe(3);
    expect(run.comments).toEqual([]);
    expect(run.retained).toEqual(result);
    expect(run.summary).toBe(`InventArch review ${STARTED}: CONDITIONAL (advisory). Stale delivery suppressed.\n`);
  },
  settle,
);

it(
  'reports an existing comment for the same review and commit as its delivery without posting another',
  async () => {
    const run = await runMain({
      started: { id: STARTED, state: 'completed', result },
      reviews: [
        {
          id: 41,
          user: { login: 'github-actions[bot]' },
          commit_id: head,
          body: `<!-- inventarch-review:${STARTED} -->`,
        },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.review).toEqual([...SETUP, delivery]);
    expect(run.reviewCalls.at(-1)?.body).toEqual({ reviewId: '41', head });
    expect(run.comments).toEqual([]);
    expect(run.summary).toBe(`InventArch review ${STARTED}: CONDITIONAL (advisory). Review comment delivered.\n`);
  },
  settle,
);

it(
  'refuses a retained result with an invalid verdict before any delivery read, comment, delivery or summary',
  async () => {
    const run = await runMain({
      started: { id: STARTED, state: 'completed', result: { ...result, verdict: 'approve' } },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Invalid retained review result');
    expect(run.review).toEqual(SETUP);
    expect(run.prReads).toBe(2);
    expect(run.comments).toEqual([]);
    expect(run.summary).toBeUndefined();
    // The result is retained before delivery, as main() always has.
    expect(run.retained).toMatchObject({ verdict: 'approve' });
  },
  settle,
);
