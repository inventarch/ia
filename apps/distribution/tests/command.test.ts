import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
import { pathToFileURL } from 'node:url';
import { runBounded } from '@tools/testing/subprocess.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adoptWorkspace, captureWorkspace, installedImplementationDigest } from '@inventarch/workspace-runtime';
import { captureResources, resourceOccurrences } from '@inventarch/workspace-runtime/resources';
import { claudeProseCatalog, codexProseCatalog } from '@inventarch/workspace-runtime/projections';
import { digest, sha256 } from '../src/files.js';
import { run } from '../src/command.js';

const repository = resolve(import.meta.dirname, '../../..'),
  temporary = mkdtempSync(join(tmpdir(), 'ia-command-test-'));
const root = join(temporary, 'workspace with spaces');
beforeAll(() => {
  mkdirSync(root);
  copyPublicLanguageFixture(repository, join(root, 'vendor/foundation'));
  cpSync(join(repository, 'tools/projections/fixtures/synthetic-review'), join(root, 'vendor/review'), {
    recursive: true,
  });
  mkdirSync(join(root, '.ia'));
  const bindings = ['foundation', 'review'].map((id) => ({
    id,
    path: 'vendor/' + id,
    revision: adoptWorkspace(join(root, 'vendor', id), id).revision,
  }));
  writeFileSync(join(root, '.ia/workspace.json'), JSON.stringify({ version: 1, adopted: bindings }));
  const validation = run(['validate', '--root', root]);
  if (validation.exitCode) throw new Error(JSON.stringify(validation.result));
  const capture = captureWorkspace(root),
    inventory = resourceOccurrences(capture),
    owner = inventory.occurrences.find((o) => o.identity.endsWith('/fictional-reviewer'))!;
  // crowncodes/ia#444: an agent export needs its agent profile, whose capability effects bound the host tools.
  const profile = inventory.occurrences.find((o) => o.identity.endsWith('/fictional-review-profile'))!;
  const resources = captureResources(capture, { roots: [], files: [], associations: [] });
  writeFileSync(join(root, 'resources.json'), JSON.stringify(resources));
  for (const host of ['claude', 'codex'])
    for (const product of ['workspace', 'plugin']) {
      const catalog = (host === 'claude' ? claudeProseCatalog : codexProseCatalog)(installedImplementationDigest());
      const body = {
        format: 'ia.projection-descriptor.v1',
        sourceRevisions: inventory.sourceRevisions,
        product,
        profiles: [catalog.profile],
        resourcesDigest: resources.digest,
        inventoryDigest: 'a'.repeat(64),
        exports: [
          {
            id: 'reviewer',
            outputName: 'fictional-reviewer',
            target: owner,
            required: true,
            description: 'Review fictional notes.',
            profile: catalog.profile.id,
            resources: [],
            requirements: [],
            presentation: {
              kind: 'agent',
              agent: owner,
              agentProfile: profile,
              model: 'inherit',
              tools: ['read'],
              delegates: [],
            },
          },
        ],
      };
      writeFileSync(join(root, `${host}-${product}.json`), JSON.stringify({ ...body, digest: digest(body) }));
    }
}, 30000);
afterAll(() => {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-command-test-'))
    throw new Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it.each(['claude-workspace', 'claude-plugin', 'codex-workspace', 'codex-plugin'])(
  'publishes and checks exact native %s output through explicit-root commands',
  (profile) => {
    const [host] = profile.split('-'),
      output = join(temporary, profile);
    mkdirSync(output);
    const args = [
      'project',
      '--root',
      root,
      '--descriptor',
      profile + '.json',
      '--resources',
      'resources.json',
      '--host',
      host!,
      '--name',
      'review',
      '--version',
      '0.1.0',
      '--out',
      output,
    ];
    expect(run([...args, '--check']).exitCode).toBe(1);
    expect(run(args)).toMatchObject({ exitCode: 0, result: { status: 'published' } });
    expect(run([...args, '--check'])).toMatchObject({ exitCode: 0, result: { status: 'current' } });
  },
);
it('validates and explains admitted records without a source loader', () => {
  expect(run(['validate', '--root', root])).toMatchObject({ exitCode: 0, result: { status: 'admitted' } });
  expect(run(['explain', '--root', root, '--record', 'agent-system/binding/agent/fictional-reviewer'])).toMatchObject({
    exitCode: 0,
    result: { record: { name: 'fictional-reviewer' } },
  });
});
it.each(
  [
    ['validate'],
    ['validate', '--root', '.'],
    ['validate', '--root', root, '--root', root],
    ['project', '--root', root, '--descriptor', '../outside.json'],
  ].map((args) => ({ args })),
)('rejects invalid root/arguments $args', ({ args }) => {
  expect(() => run(args)).toThrow();
});
it('refuses changed pinned resource bytes before output creation', () => {
  const content = JSON.parse(readFileSync(join(root, 'resources.json'), 'utf8')) as { digest: string };
  content.digest = 'f'.repeat(64);
  writeFileSync(join(root, 'tampered.json'), JSON.stringify(content));
  expect(() =>
    run([
      'project',
      '--root',
      root,
      '--descriptor',
      'codex-plugin.json',
      '--resources',
      'tampered.json',
      '--host',
      'codex',
      '--name',
      'review',
      '--version',
      '0.1.0',
      '--out',
      temporary,
    ]),
  ).toThrow('digest differs');
});
it('formats a contextual draft without applying source and creates only a new draft file', () => {
  const formattedRoot = join(temporary, 'format-workspace');
  cpSync(join(root, 'vendor/foundation'), formattedRoot, { recursive: true });
  const path = '.ia/src/systems/agent-composition-system/records/composition.ia',
    original = readFileSync(join(formattedRoot, path), 'utf8');
  writeFileSync(join(formattedRoot, 'candidate.ia'), original);
  const args = ['format', '--root', formattedRoot, '--path', path, '--input', 'candidate.ia'];
  expect(run(args)).toMatchObject({ exitCode: 0, result: { status: 'draft' } });
  expect(readFileSync(join(formattedRoot, path), 'utf8')).toBe(original);
  expect(run([...args, '--out', '.ia/work/draft.ia']).exitCode).toBe(0);
  expect(() => run([...args, '--out', '.ia/work/draft.ia'])).toThrow('already exists');
  expect(() => run([...args, '--out', path])).toThrow('.ia/work');
  writeFileSync(join(formattedRoot, 'candidate.ia'), '#! ia 1.0\n@agent broken\n');
  expect(run(args)).toMatchObject({ exitCode: 1, result: { status: 'refused' } });
  expect(readFileSync(join(formattedRoot, path), 'utf8')).toBe(original);
});
it('renders a captured structured template through the explicit-root command', () => {
  const project = join(temporary, 'structured-workspace');
  cpSync(join(root, 'vendor/foundation'), project, { recursive: true });
  const path = '.ia/src/systems/template-system/records/structured-test.ia';
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(
    join(project, path),
    '#! ia 1.0\n\n@template structured-test\n  meaning\n    says "Render an original example."\n    answers "What is rendered?"\n  template\n    filename "docs/example.md"\n    parameters []\n    lines []\n    profile structured-v1\n    resource "tree.json"\n',
  );
  const tree = JSON.stringify({
    format: 'ia.structured-template.v1',
    inputs: { title: { type: 'text', required: true } },
    nodes: [
      { kind: 'text', text: '# ' },
      { kind: 'value', input: 'title' },
    ],
  });
  writeFileSync(join(project, 'tree.json'), tree);
  const capture = captureWorkspace(project),
    owner = resourceOccurrences(capture).occurrences.find((o) => o.identity.endsWith('/structured-test'))!;
  const key = { source: owner.source, revision: owner.revision, path: 'tree.json' };
  const resources = captureResources(capture, {
    roots: [{ source: owner.source, revision: owner.revision, root: project }],
    files: [
      { key, bytes: Buffer.byteLength(tree), sha256: sha256(tree), mediaType: 'application/json', encoding: 'utf8' },
    ],
    associations: [
      { owner, resources: [{ key, role: 'template', order: 0, required: true, delivery: 'installed-reference' }] },
    ],
  });
  writeFileSync(join(project, 'resources.json'), JSON.stringify(resources));
  writeFileSync(join(project, 'values.json'), '{"title":"Original document"}');
  const args = [
    'render',
    '--root',
    project,
    '--template',
    owner.identity,
    '--resources',
    'resources.json',
    '--values',
    'values.json',
  ];
  expect(run(args)).toMatchObject({
    exitCode: 0,
    result: { status: 'rendered', artifact: { text: '# Original document' } },
  });
  expect(run([...args, '--out', '.ia/work/document.md']).exitCode).toBe(0);
  expect(() => run([...args, '--out', '.ia/work/document.md'])).toThrow('already exists');
  writeFileSync(join(project, 'values.json'), '{"title":"one","title":"two"}');
  expect(run(args)).toMatchObject({ exitCode: 1, result: { status: 'refused' } });
});

it('imports the installed command entry without dispatch and still runs an explicit CLI entry', async () => {
  const executable = resolve(repository, 'apps/distribution/dist/cli.js');
  const imported = await runBounded(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await import(' + JSON.stringify(pathToFileURL(executable).href) + '); console.log("inert-import");',
    ],
    { cwd: temporary, timeoutMs: 30000 },
  );
  expect(imported.status, imported.stderr).toBe(0);
  expect(imported.stdout.trim()).toBe('inert-import');
  expect(imported.stderr).not.toContain('IA-DIST-INPUT-INVALID');
  const help = await runBounded(process.execPath, [executable, '--help'], { cwd: temporary, timeoutMs: 30000 });
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('ia-distribution');
  const refused = await runBounded(process.execPath, [executable, 'not-a-command'], {
    cwd: temporary,
    timeoutMs: 30000,
  });
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stderr)).toMatchObject({ status: 'refused', code: 'IA-DIST-INPUT-INVALID' });
});
