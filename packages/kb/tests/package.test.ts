import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacyFoundation } from '../src/legacy.js';
import { digest, hash, LIMITS } from '../src/format.js';
import { committedReader } from '../src/git.js';
import { packageFromCommit, verifyPackage } from '../src/package.js';
import type { KnowledgePackage } from '../src/package.js';
import { packageFromCommit as legacyPackageFromCommit } from '../src/legacy.js';
const foundation = createLegacyFoundation(
  JSON.parse(readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8')),
);
const ID = 'work-system/contract/spec/alpha';
it('preserves committed packaging from an explicit bare repository root', () => {
  const { root, commit } = repository(),
    revision = commit(),
    bare = root + '-bare';
  roots.push(bare);
  execFileSync('git', ['clone', '--bare', '--quiet', root, bare], { timeout: 10000 });
  const options = { commit: revision, paths: ['.ia/src/notes.ia'], sourceId: 'legacy' };
  expect(legacyPackageFromCommit({ ...options, repository: bare })).toEqual(
    legacyPackageFromCommit({ ...options, repository: root }),
  );
});
it('retains legacy committed-writer envelopes and exact selected bytes', () => {
  const { root, commit } = repository();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/alpha.md'), 'Legacy body');
  const path = join(root, '.ia/src/notes.ia');
  writeFileSync(path, readFileSync(path, 'utf8').replace('README.md', 'docs/alpha.md'));
  const revision = commit();
  writeFileSync(join(root, 'docs/alpha.md'), 'dirty');
  const p = legacyPackageFromCommit({
    repository: root,
    commit: revision,
    paths: ['.ia/src/notes.ia', 'docs/alpha.md'],
    sourceId: 'legacy',
  });
  expect(p.format).toBe('iakb.portable.v1');
  expect(p.files[1]).toMatchObject({ path: 'docs/alpha.md', text: 'Legacy body' });
  expect(p.files[1]).not.toHaveProperty('bytes');
});

it('ignores inherited Git repository and object redirection', () => {
  const requested = repository(),
    foreign = repository();
  requested.commit();
  writeFileSync(join(foreign.root, 'README.md'), 'Foreign private body');
  const revision = foreign.commit(),
    saved = process.env['GIT_DIR'];
  try {
    process.env['GIT_DIR'] = join(foreign.root, '.git');
    expect(() =>
      packageFromCommit({ repository: requested.root, commit: revision, selection: 'selection.json', foundation }),
    ).toThrow();
  } finally {
    if (saved === undefined) delete process.env['GIT_DIR'];
    else process.env['GIT_DIR'] = saved;
  }
});
it('refuses a subdirectory root rather than mixing root and relative Git coordinates', () => {
  const { root, commit } = repository(),
    child = join(root, 'app');
  mkdirSync(join(child, '.ia/src'), { recursive: true });
  for (const path of ['selection.json', '.ia/src/notes.ia'])
    writeFileSync(join(child, path), readFileSync(join(root, path)));
  writeFileSync(join(child, 'README.md'), 'Child content');
  expect(() =>
    packageFromCommit({ repository: child, commit: commit(), selection: 'selection.json', foundation }),
  ).toThrow(/root/i);
});
it('rejects an authored copy of a foundation identity even when semantic bytes match', () => {
  const { root, commit } = repository();
  const record =
    '#! ia 1.0\n@artifact-set contract\n  meaning\n    says "An agreement or structural obligation consumers rely on."\n    answers "Is the artifact mainly there to state what consumers may rely on?"\n  data\n    order 2\n';
  writeFileSync(join(root, '.ia/src/copy.ia'), record);
  writeFileSync(
    join(root, 'selection.json'),
    JSON.stringify({
      format: 'ia.kb.selection.v1',
      sourceId: 'example',
      records: ['taxonomy/definition/artifact-set/contract'],
      resources: [],
    }),
  );
  expect(() =>
    packageFromCommit({ repository: root, commit: commit(), selection: 'selection.json', foundation }),
  ).toThrow(/foundation/i);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=' + join(root, '.git/disabled'), '-c', 'commit.gpgsign=false', '-C', root, ...args],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '--quiet', '--object-format=' + objectFormat);
  git('config', 'core.autocrlf', 'false');
  writeFileSync(
    join(root, '.ia/src/notes.ia'),
    '#! ia 1.0\n@spec alpha\n  meaning\n    says "Alpha specification."\n  work\n    title "Alpha"\n    status draft\n    source "README.md"\n',
  );
  writeFileSync(join(root, 'README.md'), '# Alpha\n\nCommitted needle.\n');
  writeFileSync(
    join(root, 'selection.json'),
    JSON.stringify({ format: 'ia.kb.selection.v1', sourceId: 'example', records: [ID], resources: ['README.md'] }),
  );
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Synthetic knowledge',
    );
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}
it('packages explicit root Markdown and selection from the exact commit despite dirty files', () => {
  const { root, commit } = repository(),
    revision = commit();
  writeFileSync(join(root, 'README.md'), 'Dirty replacement');
  writeFileSync(join(root, 'selection.json'), '{}');
  const result = packageFromCommit({ repository: root, commit: revision, selection: 'selection.json', foundation });
  expect(result).toMatchObject({
    format: 'ia.kb.package.v1',
    provenance: { commit: revision, verification: 'unverified' },
  });
  expect(JSON.stringify(result)).toContain('Committed needle.');
  expect(JSON.stringify(result)).not.toContain('Dirty replacement');
});
it('refuses a mixed native file without exporting an unselected sibling', () => {
  const { root, commit } = repository();
  const path = join(root, '.ia/src/notes.ia');
  writeFileSync(
    path,
    readFileSync(path, 'utf8') +
      '\n@spec hidden\n  meaning\n    says "Hidden specification."\n  work\n    title "Hidden"\n    status draft\n',
  );
  expect(() =>
    packageFromCommit({ repository: root, commit: commit(), selection: 'selection.json', foundation }),
  ).toThrow(/mixed|unselected/i);
});
it('refuses an unreadable repository as operational, not as invalid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge no repository '));
  roots.push(root);
  expect(() => committedReader(root, '1'.repeat(40))).toThrow(
    expect.objectContaining({ code: 'IA-KB-SOURCE-UNAVAILABLE' }),
  );
});
it('refuses a missing commit or non-commit object as invalid input in a readable repository', () => {
  const { root, commit, git } = repository();
  const revision = commit();
  for (const object of ['0123456789012345678901234567890123456789', git('rev-parse', revision + ':README.md')])
    expect(() => committedReader(root, object)).toThrow(expect.objectContaining({ code: 'IA-KB-INVALID' }));
});
it('refuses a committed selection above the package record limit', () => {
  const { root, commit } = repository();
  writeFileSync(
    join(root, 'selection.json'),
    JSON.stringify({
      format: 'ia.kb.selection.v1',
      sourceId: 'example',
      records: Array.from({ length: LIMITS.records + 1 }, (_, i) => ID + i),
      resources: [],
    }),
  );
  expect(() =>
    packageFromCommit({ repository: root, commit: commit(), selection: 'selection.json', foundation }),
  ).toThrow('Knowledge selection record limit exceeded');
});
it('keeps selections, resource associations and files within the package format limits', () => {
  const { root, commit } = repository(),
    pkg = packageFromCommit({ repository: root, commit: commit(), selection: 'selection.json', foundation });
  const resealed = (change: Partial<KnowledgePackage>) => {
    const { digest: _digest, ...body } = { ...pkg, ...change };
    return { ...body, digest: digest(body) };
  };
  const associations = (count: number) => ({
    associations: Array.from({ length: count }, () => pkg.associations[0]!),
  });
  expect(verifyPackage(resealed(associations(LIMITS.records))).associations).toHaveLength(LIMITS.records);
  expect(() => verifyPackage(resealed(associations(LIMITS.records + 1)))).toThrow('Invalid resource associations');
  const records = Array.from({ length: LIMITS.records + 1 }, (_, i) => ID + i);
  expect(() => verifyPackage(resealed({ selection: { ...pkg.selection, records } }))).toThrow(
    'Knowledge selection record limit exceeded',
  );
  const native = pkg.files.find((f) => f.path.startsWith('.ia/src/'))!,
    count = LIMITS.selectedBytes / LIMITS.fileBytes;
  const files = (extra: number) => ({
    files: [
      native,
      ...Array.from({ length: count }, (_, i) => {
        const bytes = i < count - 1 ? LIMITS.fileBytes : LIMITS.fileBytes - native.bytes + extra,
          text = 'x'.repeat(bytes);
        return { path: 'body-' + i + '.md', text, sha256: hash(text), bytes };
      }),
    ],
  });
  expect(verifyPackage(resealed(files(0))).files).toHaveLength(count + 1);
  expect(() => verifyPackage(resealed(files(1)))).toThrow('Portable byte limit exceeded');
  const many = (count: number) => ({
    files: [
      native,
      ...Array.from({ length: count - 1 }, (_, i) => ({
        path: 'body-' + String(i).padStart(3, '0') + '.md',
        text: 'x',
        sha256: hash('x'),
        bytes: 1,
      })),
    ],
  });
  expect(verifyPackage(resealed(many(LIMITS.files))).files).toHaveLength(LIMITS.files);
  expect(() => verifyPackage(resealed(many(LIMITS.files + 1)))).toThrow('Invalid file selection');
});
it('refuses malformed committed selection JSON as invalid input', () => {
  const { root, commit } = repository();
  writeFileSync(join(root, 'selection.json'), '{');
  expect(() =>
    packageFromCommit({ repository: root, commit: commit(), selection: 'selection.json', foundation }),
  ).toThrow(expect.objectContaining({ code: 'IA-KB-INVALID' }));
});
it('requires the complete SHA-256 commit rather than its 40-character abbreviation', () => {
  const { root, commit } = repository('sha256'),
    revision = commit();
  expect(revision).toHaveLength(64);
  expect(committedReader(root, revision).read('README.md').text).toContain('Committed needle.');
  expect(() => committedReader(root, revision.slice(0, 40))).toThrow(
    expect.objectContaining({ code: 'IA-KB-INVALID' }),
  );
});
it('classifies a real overflowing native tree listing as an operational source limit', () => {
  const { root, commit, git } = repository();
  const revision = commit(),
    blob = git('rev-parse', revision + ':README.md');
  const tree = (input: string) =>
    execFileSync('git', ['-C', root, 'mktree'], {
      input,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  // Synthetic Git objects avoid thousands of host files while exercising real ls-tree output and ENOBUFS.
  const native = tree(
    Array.from(
      { length: 6000 },
      (_, i) => '100644 blob ' + blob + '\t' + String(i).padStart(5, '0') + 'x'.repeat(200) + '.ia\n',
    ).join(''),
  );
  const ia = tree('040000 tree ' + native + '\tsrc\n');
  const top = tree('040000 tree ' + ia + '\t.ia\n');
  const large = git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit-tree',
    top,
    '-m',
    'Large tree',
  );
  expect(() => committedReader(root, large).nativePaths()).toThrow(
    expect.objectContaining({
      code: 'IA-KB-SOURCE-UNAVAILABLE',
      message: 'Repository output byte limit exceeded',
    }),
  );
});
it('reads a committed file of exactly the byte limit and refuses larger files by their byte limit', () => {
  const { root, commit } = repository();
  for (const [bytes, accepted] of [
    [LIMITS.fileBytes, true],
    [LIMITS.fileBytes + 1, false],
    // Past the Git output buffer: once ENOBUFS, never "unavailable or timed out".
    [LIMITS.fileBytes + 4096, false],
  ] as const) {
    writeFileSync(join(root, 'README.md'), 'x'.repeat(bytes));
    const reader = committedReader(root, commit());
    if (accepted) expect(reader.read('README.md').bytes).toBe(bytes);
    else
      expect(() => reader.read('README.md')).toThrow(
        expect.objectContaining({ code: 'IA-KB-INVALID', message: 'Selected file byte limit exceeded' }),
      );
  }
});
