import { expect, it } from 'vitest';
import {
  assessAuthoringMinting,
  createAuthoringIndex,
  pageAuthoringCatalogue,
  prepareAuthoringTarget,
  reconcileAuthoringCatalogue,
  resolveAuthoring,
  verifyAuthoringIndex,
} from '../src/authoring.js';
import { metadataDigest } from '../src/resource-format.js';
import { sha256 } from '../src/resource-format.js';
import { verifyResources } from '../src/resources.js';
import { authoringFixture } from './authoring-fixture.js';

it('reconciles complete catalogue pages and detects omitted or repeated equal-count coverage', () => {
  const f = authoringFixture();
  try {
    const view = resolveAuthoring(
      f.capture,
      f.resources,
      createAuthoringIndex(f.capture, f.resources, f.input),
      f.scope,
    );
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = pageAuthoringCatalogue(view, { cursor, limit: 5 });
      pages.push(page);
      cursor = page.next;
    } while (cursor);
    expect(reconcileAuthoringCatalogue(view, pages)).toMatchObject({ complete: true, missing: [], duplicates: [] });
    expect(reconcileAuthoringCatalogue(view, [...pages.slice(0, -1), pages[0]!]).complete).toBe(false);
    expect(reconcileAuthoringCatalogue(view, pages.slice(0, -1)).complete).toBe(false);
    expect(() => pageAuthoringCatalogue(view, { cursor: 'foreign:5', limit: 5 })).toThrow();
    expect(view.guides.some((g) => g.status === 'missing')).toBe(true);
  } finally {
    f.reader.close();
  }
});

it('requires the changed word guide coherently while retaining unchanged legacy missing guides', () => {
  const a = authoringFixture(),
    b = authoringFixture((t) =>
      t
        .replace('Use exact requirement evidence.', 'Changed text.')
        .replace('A note records an explicit bounded requirement.', 'A note records a changed bounded requirement.'),
    );
  try {
    const before = resolveAuthoring(
      a.capture,
      a.resources,
      createAuthoringIndex(a.capture, a.resources, a.input),
      a.scope,
    );
    const after = resolveAuthoring(
      b.capture,
      b.resources,
      createAuthoringIndex(b.capture, b.resources, b.input),
      b.scope,
    );
    const result = assessAuthoringMinting(before, after);
    expect(result.ready).toBe(true);
    expect(result.changed.some((r) => r.key === 'authoring-system/note')).toBe(true);
    const hidden = resolveAuthoring(b.capture, b.resources, createAuthoringIndex(b.capture, b.resources, b.input), {
      ...b.scope,
      allowedResources: [],
    });
    expect(assessAuthoringMinting(before, hidden).ready).toBe(false);
  } finally {
    a.reader.close();
    b.reader.close();
  }
});

it('blocks newly registered vocabulary without a primary guide and changed legacy schemas without current guide proof', () => {
  const before = authoringFixture();
  const added = authoringFixture(
    (t) =>
      t
        .replace(
          '    authoring-guide lowers',
          '    term lowers to definition\n      category representation\n      facets [head]\n      schema @schema term\n    authoring-guide lowers',
        )
        .replace('applies [playbook, note, authoring-guide]', 'applies [playbook, note, term, authoring-guide]') +
      '@schema term\n  lowers to definition\n  sections\n    open\n',
  );
  const changed = authoringFixture((t) =>
    t.replace(
      '@schema playbook\n  lowers to definition\n  sections\n    open',
      '@schema playbook\n  lowers to definition\n  sections\n    closed',
    ),
  );
  try {
    const view = (f: ReturnType<typeof authoringFixture>) =>
      resolveAuthoring(f.capture, f.resources, createAuthoringIndex(f.capture, f.resources, f.input), f.scope);
    const baseline = view(before),
      addedResult = assessAuthoringMinting(baseline, view(added));
    expect(addedResult.ready).toBe(false);
    expect(addedResult.changed).toContainEqual({ key: 'authoring-system/term', change: 'added', status: 'missing' });
    const changedResult = assessAuthoringMinting(baseline, view(changed));
    expect(changedResult.ready).toBe(false);
    expect(changedResult.changed).toContainEqual({
      key: 'authoring-system/playbook',
      change: 'changed',
      status: 'missing',
    });
  } finally {
    before.reader.close();
    added.reader.close();
    changed.reader.close();
  }
});

it('revises artifact/member commitments when its retained contract bytes change at the same native revision', () => {
  const f = authoringFixture();
  try {
    const original = createAuthoringIndex(f.capture, f.resources, f.input),
      { digest: _digest, ...body } = f.resources;
    const files = body.files.map((file) => {
      if (file.key.path !== 'references/note.md') return file;
      const content = '# Changed exact contract\n';
      return { ...file, content, bytes: Buffer.byteLength(content), sha256: sha256(content) };
    });
    const updated = { ...body, files },
      resources = verifyResources({ ...updated, digest: metadataDigest(updated) }, f.capture);
    const index = createAuthoringIndex(f.capture, resources, f.input);
    expect(index.artifacts[0]!.revision).not.toBe(original.artifacts[0]!.revision);
    expect(index.documents[0]!.members[0]!.revision).not.toBe(original.documents[0]!.members[0]!.revision);
  } finally {
    f.reader.close();
  }
});

it('does not claim minting readiness when a full candidate contains refused source outside the visible catalogue', () => {
  const a = authoringFixture(),
    b = authoringFixture(undefined, [{ path: '.ia/src/invalid.ia', text: '#! ia 1.0\n@unregistered invalid\n' }]);
  try {
    const view = (f: ReturnType<typeof authoringFixture>) =>
      resolveAuthoring(f.capture, f.resources, createAuthoringIndex(f.capture, f.resources, f.input), f.scope);
    expect(b.reader.report.findings.some((f) => f.severity === 'error')).toBe(true);
    expect(assessAuthoringMinting(view(a), view(b)).ready).toBe(false);
  } finally {
    a.reader.close();
    b.reader.close();
  }
});

