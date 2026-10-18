import { ensureQualification, installConsumer } from './consumer.mjs';
import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { packageManagerCommand } from '../entry/package-manager.mjs';
import { containedFile } from '../shared/paths.mjs';
const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env.npm_execpath;
if (!pnpm) throw Error('Run through pnpm kb:qualify');
let values;
try {
  ({ values } = parseArgs({
    options: { artifacts: { type: 'string' }, manifest: { type: 'string' }, output: { type: 'string' } },
  }));
  assert(!(values.artifacts && values.manifest), 'Choose --artifacts or --manifest');
} catch (error) {
  console.error(String(error));
  process.exit(2);
}
const selected = ensureQualification(
  root,
  pnpm,
  values.manifest ?? (values.artifacts ? resolve(values.artifacts, 'qualification.json') : undefined),
);
const temporaryRoot = realpathSync(tmpdir());
const temporary = mkdtempSync(join(temporaryRoot, 'ia-kb-installed-')),
  identity = lstatSync(temporary),
  consumer = join(temporary, 'consumer with spaces'),
  home = join(temporary, 'home'),
  workspace = join(temporary, 'unrelated repository');
try {
  for (const path of [consumer, home]) mkdirSync(path);
  const files = selected.packed.map((row) => row.filename);
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    NODE_AUTH_TOKEN: '',
    NPM_TOKEN: '',
    IA_HOME: join(home, 'ia'),
    IA_HOST_HOME: join(home, 'ia'),
    IA_CONFIG_HOME: join(home, 'config'),
    IA_NO_UPDATE_CHECK: '1',
    IA_REGISTRY: '',
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
  };
  writeFileSync(join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  installConsumer(consumer, selected.packed, pnpm, { name: 'kb-installed-qualification' });
  const cli = join(consumer, 'node_modules/@inventarch/cli/dist/main.js'),
    mcp = join(consumer, 'node_modules/@inventarch/mcp-door/dist/main.js');
  writeFileSync(
    join(consumer, 'offline.mjs'),
    "globalThis.fetch=()=>{throw Error('Qualification network refused')};\n",
  );
  const invoke = (args, exit = 0) => {
    const run = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(consumer, 'offline.mjs')).href, cli, ...args],
      {
        cwd: consumer,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.ifError(run.error);
    assert.equal(run.status, exit, run.stdout + '\n' + run.stderr);
    return JSON.parse(run.stdout);
  };
  invoke(['init', workspace, '--host', 'none', '--apply', '--yes', '--json']);
  for (const path of ['.kb', 'package.json', 'node_modules']) assert.equal(existsSync(join(workspace, path)), false);
  mkdirSync(join(workspace, 'docs'));
  const id = 'work-system/contract/spec/portable-knowledge';
  writeFileSync(
    join(workspace, '.ia/src/knowledge.ia'),
    '#! ia 1.0\n@spec portable-knowledge\n  meaning\n    says "A portable documentation example."\n  work\n    title "Portable knowledge"\n    status draft\n    source "docs/architecture.md"\n',
  );
  const body = '# Architecture\n\nEvidence stays beside the source.\n';
  writeFileSync(join(workspace, 'docs/architecture.md'), body);
  writeFileSync(
    join(workspace, '.ia/knowledge.json'),
    JSON.stringify({
      format: 'ia.kb.selection.v1',
      sourceId: 'example',
      records: [id],
      resources: ['docs/architecture.md'],
    }),
  );
  const kb = (args) => invoke(['kb', ...args, '--root', workspace, '--json']);
  const beforeTree = () =>
    readdirSync(workspace, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const path = join(d.parentPath, d.name);
        return [path, createHash('sha256').update(readFileSync(path)).digest('hex')];
      })
      .sort(([a], [b]) => a.localeCompare(b));
  const before = beforeTree();
  assert.equal(kb(['check']).ok, true);
  const read = kb(['read', id]);
  assert.equal(read.value.body, body);
  assert.equal(kb(['search', 'Evidence stays']).value.results[0].identity, id);
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'qualification', version: '1' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ia_kb_read', arguments: { locator: id } } },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ia_kb_search', arguments: { query: 'Evidence stays' } },
    },
  ];
  const rpc = execFileSync(
    process.execPath,
    ['--import', pathToFileURL(join(consumer, 'offline.mjs')).href, mcp, '--root', workspace],
    {
      cwd: consumer,
      env,
      input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(rpc.find((m) => m.id === 2).result.structuredContent, read);
  assert.equal(rpc.find((m) => m.id === 3).result.structuredContent.value.results[0].identity, id);
  assert.deepEqual(beforeTree(), before, 'Read-only commands changed repository bytes');
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=' + join(temporary, 'disabled-hooks'),
        '-c',
        'commit.gpgsign=false',
        '-C',
        workspace,
        ...args,
      ],
      { env, encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', '--', '.ia/src', '.ia/knowledge.json', 'docs/architecture.md');
  git(
    '-c',
    'user.name=Qualification',
    '-c',
    'user.email=qualification@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Portable knowledge',
  );
  const commit = git('rev-parse', 'HEAD'),
    output = join(workspace, 'knowledge.json'),
    pack = ['pack', '--commit', commit, '--selection', '.ia/knowledge.json', '--out', output];
  assert.equal(kb(pack).value.applied, false);
  assert.equal(existsSync(output), false);
  assert.equal(kb([...pack, '--apply', '--yes']).value.applied, true);
  assert.equal(kb([...pack, '--apply', '--yes']).value.unchanged, true);
  const verify =
    "import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import{foundationFromWorkspace,validatePackage,openKnowledgeView}from'@inventarch/kb';const v=openKnowledgeView(validatePackage(JSON.parse(readFileSync(process.argv[3],'utf8')),foundationFromWorkspace(process.argv[2])));try{assert.equal(v.search('Evidence stays').results.length,1);assert.equal(v.read('work-system/contract/spec/portable-knowledge').body,'# Architecture\\n\\nEvidence stays beside the source.\\n');}finally{v.close();}";
  writeFileSync(join(consumer, 'verify.mjs'), verify);
  execFileSync(process.execPath, [join(consumer, 'verify.mjs'), workspace, output], {
    cwd: consumer,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120000,
  });
  assert.equal(existsSync(join(workspace, '.kb')), false);
  const report = {
    format: 'ia.kb.qualification.v1',
    platform: process.platform,
    node: process.version,
    workspace,
    consumer,
    package: output,
    artifacts: files.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
    checks: [
      'non-node repository',
      'no .kb',
      'document-body search',
      'CLI/MCP parity',
      'read immutability',
      'committed pack preview/apply',
      'no overwrite',
      'installed import',
    ],
  };
  const reportPath = values.output ? resolve(values.output) : join(temporary, 'qualification.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, report: reportPath, temporary }));
} catch (error) {
  assert.equal(dirname(temporary), temporaryRoot);
  assert(basename(temporary).startsWith('ia-kb-installed-'));
  containedFile(temporary, 'cleanup-probe', { allowMissing: true });
  const current = lstatSync(temporary);
  assert(current.ino === identity.ino && current.dev === identity.dev, 'KB output changed before cleanup');
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  throw error;
}
