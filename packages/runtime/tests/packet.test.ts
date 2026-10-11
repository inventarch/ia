import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CAPTURE_FORMAT, writeCapture } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { digest } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { SHAPE_ROWS } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { entryCount, position, renderPacket } from '../src/index.js';
import type { PacketCatalogRow, PacketOutput } from '../src/index.js';
import { database, declare, freshInit, packetFixture, put, workspace } from './workspace.js';

// R19 (position-and-projection §4 and items 11 and 12; plan amendments B1 to B5 and B8): the position packet. The golden
// packet is regenerated only by `node packages/runtime/tests/golden/write.mjs`, which sets IA_POSITION_GOLDEN=write for
// the golden cases alone; its diff is reviewed with the change that makes it.
const fixture = packetFixture,
  repository = resolve(import.meta.dirname, '../../..'),
  demo = 'workspace-system/definition/workspace/demo',
  participant = 'agent-system/binding/agent/demo',
  mandate = (name: string) => `agent-system/policy/mandate/${name}`,
  system = (name: string) => `floor/definition/system/${name}`,
  NONE = 'none (no authored @mandate names an @agent)';
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
/**
 * A catalog fixture with the shape of the CLI's seven rows (apps/cli packetCatalog): the runtime takes the catalog as
 * data and imports no app (B2), so the rows the CLI builds are pinned in apps/cli.
 */
const CATALOG: readonly PacketCatalogRow[] = [
  { command: 'ia init', mode: 'effect', move: 'Execution', refuses: 'a target already initialized', next: 'ia init' },
  { command: 'ia validate', mode: 'validate', move: 'Verification', refuses: 'no .ia/src', next: 'ia init' },
  { command: 'ia capture', mode: 'effect', move: 'Execution', refuses: 'no @workspace', next: 'ia init' },
  { command: 'ia read', mode: 'read', move: 'Observation', refuses: 'an unadmitted locator', next: 'ia inspect' },
  { command: 'ia position', mode: 'read', move: 'Observation', refuses: 'an unadmitted seat', next: 'ia position' },
  { command: 'ia next', mode: 'read', move: 'Observation', refuses: 'several plans', next: 'ia next --seat <plan>' },
  { command: 'ia project', mode: 'effect', move: 'Execution', refuses: 'an unmarked file', next: 'ia project <host>' },
];
const render = (db: Handle, catalog: readonly PacketCatalogRow[] = CATALOG): PacketOutput =>
  renderPacket(db, db.resolveScope().token, catalog);
const errors = (db: Handle) => db.report.findings.filter((finding) => finding.severity === 'error');
/** A fixture @agent and a fixture @mandate in the shape of the fresh init's (B13), `authority` the mandate's fields. */
const agent = (name: string): string =>
  `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;
const authorized = (name: string, authority: readonly string[]): string =>
  `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
/** The names the references of a record's `authority.<key>` state, read from its sections as authored. */
const authorityNames = (node: Node, key: string): readonly string[] =>
  node.sections
    .filter((section) => section.name === 'authority')
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.key === key ? (field.value.kind === 'list' ? field.value.items : [field.value]) : [],
    )
    .flatMap((value) => (value.kind === 'ref' ? [value.name] : []));
/**
 * B1's formula, its terms counted from the records the scope admits rather than from the packet's sections: N the
 * references the seat's `composition.systems` states, T the words of the band-100 membership rows under the seat's own
 * declared roots, and P and M the band-100 @mandate records scoped to the seat whose participant is a band-100 @agent,
 * and those agents.
 */
