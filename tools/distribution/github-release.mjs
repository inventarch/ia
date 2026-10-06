import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { releaseNotes } from './release-changes.mjs';

const SHA = /^[a-f0-9]{40}$/;

/** Only an HTTP 404 on an optional resource means absence. Error bodies are never resource values. */
export async function githubRelease(options, { request = fetch, run = execFileSync } = {}) {
  const { repository, version, sha, token, notesFile, assets } = options;
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(sha, SHA, 'The exact published commit is required');
  assert.ok(token, 'GH_TOKEN is required');
  const tag = `v${version}`;
  const base = `https://api.github.com/repos/${repository}`;
  const api = async (path, { optional = false, body } = {}) => {
    const method = body ? 'POST' : 'GET';
    const response = await request(base + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && response.status === 404) return null;
    assert.equal(
      response.status,
      body ? 201 : 200,
      `${method} ${path || '/'}: GitHub returned HTTP ${response.status}`,
    );
    const value = await response.json();
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: invalid GitHub response`);
    return value;
  };
  // A missing or inaccessible repository must not be mistaken for two missing release resources.
  const repo = await api('');
  assert.equal(repo.full_name?.toLowerCase(), repository.toLowerCase(), 'GitHub returned another repository');
  const reference = await api(`/git/ref/tags/${tag}`, { optional: true });
  const verifyReference = async (value) => {
    assert.equal(value.ref, `refs/tags/${tag}`, 'GitHub returned another tag');
    let object = value.object;
    const visited = new Set();
    while (true) {
      assert.ok(object && SHA.test(object.sha), `${tag}: invalid tag object`);
      if (object.type === 'commit') {
        assert.equal(object.sha, sha, `${tag} does not name the published commit ${sha}`);
        return;
      }
      assert.equal(object.type, 'tag', `${tag}: tag must resolve to a commit`);
      assert.ok(!visited.has(object.sha) && visited.size < 10, `${tag}: cyclic or excessive annotated tag chain`);
      visited.add(object.sha);
      // A 404 here is a broken tag, never permission to replace the reference.
      const annotated = await api(`/git/tags/${object.sha}`);
      assert.equal(annotated.sha, object.sha, `${tag}: annotated tag identity differs`);
      object = annotated.object;
    }
  };
  if (reference) await verifyReference(reference);
  const release = await api(`/releases/tags/${tag}`, { optional: true });
  if (release) {
    assert.equal(release.tag_name, tag, 'GitHub returned another release');
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid GitHub release identity');
  }
  // Complete all lookups before the first write. Creation is never an update or a force push; a race refuses.
  if (!reference) await verifyReference(await api('/git/refs', { body: { ref: `refs/tags/${tag}`, sha } }));
  if (!release)
    run(
      'gh',
      [
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--verify-tag',
        '--title',
        `IA ${version}`,
        '--notes-file',
        notesFile,
        ...assets,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
  return { tag, tagCreated: !reference, releaseCreated: !release };
}

/** Assemble the qualified release assets and write exactly the selected changeset's release notes. */
export function releaseInputs(root, version, runnerTemp) {
  const directory = resolve(root, 'artifacts/npm');
  const vsix = readdirSync(directory).filter((name) => name.endsWith('.vsix'));
  assert.equal(vsix.length, 1, 'Exactly one qualified VSIX is required');
  const notesFile = resolve(runnerTemp, 'release-notes.md');
  writeFileSync(notesFile, releaseNotes(root, version));
  return {
    notesFile,
    assets: [...vsix, 'npm-release.json', 'system-compatibility.json'].map((name) => resolve(directory, name)),
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..');
  const version = process.env.RELEASE_VERSION;
  console.log(
    await githubRelease({
      repository: process.env.GITHUB_REPOSITORY,
      version,
      sha: process.env.RELEASE_SHA,
      token: process.env.GH_TOKEN,
      ...releaseInputs(root, version, process.env.RUNNER_TEMP),
    }),
  );
}
