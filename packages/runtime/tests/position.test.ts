import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readInputs } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import { K0, normalizeScopeKey, positionBody, resolveScopeKey } from '../src/index.js';
import type { LoadedRecord, PositionBody, ScopeKey } from '../src/index.js';
import { database, lawId, lawPath, methodPath, put, workspace } from './workspace.js';

// R15 (position-and-projection §1, §6 and §7, design item 10; decision scope-key-caps): body(K) over the conformance
// corpus. The golden bodies are regenerated only by `node packages/runtime/tests/golden/write.mjs`, which sets
// IA_POSITION_GOLDEN=write for the golden case alone; their diff is reviewed with the change that makes it.
const foundation = 'workspace-system/definition/workspace/foundation-workspace',
  governanceSystem = 'floor/definition/system/governance-system',
  check = 'compliance-system/check/gate/instance-schema-check',
  contract = 'compliance-system/contract/signature/foundation-authoring-contract',
  procedure = 'governance-system/definition/procedure/sample-procedure',
  workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia',
  records = '.ia/src/systems/governance-system/records';
const GOLDEN: Readonly<Record<string, Partial<ScopeKey>>> = {
  k0: {},
  'governance-at-law': { seat: lawId, shape: 'governance' },
  'sequence-depth-2': { shape: 'sequence', depth: 2 },
  'word-law': { seat: governanceSystem, shape: 'governance', word: 'law' },
};
const bodyOf = (db: Handle, within: string, partial: Partial<ScopeKey> = {}): PositionBody =>
  positionBody(db, within, resolveScopeKey(db, within, normalizeScopeKey(partial)));
const ids = (entries: readonly object[]) => entries.map((entry) => ('identity' in entry ? entry.identity : undefined));
const law = (name: string, severity: string, more = '') =>
  `#! ia 1.0\n@law ${name}\n  meaning\n    says "Fixture law ${name}."\n    answers "What does ${name} require?"\n  governance\n    severity ${severity}\n${more}`;
/** The foundation workspace declaring `sources`, so the records under them are its capture members. */
function declare(root: string, sources: readonly string[]): void {
  const text = readFileSync(resolve(root, workspacePath), 'utf8');
  put(
    root,
    workspacePath,
    text.replace(
      '  relationships\n',
      `    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n  relationships\n`,
    ),
  );
}

it('matches the golden bodies of K0 and three keys over the conformance corpus, the revision asserted apart', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  for (const [name, partial] of Object.entries(GOLDEN)) {
    const body = bodyOf(db, within, partial);
    expect(body.revision).toBe(db.revision);
    const file = resolve(import.meta.dirname, 'golden', `${name}.json`),
      text = `${JSON.stringify({ ...body, revision: '<revision>' }, null, 2)}\n`;
    if (process.env['IA_POSITION_GOLDEN'] === 'write') writeFileSync(file, text);
    else expect(text, name).toBe(readFileSync(file, 'utf8'));
  }
});

it('gives K0 the pointer and tally shape: the seat alone loaded, the N system pointer lines and the frontier', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    body = bodyOf(db, within);
  expect(body.key).toEqual(K0);
  expect(body.seat).toEqual({ kind: 'workspace', identity: foundation });
  expect(ids(body.loaded)).toEqual([foundation]);
  // The workspace's composition.systems refs are the N system pointer lines, at cost 0, with the field that reaches
  // them.
  const systems = body.pointers.filter((p) => p.via.by === 'field' && p.via.field === 'composition.systems');
  expect(ids(systems)).toEqual(
    ['agent-system', 'compliance-system', 'governance-system', 'session-system', 'workspace-system'].map(
      (name) => `floor/definition/system/${name}`,
    ),
  );
  expect(
    systems.every((p) => p.word === 'system' && p.hop === 0 && p.via.by === 'field' && p.via.from === foundation),
  ).toBe(true);
  // The required contract is one hop in focus past the seat: tallied with its system's steward, never entered.
  expect(body.frontier).toEqual([
    {
      system: 'compliance-system',
      kind: 'contract',
      steward: 'agent-system/binding/agent/compliance-steward',
      count: 1,
    },
  ]);
  expect(body.pointers.some((p) => p.identity === contract)).toBe(false);
  // Budget 0 loads none of the six seeds the composition holds; each is a pointer.
  expect(body.counts).toEqual({
    composition: 6,
    seeds: 7,
    loaded: 1,
    rules: 0,
    pointers: 6,
    frontier: 1,
    truncatedLoaded: 6,
    truncatedPointers: 0,
  });
  // The conformance workspace declares no sources: no capture members, named, and no refusal.
  expect(body.unknowns).toEqual([
    expect.objectContaining({
      kind: 'sources',
      subject: foundation,
      message: expect.stringContaining('workspace declares no sources'),
    }),
  ]);
  expect(body.widening).toEqual({
    deeper: { shape: 'context', phase: 'orient', depth: 1, budget: 0 },
    reseat: { shape: 'context', phase: 'orient', depth: 1, budget: 16 },
  });
  expect(Object.isFrozen(body) && Object.isFrozen(body.pointers[0]!.via)).toBe(true);
});

