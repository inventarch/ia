/** Trusted default-branch caller. PR contents are data; no checkout, shell or dependency install. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
const integer = (value) => {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) throw new Error('Positive identifier required');
  return String(value);
};
const repoName = (value) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Repository required');
  return value;
};
const pinnedSha = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Pinned Git commit required');
  return value;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function safeSource(path) {
  return (
    typeof path === 'string' &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split('/').some((p) => !p || p === '..' || p === '.') &&
    !/(^|\/)(node_modules|vendor|dist|\.git|\.env[^/]*|\.npmrc|\.netrc|credentials[^/]*|secrets?[^/]*)(\/|$)/i.test(
      path,
    ) &&
    !/\.(pem|key|p12|pfx|keystore|lock|map|min\.js)$/i.test(path) &&
    !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path) &&
    /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|ia|sql|py|go|rs|java|cs|sh|ps1|toml|css|html|vue|svelte)$/.test(path)
  );
}
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
async function pages(gh, path, field, max = 10) {
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
export function evidenceFiles(directory, omissions) {
  if (!directory || !existsSync(directory)) {
    omissions.push('Quality evidence artifacts unavailable');
    return [];
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw new Error('Evidence must be a real directory');
  const reports = [];
  let bytes = 0,
    entries = 0;
  const visit = (relative = '', depth = 0) => {
    for (const entry of readdirSync(resolve(directory, relative)).sort()) {
      if (++entries > 2000) throw new Error('Evidence inventory exceeds disclosure bound');
      const name = relative ? `${relative}/${entry}` : entry;
      const path = resolve(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        omissions.push(`Evidence symlink omitted: ${name}`);
        continue;
      }
      if (stat.isDirectory()) {
        if (depth >= 3) omissions.push(`Evidence nesting omitted: ${name}`);
        else visit(name, depth + 1);
        continue;
      }
      // Public quality emits <task>/evidence.json alongside raw logs/Vitest output.
      if (!stat.isFile() || entry !== 'evidence.json') continue;
      if (stat.size > 600000 || bytes + stat.size > 800000) {
        omissions.push(`Evidence omitted by disclosure bound: ${name}`);
        continue;
      }
      const content = readFileSync(path, 'utf8');
      JSON.parse(content);
      reports.push({ name, digest: digest(content), content });
      bytes += stat.size;
    }
  };
  visit();
  if (!reports.length) omissions.push('No task-level execution evidence disclosed');
  return reports;
}
export async function evidenceCommit(gh, repository, reports, head, base, fallback) {
  const commits = [...new Set(reports.map((r) => JSON.parse(r.content).current?.commit).filter(Boolean))];
  if (!commits.length) return fallback;
  if (commits.length !== 1) throw new Error('Execution reports disagree on the tested commit');
  const commit = pinnedSha(commits[0]);
  if (commit !== head) {
    // pull_request checkout normally tests a synthetic merge, not the PR head.
    // Bind its exact parents instead of confusing those distinct commit identities.
    const tested = await gh(`/repos/${repository}/git/commits/${commit}`);
    if (
      tested.sha !== commit ||
      tested.parents?.length !== 2 ||
      tested.parents[0].sha !== base ||
      tested.parents[1].sha !== head
    )
      throw new Error('Tested merge does not bind the current PR base and head');
  }
  return commit;
}
export async function collectSubject(gh, repository, runId, evidenceDirectory, workflow = DEFAULT_UPSTREAM_WORKFLOW) {
  const { run, pr } = await resolveRun(gh, repository, runId, workflow);
  const comparison = await gh(`/repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}`);
  const base = pinnedSha(comparison.merge_base_commit?.sha),
    head = pr.head.sha;
  const changed = (await pages(gh, `/repos/${repository}/pulls/${pr.number}/files`, null, 5)).map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
  }));
  if (changed.length > 400 || changed.length !== pr.changed_files) throw new Error('Incomplete changed-path inventory');
  const trees = {};
  for (const [side, sha] of [
    ['base', base],
    ['head', head],
  ]) {
    const tree = await gh(`/repos/${repository}/git/trees/${sha}?recursive=1`);
    if (tree.truncated) throw new Error('Git tree inventory was truncated');
    trees[side] = tree.tree.filter((f) => f.type === 'blob' && f.mode !== '120000');
  }
  const inventory = trees.head.map((f) => f.path);
  if (inventory.length > 30000) throw new Error('Repository inventory exceeds review bound');
  const omissions = [],
    files = [],
    selected = [],
    keys = new Set();
  const select = (side, path) => {
    const key = `${side}:${path}`;
    if (!keys.has(key)) {
      keys.add(key);
      selected.push({ side, path });
    }
  };
  for (const change of changed) {
    if (change.status !== 'removed') select('head', change.path);
    if (change.status !== 'added') select('base', change.previousPath ?? change.path);
  }
  // Prioritize neighboring contracts, tests, producers and consumers; the full inventory remains visible.
  const folders = new Set(changed.map((f) => dirname(f.path)));
  const neighbors = trees.head
    .filter((f) => safeSource(f.path))
    .sort(
      (a, b) =>
        Number(folders.has(dirname(b.path))) - Number(folders.has(dirname(a.path))) || a.path.localeCompare(b.path),
    );
  for (const file of neighbors) select('head', file.path);
  let bytes = 0;
  const cache = new Map();
  for (const { side, path } of selected) {
    const entry = trees[side].find((f) => f.path === path);
    if (!safeSource(path) || !entry || entry.size > 150000 || bytes + entry.size > 1700000 || files.length >= 1000) {
      omissions.push(`${side}:${path}`);
      continue;
    }
    let content = cache.get(entry.sha);
    if (content === undefined) {
      const blob = await gh(`/repos/${repository}/git/blobs/${pinnedSha(entry.sha)}`);
      if (blob.encoding !== 'base64') throw new Error('Unsupported Git blob encoding');
      const buffer = Buffer.from(blob.content, 'base64');
      if (buffer.length !== entry.size || buffer.includes(0)) {
        omissions.push(`${side}:${path}`);
        continue;
      }
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      // Git blob identity protects against a mismatched response independently of our SHA-256 capture.
      if (createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') !== entry.sha)
        throw new Error('Git blob identity mismatch');
      cache.set(entry.sha, content);
    }
    bytes += Buffer.byteLength(content);
    files.push({ side, path, content, digest: digest(content) });
  }
  const obligations = [];
  const issueIds = [
    ...new Set(
      [...(pr.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)/gi)].map((m) => m[1]),
    ),
  ];
  if (issueIds.length > 20) throw new Error('Too many linked obligations');
  for (const number of issueIds) {
    const issue = await gh(`/repos/${repository}/issues/${integer(number)}`);
    obligations.push({ source: `${repository}#${number}`, text: `${issue.title}\n${issue.body ?? ''}` });
  }
  const jobs = await pages(
    gh,
    `/repos/${repository}/actions/runs/${run.id}/attempts/${integer(run.run_attempt)}/jobs`,
    'jobs',
  );
  const evidenceOmissions = [];
  const reports = evidenceFiles(evidenceDirectory, evidenceOmissions);
  const testedCommit = await evidenceCommit(gh, repository, reports, head, pr.base.sha, run.head_sha);
  omissions.push(...evidenceOmissions);
  let protection = 'unknown',
    requiredChecks = [],
    checks = 'unknown';
  let note = 'Branch protection/ruleset requirements were not established; review is advisory and incomplete.';
  try {
    const policy = await gh(`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}/protection`);
    // Rulesets can add requirements beyond branch protection; do not pretend this is exhaustive.
    const rules = await pages(gh, `/repos/${repository}/rules/branches/${encodeURIComponent(pr.base.ref)}`, null);
    requiredChecks = [
      ...new Set([
        ...(policy.required_status_checks?.contexts ?? []),
        ...(policy.required_status_checks?.checks ?? []).map((c) => c.context),
        ...rules
          .filter((r) => r.type === 'required_status_checks')
          .flatMap((r) => r.parameters?.required_status_checks?.map((c) => c.context) ?? []),
      ]),
    ];
    protection = 'observed';
    // Only observed check jobs from this exact upstream attempt can establish these contexts.
    checks =
      requiredChecks.length &&
      requiredChecks.every((name) => jobs.some((job) => job.name === name && job.conclusion === 'success')) &&
      run.conclusion === 'success' &&
      reports.length &&
      !evidenceOmissions.length
        ? 'passed'
        : 'unknown';
    note =
      'Required contexts checked against this exact quality run; external required checks remain unknown. Artifact reports are caller evidence, not signed attestations.';
  } catch {
    /* Unknown policy is retained as an explicit hold. */
  }
  const subject = {
    version: 1,
    repository,
    pr: pr.number,
    base,
    head,
    title: pr.title,
    description: pr.body ?? '',
    obligations,
    changed,
    files,
    inventory,
    omissions,
    environment: { protection, requiredChecks, checks, note },
    evidence: {
      runId: String(run.id),
      attempt: run.run_attempt,
      commit: testedCommit,
      conclusion: run.conclusion ?? 'unknown',
      jobs: jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion ?? 'unknown',
        steps: (job.steps ?? []).map((step) => ({ name: step.name, conclusion: step.conclusion ?? 'unknown' })),
      })),
      reports,
    },
  };
  const current = await gh(`/repos/${repository}/pulls/${pr.number}`);
  if (current.head.sha !== head || current.base.sha !== pr.base.sha || current.state !== 'open')
    throw new Error('PR changed during collection');
  if (Buffer.byteLength(JSON.stringify(subject)) > 3 * 1024 * 1024)
    throw new Error('Complete review packet exceeds disclosure bound');
  return subject;
}

