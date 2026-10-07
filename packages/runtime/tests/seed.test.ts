import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import { normalizeScopeKey, seatOf, seed } from '../src/index.js';
import type { ScopeKey, Seeding } from '../src/index.js';
import { database, put, workspace } from './workspace.js';

const WS = 'workspace-system/definition/workspace/foundation-workspace',
  LAW = 'governance-system/governance/law/sample-rule',
  CHECK = 'compliance-system/check/gate/instance-schema-check',
  CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract',
  PROCEDURE = 'governance-system/definition/procedure/sample-procedure',
  CONVENTION = 'governance-system/governance/convention/sample-convention',
  PRINCIPLE = 'governance-system/governance/principle/sample-principle',
  MANDATE = 'agent-system/policy/mandate/sample-mandate',
  SYSTEM = 'floor/definition/system/governance-system',
  STEWARD = 'agent-system/binding/agent/governance-steward',
  CAPABILITY = 'agent-composition-system/definition/capability/governance-system-stewardship';
const records = '.ia/src/systems/governance-system/records';
const placed = (kind: 'adopted' | 'open' | 'runtime'): Location => ({
  placement: { kind, band: ({ adopted: 90, open: 50, runtime: 0 } as const)[kind], reach: '' },
  provenance: kind === 'runtime' ? 'runtime' : 'methodology',
});
function seeded(root: string, key: ScopeKey = {}, locations: Readonly<Record<string, Location>> = {}): Seeding {
  const db = database(root, { locations });
  return seed(db, db.resolveScope({}).token, normalizeScopeKey(key));
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}
const ids = (seeding: Seeding): readonly string[] => seeding.loaded;

it('seats an omitted seat at the workspace and a record identity at that record, a @workspace or a @system', () => {
  const db = database(workspace()),
    within = db.resolveScope({}).token,
    at = (seat?: string) => seatOf(db, within, normalizeScopeKey(seat === undefined ? {} : { seat }));
  expect(at()).toEqual({ kind: 'workspace', identity: WS, path: null, home: WS });
  expect(at(WS)).toEqual({ kind: 'workspace', identity: WS, path: null, home: WS });
  expect(at(SYSTEM)).toEqual({ kind: 'system', identity: SYSTEM, path: null, home: WS });
  expect(at(LAW)).toEqual({ kind: 'record', identity: LAW, path: null, home: WS });
});

it('seats a path at a location whose composition is the records declared there and the records claiming it', () => {
  const db = database(workspace()),
    within = db.resolveScope({}).token,
    seeding = (seat: string) => seed(db, within, normalizeScopeKey({ seat, shape: 'governance' }));
  expect(seatOf(db, within, normalizeScopeKey({ seat: 'docs/guide.md' }))).toEqual({
    kind: 'location',
    identity: null,
    path: 'docs/guide.md',
    home: WS,
  });
  expect(seeding('docs/guide.md').composition).toEqual([
    { identity: MANDATE, class: 'claimant', via: 'authority.covers docs/**', direction: null },
  ]);
  expect(seeding(`${records}/sample-rule.ia`).composition).toEqual([
    { identity: LAW, class: 'declared', via: `${records}/sample-rule.ia`, direction: null },
  ]);
  const nowhere = seeding('nowhere/notes.md');
  expect(nowhere.seat).toMatchObject({
    kind: 'location',
    path: 'nowhere/notes.md',
    unknown: 'no record claims nowhere/notes.md',
  });
  expect([nowhere.composition, nowhere.loaded]).toEqual([[], []]);
  expect(() => seatOf(db, within, normalizeScopeKey({ seat: '../outside.md' }))).toThrow(
    expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }),
  );
});

it('refuses a seat record outside the supplied scope instead of reading it as a path', () => {
  const db = database(workspace()),
    within = db.resolveScope({ identities: [WS, MANDATE] }).token;
  expect(() => seatOf(db, within, normalizeScopeKey({ seat: LAW }))).toThrow(
    expect.objectContaining({ code: 'IA-DB-OUT-OF-SCOPE' }),
  );
  expect(seatOf(db, within, normalizeScopeKey({ seat: MANDATE }))).toMatchObject({ kind: 'record', identity: MANDATE });
});

