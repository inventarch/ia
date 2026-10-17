/** Native artifacts align at npm majors, else follow their own content; immutable published tags own the baseline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import { nativeArchives, nativeVersions, readJson, type NativeArchive } from './native-archives.js';

import {
  nativeMajorAlignment,
  prepareNativeSelection,
  readNativeReleaseTarget,
  type NativeReleaseTarget,
} from './native-selectors.mjs';

export const NATIVE_CURRENT = 'releases/native/current.json';
export const NATIVE_NOTES = 'releases/native/notes.json';
const BOOTSTRAP = 'releases/native/baselines/npm-2.0.0.json';
const BOOTSTRAP_COMMIT = '53885910dc2b22809fddb46c31091660930ade48';
const BOOTSTRAP_SHA256 = 'cc948c7d95fc4653c316922cb3aef3a5a42e9983b1fb7121f137c9be8da87e08';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const stable = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const compare = (a: string, b: string) => {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
export interface NativeBaseline {
  source: { tag: string; commit: string };
  archives: NativeArchive[];
}
export interface NativeNotes {
  format: 'ia.native-release-notes.v1';
  baseline: NativeBaseline['source'];
  changes: { id: string; bump: 'patch' | 'minor' | 'major'; summary: string }[];
}
function validateArchives(rows: NativeArchive[]): void {
  assert.ok(Array.isArray(rows) && rows.length, 'Missing native archive inventory');
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'Duplicate native identity');
  for (const row of rows) {
    assert.match(row.id, /^inventarch\/[a-z][a-z0-9-]*$/);
    assert.ok(stable(row.version));
    assert.match(row.archive, /^[a-f0-9]{64}$/);
    assert.match(row.manifest, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(row.dependencies) && new Set(row.dependencies).size === row.dependencies.length);
    assert.ok(
      row.dependencies.every((id) => id !== row.id && rows.some((other) => other.id === id)),
      'Unknown native dependency',
    );
  }
}
/** The latest reachable public release tag supplies exact released native digests, even if the local ledger is edited. */
export function nativeBaseline(root: string): NativeBaseline {
  const tags = git(root, 'tag', '--merged', 'HEAD')
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => compare(a.slice(1), b.slice(1)));
  const tag = tags.at(-1);
  assert.ok(tag, 'Fetch immutable public release tags before native release qualification');
  const commit = git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  let archives: NativeArchive[];
  if (tag === 'v2.0.0') {
    assert.equal(commit, BOOTSTRAP_COMMIT, 'Published v2.0.0 tag moved');
    const bytes = readFileSync(resolve(root, BOOTSTRAP));
    assert.equal(sha(bytes), BOOTSTRAP_SHA256, 'Published bootstrap native digests changed');
    const baseline = JSON.parse(bytes.toString('utf8'));
    assert.equal(baseline.source.commit, commit);
    archives = baseline.archives;
  } else {
    assert.ok(
      git(root, 'ls-tree', '--name-only', commit, '--', NATIVE_CURRENT),
      'Published tag lacks a native archive ledger',
    );
    const ledger = JSON.parse(git(root, 'show', `${commit}:${NATIVE_CURRENT}`));
    assert.equal(ledger.format, 'ia.native-release.v1');
    archives = ledger.archives;
  }
  validateArchives(archives);
  // From npm 3.0.0 on, archives align at an npm major and may keep earlier versions of it, never passing the npm tag.
  const released = tag.slice(1);
  if (tag !== 'v2.0.0')
    assert.ok(
      archives.every(
        (row) => row.version.split('.')[0] === released.split('.')[0] && compare(row.version, released) <= 0,
      ),
      'Published native versions must stay within the npm tag major and at or below the tag',
    );
  return { source: { tag, commit }, archives };
}
const IMPACTS = ['patch', 'minor', 'major'] as const;
const RELEASES = ['none', ...IMPACTS] as const;
/** The npm release's own bump from its published version: none, patch, minor or major. */
function releaseBump(published: string, target: string): (typeof RELEASES)[number] {
  const [from, to] = [published, target].map((version) => version.split('.').map(Number)) as [number[], number[]];
  return from[0] !== to[0] ? 'major' : from[1] !== to[1] ? 'minor' : from[2] !== to[2] ? 'patch' : 'none';
}
function bump(version: string, kind: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return kind === 'major'
    ? `${major + 1}.0.0`
    : kind === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
}
/** Bind native evidence to the npm policy, including the unchanged postpublication case. */
export function assertNativeBaseline(root: string, baseline: NativeBaseline, policy: NativeReleaseTarget): boolean {
  git(root, 'merge-base', '--is-ancestor', policy.baseline.commit, 'HEAD');
  const targetTag = 'v' + policy.version;
  if (git(root, 'tag', '--list', targetTag)) {
    assert.deepEqual(
      baseline.source,
      { tag: targetTag, commit: git(root, 'rev-parse', '--verify', 'refs/tags/' + targetTag + '^{commit}') },
      'Published npm target tag is not the latest reachable native baseline',
    );
  }
  const publishedCurrent = baseline.source.tag === targetTag;
  if (publishedCurrent) {
    const tagged = JSON.parse(git(root, 'show', baseline.source.commit + ':releases/current.json'));
    assert.equal(tagged.version, policy.version, 'Published npm target differs from release tag');
    assert.deepEqual(policy.baseline, tagged.baseline, 'Published npm baseline differs from tagged policy');
  } else {
    assert.deepEqual(
      baseline.source,
      { tag: 'v' + policy.baseline.version, commit: policy.baseline.commit },
      'Native published baseline differs from npm published baseline',
    );
  }
  return publishedCurrent;
}
/**
 * Normalized content changes and their exact dependency consumers need impact notes against the latest published tag.
 * A new npm major aligns every identity to its `x.0.0`; within a major, a changed archive takes its own impact bump
 * and an unchanged archive keeps its published version. The npm release's own bump must cover every note, so from each
 * `x.0.0` alignment no native version passes the npm version.
 */
