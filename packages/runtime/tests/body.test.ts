import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import { SCOPE_BODY_LIMITS, normalizeScopeKey, positionBody } from '../src/index.js';
import type { PositionBody, ScopeKey } from '../src/index.js';
import { database, put, workspace } from './workspace.js';

const WS = 'workspace-system/definition/workspace/foundation-workspace',
  LAW = 'governance-system/governance/law/sample-rule',
  CHECK = 'compliance-system/check/gate/instance-schema-check',
  CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract',
  PROCEDURE = 'governance-system/definition/procedure/sample-procedure',
  CONVENTION = 'governance-system/governance/convention/sample-convention',
  SYSTEM = 'floor/definition/system/governance-system',
  steward = (name: string) => `agent-system/binding/agent/${name}-steward`;
const records = '.ia/src/systems/governance-system/records';
const placed = (kind: 'open' | 'runtime'): Location => ({
  placement: { kind, band: ({ open: 50, runtime: 0 } as const)[kind], reach: '' },
  provenance: kind === 'runtime' ? 'runtime' : 'methodology',
});
function body(root: string, key: ScopeKey = {}, locations: Readonly<Record<string, Location>> = {}): PositionBody {
  const db = database(root, { locations });
  return positionBody(db, db.resolveScope({}).token, normalizeScopeKey(key));
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}
const ids = (lines: readonly { readonly identity: string }[]): readonly string[] => lines.map((line) => line.identity);

it('lists the composition, cut and held records and the out-of-focus rows of loaded records as pointers', () => {
  const law = body(workspace(), { seat: LAW, shape: 'governance', depth: 1 });
  expect(law.loaded).toEqual([
    {
      identity: LAW,
      word: 'law',
      kind: 'governance',
      lane: 'authority',
      system: 'governance-system',
      steward: steward('governance'),
      band: 100,
      hop: 0,
      via: null,
      blocking: false,
    },
    {
      identity: CHECK,
      word: 'check',
      kind: 'check',
      lane: 'enforcement',
      system: 'compliance-system',
      steward: steward('compliance'),
      band: 100,
      hop: 1,
      via: { from: LAW, by: 'row', predicate: 'enforce', spelling: 'enforced-by', direction: 'in', declaredOn: LAW },
      blocking: false,
    },
  ]);
  // cite and use are outside the governance focus: the procedure is a pointer, first met from the law at hop 1.
  expect(law.pointers).toEqual([
    {
      identity: PROCEDURE,
      word: 'playbook',
      kind: 'definition',
      lane: 'definitions',
      system: 'governance-system',
      steward: steward('governance'),
      band: 100,
      hop: 1,
      via: { from: LAW, by: 'row', predicate: 'cite', spelling: 'cited-by', direction: 'in', declaredOn: PROCEDURE },
    },
  ]);
  // The seat's C0 records that are not loaded are pointers at hop 0, with the class that composed them.
  const workspaceSeat = body(workspace(), { shape: 'governance', budget: 0 });
  // The sample rule is blocking under governance: loaded outside the budget, so never a pointer.
  expect(workspaceSeat.loaded.map((line) => line.identity)).toEqual([WS, LAW]);
  // Listed pointers follow the shape's lane focus, so K0 (context) lists the composed systems among its first lines.
  expect(
    body(workspace()).pointers.find((line) => line.identity === 'floor/definition/system/agent-system'),
  ).toMatchObject({
    hop: 0,
    via: {
      from: WS,
      by: 'field',
      predicate: null,
      spelling: 'composition.systems',
      direction: 'out',
      declaredOn: null,
    },
  });
  expect(workspaceSeat.pointers.find((line) => line.identity === CONVENTION)).toMatchObject({
    hop: 0,
    via: { from: WS, by: 'capture', predicate: null, spelling: '.ia/src', direction: null, declaredOn: null },
  });
  // A seed cut by the budget is a pointer too; no loaded record is ever a pointer.
  const loaded = new Set(ids(workspaceSeat.loaded));
  expect(workspaceSeat.pointers.some((line) => loaded.has(line.identity))).toBe(false);
  expect(new Set(ids(workspaceSeat.pointers)).size).toBe(workspaceSeat.pointers.length);
  expect(workspaceSeat.counts.pointers).toBe(66);
});

