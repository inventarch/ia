import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openLocalAuthoringView } from '@inventarch/workspace-runtime/authoring-manifest';
import { prepareAuthoringTarget, resolveAuthoring } from '@inventarch/workspace-runtime/authoring';
import { checkNative, readNative } from '../native/check.js';

const root = resolve(import.meta.dirname, '../..');
const guidePath = '.ia/src/systems/authoring-system/records/public-guides.ia';

it('ships an admitted self-describing guide and real document for every winning vocabulary registration', () => {
  const { inputs, folders } = readNative(root),
    result = checkNative(inputs, folders);
  expect(result.registry.registrations.get('authoring-guide')).toMatchObject({
    system: 'authoring-system',
    kind: 'definition',
    category: 'representation',
    schema: 'authoring-guide',
  });
  expect(result.ok, JSON.stringify([...result.diagnostics, ...result.assessments.flatMap((a) => a.findings)])).toBe(
    true,
  );
  const guides = result.records.filter((r) => r.discriminator === 'authoring-guide');
  expect(guides).toHaveLength(result.registry.registrations.size);
  const field = (record: (typeof guides)[number], section: string, key: string): unknown =>
    record.sections.find((s) => s.name === section)?.fields.find((f) => 'key' in f && f.key === key);
  for (const [word, registration] of result.registry.registrations) {
    const matches = guides.filter((r) => r.name === `public-${registration.system}-${word}`);
    expect(matches, word).toHaveLength(1);
    const guide = matches[0]!;
    expect(guide.system).toBe('authoring-system');
    expect(field(guide, 'reference', 'owner')).toMatchObject({ value: { text: registration.system } });
    expect(field(guide, 'reference', 'word')).toMatchObject({ value: { text: word } });
    const document = field(guide, 'reference', 'document') as { value: { text: string } };
    expect(document.value.text).toMatch(/^\.ia\/src\/.+\.md$/);
    const content = readFileSync(resolve(root, document.value.text), 'utf8');
    expect(content).toContain('Canonical schema:');
    expect(content).toContain('@' + word);
    expect(field(guide, 'reference', 'schema')).toBeDefined();
    expect(guide.edges).toHaveLength(1);
  }
});

it('refuses a native guide missing its required primary document field', () => {
  const { inputs, folders } = readNative(root),
    source = inputs.find((i) => i.path === guidePath);
  expect(source).toBeDefined();
  const text = source!.text.replace(/^    document .+\n/m, '');
  expect(text).not.toBe(source!.text);
  const result = checkNative(
    inputs.map((i) => (i === source ? { ...i, text } : i)),
    folders,
  );
  expect(result.ok).toBe(false);
  expect(result.assessments.flatMap((a) => a.findings)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'IA-COMP-FIELD-MISSING', path: guidePath })]),
  );
});

it('resolves the shipped native library, zero-word systems and actual shared document parts', () => {
  const local = openLocalAuthoringView({
    root,
    id: 'foundation',
    adopted: [],
    manifests: [{ source: 'self', root }],
    scope: { root: '', identities: null },
  });
  try {
    const view = resolveAuthoring(local.capture, local.resources, local.index, {
      reader: local.reader,
      within: local.within,
      allowedResources: local.resources.files.map((f) => f.key),
      allowedSystems: local.systems,
      allowedRegistrations: local.registrations,
      allowedArtifacts: local.index.artifacts.map((a) => a.id),
      allowedDocuments: local.index.documents.map((d) => d.id),
    });
    expect(view.catalogue.complete).toBe(true);
    expect(view.guides).toHaveLength(44);
    expect(view.guides.filter((g) => g.status !== 'resolved')).toEqual([]);
    expect(view.systems).toHaveLength(12);
    expect(view.systems.filter((s) => s.status !== 'resolved')).toEqual([]);
    expect(view.systems.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'taxonomy',
        'agent-system',
        'compliance-system',
        'workspace-system',
        'governance-system',
        'session-system',
        'authoring-system',
        'agent-composition-system',
        'template-system',
        'hook-authoring-system',
        'learning-system',
        'work-system',
      ]),
    );
    expect(view.documents).toHaveLength(0);
    expect(view.artifacts).toHaveLength(0);
    const prepared = prepareAuthoringTarget(view, {
      target: { kind: 'word', word: 'capability' },
      document: null,
      lifecycle: null,
    });
    expect(prepared.missing).toEqual([]);
    expect(prepared.parts.some((p) => p.text.includes('@schema capability'))).toBe(true);
    expect(prepared.parts.some((p) => p.text.includes('Canonical schema:'))).toBe(true);
    expect(prepared.expectedOutputs).toEqual([]);
    expect(prepared.criteria.filter((c) => c.basis === 'semantic').every((c) => c.status === 'not-evaluated')).toBe(
      true,
    );
  } finally {
    local.close();
  }
});
