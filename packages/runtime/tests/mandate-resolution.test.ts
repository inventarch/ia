import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Handle } from '@inventarch/db';
import type { Location } from '@inventarch/language';
import {
  MODES,
  admissionReport,
  RuntimeError,
  isAdmissionRefusal,
  defaultActor,
  governingMandates,
  position,
  profileRefusal,
  refusedDependencies,
  refusedMandates,
  requireMandatesAdmitted,
  renderPacket,
  seatedWorkspace,
} from '../src/index.js';
import type { GoverningMandate, GoverningOptions, Mode } from '../src/index.js';
import { database, freshInit, packetFixture, put, workspace } from './workspace.js';

// Plan amendment C1 and operator decision OD1 (milestone generation-binding, task mandate-resolution): the authored
// @mandate records that govern an actor at a workspace or path, the default actor, and the refusal profile their moves
// and excluded words give a mode. Amendment C2 (OD2): this repository's participant may make all five moves.
const repository = resolve(import.meta.dirname, '../../..'),
  demo = 'workspace-system/definition/workspace/demo',
  participant = 'agent-system/binding/agent/demo',
  zed = 'agent-system/binding/agent/zed',
  ops = 'agent-system/binding/agent/ops',
  mandate = (name: string) => `agent-system/policy/mandate/${name}`,
  governance = (seat: string) => `ia position --seat ${seat} --shape governance`,
  ALL = ['Observation', 'Verification', 'Synthesis', 'Delegation', 'Execution'],
  ALL_MOVES = 'moves [Observation, Verification, Synthesis, Delegation, Execution]',
  STEWARD = '    steward @agent demo\n',
  SCOPE = '    scope [@workspace demo]\n',
  UNGOVERNED = 'no authored @mandate governs here, so no move or word is restricted (a mandate only adds restrictions)';
const RUNTIME: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
/** The three records a fresh init authors (B13): the demo workspace, its steward participant and its mandate. */
const records = readFileSync(packetFixture, 'utf8'),
  /** The fresh init's three records without the mandate, the last of them. */
  unmandated = records.slice(0, records.indexOf('\n@mandate demo-mandate'));
/** A fixture @agent and a fixture @mandate in the shape of the fresh init's, `authority` the mandate's fields. */
const agent = (name: string): string =>
  `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;
const authorized = (name: string, authority: readonly string[]): string =>
  `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
const errors = (db: Handle) => db.report.findings.filter((finding) => finding.severity === 'error');
const token = (db: Handle): string => db.resolveScope().token;
/** The profile `mode` meets at the demo workspace for its default actor, resolved as the CLI resolves it. */
function profileAt(db: Handle, mode: Mode, words?: readonly string[]) {
  const within = token(db),
    { actor } = defaultActor(db, within, demo),
    options: GoverningOptions = { ...(actor === undefined ? {} : { actor }), workspace: demo };
  return profileRefusal(governingMandates(db, within, options), mode, words);
}
const identities = (db: Handle, options: GoverningOptions = {}): readonly string[] =>
  governingMandates(db, token(db), options).map((entry) => entry.identity);
/** Each governing mandate with whether it binds `options.actor`. */
const bound = (db: Handle, options: GoverningOptions): readonly (readonly [string, boolean | undefined])[] =>
  governingMandates(db, token(db), options).map((entry) => [entry.identity, entry.binds] as const);
/** Governing mandates in the position packet's mandate shape (B3), which names no band and binds no actor. */
const asPacket = (entries: readonly GoverningMandate[]) =>
  entries.map(({ band: _band, binds: _binds, ...entry }) => entry);

it("resolves a fresh init's participant as the default actor, its mandate as governing, and allows every mode", () => {
  const db = database(freshInit()),
    within = token(db);
  expect(errors(db)).toEqual([]);
  const actor = defaultActor(db, within, demo);
  expect(actor).toEqual({ actor: participant, by: 'steward', participants: [participant], actors: [participant] });
  expect(Object.isFrozen(actor)).toBe(true);
  const governing = governingMandates(db, within, { actor: participant, workspace: demo });
  expect(governing).toEqual([
    { identity: mandate('demo-mandate'), band: 100, participant, binds: true, moves: ALL, scope: [demo] },
  ]);
  expect(Object.isFrozen(governing)).toBe(true);
  expect(Object.isFrozen(governing[0]!.scope)).toBe(true);
  for (const mode of MODES) {
    const verdict = profileRefusal(governing, mode);
    expect(verdict, mode).toEqual({});
    expect(Object.isFrozen(verdict), mode).toBe(true);
  }
  // Without an actor, the workspace's mandates are the packet's, as it lists them at K0.
  const packet = renderPacket(db, within, []).packet;
  expect(asPacket(governingMandates(db, within, { workspace: demo }))).toEqual(packet.mandates);
  expect(actor.participants).toEqual(packet.participants.map((entry) => entry.identity));
  // The installed base is adopted at band 90: its sample-mandate claims docs/** but, not authored, governs nothing.
  expect(db.resolveSeat('docs/guide.md').claimants.map((claimant) => [claimant.identity, claimant.band])).toEqual([
    [mandate('sample-mandate'), 90],
  ]);
  expect(identities(db, { path: 'docs/guide.md' })).toEqual([]);
  expect(identities(db)).toEqual([mandate('demo-mandate')]);
  // Without a steward the workspace's one participant is the default actor, once however many mandates name it.
  const unstewarded = database(
    freshInit(
      `${records.replace(STEWARD, '')}${authorized('second-demo-mandate', ['participant @agent demo', 'moves [Observation]', 'scope [@workspace demo]'])}`,
    ),
  );
  expect(errors(unstewarded)).toEqual([]);
  expect(defaultActor(unstewarded, token(unstewarded), demo)).toEqual({
    actor: participant,
    by: 'participant',
    participants: [participant],
    actors: [participant],
  });
  for (const mode of MODES) expect(profileAt(unstewarded, mode), mode).toEqual({});
});

it("refuses effect (ia capture) without Execution, naming the mandate's governance position, whose key resolves", () => {
  const db = database(
    freshInit(records.replace(ALL_MOVES, 'moves [Observation, Verification, Synthesis, Delegation]')),
  );
  expect(errors(db)).toEqual([]);
  expect(profileAt(db, 'effect')).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-MOVE',
      message: `${mandate('demo-mandate')} allows Observation, Verification, Synthesis, Delegation; effect needs Execution`,
      next: governance(mandate('demo-mandate')),
    },
  });
  for (const mode of MODES.filter((mode) => mode !== 'effect')) expect(profileAt(db, mode), mode).toEqual({});
  // The next command's key seats at the mandate in the governance shape.
  expect(position(db, token(db), { seat: mandate('demo-mandate'), shape: 'governance' }).body.seat.identity).toBe(
    mandate('demo-mandate'),
  );
});

it('governs a path through authority.covers, an authored claimant only, and says which mandates bind the actor', () => {
  const db = database(
    freshInit(
      `${records}${agent('zed')}${authorized('docs-mandate', [
        'participant @agent demo',
        'moves [Observation, Synthesis]',
        'covers ["docs/"]',
      ])}${authorized('zed-mandate', ['participant @agent zed', 'moves [Observation]', 'covers ["docs/guide.md"]'])}`,
    ),
  );
  expect(errors(db)).toEqual([]);
  // The trailing `/` selects the subtree (graph G06c); the adopted sample-mandate's docs/** claim is left out.
  expect(identities(db, { path: 'docs/guide.md' })).toEqual([mandate('docs-mandate'), mandate('zed-mandate')]);
  expect(identities(db, { path: 'docs/other.md' })).toEqual([mandate('docs-mandate')]);
  expect(identities(db, { path: 'src/index.ts' })).toEqual([]);
  expect(identities(db, { path: '../outside.md' })).toEqual([]);
  // An actor drops no mandate that governs the path: each says whether it binds the actor.
  expect(bound(db, { actor: participant, path: 'docs/guide.md' })).toEqual([
    [mandate('docs-mandate'), true],
    [mandate('zed-mandate'), false],
  ]);
  expect(bound(db, { actor: zed, path: 'docs/guide.md' })).toEqual([
    [mandate('docs-mandate'), false],
    [mandate('zed-mandate'), true],
  ]);
  // A workspace and a path: either one suffices. Without the path, a mandate that only covers paths does not govern.
  expect(bound(db, { actor: participant, workspace: demo, path: 'docs/guide.md' })).toEqual([
    [mandate('demo-mandate'), true],
    [mandate('docs-mandate'), true],
    [mandate('zed-mandate'), false],
  ]);
  expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(identities(db, { workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(bound(db, { actor: zed })).toEqual([
    [mandate('demo-mandate'), false],
    [mandate('docs-mandate'), false],
    [mandate('zed-mandate'), true],
  ]);
  expect(identities(db)).toEqual([mandate('demo-mandate'), mandate('docs-mandate'), mandate('zed-mandate')]);
  const within = token(db);
  expect(governingMandates(db, within, { path: 'docs/guide.md' })).toEqual([
    {
      identity: mandate('docs-mandate'),
      band: 100,
      participant,
      moves: ['Observation', 'Synthesis'],
      scope: [],
      covers: ['docs/'],
    },
    {
      identity: mandate('zed-mandate'),
      band: 100,
      participant: zed,
      moves: ['Observation'],
      scope: [],
      covers: ['docs/guide.md'],
    },
  ]);
  // Its profile: each actor's own mandates are judged; a move any of them grants is allowed, one none grants refused.
  const docs = governingMandates(db, within, { actor: participant, path: 'docs/guide.md' });
  expect(profileRefusal(docs, 'author')).toEqual({});
  expect(profileRefusal(docs, 'effect').refusal).toEqual({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: `${mandate('docs-mandate')} allows Observation, Synthesis; effect needs Execution`,
    next: governance(mandate('docs-mandate')),
  });
  // One participant's mandate never grants another a move: zed is held to its own.
  expect(profileRefusal(governingMandates(db, within, { actor: zed, path: 'docs/guide.md' }), 'author')).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-MOVE',
      message: `${mandate('zed-mandate')} allows Observation; author needs Synthesis`,
      next: governance(mandate('zed-mandate')),
    },
  });
  const both = governingMandates(db, within, { actor: participant, workspace: demo, path: 'docs/guide.md' });
  for (const mode of MODES) expect(profileRefusal(both, mode), mode).toEqual({});
  // zed is no participant of the workspace (its mandate scopes none), so the steward stays the default actor.
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [participant],
    actors: [participant],
  });
});