function formula(db: Handle, catalog: number): number {
  const records = db.records(),
    seat = db.get(db.resolveSeat('').seat!)!,
    authored = records.filter((node) => node.band === 100);
  const systems = seat.sections
    .filter((section) => section.name === 'composition')
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.key === 'systems' && field.value.kind === 'list' ? field.value.items : [],
    );
  const agents = new Set(authored.filter((node) => node.discriminator === 'agent').map((node) => node.name));
  const mandates = authored.filter(
    (node) =>
      node.discriminator === 'mandate' &&
      authorityNames(node, 'scope').includes(seat.name) &&
      agents.has(authorityNames(node, 'participant')[0] ?? ''),
  );
  const participants = new Set(mandates.map((node) => authorityNames(node, 'participant')[0]));
  const own = new Set(
      db
        .roots()
        .filter((root) => root.workspace === seat.identity)
        .map((root) => root.root),
    ),
    words = new Map(authored.map((node) => [node.identity, node.discriminator]));
  const tallies = new Set(
    db
      .snapshot()
      .membership.filter((row) => own.has(row.root) && words.has(row.identity))
      .map((row) => words.get(row.identity)),
  );
  return participants.size + mandates.length + 1 + systems.length + tallies.size + 5 + 4 + catalog + 1 + 3;
}

it('matches the golden packet of a fresh init and pins its entry count, the revision and body asserted apart', () => {
  const db = database(freshInit()),
    within = db.resolveScope().token,
    output = renderPacket(db, within, CATALOG),
    { packet, digest: packetDigest } = output,
    k0 = position(db, within);
  expect(packet.revision).toBe(db.revision);
  expect(packet.provenance.revision).toBe(db.revision);
  expect(packet.body).toBe(k0.digest);
  expect(packetDigest).toBe(digest(packet));
  const file = resolve(import.meta.dirname, 'golden', 'packet-fresh-init.json'),
    text = `${JSON.stringify(
      {
        ...packet,
        revision: '<revision>',
        body: '<body digest>',
        provenance: { ...packet.provenance, revision: '<revision>' },
      },
      null,
      2,
    )}\n`;
  if (process.env['IA_POSITION_GOLDEN'] === 'write') writeFileSync(file, text);
  else expect(text).toBe(readFileSync(file, 'utf8'));
  // P = M = 1, N = 11, T = 3 (workspace, agent, mandate) and C = 7, the milestone's final catalog (B1: 26 + N).
  expect([packet.participants.length, packet.mandates.length, packet.systems.length, packet.tallies.length]).toEqual([
    1, 1, 11, 3,
  ]);
  expect(entryCount(packet)).toBe(37);
  expect(entryCount(packet)).toBe(formula(db, CATALOG.length));
  // The output is frozen whole, and its intent rows are copies: the kernel's rows are not the packet's to freeze.
  expect([Object.isFrozen(output), Object.isFrozen(packet), Object.isFrozen(packet.intents[0]!.kinds)]).toEqual([
    true,
    true,
    true,
  ]);
  expect(packet.intents[0]!.kinds).toEqual(SHAPE_ROWS.context.kinds);
  expect(packet.intents[0]!.kinds).not.toBe(SHAPE_ROWS.context.kinds);
});

