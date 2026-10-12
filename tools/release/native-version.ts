/** Independent native release selection. Published Git objects, never a working-copy receipt, own the baseline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';
import {
  declarationVersion,
  nativeArchives,
  nativeOwners,
  nativeVersions,
  readJson,
  NATIVE_LANGUAGE_POLICY,
  NATIVE_SYSTEM_POLICY,
  type NativeArchive,
} from './native-archives.js';

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
  alignment?: '2.1.0';
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
  return { source: { tag, commit }, archives };
}
function bump(version: string, kind: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return kind === 'major'
    ? `${major + 1}.0.0`
    : kind === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
}
/** Compare actual archives repacked at published versions; propagate changed exact dependency ranges to their consumers. */
export function planNativeVersions(baseline: NativeBaseline, normalized: NativeArchive[], notes?: NativeNotes) {
  validateArchives(baseline.archives);
  validateArchives(normalized);
  const prior = new Map(baseline.archives.map((row) => [row.id, row]));
  assert.deepEqual(
    normalized.map((row) => row.id).sort(),
    [...prior.keys()].sort(),
    'Native membership change requires a reviewed baseline migration',
  );
  for (const row of normalized)
    assert.equal(row.version, prior.get(row.id)!.version, 'Comparison is not normalized to published versions');
  const direct = normalized.filter((row) => row.archive !== prior.get(row.id)!.archive).map((row) => row.id);
  const changed = new Set(direct);
  for (let size = -1; size !== changed.size; ) {
    size = changed.size;
    for (const row of normalized) if (row.dependencies.some((id) => changed.has(id))) changed.add(row.id);
  }
  const applicable =
    notes && notes.baseline.tag === baseline.source.tag && notes.baseline.commit === baseline.source.commit;
  if (notes) {
    assert.equal(notes.format, 'ia.native-release-notes.v1');
    assert.ok(Array.isArray(notes.changes));
    assert.equal(
      new Set(notes.changes.map((row) => row.id)).size,
      notes.changes.length,
      'Duplicate native release note',
    );
    for (const row of notes.changes) {
      assert.ok(
        prior.has(row.id) && ['patch', 'minor', 'major'].includes(row.bump) && row.summary?.trim(),
        'Invalid native release note',
      );
    }
    assert.ok(notes.alignment === undefined || notes.alignment === '2.1.0', 'Unsupported native alignment');
  }
  if (applicable && notes.alignment) {
    assert.equal(baseline.source.tag, 'v2.0.0', 'Native alignment is one-time');
    assert.equal(baseline.source.commit, BOOTSTRAP_COMMIT);
    assert.ok(
      baseline.archives.every((row) => row.version === '1.2.0'),
      'Native alignment requires the published initial inventory',
    );
    for (const row of normalized) changed.add(row.id);
  }
  if (changed.size) assert.ok(applicable, 'Changed native archives require notes against the latest published tag');
  const versions = Object.fromEntries(
    normalized.map((row) => {
      const note = applicable ? notes.changes.find((entry) => entry.id === row.id) : undefined;
      if (changed.has(row.id))
        assert.ok(note, `${row.id}: changed archive requires its own bump note (including dependency changes)`);
      return [row.id, changed.has(row.id) ? (notes?.alignment ?? bump(row.version, note!.bump)) : row.version];
    }),
  );
  return { versions, direct: direct.sort(), changed: [...changed].sort() };
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
function replaceFile(root: string, path: string, content: string): void {
  const old = readFileSync(resolve(root, path), 'utf8');
  writeFileSync(
    resolve(root, path),
    old.includes('\r\n') ? content.replace(/\r?\n/g, '\r\n') : content.replace(/\r\n/g, '\n'),
  );
}
export function nativeRelease(root: string, mode: 'plan' | 'check' | 'write') {
  const baseline = nativeBaseline(root),
    current = nativeVersions(root);
  const notes = existsSync(resolve(root, NATIVE_NOTES)) ? (readJson(root, NATIVE_NOTES) as NativeNotes) : undefined;
  const normalized = nativeArchives(root, Object.fromEntries(baseline.archives.map((row) => [row.id, row.version])));
  const plan = planNativeVersions(baseline, normalized, notes);
  // Compute and validate every output before writing any selected version.
  const archives = nativeArchives(root, plan.versions);
  assertNativeImmutability(baseline, archives);
  const ledger = {
    format: 'ia.native-release.v1',
    baseline: baseline.source,
    notesSha256: notes ? sha(readFileSync(resolve(root, NATIVE_NOTES))) : null,
    archives,
  };
  if (mode === 'write') {
    const writes = new Map<string, string>();
    for (const owner of nativeOwners(root))
      for (const path of [
        `.ia/src/systems/${owner.system}/system.ia`,
        `examples/public-language/contracts/${owner.system}.ia`,
      ])
        writes.set(
          path,
          declarationVersion(readFileSync(resolve(root, path), 'utf8'), owner.version, plan.versions[owner.id]!),
        );
    const policy = readJson(root, NATIVE_SYSTEM_POLICY);
    for (const row of policy.owners) row.native.version = plan.versions[row.native.id];
    writes.set(NATIVE_SYSTEM_POLICY, json(policy));
    writes.set(
      NATIVE_LANGUAGE_POLICY,
      json({ ...readJson(root, NATIVE_LANGUAGE_POLICY), language: plan.versions['inventarch/language'] }),
    );
    const before = new Map(
      [...writes.keys(), NATIVE_CURRENT].map((path) => [
        path,
        existsSync(resolve(root, path)) ? readFileSync(resolve(root, path)) : null,
      ]),
    );
    try {
      for (const [path, content] of writes) replaceFile(root, path, content);
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
    const actual = nativeArchives(root);
    assertNativeImmutability(baseline, actual);
    const retained = readJson(root, NATIVE_CURRENT);
    // Immediately after publication, the immutable tag becomes the baseline; no new receipt is needed for unchanged bytes.
    if (plan.changed.length === 0) assert.deepEqual(retained.archives, actual, 'Native archive ledger is stale');
    else assert.deepEqual(retained, ledger, 'Native archive ledger is stale; run pnpm native:version --write');
  }
  return { baseline: baseline.source, ...plan, archives };
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
