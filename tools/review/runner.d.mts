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
export function renderReview(result: unknown): string;
export function publishReview(
  gh: Github,
  repository: string,
  result: unknown,
): Promise<{ reviewId?: string; duplicate?: boolean; skipped?: string }>;
