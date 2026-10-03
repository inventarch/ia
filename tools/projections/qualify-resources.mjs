// Build first. This qualification installs emitted packages in a disposable consumer.
import '../temp/physical-temp.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readInputs } from '../../packages/db/dist/index.js';

const root = resolve(import.meta.dirname, '../..'),
  pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm resources:qualify');
const temporary = mkdtempSync(resolve(tmpdir(), 'ia-packed-resources-'));
const run = (args, cwd) => execFileSync(process.execPath, [pnpm, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const folders = [
  'packages/language',
  'packages/graph',
  'packages/compliance',
  'packages/db',
  'packages/runtime',
  '.ia/src/systems/session-system',
  '.ia/src/systems/agent-system',
  '.ia/src/systems/agent-composition-system',
];
folders.push('.ia/src/systems/template-system', '.ia/src/systems/authoring-system');
try {
  const archives = resolve(temporary, 'archives');
  mkdirSync(archives);
  const dependencies = {},
    packageDigests = {};
  for (const folder of folders) {
    const path = resolve(root, folder),
      manifest = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
    run(['pack', '--pack-destination', archives], path);
    const archive = resolve(
      archives,
      manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz',
    );
    dependencies[manifest.name] = 'file:' + archive.replaceAll('\\', '/');
    packageDigests[manifest.name] = createHash('sha256').update(readFileSync(archive)).digest('hex');
  }
  const consumer = resolve(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'independent-resource-consumer',
        private: true,
        type: 'module',
        dependencies,
        pnpm: { overrides: dependencies },
      },
      null,
      2,
    ),
  );
  run(['install', '--prefer-offline', '--ignore-scripts'], consumer);
  for (const source of readInputs(root, { adopted: [] }).sources) {
    if (source.path.startsWith('.ia/src/floor/')) continue;
    const target = resolve(consumer, 'fixture', 'foundation', source.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.text);
  }
  writeFileSync(
    resolve(consumer, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { open } from '@inventarch/db';
import { adoptWorkspace, captureWorkspace } from '@inventarch/agent-composition-system';
import { captureResources, resourceOccurrences, resolveResources, verifyResources } from '@inventarch/agent-composition-system/resources';
const foundation = resolve('fixture/foundation'), project = resolve('fixture/project'); mkdirSync(project);
const adopted = [adoptWorkspace(foundation, 'foundation')], capture = captureWorkspace(project, 'project', { adopted });
const owner = resourceOccurrences(capture).occurrences.find(o => o.identity.endsWith('/system/agent-system')); assert.ok(owner);
const key = {source:owner.source, revision:owner.revision, path:'references/guide.md'}, content = '# Inert packaged guide\\n';
mkdirSync(resolve(foundation, 'references')); writeFileSync(resolve(foundation, key.path), content);
const captured = captureResources(capture, {roots:[{source:key.source,revision:key.revision,root:foundation}],files:[{key,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),mediaType:'text/markdown',encoding:'utf8'}],associations:[{owner,resources:[{key,role:'guide',order:0,required:true,delivery:'installed-reference'}]}]});
assert.deepEqual(verifyResources(JSON.stringify(captured), capture), captured);
const reader = open(project, {cache:false, adopted});
try {
  const options = {reader,within:reader.resolveScope({identities:[owner.identity]}).token,owners:[owner],allowedResources:[key],expectedDigest:captured.digest,maxBytes:4096};
  const result = resolveResources(captured, capture, options); assert.equal(result.items.length, 1);
  assert.throws(() => resolveResources(captured, capture, {...options,allowedResources:[]}));
  const item = result.items[0], target = resolve('artifact', item.reference); mkdirSync(dirname(target), {recursive:true}); writeFileSync(target, Buffer.from(item.file.content, item.file.encoding));
  cpSync('artifact', 'relocated', {recursive:true}); assert.equal(readFileSync(resolve('relocated', item.reference), 'utf8'), content);
  console.log(JSON.stringify({packedResources:true,nativeCaptureRevision:capture.revision,resourcesDigest:captured.digest,files:captured.files.length,relocated:true}));
} finally { reader.close(); }
`,
  );
  const output = execFileSync(process.execPath, ['verify.mjs'], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.match(output, /"packedResources":true/);
  console.log(output.trim());
  console.log(JSON.stringify({ node: process.version, platform: process.platform, packageDigests }));
  console.log(
    `${folders.length} emitted packages installed outside the checkout; public resource capture, verification, scoped refusal and relocation passed.`,
  );
} finally {
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(resolve(tmpdir(), 'ia-packed-resources-')))
    throw new Error('Unsafe qualification cleanup');
  rmSync(temporary, { recursive: true, force: true });
}