it('composes C0 from field references, capture membership and word membership, one level from the seat', () => {
  const root = workspace();
  const atWorkspace = seeded(root, { shape: 'governance' }).composition;
  const classes: Record<string, number> = {};
  for (const entry of atWorkspace) classes[entry.class] = (classes[entry.class] ?? 0) + 1;
  // The 67 records captured with the workspace; its five systems and the distribution naming it are field refs.
  expect(classes).toEqual({ field: 6, capture: 61 });
  expect(atWorkspace.find((entry) => entry.identity === 'floor/definition/system/agent-system')).toEqual({
    identity: 'floor/definition/system/agent-system',
    class: 'field',
    via: 'composition.systems',
    direction: 'out',
  });
  expect(atWorkspace.find((entry) => entry.identity === LAW)).toEqual({
    identity: LAW,
    class: 'capture',
    via: '.ia/src',
    direction: null,
  });
  expect(
    atWorkspace.some((entry) => entry.identity === WS || entry.identity.startsWith('floor/definition/kind/')),
  ).toBe(false);
  expect(seeded(root, { seat: SYSTEM }).composition).toEqual([
    { identity: STEWARD, class: 'field', via: 'head.steward', direction: 'out' },
    { identity: PROCEDURE, class: 'word', via: 'playbook', direction: null },
    { identity: CONVENTION, class: 'word', via: 'convention', direction: null },
    { identity: LAW, class: 'word', via: 'law', direction: null },
    { identity: PRINCIPLE, class: 'word', via: 'principle', direction: null },
    { identity: WS, class: 'field', via: 'composition.systems', direction: 'in' },
  ]);
  // A record seat composes only its field references; the steward's own references are a level further.
  expect(seeded(root, { seat: MANDATE }).composition).toEqual([
    {
      identity: 'agent-system/binding/agent/agent-steward',
      class: 'field',
      via: 'authority.participant',
      direction: 'out',
    },
  ]);
});

it('seeds the seat and the C0 records in the shape kind or lane focus, and a word restricts C0 to that word', () => {
  const root = workspace();
  expect(seeded(root, { shape: 'governance' }).seeds).toEqual([
    'agent-system/policy/mandate/agent-system-stewardship',
    MANDATE,
    CHECK,
    CONVENTION,
    LAW,
    PRINCIPLE,
  ]);
  const context = seeded(root, { shape: 'context' });
  const kinds = new Map(
    database(root)
      .records()
      .map((node) => [node.identity, node.kind]),
  );
  expect(context.seeds.length).toBeGreaterThan(0);
  expect(context.seeds.every((id) => ['definition', 'contract'].includes(kinds.get(id)!))).toBe(true);
  expect(context.composition.filter((entry) => !context.seeds.includes(entry.identity)).length).toBeGreaterThan(0);
  const law = seeded(root, { shape: 'governance', word: 'law' });
  expect(law.composition).toEqual([{ identity: LAW, class: 'capture', via: '.ia/src', direction: null }]);
  expect(law.seeds).toEqual([LAW]);
  expect(seeded(root, { shape: 'governance', word: 'unregistered' }).composition).toEqual([]);
});

it('excludes open-band records from C0, seeds and hops, and never reads the runtime band', () => {
  const root = workspace();
  const locations = {
    [`${records}/sample-convention.ia`]: placed('open'),
    [`${records}/sample-procedure.ia`]: placed('runtime'),
  };
  const system = seeded(root, { seat: SYSTEM, shape: 'governance' }, locations);
  expect(system.composition.map((entry) => entry.identity)).toEqual([STEWARD, LAW, PRINCIPLE, WS]);
  expect(system.seeds).toEqual([LAW, PRINCIPLE]);
  expect(system.held).toEqual([{ identity: CONVENTION, reason: 'open', hop: 0, via: 'convention' }]);
  expect(stableSerialize(system)).not.toContain(PROCEDURE);
  const hop = seeded(
    root,
    { seat: LAW, shape: 'governance', depth: 2 },
    { '.ia/src/systems/compliance-system/checks/instance-schema-check.ia': placed('open') },
  );
  expect(ids(hop)).toEqual([LAW]);
  expect(hop.held).toEqual([
    {
      identity: CHECK,
      reason: 'open',
      hop: 1,
      via: { from: LAW, predicate: 'enforce', spelling: 'enforced-by', direction: 'in', declaredOn: LAW },
    },
  ]);
});

