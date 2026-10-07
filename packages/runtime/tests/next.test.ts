import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Handle } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { expect, it } from 'vitest';
import {
  AUTHORED_EVIDENCE,
  DeliveryRefusal,
  NEXT_VIEW_FORMAT,
  STATE_LINES,
  next,
  observationEvidence,
  specStanding,
} from '../src/index.js';
import type { DeliveryView, EvidenceReader, NextRequest } from '../src/index.js';
import { database, put, workspace } from './workspace.js';

/**
 * The delivery view (`next`): a pure function of the admitted records a scope reads, the retained snapshot the handle
 * carries and the evidence its reader supplies. The fixtures are a copy of the conformance corpus with work records
 * and observations written into its work and learning systems.
 */
const workRecords = '.ia/src/systems/work-system/records',
  learningRecords = '.ia/src/systems/learning-system/records',
  workspaceRecords = '.ia/src/systems/workspace-system/records';
const PLAN = 'work-system/definition/plan/release-plan',
  ALPHA = 'work-system/definition/milestone/alpha-milestone',
  BETA = 'work-system/definition/milestone/beta-milestone',
  ASK = 'work-system/definition/task/ask-task',
  WRITE = 'work-system/definition/task/write-task',
  REVIEW = 'work-system/definition/task/review-task',
  LATER = 'work-system/definition/task/later-task',
  OPEN_DECISION = 'work-system/definition/decision/open-decision',
  MADE_DECISION = 'work-system/definition/decision/made-decision',
  WRITE_EVIDENCE = 'learning-system/definition/observation/write-evidence',
  WORK_STEWARD = 'agent-system/binding/agent/work-steward',
  AGENT_STEWARD = 'agent-system/binding/agent/agent-steward';
const runtime: Location = {
  placement: { kind: 'runtime', band: 0, reach: '' },
  provenance: 'runtime',
};

const plan = (name: string): string =>
  `@plan ${name}\n  meaning\n    says "Fixture plan ${name}."\n  work\n    title "${name}"\n    status open\n    owner "fixture owner"\n`;
function milestone(name: string, owner: string, requires: readonly string[] = []): string {
  const relationships =
    requires.length === 0 ? '' : `  relationships\n${requires.map((r) => `    requires ${r}\n`).join('')}`;
  return `@milestone ${name}\n  meaning\n    says "Fixture milestone ${name}."\n  work\n    title "${name}"\n    status open\n    plan @plan release-plan\n    exit "Fixture exit."\n    owner "${owner}"\n${relationships}`;
}
function task(name: string, of: string, requires: readonly string[] = [], extra = ''): string {
  const relationships =
    requires.length === 0 ? '' : `  relationships\n${requires.map((r) => `    requires ${r}\n`).join('')}`;
  return `@task ${name}\n  meaning\n    says "Fixture task ${name}."\n  work\n    title "${name}"\n    status open\n    milestone @milestone ${of}\n${extra}${relationships}`;
}
function decision(name: string, choice?: string): string {
  return `@decision ${name}\n  meaning\n    says "Fixture decision ${name}."\n  work\n    title "${name}"\n    status ${choice === undefined ? 'open' : 'made'}\n  decision\n    question "Which way?"\n${choice === undefined ? '' : `    choice "${choice}"\n`}`;
}
interface Observed {
  readonly subject: string;
  readonly revision?: string;
  readonly evaluator?: string;
  readonly verdict?: 'success' | 'refusal' | 'inconclusive';
}
function observation(name: string, observed: Observed): string {
  const typed = [
    `    subject ${observed.subject}\n`,
    observed.revision === undefined ? '' : `    subject-revision "${observed.revision}"\n`,
    observed.evaluator === undefined ? '' : `    evaluator "${observed.evaluator}"\n`,
    observed.verdict === undefined ? '' : `    verdict ${observed.verdict}\n`,
  ].join('');
  return (
    `@observation ${name}\n  meaning\n    says "Fixture evidence ${name}."\n    answers "What did the fixture observe?"\n` +
    `  evidence\n    origin check\n    actor "fixture evaluator"\n    observed-at "2026-10-07T00:00:00Z"\n` +
    `    captured-at "2026-10-07T00:00:00Z"\n    workspace "fixture"\n    locator "fixture"\n    revision "fixture"\n` +
    `    bundle "fixture.json"\n    digest "${'0'.repeat(64)}"\n    availability unavailable\n${typed}` +
    `  interpretation\n    applies "The fixture only."\n    limits "Fixture only."\n    reason "Fixture only."\n` +
    `    basis inference\n  retention\n    status retained\n`
  );
}
const file = (...records: readonly string[]): string => `#! ia 1.0\n\n${records.join('\n')}`;