export function planNativeVersions(
  baseline: NativeBaseline,
  normalized: NativeArchive[],
  target: string,
  notes?: NativeNotes,
) {
  validateArchives(baseline.archives);
  validateArchives(normalized);
  assert.ok(stable(target), 'Native release requires a stable npm target');
  assert.match(baseline.source.tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(compare(target, baseline.source.tag.slice(1)) >= 0, 'Npm release target regressed');
  const prior = new Map(baseline.archives.map((row) => [row.id, row]));
  assert.deepEqual(
    normalized.map((row) => row.id).sort(),
    [...prior.keys()].sort(),
    'Native membership change requires a reviewed baseline migration',
  );
  for (const row of normalized) {
    assert.equal(row.version, prior.get(row.id)!.version, 'Comparison is not normalized to published versions');
    assert.ok(compare(target, row.version) >= 0, row.id + ': native version regressed');
  }
  const alignment = nativeMajorAlignment(target, baseline.source.tag.slice(1));
  const direct = normalized.filter((row) => row.archive !== prior.get(row.id)!.archive).map((row) => row.id);
  const changed = new Set(direct);
  for (let size = -1; size !== changed.size; ) {
    size = changed.size;
    for (const row of normalized) if (row.dependencies.some((id) => changed.has(id))) changed.add(row.id);
  }
  if (notes !== undefined) {
    assert.ok(notes && typeof notes === 'object', 'Invalid native release notes');
    assert.equal(notes.format, 'ia.native-release-notes.v1');
    assert.ok(!Object.hasOwn(notes, 'alignment'), 'Native notes cannot select an independent alignment version');
    assert.ok(notes.baseline && typeof notes.baseline.tag === 'string' && typeof notes.baseline.commit === 'string');
    assert.ok(Array.isArray(notes.changes));
    assert.equal(
      new Set(notes.changes.map((row) => row.id)).size,
      notes.changes.length,
      'Duplicate native release note',
    );
    for (const row of notes.changes)
      assert.ok(
        prior.has(row.id) &&
          ['patch', 'minor', 'major'].includes(row.bump) &&
          typeof row.summary === 'string' &&
          row.summary.trim(),
        'Invalid native release note',
      );
  }
  const applicable = notes?.baseline.tag === baseline.source.tag && notes?.baseline.commit === baseline.source.commit;
  if (changed.size) assert.ok(applicable, 'Changed native archives require notes against the latest published tag');
  const published = baseline.source.tag.slice(1),
    release = releaseBump(published, target),
    selected = new Map<string, string>();
  for (const id of changed) {
    const note = applicable ? notes!.changes.find((entry) => entry.id === id) : undefined;
    assert.ok(note, id + ': changed archive requires its own bump note (including dependency changes)');
    // Lag-independent: the npm release bump, not the distance to npm, bounds each archive's impact.
    assert.ok(
      RELEASES.indexOf(release) >= RELEASES.indexOf(note.bump),
      `${id}: npm ${published} -> ${target} (${release}) does not satisfy native ${note.bump} impact`,
    );
    selected.set(id, bump(prior.get(id)!.version, note.bump));
  }
  const versions = Object.fromEntries(
    normalized.map((row) => [row.id, alignment ?? selected.get(row.id) ?? row.version]),
  );
  assert.ok(
    Object.values(versions).every((version) => compare(version, target) <= 0),
    'Native versions cannot pass the npm target',
  );
  return { versions, alignment, direct: direct.sort(), changed: [...changed].sort() };
}
export function assertNativeImmutability(baseline: NativeBaseline, archives: NativeArchive[]): void {
  for (const row of archives) {
    const prior = baseline.archives.find((entry) => entry.id === row.id);
    assert.ok(prior, 'Unreviewed new native identity');
    assert.ok(compare(row.version, prior.version) >= 0, `${row.id}: native version regressed`);
    if (row.version === prior.version)
      assert.equal(row.archive, prior.archive, `${row.id}@${row.version}: published native bytes are immutable`);
  }
}
export function nativeRelease(root: string, mode: 'plan' | 'check' | 'write') {
  const policy = readNativeReleaseTarget(root),
    baseline = nativeBaseline(root),
    current = nativeVersions(root),
    publishedCurrent = assertNativeBaseline(root, baseline, policy);
  const notes = existsSync(resolve(root, NATIVE_NOTES)) ? (readJson(root, NATIVE_NOTES) as NativeNotes) : undefined;
  const normalized = nativeArchives(root, Object.fromEntries(baseline.archives.map((row) => [row.id, row.version])));
  const plan = planNativeVersions(baseline, normalized, policy.version, notes);
  const writes = prepareNativeSelection(root, policy.version, plan.versions);
  assert.ok(writes.size, 'Missing native selector surface');
  // Compute and validate every output before writing any selected version.
  const archives = nativeArchives(root, plan.versions);
  assertNativeImmutability(baseline, archives);
  const freshLedger = {
    format: 'ia.native-release.v1',
    baseline: baseline.source,
    notesSha256: notes ? sha(readFileSync(resolve(root, NATIVE_NOTES))) : null,
    archives,
  };
  const publishedLedger =
    publishedCurrent && plan.changed.length === 0
      ? JSON.parse(git(root, 'show', baseline.source.commit + ':' + NATIVE_CURRENT))
      : undefined;
  const ledger = publishedLedger ?? freshLedger;
  if (mode === 'write') {
    const before = new Map(
      [...writes.keys(), NATIVE_CURRENT].map((path) => [
        path,
        existsSync(resolve(root, path)) ? readFileSync(resolve(root, path)) : null,
      ]),
    );
    try {
      for (const [path, content] of writes) writeFileSync(resolve(root, path), content);
      // Real bytes must match the preview. A changed generated asset requires regeneration and another selection run.
      assert.deepEqual(nativeArchives(root), archives, 'Applied native version differs from planned archive bytes');
      writeFileSync(resolve(root, NATIVE_CURRENT), json(ledger));
    } catch (error) {
      for (const [path, bytes] of before) {
        if (bytes !== null) writeFileSync(resolve(root, path), bytes);
        else rmSync(resolve(root, path), { force: true });
      }
      throw error;
    }
  } else if (mode === 'check') {
    assert.deepEqual(current, plan.versions, 'Selected native versions are stale; run pnpm native:version --write');
    assert.ok(
      [...writes].every(([path, text]) => readFileSync(resolve(root, path), 'utf8') === text),
      'Native selectors are stale; run pnpm native:version --write',
    );
    const actual = nativeArchives(root);
    assertNativeImmutability(baseline, actual);
    const retained = readJson(root, NATIVE_CURRENT);
    // Immediately after publication, the immutable tag becomes the baseline; no new receipt is needed for unchanged bytes.
    assert.equal(retained.format, 'ia.native-release.v1', 'Invalid native archive ledger');
    if (publishedLedger) {
      assert.deepEqual(retained, publishedLedger, 'Published native ledger differs from immutable tagged evidence');
      assert.deepEqual(retained.archives, actual, 'Native archive ledger is stale');
    } else assert.deepEqual(retained, ledger, 'Native archive ledger is stale; run pnpm native:version --write');
  }
  return { target: policy.version, baseline: baseline.source, ...plan, archives };
}
if (isEntry(process.argv[1], import.meta.url)) {
  assert.ok(
    process.argv.slice(2).length <= 1 && [undefined, '--write', '--check'].includes(process.argv[2]),
    'Usage: native-version.ts [--write|--check]',
  );
  const result = nativeRelease(
    fileURLToPath(new URL('../../', import.meta.url)),
    process.argv[2] === '--write' ? 'write' : process.argv[2] === '--check' ? 'check' : 'plan',
  );
  console.log(json(result));
}