it('gives equal keys byte-equal bodies, through every whole-workspace token and handle of one revision', () => {
  const root = workspace(),
    db = database(root),
    other = database(root);
  for (const [, partial] of Object.entries(GOLDEN)) {
    const first = JSON.stringify(bodyOf(db, db.resolveScope().token, partial));
    expect(JSON.stringify(bodyOf(db, db.resolveScope().token, partial))).toBe(first);
    expect(JSON.stringify(bodyOf(other, other.resolveScope().token, partial))).toBe(first);
  }
  // A token selecting every admitted identity reads the same records but is no whole-workspace scope (db PT5): its
  // body differs only by the `unread` note, in place of the admission findings it may not read.
  const every = db.resolveScope({ identities: db.records().map((r) => r.identity) }).token,
    whole = bodyOf(db, db.resolveScope().token),
    narrowed = bodyOf(db, every);
  expect(JSON.stringify({ ...narrowed, unknowns: whole.unknowns })).toBe(JSON.stringify(whole));
  expect(narrowed.unknowns).toEqual([...whole.unknowns, expect.objectContaining({ kind: 'unread' })]);
  // A key spelled with its defaults is the key they complete.
  const within = db.resolveScope().token;
  expect(
    JSON.stringify(bodyOf(db, within, { seat: lawId, shape: 'governance', phase: 'plan', depth: 1, budget: 16 })),
  ).toBe(JSON.stringify(bodyOf(db, within, { seat: lawId, shape: 'governance' })));
  expect(JSON.stringify(positionBody(db, within, resolveScopeKey(db, within, K0)))).toBe(
    JSON.stringify(bodyOf(db, within)),
  );
});

it('hops along the predicate focus in either direction, loading in the shape order and pointing out of focus', () => {
  const db = database(workspace()),
    within = db.resolveScope().token;
  // From the law, the check that enforces it is one `enforced-by` row away, declared by the law (the target).
  const governance = bodyOf(db, within, { seat: lawId, shape: 'governance' });
  expect(governance.loaded[1]).toMatchObject({
    identity: check,
    hop: 1,
    via: { by: 'row', from: lawId, predicate: 'enforce', spelling: 'enforced-by', declaredBy: 'target' },
  });
  // `cited-by` is out of the governance focus: a pointer, not a hop.
  expect(governance.pointers).toEqual([
    expect.objectContaining({ identity: procedure, via: expect.objectContaining({ predicate: 'cite' }) }),
  ]);
  // From the workspace, the sequence focus follows `requires` out to the contract; depth 2 finds nothing further.
  const sequence = bodyOf(db, within, { shape: 'sequence', depth: 2 });
  expect(ids(sequence.loaded)).toEqual([foundation, contract]);
  expect(sequence.frontier).toEqual([]);
  expect(sequence.widening.deeper).toBeUndefined();
  // The governance order puts prime first: the check, primed by `governs` from the contract, ranks before the
  // convention and principle a @system seat composes, which no row primes.
  const system = bodyOf(db, within, { seat: governanceSystem, shape: 'governance' });
  expect(ids(system.loaded)).toEqual([
    governanceSystem,
    check,
    'governance-system/governance/convention/sample-convention',
    'governance-system/governance/principle/sample-principle',
  ]);
  // The blocking law is reserved in rules, outside the budget, and is neither loaded nor a pointer.
  expect(ids(system.rules)).toEqual([lawId]);
  expect(system.pointers.some((p) => p.identity === lawId)).toBe(false);
  // A record keeps what first reached it: at depth 2 the check's `enforced-by` row reaches the seed law again, which
  // stays at hop 0 by word membership.
  expect(bodyOf(db, within, { seat: governanceSystem, shape: 'governance', depth: 2 }).rules).toEqual([
    expect.objectContaining({ identity: lawId, hop: 0, via: { by: 'word', system: 'governance-system' } }),
  ]);
  // The system's word members arrive by word membership, its steward by its head.steward field.
  expect(system.pointers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ identity: procedure, via: { by: 'word', system: 'governance-system' } }),
      expect.objectContaining({
        identity: 'agent-system/binding/agent/governance-steward',
        via: { by: 'field', from: governanceSystem, field: 'head.steward', direction: 'out' },
      }),
    ]),
  );
});

