import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateSystems } from '@inventarch/compliance';
import type { SystemFolder } from '@inventarch/compliance';
import { stableSerialize } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import type { FrozenRegistry, Location } from '@inventarch/language';
import { beforeAll, expect, it } from 'vitest';
import {
  MODE_MOVES,
  OPERATION_MODES,
  SCOPE_BODY_LIMITS,
  normalizeScopeKey,
  position,
  positionBody,
  stewardApplies,
} from '../src/index.js';
import type { PositionBody, ScopeKey } from '../src/index.js';
import { database, put, workspace } from './workspace.js';

/**
 * The on-demand sections of body(K): applies by word, playbook cells, applicable rules and the governing mandates.
 * The fixture law, playbook and mandate are the native fixture instances, written into a copy of the conformance
 * corpus exactly as the native check admits them.
 */
const WS = 'workspace-system/definition/workspace/foundation-workspace',
  LAW = 'governance-system/governance/law/sample-rule',
  CHECK = 'compliance-system/check/gate/instance-schema-check',
  PRINCIPLE = 'governance-system/governance/principle/sample-principle',
  CONVENTION = 'governance-system/governance/convention/sample-convention',
  PROCEDURE = 'governance-system/definition/procedure/sample-procedure',
  FIXTURE_LAW = 'governance-system/governance/law/minimal-law',
  FIXTURE_PLAYBOOK = 'governance-system/definition/procedure/minimal-playbook',
  FIXTURE_MANDATE = 'agent-system/policy/mandate/minimal-mandate',
  SAMPLE_MANDATE = 'agent-system/policy/mandate/sample-mandate',
  steward = (name: string) => `agent-system/binding/agent/${name}-steward`;
const governanceRecords = '.ia/src/systems/governance-system/records',
  agentRecords = '.ia/src/systems/agent-system/records',
  workspaceRecords = '.ia/src/systems/workspace-system/records';

interface FixtureInstance {
  readonly path: string;
  readonly text: string;
}
let fixtures: ReadonlyMap<string, string>;
beforeAll(async () => {
  const instances = (
    (await import(resolve(import.meta.dirname, '../../../tools/native/fixture-instances.ts'))) as {
      readonly fixtureInstances: readonly FixtureInstance[];
    }
  ).fixtureInstances;
  fixtures = new Map(instances.map((instance) => [instance.path, instance.text]));
});
/** A copy of the conformance corpus with the named native fixture instances added. */
function corpus(...names: readonly string[]): string {
  const root = workspace();
  for (const name of names) {
    const path = [...fixtures.keys()].find((candidate) => candidate.endsWith(`/${name}.ia`));
    if (path === undefined) throw new Error(`No fixture instance ${name}`);
    put(root, path, fixtures.get(path)!);
  }
  return root;
}
function body(root: string, key: ScopeKey = {}, locations: Readonly<Record<string, Location>> = {}): PositionBody {
  const db = database(root, { locations });
  return positionBody(db, db.resolveScope({}).token, normalizeScopeKey(key));
}
const ids = (lines: readonly { readonly identity: string }[]): readonly string[] => lines.map((line) => line.identity);
function law(name: string, subject: string, severity = 'advisory'): string {
  return `#! ia 1.0\n@law ${name}\n  meaning\n    says "Fixture rule ${name}."\n    answers "Which fixture rule is this?"\n  governance\n    severity ${severity}\n    requires "Fixture only."\n  subject\n${subject}`;
}
function mandate(name: string, authority: string): string {
  return `#! ia 1.0\n@mandate ${name}\n  meaning\n    says "Fixture authority ${name}."\n    answers "Which fixture mandate is this?"\n  governance\n    requires "Fixture only."\n  authority\n${authority}`;
}
/** The conformance workspace with `composition.steward`, the participant its seat answers for. */
function stewarded(root: string, extra = ''): void {
  const path = `${workspaceRecords}/foundation-workspace.ia`;
  put(
    root,
    path,
    readFileSync(resolve(root, path), 'utf8').replace(
      'session-system]\n',
      `session-system]\n    steward @agent agent-steward\n${extra}`,
    ),
  );
}

