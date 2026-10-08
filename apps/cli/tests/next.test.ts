/**
 * `ia next` (position-and-projection §9 step 2, design rows 21 and 22), end to end against copies of the runtime's
 * delivery fixtures laid over the conformance corpus, a copy of the loop fixture, which authors no plan, and the
 * repository's own records, which author two.
 *
 * The exit evidence of plan task ia-next-verb: `ia next` lists each task of a plan with a basis or evidence line, and
 * stores nothing under `.ia/`. Its `--json` view is the Door's `next` result, byte for byte.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Door } from '@inventarch/runtime';
import type { DeliveryView, DoorResponse } from '@inventarch/runtime';
import { renderNext } from '../src/next.js';
import { quote, resolveCapabilities } from '../src/render.js';
import { cleanup, commandsIn, delivery, nextArgv, repository, run, workspace } from './workspace-fixture.js';

afterAll(cleanup);

const PLAN = 'work-system/definition/plan/release';
const task = (name: string): string => `work-system/definition/task/${name}`;
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const rooted = (root: string): string => `--root ${quote(root)}`;

interface Envelope {
  readonly version: number;
  readonly ok: boolean;
  readonly view: DeliveryView;
}
interface RefusalBody {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly exit: number;
  readonly where: { readonly path: string | null; readonly line: number | null; readonly identity: string | null };
  readonly next: string;
}
/** `ia next --json`: one value on stdout and nothing on stderr. */
async function next(root: string, extra: readonly string[] = [], exitCode = 0): Promise<Envelope & RefusalBody> {
  const result = await run(['next', ...extra, '--root', root, '--json']);
  expect(result.exitCode, result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.slice(0, -1)).not.toContain('\n');
  return JSON.parse(result.stdout) as Envelope & RefusalBody;
}
/** The runtime Door's `next` on `root`, with its own handle. */
function door(root: string, params: Record<string, unknown> = {}): DoorResponse {
  const gate = new Door(root, { cache: false });
  try {
    return gate.request({ operation: 'next', params });
  } finally {
    gate.close();
  }
}
/** Every file below `directory`, by relative path, hashed with its bytes, so a run is shown to write nothing there. */
function tree(directory: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => join(dirent.parentPath, dirent.name))
    .sort();
  for (const path of files)
    hash
      .update(`${relative(directory, path)}\0`)
      .update(readFileSync(path))
      .update('\0');
  return hash.digest('hex');
}
/** A `@task` of the foundation milestone whose status is outside its closed set, so admission refuses it. */
const REFUSED_TASK = [
  '#! ia 1.0',
  '',
  '@task migrate',
  '  meaning',
  '    says "Migrate the fixture data."',
  '  work',
  '    title "Migrate"',
  '    status bogus',
  '    milestone @milestone foundation',
  '',
].join('\n');
/** `root`, a delivery fixture, with the status of the record `header` opens outside its closed set, so admission refuses it. */
function refuse(root: string, header: string): string {
  const path = resolve(root, '.ia/src/work.ia');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(new RegExp(`(^${header}\\r?\\n(?:.*\\r?\\n)*?    status )\\S+`, 'm'), '$1bogus'),
  );
  return root;
}

it('prints the view the Door returns as one --json value, from any seat of the plan', async () => {
  const root = delivery(),
    machine = await next(root);
  expect(Object.keys(machine)).toEqual(['version', 'ok', 'view']);
  const served = door(root);
  if (!served.ok) throw new Error(served.message);
  expect(JSON.stringify(machine)).toBe(JSON.stringify({ version: 1, ok: true, view: served.result }));
  expect(machine.view).toMatchObject({
    format: 'ia.delivery-view.v1',
    plan: PLAN,
    next: `ia position --seat ${task('guide')} --shape sequence`,
    summary: `2 of 5 tasks have exit evidence; next: ${task('guide')}, with no declared blocker`,
  });
  for (const seat of [PLAN, 'work-system/definition/milestone/build', task('schema')])
    expect(await next(root, ['--seat', seat]), seat).toEqual(machine);
});