it('orders by the total keys: band, then hop, then lane, and in governance prime, band, hop, then sev', () => {
  // Band, then hop: with the floor's taxonomy @system composed too, the six local records at hop 0 and those one hop
  // out (band 100) load before the taxonomy at hop 0 (band 10), the first band-10 pointer.
  const composed = workspace(),
    text = readFileSync(resolve(composed, workspacePath), 'utf8');
  put(composed, workspacePath, text.replace('@system session-system]', '@system session-system, @system taxonomy]'));
  const db = database(composed),
    within = db.resolveScope().token,
    taxonomy = 'floor/definition/system/taxonomy';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const context = bodyOf(db, within, { shape: 'context' }),
    loaded = context.loaded.slice(1) as LoadedRecord[];
  expect(loaded.map((r) => [r.band, r.hop])).toEqual([...Array(6).fill([100, 0]), ...Array(10).fill([100, 1])]);
  expect(loaded).toContainEqual(expect.objectContaining({ identity: contract, hop: 1 }));
  expect(context.pointers.find((p) => p.band === 10)).toMatchObject({ identity: taxonomy, hop: 0 });
  const bands = context.pointers.map((p) => p.band);
  expect(bands).toEqual([...bands].sort((a, b) => b - a));
  // In governance prime leads: the contract the seat requires (primed by `governs`) points first, then by band.
  expect(ids(bodyOf(db, within, { shape: 'governance' }).pointers)).toEqual([
    contract,
    ...['agent-system', 'compliance-system', 'governance-system', 'session-system', 'workspace-system'].map(
      (name) => `floor/definition/system/${name}`,
    ),
    'workspace-system/definition/distribution/foundation-distribution',
    taxonomy,
  ]);

  // Lane: the foundation workspace capturing every authored record composes definitions and contracts alike at band
  // 100 and hop 0; the budget of 16 takes definitions only, and the contracts are pointers.
  const lanes = workspace();
  declare(lanes, ['.ia/src @authored']);
  const all = database(lanes),
    members = bodyOf(all, all.resolveScope().token, { shape: 'context' });
  expect(members.loaded.slice(1).map((e) => [(e as LoadedRecord).lane, (e as LoadedRecord).hop])).toEqual(
    Array(16).fill(['definitions', 0]),
  );
  expect(members.pointers).toContainEqual(
    expect.objectContaining({
      identity: contract,
      lane: 'contracts',
      hop: 0,
      via: expect.objectContaining({ by: 'membership' }),
    }),
  );

  // Sev, after prime, band and hop: among the laws no row primes, advisory before informational; among two records
  // primed by `enforce`, the seed at hop 0 before the check at hop 1 whatever their severities. Rules, two blocking
  // laws, take the governance order under every shape.
  const severities = workspace(),
    advisoryCheck = 'compliance-system/check/gate/advisory-check',
    blocking = 'governance-system/governance/law/a-block';
  for (const [name, severity, more] of [
    ['a-info', 'informational', ''],
    ['b-adv', 'advisory', ''],
    ['a-block', 'blocking', ''],
    ['e-info', 'informational', '  relationships\n    enforced-by @check advisory-check\n'],
  ] as const)
    put(severities, `${records}/${name}.ia`, law(name, severity, more));
  put(
    severities,
    '.ia/src/systems/compliance-system/checks/advisory-check.ia',
    '#! ia 1.0\n@check advisory-check\n  meaning\n    says "Fixture advisory check."\n    answers "What does it check?"\n  check\n    runs COMP-SCHEMA\n    scope "fixture"\n  governance\n    severity advisory\n',
  );
  const sev = database(severities),
    token = sev.resolveScope().token;
  expect(sev.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const ranked = bodyOf(sev, token, { seat: governanceSystem, shape: 'governance' });
  expect(ids(ranked.loaded)).toEqual([
    governanceSystem,
    check,
    'governance-system/governance/law/e-info',
    advisoryCheck,
    'governance-system/governance/convention/sample-convention',
    'governance-system/governance/law/b-adv',
    'governance-system/governance/principle/sample-principle',
    'governance-system/governance/law/a-info',
  ]);
  expect(ids(ranked.rules)).toEqual([lawId, blocking]);
  // Under context the law is one `cites` hop from the procedure and the row-less law at hop 0; prime still leads.
  const cited = bodyOf(sev, token, { seat: governanceSystem, shape: 'context' });
  expect(cited.rules.map((r) => [r.identity, r.hop])).toEqual([
    [lawId, 1],
    [blocking, 0],
  ]);
});

it('ranks an adopted record primed by a row before a local one no row primes, then local before adopted', () => {
  const root = workspace(null),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  put(
    root,
    '.ia/src/systems/workspace-system/records/local-workspace.ia',
    '#! ia 1.0\n@workspace local-workspace\n  meaning\n    says "The local boundary."\n    answers "What is local?"\n  composition\n    systems [@system governance-system]\n    sources [".ia/src @authored"]\n  relationships\n    requires @contract foundation-authoring-contract\n',
  );
  put(root, `${records}/local-rule.ia`, law('local-rule', 'advisory'));
  const db = database(root),
    within = db.resolveScope().token,
    local = 'workspace-system/definition/workspace/local-workspace';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  // The adopted contract (band 90) is primed by `governs`; the local law (band 100) and the adopted @system (band 90)
  // tie at prime 5, so band decides between them.
  const body = bodyOf(db, within, { seat: local, shape: 'governance', budget: 0 });
  expect(body.pointers.map((p) => [p.identity, p.band])).toEqual([
    [contract, 90],
    ['governance-system/governance/law/local-rule', 100],
    [governanceSystem, 90],
  ]);
});

it('seeds by the kind or the lane focus: an authority-facet contract seeds governance by lane, context by kind', () => {
  const root = workspace(),
    system = '.ia/src/systems/compliance-system/system.ia',
    complianceSystem = 'floor/definition/system/compliance-system',
    authority = 'compliance-system/contract/authority/authority-contract';
  put(
    root,
    system,
    readFileSync(resolve(root, system), 'utf8').replace('facets [signature]', 'facets [signature, authority]'),
  );
  put(
    root,
    '.ia/src/systems/compliance-system/contracts/authority-contract.ia',
    '#! ia 1.0\n@contract authority-contract\n  facet authority\n  version "0.1.0"\n  meaning\n    says "Fixture authority."\n    answers "What authority holds?"\n  relationships\n    governs @check instance-schema-check\n',
  );
  const db = database(root),
    within = db.resolveScope().token;
  // Admitted, though no case covers it.
  expect(db.refused).toEqual([]);
  const seeded = (shape: ScopeKey['shape']) => bodyOf(db, within, { seat: complianceSystem, shape });
  // Its kind, contract, is no governance kind, but its lane is a governance lane.
  expect(seeded('governance').loaded).toContainEqual(
    expect.objectContaining({
      identity: authority,
      lane: 'authority',
      hop: 0,
      via: { by: 'word', system: 'compliance-system' },
    }),
  );
  // Its lane is no context or sequence lane, but its kind is a kind of both.
  for (const shape of ['context', 'sequence'] as const)
    expect(seeded(shape).loaded, shape).toContainEqual(expect.objectContaining({ identity: authority, hop: 0 }));
  // Neither is in the execution focus: a composition record, not a seed, so a pointer.
  const execution = seeded('execution');
  expect(ids(execution.loaded)).not.toContain(authority);
  expect(execution.pointers).toContainEqual(
    expect.objectContaining({
      identity: authority,
      lane: 'authority',
      hop: 0,
      via: { by: 'word', system: 'compliance-system' },
    }),
  );
});

it('counts what the budget truncates and tallies the pointers past 48 per word and owner system', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    full = bodyOf(db, within, { seat: 'floor/definition/system/taxonomy', budget: 64 }),
    cut = bodyOf(db, within, { seat: 'floor/definition/system/taxonomy', budget: 3 });
  // |Σ ∪ C| beyond the seat: the taxonomy's word members and the kernel schemas it grounds one hop away.
  const candidates = full.counts.loaded - 1 + full.counts.truncatedLoaded;
  expect(candidates).toBeGreaterThan(64);
  expect(cut.counts.loaded).toBe(4);
  expect(cut.counts.truncatedLoaded).toBe(candidates - 3);
  // The truncated candidates are pointers: 48 listed, the rest tallied, every one counted once.
  expect(cut.counts.pointers).toBe(cut.counts.truncatedLoaded);
  expect(cut.pointers).toHaveLength(48);
  expect(cut.counts.truncatedPointers).toBe(cut.counts.pointers - 48);
  expect(cut.pointerTallies.reduce((sum, t) => sum + t.count, 0)).toBe(cut.counts.truncatedPointers);
  // One row per (owner system, word), several words of one system among them, sorted by system then word.
  expect(cut.pointerTallies.map((t) => [t.system, t.word, t.count])).toEqual([
    ['floor', 'schema', 14],
    ['taxonomy', 'lane', 6],
    ['taxonomy', 'move', 5],
    ['taxonomy', 'phase', 4],
    ['taxonomy', 'placement', 5],
    ['taxonomy', 'predicate', 18],
    ['taxonomy', 'primitive', 6],
    ['taxonomy', 'value-type', 6],
  ]);
  // The loaded records are the first of the shape's order, the listed pointers those after them.
  expect(ids(cut.loaded.slice(1))).toEqual(ids(full.loaded.slice(1, 4)));
  expect(ids(cut.pointers)).toEqual(ids(full.loaded.slice(4, 52)));
});

