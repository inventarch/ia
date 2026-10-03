import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import { open } from '../src/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

const code = (value: string) => expect.objectContaining({ code: `IA-DB-${value}` });
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
    'phase',
    'records',
    'revision',
    'root',
    'systems',
  ]);
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
    for (const read of [
      () => db.records({ within }),
      () => db.get(methodId, { within }),
      () => db.referencedBy(methodId, { within }),
      () => db.resolve({ kind: 'identity', identity: methodId }, { within }),
      () => db.search('fixture', { within }),
      () => db.traverse({ start: [methodId], within }),
      () => db.snapshot({ within }),
      () => db.resolveScope({ within }),
    ])
      expect(read).toThrow(code('SCOPE-UNAVAILABLE'));
  const scope = db.resolveScope();
  db.close();
  expect(() => db.records({ within: scope.token })).toThrow(code('CLOSED'));
  expect(() => db.resolveScope()).toThrow(code('CLOSED'));
});
it('keeps tokens on identical refresh but never revives them after input change and restoration', () => {
  const root = workspace(),
    db = open(root, { cache: false }),
    scope = db.resolveScope(),
    original = readFileSync(resolve(root, methodPath), 'utf8');
  const before = db.records({ within: scope.token });
  db.refresh();
  expect(db.records({ within: scope.token })).toEqual(before);
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
}, 30_000);