/**
 * One plan, two milestones (alpha requires beta, so beta comes first although alpha sorts first) and four tasks:
 * ask-task needs an open decision, write-task has nothing to wait for and is owned by the work steward, review-task
 * needs write-task and a made decision, later-task needs review-task and a task that does not exist.
 */
function delivery(root: string, extra: readonly string[] = []): void {
  put(
    root,
    `${workRecords}/delivery.ia`,
    file(
      plan('release-plan'),
      milestone('alpha-milestone', 'alpha owner', ['@milestone beta-milestone']),
      milestone('beta-milestone', 'beta owner'),
      task('ask-task', 'beta-milestone', ['@decision open-decision']),
      task('write-task', 'beta-milestone', [], '    owner-agent @agent work-steward\n'),
      task('review-task', 'beta-milestone', ['@task write-task', '@decision made-decision']),
      task('later-task', 'alpha-milestone', ['@task review-task', '@task missing-task']),
      decision('open-decision'),
      decision('made-decision', 'the fixture way'),
      ...extra,
    ),
  );
}
const digestOf = (root: string, identity: string): string => database(root).get(identity)!.digest;
function evidence(root: string, ...records: readonly string[]): void {
  put(root, `${learningRecords}/delivery-evidence.ia`, file(...records));
}
/** The fixture with write-task's success evidence at its current digest, attributed to its owner agent. */
function evidenced(): string {
  const root = workspace();
  delivery(root);
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision: digestOf(root, WRITE),
      evaluator: WORK_STEWARD,
      verdict: 'success',
    }),
  );
  return root;
}
function view(db: Handle, request: NextRequest = {}, reader?: EvidenceReader): DeliveryView {
  return next(db, db.resolveScope({}).token, request, reader === undefined ? {} : { evidence: reader });
}
const entry = (result: DeliveryView, identity: string) => result.entries.find((item) => item.identity === identity)!;
const line = (result: DeliveryView, identity: string, name: string) =>
  entry(result, identity).lines.find((item) => item.line === name)!;
function refusal(run: () => unknown): DeliveryRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof DeliveryRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}
/** Every path under `.ia`, with its size: a view that writes, renames or touches a file changes this listing. */
function listing(root: string): readonly string[] {
  const base = resolve(root, '.ia');
  return (readdirSync(base, { recursive: true }) as string[])
    .map((path) => `${path}:${statSync(resolve(base, path)).size}`)
    .sort();
}

it('lists the plan, its milestones and their tasks in plan order, each with the five state lines', () => {
  const db = database(evidenced()),
    result = view(db);
  expect(result.format).toBe(NEXT_VIEW_FORMAT);
  expect(NEXT_VIEW_FORMAT).toBe('ia-next-1');
  expect(result.revision).toBe(db.revision);
  // With no seat the only authored plan is the seat.
  expect(result.seat).toEqual({ identity: PLAN, word: 'plan', declared: false });
  expect(result.ordered).toBe(true);
  expect(result.review).toEqual([]);
  // beta before alpha (alpha requires beta); inside beta ask and write wait for nothing (identity order), review
  // follows write.
  expect(result.entries.map((item) => item.identity)).toEqual([PLAN, BETA, ASK, WRITE, REVIEW, ALPHA, LATER]);
  expect(entry(result, ASK)).toMatchObject({ word: 'task', milestone: BETA, status: 'open' });
  expect(entry(result, BETA)).toMatchObject({ word: 'milestone', milestone: null });
  expect(STATE_LINES).toEqual(['accepted', 'admitted', 'realizable', 'realized', 'worked']);
  for (const item of result.entries) {
    expect(item.lines.map((state) => state.line)).toEqual([...STATE_LINES]);
    for (const state of item.lines) expect(state.basis).not.toBe('');
  }
  expect(line(result, ASK, 'accepted')).toMatchObject({ value: 'accepted' });
  expect(line(result, ASK, 'accepted').basis).toContain('task');
  expect(line(result, LATER, 'realizable')).toMatchObject({ value: 'unresolved' });
  expect(line(result, LATER, 'realizable').basis).toContain('@task missing-task');
  expect(line(result, REVIEW, 'realizable')).toMatchObject({ value: 'resolved' });
  expect(line(result, WRITE, 'realized')).toMatchObject({ value: 'recorded' });
  expect(line(result, WRITE, 'realized').basis).toContain(WRITE_EVIDENCE);
  expect(line(result, WRITE, 'worked')).toMatchObject({ value: 'observed success' });
  expect(line(result, REVIEW, 'realized')).toMatchObject({ value: 'unobserved' });
  expect(line(result, REVIEW, 'worked')).toMatchObject({ value: 'unobserved' });
  // No snapshot is retained by a fresh handle, so whether one admitted the record is unknown, never assumed.
  expect(line(result, ASK, 'admitted')).toMatchObject({ value: 'unknown' });
  expect(result.snapshot).toBeNull();
});