it('loads the seat plus only records of the word, follows other words as waypoints, and tallies only the word', () => {
  const root = workspace();
  declare(root, ['.ia/src @authored']);
  put(
    root,
    `${records}/advisory-rule.ia`,
    law('advisory-rule', 'advisory', '  relationships\n    enforced-by @check instance-schema-check\n'),
  );
  const many = Array.from({ length: 50 }, (_, i) => law(`many-${i}`, 'advisory').replace('#! ia 1.0\n', ''));
  put(root, `${records}/many-rules.ia`, `#! ia 1.0\n${many.join('\n')}`);
  const db = database(root),
    within = db.resolveScope().token,
    advisory = 'governance-system/governance/law/advisory-rule';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const words = (body: PositionBody) => [
    ...body.loaded.slice(1).map((e) => (e as LoadedRecord).word),
    ...body.rules.map((e) => e.word),
    ...body.pointers.map((p) => p.word),
    ...body.pointerTallies.map((t) => t.word),
  ];
  // The workspace's capture members of the word: the seat plus 16 laws loaded, the blocking one reserved.
  const members = bodyOf(db, within, { shape: 'governance', phase: 'act', word: 'law' });
  expect(members.loaded).toHaveLength(17);
  expect(members.loaded[0]).toMatchObject({ identity: foundation, word: 'workspace' });
  expect(new Set(words(members))).toEqual(new Set(['law']));
  expect(members.loaded.slice(1).every((e) => (e as LoadedRecord).via?.by === 'membership')).toBe(true);
  expect(ids(members.rules)).toEqual([lawId]);
  expect(members.counts).toMatchObject({ composition: 52, loaded: 17, rules: 1, pointers: 35, truncatedLoaded: 35 });
  // The same word at a @system seat, budget 0: 51 pointers, 48 listed and 3 tallied, all of them laws.
  const tallied = bodyOf(db, within, { seat: governanceSystem, shape: 'governance', budget: 0, word: 'law' });
  expect(ids(tallied.loaded)).toEqual([governanceSystem]);
  expect(new Set(words(tallied))).toEqual(new Set(['law']));
  expect(tallied.pointerTallies).toEqual([
    { system: 'governance-system', word: 'law', steward: 'agent-system/binding/agent/governance-steward', count: 3 },
  ]);
  // At depth 2 from the blocking law, the check is a waypoint: followed, never loaded or listed, and the advisory
  // law it enforces is loaded at hop 2.
  const waypoint = bodyOf(db, within, { seat: lawId, shape: 'governance', depth: 2, word: 'law' });
  expect(ids(waypoint.loaded)).toEqual([lawId, advisory]);
  expect(waypoint.loaded[1]).toMatchObject({ hop: 2, via: { by: 'row', from: check, predicate: 'enforce' } });
  expect([...ids(waypoint.pointers), ...ids(waypoint.loaded)]).not.toContain(check);
  // Unfiltered, the check and the contract it enforces are loaded, and the procedure citing the law is a pointer.
  const unfiltered = bodyOf(db, within, { seat: lawId, shape: 'governance', depth: 2 });
  expect(ids(unfiltered.loaded)).toEqual(expect.arrayContaining([lawId, check, contract, advisory]));
  expect(ids(unfiltered.pointers)).toContain(procedure);
  // The frontier counts only the word too: from the check at depth 0, the two laws it enforces, not the contract.
  expect(bodyOf(db, within, { seat: check, shape: 'governance', depth: 0, word: 'law' }).frontier).toEqual([
    {
      system: 'governance-system',
      kind: 'governance',
      steward: 'agent-system/binding/agent/governance-steward',
      count: 2,
    },
  ]);
  expect(bodyOf(db, within, { seat: check, shape: 'governance', depth: 0 }).frontier).toEqual([
    {
      system: 'compliance-system',
      kind: 'contract',
      steward: 'agent-system/binding/agent/compliance-steward',
      count: 1,
    },
    {
      system: 'governance-system',
      kind: 'governance',
      steward: 'agent-system/binding/agent/governance-steward',
      count: 2,
    },
  ]);
});