it('refuses an actor that no mandate governing the workspace binds, rather than read it as ungoverned', () => {
  const db = database(
      freshInit(
        `${records.replace(STEWARD, '    steward @agent ops\n').replace(ALL_MOVES, 'moves [Observation]')}${agent('ops')}`,
      ),
    ),
    within = token(db);
  expect(errors(db)).toEqual([]);
  // The steward names the actor, whether or not it is a participant.
  expect(defaultActor(db, within, demo)).toEqual({
    actor: ops,
    by: 'steward',
    participants: [participant],
    actors: [participant, ops],
  });
  expect(governingMandates(db, within, { actor: ops, workspace: demo })).toEqual([
    { identity: mandate('demo-mandate'), band: 100, participant, binds: false, moves: ['Observation'], scope: [demo] },
  ]);
  for (const mode of MODES)
    expect(profileAt(db, mode), mode).toEqual({
      refusal: {
        code: 'IA-RUNTIME-MANDATE-ACTOR',
        message: `no mandate that governs here binds the acting @agent: ${mandate('demo-mandate')} binds ${participant}`,
        next: governance(mandate('demo-mandate')),
      },
    });
  // Without an actor the workspace's mandate is judged; where no mandate claims the path, nothing is restricted.
  expect(profileRefusal(governingMandates(db, within, { workspace: demo }), 'read')).toEqual({});
  expect(profileRefusal(governingMandates(db, within, { workspace: demo }), 'author').refusal!.code).toBe(
    'IA-RUNTIME-MANDATE-MOVE',
  );
  expect(profileRefusal(governingMandates(db, within, { actor: ops, path: 'docs/guide.md' }), 'author')).toEqual({
    notice: UNGOVERNED,
  });
});

it('reads only the closure of the workspace, as position does: another root never governs or names a participant', () => {
  const root = freshInit(records.replace(STEWARD, '').replace(ALL_MOVES, 'moves [Observation]'));
  put(
    root,
    '.ia/src/other/other.ia',
    `#! ia 1.0\n\n@workspace other\n  meaning\n    says "Another workspace."\n    answers "Which sources make up the other workspace?"\n  composition\n    systems [@system agent-system]\n    sources [".ia/src/other @authored"]\n${agent('zed')}${authorized(
      'zed-mandate',
      ['participant @agent zed', 'moves [Observation]', 'scope [@workspace demo]'],
    )}${authorized('widening-mandate', ['participant @agent demo', 'moves [Execution]', 'scope [@workspace demo]'])}`,
  );
  const db = database(root),
    within = token(db);
  expect(errors(db)).toEqual([]);
  expect(db.snapshot({ within }).membership.find((row) => row.identity === mandate('zed-mandate'))!.root).toBe(
    '.ia/src/other',
  );
  // The governance position the refusals name lists the same mandates.
  const seated = position(db, within, { seat: demo, shape: 'governance' }).body;
  expect(seated.mandates.map((pointer) => pointer.identity)).toEqual([mandate('demo-mandate')]);
  expect(identities(db, { workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'participant',
    participants: [participant],
    actors: [participant],
  });
  // The other root's mandate naming demo widens nothing, and zed, bound by none of demo's mandates, is refused.
  expect(profileAt(db, 'effect').refusal).toMatchObject({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    next: governance(mandate('demo-mandate')),
  });
  expect(profileRefusal(governingMandates(db, within, { actor: zed, workspace: demo }), 'read').refusal!.code).toBe(
    'IA-RUNTIME-MANDATE-ACTOR',
  );
});

it('reads for a path alone the closure of the workspace position seats it in, though the repository has none', () => {
  const root = freshInit('#! ia 1.0\n');
  put(
    root,
    '.ia/src/demo/workspace.ia',
    records
      .replace('sources [".ia/src @authored"]', 'sources [".ia/src/demo @authored"]')
      .replace(ALL_MOVES, 'moves [Observation]')
      .replace(SCOPE, `${SCOPE}    covers [".ia/src/"]\n`),
  );
  put(
    root,
    '.ia/src/other/other.ia',
    `#! ia 1.0\n\n@workspace other\n  meaning\n    says "Another workspace."\n    answers "Which sources make up the other workspace?"\n  composition\n    systems [@system agent-system]\n    sources [".ia/src/other @authored"]\n${agent('zed')}${authorized(
      'zed-mandate',
      ['participant @agent zed', 'moves [Observation]', 'covers [".ia/src/"]'],
    )}`,
  );
  const db = database(root),
    within = token(db),
    own = '.ia/src/demo/workspace.ia',
    other = '.ia/src/other/other.ia';
  expect(errors(db)).toEqual([]);
  // Two workspaces declare roots under .ia/src, so neither is the repository's own (db D02b).
  expect(db.resolveSeat('', { within }).seat).toBeUndefined();
  // Both mandates claim both paths; each governs only in its own workspace's closure, as position lists them.
  for (const [path, governing] of [
    [own, mandate('demo-mandate')],
    [other, mandate('zed-mandate')],
  ] as const) {
    expect(db.resolveSeat(path, { within }).claimants.map((claimant) => claimant.identity)).toEqual([
      mandate('demo-mandate'),
      mandate('zed-mandate'),
    ]);
    expect(
      position(db, within, { seat: { path }, shape: 'governance' }).body.mandates.map((pointer) => pointer.identity),
      path,
    ).toEqual([governing]);
    expect(identities(db, { path }), path).toEqual([governing]);
  }
  // So the participant's own mandate restricts it at its own path, rather than read the path as ungoverned.
  expect(profileRefusal(governingMandates(db, within, { actor: participant, path: own }), 'author')).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-MOVE',
      message: `${mandate('demo-mandate')} allows Observation; author needs Synthesis`,
      next: governance(mandate('demo-mandate')),
    },
  });
  expect(bound(db, { actor: zed, path: own })).toEqual([[mandate('demo-mandate'), false]]);
  expect(identities(db, { path: own, workspace: demo })).toEqual([mandate('demo-mandate')]);
});

it('folds a path and each covers selection with `fold`, as the edit guard does where the volume folds names', () => {
  const db = database(
    freshInit(
      `${records}${authorized('docs-mandate', ['participant @agent demo', 'moves [Synthesis]', 'covers ["Docs/"]'])}`,
    ),
  );
  expect(errors(db)).toEqual([]);
  const lower = (text: string): string => text.toLowerCase();
  // Without `fold` the dialect matches case-sensitively: `Docs/` claims neither `docs/x.md` nor `DOCS/x.md`.
  for (const path of ['docs/x.md', 'DOCS/x.md']) expect(identities(db, { path }), path).toEqual([]);
  expect(identities(db, { path: 'Docs/x.md' })).toEqual([mandate('docs-mandate')]);
  // With it, every spelling the key folds alike is claimed, and `binds` is still the actor's.
  for (const path of ['docs/x.md', 'DOCS/x.md', 'Docs/x.md'])
    expect(bound(db, { path, fold: lower, actor: participant }), path).toEqual([[mandate('docs-mandate'), true]]);
  expect(identities(db, { path: 'documents/x.md', fold: lower })).toEqual([]);
  expect(() => governingMandates(db, token(db), { path: 'docs/x.md', fold: 'lower' as never })).toThrow(
    'fold must be a function',
  );
});

