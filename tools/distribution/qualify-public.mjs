import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const draft = {
  path: '.ia/src/systems/agent-system/records/example-draft.ia',
  text: '#! ia 1.0\n\n@agent example-draft\n  meaning\n    says "A neutral draft."\n    answers "Which agent?"\n  governance\n    applies []\n',
};
for (const operation of ['validate-ia', 'format-ia']) {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--conditions=development',
        '--import',
        'tsx',
        'tools/systems/run.ts',
        '--operation',
        operation,
        '--input',
        JSON.stringify(draft),
        '--root',
        root,
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}
const base = resolve(root, '.ia/src/systems/agent-composition-system/dist');
const { openLocalAuthoringView } = await import(pathToFileURL(resolve(base, 'authoring-manifest.js')).href);
const { resolveAuthoring, closeAuthoringView } = await import(pathToFileURL(resolve(base, 'authoring.js')).href);
const { renderHostArtifacts } = await import(
  pathToFileURL(resolve(root, 'packages/compliance/dist/projections.js')).href
);
const vocabulary = JSON.parse(readFileSync(resolve(root, 'docs/reference/language/vocabulary.json'), 'utf8'));
const resources = JSON.parse(readFileSync(resolve(root, '.ia/authoring.resources.json'), 'utf8'));
const local = openLocalAuthoringView({
  root,
  id: 'public',
  adopted: [],
  manifests: [{ source: 'self', root }],
  scope: { root: '.ia', identities: null },
});
let view;
try {
  const records = [...local.reader.inspect().graph.nodes.values()];
  assert.ok(records.length > 0);
  const projected = renderHostArtifacts(records, local.reader.revision);
  assert.equal(projected.assessment.outcome, 'pass');
  assert.ok(projected.artifacts.length > 0);
  assert.equal(renderHostArtifacts(records, '').assessment.outcome, 'fail');
  view = resolveAuthoring(local.capture, local.resources, local.index, {
    reader: local.reader,
    within: local.within,
    allowedResources: local.resources.files.map((file) => file.key),
    allowedSystems: local.systems,
    allowedRegistrations: local.registrations,
    allowedArtifacts: [],
    allowedDocuments: [],
  });
  assert.equal(view.guides.length, vocabulary.words.length);
  assert.equal(view.systems.length, resources.index.systems.length);
  assert.deepEqual(
    view.guides.filter((guide) => guide.status !== 'resolved'),
    [],
  );
  assert.deepEqual(
    view.systems.filter((system) => system.status !== 'resolved'),
    [],
  );
  console.log(
    `Verified ${records.length} public records, ${view.guides.length} guides, ${view.systems.length} systems and ${projected.artifacts.length} host artifacts.`,
  );
} finally {
  if (view) closeAuthoringView(view);
  local.close();
}
