import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Foundation } from '../src/foundation.js';
import { digest } from '../src/format.js';
import { captureKnowledge } from '../src/local.js';
import { openKnowledgeView } from '../src/view.js';
const base = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8'),
) as Foundation;
const sources = base.capture.sources
  .filter((s) => s.location.placement.kind === 'adopted')
  .map((s) => ({ path: s.path.replace(/^\.ia\/distributions\/store\/[^/]+\//, ''), text: s.text }));
const input = { adopted: [{ id: 'public-base', revision: digest(sources), sources }] };
const ID = 'work-system/contract/spec/alpha';
it.each(['authored', 'adopted'])(
  'scoped closure cannot distinguish an excluded %s target from an absent target',
  (placement) => {
    const observations = [];
    for (const present of [false, true]) {
      const root = local(),
        path = join(root, '.ia/src/note.ia');
      writeFileSync(path, readFileSync(path, 'utf8') + '  relationships\n    cites @spec hidden\n');
      const hidden =
        '#! ia 1.0\n@spec hidden\n  meaning\n    says "Hidden."\n  work\n    title "Hidden"\n    status draft\n';
      const hiddenSources = [{ path: '.ia/src/hidden.ia', text: hidden }];
      const scopedInput = {
        adopted: [
          ...input.adopted,
          ...(present && placement === 'adopted'
            ? [{ id: 'private-notes', revision: digest(hiddenSources), sources: hiddenSources }]
            : []),
        ],
      };
      if (present && placement === 'authored')
        writeFileSync(
          join(root, '.ia/src/hidden.ia'),
          '#! ia 1.0\n@spec hidden\n  meaning\n    says "Hidden."\n  work\n    title "Hidden"\n    status draft\n',
        );
      const view = openKnowledgeView(captureKnowledge(root, { input: scopedInput, identities: [ID] }));
      try {
        const { snapshot: _snapshot, ...check } = view.check();
        observations.push({ check, incomplete: view.search('needle').incomplete, edges: view.traverse(ID).edges });
      } finally {
        view.close();
      }
    }
    expect(observations[0]).toEqual(observations[1]);
  },
);

it('reports missing identity and fragment targets without disclosing excluded records', () => {
  for (const target of ['@spec missing', '@spec alpha#missing']) {
    const root = local(),
      path = join(root, '.ia/src/note.ia');
    writeFileSync(path, readFileSync(path, 'utf8') + '  relationships\n    cites ' + target + '\n');
    const view = openKnowledgeView(captureKnowledge(root, { input, identities: [ID] }));
    try {
      expect(view.check().ok).toBe(false);
      expect(view.search('needle').incomplete).toBe(true);
      expect(JSON.stringify(view.check())).not.toContain('missing');
    } finally {
      view.close();
    }
  }
});

it.each(['cites', 'cited-by'])('preserves cross-file graph direction for %s', (spelling) => {
  const root = local(),
    path = join(root, '.ia/src/note.ia');
  writeFileSync(path, readFileSync(path, 'utf8') + '  relationships\n    ' + spelling + ' @spec beta\n');
  writeFileSync(
    join(root, '.ia/src/beta.ia'),
    '#! ia 1.0\n@spec beta\n  meaning\n    says "Beta."\n  work\n    title "Beta"\n    status draft\n',
  );
  const snapshot = captureKnowledge(root, { input }),
    beta = 'work-system/contract/spec/beta';
  expect(snapshot.edges).toEqual([
    expect.objectContaining({
      from: spelling === 'cites' ? ID : beta,
      predicate: 'cite',
      to: spelling === 'cites' ? beta : ID,
    }),
  ]);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function local() {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge local '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  writeFileSync(
    join(root, '.ia/src/note.ia'),
    '#! ia 1.0\n@spec alpha\n  meaning\n    says "Alpha."\n  work\n    title "Alpha"\n    status draft\n    source "README.md"\n',
  );
  writeFileSync(join(root, 'README.md'), '# Alpha\n\n' + 'padding '.repeat(80) + 'document-only needle.\n');
  return root;
}
it('finds bound document-only text with a match-centered excerpt and creates no .kb folder', () => {
  const root = local(),
    view = openKnowledgeView(captureKnowledge(root, { input }));
  try {
    expect(view.search('document-only')).toMatchObject({
      results: [{ identity: ID, excerpt: expect.stringContaining('document-only') }],
      truncated: false,
    });
    expect(view.read(ID)).toMatchObject({
      body: expect.stringContaining('document-only'),
      citation: { kind: 'working-tree' },
    });
    expect(existsSync(join(root, '.kb'))).toBe(false);
  } finally {
    view.close();
  }
});
it('does not resolve an old local citation against changed document bytes', () => {
  const root = local(),
    first = openKnowledgeView(captureKnowledge(root, { input }));
  const citation = first.read(ID).citation;
  writeFileSync(join(root, 'README.md'), '# Alpha\n\nDifferent content.\n');
  const second = openKnowledgeView(captureKnowledge(root, { input }));
  try {
    expect(() => second.resolveCitation(citation)).toThrow(/snapshot unavailable/);
    expect(first.resolveCitation(citation).body).toContain('document-only');
  } finally {
    first.close();
    second.close();
  }
});
it('scope excludes hidden body terms, identities and edges without reading the hidden resource', () => {
  const root = local();
  writeFileSync(
    join(root, '.ia/src/hidden.ia'),
    '#! ia 1.0\n@spec hidden\n  meaning\n    says "Hidden."\n  work\n    title "Hidden"\n    status draft\n    source "hidden.md"\n  relationships\n    cites @spec alpha\n',
  );
  writeFileSync(join(root, 'hidden.md'), 'private-body-term');
  const view = openKnowledgeView(captureKnowledge(root, { input, identities: [ID] }));
  try {
    expect(view.search('private-body-term')).toMatchObject({ results: [], truncated: false, incomplete: false });
    expect(view.check()).toMatchObject({ records: 1, unavailable: [] });
    expect(view.traverse(ID)).toMatchObject({ identities: [ID], edges: [] });
    expect(() => view.read('work-system/contract/spec/hidden')).toThrow('Knowledge not available in this scope');
  } finally {
    view.close();
  }
});
it('refuses stale graph scopes, oversized responses and closed views', () => {
  const root = local();
  expect(() => captureKnowledge(root, { input, expectedRevision: '0'.repeat(64) })).toThrow('revision changed');
  writeFileSync(join(root, 'README.md'), 'a'.repeat(50 * 1024));
  const view = openKnowledgeView(captureKnowledge(root, { input }));
  expect(() => view.read(ID)).toThrow(/48 KiB/);
  expect(() => view.search('a', 101)).toThrow();
  view.close();
  expect(() => view.search('a')).toThrow(/closed/);
});
it('reports unsupported external body locators unavailable without fetching them', () => {
  const root = local(),
    path = join(root, '.ia/src/note.ia');
  writeFileSync(path, readFileSync(path, 'utf8').replace('README.md', 'https://example.invalid/private.md'));
  const view = openKnowledgeView(captureKnowledge(root, { input }));
  try {
    expect(view.check()).toMatchObject({ ok: false, records: 0, unavailable: [{ identity: ID }] });
    expect(view.search('example')).toMatchObject({ results: [], incomplete: true });
  } finally {
    view.close();
  }
});
