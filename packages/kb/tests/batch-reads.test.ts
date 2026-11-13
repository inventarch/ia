import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedReader } from '../src/git.js';
import { createLegacyFoundation } from '../src/legacy.js';
import { packageFromCommit } from '../src/package.js';

// Every git process the reader starts goes through execFileSync; the wrapper counts them and changes nothing.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const spawned = vi.mocked(execFileSync);

const foundation = createLegacyFoundation(
  JSON.parse(readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8')),
);
const ID = 'work-system/contract/spec/alpha';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spec = (name: string) =>
  `#! ia 1.0\n@spec ${name}\n  meaning\n    says "Specification ${name}."\n  work\n    title "${name}"\n    status draft\n    source "README.md"\n`;
function repository(extra: number) {
  const root = mkdtempSync(join(tmpdir(), 'ia batch reads '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src/more'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=' + join(root, '.git/disabled'), '-c', 'commit.gpgsign=false', '-C', root, ...args],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(root, '.ia/src/notes.ia'), spec('alpha'));
  for (let i = 0; i < extra; i++) writeFileSync(join(root, `.ia/src/more/beta-${i}.ia`), spec(`beta-${i}`));
  writeFileSync(join(root, 'README.md'), '# Alpha\n\nCommitted needle.\n');
  writeFileSync(
    join(root, 'selection.json'),
    JSON.stringify({ format: 'ia.kb.selection.v1', sourceId: 'example', records: [ID], resources: ['README.md'] }),
  );
  // `staged` commits the index as it stands, so an entry added only to the index (a link) is kept.
  const commit = (staged = false) => {
    if (!staged) git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Synthetic');
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}
/** The git processes one packageFromCommit starts, and its result or refusal. */
function pack(root: string, commit: string) {
  spawned.mockClear();
  let outcome: unknown;
  try {
    outcome = packageFromCommit({ repository: root, commit, selection: 'selection.json', foundation });
  } catch (error) {
    outcome = error;
  }
  return { outcome, git: spawned.mock.calls.filter((call) => call[0] === 'git').length };
}

describe('kb pack reads a commit with a fixed number of git processes', () => {
  it('starts the same number of git processes, at most nine, for one native file and for twenty-one', () => {
    const one = repository(0),
      many = repository(20);
    const small = pack(one.root, one.commit()),
      large = pack(many.root, many.commit());
    expect(small.outcome).toMatchObject({ format: 'ia.kb.package.v1' });
    expect(large.outcome).toMatchObject({ format: 'ia.kb.package.v1' });
    expect((large.outcome as { files: unknown[] }).files).toEqual((small.outcome as { files: unknown[] }).files);
    expect(large.git).toBe(small.git);
    expect(large.git).toBeLessThanOrEqual(9);
  });
});

describe('kb pack keeps its refusals and their order when it reads in batches', () => {
  const blobOf = (repo: ReturnType<typeof repository>, bytes: Buffer | string) => {
    const file = join(repo.root, 'blob.tmp');
    writeFileSync(file, bytes);
    const id = repo.git('hash-object', '-w', file);
    rmSync(file);
    return id;
  };
  it('refuses a committed link among the native files', () => {
    const repo = repository(2);
    repo.git('add', '.');
    repo.git('update-index', '--add', '--cacheinfo', `120000,${blobOf(repo, 'notes.ia')},.ia/src/more/link.ia`);
    const { outcome } = pack(repo.root, repo.commit(true));
    expect(outcome).toMatchObject({ message: 'Selected committed regular non-executable blob unavailable' });
  });
  it('refuses a native file that is not UTF-8', () => {
    const repo = repository(2);
    writeFileSync(join(repo.root, '.ia/src/more/broken.ia'), Buffer.from([0x23, 0x21, 0xff, 0xfe, 0x0a]));
    const { outcome } = pack(repo.root, repo.commit());
    expect(outcome).toMatchObject({ message: 'Selected blob is not UTF-8' });
  });
  it('refuses a native file whose name is not UTF-8, as reading it path by path does', () => {
    // A Git path is bytes. Decoded lossily, a stray 0xff byte becomes U+FFFD, a path the commit does not hold, so the
    // path-by-path read refuses it; the batched read must not fetch the blob under that name instead.
    const repo = repository(0);
    repo.git('add', '.');
    const entry = Buffer.concat([
      Buffer.from(`100644 blob ${blobOf(repo, spec('gamma'))}\t.ia/src/more/gamma-`),
      Buffer.from([0xff]),
      Buffer.from('.ia\0'),
    ]);
    execFileSync('git', ['-C', repo.root, 'update-index', '-z', '--index-info'], { input: entry, windowsHide: true });
    const { outcome } = pack(repo.root, repo.commit(true));
    expect(outcome).toMatchObject({ message: 'Selected committed regular non-executable blob unavailable' });
  });
  it('packs a native file whose name is not UTF-8 when another file has its lossy name, as path by path does', () => {
    // The lossy name of `gamma-<0xff>.ia` is `gamma-\uFFFD.ia`, and here a file really has that name: reading the name,
    // in a batch or path by path, reads that file.
    const repo = repository(0);
    repo.git('add', '.');
    const entries = Buffer.concat([
      Buffer.from(`100644 blob ${blobOf(repo, spec('gamma'))}\t.ia/src/more/gamma-\uFFFD.ia\0`),
      Buffer.from(`100644 blob ${blobOf(repo, spec('delta'))}\t.ia/src/more/gamma-`),
      Buffer.from([0xff]),
      Buffer.from('.ia\0'),
    ]);
    execFileSync('git', ['-C', repo.root, 'update-index', '-z', '--index-info'], { input: entries, windowsHide: true });
    const revision = repo.commit(true);
    expect(pack(repo.root, revision).outcome).toMatchObject({ format: 'ia.kb.package.v1' });
    // Which blob the name reads: the real file's, in a batch as path by path, never the 0xff name's.
    const reader = committedReader(repo.root, revision),
      name = '.ia/src/more/gamma-\uFFFD.ia';
    expect(reader.readMany([name])[0]!().text).toBe(spec('gamma'));
    expect(reader.read(name).text).toBe(spec('gamma'));
  });
  it('refuses at the first faulty native file in path order', () => {
    const repo = repository(0);
    writeFileSync(join(repo.root, '.ia/src/more/a-broken.ia'), Buffer.from([0xff, 0x0a]));
    repo.git('add', '.');
    repo.git('update-index', '--add', '--cacheinfo', `120000,${blobOf(repo, 'x')},.ia/src/more/z-link.ia`);
    const { outcome } = pack(repo.root, repo.commit(true));
    expect(outcome).toMatchObject({ message: 'Selected blob is not UTF-8' });
  });
  it('refuses native text past 16 MiB in total', () => {
    const repo = repository(0);
    const body = `#! ia 1.0\n# ${'x'.repeat(1024 * 1024 - 16)}\n`;
    for (let i = 0; i < 17; i++)
      writeFileSync(join(repo.root, `.ia/src/more/big-${String(i).padStart(2, '0')}.ia`), body);
    const { outcome } = pack(repo.root, repo.commit());
    expect(outcome).toMatchObject({ message: 'Native discovery byte limit exceeded' });
  }, 60_000);

  // A partial clone or a damaged store can lack objects the old reader never opened.
  const dropObject = (repo: ReturnType<typeof repository>, path: string) => {
    const id = repo.git('rev-parse', `HEAD:${path}`);
    rmSync(join(repo.root, '.git', 'objects', id.slice(0, 2), id.slice(2)));
  };
  it('still packs when an object it never reads is missing from the store', () => {
    const repo = repository(1);
    writeFileSync(join(repo.root, '.ia/src/more/notes.txt'), 'not a source');
    const revision = repo.commit();
    const before = pack(repo.root, revision).outcome;
    dropObject(repo, '.ia/src/more/notes.txt');
    expect(pack(repo.root, revision).outcome).toEqual(before);
  });
  it('refuses at an earlier faulty file before a later missing object', () => {
    const repo = repository(0);
    writeFileSync(join(repo.root, '.ia/src/more/a-broken.ia'), Buffer.from([0xff, 0x0a]));
    writeFileSync(join(repo.root, '.ia/src/more/z-gone.ia'), spec('gone'));
    const revision = repo.commit();
    dropObject(repo, '.ia/src/more/z-gone.ia');
    expect(pack(repo.root, revision).outcome).toMatchObject({ message: 'Selected blob is not UTF-8' });
  });
});
