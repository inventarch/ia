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
 * One review run, as main() runs it: start or reuse, advance to a result or cancel at the deadline, retain, deliver.
 * Resolves to the job summary line.
 */
export function runReview(options: {
  api: ReviewApi;
  pause: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
  key: string;
  subjectDigest: string;
  head: string;
  retain: (result: unknown) => void;
  publish: (result: unknown) => Promise<{ reviewId?: string; duplicate?: boolean; skipped?: string }>;
}): Promise<string>;
export function publishReview(
  gh: Github,
  repository: string,
  result: unknown,
): Promise<{ reviewId?: string; duplicate?: boolean; skipped?: string }>;
