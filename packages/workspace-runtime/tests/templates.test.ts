import { createSystemFixture } from '../../../tools/systems/fixture.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import type { CompiledRecord } from '@inventarch/language';
import { adoptWorkspace, captureWorkspace } from '../src/index.js';
import { captureResources, resourceOccurrences } from '../src/resources.js';
import { renderCapturedTemplate } from '../src/templates.js';
import { metadataDigest, sha256 } from '../src/resource-format.js';
import type { CapturedTemplateOptions } from '../src/templates.js';

// Cases rebuild adopted native views and captured resources on disk.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  temporary = mkdtempSync(join(tmpdir(), 'ia-templates-')),
  handles: Handle[] = [];
const source = adoptWorkspace(repository, 'foundation'),
  systems = [
    '.ia/src/systems/workspace-system/records/system-packages.ia',
    '.ia/src/floor/artifact-set.ia',
    '.ia/src/floor/axis.ia',
    '.ia/src/floor/cardinality.ia',
    '.ia/src/floor/category.ia',
    '.ia/src/floor/dimension.ia',
    '.ia/src/floor/floor.schema.ia',
    '.ia/src/floor/intent-shape.ia',
    '.ia/src/floor/kernel.schema.ia',
    '.ia/src/floor/kind.ia',
    '.ia/src/floor/lane.ia',
    '.ia/src/floor/move.ia',
    '.ia/src/floor/phase.ia',
    '.ia/src/floor/placement.ia',
    '.ia/src/floor/predicate.ia',
    '.ia/src/floor/primitive.ia',
    '.ia/src/floor/taxonomy.system.ia',
    '.ia/src/floor/value-type.ia',
    '.ia/src/systems/agent-system/system.ia',
    '.ia/src/systems/agent-system/schemas/agent.schema.ia',
    '.ia/src/systems/agent-system/schemas/mandate.schema.ia',
    '.ia/src/systems/compliance-system/system.ia',
    '.ia/src/systems/compliance-system/schemas/case.schema.ia',
    '.ia/src/systems/compliance-system/schemas/check.schema.ia',
    '.ia/src/systems/compliance-system/schemas/contract.schema.ia',
    '.ia/src/systems/workspace-system/system.ia',
    '.ia/src/systems/workspace-system/schemas/distribution.schema.ia',
    '.ia/src/systems/workspace-system/schemas/workspace.schema.ia',
    '.ia/src/systems/governance-system/system.ia',
    '.ia/src/systems/governance-system/schemas/convention.schema.ia',
    '.ia/src/systems/governance-system/schemas/law.schema.ia',
    '.ia/src/systems/governance-system/schemas/playbook.schema.ia',
    '.ia/src/systems/governance-system/schemas/principle.schema.ia',
    '.ia/src/systems/session-system/system.ia',
    '.ia/src/systems/session-system/schemas/run.schema.ia',
    '.ia/src/systems/authoring-system/system.ia',
    '.ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia',
    '.ia/src/systems/authoring-system/schemas/operation.schema.ia',
    '.ia/src/systems/agent-composition-system/system.ia',
    '.ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/capability.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/harness.schema.ia',
    '.ia/src/systems/agent-composition-system/schemas/voice.schema.ia',
    '.ia/src/systems/template-system/system.ia',
    '.ia/src/systems/template-system/schemas/template.schema.ia',
    '.ia/src/systems/hook-authoring-system/system.ia',
    '.ia/src/systems/hook-authoring-system/schemas/hook.schema.ia',
    '.ia/src/systems/learning-system/system.ia',
    '.ia/src/systems/learning-system/schemas/improvement.schema.ia',
    '.ia/src/systems/learning-system/schemas/observation.schema.ia',
    '.ia/src/systems/work-system/system.ia',
    '.ia/src/systems/work-system/schemas/decision.schema.ia',
    '.ia/src/systems/work-system/schemas/milestone.schema.ia',
    '.ia/src/systems/work-system/schemas/plan.schema.ia',
    '.ia/src/systems/work-system/schemas/task.schema.ia',
    '.ia/src/systems/work-system/schemas/spec.schema.ia',
    '.ia/src/systems/agent-composition-system/records/composition.ia',
    '.ia/src/systems/workspace-system/records/quality.ia',
    '.ia/src/systems/workspace-system/records/architecture.ia',
    '.ia/src/systems/learning-system/records/evidence.ia',
    '.ia/src/systems/workspace-system/records/language.ia',
    '.ia/src/systems/work-system/records/work.ia',
    '.ia/src/systems/authoring-system/operations/validate-ia.ia',
    '.ia/src/systems/authoring-system/operations/format-ia.ia',
    '.ia/src/systems/template-system/operations/render-template.ia',
    '.ia/src/systems/workspace-system/records/repository-distribution.ia',
  ];