it('reserves a blocking law that claims a location seat through subject.covers alone, at budget 0', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, lawPath), 'utf8');
  put(
    root,
    lawPath,
    text.replace(
      '  relationships\n',
      '  subject\n    covers ["src/billing/**", ".ia/work/claimed/**"]\n  relationships\n',
    ),
  );
  const db = database(root),
    within = db.resolveScope().token,
    path = 'src/billing/invoice.ts';
  const body = bodyOf(db, within, { seat: { path }, shape: 'context', phase: 'orient', depth: 0, budget: 0 });
  expect(body.seat).toEqual({ kind: 'location', path });
  // The location is no record: it loads as its path, alone.
  expect(body.loaded).toEqual([{ path }]);
  expect(body.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      word: 'law',
      via: { by: 'claim', matches: [{ field: 'subject.covers', selection: 'src/billing/**' }] },
    }),
  ]);
  expect(body.pointers.some((p) => p.identity === lawId)).toBe(false);
  // The repository's workspace the path is declared at is composition too, a pointer at budget 0.
  expect(body.pointers).toEqual([
    expect.objectContaining({ identity: foundation, via: { by: 'declared-at', rule: 'repository' } }),
  ]);
  expect(body.counts).toMatchObject({ composition: 2, loaded: 1, rules: 1, pointers: 1 });
  // A path nothing claims or is declared at is an empty composition, named, with the workspace as the widening key.
  const nothing = bodyOf(db, within, { seat: { path: '.ia/work/notes' }, depth: 0, budget: 0 });
  expect(nothing.loaded).toEqual([{ path: '.ia/work/notes' }]);
  expect(nothing.counts.composition).toBe(0);
  expect(nothing.unknowns[0]).toEqual({
    kind: 'seat',
    subject: '.ia/work/notes',
    message: "no record claims '.ia/work/notes' and none is declared at it; widening key: the workspace",
  });
  // A path the law claims but no record is declared at: the claim is composition, and the seat's unknown is named.
  const claimed = bodyOf(db, within, { seat: { path: '.ia/work/claimed/note.md' }, depth: 0, budget: 0 });
  expect(claimed.rules).toEqual([
    expect.objectContaining({
      identity: lawId,
      via: { by: 'claim', matches: [{ field: 'subject.covers', selection: '.ia/work/claimed/**' }] },
    }),
  ]);
  expect(claimed.unknowns.filter((u) => u.kind === 'seat')).toEqual([
    {
      kind: 'seat',
      subject: '.ia/work/claimed/note.md',
      message: "no admitted record in this scope is declared at '.ia/work/claimed/note.md'",
    },
  ]);
});

