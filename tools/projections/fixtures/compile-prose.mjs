// Runs from an isolated consumer. Imports only public installed packages and the link walk copied beside it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { open } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import { adoptWorkspace, captureWorkspace, installedImplementationDigest } from '@inventarch/agent-composition-system';
import { captureResources, resourceOccurrences } from '@inventarch/agent-composition-system/resources';
import {
  claudeProseCatalog,
  codexProseCatalog,
  compileProjection,
  serializeProjection,
} from '@inventarch/agent-composition-system/projections';
// The shared link rule, copied beside this script; external and fragment-only links name no product file.
import { linkCounts, linkProblems } from './link-walk.mjs';
const walkLinks = (host, product, directory, files) => {
  assert.deepEqual(
    linkProblems(resolve(directory), files),
    [],
    `${host} ${product}: every local link must reach a regular file inside the written product`,
  );
  console.log(JSON.stringify({ packedLinks: true, host, product, ...linkCounts(files) }));
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => hash(stableSerialize(value));
const root = resolve('fixture/project'),
  source = resolve('fixture/synthetic-review');
mkdirSync(root);
const adopted = [adoptWorkspace(resolve('fixture/foundation'), 'foundation'), adoptWorkspace(source, 'review')];
const admission = open(root, { cache: false, adopted });
try {
  assert.deepEqual(
    admission.report.findings.filter((f) => f.severity === 'error'),
    [],
    'Explicit prose fixture dependency closure must be admitted before resolving projection owners',
  );
} finally {
  admission.close();
}
const capture = captureWorkspace(root, 'project', { adopted }),
  inventory = resourceOccurrences(capture);
const owner = (name) => {
  const found = inventory.occurrences.find((o) => o.identity.endsWith('/' + name));
  assert.ok(found, 'Missing admitted fixture owner: ' + name);
  return found;
};
const capability = owner('fictional-review');
const files = ['references/review-guide.md', 'references/examples/note.md'].map((path) => {
  const bytes = readFileSync(resolve(source, path));
  return {
    key: { source: capability.source, revision: capability.revision, path },
    bytes: bytes.length,
    sha256: hash(bytes),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  };
});
const uses = files.map((f, index) => ({
  key: f.key,
  role: index ? 'example' : 'body',
  order: 0,
  required: true,
  delivery: index ? 'installed-reference' : 'inline',
}));
const resources = captureResources(capture, {
  roots: [{ source: capability.source, revision: capability.revision, root: source }],
  files,
  associations: [
    { owner: capability, resources: uses },
    { owner: owner('fictional-review-method'), resources: uses },
  ],
});
const catalog = claudeProseCatalog(installedImplementationDigest(), {
  models: [{ id: 'inherit', name: 'inherit' }],
  tools: [{ id: 'read', name: 'Read' }],
  inputFields: [{ name: 'topic', type: 'text' }],
});
const common = {
  profile: catalog.profile.id,
  required: true,
  description: 'Review fictional notes with source evidence.',
  requirements: [],
};
const body = {
  format: 'ia.projection-descriptor.v1',
  sourceRevisions: inventory.sourceRevisions,
  product: 'plugin',
  profiles: [catalog.profile],
  resourcesDigest: resources.digest,
  inventoryDigest: digest({ fixture: 'original-public-prose' }),
  exports: [
    {
      ...common,
      id: 'check',
      outputName: 'fictional-check',
      target: owner('fictional-review-method'),
      resources: uses,
      presentation: {
        kind: 'command',
        invocation: 'explicit',
        arguments: [{ name: 'topic', type: 'text', required: true, target: 'topic' }],
        body: [owner('fictional-review-method')],
      },
    },
    {
      ...common,
      id: 'review',
      outputName: 'fictional-review',
      target: capability,
      resources: uses,
      presentation: {
        kind: 'skill',
        invocation: 'automatic-or-explicit',
        arguments: [],
        patterns: [],
        body: [owner('fictional-review-method')],
      },
    },
    {
      ...common,
      id: 'reviewer',
      outputName: 'fictional-reviewer',
      target: owner('fictional-reviewer'),
      resources: [],
      presentation: {
        kind: 'agent',
        agent: owner('fictional-reviewer'),
        agentProfile: owner('fictional-review-profile'),
        voice: owner('fictional-concise'),
        mandate: owner('fictional-read-only'),
        model: 'inherit',
        tools: ['read'],
        delegates: [],
      },
    },
  ],
};
const descriptor = { ...body, digest: digest(body) },
  reader = open(root, { cache: false, adopted });
// Copy a product into a fresh root outside this consumer; under the shared link rule every local link must reach a
// regular file inside it, and every file must keep its recorded bytes.
const relocate = (result) => {
  // Checked before use: a throw in finally would replace a failing assertion's error.
  const target = mkdtempSync(join(tmpdir(), 'ia-packed-relocated-'));
  if (dirname(target) !== resolve(tmpdir())) throw new Error('Unsafe relocation cleanup');
  try {
    for (const file of result.files) {
      const path = join(target, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.content, file.encoding));
    }
    for (const file of result.files) assert.equal(hash(readFileSync(join(target, file.path))), file.sha256);
    assert.deepEqual(
      linkProblems(target, result.files),
      [],
      'relocated links must reach regular files inside the product',
    );
    for (const file of result.files.filter((file) => file.path.endsWith('/scripts/verify-resources.mjs'))) {
      const skillRoot = realpathSync.native(target);
      const run = spawnSync(process.execPath, [join(target, file.path), '--root', skillRoot], {
        cwd: target,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.equal(JSON.parse(run.stdout).status, 'verified');
    }
    return linkCounts(result.files).local;
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
};
// One revision-bound evidence line per product: identities, every output hash and the relocation link count.
const record = (host, product, result, selected) => {
  const relocatedLinks = relocate(result),
    { manifest } = result;
  console.log(
    JSON.stringify({
      packedEvidence: true,
      host,
      product,
      sourceRevisions: manifest.sourceRevisions,
      nativeCaptureRevision: resources.nativeCaptureRevision,
      resourcesDigest: manifest.resourcesDigest,
      inventoryDigest: manifest.inventoryDigest,
      descriptorDigest: manifest.descriptorDigest,
      implementationDigest: selected.profile.implementationDigest,
      manifestDigest: manifest.digest,
      omissions: manifest.omissions,
      enforcement: manifest.enforcement,
      outputs: manifest.outputs.map(({ path, role, bytes, sha256 }) => ({ path, role, bytes, sha256 })),
      relocatedLinks,
    }),
  );
};
if (process.argv.includes('--distribution')) {
  mkdirSync(resolve(root, '.ia'), { recursive: true });
  const bindings = adopted.map((source, index) => {
    const path = 'vendor/' + source.id;
    cpSync(resolve(index ? 'fixture/synthetic-review' : 'fixture/foundation'), resolve(root, path), {
      recursive: true,
    });
    return { id: source.id, revision: source.revision, path };
  });
  writeFileSync(resolve(root, '.ia/workspace.json'), JSON.stringify({ version: 1, adopted: bindings }));
  writeFileSync(resolve(root, 'resources.json'), JSON.stringify(resources));
  for (const product of ['workspace', 'plugin']) {
    const input = { ...body, product };
    writeFileSync(resolve(root, 'claude-' + product + '.json'), JSON.stringify({ ...input, digest: digest(input) }));
  }
}
try {
  assert.equal(reader.report.findings.filter((f) => f.severity === 'error').length, 0);
  const options = {
    reader,
    within: reader.resolveScope().token,
    allowedResources: files.map((f) => f.key),
    expectedResourcesDigest: resources.digest,
    inventoryDigest: descriptor.inventoryDigest,
    catalog,
    name: 'fictional-review',
    version: '0.1.0',
  };
  const result = compileProjection(capture, descriptor, resources, options);
  assert.equal(result.status, 'compiled', JSON.stringify(result));
  assert.deepEqual(
    serializeProjection(capture, JSON.stringify(descriptor), JSON.stringify(resources), options),
    result,
  );
  assert.equal(
    compileProjection(capture, descriptor, resources, { ...options, allowedResources: [] }).status,
    'refused',
  );
  assert.equal(result.files.length, 8);
  for (const file of result.files) {
    const target = resolve('output', file.path);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = Buffer.from(file.content, file.encoding);
    assert.equal(hash(bytes), file.sha256);
    writeFileSync(target, bytes);
  }
  walkLinks('claude', 'plugin', 'output', result.files);
  writeFileSync('projection-manifest.json', JSON.stringify(result.manifest, null, 2) + '\n');
  console.log(
    JSON.stringify({
      packedProjections: true,
      records: reader.records().length,
      outputs: result.files.length,
      manifestDigest: result.manifest.digest,
      sourceRevisions: result.manifest.sourceRevisions,
      resourcesDigest: resources.digest,
      implementationDigest: catalog.profile.implementationDigest,
    }),
  );
  record('claude', 'plugin', result, catalog);
  const workspaceBody = { ...body, product: 'workspace' },
    workspace = compileProjection(capture, { ...workspaceBody, digest: digest(workspaceBody) }, resources, options);
  assert.equal(workspace.status, 'compiled', JSON.stringify(workspace));
  assert.deepEqual(workspace.manifest.exports, result.manifest.exports);
  assert.equal(workspace.files.length, 7);
  record('claude', 'workspace', workspace, catalog);
  const codexCatalog = codexProseCatalog(catalog.profile.implementationDigest, {
    models: catalog.models,
    tools: [{ id: 'read', name: 'read' }],
    inputFields: catalog.inputFields,
  });
  for (const product of ['workspace', 'plugin']) {
    const codexBody = {
      ...body,
      product,
      profiles: [codexCatalog.profile],
      exports: body.exports.map((e) => ({ ...e, profile: codexCatalog.profile.id })),
    };
    const codexDescriptor = { ...codexBody, digest: digest(codexBody) },
      codexOptions = { ...options, catalog: codexCatalog };
    if (process.argv.includes('--distribution'))
      writeFileSync(resolve(root, 'codex-' + product + '.json'), JSON.stringify(codexDescriptor));
    const codex = compileProjection(capture, codexDescriptor, resources, codexOptions);
    assert.equal(codex.status, 'compiled', JSON.stringify(codex));
    assert.deepEqual(codex.manifest.exports, result.manifest.exports);
    assert.deepEqual(
      serializeProjection(capture, JSON.stringify(codexDescriptor), JSON.stringify(resources), codexOptions),
      codex,
    );
    assert.equal(
      compileProjection(capture, codexDescriptor, resources, { ...codexOptions, allowedResources: [] }).status,
      'refused',
    );
    assert.equal(codex.files.length, product === 'workspace' ? 12 : 15);
    for (const file of codex.files) {
      const target = resolve('codex-' + product, file.path);
      mkdirSync(dirname(target), { recursive: true });
      const bytes = Buffer.from(file.content, file.encoding);
      assert.equal(hash(bytes), file.sha256);
      writeFileSync(target, bytes);
    }
    walkLinks('codex', product, 'codex-' + product, codex.files);
    writeFileSync('codex-' + product + '-manifest.json', JSON.stringify(codex.manifest, null, 2) + '\n');
    console.log(
      JSON.stringify({
        packedCodexProjections: true,
        product,
        records: reader.records().length,
        outputs: codex.files.length,
        manifestDigest: codex.manifest.digest,
        resourcesDigest: resources.digest,
        implementationDigest: codexCatalog.profile.implementationDigest,
      }),
    );
    record('codex', product, codex, codexCatalog);
  }
} finally {
  reader.close();
}