it('holds the entry formula on the conformance corpus and on this repository, counted from their records', () => {
  for (const [name, root] of [
    ['conformance', workspace()],
    ['repository', repository],
  ] as const) {
    const db = database(root),
      { packet } = render(db);
    expect(packet.systems.length, name).toBe(packet.seat.systems);
    expect(entryCount(packet), name).toBe(formula(db, CATALOG.length));
    // B1's pinned counts under the seven-row catalog: the conformance corpus (P = M = T = 0, N = 5) and this repository
    // (P = M = 1, N = 11, T = 22), whose committed CLAUDE.md renders the same 56 (tools/projections/generate.test.ts).
    expect(entryCount(packet), name).toBe(name === 'conformance' ? 26 : 56);
    // The host note is no entry, and the formula does not read the catalog's contents.
    expect(entryCount(render(db, []).packet), name).toBe(entryCount(packet) - CATALOG.length);
  }
  // The conformance corpus declares no root, so its seat has no capture member and no tally, as body(K0) says.
  const db = database(workspace()),
    { packet } = render(db);
  expect(packet.seat).toEqual({
    identity: 'workspace-system/definition/workspace/foundation-workspace',
    sources: [],
    systems: 5,
    participants: NONE,
  });
  expect(packet.tallies).toEqual([]);
  expect(position(db, db.resolveScope().token).body.unknowns).toContainEqual(
    expect.objectContaining({ kind: 'sources', message: expect.stringContaining('has no capture members') }),
  );
  // A declared root narrower than the corpus tallies its own members alone, by word.
  const narrower = workspace();
  declare(narrower, ['.ia/src/systems/workspace-system @authored']);
  const declared = database(narrower),
    tallied = render(declared).packet;
  expect(errors(declared)).toEqual([]);
  expect(tallied.seat.sources).toEqual(['.ia/src/systems/workspace-system @authored']);
  expect(tallied.tallies).toEqual([
    { word: 'agent', count: 1 },
    { word: 'distribution', count: 1 },
    { word: 'schema', count: 2 },
    { word: 'system', count: 1 },
    { word: 'workspace', count: 1 },
  ]);
  expect(entryCount(tallied)).toBe(formula(declared, CATALOG.length));
});

it('renders a workspace with no participant with no participant entry and no refusal', () => {
  // The conformance corpus's sample mandate names a participant but scopes no workspace, so body(K0) lists none.
  const none = render(database(workspace())).packet;
  expect([none.participants, none.mandates]).toEqual([[], []]);
  expect(none.seat.participants).toBe(NONE);
  // A mandate scoped to the seat whose participant is an adopted @agent (band 90) names no authored participant.
  const adopted = freshInit(
    readFileSync(fixture, 'utf8').replace('participant @agent demo', 'participant @agent agent-steward'),
  );
  const { packet } = render(database(adopted));
  expect([packet.participants, packet.mandates]).toEqual([[], []]);
  expect(packet.seat.participants).toBe(NONE);
  expect(entryCount(packet)).toBe(35);
  // With one, the seat line names no `none` and the participant is read through the scope.
  const one = render(database(freshInit())).packet;
  expect(one.seat).toEqual({
    identity: demo,
    sources: ['.ia/src @authored'],
    systems: 11,
    steward: participant,
  });
  expect(one.participants).toEqual([
    { identity: participant, says: 'The IDE agent operating in the demo workspace, any vendor.' },
  ]);
});

it('renders two participants named by three mandates by identity, each agent once, each mandate as authored', () => {
  // The second agent sorts after demo while its mandate sorts first, so neither order is the order mandates name them.
  const db = database(
    freshInit(
      `${readFileSync(fixture, 'utf8')}${agent('zed')}${authorized('zz-mandate', [
        'participant @agent demo',
        'moves [Observation]',
        'scope [@workspace demo]',
        'excluded-words [schema]',
        'covers ["src/"]',
      ])}${authorized('aa-mandate', ['participant @agent zed', 'scope [@workspace demo]'])}`,
    ),
  );
  expect(errors(db)).toEqual([]);
  const { packet } = render(db);
  expect(packet.participants.map((entry) => entry.identity)).toEqual([participant, 'agent-system/binding/agent/zed']);
  expect(packet.mandates).toEqual([
    { identity: mandate('aa-mandate'), participant: 'agent-system/binding/agent/zed', scope: [demo] },
    {
      identity: mandate('demo-mandate'),
      participant,
      moves: ['Observation', 'Verification', 'Synthesis', 'Delegation', 'Execution'],
      scope: [demo],
    },
    {
      identity: mandate('zz-mandate'),
      participant,
      moves: ['Observation'],
      scope: [demo],
      excludedWords: ['schema'],
      covers: ['src/'],
    },
  ]);
  expect(packet.seat.participants).toBeUndefined();
  expect(entryCount(packet)).toBe(40);
  expect(entryCount(packet)).toBe(formula(db, CATALOG.length));
});