it("never enters another workspace's root: a record there is a pointer naming that workspace", () => {
  const root = workspace();
  declare(root, ['.ia/src @authored']);
  put(
    root,
    '.ia/src/systems/workspace-system/records/compliance-workspace.ia',
    '#! ia 1.0\n@workspace compliance-workspace\n  meaning\n    says "The compliance records\' own boundary."\n    answers "Which roots does it capture?"\n  composition\n    systems [@system compliance-system]\n    sources [".ia/src/systems/compliance-system @authored"]\n',
  );
  const db = database(root),
    within = db.resolveScope().token,
    other = 'workspace-system/definition/workspace/compliance-workspace';
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const body = bodyOf(db, within, { seat: lawId, shape: 'governance' });
  // The law is the foundation workspace's member; the check that enforces it is the other workspace's.
  expect(ids(body.loaded)).toEqual([lawId]);
  expect(body.pointers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identity: check,
        hop: 1,
        workspace: other,
        via: expect.objectContaining({ predicate: 'enforce' }),
      }),
    ]),
  );
  // Never entered, the check is no hop from which the contract could be reached.
  expect(body.frontier).toEqual([]);
  expect(body.unknowns.some((u) => u.kind === 'sources')).toBe(false);
  // With the word law, the check is of another word outside the closure: neither entered nor listed.
  const laws = bodyOf(db, within, { seat: lawId, shape: 'governance', word: 'law' });
  expect([...ids(laws.loaded), ...ids(laws.pointers)]).toEqual([lawId]);
  // At the foundation workspace, the compliance-system @system its `composition.systems` names is composition of
  // the other workspace's root: a pointer naming it, at hop 0, never loaded or counted in the composition.
  const complianceSystem = 'floor/definition/system/compliance-system',
    seated = bodyOf(db, within, { seat: foundation, budget: 64 });
  expect(seated.pointers).toContainEqual(
    expect.objectContaining({
      identity: complianceSystem,
      hop: 0,
      workspace: other,
      via: { by: 'field', from: foundation, field: 'composition.systems', direction: 'out' },
    }),
  );
  expect(ids(seated.loaded)).not.toContain(complianceSystem);
  expect(seated.counts.composition).toBe(58);
  // A location in the compliance-system folder is declared at that @system, whose root the other workspace declares:
  // its closure is that workspace's, the @system its composition, and no sources unknown is named.
  const location = (shape: ScopeKey['shape']) =>
    bodyOf(db, within, { seat: { path: '.ia/src/systems/compliance-system/checks' }, shape });
  const governed = location('governance');
  expect(governed.unknowns).toEqual([]);
  expect(governed.counts.composition).toBe(1);
  expect(governed.pointers).toHaveLength(1);
  expect(governed.pointers[0]).toMatchObject({
    identity: complianceSystem,
    via: { by: 'declared-at', rule: 'system' },
  });
  expect(governed.pointers[0]!.workspace).toBeUndefined();
  expect(ids(location('context').loaded)).toContain(complianceSystem);
  // Two workspaces declaring roots leave the repository's own undecided: K0 is the empty composition, named.
  const k0 = bodyOf(db, within);
  expect(k0.seat).toEqual({ kind: 'workspace', unknown: 'undeclared' });
  expect(k0.loaded).toEqual([{ path: '' }]);
  expect(k0.counts).toMatchObject({ composition: 0, seeds: 1, loaded: 1, pointers: 0, frontier: 0 });
  expect(k0.unknowns.map((u) => u.kind)).toEqual(['seat']);
});