it('hops along the shape predicates in either direction up to the depth, loading what it reaches whatever its kind', () => {
  const root = workspace();
  expect(ids(seeded(root, { seat: LAW, shape: 'governance', depth: 0 }))).toEqual([LAW]);
  expect(ids(seeded(root, { seat: LAW, shape: 'governance', depth: 1 }))).toEqual([LAW, CHECK]);
  const two = seeded(root, { seat: LAW, shape: 'governance', depth: 2 });
  expect(ids(two)).toEqual([LAW, CHECK, CONTRACT]);
  expect(two.ranked).toEqual([
    {
      identity: CHECK,
      hop: 1,
      band: 100,
      via: { from: LAW, predicate: 'enforce', spelling: 'enforced-by', direction: 'in', declaredOn: LAW },
      blocking: false,
      loaded: true,
    },
    {
      identity: CONTRACT,
      hop: 2,
      band: 100,
      via: { from: CHECK, predicate: 'enforce', spelling: 'enforces', direction: 'out', declaredOn: CHECK },
      blocking: false,
      loaded: true,
    },
  ]);
  // cite is outside the governance focus and inside the context focus, read from the cited end.
  expect(ids(seeded(root, { seat: LAW, shape: 'context', depth: 1 }))).toEqual([LAW, PROCEDURE]);
});

it('never enters another workspace closure: another @workspace and its members are held, not loaded', () => {
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
  // The word keeps C0 to the contract, so the workspace's require rows are what reach the second workspace.
  const context = seeded(root, { seat: WS, shape: 'context', word: 'contract' });
  expect(ids(context)).toEqual([WS, CONTRACT]);
  expect(context.held).toEqual([
    {
      identity: second,
      reason: 'workspace',
      hop: 1,
      via: { from: WS, predicate: 'require', spelling: 'requires', direction: 'out', declaredOn: WS },
    },
  ]);
  // Without the word the second workspace is a C0 member of the first, held there and not met again by the hop.
  expect(seeded(root, { seat: WS, shape: 'context' }).held).toEqual([
    { identity: second, reason: 'workspace', hop: 0, via: '.ia/src' },
  ]);
  const members = seeded(root, { seat: WS }).composition.map((entry) => entry.identity);
  expect(members).toContain(CONTRACT);
  expect(members.some((identity) => identity.startsWith('compliance-system/definition/scenario/'))).toBe(false);
  const execution = seeded(root, { seat: CONTRACT, shape: 'execution' });
  expect(ids(execution)).toEqual([CONTRACT]);
  expect(execution.held.map((held) => [held.identity, held.reason, held.hop])).toEqual([
    ['compliance-system/definition/scenario/foreign-vocabulary', 'workspace', 1],
    ['compliance-system/definition/scenario/missing-required-field', 'workspace', 1],
    ['compliance-system/definition/scenario/valid-native-record', 'workspace', 1],
  ]);
});

it('homes a record or @system seat captured with a @system in the workspace that system belongs to', () => {
  const root = workspace(),
    law = { [`${records}/sample-rule.ia`]: placed('adopted') };
  // The adopted law is a member of its @system; the seat still stays inside the workspace closure.
  const adoptedLaw = seeded(root, { seat: LAW, shape: 'governance', depth: 2 }, law);
  expect(adoptedLaw.seat).toEqual({ kind: 'record', identity: LAW, path: null, home: WS });
  expect([ids(adoptedLaw), adoptedLaw.held]).toEqual([[LAW, CHECK, CONTRACT], []]);
  expect(ids(seeded(root, { seat: LAW, shape: 'context', depth: 1 }, law))).toEqual([LAW, PROCEDURE]);
  // The location seat at the same file agrees.
  expect(seeded(root, { seat: `${records}/sample-rule.ia`, shape: 'governance' }, law).seat.home).toBe(WS);
  // A fully adopted @system is its own membership seat; its home is the workspace seat.
  const system = seeded(
    root,
    { seat: SYSTEM, shape: 'governance' },
    { '.ia/src/systems/governance-system/system.ia': placed('adopted') },
  );
  expect(system.seat).toEqual({ kind: 'system', identity: SYSTEM, path: null, home: WS });
  expect(system.held).toEqual([]);
  expect(system.composition.map((entry) => entry.identity)).toContain(WS);
});