it('gives every record one of the three verdicts, naming each basis it rests on', () => {
  const result = view(database(evidenced()));
  expect(entry(result, ASK).verdict).toEqual({
    kind: 'blocked',
    text: `blocked (${OPEN_DECISION} no choice)`,
    observation: null,
    evaluator: null,
    selfAttributed: false,
  });
  expect(entry(result, ASK).basis).toEqual([
    {
      predicate: 'require',
      target: OPEN_DECISION,
      resolved: true,
      word: 'decision',
      standing: 'no choice',
      blocking: true,
    },
  ]);
  // The owner agent recorded the evidence: self-attributed.
  expect(entry(result, WRITE).verdict).toEqual({
    kind: 'evidence',
    text: `exit evidence recorded (${WRITE_EVIDENCE}, evaluator ${WORK_STEWARD}, self-attributed)`,
    observation: WRITE_EVIDENCE,
    evaluator: WORK_STEWARD,
    selfAttributed: true,
  });
  expect(entry(result, REVIEW).verdict).toMatchObject({ kind: 'clear', text: 'no declared blocker' });
  expect(entry(result, REVIEW).basis).toEqual([
    {
      predicate: 'require',
      target: MADE_DECISION,
      resolved: true,
      word: 'decision',
      standing: 'choice made',
      blocking: false,
    },
    {
      predicate: 'require',
      target: WRITE,
      resolved: true,
      word: 'task',
      standing: `exit evidence ${WRITE_EVIDENCE}`,
      blocking: false,
    },
  ]);
  // A predecessor without exit evidence and a requirement that names nothing both block.
  expect(entry(result, LATER).verdict).toMatchObject({
    kind: 'blocked',
    text: `blocked (${REVIEW} no exit evidence; @task missing-task unresolved)`,
  });
  expect(entry(result, LATER).basis.map((item) => [item.target, item.resolved, item.standing])).toEqual([
    [REVIEW, true, 'no exit evidence'],
    ['@task missing-task', false, 'unresolved'],
  ]);
  // A milestone's requirements are read the same way: beta has no exit evidence, so alpha is blocked.
  expect(entry(result, ALPHA).verdict.text).toBe(`blocked (${BETA} no exit evidence)`);
  expect(entry(result, BETA).verdict.text).toBe('no declared blocker');
  // The next command positions at the first task in plan order with no declared blocker.
  expect(result.next).toBe(`ia position --seat ${REVIEW}`);
  for (const item of result.entries)
    expect(
      item.verdict.text === 'no declared blocker' ||
        /^blocked \(.+\)$/.test(item.verdict.text) ||
        /^exit evidence recorded \(\S+, evaluator \S+(, self-attributed)?\)$/.test(item.verdict.text),
    ).toBe(true);
});

it('attributes evidence to its evaluator, and to the participant when the evaluator is the workspace steward', () => {
  const root = workspace();
  delivery(root);
  const revision = digestOf(root, WRITE);
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision,
      evaluator: 'fixture-tool@1.0.0',
      verdict: 'success',
    }),
  );
  expect(entry(view(database(root)), WRITE).verdict.text).toBe(
    `exit evidence recorded (${WRITE_EVIDENCE}, evaluator fixture-tool@1.0.0)`,
  );
  // The participant is the home workspace's steward, as the position body reads it.
  const path = `${workspaceRecords}/foundation-workspace.ia`;
  put(
    root,
    path,
    readFileSync(resolve(root, path), 'utf8').replace(
      'session-system]\n',
      'session-system]\n    steward @agent agent-steward\n',
    ),
  );
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision,
      evaluator: AGENT_STEWARD,
      verdict: 'success',
    }),
  );
  const result = view(database(root));
  expect(result.participant).toBe(AGENT_STEWARD);
  expect(entry(result, WRITE).verdict).toMatchObject({ evaluator: AGENT_STEWARD, selfAttributed: true });
  // Missing evaluator: the evidence still closes the task, and says the evaluator is unknown.
  evidence(root, observation('write-evidence', { subject: '@task write-task', revision, verdict: 'success' }));
  expect(entry(view(database(root)), WRITE).verdict.text).toBe(
    `exit evidence recorded (${WRITE_EVIDENCE}, evaluator unknown)`,
  );
});

