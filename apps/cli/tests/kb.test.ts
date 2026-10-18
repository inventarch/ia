import { afterAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, run, scratch, cli, repository } from './workspace-fixture.js';
afterAll(cleanup);
import { canonicalDistributionJson, installationWorkspace } from '@inventarch/db/distribution';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { symlinkSync, unlinkSync } from 'node:fs';
import { dispatch } from '../src/consumer.js';
import { makeHost } from './workspace-fixture.js';
function installedKnowledge() {
  const root = scratch('kb-pack');
  const installation = JSON.parse(
    readFileSync(join(repository, 'packages/kb/tests/fixtures/public-installation.json'), 'utf8'),
  );
  const write = (path: string, content: string | Buffer) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const bundles = new Map();
  for (const bundle of installation.bundles) {
    const pkg = installation.lock.packages.find((p: { id: string }) => p.id === bundle.id);
    bundles.set(bundle.id, { manifest: bundle.manifest, manifestDigest: pkg.manifest, archiveDigest: pkg.archive });
    write('.ia/distributions/store/' + pkg.archive + '/distribution.json', canonicalDistributionJson(bundle.manifest));
    for (const file of bundle.files)
      write('.ia/distributions/store/' + pkg.archive + '/' + file.path, Buffer.from(file.base64, 'base64'));
  }
  const generation = '.ia/distributions/generations/' + installation.pointer.generation;
  write('.ia/distributions.lock.json', canonicalDistributionJson(installation.lock));
  write('.ia/distributions/active.json', canonicalDistributionJson(installation.pointer));
  write(generation + '/lock.json', canonicalDistributionJson(installation.lock));
  write(generation + '/inputs.json', canonicalDistributionJson(installation.inputs));
  const workspace = installationWorkspace(installation.lock, installation.inputs, bundles);
  if (workspace !== null) write(generation + '/workspace.ia', workspace);
  write(
    '.ia/src/notes.ia',
    '#! ia 1.0\n@spec knowledge-alpha\n  meaning\n    says "Alpha."\n  work\n    title "Alpha"\n    status draft\n    source "README.md"\n',
  );
  write('README.md', 'Only committed knowledge.');
  write(
    'selection.json',
    JSON.stringify({ format: 'ia.kb.selection.v1', sourceId: 'test', records: [ID], resources: ['README.md'] }),
  );
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=' + join(root, '.git/no-hooks'), '-c', 'commit.gpgsign=false', '-C', root, ...args],
      { encoding: 'utf8', timeout: 10000 },
    ).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', '.ia/src', 'README.md', 'selection.json');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Knowledge');
  const commit = git('rev-parse', 'HEAD');
  const args = (out: string) => [
    'kb',
    'pack',
    '--root',
    root,
    '--commit',
    commit,
    '--selection',
    'selection.json',
    '--out',
    out,
    '--json',
  ];
  return { root, args };
}
it('previews valid committed packages, returns unchanged on retry, and refuses protected destinations', async () => {
  const { root, args } = installedKnowledge();
  const before = readFileSync(join(root, 'README.md'));
  expect(JSON.parse((await run(args('export.json'))).stdout).value.applied).toBe(false);
  expect(existsSync(join(root, 'export.json'))).toBe(false);
  const first = await run([...args('export.json'), '--apply', '--yes']);
  expect(first.exitCode, first.stdout).toBe(0);
  const again = await run([...args('export.json'), '--apply', '--yes']);
  expect(again.exitCode, again.stdout).toBe(0);
  expect(JSON.parse(again.stdout).value).toMatchObject({ applied: false, unchanged: true });
  for (const output of ['.ia/src/package.ia', '.ia/output.json', 'README.md', 'selection.json']) {
    const result = await run([...args(output), '--apply', '--yes']);
    expect(result.exitCode, result.stdout).toBe(1);
  }
  expect(readFileSync(join(root, 'README.md'))).toEqual(before);
  expect(existsSync(join(root, '.ia/src/package.ia'))).toBe(false);
  writeFileSync(join(root, 'different.json'), 'Keep this.');
  expect((await run([...args('different.json'), '--apply', '--yes'])).exitCode).toBe(1);
  expect(readFileSync(join(root, 'different.json'), 'utf8')).toBe('Keep this.');
});
function governance(root: string, move: string, scoped = false) {
  let text = readFileSync(join(cli, 'tests/fixtures/composition-workspace/.ia/src/workspace.ia'), 'utf8').replace(
    'moves [Observation, Verification, Synthesis, Delegation, Execution]',
    'moves [' + move + ']',
  );
  if (scoped) text = text.replace('scope [@workspace demo]', 'covers ["protected/"]');
  writeFileSync(join(root, '.ia/src/workspace.ia'), text);
}
it('protects a committed selector addressed by an absolute path even when its working copy is absent', async () => {
  const { root, args } = installedKnowledge();
  unlinkSync(join(root, 'selection.json'));
  const command = args('selection.json');
  command[command.indexOf('--selection') + 1] = join(root, 'selection.json');
  const result = await run([...command, '--apply', '--yes']);
  expect(result.exitCode, result.stdout).toBe(1);
  expect(existsSync(join(root, 'selection.json'))).toBe(false);
});
it('enforces path mandates and rejects junction aliases before a pack write', async () => {
  const { root, args } = installedKnowledge();
  mkdirSync(join(root, 'protected'));
  governance(root, 'Observation', true);
  for (const path of ['protected/package.json', join(root, 'protected/absolute.json')]) {
    const result = await run([...args(path), '--apply', '--yes', '--actor', '@agent demo']);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(existsSync(join(root, path))).toBe(false);
  }
  symlinkSync(join(root, 'protected'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await run([...args('alias/package.json'), '--apply', '--yes', '--actor', '@agent demo']);
  expect(result.exitCode, result.stdout).toBe(1);
  expect(existsSync(join(root, 'protected/package.json'))).toBe(false);
});
it('rejudges current authority and destination after interactive confirmation', async () => {
  const { root, args } = installedKnowledge();
  governance(root, 'Execution');
  const host = makeHost({ cwd: root, interactive: true });
  const result = await dispatch(
    [...args('export.json').filter((arg) => arg !== '--json'), '--apply', '--actor', '@agent demo'],
    {
      ...host,
      interaction: {
        ...host.interaction,
        read: async () => {
          governance(root, 'Observation');
          return 'y';
        },
      },
    },
    () => {
      throw Error('Unexpected machine route');
    },
    [],
  );
  expect(result.exitCode, result.stdout).toBe(1);
  expect(existsSync(join(root, 'export.json'))).toBe(false);
});

it.each(['Observation', 'Verification', 'Execution'])(
  'gates every nested operation under a %s-only participant',
  async (move) => {
    const root = knowledge(),
      out = join(root, 'package.json');
    const governance = readFileSync(
      join(cli, 'tests/fixtures/composition-workspace/.ia/src/workspace.ia'),
      'utf8',
    ).replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', 'moves [' + move + ']');
    writeFileSync(join(root, '.ia/src/workspace.ia'), governance);
    const invoke = (args: string[]) => run(['kb', ...args, '--root', root, '--actor', '@agent demo', '--json']);
    const search = await invoke(['search', 'Document-only']),
      check = await invoke(['check']);
    expect(search.exitCode, search.stdout).toBe(move === 'Observation' ? 0 : 1);
    expect(check.exitCode, check.stdout).toBe(move === 'Verification' ? 0 : 1);
    const pack = ['pack', '--commit', '1'.repeat(40), '--selection', '.ia/knowledge.json', '--out', out];
    for (const apply of [false, true]) {
      const result = await invoke([...pack, ...(apply ? ['--apply', '--yes'] : [])]);
      const allowed = move === (apply ? 'Execution' : 'Verification'),
        body = JSON.parse(result.stdout);
      if (allowed)
        expect(body.error, result.stdout).toEqual({
          code: 'IA-KB-INVALID',
          message: 'Installed native foundation required',
        });
      else expect(body.code, result.stdout).toMatch(/^IA-RUNTIME-MANDATE/);
      expect(existsSync(out)).toBe(false);
    }
  },
);
it('judges nested retry advice with the same parsed mode table', async () => {
  const { judgedNext } = await import('../src/profile.js');
  const gate = {
    state: {
      actor: 'agent-system/binding/agent/demo',
      by: 'actor' as const,
      mandates: [
        {
          identity: 'agent-system/policy/mandate/read-only',
          band: 100 as const,
          scope: [],
          moves: ['Observation' as const],
          binds: true,
        },
      ],
      rooted: '',
    },
  };
  expect(judgedNext('Run "ia kb check" to check.', gate)).toContain('needs Verification');
  expect(judgedNext('Run "ia kb search term" to search.', gate)).toContain('--actor');
});

const ID = 'work-system/contract/spec/knowledge-alpha';
function knowledge() {
  const root = scratch('kb');
  cpSync(join(repository, 'examples/conformance/native'), join(root, '.ia/src'), { recursive: true });
  mkdirSync(join(root, '.ia/src/knowledge'), { recursive: true });
  writeFileSync(
    join(root, '.ia/src/knowledge/notes.ia'),
    '#! ia 1.0\n@spec knowledge-alpha\n  meaning\n    says "Alpha."\n  work\n    title "Alpha"\n    status draft\n    source "README.md"\n',
  );
  writeFileSync(join(root, 'README.md'), '# Alpha\n\nDocument-only needle.\n');
  writeFileSync(
    join(root, '.ia/knowledge.json'),
    JSON.stringify({ format: 'ia.kb.selection.v1', sourceId: 'example', records: [ID], resources: ['README.md'] }),
  );
  return root;
}
it('shows nested help without opening a workspace and refuses wrong nested grammar', async () => {
  const cwd = scratch('kb-help');
  const help = await run(['kb', 'pack', '--help'], { cwd });
  expect(help.exitCode, help.stdout + help.stderr).toBe(0);
  expect(help.stdout).toContain('--selection');
  expect(help.stdout).toContain('commit');
  expect((await run(['kb', 'check', '--query', 'x', '--json'], { cwd })).exitCode).toBe(2);
});
it('searches bound text, reads citations, and refuses changed snapshots without .kb', async () => {
  const root = knowledge();
  const invoke = (args: string[]) => run(['kb', ...args, '--root', root, '--json']);
  const search = await invoke(['search', 'Document-only']);
  expect(search.exitCode, search.stdout).toBe(0);
  expect(JSON.parse(search.stdout).value.results[0].identity).toBe(ID);
  const read = JSON.parse((await invoke(['read', ID])).stdout);
  writeFileSync(join(root, 'citation.json'), JSON.stringify(read.value.citation));
  expect((await invoke(['resolve', '--citation', 'citation.json'])).exitCode).toBe(0);
  writeFileSync(join(root, 'README.md'), 'Changed.');
  expect(JSON.parse((await invoke(['resolve', '--citation', 'citation.json'])).stdout).error.code).toBe(
    'IA-KB-SNAPSHOT-UNAVAILABLE',
  );
  expect(existsSync(join(root, '.kb'))).toBe(false);
});
