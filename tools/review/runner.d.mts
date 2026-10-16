export function digest(text: string): string;
export function safeSource(path: string): boolean;
export type Github = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;
export function githubClient(token: string, fetcher?: typeof fetch): Github;
export const DEFAULT_UPSTREAM_WORKFLOW: '.github/workflows/platform-quality.yml';
export function resolveRun(
  gh: Github,
  repository: string,
  run: string,
  workflow?: string,
): Promise<{ run: Record<string, unknown>; pr: Record<string, unknown> }>;
export function collectSubject(
  gh: Github,
  repository: string,
  run: string,
  evidence?: string,
  workflow?: string,
): Promise<Record<string, unknown>>;
export function evidenceCommit(
  gh: Github,
  repository: string,
  reports: { content: string }[],
  head: string,
  base: string,
  fallback: string,
): Promise<string>;
export function evidenceFiles(
  directory: string | undefined,
  omissions: string[],
): { name: string; digest: string; content: string }[];
/** A review API receipt's review id; an advance receipt must also name `started`, the review the first one started. */
export function receiptId(receipt: unknown, started?: string): string;
/** The job summary line, from a review id and one of the four advisory verdicts. */
export function reviewSummary(id: unknown, verdict: unknown, delivery: { skipped?: string }): string;
export function renderReview(result: unknown): string;
/** A request to the review API: its path under /v1/reviews, its JSON body and method (POST by default). */
export type ReviewApi = (path: string, input?: unknown, method?: string) => Promise<unknown>;
/**
 * Start or reuse a review and advance it to a result, as main() does, cancelling it at the deadline. Resolves to the
 * review the first receipt started and the receipt that holds its result.
 */
export function awaitResult(options: {
  api: ReviewApi;
  pause: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
  key: string;
  subjectDigest: string;
}): Promise<{ review: string; receipt: { result: unknown } & Record<string, unknown> }>;
export function publishReview(
  gh: Github,
  repository: string,
  result: unknown,
): Promise<{ reviewId?: string; duplicate?: boolean; skipped?: string }>;
