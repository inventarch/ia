/**
 * `ia next`, the consumer command over the delivery view, against a copy of the native conformance corpus that also
 * holds this repository's own work records (one plan, one milestone, one task).
 *
 * The view is the Door's `next` operation; this command only names the seat and tells the view as text or as one JSON
 * value. So the tests hold it to the machine route on the same workspace: the same seat gives the same view whichever
 * way it is asked, the snapshot the capture store keeps as current included, and asking writes nothing.
 */
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { MACHINE_PROTOCOL, NEXT_COMMANDS, STATE_LINES } from '@inventarch/runtime';
import type { DeliveryView } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { findCommand } from '../src/commands.js';
import { runCli } from '../src/main.js';
import { cleanup, repository, run, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const MAIN = resolve(repository, 'apps/cli/dist/main.js');
const NATIVE = resolve(repository, 'examples/conformance/native');
const WORK = '.ia/src/systems/work-system/records/work.ia';
const PLAN = 'work-system/definition/plan/example-plan',
  MILESTONE = 'work-system/definition/milestone/example-milestone',
  TASK = 'work-system/definition/task/example-task',
  LAW = 'governance-system/governance/law/sample-rule';
const ANSI = /\u001b\[/;

/** A copy of the native conformance corpus as a workspace's `.ia/src`, with this repository's work records or none. */
function native(work = true): string {
  const root = resolve(scratch('next'), 'workspace');
  cpSync(NATIVE, resolve(root, '.ia/src'), { recursive: true });
  if (work) {
    mkdirSync(resolve(root, WORK, '..'), { recursive: true });
    cpSync(resolve(repository, WORK), resolve(root, WORK));
  }
  return root;
}
/** Every path under `.ia`, with its size: a command that writes, renames or touches a file changes this listing. */
function listing(root: string): readonly string[] {
  const base = resolve(root, '.ia');
  return (readdirSync(base, { recursive: true }) as string[])
    .map((path) => `${path}:${String(statSync(resolve(base, path)).size)}`)
    .sort();
}
interface Delivered extends DeliveryView {
  readonly version: number;
}
async function json(argv: readonly string[]): Promise<Delivered> {
  const got = await run(['next', ...argv, '--json']);
  expect([got.exitCode, got.stderr], argv.join(' ')).toEqual([0, '']);
  expect(got.stdout.endsWith('\n') && !got.stdout.slice(0, -1).includes('\n'), argv.join(' ')).toBe(true);
  return JSON.parse(got.stdout) as Delivered;
}
/** The machine route's view for the same workspace and parameters. */
function machine(root: string, params: Readonly<Record<string, unknown>>): DeliveryView {
  const got = runCli(['next', '--root', root, '--params', JSON.stringify(params)]);
  expect(got.exitCode, got.stdout).toBe(0);
  return (JSON.parse(got.stdout) as { result: DeliveryView }).result;
}
const VERDICT = /^(no declared blocker|blocked \(.+\)|exit evidence recorded \(.+, evaluator .+\))$/;
const flat = (text: string): string => text.replace(/\s+/g, ' ');

it('lists each task of the work records with a basis or evidence line, and stores nothing under .ia', async () => {
  const root = native(),
    before = listing(root);
  const view = await json(['--root', root]);
  expect(view.version).toBe(1);
  // The consumer value is the operation's result under the consumer version: the machine route's view, key for key.
  const { version, ...rest } = view;
  expect(rest).toEqual(machine(root, {}));
  expect(Object.keys(view)).toEqual(['version', ...Object.keys(machine(root, {}))]);
  expect(view.seat).toEqual({ identity: PLAN, word: 'plan', declared: false });
  expect(view.entries.map((entry) => [entry.identity, entry.word])).toEqual([
    [PLAN, 'plan'],
    [MILESTONE, 'milestone'],
    [TASK, 'task'],
  ]);
  for (const entry of view.entries) {
    expect(entry.verdict.text, entry.identity).toMatch(VERDICT);
    expect(
      entry.lines.map((line) => line.line),
      entry.identity,
    ).toEqual([...STATE_LINES]);
    for (const line of entry.lines) expect(line.basis, `${entry.identity} ${line.line}`).not.toBe('');
  }
  // Every task is listed with a basis line: a requirement and its standing, or recorded exit evidence.
  for (const task of view.entries.filter((entry) => entry.word === 'task'))
    expect(task.basis.length > 0 || task.verdict.kind === 'evidence', task.identity).toBe(true);
  // Asking, as text or as data, on either route, writes nothing under .ia.
  await run(['next', '--root', root]);
  machine(root, {});
  expect(listing(root)).toEqual(before);
});

it('reads admitted against the snapshot the capture store keeps as current, on both routes alike', async () => {
  const root = native();
  const unseeded = await json(['--root', root]);
  expect(unseeded.snapshot).toBeNull();
  for (const entry of unseeded.entries)
    expect(entry.lines.find((line) => line.line === 'admitted')?.value, entry.identity).toBe('unknown');
  const captured = await run(['capture', '--root', root, '--json']);
  expect(captured.exitCode, captured.stdout).toBe(0);
  const revision = (JSON.parse(captured.stdout) as { revision: string }).revision;
  const seeded = await json(['--root', root]);
  expect(seeded.snapshot).toBe(revision);
  for (const entry of seeded.entries)
    expect(entry.lines.find((line) => line.line === 'admitted')?.value, entry.identity).toBe('admitted');
  const { version, ...rest } = seeded;
  expect(rest).toEqual(machine(root, {}));
  const text = flat((await run(['next', '--root', root])).stdout);
  expect(text).toContain(`Snapshot ${revision.slice(0, 12)}`);
});

it('narrows to a milestone or a task seat, and tells the view as text in plan order', async () => {
  const root = native();
  const milestone = await json(['--seat', MILESTONE, '--root', root]);
  expect(milestone.seat).toEqual({ identity: MILESTONE, word: 'milestone', declared: true });
  expect(milestone.entries.map((entry) => entry.identity)).toEqual([MILESTONE, TASK]);
  const { version, ...rest } = milestone;
  expect(rest).toEqual(machine(root, { seat: MILESTONE }));
  expect((await json(['--seat', TASK, '--root', root])).entries.map((entry) => entry.identity)).toEqual([TASK]);
  const view = await json(['--root', root]);
  const got = await run(['next', '--root', root]);
  expect([got.exitCode, got.stderr]).toEqual([0, '']);
  expect(got.stdout).not.toMatch(ANSI);
  const text = flat(got.stdout);
  expect(text).toContain(`Next ${PLAN}`);
  expect(text).toContain("Seat plan, the scope's only authored plan");
  // Each listed record in plan order, with its verdict, its five state lines and its requirements.
  const at = view.entries.map((entry) => text.indexOf(`${entry.identity} ${entry.word}`));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  for (const entry of view.entries) {
    expect(text, entry.identity).toContain(`Verdict ${entry.verdict.text}`);
    for (const line of entry.lines)
      expect(text, `${entry.identity} ${line.line}`).toContain(`${line.value} ${line.basis}`);
    for (const basis of entry.basis) expect(text, entry.identity).toContain(`Requires ${basis.target}`);
  }
  for (const label of ['Accepted', 'Admitted', 'Realizable', 'Realized', 'Worked']) expect(text).toContain(label);
  // The first task with no declared blocker is the next command, or the text says there is none.
  expect(text).toContain(view.next === null ? 'No task is clear of declared blockers.' : view.next);
  expect(text).toContain('Run "ia next --json" for the view as data.');
});

it('prints --json as one value, byte for byte the same on every run, with no colour', async () => {
  const root = native();
  const first = await run(['next', '--root', root, '--json', '--color']),
    second = await run(['next', '--root', root, '--json']);
  expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).not.toMatch(ANSI);
});

it('refuses with the code and the next command for the cause, at the exit class it belongs to', async () => {
  const root = native(),
    bare = native(false),
    absent = resolve(scratch('next-absent'), 'absent');
  const refused: readonly (readonly [readonly string[], string, number, string])[] = [
    // Decided by reading the workspace: the request was well formed, the workspace answers no.
    [['--root', bare], 'IA-RUNTIME-REQUEST-INVALID', 1, NEXT_COMMANDS.noPlan()],
    [['--seat', LAW, '--root', root], 'IA-RUNTIME-REQUEST-INVALID', 1, NEXT_COMMANDS.position(LAW)],
    [['--seat', 'work-system/definition/task/none', '--root', root], 'IA-RUNTIME-REQUEST-INVALID', 1, 'ia next'],
    // A root that cannot be opened.
    [['--root', absent], 'IA-DB-ROOT-INVALID', 3, '--root <path>'],
    // A usage failure of the grammar.
    [['--depth', '1', '--root', root], 'IA-CLI-USAGE', 2, 'ia next --help'],
  ];
  for (const [argv, code, exit, next] of refused) {
    const label = argv.join(' ');
    const value = await run(['next', ...argv, '--json']);
    expect([value.exitCode, value.stderr], label).toEqual([exit, '']);
    const refusal = JSON.parse(value.stdout) as { next: string };
    expect(refusal, label).toMatchObject({ version: 1, ok: false, code, exit });
    expect(refusal.next, label).toContain(next);
    const human = await run(['next', ...argv]);
    expect([human.exitCode, human.stdout], label).toEqual([exit, '']);
    expect(human.stderr, label).toContain(code);
    expect(flat(human.stderr), label).toContain(next);
  }
  // Two authored plans and no seat: seat the view at the first, as the machine route also says.
  const two = native();
  cpSync(
    resolve(repository, '.ia/src/systems/work-system/records'),
    resolve(two, '.ia/src/systems/work-system/records'),
    {
      recursive: true,
    },
  );
  const ambiguous = await run(['next', '--root', two, '--json']);
  expect(ambiguous.exitCode).toBe(1);
  const machineRefusal = JSON.parse(runCli(['next', '--root', two, '--params', '{}']).stdout) as { next: string };
  expect((JSON.parse(ambiguous.stdout) as { next: string }).next).toBe(machineRefusal.next);
  expect(machineRefusal.next).toMatch(/^ia next --seat work-system\/definition\/plan\//);
});

it('runs from the built binary, keeps --params and --schema on the machine route, and names that form in its help', async () => {
  expect(findCommand('next')).toBeDefined();
  const root = native();
  const bounded = (args: readonly string[]) =>
    runBounded(process.execPath, [MAIN, ...args], { cwd: repository, timeoutMs: 30_000 });
  const consumer = await bounded(['next', '--root', root, '--json']);
  expect([consumer.status, consumer.stderr]).toEqual([0, '']);
  const { version, ...view } = JSON.parse(consumer.stdout) as Delivered;
  const routed = await bounded(['next', '--root', root, '--params', '{}']);
  expect([routed.status, routed.stderr]).toEqual([0, '']);
  expect(JSON.parse(routed.stdout)).toEqual({ ok: true, result: view });
  const schema = await bounded(['next', '--schema']);
  expect(JSON.parse(schema.stdout)).toEqual({
    version: MACHINE_PROTOCOL.version,
    ...MACHINE_PROTOCOL.operations.find((operation) => operation.name === 'next'),
  });
  const help = await bounded(['next', '--help']);
  expect([help.status, help.stderr]).toEqual([0, '']);
  expect(help.stdout).toContain('ia next [--seat <plan|milestone|task>] [--json]');
  expect(help.stdout).toContain('Machine operation (protocol v2)');
  expect(help.stdout).toContain(`ia next --params '{}' --help`);
  const operationHelp = await bounded(['next', '--params', '{}', '--help']);
  expect(operationHelp.stdout).toContain('ia_next');
}, 90_000);