it('gives a seat no declared root holds no workspace: the fallback closure, named, its blocking law still reserved', () => {
  const root = workspace();
  // The repository's workspace declares only the workspace-system's folder: no root holds the governance-system.
  declare(root, ['.ia/src/systems/workspace-system @authored']);
  const db = database(root),
    within = db.resolveScope().token,
    fallback = expect.objectContaining({
      kind: 'sources',
      message: expect.stringContaining('no @workspace holds the seat'),
    });
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const system = bodyOf(db, within, { seat: governanceSystem, shape: 'governance' });
  expect(ids(system.rules)).toEqual([lawId]);
  expect(ids(system.loaded)).toEqual([
    governanceSystem,
    check,
    'governance-system/governance/convention/sample-convention',
    'governance-system/governance/principle/sample-principle',
  ]);
  expect(system.unknowns).toEqual([fallback]);
  expect(system.unknowns[0]!.subject).toBeUndefined();
  // The workspace's own records are the ones outside that closure, pointers naming it.
  expect(system.pointers).toContainEqual(expect.objectContaining({ identity: foundation, workspace: foundation }));
  // Seated at the law, the check that enforces it is entered.
  const atLaw = bodyOf(db, within, { seat: lawId, shape: 'governance' });
  expect(ids(atLaw.loaded)).toEqual([lawId, check]);
  expect(atLaw.unknowns).toEqual([fallback]);
  // The workspace itself keeps its closure: its capture members, no unknown.
  expect(bodyOf(db, within).unknowns).toEqual([]);
});