it('lists pointers up to the pointer limit and tallies the rest per word and owner system with the steward', () => {
  const k0 = body(workspace());
  expect(SCOPE_BODY_LIMITS.pointers).toBe(48);
  expect(k0.pointers.length).toBe(SCOPE_BODY_LIMITS.pointers);
  // Ordered by band, hop, lane focus (definitions, then contracts) and identity.
  expect(k0.pointers[0]!.identity).toBe('agent-composition-system/definition/capability/agent-system-stewardship');
  expect(k0.pointers.slice(19, 21).map((line) => line.identity)).toEqual([
    'workspace-system/definition/distribution/foundation-distribution',
    CONTRACT,
  ]);
  expect(k0.pointers[47]!.identity).toBe('floor/contract/head/voice');
  const read = (name: string) => `ia read ${steward(name)}`,
    seat = (name: string) => `floor/definition/system/${name}`;
  expect(k0.tallies).toEqual([
    {
      word: 'agent',
      system: 'agent-system',
      count: 11,
      steward: steward('agent'),
      seat: seat('agent-system'),
      read: read('agent'),
    },
    {
      word: 'agent-profile',
      system: 'agent-composition-system',
      count: 1,
      steward: steward('agent-composition'),
      seat: seat('agent-composition-system'),
      read: read('agent-composition'),
    },
    {
      word: 'check',
      system: 'compliance-system',
      count: 1,
      steward: steward('compliance'),
      seat: seat('compliance-system'),
      read: read('compliance'),
    },
    ...['convention', 'law'].map((word) => ({
      word,
      system: 'governance-system',
      count: 1,
      steward: steward('governance'),
      seat: seat('governance-system'),
      read: read('governance'),
    })),
    {
      word: 'mandate',
      system: 'agent-system',
      count: 2,
      steward: steward('agent'),
      seat: seat('agent-system'),
      read: read('agent'),
    },
    {
      word: 'principle',
      system: 'governance-system',
      count: 1,
      steward: steward('governance'),
      seat: seat('governance-system'),
      read: read('governance'),
    },
    // The floor's schemas have no @system record and so no steward to read.
    { word: 'schema', system: 'floor', count: 1, steward: null, seat: null, read: null },
  ]);
  expect(k0.counts).toMatchObject({ pointers: 67, truncatedPointers: 19 });
});

it('tallies the frontier at hop d+1 from the loaded records per owner system and kind, never entering it', () => {
  const law = body(workspace(), { seat: LAW, shape: 'governance', depth: 1 });
  expect(law.frontier).toEqual([
    {
      system: 'compliance-system',
      kind: 'contract',
      count: 1,
      steward: steward('compliance'),
      seat: 'floor/definition/system/compliance-system',
      read: `ia read ${steward('compliance')}`,
    },
  ]);
  expect(ids(law.loaded)).not.toContain(CONTRACT);
  expect(ids(law.pointers)).not.toContain(CONTRACT);
  expect(law.counts.frontier).toBe(1);
  // At depth 2 the contract is loaded and the frontier moves on.
  const deeper = body(workspace(), { seat: LAW, shape: 'governance', depth: 2 });
  expect(ids(deeper.loaded)).toContain(CONTRACT);
  expect(deeper.frontier.some((tally) => tally.kind === 'contract')).toBe(false);
  // A record already listed as a pointer is not counted again: K0's required contract is a C0 pointer.
  expect(body(workspace()).frontier).toEqual([]);
});

it('restricts every tally to the key word, while loaded records and pointer lines keep their full shape', () => {
  const root = workspace();
  const law = body(root, { seat: LAW, shape: 'governance', depth: 1, word: 'law' });
  // The frontier contract is not a law: its tally goes. The check a hop loaded stays, as the seeding loads it.
  expect(law.frontier).toEqual([]);
  expect(law.counts.frontier).toBe(0);
  expect(ids(law.loaded)).toEqual([LAW, CHECK]);
  expect(ids(law.pointers)).toEqual([PROCEDURE]);
  expect(body(root, { word: 'law' }).captured).toEqual([{ word: 'law', count: 1 }]);
  expect(body(root, { word: 'unregistered' }).captured).toEqual([]);
});

