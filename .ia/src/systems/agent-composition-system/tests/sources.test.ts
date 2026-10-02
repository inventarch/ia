import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stableSerialize } from '@ia/graph';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonical, digest } from '@ia/session-system';
import { resourceOccurrences } from '../src/resources.js';
import { Corpus, verifyCapture } from '../src/corpus.js';
import {
  admitSourceCapture,
  createSourcePolicy,
  homeSourceCapture,
  mountSourceCapture,
  verifySourcePolicy,
} from '../src/sources.js';

const root = mkdtempSync(resolve(tmpdir(), 'ia-source-composition-'));
const nativeDigest = (files: { path: string; text: string }[]) =>
  createHash('sha256').update(stableSerialize(files)).digest('hex');
afterAll(() => {
  if (dirname(root) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
  rmSync(root, { recursive: true, force: true });
});
it('captures a host-selected foundation and validates its retained exact policy bytes', () => {
  const policy = createSourcePolicy(root, { validator: digest('implementation') });
  expect(verifySourcePolicy(policy)).toEqual(policy);
  expect(() =>
    verifySourcePolicy({
      ...policy,
      foundation: { ...policy.foundation, sources: [{ path: '.ia/src/changed.ia', text: 'changed' }] },
    }),
  ).toThrow();
  expect(() => verifySourcePolicy({ ...policy, unexpected: true })).toThrow();
  const forged = structuredClone(policy);
  Object.assign(forged.floor[0]!.location, { provenance: 'invented-authority' });
  expect(() => verifySourcePolicy(forged)).toThrow();
  const capture = homeSourceCapture('home', [], policy);
  expect(admitSourceCapture(capture).ok).toBe(true);
});
it('preserves the explicit personal mount namespace with exact native content identity', () => {
  const policy = createSourcePolicy(root, { validator: digest('implementation') });
  const project = homeSourceCapture('project', [], policy);
  const home = homeSourceCapture(
    'home',
    [{ path: '.ia/src/note.ia', text: '#! ia 1.0\n\n# native source comment\n' }],
    policy,
  );
  const personal = mountSourceCapture(project, home, digest('revision'), policy, 'personal');
  expect(
    personal.sources.some(
      (source) =>
        source.path ===
        `.ia/adopted/personal/${nativeDigest([{ path: '.ia/src/note.ia', text: '#! ia 1.0\n\n# native source comment\n' }])}/.ia/src/note.ia`,
    ),
  ).toBe(true);
  expect(() => mountSourceCapture(personal, home, digest('other'), policy, 'personal')).toThrow();
  const altered = { ...policy, floor: [] };
  expect(() => mountSourceCapture(project, home, digest('revision'), altered, 'personal')).toThrow();
});

it.each(['personal', 'workspace'])(
  'binds the %s resource mount to exact native bytes rather than the durable ledger revision',
  (mountId) => {
    const policy = createSourcePolicy(root, { validator: digest('implementation') });
    const project = homeSourceCapture('project', [], policy);
    const files = [{ path: '.ia/src/note.ia', text: '#! ia 1.0\n# Native source resource identity.\n' }];
    const home = homeSourceCapture('home', files, policy);
    const mounted = mountSourceCapture(project, home, digest('ledger-request-policy-actor'), policy, mountId);
    expect(resourceOccurrences(mounted).sourceRevisions).toContainEqual({
      source: mountId,
      revision: nativeDigest(files),
    });
    expect(
      mounted.sources.some((source) => source.path === `.ia/adopted/${mountId}/${nativeDigest(files)}/.ia/src/note.ia`),
    ).toBe(true);
    const { revision: _revision, ...body } = structuredClone(mounted);
    const changed = {
      ...body,
      sources: body.sources.map((source) =>
        source.path.includes(`.ia/adopted/${mountId}/`) ? { ...source, text: source.text + '# tampered\n' } : source,
      ),
    };
    expect(() => resourceOccurrences({ ...changed, revision: digest(changed) })).toThrow(
      'Adopted source revision differs from its exact native bytes',
    );
  },
);

it('refuses a mount identity that aliases the project resource source', () => {
  const policy = createSourcePolicy(root, { validator: digest('implementation') });
  const project = homeSourceCapture('workspace', [], policy);
  const home = homeSourceCapture('home', [{ path: '.ia/src/note.ia', text: '#! ia 1.0\n' }], policy);
  expect(() => mountSourceCapture(project, home, digest('revision'), policy)).toThrow('Invalid source mount identity');
});

it('keeps a retained legacy ledger-path capture decodable and its exact native inspection bytes unchanged', async () => {
  const policy = createSourcePolicy(root, { validator: digest('implementation') });
  const project = homeSourceCapture('project', [], policy),
    path = `.ia/adopted/personal/${digest('legacy-ledger')}/.ia/src/note.ia`;
  const text = '#! ia 1.0\n# Exact retained legacy bytes.\n';
  const body = {
    version: 1 as const,
    id: project.id,
    folders: ['.ia/src'],
    floorOrigin: project.floorOrigin,
    sources: [
      ...project.sources,
      {
        path,
        text,
        location: {
          placement: { kind: 'adopted' as const, band: 90 as const, reach: '' },
          provenance: 'methodology' as const,
        },
      },
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const retained = { ...body, revision: digest(body) },
    serialized = JSON.stringify(retained);
  expect(verifyCapture(JSON.parse(serialized))).toEqual(retained);
  const corpus = new Corpus(JSON.parse(serialized));
  try {
    const context = { grant: { sources: [retained.revision] } } as Parameters<typeof corpus.adapter.execute>[1];
    const first = await corpus.adapter.execute({ operation: 'read', path }, context);
    expect(first).toEqual(await corpus.adapter.execute({ operation: 'read', path }, context));
    expect(JSON.parse((first.output as { text: string }).text).lines.join('\n')).toBe(text);
    expect(canonical(corpus.capture)).toBe(canonical(retained));
  } finally {
    corpus.close();
  }
});