it('adds the on-demand sections after the captured tallies, before the counts', () => {
  expect(Object.keys(body(workspace()))).toEqual([
    'revision',
    'key',
    'seat',
    'loaded',
    'pointers',
    'tallies',
    'frontier',
    'systems',
    'captured',
    'appliesByWord',
    'cells',
    'rules',
    'mandates',
    'counts',
    'widening',
    'unknowns',
  ]);
});

it('lists the rules and playbooks whose subject word or kind matches a loaded record, as field matches', () => {
  const at = body(corpus('minimal-law', 'minimal-playbook'), { seat: FIXTURE_PLAYBOOK, shape: 'governance' });
  expect(ids(at.loaded)).toEqual([FIXTURE_PLAYBOOK]);
  // Both are matched by field only: no row joins them to the playbook, so neither is loaded, pointed at or tallied.
  expect(at.appliesByWord.listed).toEqual([
    {
      identity: FIXTURE_LAW,
      word: 'law',
      kind: 'governance',
      lane: 'authority',
      system: 'governance-system',
      steward: steward('governance'),
      band: 100,
      words: ['playbook'],
      by: [{ field: 'subject-kind', value: 'definition' }],
    },
    {
      identity: PRINCIPLE,
      word: 'principle',
      kind: 'governance',
      lane: 'authority',
      system: 'governance-system',
      steward: steward('governance'),
      band: 100,
      words: ['playbook'],
      by: [
        { field: 'subject-word', value: 'playbook' },
        { field: 'subject-kind', value: 'definition' },
      ],
    },
  ]);
  expect(at.appliesByWord.tallies).toEqual([]);
  expect(at.appliesByWord.count).toBe(2);
  for (const line of at.appliesByWord.listed) {
    expect(Object.keys(line)).not.toContain('hop');
    expect(Object.keys(line)).not.toContain('via');
  }
  // body(K0) of the corpus: the workspace is a definition, so the principle applies by its subject kind.
  expect(ids(body(workspace()).appliesByWord.listed)).toEqual([PRINCIPLE]);
  // A rule whose subject names no loaded word or kind does not apply.
  expect(ids(body(workspace(), { seat: CHECK, shape: 'context', depth: 0 }).appliesByWord.listed)).toEqual([]);
});

it('lists each word of the loaded records once, with the agents whose governance.applies names it', () => {
  const at = body(workspace(), { seat: LAW, shape: 'governance', depth: 1 });
  expect(ids(at.loaded)).toEqual([LAW, CHECK]);
  expect(at.appliesByWord.words).toEqual([
    { word: 'check', stewards: [steward('compliance')] },
    { word: 'law', stewards: [steward('governance')] },
  ]);
  const deep = body(workspace(), { shape: 'governance', depth: 2, budget: 64 }),
    words = deep.appliesByWord.words.map((entry) => entry.word);
  expect(new Set(words).size).toBe(words.length);
  expect(words).toEqual([...new Set(deep.loaded.map((line) => line.word))].sort());
  // A conditioned applies clause attributes nothing, as in the compliance steward check.
  const root = workspace();
  put(
    root,
    `${agentRecords}/scoped-agent.ia`,
    '#! ia 1.0\n@agent scoped-agent\n  meaning\n    says "A fixture agent."\n    answers "Which agent applies only in plan?"\n  governance\n    applies [check]\n    applies [law]\n      when phase is plan\n',
  );
  expect(body(root, { seat: LAW, shape: 'governance', depth: 1 }).appliesByWord.words).toEqual([
    { word: 'check', stewards: [steward('compliance'), 'agent-system/binding/agent/scoped-agent'] },
    { word: 'law', stewards: [steward('governance')] },
  ]);
});