it('lists each task in order with its verdict, status, basis and five state lines, then review and next', async () => {
  const root = delivery(),
    view = (await next(root)).view;
  const human = await run(['next', '--root', root]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stderr).toBe('');
  expect(human.stdout).toBe(renderNext(view, resolveCapabilities({ env: {}, isTTY: false }), ` ${rooted(root)}`));
  const text = flat(human.stdout);
  expect(text.startsWith(`Plan ${PLAN} revision ${view.revision.slice(0, 12)}…`)).toBe(true);
  expect(text).toContain(view.summary);
  expect(text).toContain(
    `Milestones ▲ work-system/definition/milestone/foundation not satisfied: exit evidence missing for 1 of 3 tasks status open (self-declared)`,
  );
  // Each milestone in the view's order, then the tasks under their own label.
  expect(view.milestones.map((m) => m.identity)).toEqual([
    'work-system/definition/milestone/foundation',
    'work-system/definition/milestone/build',
  ]);
  let at = text.indexOf('Milestones ');
  for (const milestone of view.milestones) {
    const line = `${milestone.identity} ${milestone.satisfied ? 'satisfied' : 'not satisfied'}: ${milestone.basis} ${milestone.status}`;
    const found = text.indexOf(flat(line), at);
    expect(found, line).toBeGreaterThan(at);
    at = found;
  }
  expect(text.indexOf('Tasks ', at)).toBeGreaterThan(at);
  at = text.indexOf('Tasks ', at);
  // Every task has its verdict line, which is a basis or an evidence line, then its own status, apart from it.
  expect(view.tasks.map((t) => [t.identity, t.verdict])).toEqual([
    [task('guide'), 'unblocked'],
    [task('schema'), 'evidenced'],
    [task('examples'), 'evidenced'],
    [task('package'), 'blocked'],
    [task('release-notes'), 'blocked'],
  ]);
  for (const delivered of view.tasks) {
    expect(delivered.line).toMatch(/^(?:exit evidence recorded \(|no declared blocker$|blocked \()/);
    expect(delivered.states.map((state) => state.dimension)).toEqual([
      'intent',
      'definition',
      'realizable',
      'realized',
      'worked',
    ]);
    for (const line of [
      delivered.identity,
      delivered.line,
      delivered.status,
      ...delivered.prerequisites.map((prerequisite) => `requires ${prerequisite.basis}`),
      ...delivered.states.map((state) => `${state.dimension} ${state.value}: ${state.basis}`),
    ]) {
      const found = text.indexOf(flat(line), at);
      expect(found, `${delivered.identity}: ${line}`).toBeGreaterThanOrEqual(at);
      at = found;
    }
  }
  expect(text).toContain('status closed (self-declared)');
  expect(text.indexOf('Review No review item.')).toBeGreaterThan(at);
  // The last line names the view's command for the first task with no declared blocker, with this invocation's root.
  expect(
    human.stdout
      .split('\n')
      .some((line) => line.includes(`"ia position --seat ${task('guide')} --shape sequence ${rooted(root)}"`)),
  ).toBe(true);
  // Without a next command, as when every task without exit evidence is blocked, nothing names one.
  const caps = resolveCapabilities({ env: {}, isTTY: false });
  expect(renderNext({ ...view, next: null }, caps)).toBe(renderNext(view, caps).replace(/\n\n→ [^]*$/, '\n'));
});

it('lists a @task admission refused as a review item with its owner, and writes nothing under .ia/', async () => {
  const root = delivery();
  writeFileSync(resolve(root, '.ia/src/migrate.ia'), REFUSED_TASK);
  // A capture first, so the snapshot pair the view reads exists; the view itself writes nothing, its reads included.
  expect((await run(['capture', '--root', root])).exitCode).toBe(1);
  const before = tree(resolve(root, '.ia'));
  const view = (await next(root)).view;
  expect(view.review).toEqual([
    {
      kind: 'admission',
      records: [task('migrate')],
      owner: 'agent-system/binding/agent/work-steward',
      message: `admission refused ${task('migrate')} at .ia/src/migrate.ia:3 (IA-COMP-FIELD-VALUE), so no plan can place it; ia validate reports why`,
    },
  ]);
  const human = await run(['next', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(flat(human.stdout)).toContain(
    `Review ▲ admission ${view.review[0]!.message} owner agent-system/binding/agent/work-steward`,
  );
  await next(root, ['--seat', task('schema')]);
  await next(root, ['--seat', task('migrate')], 1);
  expect(tree(resolve(root, '.ia'))).toBe(before);
  expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
});

it('refuses each delivery refusal at exit 1 with the runtime code and message, naming one command that runs', async () => {
  const base = delivery(),
    refused = delivery(),
    orphaned = delivery(),
    plans = delivery('plans'),
    cycle = delivery('cycle'),
    loop = workspace(),
    planRefused = refuse(delivery(), '@plan release'),
    milestoneRefused = refuse(delivery(), '@milestone foundation');
  writeFileSync(resolve(refused, '.ia/src/migrate.ia'), REFUSED_TASK);
  writeFileSync(
    resolve(orphaned, '.ia/src/orphan.ia'),
    '#! ia 1.0\n\n@milestone orphan\n  meaning\n    says "A milestone whose plan is not authored."\n  work\n    title "Orphan"\n    status open\n    plan @plan absent\n    exit "Never."\n',
  );
  const law = 'governance-system/governance/law/sample-rule',
    orphan = 'work-system/definition/milestone/orphan',
    foundation = 'work-system/definition/milestone/foundation';
  const rows: readonly {
    readonly root: string;
    readonly seat?: string;
    readonly code: string;
    readonly command: string;
    /** What the text says beside the command, which holds of the workspace it names. */
    readonly says?: string;
    /** The exit of the named command: a repair the user makes comes first where it is still refused. */
    readonly then: number;
  }[] = [
    // A record of another word names its inspection; ia position, which the runtime names, is not a verb yet.
    { root: base, seat: law, code: 'IA-RUNTIME-NEXT-SEAT', command: `ia inspect ${law} ${rooted(base)}`, then: 0 },
    // A seat no source holds names the nearest @plan, @milestone or @task, as ia inspect names the nearest identity;
    // with none near, the view without a seat by how many plans the workspace authors, as the view counts them.
    {
      root: base,
      seat: task('absent'),
      code: 'IA-RUNTIME-NEXT-SEAT',
      command: `ia next --seat ${task('schema')} ${rooted(base)}`,
      says: 'for the nearest admitted @plan, @milestone or @task',
      then: 0,
    },
    {
      root: base,
      seat: 'absent',
      code: 'IA-RUNTIME-NEXT-SEAT',
      command: `ia next ${rooted(base)}`,
      says: `to read ${PLAN}, the only plan the workspace authors`,
      then: 0,
    },
    {
      root: plans,
      seat: 'absent',
      code: 'IA-RUNTIME-NEXT-SEAT',
      command: `ia next --seat work-system/definition/plan/research ${rooted(plans)}`,
      says: 'the first of the 2 plans the workspace authors',
      then: 0,
    },
    {
      root: loop,
      seat: task('absent'),
      code: 'IA-RUNTIME-NEXT-SEAT',
      command: `ia next ${rooted(loop)}`,
      says: 'Author a @plan',
      then: 1,
    },
    {
      root: refused,
      seat: task('migrate'),
      code: 'IA-RUNTIME-NEXT-SEAT',
      command: `ia validate ${rooted(refused)}`,
      then: 1,
    },
    {
      root: loop,
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      command: `ia next ${rooted(loop)}`,
      says: 'Author a @plan',
      then: 1,
    },
    {
      root: orphaned,
      seat: orphan,
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      command: `ia next --seat ${orphan} ${rooted(orphaned)}`,
      then: 1,
    },
    // A plan a source holds and admission refused, or the milestone on a task seat's way to it, names the validation
    // that says why, never records to author.
    ...[undefined, foundation, task('guide')].map((seat) => ({
      root: planRefused,
      ...(seat === undefined ? {} : { seat }),
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      command: `ia validate ${rooted(planRefused)}`,
      says: `to see why admission refused ${PLAN}`,
      then: 1,
    })),
    {
      root: milestoneRefused,
      seat: task('guide'),
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      command: `ia validate ${rooted(milestoneRefused)}`,
      says: `to see why admission refused ${foundation}`,
      then: 1,
    },
    {
      root: plans,
      code: 'IA-RUNTIME-NEXT-AMBIGUOUS',
      command: `ia next --seat work-system/definition/plan/research ${rooted(plans)}`,
      then: 0,
    },
    { root: cycle, code: 'IA-RUNTIME-NEXT-CYCLE', command: `ia next ${rooted(cycle)}`, then: 1 },
  ];
  for (const row of rows) {
    const label = `${row.code} ${row.seat ?? ''}`,
      seat = row.seat === undefined ? [] : ['--seat', row.seat];
    const body = await next(row.root, seat, 1),
      expected = door(row.root, row.seat === undefined ? {} : { seat: row.seat });
    if (expected.ok) throw new Error(`${label}: the Door read a view`);
    expect(body, label).toMatchObject({ ok: false, code: row.code, message: expected.message, exit: 1 });
    expect(commandsIn(body.next), label).toEqual([row.command]);
    if (row.says !== undefined) expect(body.next, label).toContain(row.says);
    expect((await run(nextArgv(body.next))).exitCode, `${label}: ${body.next}`).toBe(row.then);
    // Human output names the same command on its `→` line.
    const human = await run(['next', ...seat, '--root', row.root]);
    expect(human.exitCode, label).toBe(1);
    expect(flat(human.stderr).split('→ ')[1], label).toBe(flat(body.next));
  }
  // A cycle is located at its first declared row, an unadmitted seat at the workspace.
  expect((await next(cycle, [], 1)).where).toMatchObject({
    path: '.ia/src/work.ia',
    identity: task('alpha'),
  });
  expect((await next(base, ['--seat', task('absent')], 1)).where).toEqual({
    path: realpathSync(base),
    line: null,
    identity: task('absent'),
  });
  // A usage error is refused before the workspace is read, naming the verb's help.
  const usage = await next(base, ['stray'], 2);
  expect(usage).toMatchObject({ code: 'IA-CLI-USAGE', exit: 2 });
  expect(commandsIn(usage.next)).toEqual(['ia next --help']);
  // That help, which the runtime's IA-RUNTIME-NEXT-NO-PLAN names to Door and MCP callers, says which records make a plan.
  const help = await run(['next', '--help']);
  expect(help.exitCode).toBe(0);
  expect(flat(help.stdout)).toContain(
    'the only @plan authored, with @milestone records that name it in work.plan and @task records that name those in work.milestone',
  );
});

it("reads the repository's own plans: without a seat several are refused, and the one the refusal names reads", async () => {
  const refused = await next(repository, [], 1);
  expect(refused.code).toBe('IA-RUNTIME-NEXT-AMBIGUOUS');
  const [command] = commandsIn(refused.next);
  expect(command).toMatch(
    new RegExp(
      `^ia next --seat work-system/definition/plan/[a-z-]+ ${rooted(repository).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    ),
  );
  const result = await run([...nextArgv(refused.next), '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  const { view } = JSON.parse(result.stdout) as Envelope;
  expect(view.tasks.length).toBeGreaterThan(0);
  for (const delivered of view.tasks) expect(delivered.line.length, delivered.identity).toBeGreaterThan(0);
});