const escapeText = (value) =>
  String(value)
    .replace(/[\\`*_{}[\]()!|~]/g, '\\$&')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b');
export function renderReview(result) {
  if (
    !['APPROVE', 'CONDITIONAL', 'REQUEST_CHANGES', 'INCOMPLETE'].includes(result.verdict) ||
    result.mode !== 'advisory' ||
    !/^[a-f0-9-]{36}$/.test(result.id)
  )
    throw new Error('Invalid retained review result');
  const marker = `<!-- inventarch-review:${result.id} -->`;
  // Monochrome status symbols provide scan cues; labels retain the full meaning.
  const verdicts = {
    APPROVE: '✓ Approval recommended',
    CONDITIONAL: '△ Conditional recommendation',
    REQUEST_CHANGES: '× Changes requested',
    INCOMPLETE: '◌ Review incomplete',
  };
  const findings = result.findings ?? [],
    gaps = result.gaps ?? [];
  const stages = [...new Set(result.coverage?.stages ?? [])];
  const blocking = findings.filter((finding) => finding.disposition === 'BLOCKING').length;
  const followUps = findings.filter((finding) => finding.disposition === 'FOLLOW_UP').length;
  const lines = [
    marker,
    '## InventArch review',
    '',
    `**${verdicts[result.verdict]}** · ${findings.length} finding${findings.length === 1 ? '' : 's'} · ${blocking} blocking recommendation${blocking === 1 ? '' : 's'} · ${followUps} follow-up${followUps === 1 ? '' : 's'}`,
    '',
    escapeText(result.summary),
    '',
    ...(gaps.length ? [`*Evidence limited: ${gaps.length} recorded gaps. See review details below.*`, ''] : []),
  ];
  if (findings.length) lines.push('---', '');
  else lines.push('**No actionable findings retained.** See the verdict and evidence limits above.', '');
  for (const [index, f] of findings.entries()) {
    const severity =
      { high: '▲ High severity', medium: '△ Medium severity', low: '○ Low severity' }[f.severity] ??
      escapeText(f.severity ?? 'Severity unrecorded');
    const disposition =
      { BLOCKING: 'Blocking recommendation', FOLLOW_UP: 'Follow-up' }[f.disposition] ?? escapeText(f.disposition);
    const location = `${f.citation.path}:${f.citation.line}${f.citation.endLine && f.citation.endLine !== f.citation.line ? `–${f.citation.endLine}` : ''}`;
    lines.push(
      `### ${index + 1}. ${escapeText(f.title)}`,
      '',
      `${severity} · ${disposition} · ${escapeText(location)} (${escapeText(f.citation.side)})`,
      '',
      `- **Trigger:** ${escapeText(f.trigger)}`,
      `- **Impact:** ${escapeText(f.consequence)}`,
      `- **Fix / verify:** ${escapeText(f.fix)}`,
      '',
    );
  }
  lines.push(
    '---',
    '',
    '<details><summary>Review details — coverage, counter-evidence, and limitations</summary>',
    '',
    `**Scope:** ${result.coverage?.stages ? stages.length : 'Unrecorded'} passes · ${result.coverage?.filesRead ?? 'Unrecorded'} file versions read · ${result.coverage?.fullUnchangedFiles?.length ?? 'Unrecorded'} full unchanged files read`,
    '',
  );
  if (findings.length) {
    lines.push('#### Counter-evidence considered', '');
    for (const [index, f] of findings.entries())
      lines.push(`**${index + 1}. ${escapeText(f.title)}**`, '', escapeText(f.counterEvidence), '');
  }
  if (gaps.length)
    lines.push(`#### Evidence gaps (${gaps.length})`, '', ...gaps.map((gap) => `- ${escapeText(gap)}`), '');
  lines.push(
    '#### Provenance',
    '',
    '| Detail | Recorded evidence |',
    '| :--- | :--- |',
    `| Model | ${escapeText(result.model)} |`,
    `| Review passes | ${escapeText(stages.join(', ') || 'Not recorded')} |`,
    `| Method | ${escapeText(result.method)} |`,
    `| Source packet | ${escapeText(result.subject)} |`,
    '',
    'File versions count each revision separately; reading the base and head of one path counts as two. Pass counts describe recorded work, not a coverage percentage.',
    '',
    'CI execution evidence is retained with the review; restored results and skipped steps are not new execution.',
    '',
    '</details>',
    '',
    `*Advisory review of commit \`${pinnedSha(result.head)}\`. Does not approve or block merging.*`,
  );
  const body = lines.join('\n');
  if (Buffer.byteLength(body) > 60000)
    throw new Error('Review exceeds GitHub comment bound; retained result must be inspected directly');
  return body;
}
export async function publishReview(gh, repository, result) {
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

async function main() {
  const repository = repoName(process.env.GITHUB_REPOSITORY ?? '');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const runId = integer(event.workflow_run?.id ?? process.env.IA_REVIEW_RUN_ID);
  // A host whose quality workflow has another path names it; the default is Public quality.
  const workflow = process.env.IA_REVIEW_UPSTREAM_WORKFLOW || DEFAULT_UPSTREAM_WORKFLOW;
  const gh = githubClient(process.env.GH_TOKEN ?? '');
  if (process.argv.includes('--prepare')) {
    const { run, pr } = await resolveRun(gh, repository, runId, workflow);
    appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${integer(run.id)}\npr=${integer(pr.number)}\n`);
    return;
  }
  const origin = new URL(process.env.IA_REVIEW_API ?? '');
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('HTTPS API origin required');
  const binding = process.env.IA_REVIEW_BINDING;
  if (!/^[a-f0-9-]{36}$/.test(binding ?? '')) throw new Error('Review binding ID required');
  let token,
    expires = 0;
  const api = async (path, input, method = 'POST') => {
    if (Date.now() >= expires) {
      const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
      if (oidcUrl.protocol !== 'https:') throw new Error('HTTPS OIDC request required');
      oidcUrl.searchParams.set('audience', `${origin.origin}/v1/reviews`);
      const oidc = await fetch(oidcUrl, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!oidc.ok) throw new Error('GitHub OIDC unavailable');
      const identity = await oidc.json();
      const exchange = await fetch(`${origin.origin}/v1/reviews/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding, token: identity.value }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!exchange.ok) throw new Error(`InventArch identity exchange failed (${exchange.status})`);
      const session = await exchange.json();
      token = session.access_token;
      expires = Date.now() + 240000;
    }
    const response = await fetch(`${origin.origin}/v1/reviews${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`InventArch review request failed (${response.status})`);
    return response.json();
  };
  const subject = await collectSubject(gh, repository, runId, process.env.IA_REVIEW_EVIDENCE, workflow);
  const content = JSON.stringify(subject),
    subjectDigest = digest(content);
  await api(`/artifacts/${subjectDigest}`, { content }, 'PUT');
  let receipt = await api('', {
    key: `github:${runId}:${subject.evidence.attempt}:${subject.head}`,
    digest: subjectDigest,
  });
  const deadline = Date.now() + 15 * 60000;
  while (!receipt.result && Date.now() < deadline) {
    receipt = await api(`/${receipt.id}/advance`);
    if (receipt.state === 'running') await pause(3000);
  }
  if (!receipt.result) {
    await api(`/${receipt.id}/cancel`);
    throw new Error('Review exceeded CI deadline');
  }
  mkdirSync('artifacts/review', { recursive: true });
  writeFileSync('artifacts/review/result.json', JSON.stringify(receipt.result, null, 2));
  const delivery = await publishReview(gh, repository, receipt.result);
  if (delivery.reviewId) await api(`/${receipt.id}/delivery`, { reviewId: delivery.reviewId, head: subject.head });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `InventArch review ${receipt.id}: ${receipt.result.verdict} (advisory). ${delivery.skipped ? 'Stale delivery suppressed.' : 'Review comment delivered.'}\n`,
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      `InventArch review could not complete: ${error instanceof Error ? error.message : 'unknown error'}. No clean review is inferred; inspect the workflow configuration and retained API events.`,
    );
    process.exitCode = 1;
  });