it('reads steward governance.applies as the compliance steward check does', () => {
  const root = workspace();
  put(
    root,
    `${agentRecords}/parity-agents.ia`,
    [
      '#! ia 1.0',
      '@agent parity-plain',
      '  meaning\n    says "A fixture agent."\n    answers "Which words does it apply to?"',
      '  governance\n    applies [law, playbook]',
      '@agent parity-conditioned',
      '  meaning\n    says "A fixture agent."\n    answers "Which words does it apply to?"',
      '  governance\n    applies [principle]\n    applies [law, convention]\n      when phase is plan',
      '',
    ].join('\n'),
  );
  const db = database(root),
    agents = db.records().filter((node) => node.discriminator === 'agent');
  expect(agents.length).toBe(13);
  const words = ['agent', 'mandate', 'law', 'principle', 'convention', 'playbook', 'check', 'hook', 'unclaimed'];
  for (const agent of agents) {
    // One synthetic system whose steward is this agent and whose words are `words`: compliance names the words its
    // steward's unconditioned applies leaves uncovered.
    const folder: SystemFolder = {
      name: 'parity',
      path: 'parity',
      sources: [
        {
          ast: { path: 'parity/system.ia', records: [{ discriminator: 'system', name: 'parity', nested: [] }] },
        } as unknown as SystemFolder['sources'][number],
      ],
      records: [agent],
    };
    const registry = {
      systems: new Map([
        [
          'parity',
          {
            name: 'parity',
            path: 'parity/system.ia',
            span: { line: 1 },
            requires: [{ name: 'agent-system', span: { line: 1 } }],
            steward: { discriminator: 'agent', name: agent.name },
            entries: words.map((keyword) => ({ keyword, span: { line: 1 } })),
            consent: [{ sources: '*', targets: '*' }],
          },
        ],
      ]),
      registrations: new Map(),
      schemas: new Map(),
      order: ['agent-system', 'parity'],
    } as unknown as FrozenRegistry;
    const steward = validateSystems([folder], registry, [agent]).find((result) => result.check === 'COMP-STEWARD')!;
    const message = steward.findings[0]?.message ?? '',
      missing =
        message === '' ? [] : message.slice(message.indexOf('coverage for ') + 'coverage for '.length).split(', ');
    const covered = words.filter((word) => !missing.includes(word));
    expect([agent.identity, stewardApplies(agent as Node).filter((word) => words.includes(word))]).toEqual([
      agent.identity,
      covered,
    ]);
  }
  expect(stewardApplies(agents.find((agent) => agent.name === 'parity-conditioned')! as Node)).toEqual(['principle']);
});

