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
const base = resolve(root, 'packages/workspace-runtime/dist');
const { openLocalAuthoringView } = await import(pathToFileURL(resolve(base, 'authoring-manifest.js')).href);
const { resolveAuthoring, closeAuthoringView } = await import(pathToFileURL(resolve(base, 'authoring.js')).href);
// The repository projection is the runtime's position packet, rendered by its claude adapter (milestone position-packet
// task replace-renderers), with the command catalog the CLI tags.
const { renderPacket } = await import(pathToFileURL(resolve(root, 'packages/runtime/dist/packet.js')).href);
const { PACKET_MARKER, renderHost } = await import(
  pathToFileURL(resolve(root, 'packages/runtime/dist/packet-host.js')).href
);
const { packetCatalog } = await import(pathToFileURL(resolve(root, 'apps/cli/dist/commands.js')).href);
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
  const { packet, digest, hostNote } = renderPacket(local.reader, local.reader.resolveScope().token, packetCatalog());
  const projected = renderHost('claude', packet, digest, hostNote, 'repository');
  assert.deepEqual(
    projected.files.map((file) => file.path),
    ['CLAUDE.md', '.claude/skills/ia-authoring/SKILL.md', '.agents/skills/ia-authoring/SKILL.md'],
  );
  assert.ok(projected.files.every((file) => file.text.split('\n').includes(PACKET_MARKER)));
  assert.equal(projected.receipt.packetDigest, digest);
  assert.throws(() => renderHost('claude', packet, 'f'.repeat(64), hostNote, 'repository'), {
    code: 'IA-RUNTIME-REQUEST-INVALID',
  });
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
    `Verified ${records.length} public records, ${view.guides.length} guides, ${view.systems.length} systems and ${projected.files.length} host artifacts.`,
  );
} finally {
  if (view) closeAuthoringView(view);
  local.close();
}