it('names the unresolved rows of a loaded record on a whole-workspace scope; a narrowed one says it reads none', () => {
  const root = workspace();
  put(
    root,
    `${records}/dangling-rule.ia`,
    law('dangling-rule', 'advisory', '  relationships\n    enforced-by @check missing-check\n'),
  );
  // In one file of two laws, the second's dangling row; a procedure row its system does not consent to; and a
  // mandate whose participant no admitted @agent is.
  put(
    root,
    `${records}/pair.ia`,
    `${law('first-rule', 'advisory')}\n${law('second-rule', 'advisory', '  relationships\n    enforced-by @check missing-check\n').replace('#! ia 1.0\n', '')}`,
  );
  put(root, methodPath, `${readFileSync(resolve(root, methodPath), 'utf8')}    forbids @law sample-rule\n`);
  put(
    root,
    '.ia/src/systems/agent-system/records/ghost-mandate.ia',
    '#! ia 1.0\n@mandate ghost-mandate\n  meaning\n    says "A mandate for no admitted agent."\n    answers "Whom does it bind?"\n  governance\n    requires "Fixture statement."\n  authority\n    participant @agent ghost-agent\n',
  );
  const db = database(root),
    within = db.resolveScope().token,
    dangling = 'governance-system/governance/law/dangling-rule';
  expect(db.refused).toEqual([]);
  const whole = bodyOf(db, within, { seat: dangling, shape: 'governance' });
  expect(whole.unknowns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'finding',
        subject: dangling,
        code: 'IA-GRAPH-TARGET-MISSING',
        path: `${records}/dangling-rule.ia`,
      }),
    ]),
  );
  const findings = (seat: string) =>
    bodyOf(db, within, { seat, shape: 'governance' })
      .unknowns.filter((u) => u.kind === 'finding')
      .map((u) => [u.subject, u.code]);
  expect(findings(procedure)).toEqual([[procedure, 'IA-GRAPH-EDGE-UNCONSENTED']]);
  expect(findings('agent-system/policy/mandate/ghost-mandate')).toEqual([
    ['agent-system/policy/mandate/ghost-mandate', 'IA-COMP-FIELD-REF-MISSING'],
  ]);
  // A finding is named on the loaded record whose span holds it, never on an earlier record of its file, and never
  // on a record that is only a pointer, as the procedure is at the law.
  expect(findings('governance-system/governance/law/second-rule')).toEqual([
    ['governance-system/governance/law/second-rule', 'IA-GRAPH-TARGET-MISSING'],
  ]);
  expect(findings('governance-system/governance/law/first-rule')).toEqual([]);
  const atLaw = bodyOf(db, within, { seat: lawId, shape: 'governance' });
  expect(atLaw.pointers).toContainEqual(expect.objectContaining({ identity: procedure }));
  expect(atLaw.unknowns.filter((u) => u.kind === 'finding')).toEqual([]);
  const narrowed = db.resolveScope({ identities: [dangling, check] }).token,
    body = bodyOf(db, narrowed, { seat: dangling, shape: 'governance' });
  expect(body.unknowns.filter((u) => u.kind === 'finding')).toEqual([]);
  expect(body.unknowns).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unread' })]));
});

it('reads only through an explicit scope token', () => {
  const db = database(workspace()),
    within = db.resolveScope().token,
    resolved = resolveScopeKey(db, within, K0);
  for (const token of ['', undefined])
    expect(() => positionBody(db, token as unknown as string, resolved)).toThrow(
      expect.objectContaining({ code: 'IA-RUNTIME-REQUEST-INVALID' }),
    );
  expect(() => positionBody(db, 'forged', resolved)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
  );
});