const sources = source.sources.filter((s) => systems.includes(s.path));
const foundation = { ...source, sources, revision: metadataDigest(sources) };
const tree = {
  format: 'ia.structured-template.v1',
  inputs: { title: { type: 'text', required: true } },
  nodes: [
    { kind: 'text', text: '# ' },
    { kind: 'value', input: 'title' },
    { kind: 'text', text: '\n' },
  ],
};
let sequence = 0;
function setup(
  filename = 'docs/design.md',
  resourceText = JSON.stringify(tree),
  profile = 'structured-v1',
  authored = false,
) {
  const base = join(temporary, String(sequence++)),
    project = join(base, 'project'),
    fixture = authored ? project : join(base, 'fixture');
  cpSync(join(repository, 'tools/projections/fixtures/synthetic-review'), fixture, { recursive: true });
  if (!authored) mkdirSync(project);
  const declaration = join(fixture, '.ia/src/systems/fictional-review-system/system.ia');
  writeFileSync(
    declaration,
    readFileSync(declaration, 'utf8').replace('    - agent-system', '    - agent-system\n    - template-system'),
  );
  writeFileSync(
    join(fixture, '.ia/src/systems/fictional-review-system/template.ia'),
    `#! ia 1.0\n\n@template structured-document\n  meaning\n    says "Produce an original fixture document."\n    answers "What is rendered?"\n  template\n    filename "${filename}"\n    parameters []\n    lines []\n    profile ${profile}\n    resource "templates/document.json"\n`,
  );
  mkdirSync(join(fixture, 'templates'));
  writeFileSync(join(fixture, 'templates/document.json'), resourceText);
  const adopted = authored ? [foundation] : [foundation, adoptWorkspace(fixture, 'fixture')],
    capture = captureWorkspace(project, 'project', { adopted }),
    inventory = resourceOccurrences(capture);
  const owner = inventory.occurrences.find((o) => o.identity.endsWith('/structured-document'))!;
  const key = { source: owner.source, revision: owner.revision, path: 'templates/document.json' };
  const resources = captureResources(capture, {
    roots: [{ source: owner.source, revision: owner.revision, root: fixture }],
    files: [
      {
        key,
        bytes: Buffer.byteLength(resourceText),
        sha256: sha256(resourceText),
        mediaType: 'application/json',
        encoding: 'utf8',
      },
    ],
    associations: [
      { owner, resources: [{ key, role: 'template', required: true, order: 0, delivery: 'installed-reference' }] },
    ],
  });
  const reader = open(project, { cache: false, adopted });
  handles.push(reader);
  expect(reader.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const options: CapturedTemplateOptions = {
    reader,
    within: reader.resolveScope().token,
    owner,
    allowedResources: [key],
    expectedResourcesDigest: resources.digest,
    values: { title: 'Fixture design' },
  };
  return { capture, resources, options, reader, project };
}
let fixture: ReturnType<typeof setup>;
beforeAll(() => {
  fixture = setup();
}, 30000);
afterAll(() => {
  handles.forEach((h) => h.close());
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-templates-'))
    throw new Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

it('renders an exact adopted template/resource through current scope with deterministic pins', () => {
  const result = renderCapturedTemplate(fixture.capture, fixture.resources, fixture.options);
  expect(result).toMatchObject({
    status: 'rendered',
    profile: 'structured-v1',
    artifact: { path: 'docs/design.md', text: '# Fixture design\n', bytes: 17 },
  });
  expect(
    renderCapturedTemplate(fixture.capture, JSON.stringify(fixture.resources), {
      ...fixture.options,
      values: '{"title":"Fixture design"}',
    }),
  ).toEqual(result);
});
it('runs every template-system case this file evaluates and matches its declared code', () => {
  const evaluator = '.ia/src/systems/agent-composition-system/tests/templates.test.ts';
  const scenario = (record: CompiledRecord, key: string): string | undefined => {
    const row = record.sections
      .filter((s) => s.name === 'scenario')
      .flatMap((s) => s.fields)
      .find((f) => 'key' in f && f.key === key);
    return row !== undefined && 'value' in row && 'text' in row.value ? row.value.text : undefined;
  };
  const run: Record<string, () => ReturnType<typeof renderCapturedTemplate>> = {
    'render-captured-template-success': () =>
      renderCapturedTemplate(fixture.capture, fixture.resources, fixture.options),
    'render-captured-template-refusal': () =>
      renderCapturedTemplate(fixture.capture, fixture.resources, { ...fixture.options, values: '{}' }),
    'render-captured-template-unpermitted': () =>
      renderCapturedTemplate(fixture.capture, fixture.resources, { ...fixture.options, allowedResources: [] }),
  };
  const nativeFixture = createSystemFixture(repository);
  const reader = open(nativeFixture.root, { cache: false });
  handles.push(reader);
  nativeFixture.close();
  const cases = reader
    .records()
    .filter(
      (r) =>
        r.discriminator === 'case' &&
        r.source.path.startsWith('.ia/src/systems/template-system/') &&
        scenario(r, 'evaluator') === evaluator,
    );
  expect(cases.map((r) => r.name).sort()).toEqual(Object.keys(run).sort());
  for (const row of cases) {
    const result = run[row.name]!(),
      observed = result.status === 'rendered' ? 'pass' : result.code;
    expect(result.status, row.name).toBe(scenario(row, 'kind') === 'success' ? 'rendered' : 'refused');
    expect(observed, row.name).toBe(scenario(row, 'code'));
    if (row.name === 'render-captured-template-success')
      expect(result).toMatchObject({ artifact: { path: 'docs/design.md', text: '# Fixture design\n', bytes: 17 } });
  }
});
it('requires both native scope and independent resource permission', () => {
  const hidden = fixture.reader.resolveScope({ identities: [] }).token;
  for (const change of [
    { within: hidden },
    { within: 'forged' },
    { within: '' },
    { allowedResources: [] },
    { expectedResourcesDigest: 'f'.repeat(64) },
    { owner: { ...fixture.options.owner, source: 'other' } },
  ]) {
    expect(renderCapturedTemplate(fixture.capture, fixture.resources, { ...fixture.options, ...change })).toMatchObject(
      { status: 'refused' },
    );
  }
});
it('refuses duplicate JSON fields in values and captured template bodies', () => {
  expect(
    renderCapturedTemplate(fixture.capture, fixture.resources, {
      ...fixture.options,
      values: '{"title":"one","title":"two"}',
    }),
  ).toMatchObject({ status: 'refused' });
  const f = setup('docs/test.md', JSON.stringify(tree).replace('"format":', '"format":"wrong","format":'));
  expect(renderCapturedTemplate(f.capture, f.resources, f.options)).toMatchObject({ status: 'refused' });
});
it('refuses unavailable profiles and unvalidated output syntax', () => {
  for (const f of [setup('docs/test.md', JSON.stringify(tree), 'future-v9'), setup('docs/test.html')])
    expect(renderCapturedTemplate(f.capture, f.resources, f.options)).toMatchObject({ status: 'refused' });
});
it('validates JSON output and refuses malformed JSON without artifacts', () => {
  const f = setup(
    'deploy.json',
    JSON.stringify({
      ...tree,
      nodes: [
        { kind: 'text', text: '{"release":' },
        { kind: 'value', input: 'title' },
        { kind: 'text', text: '}' },
      ],
    }),
  );
  expect(renderCapturedTemplate(f.capture, f.resources, { ...f.options, values: { title: 'true' } })).toMatchObject({
    status: 'rendered',
    artifact: { text: '{"release":true}' },
  });
  expect(renderCapturedTemplate(f.capture, f.resources, { ...f.options, values: { title: 'broken' } })).toMatchObject({
    status: 'refused',
  });
});
it('refuses stale scopes after source refresh', () => {
  const f = setup();
  mkdirSync(join(f.project, '.ia/src'), { recursive: true });
  writeFileSync(join(f.project, '.ia/src/change.ia'), '#! ia 1.0\n# changed\n');
  f.reader.refresh();
  expect(renderCapturedTemplate(f.capture, f.resources, f.options)).toMatchObject({ status: 'refused' });
});
it('contextually validates authored IA drafts and refuses narrow-scope probes without writes', () => {
  const native =
    '#! ia 1.0\n\n@capability template-output\n  meaning\n    says "{{title}}"\n    answers "What is produced?"\n  execution\n    effects [read]\n';
  const nodes = [
    { kind: 'text', text: native.split('{{title}}')[0] },
    { kind: 'value', input: 'title' },
    { kind: 'text', text: native.split('{{title}}')[1] },
  ];
  const f = setup(
    '.ia/src/systems/fictional-review-system/draft.ia',
    JSON.stringify({ ...tree, nodes }),
    'structured-v1',
    true,
  );
  const rendered = renderCapturedTemplate(f.capture, f.resources, f.options);
  expect(rendered, JSON.stringify(rendered)).toMatchObject({ status: 'rendered' });
  expect(f.reader.records().some((r) => r.name === 'template-output')).toBe(false);
  expect(
    renderCapturedTemplate(f.capture, f.resources, { ...f.options, values: { title: '"\n  invalid true\n"' } }),
  ).toMatchObject({ status: 'refused' });
  const within = f.reader.resolveScope({ identities: [f.options.owner.identity] }).token;
  expect(renderCapturedTemplate(f.capture, f.resources, { ...f.options, within })).toMatchObject({ status: 'refused' });
});
