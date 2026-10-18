export const integer = (value) => {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) throw new Error('Positive identifier required');
  return String(value);
};
export const repoName = (value) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Repository required');
  return value;
};
export const pinnedSha = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Pinned Git commit required');
  return value;
};
export function githubClient(token, fetcher = fetch) {
  return async (path, options = {}) => {
    if (!path.startsWith('/repos/')) throw new Error('Only repository GitHub endpoints allowed');
    const response = await fetcher(`https://api.github.com${path}`, {
      method: options.method ?? 'GET',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${response.status} for ${path.split('?')[0]}`);
      error.status = response.status;
      throw error;
    }
    const content = await response.text();
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('GitHub response exceeds read bound');
    return JSON.parse(content);
  };
}
export async function pages(gh, path, field, max = 10) {
  const rows = [];
  for (let page = 1; page <= max; page++) {
    const response = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = field ? response[field] : response;
    if (!Array.isArray(list)) throw new Error('Unexpected GitHub list');
    rows.push(...list);
    if (list.length < 100) return rows;
  }
  throw new Error('GitHub pagination exceeded disclosure bound');
}
/** The upstream quality workflow whose completed pull-request run is the only admissible review subject. */
export const DEFAULT_UPSTREAM_WORKFLOW = '.github/workflows/platform-quality.yml';
const workflowPath = (value) => {
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(value)) throw new Error('Upstream workflow path required');
  return value;
};
export async function resolveRun(gh, repository, runId, workflow = DEFAULT_UPSTREAM_WORKFLOW) {
  repository = repoName(repository);
  runId = integer(runId);
  workflow = workflowPath(workflow);
  const run = await gh(`/repos/${repository}/actions/runs/${runId}`);
  if (
    run.repository?.full_name !== repository ||
    run.path !== workflow ||
    run.event !== 'pull_request' ||
    run.status !== 'completed' ||
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length > 1
  )
    throw new Error(`Expected a completed pull-request run of ${workflow}`);
  let association = run.pull_requests[0];
  const recovered = !association;
  if (recovered) {
    const candidates = (
      await pages(gh, `/repos/${repository}/commits/${pinnedSha(run.head_sha)}/pulls`, null, 2)
    ).filter(
      (candidate) =>
        candidate.state === 'open' &&
        candidate.base?.repo?.full_name === repository &&
        candidate.head?.sha === run.head_sha &&
        candidate.head?.repo?.full_name === run.head_repository?.full_name &&
        candidate.head?.ref === run.head_branch,
    );
    if (candidates.length !== 1) throw new Error('Expected exactly one current PR for the upstream commit');
    association = candidates[0];
  }
  const pr = await gh(`/repos/${repository}/pulls/${integer(association.number)}`);
  if (
    pr.state !== 'open' ||
    pr.base?.repo?.full_name !== repository ||
    pr.head?.sha !== association.head?.sha ||
    pr.base?.sha !== association.base?.sha
  )
    throw new Error('Upstream run is stale or does not match the current PR revisions');
  if (
    recovered &&
    (pr.head?.sha !== run.head_sha ||
      pr.head?.repo?.full_name !== run.head_repository?.full_name ||
      pr.head?.ref !== run.head_branch)
  )
    throw new Error('Recovered PR does not match the upstream branch');
  pinnedSha(pr.head.sha);
  pinnedSha(pr.base.sha);
  pinnedSha(run.head_sha);
  return { run, pr };
}