it('governs wherever its participant acts a mandate that states neither scope nor covers, with or without a steward', () => {
  const located = records.replace(SCOPE, '').replace(ALL_MOVES, 'moves [Observation]'),
    loose = authorized('loose-mandate', ['moves [Observation]']);
  const db = database(freshInit(`${located}${agent('zed')}${loose}`)),
    within = token(db);
  expect(errors(db)).toEqual([]);
  expect(governingMandates(db, within, { actor: participant, workspace: demo })).toEqual([
    { identity: mandate('demo-mandate'), band: 100, participant, binds: true, moves: ['Observation'], scope: [] },
  ]);
  expect(identities(db, { actor: participant, path: 'src/index.ts' })).toEqual([mandate('demo-mandate')]);
  expect(profileAt(db, 'read')).toEqual({});
  expect(profileAt(db, 'author').refusal).toEqual({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: `${mandate('demo-mandate')} allows Observation; author needs Synthesis`,
    next: governance(mandate('demo-mandate')),
  });
  // It locates no other actor, and one that names no participant either governs only where no location is asked.
  expect(identities(db, { actor: zed, workspace: demo })).toEqual([]);
  expect(identities(db, { workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(identities(db)).toEqual([mandate('demo-mandate'), mandate('loose-mandate')]);
  // Without a steward it names no participant of the workspace, yet governs the actorless profile alike.
  const unstewarded = database(freshInit(located.replace(STEWARD, '')));
  expect(defaultActor(unstewarded, token(unstewarded), demo).actor).toBeUndefined();
  expect(profileAt(unstewarded, 'author').refusal!.code).toBe('IA-RUNTIME-MANDATE-MOVE');
});

it('locates nothing by a declared empty scope or covers, so an empty list never lifts a restriction', () => {
  for (const empty of ['    scope []\n', '    covers []\n']) {
    const db = database(freshInit(records.replace(SCOPE, empty).replace(ALL_MOVES, 'moves [Observation]'))),
      within = token(db);
    expect(errors(db)).toEqual([]);
    // Located by its participant alone, as when it states neither key: it governs the workspace and a path alike.
    expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
    expect(identities(db, { actor: participant, path: 'src/index.ts' })).toEqual([mandate('demo-mandate')]);
    expect(governingMandates(db, within, { actor: participant, workspace: demo })).toHaveLength(1);
    expect(profileAt(db, 'author').refusal!.code).toBe('IA-RUNTIME-MANDATE-MOVE');
  }
});

it("never pools two participants' mandates without an actor, refusing rather than granting either's moves", () => {
  const db = database(
      freshInit(
        `${records.replace(STEWARD, '').replace(SCOPE, '').replace(ALL_MOVES, 'moves [Observation]')}${agent('zed')}${authorized(
          'zed-mandate',
          ['participant @agent zed', 'moves [Synthesis, Execution]'],
        )}`,
      ),
    ),
    within = token(db);
  expect(errors(db)).toEqual([]);
  // Neither mandate is scoped to the workspace, so it has no participant and no default actor, yet both govern.
  expect(defaultActor(db, within, demo).actor).toBeUndefined();
  expect(identities(db, { workspace: demo })).toEqual([mandate('demo-mandate'), mandate('zed-mandate')]);
  for (const mode of MODES)
    expect(profileAt(db, mode), mode).toEqual({
      refusal: {
        code: 'IA-RUNTIME-MANDATE-ACTOR',
        message: `the mandates that govern here bind 2 participants and name no acting @agent: ${mandate('demo-mandate')} binds ${participant}; ${mandate('zed-mandate')} binds ${zed}`,
        next: governance(mandate('demo-mandate')),
      },
    });
  // Named, each actor is held to its own mandate alone.
  const zeds = governingMandates(db, within, { actor: zed, workspace: demo });
  expect(zeds.map((entry) => [entry.identity, entry.binds])).toEqual([[mandate('zed-mandate'), true]]);
  expect(profileRefusal(zeds, 'author')).toEqual({});
  expect(profileRefusal(zeds, 'read').refusal!.message).toBe(
    `${mandate('zed-mandate')} allows Synthesis, Execution; read needs Observation`,
  );
  expect(
    profileRefusal(governingMandates(db, within, { actor: participant, workspace: demo }), 'author').refusal!.code,
  ).toBe('IA-RUNTIME-MANDATE-MOVE');
});

it('binds whoever acts a mandate that names no participant, and judges it without an actor too', () => {
  const houseRules = authorized('house-rules', [
    'moves [Observation]',
    'scope [@workspace demo]',
    'excluded-words [hook]',
  ]);
  const refused = {
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: `${mandate('house-rules')} allows Observation; author needs Synthesis`,
    next: governance(mandate('house-rules')),
  };
  const stewarded = database(freshInit(`${unmandated}${houseRules}`)),
    within = token(stewarded);
  expect(errors(stewarded)).toEqual([]);
  expect(defaultActor(stewarded, within, demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [],
    actors: [participant],
  });
  expect(governingMandates(stewarded, within, { actor: participant, workspace: demo })).toEqual([
    {
      identity: mandate('house-rules'),
      band: 100,
      binds: true,
      moves: ['Observation'],
      scope: [demo],
      excludedWords: ['hook'],
    },
  ]);
  expect(profileAt(stewarded, 'author').refusal).toEqual(refused);
  expect(profileAt(stewarded, 'read', ['hook']).refusal!.code).toBe('IA-RUNTIME-MANDATE-WORD');
  // With no participant and no steward there is no actor and no refusal, but the mandate still governs.
  for (const participantLine of [[], ['participant @agent ghost']]) {
    const unstewarded = database(
      freshInit(
        `${unmandated.replace(STEWARD, '')}${authorized('house-rules', [...participantLine, 'moves [Observation]', 'scope [@workspace demo]'])}`,
      ),
    );
    expect(errors(unstewarded)).toEqual([]);
    expect(defaultActor(unstewarded, token(unstewarded), demo)).toEqual({
      participants: [],
      actors: [],
      reason: `${demo} states no composition.steward, and no authored @mandate scoped to it names an authored @agent as its participant`,
    });
    expect(profileAt(unstewarded, 'read')).toEqual({});
    expect(profileAt(unstewarded, 'author').refusal).toEqual(refused);
  }
});

it('names no default actor while several participants and no steward leave the choice open, and refuses with it', () => {
  const several = `${records.replace(STEWARD, '')}${agent('zed')}${authorized('zed-mandate', [
    'participant @agent zed',
    'moves [Observation]',
    'scope [@workspace demo]',
  ])}`;
  const db = database(freshInit(several)),
    within = token(db);
  expect(errors(db)).toEqual([]);
  const reason = `${demo} states no composition.steward, and its authored mandates name 2 participants (${participant}, ${zed}): name one of them as its composition.steward`;
  const actor = defaultActor(db, within, demo);
  expect(actor).toEqual({
    participants: [participant, zed],
    actors: [participant, zed],
    reason,
    refusal: { code: 'IA-RUNTIME-MANDATE-ACTOR', message: reason, next: governance(demo) },
  });
  expect(Object.isFrozen(actor.refusal)).toBe(true);
  // The next command's key seats at the workspace, whose mandates name both participants.
  const seated = position(db, within, { seat: demo, shape: 'governance' }).body;
  expect(seated.seat.identity).toBe(demo);
  expect(seated.mandates.map((pointer) => pointer.identity)).toEqual([mandate('demo-mandate'), mandate('zed-mandate')]);
  // Without an actor every mandate scoped to the workspace governs; with one, each says whether it binds it.
  expect(identities(db, { workspace: demo })).toEqual([mandate('demo-mandate'), mandate('zed-mandate')]);
  expect(bound(db, { actor: zed, workspace: demo })).toEqual([
    [mandate('demo-mandate'), false],
    [mandate('zed-mandate'), true],
  ]);
  // The steward names the actor among them.
  const stewarded = database(freshInit(several.replace('    sources [".ia/src @authored"]\n', `$&${STEWARD}`)));
  expect(defaultActor(stewarded, token(stewarded), demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [participant, zed],
    actors: [participant, zed],
  });
  // A steward that resolves to no admitted @agent names none; the reason says so rather than that none is stated.
  const dangling = database(
    freshInit(several.replace('    sources [".ia/src @authored"]\n', '$&    steward @agent ghost\n')),
  );
  expect(errors(dangling)).toEqual([]);
  expect(defaultActor(dangling, token(dangling), demo).reason).toBe(
    `${demo}'s composition.steward resolves to no admitted @agent, and its authored mandates name 2 participants (${participant}, ${zed}): name one of them as its composition.steward`,
  );
  // With no mandate, no participant and no steward there is no actor and nothing to refuse: the notice.
  const none = database(freshInit(unmandated.replace(STEWARD, '')));
  expect(errors(none)).toEqual([]);
  expect(defaultActor(none, token(none), demo)).toEqual({
    participants: [],
    actors: [],
    reason: `${demo} states no composition.steward, and no authored @mandate scoped to it names an authored @agent as its participant`,
  });
  for (const mode of MODES) expect(profileAt(none, mode), mode).toEqual({ notice: UNGOVERNED });
});

it('counts only an authored steward as the default actor, and lists it among the actors (review C2-R1)', () => {
  // The adopted corpus's agent-steward is an installed (band 90) @agent: as composition.steward it names no actor, and
  // the choice falls to the participants, as if the workspace named no steward.
  const installed = 'agent-system/binding/agent/agent-steward',
    INSTALLED = '    steward @agent agent-steward\n',
    unnamed = `${demo}'s composition.steward ${installed} is no authored @agent`;
  const db = database(freshInit(records.replace(STEWARD, INSTALLED))),
    within = token(db);
  expect(errors(db)).toEqual([]);
  expect(db.records().find((record) => record.identity === installed)!.band).toBe(90);
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'participant',
    participants: [participant],
    actors: [participant],
  });
  const several = database(
    freshInit(
      `${records.replace(STEWARD, INSTALLED)}${agent('zed')}${authorized('zed-mandate', [
        'participant @agent zed',
        'moves [Observation]',
        'scope [@workspace demo]',
      ])}`,
    ),
  );
  const reason = `${unnamed}, and its authored mandates name 2 participants (${participant}, ${zed}): name one of them as its composition.steward`;
  expect(defaultActor(several, token(several), demo)).toEqual({
    participants: [participant, zed],
    actors: [participant, zed],
    reason,
    refusal: { code: 'IA-RUNTIME-MANDATE-ACTOR', message: reason, next: governance(demo) },
  });
  const none = database(freshInit(unmandated.replace(STEWARD, INSTALLED)));
  expect(defaultActor(none, token(none), demo)).toEqual({
    participants: [],
    actors: [],
    reason: `${unnamed}, and no authored @mandate scoped to it names an authored @agent as its participant`,
  });
  // An authored steward is the default actor and one of the actors --actor may name, participant or not.
  const authored = database(freshInit(`${records.replace(STEWARD, '    steward @agent ops\n')}${agent('ops')}`));
  expect(defaultActor(authored, token(authored), demo)).toEqual({
    actor: ops,
    by: 'steward',
    participants: [participant],
    actors: [participant, ops],
  });
});

it('counts only the authored participants of authored mandates', () => {
  const db = database(
      freshInit(
        `${records.replace(STEWARD, '')}${agent('zed')}${authorized('adopted-agent-mandate', [
          'participant @agent agent-steward',
          'moves [Observation]',
          'scope [@workspace demo]',
        ])}`,
        {
          '.ia/src/vendored.ia': `#! ia 1.0\n${authorized('vendored-mandate', ['participant @agent zed', 'moves [Observation]', 'scope [@workspace demo]'])}`,
        },
      ),
    ),
    within = token(db);
  expect(errors(db)).toEqual([]);
  expect(db.records().find((record) => record.identity === mandate('vendored-mandate'))!.band).toBe(90);
  // Neither the adopted agent-steward nor zed, named only by an adopted mandate, is a participant of the workspace.
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'participant',
    participants: [participant],
    actors: [participant],
  });
  expect(governingMandates(db, within, { actor: participant, workspace: demo })).toEqual([
    {
      identity: mandate('adopted-agent-mandate'),
      band: 100,
      participant: 'agent-system/binding/agent/agent-steward',
      binds: false,
      moves: ['Observation'],
      scope: [demo],
    },
    { identity: mandate('demo-mandate'), band: 100, participant, binds: true, moves: ALL, scope: [demo] },
  ]);
  for (const mode of MODES) expect(profileAt(db, mode), mode).toEqual({});
});