it('tallies the records captured under the workspace seat authored roots per word, the seat included', () => {
  const k0 = body(workspace());
  expect(k0.captured).toEqual(
    Object.entries({
      agent: 11,
      'agent-profile': 1,
      capability: 2,
      case: 3,
      check: 1,
      contract: 1,
      convention: 1,
      distribution: 1,
      law: 1,
      mandate: 2,
      playbook: 1,
      principle: 1,
      run: 1,
      schema: 28,
      system: 11,
      voice: 1,
      workspace: 1,
    }).map(([word, count]) => ({ word, count })),
  );
  expect(body(workspace(), { seat: LAW }).captured).toEqual([]);
});

it('gives one system pointer line per system the home workspace composes, else per admitted system', () => {
  const k0 = body(workspace());
  expect(k0.systems.map((line) => line.system)).toEqual([
    'agent-system',
    'compliance-system',
    'governance-system',
    'session-system',
    'workspace-system',
  ]);
  expect(k0.systems[2]).toEqual({
    system: 'governance-system',
    identity: SYSTEM,
    words: ['law', 'principle', 'convention', 'playbook'],
    band: 100,
    steward: steward('governance'),
    read: `ia read ${steward('governance')}`,
  });
  // A record seat reads its home workspace's systems.
  expect(body(workspace(), { seat: LAW }).systems).toEqual(k0.systems);
  // With no @workspace record the seat is the synthetic closure: every admitted @system, the floor's taxonomy aside.
  const root = workspace();
  rmSync(resolve(root, '.ia/src/systems/workspace-system/records/foundation-workspace.ia'));
  const synthetic = body(root);
  expect(synthetic.seat).toMatchObject({ kind: 'workspace', identity: null });
  expect(synthetic.systems.map((line) => line.system)).toEqual([
    'agent-composition-system',
    'agent-system',
    'authoring-system',
    'compliance-system',
    'governance-system',
    'hook-authoring-system',
    'learning-system',
    'session-system',
    'template-system',
    'work-system',
    'workspace-system',
  ]);
});

it('lists held open-band records as pointers and never reads the runtime band', () => {
  const held = body(
    workspace(),
    { seat: SYSTEM, shape: 'governance' },
    { [`${records}/sample-convention.ia`]: placed('open'), [`${records}/sample-procedure.ia`]: placed('runtime') },
  );
  expect(held.pointers.find((line) => line.identity === CONVENTION)).toEqual({
    identity: CONVENTION,
    word: 'convention',
    kind: 'governance',
    lane: 'authority',
    system: 'governance-system',
    steward: steward('governance'),
    band: 50,
    hop: 0,
    via: { from: SYSTEM, by: 'word', predicate: null, spelling: 'convention', direction: null, declaredOn: null },
  });
  expect(ids(held.loaded)).not.toContain(CONVENTION);
  expect(stableSerialize(held)).not.toContain(PROCEDURE);
});

it('prints the two widening-key forms: one hop deeper from the seat, and re-seating at a line', () => {
  const law = body(workspace(), { seat: LAW, shape: 'governance', depth: 1 });
  expect(law.widening).toEqual({
    deepen: {
      seat: LAW,
      shape: 'governance',
      phase: 'plan',
      primitive: 'Inference',
      depth: 2,
      budget: 16,
      word: null,
    },
    reseat: { shape: 'governance', phase: 'plan', primitive: 'Inference', depth: 1, budget: 16, word: null },
  });
  expect(body(workspace(), { seat: LAW, shape: 'governance', depth: 2 }).widening.deepen).toBeNull();
  expect(body(workspace()).widening.deepen).toEqual({
    seat: null,
    shape: 'context',
    phase: 'orient',
    primitive: 'Attention',
    depth: 1,
    budget: 0,
    word: null,
  });
});

it('counts C0, seeds, loaded, the budget cut, pointers, the pointer cut and the frontier', () => {
  expect(body(workspace()).counts).toEqual({
    composition: 67,
    seeds: 49,
    loaded: 1,
    truncated: 49,
    pointers: 67,
    truncatedPointers: 19,
    frontier: 0,
  });
});