it('reads evidence against the retained snapshot: stale on the previous digest, unknown on neither', () => {
  const root = evidenced(),
    before = database(root),
    retained = {
      revision: before.revision,
      digests: new Map(before.records().map((node) => [node.identity, node.digest])),
    };
  // Edit write-task after the observation: its digest moves, the observation's subject-revision does not.
  put(
    root,
    `${workRecords}/delivery.ia`,
    readFileSync(resolve(root, `${workRecords}/delivery.ia`), 'utf8').replace(
      'says "Fixture task write-task."',
      'says "Fixture task write-task, edited."',
    ),
  );
  const stale = view(database(root, { previous: retained }));
  expect(stale.snapshot).toBe(before.revision);
  expect(line(stale, WRITE, 'worked')).toMatchObject({ value: 'stale' });
  expect(line(stale, WRITE, 'realized')).toMatchObject({ value: 'recorded' });
  // Stale evidence closes nothing: write-task has nothing to wait for, and review-task waits for it again.
  expect(entry(stale, WRITE).verdict.text).toBe('no declared blocker');
  expect(entry(stale, REVIEW).verdict.text).toBe(`blocked (${WRITE} exit evidence stale (${WRITE_EVIDENCE}))`);
  // The retained snapshot admitted the unchanged records at their digests, not the edited one.
  expect(line(stale, ASK, 'admitted')).toMatchObject({ value: 'admitted' });
  expect(line(stale, WRITE, 'admitted')).toMatchObject({ value: 'not evaluated' });
  // A second success at the current digest is preferred over the one at the retained snapshot's digest, although
  // its identity sorts after it.
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision: retained.digests.get(WRITE)!,
      evaluator: WORK_STEWARD,
      verdict: 'success',
    }),
    observation('write-evidence-current', {
      subject: '@task write-task',
      revision: digestOf(root, WRITE),
      evaluator: WORK_STEWARD,
      verdict: 'success',
    }),
  );
  const both = view(database(root, { previous: retained }));
  expect(line(both, WRITE, 'worked')).toMatchObject({ value: 'observed success' });
  expect(entry(both, WRITE).verdict.observation).toBe('learning-system/definition/observation/write-evidence-current');
  expect(entry(both, REVIEW).verdict.text).toBe('no declared blocker');
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision: retained.digests.get(WRITE)!,
      evaluator: WORK_STEWARD,
      verdict: 'success',
    }),
  );
  // Without a retained snapshot the old digest matches neither: unknown, and the view names no stale evidence.
  const unknown = view(database(root));
  expect(line(unknown, WRITE, 'worked')).toMatchObject({ value: 'unknown' });
  expect(entry(unknown, REVIEW).verdict.text).toBe(`blocked (${WRITE} no exit evidence)`);
  // A refusal verdict at the current digest is observed, but is no exit evidence.
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision: digestOf(root, WRITE),
      evaluator: WORK_STEWARD,
      verdict: 'refusal',
    }),
  );
  const refused = view(database(root));
  expect(line(refused, WRITE, 'worked')).toMatchObject({ value: 'observed refusal' });
  expect(entry(refused, WRITE).verdict.text).toBe('no declared blocker');
});

it('reports a require cycle as a review item with its owner and claims no order', () => {
  const root = workspace();
  delivery(root, [
    task('loop-a-task', 'alpha-milestone', ['@task loop-b-task']),
    task('loop-b-task', 'alpha-milestone', ['@task loop-a-task']),
    // wait-task waits on the cycle without lying on it: unordered, listed, yet not a cycle member.
    task('wait-task', 'alpha-milestone', ['@task loop-a-task']),
  ]);
  const result = view(database(root));
  expect(result.ordered).toBe(false);
  expect(result.review).toEqual([
    {
      kind: 'cycle',
      records: ['work-system/definition/task/loop-a-task', 'work-system/definition/task/loop-b-task'],
      owner: 'alpha owner',
    },
  ]);
  // Every record is still listed with its lines and verdict.
  expect(result.entries.map((item) => item.identity)).toContain('work-system/definition/task/loop-a-task');
  expect(entry(result, 'work-system/definition/task/loop-a-task').verdict.kind).toBe('blocked');
  expect(entry(result, 'work-system/definition/task/wait-task').verdict.kind).toBe('blocked');
  // write-task has no declared blocker, but with no order to claim the view names no next command.
  expect(entry(result, WRITE).verdict.kind).toBe('clear');
  expect(result.next).toBeNull();
});