const rule = (name: string, severity: string, relation = '') =>
  `@law ${name}\n  meaning\n    says "Rule ${name}."\n    answers "Which rule is ${name}?"\n  governance\n    severity ${severity}\n  subject\n    covers ["src/**"]\n${relation === '' ? '' : `  relationships\n    ${relation}\n`}`;
function rules(): string {
  const root = workspace();
  put(
    root,
    `${records}/order-rules.ia`,
    `#! ia 1.0\n\n${rule('advisory-rule', 'advisory', 'governs @agent missing-agent')}\n${rule('blocking-rule', 'blocking')}\n${rule('steward-rule', 'informational', 'governs @agent governance-steward')}`,
  );
  put(
    root,
    `${records}/order-convention.ia`,
    '#! ia 1.0\n\n@convention adopted-convention\n  meaning\n    says "An adopted convention."\n    answers "Which convention constrains the contract?"\n  governance\n    severity advisory\n  subject\n    covers ["src/**"]\n  relationships\n    constrains @contract foundation-authoring-contract\n',
  );
  return root;
}
const adopted = { [`${records}/order-convention.ia`]: placed('adopted') };
const ORDER = {
  advisory: 'governance-system/governance/law/advisory-rule',
  blocking: 'governance-system/governance/law/blocking-rule',
  steward: 'governance-system/governance/law/steward-rule',
  convention: 'governance-system/governance/convention/adopted-convention',
};

it('orders governance by priming index, band, hop, severity and identity', () => {
  const seeding = seeded(rules(), { seat: 'src/app.ts', shape: 'governance' }, adopted);
  expect(seeding.seeds).toEqual([ORDER.convention, ORDER.advisory, ORDER.blocking, ORDER.steward]);
  // steward-rule and the steward it governs prime 0; the rest prime 5, then band (the adopted convention is 90) and severity.
  expect(ids(seeding)).toEqual([ORDER.steward, STEWARD, ORDER.blocking, ORDER.advisory, ORDER.convention]);
  expect(seeding.truncated).toBe(0);
});

it('never primes on a row to a runtime-band record, which is never read', () => {
  const runtime = { ...adopted, '.ia/src/systems/governance-system/steward.ia': placed('runtime') };
  // steward-rule governs the steward; with the steward in the runtime band it primes like the rest.
  expect(ids(seeded(rules(), { seat: 'src/app.ts', shape: 'governance' }, runtime))).toEqual([
    ORDER.blocking,
    ORDER.advisory,
    ORDER.steward,
    ORDER.convention,
  ]);
});

it('reads hop before severity under governance, and the whole priming list, implement included', () => {
  const root = rules();
  put(
    root,
    `${records}/order-hops.ia`,
    `#! ia 1.0\n\n${rule('governing-rule', 'informational', 'governs @law governed-rule')}\n${rule('implementing-rule', 'advisory', 'implements @contract foundation-authoring-contract')}\n@law governed-rule\n  meaning\n    says "Rule governed-rule."\n    answers "Which rule is governed?"\n  governance\n    severity advisory\n`,
  );
  const law = (name: string) => `governance-system/governance/law/${name}`;
  // Prime 0 at hop 0, then prime 0 at hop 1 (by severity), then implement's priming index 4, then prime 5.
  expect(ids(seeded(root, { seat: 'src/app.ts', shape: 'governance' }, adopted))).toEqual([
    law('governing-rule'),
    ORDER.steward,
    law('governed-rule'),
    STEWARD,
    law('implementing-rule'),
    ORDER.blocking,
    ORDER.advisory,
    ORDER.convention,
  ]);
});