it('renders an admitted mandate as authored, never refusing it: a declared empty move list, fragment references', () => {
  const text = readFileSync(fixture, 'utf8');
  for (const [name, records, fields] of [
    [
      'moves []',
      text.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', 'moves []'),
      { moves: [] },
    ],
    [
      'fragments',
      text
        .replace('participant @agent demo', 'participant @agent demo#meaning')
        .replace('scope [@workspace demo]', 'scope [@workspace demo#meaning]'),
      { moves: ['Observation', 'Verification', 'Synthesis', 'Delegation', 'Execution'] },
    ],
  ] as const) {
    const db = database(freshInit(records)),
      within = db.resolveScope().token;
    expect(errors(db), name).toEqual([]);
    expect(
      position(db, within).body.mandates.map((pointer) => pointer.identity),
      name,
    ).toEqual([mandate('demo-mandate')]);
    const { packet } = renderPacket(db, within, CATALOG);
    expect(packet.mandates, name).toEqual([
      { identity: mandate('demo-mandate'), participant, ...fields, scope: [demo] },
    ]);
    expect(
      packet.participants.map((entry) => entry.identity),
      name,
    ).toEqual([participant]);
    expect(entryCount(packet), name).toBe(formula(db, CATALOG.length));
  }
});

it('leaves out an adopted mandate scoped to the seat, which body(K0) lists', () => {
  const db = database(
      freshInit(undefined, {
        '.ia/src/shipped.ia': `#! ia 1.0\n${authorized('shipped-mandate', ['participant @agent demo', 'scope [@workspace demo]'])}`,
      }),
    ),
    within = db.resolveScope().token;
  expect(errors(db)).toEqual([]);
  expect(position(db, within).body.mandates.map((pointer) => [pointer.identity, pointer.band])).toEqual([
    [mandate('demo-mandate'), 100],
    [mandate('shipped-mandate'), 90],
  ]);
  const { packet } = renderPacket(db, within, CATALOG);
  expect(packet.mandates.map((entry) => entry.identity)).toEqual([mandate('demo-mandate')]);
  expect(entryCount(packet)).toBe(formula(db, CATALOG.length));
});

