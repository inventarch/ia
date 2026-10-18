import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLegacyFoundation } from '../src/legacy.js';
import { packageFromCommit } from '../src/package.js';
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
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=' + join(root, '.git/disabled'), '-c', 'commit.gpgsign=false', '-C', root, ...args],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '--quiet');
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