it('orders the other shapes by band, hop, lane focus and identity', () => {
  const root = workspace();
  put(
    root,
    `${records}/sample-procedure.ia`,
    readFileSync(resolve(root, `${records}/sample-procedure.ia`), 'utf8').concat(
      '    cites @spec seeding-spec\n    cites @capability agent-system-stewardship\n    cites @case valid-native-record\n',
    ),
  );
  const spec = '.ia/src/systems/work-system/records/seeding-spec.ia';
  put(
    root,
    spec,
    '#! ia 1.0\n\n@spec seeding-spec\n  meaning\n    says "A spec the sample procedure cites."\n  work\n    title "Seeding spec"\n    status accepted\n',
  );
  const SPEC = 'work-system/contract/spec/seeding-spec',
    CITED = 'agent-composition-system/definition/capability/agent-system-stewardship',
    CASE = 'compliance-system/definition/scenario/valid-native-record';
  // The C0 capability (hop 0) comes before the cited one (hop 1, a smaller identity); among hop 1 the definitions
  // lane by identity, then the spec (contracts lane), then the law (outside the lane focus).
  expect(ids(seeded(root, { seat: PROCEDURE, shape: 'context' }))).toEqual([
    PROCEDURE,
    CAPABILITY,
    CITED,
    CASE,
    SPEC,
    LAW,
  ]);
  // Band outranks the lane: an adopted spec follows the authored law.
  expect(ids(seeded(root, { seat: PROCEDURE, shape: 'context' }, { [spec]: placed('adopted') }))).toEqual([
    PROCEDURE,
    CAPABILITY,
    CITED,
    CASE,
    LAW,
    SPEC,
  ]);
});

it('cuts at the budget beyond the seat, holding blocking rules outside the budget without refusing', () => {
  const root = rules();
  const one = seeded(root, { seat: 'src/app.ts', shape: 'governance', budget: 1 }, adopted);
  expect(ids(one)).toEqual([ORDER.steward, ORDER.blocking]);
  expect(one.truncated).toBe(3);
  expect(one.ranked.filter((entry) => entry.blocking).map((entry) => entry.identity)).toEqual([ORDER.blocking]);
  const none = seeded(root, { seat: 'src/app.ts', shape: 'governance', budget: 0 }, adopted);
  expect(ids(none)).toEqual([ORDER.blocking]);
  expect(none.truncated).toBe(4);
  // At a record seat the seat is loaded and counts 0 against the budget.
  const law = seeded(workspace(), { seat: LAW, shape: 'governance', depth: 2, budget: 1 });
  expect(ids(law)).toEqual([LAW, CHECK]);
  expect(law.truncated).toBe(1);
});

it('reports the dangling rows and unconsented edges of loaded records as unknowns, and follows neither', () => {
  const root = rules(),
    all = seeded(root, { seat: 'src/app.ts', shape: 'governance' }, adopted);
  expect(all.unknowns).toEqual([
    {
      identity: ORDER.convention,
      reason: 'unconsented',
      path: `${records}/order-convention.ia`,
      line: 12,
      text: `source system refuses constrain from ${ORDER.convention} to ${CONTRACT}`,
    },
    { identity: ORDER.advisory, reason: 'dangling', path: `${records}/order-rules.ia`, line: 12, text: 'governs' },
  ]);
  expect(ids(all)).not.toContain(CONTRACT);
  expect(seeded(root, { seat: 'src/app.ts', shape: 'governance', budget: 0 }, adopted).unknowns).toEqual([]);
});

it('reports the seat record own dangling rows in either direction, and a refusal only at the record declaring it', () => {
  const root = rules(),
    pair = `${records}/order-pair.ia`;
  put(
    root,
    `${records}/order-enforced.ia`,
    `#! ia 1.0\n\n${rule('enforced-rule', 'advisory', 'enforced-by @check missing-check')}`,
  );
  const convention = (name: string, relation: string) =>
    `@convention ${name}\n  meaning\n    says "Convention ${name}."\n    answers "Which convention is ${name}?"\n  governance\n    severity advisory\n${relation}`;
  put(
    root,
    pair,
    `#! ia 1.0\n\n${convention('loud-convention', '  relationships\n    constrains @contract foundation-authoring-contract\n')}\n${convention('quiet-convention', '')}`,
  );
  const at = (seat: string) =>
    seeded(root, { seat, shape: 'governance', depth: 0 }, { ...adopted, [pair]: placed('adopted') });
  const enforced = 'governance-system/governance/law/enforced-rule';
  // enforced-by is read from the check's end: an `in` row, dangling on the seat that declares it.
  expect(at(enforced).unknowns).toEqual([
    { identity: enforced, reason: 'dangling', path: `${records}/order-enforced.ia`, line: 12, text: 'enforced-by' },
  ]);
  expect(at(ORDER.advisory).unknowns).toEqual([
    { identity: ORDER.advisory, reason: 'dangling', path: `${records}/order-rules.ia`, line: 12, text: 'governs' },
  ]);
  const loud = 'governance-system/governance/convention/loud-convention';
  expect(at(loud).unknowns).toEqual([
    {
      identity: loud,
      reason: 'unconsented',
      path: pair,
      line: 10,
      text: `source system refuses constrain from ${loud} to ${CONTRACT}`,
    },
  ]);
  // The quiet convention shares the file but declares nothing.
  expect(at('governance-system/governance/convention/quiet-convention').unknowns).toEqual([]);
});