it('narrows to a milestone or task seat and refuses a request it cannot answer, naming the next command', () => {
  const root = evidenced(),
    db = database(root);
  expect(view(db, { seat: BETA }).entries.map((item) => item.identity)).toEqual([BETA, ASK, WRITE, REVIEW]);
  expect(view(db, { seat: BETA }).seat).toEqual({ identity: BETA, word: 'milestone', declared: true });
  expect(view(db, { seat: LATER }).entries.map((item) => item.identity)).toEqual([LATER]);
  // A record that is not a plan, milestone or task: position at it instead.
  const notWork = refusal(() => view(db, { seat: OPEN_DECISION }));
  expect(notWork.code).toBe('IA-RUNTIME-REQUEST-INVALID');
  expect(notWork.next).toBe(`ia position --seat ${OPEN_DECISION}`);
  // A seat that names nothing the scope reads.
  const nothing = refusal(() => view(db, { seat: 'work-system/definition/task/no-such-task' }));
  expect(nothing.code).toBe('IA-RUNTIME-REQUEST-INVALID');
  expect(nothing.next).toBe('ia next');
  expect(() => view(db, { seat: '' })).toThrow(/IA-RUNTIME-REQUEST-INVALID/);
  // No plan and no seat: the worked example of a plan.
  const empty = refusal(() => view(database(workspace())));
  expect(empty.code).toBe('IA-RUNTIME-REQUEST-INVALID');
  expect(empty.next).toBe('ia vocabulary plan --example');
  // Two plans and no seat: both are named and the next command picks the first.
  put(root, `${workRecords}/other-plan.ia`, file(plan('another-plan')));
  const two = refusal(() => view(database(root)));
  expect(two.message).toContain('work-system/definition/plan/another-plan');
  expect(two.message).toContain(PLAN);
  expect(two.next).toBe('ia next --seat work-system/definition/plan/another-plan');
  expect(view(database(root), { seat: PLAN }).seat).toEqual({ identity: PLAN, word: 'plan', declared: true });
  // Only authored plans are found without a seat: an open-band plan is visible, not taken on.
  const open: Location = { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' };
  expect(view(database(root, { locations: { [`${workRecords}/other-plan.ia`]: open } })).seat).toEqual({
    identity: PLAN,
    word: 'plan',
    declared: false,
  });
});

it('counts on the accepted line the findings that name the record', () => {
  const root = workspace();
  delivery(root, [task('agentless-task', 'beta-milestone', [], '    owner-agent @agent no-such-agent\n')]);
  const result = view(database(root));
  // An owner agent that names no record is a warning on the task, which is still admitted.
  expect(line(result, 'work-system/definition/task/agentless-task', 'accepted')).toEqual({
    line: 'accepted',
    value: 'accepted',
    basis: 'admitted against floor/contract/head/task; 1 finding names it',
  });
  expect(line(result, ASK, 'accepted').basis).toBe('admitted against floor/contract/head/task');
});

it('stores nothing and gives one frozen view whatever the scope token', () => {
  const root = evidenced(),
    before = listing(root),
    db = database(root),
    first = next(db, db.resolveScope({}).token),
    second = next(db, db.resolveScope({}).token);
  expect(listing(root)).toEqual(before);
  expect(stableSerialize(second)).toBe(stableSerialize(first));
  expect(stableSerialize(view(database(root)))).toBe(stableSerialize(first));
  expect(Object.isFrozen(first) && Object.isFrozen(first.entries) && Object.isFrozen(first.entries[0]!.lines)).toBe(
    true,
  );
  const text = stableSerialize(first);
  expect(text).not.toContain(root);
  expect(text).not.toContain(db.resolveScope({}).token);
});

it('reads authored observations by default; another evidence reader may add the runtime band and names its overlay', () => {
  const root = workspace();
  delivery(root);
  const evidencePath = `${learningRecords}/delivery-evidence.ia`;
  evidence(
    root,
    observation('write-evidence', {
      subject: '@task write-task',
      revision: digestOf(root, WRITE),
      evaluator: WORK_STEWARD,
      verdict: 'success',
    }),
  );
  const db = database(root, { locations: { [evidencePath]: runtime } }),
    plain = view(db);
  expect(plain.evidence).toEqual({ reader: 'authored', overlay: null });
  expect(line(plain, WRITE, 'realized')).toMatchObject({ value: 'unobserved' });
  expect(entry(plain, WRITE).verdict.kind).toBe('clear');
  expect(view(db, {}, AUTHORED_EVIDENCE)).toEqual(plain);
  // Nor does the default reader take observations read at an adopted or open placement: authored ones only.
  for (const placement of [
    { kind: 'adopted', band: 90, reach: '' },
    { kind: 'open', band: 50, reach: '' },
  ] as const) {
    const placed = view(database(root, { locations: { [evidencePath]: { placement, provenance: 'methodology' } } }));
    expect(line(placed, WRITE, 'realized')).toMatchObject({ value: 'unobserved' });
    expect(entry(placed, WRITE).verdict.kind).toBe('clear');
  }
  const overlay: EvidenceReader = {
    name: 'fixture-overlay',
    read: (handle, within) => ({
      observations: handle
        .records({ within })
        .filter((node) => node.discriminator === 'observation' && node.placement.kind === 'runtime')
        .map((node) => observationEvidence(handle, within, node)),
      overlay: 'f'.repeat(64),
    }),
  };
  const overlaid = view(db, {}, overlay);
  expect(overlaid.evidence).toEqual({ reader: 'fixture-overlay', overlay: 'f'.repeat(64) });
  expect(line(overlaid, WRITE, 'realized')).toMatchObject({ value: 'recorded' });
  expect(line(overlaid, WRITE, 'realized').basis).toContain('runtime');
  expect(entry(overlaid, WRITE).verdict).toMatchObject({ kind: 'evidence', observation: WRITE_EVIDENCE });
});

it('lists the native work records: the example task waits on its open decision', () => {
  const root = workspace();
  put(
    root,
    `${workRecords}/work.ia`,
    readFileSync(resolve(import.meta.dirname, '../../../.ia/src/systems/work-system/records/work.ia'), 'utf8'),
  );
  const result = view(database(root));
  expect(result.seat.identity).toBe('work-system/definition/plan/example-plan');
  expect(result.entries.map((item) => item.identity)).toEqual([
    'work-system/definition/plan/example-plan',
    'work-system/definition/milestone/example-milestone',
    'work-system/definition/task/example-task',
  ]);
  expect(entry(result, 'work-system/definition/task/example-task').verdict.text).toBe(
    'blocked (work-system/definition/decision/example-decision no choice)',
  );
  expect(result.next).toBeNull();
});

it('keeps a partially superseded spec live for the scope it does not replace, and a supersession current until grounded', () => {
  const source = readFileSync(
      resolve(import.meta.dirname, '../../../.ia/src/systems/work-system/records/work.ia'),
      'utf8',
    ),
    SPEC = 'work-system/contract/spec/example-spec',
    REFERENCE = 'work-system/contract/spec/example-reference-spec',
    SPLIT = 'work-system/definition/decision/example-split-decision';
  const standing = (text: string) => {
    const root = workspace();
    put(root, `${workRecords}/work.ia`, text);
    const db = database(root);
    return specStanding(db, db.resolveScope({}).token, SPEC);
  };
  expect(standing(source)).toEqual({
    standing: `partially superseded by ${REFERENCE} (grounded by ${SPLIT})`,
    blocking: false,
  });
  expect(standing(source.replace(/\n {4}replaced-scope "[^"]*"/, ''))).toEqual({
    standing: `superseded by ${REFERENCE} (grounded by ${SPLIT})`,
    blocking: true,
  });
  expect(standing(source.replace(/\n {4}effective-revision "[^"]*"/, ''))).toEqual({
    standing: `supersession declared, not grounded (${REFERENCE})`,
    blocking: false,
  });
  expect(standing(source.replace(/\n {4}grounded-by @decision example-split-decision/, ''))).toEqual({
    standing: `supersession declared, not grounded (${REFERENCE})`,
    blocking: false,
  });
  // The superseding spec itself is current.
  const root = workspace();
  put(root, `${workRecords}/work.ia`, source);
  const db = database(root);
  expect(specStanding(db, db.resolveScope({}).token, REFERENCE)).toEqual({ standing: 'current', blocking: false });
});

it('never claims a requirement it cannot read: a target outside the scope blocks as unknown', () => {
  const root = evidenced(),
    db = database(root),
    within = db.resolveScope({ identities: [PLAN, BETA, ALPHA, ASK, WRITE, REVIEW, LATER, WRITE_EVIDENCE] }).token,
    result = next(db, within);
  // The made decision lies outside the scope: review-task cannot claim it has a choice.
  expect(entry(result, REVIEW).basis).toContainEqual({
    predicate: 'require',
    target: MADE_DECISION,
    resolved: true,
    word: null,
    standing: 'outside the scope',
    blocking: true,
  });
  expect(entry(result, REVIEW).verdict.kind).toBe('blocked');
  expect(entry(result, WRITE).verdict.kind).toBe('evidence');
  // A seat the scope does not read gets one refusal, whether it lies outside the scope or names nothing: the view
  // reads only through the token, so it cannot tell the two apart.
  const outside = refusal(() => next(db, within, { seat: MADE_DECISION })),
    missing = refusal(() => next(db, within, { seat: 'work-system/definition/task/no-such-task' }));
  expect([outside.code, outside.next]).toEqual(['IA-RUNTIME-REQUEST-INVALID', 'ia next']);
  expect([missing.code, missing.next]).toEqual([outside.code, outside.next]);
  expect(outside.message.replace(MADE_DECISION, '<seat>')).toBe(
    missing.message.replace('work-system/definition/task/no-such-task', '<seat>'),
  );
});

/** `db` with every method call checked to carry `within`; any other read is a property, recorded in `properties`. */
function guarded(db: Handle, within: string, properties: Set<string>): Handle {
  return new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        properties.add(String(property));
        return value;
      }
      return (...args: unknown[]) => {
        const options = args.at(-1);
        if (typeof options !== 'object' || options === null || (options as { within?: unknown }).within !== within)
          throw new Error(`${String(property)} read without the scope token`);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

it('reads the handle only through the scope token it is given', () => {
  const db = database(evidenced()),
    within = db.resolveScope({ identities: [PLAN, BETA, ALPHA, ASK, WRITE, REVIEW, LATER, WRITE_EVIDENCE] }).token,
    properties = new Set<string>(),
    guard = guarded(db, within, properties);
  expect(stableSerialize(next(guard, within))).toBe(stableSerialize(next(db, within)));
  expect(next(guard, within, { seat: BETA }).seat.identity).toBe(BETA);
  for (const seat of [MADE_DECISION, 'work-system/definition/task/no-such-task'])
    expect(refusal(() => next(guard, within, { seat })).next).toBe('ia next');
  // The findings the accepted line counts come from the handle's report, filtered to the listed record.
  expect([...properties]).toEqual(['report']);
  // Supersessions, in either spelling, and the decisions grounding them are read through the token too.
  const OLD = 'work-system/definition/task/aaa-old-task',
    NEW = 'work-system/definition/task/zzz-new-task',
    PRIOR = 'work-system/definition/task/aab-prior-task',
    LATEST = 'work-system/definition/task/zzy-latest-task',
    SPLIT = 'work-system/definition/decision/split-decision';
  const relating = (name: string, rows: string) =>
    `@task ${name}\n  meaning\n    says "Fixture task ${name}."\n  work\n    title "${name}"\n    status open\n` +
    `    milestone @milestone beta-milestone\n  relationships\n${rows}`;
  const root = workspace();
  delivery(root, [
    task('aaa-old-task', 'beta-milestone'),
    relating('zzz-new-task', '    supersedes @task aaa-old-task\n'),
    relating('aab-prior-task', '    superseded-by @task zzy-latest-task\n'),
    task('zzy-latest-task', 'beta-milestone'),
    `${decision('split-decision', 'the newer task')}    effective-revision "${'0'.repeat(63)}1"\n` +
      `  relationships\n    grounds @task zzz-new-task\n`,
  ]);
  const related = database(root),
    scoped = related.resolveScope({
      identities: [PLAN, BETA, ALPHA, ASK, WRITE, REVIEW, LATER, OLD, NEW, PRIOR, LATEST, SPLIT],
    }).token,
    read = next(guarded(related, scoped, properties), scoped);
  expect(stableSerialize(read)).toBe(stableSerialize(next(related, scoped)));
  expect(entry(read, OLD).verdict.text).toBe(`blocked (superseded by ${NEW} (grounded by ${SPLIT}))`);
  expect(entry(read, PRIOR).verdict.text).toBe(
    `blocked (superseded by ${LATEST} (supersession declared, not grounded))`,
  );
  expect([...properties]).toEqual(['report']);
});

it('reads a requirement another record declares in the inverse spelling', () => {
  const root = workspace();
  delivery(root, [
    '@task yield-task\n  meaning\n    says "Fixture task yield-task."\n  work\n    title "yield-task"\n    status open\n' +
      '    milestone @milestone alpha-milestone\n  relationships\n    required-by @task later-task\n',
  ]);
  const result = view(database(root));
  expect(entry(result, LATER).basis.map((item) => [item.target, item.standing])).toContainEqual([
    'work-system/definition/task/yield-task',
    'no exit evidence',
  ]);
  // The requirement orders the tasks too: yield-task before later-task, although it sorts after.
  const order = result.entries.map((item) => item.identity);
  expect(order.indexOf('work-system/definition/task/yield-task')).toBeLessThan(order.indexOf(LATER));
});

it('blocks a record another one supersedes, names the supersession, and never offers it as next', () => {
  const OLD = 'work-system/definition/task/aaa-old-task',
    NEW = 'work-system/definition/task/zzz-new-task',
    PRIOR = 'work-system/definition/task/aab-prior-task',
    LATEST = 'work-system/definition/task/zzy-latest-task',
    SPLIT = 'work-system/definition/decision/split-decision';
  const superseding = (name: string, rows: string) =>
    `@task ${name}\n  meaning\n    says "Fixture task ${name}."\n  work\n    title "${name}"\n    status open\n` +
    `    milestone @milestone beta-milestone\n  relationships\n${rows}`;
  const root = workspace();
  delivery(root, [
    task('aaa-old-task', 'beta-milestone'),
    superseding('zzz-new-task', '    supersedes @task aaa-old-task\n'),
    // The inverse spelling, declared on the superseded record.
    superseding('aab-prior-task', '    superseded-by @task zzy-latest-task\n'),
    task('zzy-latest-task', 'beta-milestone'),
  ]);
  const result = view(database(root));
  // aaa-old-task sorts first and waits for nothing it requires, yet a declared supersession blocks it.
  expect(entry(result, OLD).verdict).toEqual({
    kind: 'blocked',
    text: `blocked (superseded by ${NEW} (supersession declared, not grounded))`,
    observation: null,
    evaluator: null,
    selfAttributed: false,
  });
  expect(entry(result, OLD).basis).toEqual([
    {
      predicate: 'supersede',
      target: NEW,
      resolved: true,
      word: 'task',
      standing: `superseded by ${NEW} (supersession declared, not grounded)`,
      blocking: true,
    },
  ]);
  expect(entry(result, PRIOR).verdict.text).toBe(
    `blocked (superseded by ${LATEST} (supersession declared, not grounded))`,
  );
  // The superseding records wait for nothing; a supersession is no requirement.
  expect(entry(result, NEW).verdict.text).toBe('no declared blocker');
  expect(entry(result, LATEST).verdict.text).toBe('no declared blocker');
  expect(line(result, OLD, 'realizable')).toMatchObject({ value: 'resolved', basis: 'declares no requirement' });
  // The next command skips the superseded records.
  expect(result.next).toBe(`ia position --seat ${WRITE}`);
  // A grounding decision with a choice and an effective revision names the grounding.
  put(
    root,
    `${workRecords}/grounding.ia`,
    file(
      `${decision('split-decision', 'the newer task')}    effective-revision "${'0'.repeat(63)}1"\n` +
        `  relationships\n    grounds @task zzz-new-task\n`,
    ),
  );
  expect(entry(view(database(root)), OLD).verdict.text).toBe(`blocked (superseded by ${NEW} (grounded by ${SPLIT}))`);
  // A superseding record in the runtime band is never read: the supersession is not seen.
  const latestPath = `${workRecords}/latest.ia`;
  put(root, latestPath, file(superseding('zzx-runtime-task', '    supersedes @task aab-prior-task\n')));
  const banded = view(database(root, { locations: { [latestPath]: runtime } }));
  expect(entry(banded, PRIOR).basis.map((item) => item.target)).toEqual([LATEST]);
});

it('never offers a record that names its superseder outside the scope: the supersession blocks as unread', () => {
  const OLD = 'work-system/definition/task/aaa-old-task',
    NEW = 'work-system/definition/task/zzz-new-task',
    GONE = 'work-system/definition/task/aab-gone-task',
    newPath = `${workRecords}/new.ia`;
  const superseded = (name: string, by: string) =>
    `@task ${name}\n  meaning\n    says "Fixture task ${name}."\n  work\n    title "${name}"\n    status open\n` +
    `    milestone @milestone beta-milestone\n  relationships\n    superseded-by @task ${by}\n`;
  const root = workspace();
  // The inverse spelling, declared on the superseded record itself; the superseding record is in another file.
  delivery(root, [superseded('aaa-old-task', 'zzz-new-task'), superseded('aab-gone-task', 'no-such-task')]);
  put(root, newPath, file(task('zzz-new-task', 'beta-milestone')));
  const unread = (target: string) => ({
    predicate: 'supersede',
    target,
    resolved: true,
    word: null,
    standing: `superseded by ${target} (outside the scope)`,
    blocking: true,
  });
  // The superseding record lies outside the scope: the token prunes its row, so the view names the reference as
  // written, and the record cannot claim it is clear, as with a requirement.
  const db = database(root),
    narrow = next(db, db.resolveScope({ identities: [PLAN, BETA, ALPHA, ASK, WRITE, REVIEW, LATER, OLD, GONE] }).token);
  expect(entry(narrow, OLD).basis).toEqual([unread('@task zzz-new-task')]);
  expect(entry(narrow, OLD).verdict.text).toBe('blocked (superseded by @task zzz-new-task (outside the scope))');
  // A superseding record that resolves to none blocks too.
  expect(entry(narrow, GONE).basis).toEqual([
    {
      predicate: 'supersede',
      target: '@task no-such-task',
      resolved: false,
      word: null,
      standing: 'superseded by @task no-such-task (unresolved)',
      blocking: true,
    },
  ]);
  expect(narrow.next).toBe(`ia position --seat ${WRITE}`);
  // A superseding record in the runtime band is never read: the same basis, naming the record.
  expect(entry(view(database(root, { locations: { [newPath]: runtime } })), OLD).basis).toEqual([unread(NEW)]);
  // With the full scope, the superseding record is read and named.
  expect(entry(view(db), OLD).basis).toEqual([
    { ...unread(NEW), word: 'task', standing: `superseded by ${NEW} (supersession declared, not grounded)` },
  ]);
});

it("takes the observation a record's work.exit-evidence names, whatever subject it names", () => {
  const root = workspace();
  delivery(root, [task('declared-task', 'beta-milestone', [], '    exit-evidence @observation declared-evidence\n')]);
  const declared = 'work-system/definition/task/declared-task';
  evidence(
    root,
    observation('declared-evidence', {
      subject: '@decision made-decision',
      revision: digestOf(root, declared),
      evaluator: 'fixture-tool@1.0.0',
      verdict: 'success',
    }),
  );
  expect(entry(view(database(root)), declared).verdict.text).toBe(
    'exit evidence recorded (learning-system/definition/observation/declared-evidence, evaluator fixture-tool@1.0.0)',
  );
});
