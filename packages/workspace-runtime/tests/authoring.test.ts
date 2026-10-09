import { expect, it } from 'vitest';
import {
  createAuthoringIndex,
  verifyAuthoringIndex,
  resolveAuthoring,
  prepareAuthoringTarget,
} from '../src/authoring.js';
import { authoringFixture } from './authoring-fixture.js';

it('joins a typed guide to the winning registration/schema and captured document', () => {
  const f = authoringFixture();
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input);
    expect(verifyAuthoringIndex(JSON.stringify(index), f.capture, f.resources)).toEqual(index);
    const view = resolveAuthoring(f.capture, f.resources, index, f.scope);
    expect(view.guides.find((g) => g.key === 'authoring-system/note')).toMatchObject({
      status: 'resolved',
      document: { key: f.key('references/note.md') },
    });
    expect(view.systems.find((s) => s.name === 'authoring-system')).toMatchObject({
      status: 'resolved',
      teaching: 'not-evaluated',
    });
    const packet = prepareAuthoringTarget(view, { target: f.target, document: 'brief', lifecycle: null });
    expect(packet.missing).toEqual([]);
    expect(packet.parts.some((p) => p.text.includes('Explicit upstream requirement.'))).toBe(true);
    expect(packet.expectedOutputs).toEqual([
      { role: 'acceptance', reason: 'Expected after requirements are authored.' },
    ]);
    expect(packet.criteria.find((c) => c.id === 'coherence')?.status).toBe('not-evaluated');
  } finally {
    f.reader.close();
  }
});

it('does not infer a guide from an arbitrary resource role or a conditional cite', () => {
  const f = authoringFixture((text) => text.replace('cites @schema note\n', 'cites @schema note when phase is act\n'));
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input),
      view = resolveAuthoring(f.capture, f.resources, index, f.scope);
    expect(view.guides.find((g) => g.key === 'authoring-system/note')?.status).not.toBe('resolved');
    expect(
      prepareAuthoringTarget(view, { target: f.target, document: null, lifecycle: null }).missing.length,
    ).toBeGreaterThan(0);
  } finally {
    f.reader.close();
  }
});

it('hides excluded guide and functional resource bytes and rejects forged retained index pins', () => {
  const f = authoringFixture();
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input);
    expect(() => verifyAuthoringIndex({ ...index, digest: 'a'.repeat(64) }, f.capture, f.resources)).toThrow();
    const view = resolveAuthoring(f.capture, f.resources, index, {
      ...f.scope,
      allowedResources: [],
      allowedArtifacts: [],
      allowedDocuments: [],
    });
    expect(view.guides.find((g) => g.key === 'authoring-system/note')?.status).toBe('unavailable');
    expect(JSON.stringify(view)).not.toContain('Use exact requirement evidence.');
    expect(JSON.stringify(view)).not.toContain('Explicit upstream requirement.');
  } finally {
    f.reader.close();
  }
});
