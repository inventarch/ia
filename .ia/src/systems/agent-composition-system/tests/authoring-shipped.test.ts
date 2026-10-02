import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openLocalAuthoringView } from '../src/authoring-manifest.js';
import {
  resolveAuthoring,
  prepareAuthoringTarget,
  pageAuthoringCatalogue,
  reconcileAuthoringCatalogue,
} from '../src/authoring.js';

it('resolves every shipped guide and actual system with complete catalogue paging', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const local = openLocalAuthoringView({
    root,
    id: 'shipped',
    adopted: [],
    manifests: [{ source: 'self', root }],
    scope: { root: '.', identities: null },
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
    expect(view.guides).toHaveLength(43);
    expect(view.guides.filter((g) => g.status !== 'resolved')).toEqual([]);
    expect(view.systems).toHaveLength(12);
    expect(view.systems.filter((s) => s.status !== 'resolved')).toEqual([]);
    expect(view.systems.find((s) => s.name === 'taxonomy')?.parts.length).toBeGreaterThan(0);
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = pageAuthoringCatalogue(view, { cursor, limit: 11 });
      pages.push(page);
      cursor = page.next;
    } while (cursor);
    expect(reconcileAuthoringCatalogue(view, pages).complete).toBe(true);
    for (const guide of view.guides) {
      const required = prepareAuthoringTarget(view, {
        target: { kind: 'word', word: guide.word },
        document: null,
        lifecycle: null,
      });
      expect(required.missing, guide.key).toEqual([]);
      expect(required.parts.length).toBeGreaterThanOrEqual(3);
    }
  } finally {
    local.close();
  }
}, 30_000);
