// Runs from an isolated consumer. Imports only public installed packages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  assert.equal(result.files.length, 6);
  for (const file of result.files) {
    const target = resolve('output', file.path);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = Buffer.from(file.content, file.encoding);
    assert.equal(hash(bytes), file.sha256);
    writeFileSync(target, bytes);
  }
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
    assert.equal(codex.files.length, product === 'workspace' ? 8 : 9);
    for (const file of codex.files) {
      const target = resolve('codex-' + product, file.path);
      mkdirSync(dirname(target), { recursive: true });
      const bytes = Buffer.from(file.content, file.encoding);
      assert.equal(hash(bytes), file.sha256);
      writeFileSync(target, bytes);
    }
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
  }
} finally {
  reader.close();
}