it('lists rules and playbooks beyond the listing limit as tallies per word and owner system', () => {
  const root = workspace(),
    extra = SCOPE_BODY_LIMITS.pointers + 2;
  for (let index = 0; index < extra; index++)
    put(
      root,
      `${governanceRecords}/kind-law-${String(index).padStart(2, '0')}.ia`,
      law(`kind-law-${String(index).padStart(2, '0')}`, '    subject-kind definition\n'),
    );
  const k0 = body(root).appliesByWord;
  expect(k0.listed.length).toBe(SCOPE_BODY_LIMITS.pointers);
  expect(k0.count).toBe(extra + 1);
  // Listed by band then identity: the first 48 laws; two laws and the principle are tallied.
  const owner = {
    system: 'governance-system',
    steward: steward('governance'),
    seat: 'floor/definition/system/governance-system',
    read: `ia read ${steward('governance')}`,
  };
  expect(k0.tallies).toEqual([
    { word: 'law', count: 2, ...owner },
    { word: 'principle', count: 1, ...owner },
  ]);
  expect(k0.listed.map((line) => line.identity)).toEqual(
    [...k0.listed.map((line) => line.identity)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  // The key's word keeps only its own word in every tally, as for pointers.
  expect(body(root, { word: 'law', depth: 0, budget: 0 }).appliesByWord.tallies).toEqual([
    { word: 'law', count: 2, ...owner },
  ]);
});

it('delivers the plan cell of the fixture playbook: exact under governance, primary under context', () => {
  const root = corpus('minimal-playbook');
  const governance = body(root, { seat: FIXTURE_PLAYBOOK, shape: 'governance', phase: 'plan' });
  expect(governance.cells).toEqual({
    listed: [
      {
        playbook: FIXTURE_PLAYBOOK,
        via: ['seat'],
        address: `${FIXTURE_PLAYBOOK}#plan/Inference`,
        selection: 'exact',
        phase: 'plan',
        primitive: 'Inference',
        text: 'Infer the fixture step.',
        nearest: null,
      },
    ],
    count: 1,
  });
  // Context is Attention's shape: the plan phase has no Attention cell, so its primary plan cell is delivered.
  expect(body(root, { seat: FIXTURE_PLAYBOOK, shape: 'context', phase: 'plan' }).cells.listed).toEqual([
    expect.objectContaining({
      address: `${FIXTURE_PLAYBOOK}#plan/Inference`,
      selection: 'primary',
      phase: 'plan',
      primitive: 'Inference',
    }),
  ]);
});

it('takes cells from the playbooks that apply by word and the playbooks at the seat, at most four, by band and id', () => {
  // body(K0): the corpus playbook is captured under the workspace seat, so its (orient, Attention) cell is delivered.
  expect(body(workspace()).cells).toEqual({
    listed: [
      {
        playbook: PROCEDURE,
        via: ['seat'],
        address: `${PROCEDURE}#orient/Attention`,
        selection: 'exact',
        phase: 'orient',
        primitive: 'Attention',
        text: 'Sample fixture statement 4.',
        nearest: null,
      },
    ],
    count: 1,
  });
  const root = workspace();
  for (const name of ['p-a', 'p-b', 'p-c', 'p-d', 'p-e'])
    put(
      root,
      `${governanceRecords}/${name}.ia`,
      `#! ia 1.0\n@playbook ${name}\n  meaning\n    says "Fixture procedure ${name}."\n    answers "Which procedure is this?"\n  cognition\n    plan\n      primary Inference\n      Inference means "Plan ${name}."\n  subject\n    subject-word law\n`,
    );
  // At the law seat no playbook is composed; five apply by word (subject-word law). The first four by id are delivered.
  const at = body(root, { seat: LAW, shape: 'governance', depth: 0 }).cells;
  expect(at.count).toBe(5);
  expect(at.listed.map((cell) => [cell.playbook, cell.via, cell.address])).toEqual(
    ['p-a', 'p-b', 'p-c', 'p-d'].map((name) => [
      `governance-system/definition/procedure/${name}`,
      ['applies'],
      `governance-system/definition/procedure/${name}#plan/Inference`,
    ]),
  );
});

it('names the nearest phase with a cell when a playbook has none at the key phase', () => {
  const root = workspace();
  put(
    root,
    `${governanceRecords}/late.ia`,
    '#! ia 1.0\n@playbook late\n  meaning\n    says "A fixture procedure with act and learn cells only."\n    answers "Which phase has a cell?"\n  cognition\n    act\n      Attention means "Watch the step."\n    learn\n      primary Learning\n      Learning means "Record the outcome."\n',
  );
  const late = 'governance-system/definition/procedure/late';
  expect(body(root, { seat: late, shape: 'context', phase: 'plan' }).cells.listed).toEqual([
    {
      playbook: late,
      via: ['seat'],
      address: null,
      selection: null,
      phase: 'plan',
      primitive: 'Attention',
      text: null,
      // orient and act are both one phase from plan; orient, the earlier, has no cell, act has an Attention cell.
      nearest: 'act',
    },
  ]);
  // When both phases one away have a cell, the earlier one is the nearest.
  put(
    root,
    `${governanceRecords}/late.ia`,
    '#! ia 1.0\n@playbook late\n  meaning\n    says "A fixture procedure with orient and act cells."\n    answers "Which phase has a cell?"\n  cognition\n    orient\n      primary Attention\n      Attention means "Look around."\n    act\n      primary Attention\n      Attention means "Watch the step."\n',
  );
  expect(body(root, { seat: late, shape: 'context', phase: 'plan' }).cells.listed[0]!.nearest).toBe('orient');
});

it('keeps the fixture blocking law outside the budget among the applicable rules', () => {
  const root = corpus('minimal-law', 'minimal-playbook');
  const at = body(root, { seat: FIXTURE_PLAYBOOK, shape: 'governance', budget: 0 });
  // Only the seat is loaded, and only the blocking law is listed: the advisory principle is cut by the budget.
  expect(at.counts.loaded).toBe(1);
  expect(at.rules).toEqual({
    listed: [
      {
        identity: FIXTURE_LAW,
        word: 'law',
        kind: 'governance',
        lane: 'authority',
        system: 'governance-system',
        steward: steward('governance'),
        band: 100,
        severity: 'blocking',
        blocking: true,
        by: [{ by: 'subject-kind', value: 'definition', of: 'seat' }],
      },
    ],
    count: 2,
    truncated: 1,
  });
  // With room, the advisory rules follow the blocking ones, by band then id.
  put(root, `${governanceRecords}/z-law.ia`, law('z-law', '    subject-kind definition\n'));
  put(root, `${governanceRecords}/a-law.ia`, law('a-law', '    subject-kind definition\n'));
  const open: Location = { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' };
  expect(
    ids(
      body(
        root,
        { seat: FIXTURE_PLAYBOOK, shape: 'governance', budget: 16 },
        { [`${governanceRecords}/a-law.ia`]: open },
      ).rules.listed,
    ),
  ).toEqual([
    FIXTURE_LAW,
    'governance-system/governance/law/z-law',
    PRINCIPLE,
    'governance-system/governance/law/a-law',
  ]);
  // A path the fixture law covers: the law claims the location seat.
  const located = body(root, { seat: 'docs/guide.md', budget: 0 }).rules;
  expect(located.listed).toEqual([
    expect.objectContaining({
      identity: FIXTURE_LAW,
      blocking: true,
      by: [{ by: 'covers', value: 'docs/**', of: 'seat' }],
    }),
  ]);
});

it('applies rules by a governance row at the seat and by the key word', () => {
  // The check enforces the sample rule: a row in the governance shape's focus, read from the seat.
  const check = body(workspace(), { seat: CHECK, shape: 'governance', budget: 0 }).rules;
  expect(check.listed).toEqual([
    expect.objectContaining({ identity: LAW, blocking: true, by: [{ by: 'row', value: 'enforce', of: 'seat' }] }),
  ]);
  // The convention's subject names the contract word: a key with that word applies it, at any seat.
  const word = body(workspace(), { word: 'contract', budget: 16 }).rules;
  expect(word.listed.find((line) => line.identity === CONVENTION)).toEqual(
    expect.objectContaining({
      blocking: false,
      by: [
        { by: 'subject-word', value: 'contract', of: 'word' },
        { by: 'subject-kind', value: 'contract', of: 'word' },
      ],
    }),
  );
});

it('includes the mandates whose covers claims the seat, with whether they permit a read', () => {
  const root = corpus('minimal-mandate');
  put(
    root,
    `${agentRecords}/verify-only.ia`,
    mandate('verify-only', '    participant @agent agent-steward\n    moves [Verification]\n    covers ["docs/**"]\n'),
  );
  const mandates = body(root, { seat: 'docs/guide.md' }).mandates;
  expect(ids(mandates)).toEqual([FIXTURE_MANDATE, SAMPLE_MANDATE, 'agent-system/policy/mandate/verify-only']);
  expect(mandates[0]).toEqual({
    identity: FIXTURE_MANDATE,
    word: 'mandate',
    kind: 'policy',
    lane: 'enforcement',
    system: 'agent-system',
    steward: steward('agent'),
    band: 100,
    by: [{ by: 'covers', value: 'docs/**' }],
    participant: steward('agent'),
    moves: ['Observation', 'Verification'],
    scope: [WS],
    excludedWords: ['hook'],
    covers: ['docs/**'],
    refusal: null,
    problem: null,
  });
  // A position is a read: a mandate without the Observation move refuses it.
  expect(mandates[2]!.refusal).toEqual({
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: 'agent-system/policy/mandate/verify-only allows Verification; read needs Observation',
    next: 'ia inspect agent-system/policy/mandate/verify-only --edges both',
  });
  // Nothing claims the workspace seat, and the corpus workspace names no participant.
  expect(body(root).mandates).toEqual([]);
});

it("includes the mandates binding the seat workspace's participant, within their declared scope", () => {
  const root = corpus('minimal-mandate');
  stewarded(root);
  put(
    root,
    `${workspaceRecords}/second-workspace.ia`,
    '#! ia 1.0\n\n@workspace second-workspace\n  meaning\n    says "A second boundary."\n    answers "Which workspace is the other one?"\n  composition\n    systems [@system compliance-system]\n',
  );
  put(
    root,
    `${agentRecords}/elsewhere.ia`,
    mandate(
      'elsewhere',
      '    participant @agent agent-steward\n    moves [Observation]\n    scope [@workspace second-workspace]\n',
    ),
  );
  const at = body(root, { seat: WS }).mandates;
  expect(ids(at)).toEqual([FIXTURE_MANDATE, SAMPLE_MANDATE]);
  expect(at.map((entry) => entry.by)).toEqual([
    [{ by: 'participant', value: steward('agent') }],
    [{ by: 'participant', value: steward('agent') }],
  ]);
  expect(ids(body(root, { seat: 'agent-system/policy/mandate/elsewhere' }).mandates)).toEqual([]);
});

it('maps the position, read and next operations to the read mode, whose move is Observation', () => {
  expect(OPERATION_MODES).toEqual({ position: 'read', read: 'read', next: 'read' });
  expect(Object.isFrozen(OPERATION_MODES)).toBe(true);
  for (const mode of Object.values(OPERATION_MODES)) expect(MODE_MOVES[mode]).toBe('Observation');
});

it('keeps the on-demand sections pure: equal key values give byte-equal sections whatever the host', () => {
  const [a, b] = [corpus('minimal-law', 'minimal-playbook', 'minimal-mandate'), workspace()];
  stewarded(a);
  for (const name of ['minimal-law', 'minimal-playbook', 'minimal-mandate']) {
    const path = [...fixtures.keys()].find((candidate) => candidate.endsWith(`/${name}.ia`))!;
    put(b, path, fixtures.get(path)!);
  }
  stewarded(b);
  const key = normalizeScopeKey({ seat: FIXTURE_PLAYBOOK, shape: 'governance', phase: 'plan' });
  const [one, two] = [database(a), database(b)];
  const first = position(one, one.resolveScope({}).token, key),
    second = position(two, two.resolveScope({}).token, key, {
      hostFacts: () => ({ cli: 'ia@9.9.9', adapter: 'fixture-adapter@1.0.0' }),
    });
  const sections = (entry: PositionBody) =>
    stableSerialize([entry.appliesByWord, entry.cells, entry.rules, entry.mandates]);
  expect(sections(first.body)).toBe(sections(second.body));
  expect(first.digest).toBe(second.digest);
  for (const absent of [a, b, 'ia@9.9.9', 'fixture-adapter']) expect(sections(first.body)).not.toContain(absent);
});