it('marks a location seat unknown when nothing the seeding reads is declared there or claims it', () => {
  const db = database(workspace(), { locations: { [`${records}/sample-procedure.ia`]: placed('runtime') } }),
    at = (seat: string, within = db.resolveScope({}).token) => seatOf(db, within, normalizeScopeKey({ seat }));
  // The mandate claiming the path lies outside a narrow scope.
  expect(at('docs/guide.md', db.resolveScope({ identities: [WS, LAW] }).token)).toMatchObject({
    kind: 'location',
    unknown: 'no record claims docs/guide.md',
  });
  expect(at('docs/guide.md')).not.toHaveProperty('unknown');
  // The only record declared at the path is in the runtime band, which is never read.
  expect(at(`${records}/sample-procedure.ia`)).toMatchObject({
    kind: 'location',
    unknown: `no record claims ${records}/sample-procedure.ia`,
  });
});

it('names no record outside the scope: an unconsented edge to one is no unknown, as its row would be pruned', () => {
  const db = database(rules(), { locations: adopted }),
    at = (identities: readonly string[]) =>
      seed(
        db,
        db.resolveScope({ identities: [...identities] }).token,
        normalizeScopeKey({ seat: ORDER.convention, shape: 'governance' }),
      );
  const narrow = at([ORDER.convention]);
  expect(narrow.unknowns).toEqual([]);
  expect(stableSerialize(narrow)).not.toContain(CONTRACT);
  expect(at([ORDER.convention, CONTRACT]).unknowns).toEqual([
    {
      identity: ORDER.convention,
      reason: 'unconsented',
      path: `${records}/order-convention.ia`,
      line: 12,
      text: `source system refuses constrain from ${ORDER.convention} to ${CONTRACT}`,
    },
  ]);
});

it('serves K0 as the workspace seat alone, every seed cut at budget 0', () => {
  const k0 = seeded(workspace());
  expect(k0.seat).toEqual({ kind: 'workspace', identity: WS, path: null, home: WS });
  expect(k0.loaded).toEqual([WS]);
  expect(k0.composition.length).toBe(67);
  expect(k0.seeds.length).toBeGreaterThan(0);
  expect(k0.ranked.every((entry) => entry.hop === 0 && !entry.loaded)).toBe(true);
  expect(k0.truncated).toBe(k0.seeds.length);
});

it('is a pure function of the key value and the revision: no token, no root, no per-part sources, no phase', () => {
  const [a, b] = [workspace(), workspace()];
  const key = { shape: 'governance', depth: 2 };
  const first = seeded(a, key),
    second = seeded(b, key);
  expect(stableSerialize(first)).toBe(stableSerialize(second));
  expect(deeplyFrozen(first)).toBe(true);
  const db = database(a),
    [one, two] = [db.resolveScope({}).token, db.resolveScope({}).token];
  expect(stableSerialize(seed(db, one, normalizeScopeKey(key)))).toBe(
    stableSerialize(seed(db, two, normalizeScopeKey(key))),
  );
  const text = stableSerialize(first);
  for (const absent of [one, two, a, b]) expect(text).not.toContain(absent);
  expect(Object.keys(first.key)).toEqual(['seat', 'shape', 'phase', 'primitive', 'depth', 'budget', 'word']);
  expect(first.revision).toBe(db.revision);
  // K0 however spelled; the phase picks cells, never the loaded set.
  expect(stableSerialize(seeded(a, { shape: 'context', phase: 'orient', depth: 0, budget: 0 }))).toBe(
    stableSerialize(seeded(a)),
  );
  const act = seeded(a, { ...key, phase: 'act' });
  expect({ ...act, key: first.key }).toEqual(first);
  expect(act.key).toEqual({ ...first.key, phase: 'act' });
});