it('restricts nothing and says so when no mandate governs', () => {
  const db = database(freshInit(unmandated)),
    within = token(db);
  expect(errors(db)).toEqual([]);
  // The steward is still the default actor; no mandate names it.
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [],
    actors: [participant],
  });
  expect(governingMandates(db, within, { actor: participant, workspace: demo })).toEqual([]);
  for (const mode of MODES) {
    expect(profileAt(db, mode), mode).toEqual({ notice: UNGOVERNED });
    expect(profileAt(db, mode, ['schema']), mode).toEqual({ notice: UNGOVERNED });
  }
});

it('resolves what a workspace with admission errors admits', () => {
  const root = freshInit(
    `${records.replace(ALL_MOVES, 'moves [Observation, Verification]')}${authorized('ghost-mandate', [
      'participant @agent ghost',
      'moves [Observation]',
      'covers ["docs/"]',
    ])}`,
  );
  put(
    root,
    '.ia/src/broken.ia',
    '#! ia 1.0\n\n@task broken\n  meaning\n    says "A task admission refuses."\n  work\n    title "Broken"\n    status bogus\n',
  );
  const db = database(root),
    within = token(db);
  expect(errors(db).length).toBeGreaterThan(0);
  expect(db.refused.map((record) => record.identity)).toContain('work-system/definition/task/broken');
  expect(defaultActor(db, within, demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [participant],
    actors: [participant],
  });
  expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(profileAt(db, 'validate')).toEqual({});
  expect(profileAt(db, 'author').refusal).toMatchObject({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    next: governance(mandate('demo-mandate')),
  });
  // An admitted mandate whose participant resolves to no admitted @agent keeps the reference as authored.
  const ghost = governingMandates(db, within, { path: 'docs/guide.md' });
  expect(ghost.map((entry) => [entry.identity, entry.participant])).toEqual([
    [mandate('ghost-mandate'), '@agent ghost'],
  ]);
});

it('judges excluded words only when words are given, after the move', () => {
  const db = database(freshInit(records.replace(`    ${ALL_MOVES}\n`, `$&    excluded-words [schema, hook]\n`)));
  expect(errors(db)).toEqual([]);
  expect(governingMandates(db, token(db), { workspace: demo })[0]!.excludedWords).toEqual(['schema', 'hook']);
  expect(profileAt(db, 'author')).toEqual({});
  expect(profileAt(db, 'author', [])).toEqual({});
  expect(profileAt(db, 'author', ['task'])).toEqual({});
  expect(profileAt(db, 'author', ['task', 'hook', 'schema'])).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-WORD',
      message: `${mandate('demo-mandate')} excludes hook, schema`,
      next: governance(mandate('demo-mandate')),
    },
  });
  expect(profileAt(db, 'validate', ['schema']).refusal!.code).toBe('IA-RUNTIME-MANDATE-WORD');
  // A declared empty list is stated, as the packet renders it; each scope reference is resolved once, or kept.
  const stated = database(
    freshInit(
      records.replace(
        SCOPE,
        '    scope [@workspace ghost, @workspace demo, @workspace demo]\n    excluded-words []\n    covers []\n',
      ),
    ),
  );
  expect(errors(stated)).toEqual([]);
  const governing = governingMandates(stated, token(stated), { workspace: demo });
  expect(governing).toEqual([
    {
      identity: mandate('demo-mandate'),
      band: 100,
      participant,
      moves: ALL,
      scope: ['@workspace ghost', demo],
      covers: [],
      excludedWords: [],
    },
  ]);
  expect(asPacket(governing)).toEqual(renderPacket(stated, token(stated), []).packet.mandates);
  expect(profileRefusal(governing, 'author', ['hook'])).toEqual({});
});

it('judges any number of mandates: any one grants a move, any one excludes a word, the first named is next', () => {
  const a = 'agent-system/policy/mandate/a',
    b = 'agent-system/policy/mandate/b';
  // A mandate that declares no moves grants every one.
  for (const mode of MODES)
    expect(profileRefusal([{ identity: a, moves: ['Observation'] }, { identity: b }], mode)).toEqual({});
  expect(
    profileRefusal(
      [
        { identity: a, moves: ['Observation'] },
        { identity: b, moves: ['Verification', 'Execution'] },
      ],
      'author',
    ),
  ).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-MOVE',
      message: `${a} allows Observation; ${b} allows Verification, Execution; author needs Synthesis`,
      next: governance(a),
    },
  });
  expect(
    profileRefusal(
      [
        { identity: a, moves: ['Synthesis'] },
        { identity: b, moves: ['Observation'], excludedWords: ['law', 'hook'] },
      ],
      'author',
      ['hook', 'law'],
    ),
  ).toEqual({
    refusal: { code: 'IA-RUNTIME-MANDATE-WORD', message: `${b} excludes hook, law`, next: governance(b) },
  });
  expect(
    profileRefusal(
      [
        { identity: a, excludedWords: ['hook'] },
        { identity: b, excludedWords: ['law'] },
      ],
      'read',
      ['law', 'hook'],
    ).refusal,
  ).toEqual({ code: 'IA-RUNTIME-MANDATE-WORD', message: `${a} excludes hook; ${b} excludes law`, next: governance(a) });
  // A mandate that binds another participant grants and excludes nothing; when every one does, the actor is refused.
  expect(
    profileRefusal(
      [
        { identity: a, participant: 'agent/x', binds: false },
        { identity: b, moves: ['Observation'], binds: true },
      ],
      'author',
    ).refusal!.message,
  ).toBe(`${b} allows Observation; author needs Synthesis`);
  expect(
    profileRefusal(
      [
        { identity: a, binds: false, excludedWords: ['hook'] },
        { identity: b, binds: true },
      ],
      'author',
      ['hook'],
    ),
  ).toEqual({});
  expect(
    profileRefusal(
      [
        { identity: a, participant: 'agent/x', binds: false },
        { identity: b, binds: false },
      ],
      'read',
    ),
  ).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-ACTOR',
      message: `no mandate that governs here binds the acting @agent: ${a} binds agent/x; ${b}`,
      next: governance(a),
    },
  });
  // Two participants' mandates are never pooled; one participant's several, and those naming none, are.
  expect(
    profileRefusal(
      [
        { identity: a, moves: ['Observation'] },
        { identity: b, participant: 'agent/x', moves: ['Synthesis'] },
        { identity: 'agent-system/policy/mandate/c', participant: 'agent/y' },
      ],
      'author',
    ),
  ).toEqual({
    refusal: {
      code: 'IA-RUNTIME-MANDATE-ACTOR',
      message: `the mandates that govern here bind 2 participants and name no acting @agent: ${b} binds agent/x; agent-system/policy/mandate/c binds agent/y`,
      next: governance(b),
    },
  });
  expect(
    profileRefusal(
      [
        { identity: a, moves: ['Observation'] },
        { identity: b, participant: 'agent/x', moves: ['Synthesis'] },
        { identity: 'agent-system/policy/mandate/c', participant: 'agent/x', moves: ['Execution'] },
      ],
      'author',
    ),
  ).toEqual({});
  // The move is judged before the words.
  expect(
    profileRefusal([{ identity: a, moves: ['Observation'], excludedWords: ['hook'] }], 'author', ['hook']).refusal!
      .code,
  ).toBe('IA-RUNTIME-MANDATE-MOVE');
  // An unknown mode is refused before anything is read, and every declared move list is judged, bound or not.
  expect(() => profileRefusal([], 'invented' as Mode)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  expect(() => profileRefusal([{ identity: a }, { identity: b, moves: [], binds: false }], 'read')).toThrow(
    'authority.moves must name at least one kernel move',
  );
  // A compiled @mandate is read through mandateAuthorityOf.
  const sample = database(workspace())
    .records()
    .find((record) => record.discriminator === 'mandate' && record.name === 'sample-mandate')!;
  expect(profileRefusal([sample], 'author').refusal).toEqual({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: `${sample.identity} allows Observation, Verification; author needs Synthesis`,
    next: governance(sample.identity),
  });
  expect(profileRefusal([sample], 'read', ['hook']).refusal!.code).toBe('IA-RUNTIME-MANDATE-WORD');
});