it('is a pure function of the key value and the revision: equal keys give byte-equal bodies', () => {
  const [a, b] = [workspace(), workspace()];
  const key = { shape: 'governance', depth: 2 };
  const first = body(a, key);
  expect(stableSerialize(first)).toBe(stableSerialize(body(b, key)));
  expect(deeplyFrozen(first)).toBe(true);
  const db = database(a),
    [one, two] = [db.resolveScope({}).token, db.resolveScope({}).token];
  expect(stableSerialize(positionBody(db, one, normalizeScopeKey(key)))).toBe(
    stableSerialize(positionBody(db, two, normalizeScopeKey(key))),
  );
  const text = stableSerialize(first);
  for (const absent of [one, two, a, b]) expect(text).not.toContain(absent);
  expect(first.revision).toBe(db.revision);
  expect(Object.keys(first.key)).toEqual(['seat', 'shape', 'phase', 'primitive', 'depth', 'budget', 'word']);
  expect(text).not.toContain('"sources"');
  // K0 however it is spelled: one body.
  expect(stableSerialize(body(a, { shape: 'context', phase: 'orient', depth: 0, budget: 0 }))).toBe(
    stableSerialize(body(a)),
  );
});

/**
 * Goldens over the native conformance corpus: K0 and three keys. The revision is checked against the handle and
 * written as `<revision>`, so an unrelated corpus edit does not move every golden. Regenerate with
 * `pnpm --filter @inventarch/runtime test -- -u`; never edit the files by hand.
 */
const GOLDENS: Readonly<Record<string, ScopeKey>> = {
  k0: {},
  'governance-workspace': { shape: 'governance' },
  'context-system': { seat: SYSTEM, shape: 'context' },
  'word-law': { word: 'law', depth: 0, budget: 64 },
};
for (const [name, key] of Object.entries(GOLDENS))
  it(`matches the ${name} golden over the native conformance corpus`, async () => {
    const root = workspace(),
      db = database(root),
      result = positionBody(db, db.resolveScope({}).token, normalizeScopeKey(key));
    expect(result.revision).toBe(db.revision);
    await expect(`${JSON.stringify({ ...result, revision: '<revision>' }, null, 2)}\n`).toMatchFileSnapshot(
      `golden/position/${name}.json`,
    );
  });

it('serves body(K0) as the workspace seat, pointers and tallies, with one line per composed system', () => {
  const k0 = body(workspace());
  expect(ids(k0.loaded)).toEqual([WS]);
  expect([k0.pointers.length, k0.tallies.length > 0, k0.systems.length]).toEqual([48, true, 5]);
});

it('w=law, at depth 0, yields only law entries beside the seat: composition, pointers and every tally', () => {
  // The seeding's word filter restricts C0 (so the seeds) and the tallies; a hop may still load another word, so the key
  // that pins "only law entries" is a depth-0 key, where nothing is reached by a hop.
  const law = body(workspace(), { word: 'law', depth: 0, budget: 64 });
  const words = (lines: readonly { readonly word: string }[]) => [...new Set(lines.map((line) => line.word))];
  expect(ids(law.loaded)).toEqual([WS]);
  expect(words(law.pointers)).toEqual(['law']);
  expect(words(law.tallies)).toEqual([]);
  expect(words(law.captured)).toEqual(['law']);
  expect(law.frontier).toEqual([]);
  expect(ids(law.pointers)).toEqual([LAW]);
});

it('keeps another workspace a pointer and never enters it', () => {
  const root = workspace(),
    at = '.ia/src/systems/workspace-system/records';
  put(
    root,
    `${at}/foundation-workspace.ia`,
    readFileSync(resolve(root, `${at}/foundation-workspace.ia`), 'utf8')
      .replace('session-system]\n', 'session-system]\n    sources [".ia/src @authored"]\n')
      .concat('    requires @workspace second-workspace\n'),
  );
  put(
    root,
    `${at}/second-workspace.ia`,
    '#! ia 1.0\n\n@workspace second-workspace\n  meaning\n    says "A second boundary holding the cases."\n    answers "Which workspace holds the cases?"\n  composition\n    systems [@system compliance-system]\n    sources [".ia/src/systems/compliance-system/cases @authored"]\n',
  );
  const second = 'workspace-system/definition/workspace/second-workspace';
  const context = body(root, { seat: WS, shape: 'context', word: 'contract' });
  expect(ids(context.loaded)).not.toContain(second);
  expect(context.pointers.find((line) => line.identity === second)).toMatchObject({
    word: 'workspace',
    hop: 1,
    via: { from: WS, by: 'row', predicate: 'require', spelling: 'requires', direction: 'out', declaredOn: WS },
  });
});
