import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DirectedEdgeRow } from '@inventarch/graph';
import { PHASES } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { EditorDatabase } from '../src/editor/index.js';
import { open } from '../src/index.js';
import type { Handle, Scope } from '../src/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

const code = (value: string) => expect.objectContaining({ code: `IA-DB-${value}` });
/** Every read a scope token binds (D08, D09), a child scope among them. */
const scopedReads = (db: Handle, within: string): readonly (() => unknown)[] => [
  () => db.records({ within }),
  () => db.get(methodId, { within }),
  () => db.referencedBy(methodId, { within }),
  () => db.directedView(methodId, { within }),
  () => db.resolveSeat(methodPath, { within }),
  () => db.inertDeclarations({ within }),
  () => db.words({ within }),
  () => db.roots({ within }),
  () => db.resolve({ kind: 'identity', identity: methodId }, { within }),
  () => db.search('fixture', { within }),
  () => db.traverse({ start: [methodId], within }),
  () => db.snapshot({ within }),
  () => db.staleness(methodId, { within }),
  () => db.readiness(methodId, '0'.repeat(64), { within }),
  () => db.isCompleteScope(within),
  () => db.resolveScope({ within }),
];
it('issues opaque immutable scope bindings, inherits them on reads and intersects allowlists', () => {
  const db = open(workspace(), { cache: false }),
    ids = [methodId],
    parent = db.resolveScope({ root: 'team/./one', phase: 'act', identities: ids });
  ids.push('not-allowed');
  const child = db.resolveScope({
    within: parent.token,
    root: 'team/one/child',
    identities: [methodId, 'not-allowed'],
  });
  expect(parent.token).not.toBe(child.token);
  expect(parent.root).toBe('team/one');
  expect(child.phase).toBe('act');
  expect(db.records({ within: child.token }).map((r) => r.identity)).toEqual([methodId]);
  expect(db.get(methodId, { within: child.token })?.identity).toBe(methodId);
  expect(() => db.get('not-allowed', { within: child.token })).toThrow(code('OUT-OF-SCOPE'));
  expect(() => {
    (parent as { root: string }).root = '';
  }).toThrow();
  expect(Object.keys(db.snapshot({ within: child.token })).sort()).toEqual([
    'authoredRevision',
    'membership',
    'phase',
    'records',
    'revision',
    'root',
    'systems',
  ]);
  expect(db.snapshot({ within: child.token }).membership.map((row) => row.identity)).toEqual([methodId]);
  const empty = db.resolveScope({ within: child.token, identities: [] });
  expect(db.records({ within: empty.token })).toEqual([]);
});
it('reads typed field references by target and prunes holders outside the scope', () => {
  const db = open(workspace(), { cache: false }),
    all = db.referencedBy(methodId);
  expect(all.map((r) => [r.from, r.field])).toContainEqual([
    'agent-composition-system/definition/capability/governance-system-stewardship',
    'composition.playbooks',
  ]);
  expect(all.every((r) => r.to === methodId)).toBe(true);
  const holders = db.resolveScope({ identities: [methodId, all[0]!.from] }),
    alone = db.resolveScope({ identities: [methodId] });
  expect(db.referencedBy(methodId, { within: holders.token }).map((r) => r.from)).toEqual([all[0]!.from]);
  expect(db.referencedBy(methodId, { within: alone.token })).toEqual([]);
  expect(() => db.referencedBy(all[0]!.from, { within: alone.token })).toThrow(code('OUT-OF-SCOPE'));
});
it('reads the graph directed view and prunes rows whose counterpart is outside the scope', () => {
  const db = open(workspace(), { cache: false }),
    all = db.directedView(methodId);
  const declared = all.find((row): row is DirectedEdgeRow => row.kind === 'edge')!;
  // The counterpart's view reads the same assertion as a derived inverse declared on this record.
  expect(db.directedView(declared.counterpart)).toContainEqual(
    expect.objectContaining({
      kind: 'inverse',
      derived: true,
      predicate: declared.predicate,
      counterpart: methodId,
      declaredOn: methodId,
    }),
  );
  // Its inbound field-ref rows are referencedBy's references, read from the target's side.
  expect(
    all
      .filter((row) => row.kind === 'field-ref' && row.direction === 'in')
      .map((row) => row.counterpart)
      .sort(),
  ).toEqual(
    db
      .referencedBy(methodId)
      .map((reference) => reference.from)
      .sort(),
  );
  const counterpart = declared.counterpart,
    pair = db.resolveScope({ identities: [methodId, counterpart] }),
    alone = db.resolveScope({ identities: [methodId] });
  expect(db.directedView(methodId, { within: pair.token })).toEqual(
    all.filter((row) => row.counterpart === counterpart),
  );
  expect(db.directedView(methodId, { within: alone.token })).toEqual([]);
  expect(() => db.directedView(counterpart, { within: alone.token })).toThrow(code('OUT-OF-SCOPE'));
  expect(db.directedView('governance-system/definition/procedure/absent')).toEqual([]);
});
it('checks explicit root, phase and revision assertions and refuses wider child roots', () => {
  const db = open(workspace(false), { cache: false }),
    scope = db.resolveScope({ root: 'team', phase: 'act' });
  expect(db.records({ within: scope.token, root: 'team/.', phase: 'act', revision: scope.revision })).toHaveLength(118);
  for (const mismatch of [{ root: '' }, { phase: 'orient' as const }, { phase: null }, { revision: 'other' }])
    expect(() => db.records({ within: scope.token, ...mismatch })).toThrow(code('SCOPE-MISMATCH'));
  for (const root of ['', 'team-other', '../escape', '/absolute'])
    expect(() => db.resolveScope({ within: scope.token, root })).toThrow(code('SCOPE-MISMATCH'));
  expect(() => db.resolveScope({ within: scope.token, revision: 'other' })).toThrow(code('SCOPE-MISMATCH'));
  expect(() => db.resolveScope({ revision: 'other' })).toThrow(code('STALE'));
  expect(db.resolveScope({ within: scope.token, phase: null }).phase).toBeUndefined();
});
it('checks unknown, foreign and closed tokens on every scoped read', () => {
  const db = open(workspace(false), { cache: false }),
    other = open(workspace(false), { cache: false }),
    foreign = other.resolveScope();
  for (const within of ['forged', foreign.token])
    for (const read of scopedReads(db, within)) expect(read).toThrow(code('SCOPE-UNAVAILABLE'));
  const scope = db.resolveScope();
  db.close();
  expect(() => db.records({ within: scope.token })).toThrow(code('CLOSED'));
  expect(() => db.resolveScope()).toThrow(code('CLOSED'));
  expect(() => db.isIssuedScope(scope.token)).toThrow(code('CLOSED'));
});
it('keeps tokens on identical refresh but never revives them after input change and restoration', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    scope = db.resolveScope(),
    original = readFileSync(resolve(root, methodPath), 'utf8');
  const before = db.records({ within: scope.token });
  db.refresh();
  expect(db.records({ within: scope.token })).toEqual(before);
  // It reads the objects of the current view, not those it was issued against.
  expect(db.records({ within: scope.token })[0]).toBe(db.records()[0]);
  expect(db.records({ within: scope.token })[0]).not.toBe(before[0]);
  put(root, methodPath, original + '\n# change\n');
  db.refresh();
  expect(() => db.records({ within: scope.token })).toThrow(code('STALE'));
  const next = db.resolveScope();
  put(root, methodPath, original);
  db.refresh();
  expect(db.revision).toBe(scope.revision);
  expect(() => db.records({ within: scope.token })).toThrow(code('STALE'));
  expect(() => db.resolveScope({ within: next.token })).toThrow(code('STALE'));
});
/** D08c: the scopes a reader holds. A client's token outlives this many newer scopes however long it sits unread. */
const HELD_SCOPES = 4096;
/** Declares `count` reaches over `root`, `reach/0` and on, each with a source of its own, so that each has its own views. */
function declareReaches(count: number, root: string, locations: Record<string, Location> = {}) {
  const source = readFileSync(resolve(root, methodPath), 'utf8');
  for (let index = 0; index < count; index++) {
    const path = `.ia/src/reach-${index}.ia`;
    put(root, path, source.replace('@playbook sample-procedure', `@playbook reach-${index}`));
    locations[path] = { placement: { kind: 'authored', band: 100, reach: `reach/${index}` }, provenance: 'workspace' };
  }
  return locations;
}
it('evicts the least recently used scope past 4,096, and its token refuses as a stale one does', () => {
  const db = open(workspace(), { cache: false }),
    kept = db.resolveScope({ identities: [methodId] }),
    evicted = db.resolveScope({ identities: [methodId] });
  for (let held = 2; held < HELD_SCOPES; held++) db.resolveScope();
  // Full, nothing has left: the oldest still reads, and that read leaves `evicted` the least recently used.
  expect(db.records({ within: kept.token }).map((r) => r.identity)).toEqual([methodId]);
  const newest = db.resolveScope({ identities: [] });
  for (const read of scopedReads(db, evicted.token)) expect(read).toThrow(code('STALE'));
  // Refused, never read wider, and what stays keeps its own boundary.
  expect(db.records({ within: kept.token }).map((r) => r.identity)).toEqual([methodId]);
  expect(db.records({ within: newest.token })).toEqual([]);
});
it('tells a token evicted long ago from a token this reader never issued, and keeps the token a UUID', () => {
  const db = open(workspace(false), { cache: false }),
    other = open(workspace(false), { cache: false }),
    evicted = db.resolveScope().token,
    foreign = other.resolveScope().token;
  expect(evicted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (let held = 0; held < 2 * HELD_SCOPES; held++) db.resolveScope();
  expect(db.isIssuedScope(evicted)).toBe(true);
  expect(() => db.records({ within: evicted })).toThrow(code('STALE'));
  const tampered = `${evicted.slice(0, -1)}${evicted.endsWith('0') ? '1' : '0'}`,
    spliced = `${randomUUID().slice(0, 24)}${evicted.slice(24)}`;
  for (const within of [tampered, spliced, foreign, randomUUID(), '', 'forged']) {
    expect(db.isIssuedScope(within), within).toBe(false);
    expect(() => db.records({ within }), within).toThrow(code('SCOPE-UNAVAILABLE'));
  }
});
it('never evicts a pinned scope, which goes stale all the same when the inputs change', () => {
  const root = workspace(false),
    db = open(root, { cache: false }),
    pinned = db.resolveScope({ pinned: true }),
    unpinned = db.resolveScope();
  // A child is a scope of its own: it holds its parent's boundary, not its parent's pin.
  const child = db.resolveScope({ within: pinned.token });
  for (let held = 0; held < HELD_SCOPES; held++) db.resolveScope();
  expect(db.records({ within: pinned.token })).toEqual(db.records());
  for (const token of [unpinned.token, child.token]) expect(() => db.records({ within: token })).toThrow(code('STALE'));
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  db.refresh();
  expect(() => db.records({ within: pinned.token })).toThrow(code('STALE'));
  // Like any token, it does not revive when the inputs it was issued against come back.
  rmSync(resolve(root, '.ia/src/new.ia'));
  db.refresh();
  expect(db.revision).toBe(pinned.revision);
  expect(() => db.records({ within: pinned.token })).toThrow(code('STALE'));
});
it('holds pinned scopes outside the bound: they take no ordinary place, and nothing comes back already evicted', () => {
  const db = open(workspace(false), { cache: false });
  for (let pinned = 0; pinned < 2 * HELD_SCOPES; pinned++) db.resolveScope({ pinned: true });
  const oldest = db.resolveScope(),
    next = db.resolveScope();
  expect(db.records({ within: oldest.token })).toEqual(db.records());
  for (let held = 2; held < HELD_SCOPES; held++) db.resolveScope();
  // All 4,096 ordinary scopes fit beside the pins, and the next one evicts an ordinary scope.
  expect(db.records({ within: oldest.token })).toEqual(db.records());
  db.resolveScope();
  expect(() => db.records({ within: next.token })).toThrow(code('STALE'));
  expect(db.records({ within: oldest.token })).toEqual(db.records());
});
it('lets go of what a refresh replaced while earlier tokens go on reading, and of every scope on close', async () => {
  const child = await runBounded(
    process.execPath,
    [
      '--expose-gc',
      '--conditions=development',
      '--import',
      'tsx',
      resolve(import.meta.dirname, 'release-child.ts'),
      workspace(),
    ],
    { cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, NODE_OPTIONS: '' }, timeoutMs: 30_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({
    replacedCollected: [true, true, true],
    currentCollected: false,
    tokensRead: [true, true, true],
    closedCollected: [true, true],
  });
});
it('reads through a scope and narrows it the same once its view has left the held views', () => {
  const root = workspace(),
    overlay = '.ia/src/overlay.ia';
  put(root, overlay, readFileSync(resolve(root, methodPath), 'utf8'));
  const locations = declareReaches(3, root, {
    [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
    [overlay]: { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' },
  });
  const db = open(root, { cache: false, locations }),
    /** Three reaches read whole and at every phase leave no view held but the root one. */
    readOtherViews = () => {
      for (let reach = 0; reach < 3; reach++)
        for (const phase of [null, ...PHASES]) db.resolveScope({ root: `reach/${reach}`, phase });
    },
    parent = db.resolveScope({ identities: [methodId] }),
    narrowed = db.resolveScope({ within: parent.token, root: 'team' }),
    phased = db.resolveScope({ phase: 'act', identities: [methodId] }),
    independent = db.resolveScope({ root: 'team', identities: [methodId] }),
    whole = db.resolveScope({ phase: 'act' }),
    scopes: readonly Scope[] = [parent, narrowed, phased, independent, whole];
  const before = scopes.map((scope) => db.snapshot({ within: scope.token }));
  expect(before.slice(0, 4).map((snapshot) => snapshot.records.map((record) => record.source.path))).toEqual([
    [methodPath],
    [],
    [methodPath],
    [overlay],
  ]);
  readOtherViews();
  expect(scopes.map((scope) => db.snapshot({ within: scope.token }))).toEqual(before);
  // A child taken now intersects the same occurrences: the winner at `team` is still no occurrence of the parent's.
  const child = db.resolveScope({ within: parent.token, root: 'team' });
  expect(db.records({ within: child.token })).toEqual([]);
  expect(() => db.get(methodId, { within: child.token })).toThrow(code('OUT-OF-SCOPE'));
  // A scope that keeps its whole view bounds a child the same once that view is gone.
  readOtherViews();
  const inside = db.resolveScope({ within: whole.token, identities: [methodId, 'absent'] });
  expect(db.records({ within: inside.token }).map((record) => record.identity)).toEqual([methodId]);
  const team = db.resolveScope({ within: whole.token, root: 'team' });
  expect(() => db.get(methodId, { within: team.token })).toThrow(code('OUT-OF-SCOPE'));
});
it('holds 16 views of its inputs, the least recently used leaving first and the root view never', () => {
  const root = workspace(),
    editor = new EditorDatabase(root, { locations: declareReaches(3, root) }),
    snapshot = editor.current,
    whole = snapshot.inspect(),
    kept = snapshot.inspect({ root: 'reach/0' }),
    evicted = snapshot.inspect({ root: 'reach/1' });
  try {
    snapshot.inspect({ root: 'reach/2' });
    for (const phase of PHASES)
      for (const location of ['', 'reach/0', 'reach/2']) snapshot.inspect({ root: location, phase });
    // Full, nothing has left: this read leaves `evicted` the least recently used but for the root view.
    expect(snapshot.inspect({ root: 'reach/0' })).toBe(kept);
    snapshot.inspect({ root: 'reach/1', phase: 'act' });
    const again = snapshot.inspect({ root: 'reach/1' });
    expect(again).not.toBe(evicted);
    expect(again.graph.revision).toBe(evicted.graph.revision);
    expect(snapshot.inspect({ root: 'reach/0' })).toBe(kept);
    expect(snapshot.inspect()).toBe(whole);
  } finally {
    editor.close();
  }
});
it('reads every location below one declared reach through one view, each read naming its own root', () => {
  const root = workspace(),
    editor = new EditorDatabase(root, { locations: declareReaches(1, root) }),
    snapshot = editor.current,
    reachId = 'governance-system/definition/procedure/reach-0';
  try {
    // A root names no view of its own, so naming a thousand builds and holds none.
    expect(snapshot.inspect({ root: 'elsewhere' })).toBe(snapshot.inspect());
    expect(snapshot.inspect({ root: 'reach/0-other' })).toBe(snapshot.inspect());
    expect(snapshot.inspect({ root: 'elsewhere/deep', phase: 'act' })).toBe(snapshot.inspect({ phase: 'act' }));
    expect(snapshot.inspect({ root: 'reach/0/deep' })).toBe(snapshot.inspect({ root: 'reach/0' }));
    expect(snapshot.inspect({ root: 'reach/0' })).not.toBe(snapshot.inspect());
    // The reach still decides what is admitted, and each read still names the root it was asked for.
    expect(snapshot.get(reachId, { root: 'reach/0/deep' })?.identity).toBe(reachId);
    expect(snapshot.get(reachId, { root: 'elsewhere' })).toBeUndefined();
    expect(snapshot.snapshot({ root: 'elsewhere/deep' }).root).toBe('elsewhere/deep');
    const scope = snapshot.resolveScope({ root: 'reach/0/deep', phase: 'act' });
    expect(scope.root).toBe('reach/0/deep');
    expect(snapshot.snapshot({ within: scope.token })).toMatchObject({ root: 'reach/0/deep', phase: 'act' });
    expect(() => snapshot.resolveScope({ within: scope.token, root: 'reach/0' })).toThrow(code('SCOPE-MISMATCH'));
    expect(snapshot.resolveScope({ within: scope.token, root: 'reach/0/deep/er' }).root).toBe('reach/0/deep/er');
  } finally {
    editor.close();
  }
});
it('prunes resolution, scoped BM25 and traversal before any excluded intermediary or gated edge', () => {
  const root = workspace(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  for (const [name, next] of [
    ['first', 'middle'],
    ['middle', 'last'],
    ['last', null],
  ] as const)
    put(
      root,
      `.ia/src/${name}.ia`,
      source.replace('@playbook sample-procedure', `@playbook ${name}`) +
        (next === null ? '' : `    cites @playbook ${next}\n    cites @playbook ${next} when phase is act\n`),
    );
  const db = open(root, { cache: false }),
    prefix = 'governance-system/definition/procedure/',
    first = prefix + 'first',
    last = prefix + 'last';
  const scope = db.resolveScope({ identities: [first, last] }),
    within = scope.token;
  expect(db.resolve({ kind: 'ref', discriminator: 'playbook', name: 'middle' }, { within })).toEqual({
    ok: false,
    code: 'IA-GRAPH-TARGET-MISSING',
  });
  expect(db.search('fixture', { within })).toHaveLength(2);
  expect(db.search('fixture', { within }).every((hit) => [first, last].includes(hit.identity))).toBe(true);
  const walk = db.traverse({ start: [first], follow: ['cites'], depth: 8, coordinate: { phase: 'orient' }, within });
  expect(walk.nodes).toEqual([{ identity: first, depth: 0 }]);
  expect(walk.edges).toEqual([]);
  expect(walk.gated).toEqual([]);
  expect(db.traverse({ start: [first], follow: ['cites'], depth: 8 }).nodes.some((n) => n.identity === last)).toBe(
    true,
  );
});
it('intersects physical occurrences so a narrower-root winner cannot replace the parent winner', () => {
  const root = workspace(),
    overlay = '.ia/src/overlay.ia';
  put(root, overlay, readFileSync(resolve(root, methodPath), 'utf8'));
  const locations: Record<string, Location> = {
    [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
    [overlay]: { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' },
  };
  const db = open(root, { cache: false, locations }),
    parent = db.resolveScope({ identities: [methodId] }),
    child = db.resolveScope({ within: parent.token, root: 'team' });
  expect(db.get(methodId, { within: parent.token })?.source.path).toBe(methodPath);
  expect(db.records({ within: child.token })).toEqual([]);
  expect(() => db.get(methodId, { within: child.token })).toThrow(code('OUT-OF-SCOPE'));
  const independent = db.resolveScope({ root: 'team', identities: [methodId] });
  expect(db.get(methodId, { within: independent.token })?.source.path).toBe(overlay);
});
it('keeps the parent occurrence boundary before phase selection so permitted phase changes work', () => {
  const root = workspace(),
    overlay = '.ia/src/overlay.ia';
  put(
    root,
    overlay,
    readFileSync(resolve(root, methodPath), 'utf8').replace(
      / {2}activation\n(?: {4}activate when .*\n)+/,
      '  activation\n    activate when phase is act\n',
    ),
  );
  const db = open(root, {
    cache: false,
    locations: { [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
  });
  const orient = db.resolveScope({ phase: 'orient', identities: [methodId] }),
    act = db.resolveScope({ within: orient.token, phase: 'act' });
  expect(db.get(methodId, { within: orient.token })?.source.path).toBe(methodPath);
  expect(db.get(methodId, { within: act.token })?.source.path).toBe(overlay);
});
// This case rebuilds full native vocabulary views; Windows CI measured 10.9s.
// Its fixture allowance leaves scope/authority assertions and runtime limits intact.
it('refuses child vocabulary changes while allowing independent authority to scope that view', () => {
  const root = workspace(),
    prefix = '.ia/src/systems/extension',
    locations: Record<string, Location> = {};
  const files = {
    'system.ia':
      '#! ia 1.0\n@system extension\n  provider "fixture"\n  version "1.0.0"\n  steward @agent extension-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
    'schemas/widget.ia': '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n',
    'steward.ia':
      '#! ia 1.0\n@agent extension-steward\n  meaning\n    says "Own extension"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    'one.ia': '#! ia 1.0\n@widget one\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    put(root, path, text);
    locations[path] = { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' };
  }
  const db = open(root, { cache: false, locations }),
    parent = db.resolveScope();
  expect(() => db.resolveScope({ within: parent.token, root: 'team' })).toThrow(code('SCOPE-MISMATCH'));
  const inside = db.resolveScope({ root: 'team' });
  expect(inside.revision).not.toBe(parent.revision);
  expect(db.records({ within: inside.token }).some((r) => r.discriminator === 'widget')).toBe(true);
  const child = db.resolveScope({ within: inside.token, root: 'team/child', revision: inside.revision });
  expect(db.records({ within: child.token }).some((r) => r.discriminator === 'widget')).toBe(true);
  // D09a: the word is registered only in the view whose registry admits the extension.
  expect(db.words({ within: parent.token })).not.toContain('widget');
  expect(db.words({ within: inside.token })).toEqual([...db.words(), 'widget'].sort());
  expect(db.words({ within: child.token })).toEqual(db.words({ within: inside.token }));
}, 30_000);
it('lists the words the view registers for its admitted systems, the same for every scope of it', () => {
  const root = workspace(),
    prefix = '.ia/src/systems/extension';
  put(
    root,
    `${prefix}/system.ia`,
    '#! ia 1.0\n@system extension\n  provider "fixture"\n  version "1.0.0"\n  steward @agent extension-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
  );
  put(root, `${prefix}/schemas/widget.ia`, '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n');
  const db = open(root, { cache: false });
  try {
    const words = db.words();
    // Admission blocks the extension, whose steward is missing, and its word with it.
    expect(db.snapshot().systems).not.toContain('extension');
    expect(words).not.toContain('widget');
    // The floor's two words, the taxonomy's and each admitted system's, sorted and frozen.
    expect(words).toEqual(expect.arrayContaining(['schema', 'system', 'kind', 'phase', 'law', 'workspace', 'mandate']));
    expect(words).toEqual([...words].sort());
    expect(new Set(words).size).toBe(words.length);
    expect(Object.isFrozen(words)).toBe(true);
    for (const scope of [db.resolveScope(), db.resolveScope({ identities: [] }), db.resolveScope({ phase: 'act' })])
      expect(db.words({ within: scope.token })).toEqual(words);
    put(
      root,
      `${prefix}/steward.ia`,
      '#! ia 1.0\n@agent extension-steward\n  meaning\n    says "Own extension"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    );
    db.refresh();
    expect(db.snapshot().systems).toContain('extension');
    expect(db.words()).toEqual([...words, 'widget'].sort());
    // A second system registering the same keyword at the same band blocks it, and admission blocks both systems.
    const other = '.ia/src/systems/other';
    put(
      root,
      `${other}/system.ia`,
      '#! ia 1.0\n@system other\n  provider "fixture"\n  version "1.0.0"\n  steward @agent other-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
    );
    put(
      root,
      `${other}/schemas/widget.ia`,
      '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n',
    );
    put(
      root,
      `${other}/steward.ia`,
      '#! ia 1.0\n@agent other-steward\n  meaning\n    says "Own other"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    );
    db.refresh();
    expect(db.report.findings.map((finding) => finding.code)).toContain('IA-LANG-DISCRIMINATOR-CONFLICT');
    expect(db.snapshot().systems).not.toContain('extension');
    expect(db.snapshot().systems).not.toContain('other');
    expect(db.words()).toEqual(words);
  } finally {
    db.close();
  }
  expect(() => db.words()).toThrow(code('CLOSED'));
});