it('reads only through its scope token, never at runtime placement, and refuses what it cannot read', () => {
  const path = '.ia/src/runtime-mandate.ia',
    root = freshInit();
  put(
    root,
    path,
    `#! ia 1.0\n${authorized('runtime-mandate', ['participant @agent demo', 'scope [@workspace demo]'])}`,
  );
  const authored = database(root);
  expect(identities(authored, { actor: participant, workspace: demo })).toEqual([
    mandate('demo-mandate'),
    mandate('runtime-mandate'),
  ]);
  const placed = database(root, { locations: { [path]: RUNTIME } });
  expect(placed.records().some((record) => record.identity === mandate('runtime-mandate'))).toBe(true);
  expect(identities(placed, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  // A steward at runtime placement is no actor: the participant is the default actor, and the steward no admitted one.
  const steward = '.ia/src/runtime-agent.ia',
    rt = 'agent-system/binding/agent/rt',
    runtimeSteward = freshInit(records.replace(STEWARD, '    steward @agent rt\n'));
  put(runtimeSteward, steward, `#! ia 1.0\n${agent('rt')}`);
  const stewardPlaced = database(runtimeSteward, { locations: { [steward]: RUNTIME } }),
    stewardWithin = token(stewardPlaced);
  expect(errors(stewardPlaced)).toEqual([]);
  expect(stewardPlaced.records().find((record) => record.identity === rt)!.band).toBe(0);
  expect(defaultActor(stewardPlaced, stewardWithin, demo)).toEqual({
    actor: participant,
    by: 'participant',
    participants: [participant],
    actors: [participant],
  });
  expect(() => governingMandates(stewardPlaced, stewardWithin, { actor: rt })).toThrow(
    `'${rt}' is not an admitted @agent`,
  );
  // A narrowed scope reads only what it admits.
  const narrowed = authored.resolveScope({ identities: [demo, participant] }).token;
  expect(governingMandates(authored, narrowed, { actor: participant, workspace: demo })).toEqual([]);
  expect(defaultActor(authored, narrowed, demo)).toEqual({
    actor: participant,
    by: 'steward',
    participants: [],
    actors: [participant],
  });
  // A missing token, or an actor or workspace that is not an admitted record of its word, is refused; an unknown
  // token keeps its database code.
  expect(() => governingMandates(authored, '')).toThrow('IA-RUNTIME-REQUEST-INVALID');
  expect(() => defaultActor(authored, '', demo)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  expect(() => governingMandates(authored, 'forged')).toThrow(
    expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
  );
  expect(() => defaultActor(authored, 'forged', demo)).toThrow(
    expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
  );
  const within = token(authored);
  expect(() => governingMandates(authored, within, { actor: demo })).toThrow(`'${demo}' is not an admitted @agent`);
  expect(() => governingMandates(authored, within, { workspace: participant })).toThrow(
    `'${participant}' is not an admitted @workspace`,
  );
  expect(() => defaultActor(authored, within, 'workspace-system/definition/workspace/absent')).toThrow(
    'IA-RUNTIME-REQUEST-INVALID',
  );
  // A governing admitted mandate whose authority mandateAuthorityOf refuses (a child under `authority.moves`, which
  // admission admits) is refused, located as data; one that does not govern is never read.
  const malformed = database(
    freshInit(
      `${records}${agent('zed')}${authorized('zed-mandate', ['participant @agent zed', 'moves [Observation]', '  note x', 'covers ["src/"]'])}`,
    ),
  );
  expect(errors(malformed)).toEqual([]);
  expect(identities(malformed, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  expect(() => governingMandates(malformed, token(malformed), { path: 'src/index.ts' })).toThrow(
    expect.objectContaining({
      code: 'IA-RUNTIME-REQUEST-INVALID',
      message: `IA-RUNTIME-REQUEST-INVALID: ${mandate('zed-mandate')}: authority.moves must be an unconditional inline value`,
      where: { path: '.ia/src/workspace.ia', line: 37, identity: mandate('zed-mandate') },
    }),
  );
  // A stated `moves []` fails admission now (compliance C05), so it is never read: every resolver fails closed instead.
  const emptied = database(
    freshInit(
      `${records}${agent('zed')}${authorized('zed-mandate', ['participant @agent zed', 'moves []', 'covers ["src/"]'])}`,
    ),
  );
  expect(errors(emptied).map((finding) => [finding.code, finding.line])).toEqual([['IA-COMP-FIELD-VALUE', 45]]);
  expect(() => governingMandates(emptied, token(emptied), { actor: participant, workspace: demo })).toThrow(
    expect.objectContaining({
      code: 'IA-RUNTIME-REQUEST-INVALID',
      where: { path: '.ia/src/workspace.ia', line: 37, identity: mandate('zed-mandate') },
    }),
  );
});

it("resolves this repository's participant as its default actor, granted all five moves (amendment C2)", () => {
  const db = database(repository),
    within = token(db),
    language = 'workspace-system/definition/workspace/language-workspace',
    own = 'agent-system/binding/agent/language-participant';
  expect(db.resolveSeat('', { within }).seat).toBe(language);
  // language-workspace states no composition.steward, so its one participant is the default actor.
  expect(defaultActor(db, within, language)).toEqual({
    actor: own,
    by: 'participant',
    participants: [own],
    actors: [own],
  });
  const governing = governingMandates(db, within, { actor: own, workspace: language });
  expect(governing).toEqual([
    {
      identity: mandate('language-mandate'),
      band: 100,
      participant: own,
      binds: true,
      moves: ALL,
      scope: [language],
      covers: ['.ia/src/'],
    },
  ]);
  // So ia capture, ia project and pnpm projections:generate (effect, Execution) pass the profile here, as every mode does.
  for (const mode of MODES) expect(profileRefusal(governing, mode), mode).toEqual({});
  expect(identities(db, { actor: own, path: '.ia/src/systems/work-system/system.ia' })).toEqual([
    mandate('language-mandate'),
  ]);
  expect(identities(db, { actor: own, path: 'README.md' })).toEqual([]);
});

it('names the consumers the code has: the CLI mandate profile and the edit guard, and no Door operation (R21)', () => {
  const read = (path: string) => readFileSync(resolve(repository, path), 'utf8');
  const RESOLVER = /\b(?:governingMandates|defaultActor|profileRefusal|evaluateMandateGuard)\(/;
  // The edit guard calls all three; no other runtime module but the resolver's own does, so no Door operation does.
  const guard = read('packages/runtime/src/mandate-guard.ts');
  for (const name of ['governingMandates', 'defaultActor', 'profileRefusal'])
    expect(guard, name).toMatch(new RegExp(`\\b${name}\\(`));
  const sources = readdirSync(resolve(repository, 'packages/runtime/src'), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => path.replaceAll('\\', '/'));
  expect(sources.filter((path) => RESOLVER.test(read(`packages/runtime/src/${path}`))).sort()).toEqual([
    'mandate-guard.ts',
    'mandate-modes.ts',
  ]);
  // SPEC R21 and the pending note say so.
  const spec = read('packages/runtime/SPEC.md')
      .split('\n')
      .find((line) => line.startsWith('R21. '))!,
    note = (JSON.parse(read('releases/pending/mandate-resolution.json')) as { summary: string }).summary;
  for (const [text, where] of [
    [spec, 'SPEC R21'],
    [note, 'releases/pending/mandate-resolution.json'],
  ] as const) {
    expect(text, where).not.toContain('or hook does yet');
    expect(text, where).toContain('the edit guard');
    expect(text, where).toContain('evaluateMandateGuard');
    expect(text, where).toContain('no Door operation does');
  }
});

describe('a @mandate that fails admission (lane D, D1 and D2)', () => {
  /** The fresh init with its mandate's moves replaced by an unknown move and an excluded word added: the probe. */
  const probe = records.replace(ALL_MOVES, 'moves [Bogus]\n    excluded-words [task]');
  /** A fixture file holding `body` after the pragma, so its first record's header is on line 3. */
  const file = (body: string): string => `#! ia 1.0\n${body}`;
  const refusal = (run: () => unknown): RuntimeError => {
    try {
      run();
    } catch (error) {
      if (error instanceof RuntimeError) return error;
      throw error;
    }
    throw new Error('expected a RuntimeError');
  };

  it('(a) finds a refused authored mandate, with its admission code and message, frozen', () => {
    const db = database(freshInit(probe));
    expect(db.get(mandate('demo-mandate'))).toBeUndefined();
    const refused = refusedMandates(db);
    expect(refused).toEqual([
      {
        identity: mandate('demo-mandate'),
        path: '.ia/src/workspace.ia',
        line: 19,
        code: 'IA-COMP-FIELD-VALUE',
        message: expect.stringContaining(`'authority.moves' admits one of`),
      },
    ]);
    expect(Object.isFrozen(refused)).toBe(true);
    expect(Object.isFrozen(refused[0])).toBe(true);
  });

  it('(b) finds both occurrences of an authored mandate identity that ties', () => {
    const root = freshInit();
    const twin = authorized('twin', ['participant @agent demo', 'moves [Observation]', 'scope [@workspace demo]']);
    put(root, '.ia/src/twin-a.ia', file(twin));
    put(root, '.ia/src/twin-b.ia', file(twin));
    const db = database(root);
    expect(refusedMandates(db)).toEqual(
      ['.ia/src/twin-a.ia', '.ia/src/twin-b.ia'].map((path) => ({
        identity: mandate('twin'),
        path,
        line: 3,
        code: 'IA-GRAPH-IDENTITY-TIE',
        message: expect.stringContaining(`${mandate('twin')} ties at band 100`),
      })),
    );
  });

  it('(c) finds a mandate in a file refused whole: a language error, a duplicate requirement id, an unreadable header', () => {
    const root = freshInit();
    put(
      root,
      '.ia/src/broken.ia',
      file(
        `${authorized('broken', ['participant @agent demo', 'moves [Observation]'])}${agent('loose')}   misindented here\n`,
      ),
    );
    put(
      root,
      '.ia/src/duplicate.ia',
      file(
        `${authorized('dup', ['participant @agent demo', 'moves [Observation]'])}\n@contract clash\n  version "0.1.0"\n  meaning\n    says "x"\n    answers "y"\n  relationships\n    governs @check instance-schema-check\n  inputs\n    REQ-FOUNDATION-INPUT "Declared by the installed foundation contract too."\n`,
      ),
    );
    put(root, '.ia/src/header.ia', file('\n@mandate Bad_Name!\n  meaning\n    says "x"\n'));
    const db = database(root);
    expect(refusedMandates(db)).toEqual([
      {
        identity: mandate('broken'),
        path: '.ia/src/broken.ia',
        line: 3,
        code: 'IA-LANG-INDENT-STEP',
        message: expect.stringContaining('indentation of 3'),
      },
      {
        identity: mandate('dup'),
        path: '.ia/src/duplicate.ia',
        line: 3,
        code: 'IA-LANG-REQUIREMENT-DUPLICATE',
        message: expect.stringContaining('REQ-FOUNDATION-INPUT'),
      },
      {
        path: '.ia/src/header.ia',
        line: 3,
        code: 'IA-LANG-HEADER-MALFORMED',
        message: expect.stringContaining('Bad_Name!'),
      },
    ]);
  });

  it('finds none for a parse error in a file that declares no mandate, or a mandate refused in the installed base', () => {
    const root = freshInit(records, {
      '.ia/src/systems/agent-system/records/sample-mandate.ia': readFileSync(
        resolve(repository, 'examples/conformance/native/systems/agent-system/records/sample-mandate.ia'),
        'utf8',
      ).replace('moves [Observation, Verification]', 'moves [Bogus]'),
      '.ia/src/broken-mandate.ia': file(`${authorized('installed-broken', ['moves [Observation]'])}   misindented\n`),
    });
    put(root, '.ia/src/plain.ia', file('\n@agent plain\n  meaning\n    says "x\n'));
    const db = database(root);
    // Admission refuses all three: the installed sample-mandate, the installed file and the authored one.
    expect(db.refused.map((record) => [record.identity, record.reason])).toContainEqual([
      mandate('sample-mandate'),
      'IA-COMP-FIELD-VALUE',
    ]);
    expect(errors(db).map((finding) => finding.path)).toEqual(
      expect.arrayContaining(['.ia/src/plain.ia', expect.stringMatching(/broken-mandate\.ia$/)]),
    );
    expect(refusedMandates(db)).toEqual([]);
    // So nothing fails closed: the authored mandate governs as before.
    expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  });

  it('fails every resolver closed, whatever the scope, with the first refused mandate located as data (D2)', () => {
    const root = freshInit(probe);
    put(root, '.ia/src/twin-a.ia', file(authorized('twin', ['moves [Observation]'])));
    put(root, '.ia/src/twin-b.ia', file(authorized('twin', ['moves [Observation]'])));
    const db = database(root),
      within = token(db),
      narrowed = db.resolveScope({ identities: [demo, participant] }).token;
    expect(refusedMandates(db).map((entry) => entry.path)).toEqual([
      '.ia/src/twin-a.ia',
      '.ia/src/twin-b.ia',
      '.ia/src/workspace.ia',
    ]);
    for (const [name, run] of [
      ['governingMandates', () => governingMandates(db, within, { actor: participant, workspace: demo })],
      ['governingMandates by path', () => governingMandates(db, within, { path: 'docs/guide.md' })],
      ['defaultActor', () => defaultActor(db, within, demo)],
      ['seatedWorkspace', () => seatedWorkspace(db, within, 'docs/guide.md')],
      ['requireMandatesAdmitted', () => requireMandatesAdmitted(db, within)],
    ] as const) {
      const error = refusal(run);
      expect(error.code, name).toBe('IA-RUNTIME-REQUEST-INVALID');
      // Review D-R2: the cause is marked on the error, which callers branch on.
      expect(error.admission, name).toBe('refused');
      expect(isAdmissionRefusal(error), name).toBe(true);
      expect(error.where, name).toEqual({ path: '.ia/src/twin-a.ia', line: 3, identity: mandate('twin') });
      expect(Object.isFrozen(error.where), name).toBe(true);
      expect(error.message, name).toContain(
        `${mandate('twin')} (.ia/src/twin-a.ia:3) failed admission: IA-GRAPH-IDENTITY-TIE`,
      );
      expect(error.message, name).toContain('2 more @mandate records failed admission');
    }
    // Review D-N4: a narrowed token fails closed just the same, but names no path, record or finding and carries no where.
    for (const [name, run] of [
      ['governingMandates narrowed', () => governingMandates(db, narrowed)],
      ['defaultActor narrowed', () => defaultActor(db, narrowed, demo)],
      ['seatedWorkspace narrowed', () => seatedWorkspace(db, narrowed, 'docs/guide.md')],
    ] as const) {
      const error = refusal(run);
      expect(error.code, name).toBe('IA-RUNTIME-REQUEST-INVALID');
      expect(isAdmissionRefusal(error), name).toBe(true);
      expect(error.where, name).toBeUndefined();
      expect(error.message, name).toBe(
        'IA-RUNTIME-REQUEST-INVALID: an authored @mandate, or a record a mandate resolution reads, failed admission; every mandate-gated decision fails closed across the workspace, since whom a mandate binds, where it governs or who acts by default cannot be trusted; read it through a whole-workspace scope',
      );
      for (const secret of ['twin', '.ia/src', 'IA-GRAPH', 'IA-COMP'])
        expect(error.message, name).not.toContain(secret);
    }
    // An unknown token keeps its database code.
    expect(() => requireMandatesAdmitted(db, 'forged')).toThrow(
      expect.objectContaining({ code: 'IA-DB-SCOPE-UNAVAILABLE' }),
    );
    // A refusal of an admitted mandate's authority is not one.
    expect(
      isAdmissionRefusal(new RuntimeError('IA-RUNTIME-REQUEST-INVALID', 'x', undefined, { path: 'a', line: 1 })),
    ).toBe(false);
    // One with no identity known is located by its path and line alone.
    const header = freshInit();
    put(header, '.ia/src/header.ia', file('\n@mandate Bad_Name!\n  meaning\n    says "x"\n'));
    const unnamed = database(header);
    const error = refusal(() => governingMandates(unnamed, token(unnamed)));
    expect(error.where).toEqual({ path: '.ia/src/header.ia', line: 3 });
    expect(error.message).toContain('the @mandate at .ia/src/header.ia:3 failed admission: IA-LANG-HEADER-MALFORMED');
  });
});

describe('a record an admitted @mandate depends on that fails admission (lane D, D9)', () => {
  /** `@agent demo` with an undeclared section, so admission refuses it at its header, line 12 of the fixture. */
  const brokenAgent = (text: string): string =>
    text.replace('  governance\n    applies []\n', '  governance\n    applies []\n  bogus\n    note x\n');
  /** `@workspace demo` with an undeclared section, so admission refuses it at its header, line 3. */
  const brokenWorkspace = (text: string): string => text.replace(STEWARD, `${STEWARD}  bogus\n    note x\n`);
  const thrown = (run: () => unknown): RuntimeError => {
    try {
      run();
    } catch (error) {
      if (error instanceof RuntimeError) return error;
      throw error;
    }
    throw new Error('expected a RuntimeError');
  };
  /** Every resolver that reads a handle, each failing closed at `where` with a message naming `dependency`. */
  function failsClosed(db: Handle, where: Record<string, unknown>, dependency: string): void {
    const within = token(db);
    for (const [name, run] of [
      ['governingMandates', () => governingMandates(db, within, { actor: participant })],
      ['governingMandates by path', () => governingMandates(db, within, { path: 'docs/guide.md' })],
      ['defaultActor', () => defaultActor(db, within, demo)],
      ['seatedWorkspace', () => seatedWorkspace(db, within, 'docs/guide.md')],
    ] as const) {
      const error = thrown(run);
      expect(error.code, name).toBe('IA-RUNTIME-REQUEST-INVALID');
      expect(error.where, name).toEqual(where);
      expect(error.message, name).toContain(dependency);
    }
  }

  it("fails closed when a mandate's authority.participant names an @agent that failed admission", () => {
    // Without a steward, so only the mandate depends on the agent.
    const db = database(freshInit(brokenAgent(records.replace(STEWARD, ''))));
    expect(errors(db).map((finding) => [finding.code, finding.line])).toEqual([['IA-COMP-SECTION-UNKNOWN', 17]]);
    expect(refusedMandates(db)).toEqual([]);
    const dependencies = refusedDependencies(db);
    expect(dependencies).toEqual([
      {
        dependent: mandate('demo-mandate'),
        field: 'authority.participant',
        reference: '@agent demo',
        identity: participant,
        path: '.ia/src/workspace.ia',
        line: 11,
        code: 'IA-COMP-SECTION-UNKNOWN',
        message: expect.stringContaining("does not admit section 'bogus'"),
      },
    ]);
    expect(Object.isFrozen(dependencies)).toBe(true);
    expect(Object.isFrozen(dependencies[0])).toBe(true);
    failsClosed(
      db,
      { path: '.ia/src/workspace.ia', line: 11, identity: participant },
      `${mandate('demo-mandate')} depends on @agent demo through authority.participant, and ${participant} (.ia/src/workspace.ia:11) failed admission: IA-COMP-SECTION-UNKNOWN`,
    );
  });

  it("fails closed when a mandate's authority.scope names a @workspace that failed admission", () => {
    const db = database(freshInit(brokenWorkspace(records)));
    expect(errors(db).map((finding) => [finding.code, finding.line])).toEqual([['IA-COMP-SECTION-UNKNOWN', 11]]);
    expect(refusedDependencies(db)).toEqual([
      expect.objectContaining({
        dependent: mandate('demo-mandate'),
        field: 'authority.scope',
        reference: '@workspace demo',
        identity: demo,
        path: '.ia/src/workspace.ia',
        line: 3,
      }),
    ]);
    failsClosed(
      db,
      { path: '.ia/src/workspace.ia', line: 3, identity: demo },
      `${mandate('demo-mandate')} depends on @workspace demo through authority.scope`,
    );
  });

  it("fails closed when a workspace's composition.steward names an @agent that failed admission, and no mandate does", () => {
    // The steward is named by no mandate: the one mandate binds ops, which would become the default actor.
    const db = database(
      freshInit(brokenAgent(records.replace('participant @agent demo', 'participant @agent ops')) + agent('ops')),
    );
    expect(refusedDependencies(db)).toEqual([
      expect.objectContaining({
        dependent: demo,
        field: 'composition.steward',
        reference: '@agent demo',
        identity: participant,
        line: 12,
      }),
    ]);
    failsClosed(
      db,
      { path: '.ia/src/workspace.ia', line: 12, identity: participant },
      `${demo} depends on @agent demo through composition.steward`,
    );
  });

  it('names both dependencies when the agent is the steward and the participant, and a refused mandate before them', () => {
    const db = database(freshInit(brokenAgent(records)));
    expect(refusedDependencies(db).map((entry) => [entry.dependent, entry.field])).toEqual([
      [mandate('demo-mandate'), 'authority.participant'],
      [demo, 'composition.steward'],
    ]);
    expect(thrown(() => defaultActor(db, token(db), demo)).message).toContain(
      '(1 more record a mandate resolution reads failed admission)',
    );
    // A refused mandate is named first, the dependencies counted after it.
    const text = `${brokenAgent(records)}${authorized('refused', ['moves []'])}`,
      both = database(freshInit(text));
    const error = thrown(() => governingMandates(both, token(both)));
    expect(error.where).toEqual({
      path: '.ia/src/workspace.ia',
      line: text.split('\n').indexOf('@mandate refused') + 1,
      identity: mandate('refused'),
    });
    expect(error.message).toContain('and 2 records a mandate resolution reads failed admission');
  });

  it('does not fail closed for an unrelated refused @agent, a never-authored reference, or a refused installed @agent', () => {
    const stray = agent('stray').replace('    applies []\n', '    applies []\n  bogus\n    note x\n');
    const ghost = authorized('ghost-mandate', ['participant @agent ghost', 'moves [Observation]', 'covers ["ghost/"]']);
    const installed = authorized('installed-mandate', [
      'participant @agent vendored',
      'moves [Observation]',
      'covers ["installed/"]',
    ]);
    const root = freshInit(`${records}${stray}${ghost}${installed}`, {
      // An @agent of the installed base with an undeclared section: band 90, refused.
      '.ia/src/vendored.ia': `#! ia 1.0\n${agent('vendored').replace('    applies []\n', '    applies []\n  bogus\n    note x\n')}`,
    });
    const db = database(root);
    // The stray agent and the installed steward are refused; no admitted mandate depends on a band-100 refused record.
    expect(db.unadmitted.map((entry) => [entry.identity, entry.band])).toEqual(
      expect.arrayContaining([
        ['agent-system/binding/agent/stray', 100],
        ['agent-system/binding/agent/vendored', 90],
      ]),
    );
    expect(refusedMandates(db)).toEqual([]);
    expect(refusedDependencies(db)).toEqual([]);
    // The never-authored participant stays as authored, as before.
    expect(governingMandates(db, token(db), { path: 'ghost/x.md' })).toEqual([
      expect.objectContaining({ identity: mandate('ghost-mandate'), participant: '@agent ghost' }),
    ]);
    expect(defaultActor(db, token(db), demo).actor).toBe(participant);
  });
});

describe('the mandate facet and the shadowing override (review D-N6, D-R2)', () => {
  it('reads a record as a mandate by its identity facet as well as its word', () => {
    const entry = (word: string, identity: string) => ({
      identity,
      word,
      name: 'x',
      band: 100 as const,
      path: '.ia/src/x.ia',
      line: 3,
      endLine: 3,
      finding: { code: 'IA-COMP-FIELD-VALUE', path: '.ia/src/x.ia', line: 3, message: 'm' },
    });
    const stub = {
      unadmitted: [entry('grant', 'local/policy/mandate/x'), entry('grant', 'local/policy/grant/y')],
    } as unknown as Handle;
    expect(refusedMandates(stub).map((refused) => refused.identity)).toEqual(['local/policy/mandate/x']);
  });
  it('fails closed, marked by its cause, for a refused authored mandate sharing its identity with an admitted installed one', () => {
    // The installed sample-mandate is admitted at band 90; an authored override of it fails admission.
    const root = freshInit();
    put(
      root,
      '.ia/src/shadow.ia',
      '#! ia 1.0\n\n@mandate sample-mandate\n  meaning\n    says "Shadow."\n    answers "What?"\n  governance\n    requires "Nothing."\n  authority\n    participant @agent demo\n    moves [Bogus]\n',
    );
    const db = database(root),
      within = token(db);
    expect(db.get(mandate('sample-mandate'), { within })?.band).toBe(90);
    let caught: unknown;
    try {
      governingMandates(db, within, {});
    } catch (error) {
      caught = error;
    }
    expect(isAdmissionRefusal(caught)).toBe(true);
    expect((caught as RuntimeError).where).toEqual({
      path: '.ia/src/shadow.ia',
      line: 3,
      identity: mandate('sample-mandate'),
    });
  });
});

it('spells the admission report root only when every character is inert unquoted (review D-R1, D-N2)', () => {
  const slash = (path: string) => (process.platform === 'win32' ? path.replaceAll('/', '\\') : path);
  expect(admissionReport(slash('/work/ws-1/a.b_c'))).toEqual({
    command: 'ia report --root /work/ws-1/a.b_c',
    fromRoot: false,
  });
  expect(admissionReport(slash('/work/caf\u00e9'))).toEqual({
    command: 'ia report --root /work/caf\u00e9',
    fromRoot: false,
  });
  for (const unsafe of [
    '/work/a&b',
    '/work/a(b',
    '/work/a$b',
    '/work/a`b',
    '/work/a b',
    '/work/a"b',
    "/work/a'b",
    '/work/~a',
  ])
    expect(admissionReport(slash(unsafe)), unsafe).toEqual({ command: 'ia report', fromRoot: true });
  expect(admissionReport(undefined)).toEqual({ command: 'ia report', fromRoot: true });
});

describe('a file refused whole whose records db cannot all identify (review D2-R2)', () => {
  const body = '  meaning\n    says "x"\n';
  it('keeps the restrictive profile when an unrelated rejected file contains an attribution comment', () => {
    const root = freshInit(readFileSync(packetFixture, 'utf8').replace(ALL_MOVES, 'moves [Observation]')),
      comment = `# authored-by @agent demo under @mandate demo-mandate at ${'a'.repeat(64)}`;
    put(root, '.ia/src/extra.ia', `#! ia 1.0\n${comment}\n@agent unrelated\n  meaning\n    says "unfinished\n`);
    const db = database(root),
      within = token(db);
    expect(refusedMandates(db)).toEqual([]);
    expect(defaultActor(db, within, demo).actor).toBe(participant);
    const mandates = governingMandates(db, within, { actor: participant, workspace: demo });
    expect(mandates.map((entry) => entry.identity)).toEqual([mandate('demo-mandate')]);
    expect(profileRefusal(mandates, 'read').refusal).toBeUndefined();
    expect(profileRefusal(mandates, 'effect').refusal?.code).toBe('IA-RUNTIME-MANDATE-MOVE');
  });
  it('retains unidentified authority and resolution dependency refusals after an attribution comment', () => {
    const comment = `# authored-by @agent demo under @mandate demo-mandate at ${'a'.repeat(64)}`;
    for (const text of [
      '@ mandate hidden\n',
      '\uFF20mandate hidden\n',
      '<<<<<<< HEAD\ngarbage\n=======\nother\n>>>>>>> incoming\n',
      '@mandate hidden\n  meaning\n    says "unfinished\n',
      '@agent demo\n  meaning\n    says "unfinished\n',
      '@workspace demo\n  meaning\n    says "unfinished\n',
    ]) {
      const root = freshInit();
      put(root, '.ia/src/extra.ia', `#! ia 1.0\n${comment}\n${text}`);
      const db = database(root),
        within = token(db);
      for (const resolve of [
        () => defaultActor(db, within, demo),
        () => seatedWorkspace(db, within, '.ia/src/workspace.ia'),
        () => governingMandates(db, within, { actor: participant, workspace: demo }),
      ])
        expect(resolve, text).toThrow(expect.objectContaining({ admission: 'refused' }));
    }
  });
  const thrownBy = (run: () => unknown): RuntimeError => {
    try {
      run();
    } catch (error) {
      if (error instanceof RuntimeError) return error;
      throw error;
    }
    throw new Error('expected a RuntimeError');
  };
  for (const [name, text, line] of [
    ['a space after the at sign', `#! ia 1.0\n\n@ mandate spaced\n${body}`, 3],
    ['a full-width at sign', `#! ia 1.0\n\n${String.fromCharCode(0xff20)}mandate wide\n${body}`, 3],
    // Its first line reads as a comment; the next opens with a NUL at column 0 of a file refused at its pragma.
    ['UTF-16LE without a byte-order mark', Buffer.from(`#! ia 1.0\n\n@mandate sixteen\n${body}`, 'utf16le'), 2],
    ['a stray top-level line beside an identified record', `#! ia 1.0\n${agent('strayhost')}\ngarbage line here\n`, 10],
    // Review D2 recheck F1 (a): a file refused at its pragma reports nothing past it.
    [
      'a spaced header after a named first header, with no pragma',
      `@agent other\n${body}\n@ mandate extra\n${body}`,
      5,
    ],
    [
      'a joined at sign after a named first header, with no pragma',
      `@agent other\n${body}\n@${String.fromCharCode(0x200d)}mandate extra\n${body}`,
      5,
    ],
    // F1 (b): a line opening with an at sign that no reading names counts wherever it stands.
    [
      'a spaced header indented inside a parsed record',
      `#! ia 1.0\n\n@agent other\n${body}  @ mandate extra\n    meaning\n`,
      6,
    ],
    [
      'a full-width header inside a prose value left open',
      `#! ia 1.0\n\n@agent other\n  meaning\n    says """\n\n${String.fromCharCode(0xff20)}mandate extra\n${body}`,
      7,
    ],
  ] as const)
    it(`fails closed for ${name}, which may be a mandate`, () => {
      const root = freshInit();
      put(root, '.ia/src/extra.ia', text as string);
      const db = database(root);
      expect(refusedMandates(db)[0]).toEqual({
        path: '.ia/src/extra.ia',
        line,
        code: expect.stringMatching(/^IA-LANG-/),
        message: expect.any(String),
        unidentified: true,
      });
      const error = thrownBy(() => governingMandates(db, token(db), { actor: participant, workspace: demo }));
      expect(isAdmissionRefusal(error)).toBe(true);
      expect(error.where).toEqual({ path: '.ia/src/extra.ia', line });
      expect(error.message).toContain(
        `an unidentified record at .ia/src/extra.ia:${line}, possibly a @mandate, failed admission`,
      );
    });
  it('does not fail closed for an error inside an identified record that is no mandate', () => {
    const root = freshInit();
    put(root, '.ia/src/extra.ia', '#! ia 1.0\n\n@agent inside\n  meaning\n    says "x\n');
    const db = database(root);
    expect(db.unadmitted.map((entry) => [entry.word, entry.line])).toEqual([['agent', 3]]);
    expect(refusedMandates(db)).toEqual([]);
    expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  });
  it('does not fail closed for a file of comments alone, with no pragma, but does for a malformed header after one (review D2 recheck F2)', () => {
    const root = freshInit();
    put(root, '.ia/src/notes.ia', '# notes for later\n');
    const db = database(root);
    expect(db.report.findings.some((finding) => finding.path === '.ia/src/notes.ia')).toBe(true);
    expect(refusedMandates(db)).toEqual([]);
    expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
    put(root, '.ia/src/notes.ia', '# notes for later\n@ mandate extra\n');
    const again = database(root);
    expect(refusedMandates(again).map((entry) => [entry.line, entry.unidentified])).toEqual([[2, true]]);
    expect(() => identities(again, { actor: participant, workspace: demo })).toThrow(
      expect.objectContaining({ admission: 'refused' }),
    );
  });
  it('counts a line the token scan reads as a mandate once (review D2 recheck F3)', () => {
    const root = freshInit();
    put(root, '.ia/src/extra.ia', `#! ia 1.0\n${agent('other')}${String.fromCharCode(0)}@mandate extra\n${body}`);
    const db = database(root);
    expect(db.unadmitted.filter((entry) => entry.line === 9).map((entry) => entry.word)).toEqual([
      undefined,
      'mandate',
    ]);
    expect(refusedMandates(db).map((entry) => [entry.line, entry.unidentified ?? false])).toEqual([[9, false]]);
    const error = thrownBy(() => governingMandates(db, token(db), { actor: participant, workspace: demo }));
    expect(error.message).toContain('the @mandate at .ia/src/extra.ia:9 failed admission: IA-LANG-');
    expect(error.message).not.toContain('unidentified');
    expect(error.message).not.toContain('more');
  });
  it('does not fail closed for an empty file, which declares nothing', () => {
    const root = freshInit();
    put(root, '.ia/src/empty.ia', '');
    const db = database(root);
    expect(db.report.findings.some((finding) => finding.path === '.ia/src/empty.ia')).toBe(true);
    expect(refusedMandates(db)).toEqual([]);
    expect(identities(db, { actor: participant, workspace: demo })).toEqual([mandate('demo-mandate')]);
  });
  it('names a mandate db identifies before a record it cannot, and counts the rest by kind', () => {
    const root = freshInit();
    put(root, '.ia/src/extra.ia', `#! ia 1.0\n${agent('strayhost')}\ngarbage line here\n`);
    put(root, '.ia/src/zz-broken.ia', `#! ia 1.0\n${authorized('broken', ['moves [Bogus]'])}`);
    const db = database(root);
    expect(refusedMandates(db).map((entry) => [entry.path, entry.line, entry.unidentified ?? false])).toEqual([
      ['.ia/src/extra.ia', 10, true],
      ['.ia/src/zz-broken.ia', 3, false],
    ]);
    const error = thrownBy(() => governingMandates(db, token(db), { actor: participant, workspace: demo }));
    expect(isAdmissionRefusal(error)).toBe(true);
    expect(error.where).toEqual({ path: '.ia/src/zz-broken.ia', line: 3, identity: mandate('broken') });
    expect(error.message).toContain(`${mandate('broken')} (.ia/src/zz-broken.ia:3) failed admission`);
    expect(error.message).toContain('(1 unidentified record failed admission)');
    // A second unidentified record, and no identified mandate: the first is named, the other counted.
    put(root, '.ia/src/zz-broken.ia', `#! ia 1.0\n\n@ mandate spaced\n${body}`);
    const again = database(root);
    const second = thrownBy(() => governingMandates(again, token(again), { actor: participant, workspace: demo }));
    expect(second.where).toEqual({ path: '.ia/src/extra.ia', line: 10 });
    expect(second.message).toContain('an unidentified record at .ia/src/extra.ia:10, possibly a @mandate, failed');
    const counted = /\((\d+) more unidentified records? failed admission\)/.exec(second.message);
    expect(Number(counted?.[1])).toBe(refusedMandates(again).length - 1);
    expect(second.message).not.toContain('@mandate record');
  });
});

describe('D9 through a tie and a file refused whole (review D2-N1)', () => {
  const dependencyOf = (root: string) => {
    const db = database(root);
    return { db, dependencies: refusedDependencies(db) };
  };
  it('fails closed when the participant @agent ties at band 100', () => {
    const root = freshInit(records);
    put(root, '.ia/src/twin-agent.ia', `#! ia 1.0\n${agent('demo')}`);
    const { db, dependencies } = dependencyOf(root);
    expect(db.unadmitted.filter((entry) => entry.finding.code === 'IA-GRAPH-IDENTITY-TIE').length).toBe(2);
    expect(dependencies.map((entry) => [entry.dependent, entry.field, entry.code])).toEqual(
      expect.arrayContaining([
        [mandate('demo-mandate'), 'authority.participant', 'IA-GRAPH-IDENTITY-TIE'],
        [demo, 'composition.steward', 'IA-GRAPH-IDENTITY-TIE'],
      ]),
    );
    expect(() => defaultActor(db, token(db), demo)).toThrow(expect.objectContaining({ admission: 'refused' }));
  });
  it('fails closed when the scoped @workspace ties at band 100', () => {
    const root = freshInit(records);
    put(
      root,
      '.ia/src/twin-workspace.ia',
      '#! ia 1.0\n\n@workspace demo\n  meaning\n    says "A twin."\n    answers "Which?"\n',
    );
    const { db, dependencies } = dependencyOf(root);
    expect(dependencies.map((entry) => [entry.dependent, entry.field, entry.path, entry.code])).toEqual(
      expect.arrayContaining([
        [mandate('demo-mandate'), 'authority.scope', '.ia/src/twin-workspace.ia', 'IA-GRAPH-IDENTITY-TIE'],
        [mandate('demo-mandate'), 'authority.scope', '.ia/src/workspace.ia', 'IA-GRAPH-IDENTITY-TIE'],
      ]),
    );
    expect(() => governingMandates(db, token(db))).toThrow(expect.objectContaining({ admission: 'refused' }));
  });
  it('fails closed when the participant @agent is a header only the text of a file refused whole shows', () => {
    // The participant ghostly is authored only as an indented header the parse refuses: no identity, its name known.
    const root = freshInit(
      `${records}${authorized('ghost-mandate', ['participant @agent ghostly', 'moves [Observation]', 'covers ["ghost/"]'])}`,
    );
    put(root, '.ia/src/ghostly.ia', '#! ia 1.0\n\n  @agent ghostly\n');
    const { db, dependencies } = dependencyOf(root);
    expect(refusedMandates(db)).toEqual([]);
    expect(dependencies).toEqual([
      {
        dependent: mandate('ghost-mandate'),
        field: 'authority.participant',
        reference: '@agent ghostly',
        path: '.ia/src/ghostly.ia',
        line: 3,
        code: 'IA-LANG-TOPLEVEL-UNEXPECTED',
        message: expect.any(String),
      },
    ]);
    const error = (() => {
      try {
        governingMandates(db, token(db), { path: 'ghost/x.md' });
      } catch (caught) {
        return caught as RuntimeError;
      }
      throw new Error('expected a refusal');
    })();
    expect(error.where).toEqual({ path: '.ia/src/ghostly.ia', line: 3 });
  });
});