it('gives byte-equal packets and digests at two absolute roots, with no root or token in the packet', () => {
  const at = [freshInit(), freshInit()].map((root) => {
    const db = database(root),
      within = db.resolveScope().token,
      output = renderPacket(db, within, CATALOG),
      text = JSON.stringify(output.packet);
    expect(text).not.toContain(within);
    for (const spelling of [root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\')])
      expect(text).not.toContain(spelling);
    return { text, digest: output.digest };
  });
  expect(at[0]!.text).toBe(at[1]!.text);
  expect(at[0]!.digest).toBe(at[1]!.digest);
});

it("takes packet.body and the seat from one position at K0, read through the caller's token", () => {
  const db = database(freshInit()),
    within = db.resolveScope().token,
    k0 = position(db, within),
    { packet } = renderPacket(db, within, CATALOG);
  expect(packet.body).toBe(k0.digest);
  expect(packet.revision).toBe(k0.body.revision);
  expect(packet.seat.identity).toBe(k0.body.seat.identity);
  expect(packet.mandates.map((entry) => entry.identity)).toEqual(k0.body.mandates.map((pointer) => pointer.identity));
  // The catalog is copied in its order, each row's five fields only.
  const extra = CATALOG.map((row) => ({ ...row, summary: 'not in the packet' }));
  expect(renderPacket(db, within, extra).packet.commands).toEqual(CATALOG);
  expect(() => renderPacket(db, '', CATALOG)).toThrow(expect.objectContaining({ code: 'IA-RUNTIME-REQUEST-INVALID' }));
  expect(() => renderPacket(db, 'forged', CATALOG)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
  );
});

it('reads every section through a narrowed token: what it leaves out is unresolved, or no entry', () => {
  const db = database(freshInit()),
    left = [system('work-system'), participant],
    narrowed = db.resolveScope({
      identities: db
        .records()
        .map((node) => node.identity)
        .filter((identity) => !left.includes(identity)),
    }).token,
    k0 = position(db, narrowed),
    { packet } = renderPacket(db, narrowed, CATALOG);
  expect(packet.body).toBe(k0.digest);
  // The @system outside the scope is a reference no admitted record answers; the participant @agent is none, so its
  // mandate, which body(K0) still lists, is no entry, and the seat's steward is the reference as authored.
  expect(k0.body.mandates.map((pointer) => pointer.identity)).toEqual([mandate('demo-mandate')]);
  expect(packet.systems).toContainEqual({
    identity: '@system work-system',
    words: 'unresolved',
    steward: 'unresolved',
  });
  expect(packet.systems.map((line) => line.identity)).not.toContain(system('work-system'));
  expect([packet.participants, packet.mandates]).toEqual([[], []]);
  expect(packet.seat).toEqual({
    identity: demo,
    sources: ['.ia/src @authored'],
    systems: 11,
    steward: '@agent demo',
    participants: NONE,
  });
  expect(packet.tallies).toEqual([
    { word: 'mandate', count: 1 },
    { word: 'workspace', count: 1 },
  ]);
  // The whole-workspace token reads both.
  const whole = render(db).packet;
  expect(whole.participants.map((entry) => entry.identity)).toEqual([participant]);
  expect(whole.systems).toContainEqual(expect.objectContaining({ identity: system('work-system'), band: 90 }));
});

it('moves only the host note when a capture is written: the packet and its digest stay', () => {
  const root = freshInit(),
    db = database(root),
    before = render(db);
  expect(before.hostNote).toEqual({
    revision: db.revision,
    freshness: 'no-capture',
    key: { shape: 'context', phase: 'orient', depth: 0, budget: 0 },
    installed: 'unknown (no join checked here)',
  });
  writeCapture(
    root,
    `${JSON.stringify({ format: CAPTURE_FORMAT, revision: db.revision, membership: db.snapshot().membership })}\n`,
  );
  db.refresh();
  const after = render(db);
  expect(after.hostNote).toMatchObject({ capturedRevision: db.revision, freshness: 'current' });
  expect(after.hostNote).not.toEqual(before.hostNote);
  expect(JSON.stringify(after.packet)).toBe(JSON.stringify(before.packet));
  expect(after.digest).toBe(before.digest);
});

it('prints a composition.systems reference no admitted record answers as unresolved, and orders the lines by identity', () => {
  // Authored out of order: workspace-system first and the unresolved reference last.
  const root = freshInit(
    readFileSync(fixture, 'utf8')
      .replace('[@system agent-composition-system,', '[@system workspace-system, @system agent-composition-system,')
      .replace(', @system work-system, @system workspace-system]', ', @system work-system, @system zz-missing-system]'),
  );
  const { packet } = render(database(root));
  expect(packet.seat.systems).toBe(12);
  expect(packet.systems.map((line) => line.identity)).toEqual([
    '@system zz-missing-system',
    ...[
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
    ].map(system),
  ]);
  expect(packet.systems[0]).toEqual({
    identity: '@system zz-missing-system',
    words: 'unresolved',
    steward: 'unresolved',
  });
  expect(packet.systems[2]).toEqual({
    identity: system('agent-system'),
    words: ['agent', 'mandate'],
    band: 90,
    steward: 'agent-system/binding/agent/agent-steward',
    reach: `ia position --seat ${system('agent-system')}`,
  });
});

it('reads a @system at runtime placement as no admitted record: its line is unresolved', () => {
  const db = database(workspace(), { locations: { '.ia/src/systems/session-system/system.ia': RUNTIME } }),
    { packet } = render(db);
  expect(db.records().find((node) => node.identity === system('session-system'))?.band).toBe(0);
  // The conformance seat authors its five systems out of identity order.
  expect(packet.systems.map((line) => line.identity)).toEqual([
    '@system session-system',
    system('agent-system'),
    system('compliance-system'),
    system('governance-system'),
    system('workspace-system'),
  ]);
  expect(packet.systems[0]).toEqual({ identity: '@system session-system', words: 'unresolved', steward: 'unresolved' });
  expect(render(database(workspace())).packet.systems).toContainEqual(
    expect.objectContaining({ identity: system('session-system'), band: 100 }),
  );
});

it('renders a repository root no admitted @workspace is declared at with no seat identity, line, tally or slug', () => {
  // Two workspaces declaring roots leave the repository's own undecided (R14): K0's seat is unknown, not refused.
  const root = workspace();
  declare(root, ['.ia/src @authored']);
  put(
    root,
    '.ia/src/systems/workspace-system/records/compliance-workspace.ia',
    '#! ia 1.0\n@workspace compliance-workspace\n  meaning\n    says "The compliance records\' own boundary."\n    answers "Which roots does it capture?"\n  composition\n    systems [@system compliance-system]\n    sources [".ia/src/systems/compliance-system @authored"]\n',
  );
  const db = database(root),
    within = db.resolveScope().token;
  expect(errors(db)).toEqual([]);
  expect(position(db, within).body.seat).toEqual({ kind: 'workspace', unknown: 'undeclared' });
  const { packet } = renderPacket(db, within, CATALOG);
  expect(packet.seat).toEqual({ sources: [], systems: 0, participants: NONE });
  expect([packet.participants, packet.mandates, packet.systems, packet.tallies]).toEqual([[], [], [], []]);
  expect(packet.provenance).toEqual({ revision: db.revision });
  expect(entryCount(packet)).toBe(1 + 5 + 4 + CATALOG.length + 1 + 3);
});

it('tables the five shapes and the four phases, each shape with the registered words it seeds', () => {
  const root = workspace(),
    { packet } = render(database(root));
  expect(packet.intents.map((row) => [row.shape, row.primitive, row.phase])).toEqual([
    ['context', 'Attention', 'orient'],
    ['governance', 'Inference', 'plan'],
    ['execution', 'Decision', 'act'],
    ['sequence', 'Inference', 'plan'],
    ['learning', 'Learning', 'learn'],
  ]);
  const seeded = (shape: string) => packet.intents.find((row) => row.shape === shape)!.words;
  // The floor's two words: @system lowers to definition, @schema to contract.
  expect(seeded('context')).toEqual(expect.arrayContaining(['system', 'schema', 'workspace', 'contract']));
  expect(seeded('governance')).toEqual(['check', 'convention', 'law', 'mandate', 'principle']);
  expect(seeded('learning')).not.toContain('schema');
  // A word with an authority facet is seeded under governance by its lane, as a position seeds its records (R15).
  const compliance = '.ia/src/systems/compliance-system/system.ia';
  put(
    root,
    compliance,
    readFileSync(resolve(root, compliance), 'utf8').replace('facets [signature]', 'facets [signature, authority]'),
  );
  expect(render(database(root)).packet.intents.find((row) => row.shape === 'governance')!.words).toContain('contract');
  expect(packet.phases.map((row) => [row.phase, row.primitives])).toEqual([
    ['orient', ['Memory', 'Attention']],
    ['plan', ['Inference']],
    ['act', ['Decision', 'Escalation']],
    ['learn', ['Learning']],
  ]);
  expect(packet.lines).toEqual([
    'run ia position; if it refuses, run the command it names',
    'state intent to the CLI as shape + optional phase + optional seat + optional word; the CLI never receives free text',
    "when a word's owner is not this workspace, delegate by re-seating at the owning system; a steward pointer is readable, not an invocation",
  ]);
});
