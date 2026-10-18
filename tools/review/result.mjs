import { pages, repoName, integer } from './github.mjs';
import { renderReview } from './render.mjs';

export function validateResult(result, expected) {
  if (!expected || !result || ['repository', 'pr', 'head', 'subject'].some((key) => result[key] !== expected[key]))
    throw new Error('Review result does not match the submitted subject');
  return result;
}
export async function publishReview(gh, repository, result, expected) {
  validateResult(result, expected);
  if (expected.repository !== repository) throw new Error('Review result does not match the submitted subject');
  const body = renderReview(result),
    marker = `<!-- inventarch-review:${result.id} -->`;
  const pr = await gh(`/repos/${repoName(repository)}/pulls/${integer(result.pr)}`);
  if (result.repository !== repository || pr.head.sha !== result.head || pr.state !== 'open')
    return { skipped: 'stale-head' };
  const previous = (await pages(gh, `/repos/${repository}/pulls/${result.pr}/reviews`, null, 20)).find(
    (review) =>
      review.user?.login === 'github-actions[bot]' && review.commit_id === result.head && review.body?.includes(marker),
  );
  if (previous) return { reviewId: String(previous.id), duplicate: true };
  // The commit_id prevents attribution to a later head even if a push races this last read.
  const posted = await gh(`/repos/${repository}/pulls/${result.pr}/reviews`, {
    method: 'POST',
    body: { commit_id: result.head, event: 'COMMENT', body },
  });
  return { reviewId: String(posted.id), duplicate: false };
}