it('reports visible primary collisions without disclosing an excluded colliding descriptor', () => {
  const f = authoringFixture(
    (text) =>
      text +
      text
        .slice(text.indexOf('@authoring-guide note-guide'))
        .replace('@authoring-guide note-guide', '@authoring-guide hidden-guide'),
  );
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input),
      full = resolveAuthoring(f.capture, f.resources, index, f.scope);
    expect(full.guides.find((g) => g.word === 'note')?.status).toBe('conflict');
    const within = f.reader.resolveScope({
      identities: f.reader
        .records({ within: f.scope.within })
        .filter((r) => r.name !== 'hidden-guide')
        .map((r) => r.identity),
    }).token;
    const narrowed = resolveAuthoring(f.capture, f.resources, index, { ...f.scope, within });
    expect(narrowed.guides.find((g) => g.word === 'note')?.status).toBe('unavailable');
    expect(JSON.stringify(narrowed)).not.toContain('hidden-guide');
  } finally {
    f.reader.close();
  }
});

it('rejects forged artifact/member revisions even after a caller recomputes the envelope digest', () => {
  const f = authoringFixture();
  try {
    const index = createAuthoringIndex(f.capture, f.resources, f.input),
      forged = structuredClone(index);
    (forged.artifacts[0] as { revision: string }).revision = 'a'.repeat(64);
    (forged.documents[0]!.members[0] as { revision: string }).revision = 'a'.repeat(64);
    const { digest: _digest, ...body } = forged;
    expect(() => verifyAuthoringIndex({ ...body, digest: metadataDigest(body) }, f.capture, f.resources)).toThrow(
      /proof/,
    );
    expect(() => createAuthoringIndex(f.capture, f.resources, { ...f.input, arbitraryGrant: true })).toThrow();
    expect(() =>
      verifyAuthoringIndex(
        JSON.stringify(index).replace('"format":', '"format":"duplicate","format":'),
        f.capture,
        f.resources,
      ),
    ).toThrow();
  } finally {
    f.reader.close();
  }
});

it('keeps shared artifact identity across a brief and PRD while missing inputs block and outputs remain expected', () => {
  const f = authoringFixture();
  try {
    const input = { ...f.input, documents: [...f.input.documents, { ...f.input.documents[0]!, id: 'prd' }] };
    const index = createAuthoringIndex(f.capture, f.resources, input);
    expect(index.documents[0]!.members[0]!.revision).toBe(index.documents[1]!.members[0]!.revision);
    const view = resolveAuthoring(f.capture, f.resources, index, { ...f.scope, allowedDocuments: ['brief', 'prd'] });
    const a = prepareAuthoringTarget(view, {
      target: { kind: 'document', id: 'brief' },
      document: null,
      lifecycle: null,
    });
    const b = prepareAuthoringTarget(view, {
      target: { kind: 'document', id: 'prd' },
      document: null,
      lifecycle: null,
    });
    expect(a.parts).toEqual(b.parts);
    expect(a.missing).toEqual([]);
    expect(a.expectedOutputs).toHaveLength(1);
    const empty = { ...f.input, documents: [{ ...f.input.documents[0]!, members: [] }] },
      emptyIndex = createAuthoringIndex(f.capture, f.resources, empty);
    expect(
      prepareAuthoringTarget(resolveAuthoring(f.capture, f.resources, emptyIndex, f.scope), {
        target: { kind: 'document', id: 'brief' },
        document: null,
        lifecycle: null,
      }).missing,
    ).toContainEqual({ id: 'role-requirement', reason: 'Profile role is not yet supplied' });
  } finally {
    f.reader.close();
  }
});

it('binds source ranges and does not accept impossible same-iteration lifecycle ordering', () => {
  const f = authoringFixture();
  try {
    const artifact = f.input.artifacts[0]!;
    const ranged = {
      ...f.input,
      artifacts: [
        {
          ...artifact,
          source: { kind: 'resource' as const, key: f.key('documents/requirement.md'), range: { start: 1, end: 1 } },
        },
      ],
    };
    const index = createAuthoringIndex(f.capture, f.resources, ranged);
    expect(index.artifacts[0]!.revision).not.toBe(
      createAuthoringIndex(f.capture, f.resources, f.input).artifacts[0]!.revision,
    );
    expect(() =>
      createAuthoringIndex(f.capture, f.resources, {
        ...ranged,
        artifacts: [
          { ...ranged.artifacts[0]!, source: { ...ranged.artifacts[0]!.source, range: { start: 2, end: 50 } } },
        ],
      }),
    ).toThrow(/range/);
    const transition = {
      id: 'forward',
      from: 'draft',
      to: 'review',
      inputs: ['requirement'],
      outputs: ['acceptance'],
      feedback: false,
      criteria: [],
    };
    const model = {
      id: 'authoring',
      version: '1',
      stages: ['draft', 'review'],
      transitions: [transition, { ...transition, id: 'return', from: 'review', to: 'draft' }],
    };
    expect(() => createAuthoringIndex(f.capture, f.resources, { ...f.input, lifecycles: [model] })).toThrow(/ordering/);
    expect(
      createAuthoringIndex(f.capture, f.resources, {
        ...f.input,
        lifecycles: [{ ...model, transitions: [transition, { ...model.transitions[1]!, feedback: true }] }],
      }).lifecycles,
    ).toHaveLength(1);
  } finally {
    f.reader.close();
  }
});
