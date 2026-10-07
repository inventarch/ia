/**
 * `ia position`, the consumer command over a scope key, against a copy of the native conformance corpus.
 *
 * The body, its digest and the host note are the runtime's (`position`); this command only spells the key from its
 * options and tells the result as text or as one JSON value. So the tests hold it to the machine route on the same
 * workspace: the same key gives the same body and digest whichever way it is asked.
 */
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { MACHINE_PROTOCOL, SEED_CLASSES } from '@inventarch/runtime';
import type { HostNote, Position, PositionBody } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { findCommand, SINCE_2_OPERATIONS } from '../src/commands.js';
import { dispatch } from '../src/consumer.js';
import type { Result } from '../src/consumer.js';
import { runCli } from '../src/main.js';
import { cleanup, makeHost, repository, run, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const MAIN = resolve(repository, 'apps/cli/dist/main.js');
const NATIVE = resolve(repository, 'examples/conformance/native');
const WS = 'workspace-system/definition/workspace/foundation-workspace',
  LAW = 'governance-system/governance/law/sample-rule',
  SYSTEM = 'floor/definition/system/governance-system';
const ANSI = /\u001b\[/;

/** A copy of the native conformance corpus as a workspace's `.ia/src`. */
function native(): string {
  const root = resolve(scratch('position'), 'workspace');
  cpSync(NATIVE, resolve(root, '.ia/src'), { recursive: true });
  return root;
}
interface Delivered extends Position {
  readonly version: number;
}
async function json(argv: readonly string[]): Promise<Delivered> {
  const got = await run(['position', ...argv, '--json']);
  expect([got.exitCode, got.stderr], argv.join(' ')).toEqual([0, '']);
  expect(got.stdout.endsWith('\n') && !got.stdout.slice(0, -1).includes('\n'), argv.join(' ')).toBe(true);
  return JSON.parse(got.stdout) as Delivered;
}
/** The machine route's position for the same workspace and key parameters. */
function machine(root: string, params: Readonly<Record<string, unknown>>): Position {
  const got = runCli(['position', '--root', root, '--params', JSON.stringify(params)]);
  expect(got.exitCode).toBe(0);
  return (JSON.parse(got.stdout) as { result: Position }).result;
}
const words = (lines: readonly { readonly word: string }[]): readonly string[] => [
  ...new Set(lines.map((line) => line.word)),
];

it('lists only law entries wherever the word reaches, for the governance key at the act phase', async () => {
  const root = native();
  const asked = ['--shape', 'governance', '--phase', 'act', '--word', 'law', '--root', root];
  const { body } = await json(asked);
  expect(body.key).toMatchObject({ seat: null, shape: 'governance', phase: 'act', word: 'law' });
  // The word restricts what the seat composes and seeds, and every tally: those entries are law and nothing else.
  const seeded = (lines: PositionBody['loaded'] | PositionBody['pointers']) =>
    lines.filter((line) => line.via !== null && (SEED_CLASSES as readonly string[]).includes(line.via.by));
  expect(words(seeded(body.loaded))).toEqual(['law']);
  expect(seeded(body.loaded).map((line) => line.identity)).toEqual([LAW]);
  expect(words(seeded(body.pointers))).toEqual([]);
  expect(words(body.tallies)).toEqual([]);
  expect(words(body.captured)).toEqual(['law']);
  expect(words(body.appliesByWord.tallies)).toEqual([]);
  // A record a row reaches from a loaded one keeps its own word, one hop out: the filter is not applied to it.
  for (const line of [...body.loaded, ...body.pointers].filter((entry) => entry.via?.by === 'row'))
    expect(line.hop, line.identity).toBeGreaterThan(0);
  // The text lists the law it seeded, and says the word was declared.
  const text = await run(['position', ...asked]);
  expect([text.exitCode, text.stderr]).toEqual([0, '']);
  expect(text.stdout).toContain(LAW);
  expect(text.stdout).toContain('word law (declared)');
});

it('answers bare ia position with the body and digest the machine route gives for an empty key', async () => {
  const root = native();
  const consumer = await json(['--root', root]),
    route = machine(root, {});
  expect(consumer.version).toBe(1);
  expect(Object.keys(consumer)).toEqual(['version', 'body', 'digest', 'hostNote']);
  expect(consumer.body).toEqual(route.body);
  expect(consumer.digest).toBe(route.digest);
  // The host note differs only in the CLI that served it: this host is version 9.9.9.
  expect({ ...consumer.hostNote, cli: null }).toEqual({ ...route.hostNote, cli: null });
  expect(consumer.hostNote.cli).toBe('ia@9.9.9');
  expect(consumer.hostNote.key.k0).toBe(true);
  // The same holds for a key with every part declared.
  const key = { seat: SYSTEM, shape: 'context', phase: 'orient', depth: 2, budget: 8, word: 'law' };
  const full = await json([
    ...Object.entries(key).flatMap(([part, value]) => [`--${part}`, String(value)]),
    '--root',
    root,
  ]);
  const declared = machine(root, key);
  expect([full.body, full.digest]).toEqual([declared.body, declared.digest]);
});

it('maps each option to its scope key part and tells how each part was supplied', async () => {
  const root = native();
  const { hostNote } = await json(['--seat', SYSTEM, '--depth', '2', '--budget', '8', '--root', root]);
  expect(hostNote.key).toEqual({
    seat: SYSTEM,
    shape: 'context',
    phase: 'orient',
    primitive: 'Attention',
    depth: 2,
    budget: 8,
    word: null,
    k0: false,
    sources: {
      seat: 'declared',
      shape: 'default',
      phase: 'derived',
      primitive: 'derived',
      depth: 'declared',
      budget: 'declared',
      word: 'default',
    },
  });
  // K0 is a value: spelled out part by part it is the same body and digest, and only the key line tells the spelling.
  const bare = await json(['--root', root]),
    spelled = await json(['--shape', 'context', '--phase', 'orient', '--depth', '0', '--budget', '0', '--root', root]);
  expect([spelled.body, spelled.digest]).toEqual([bare.body, bare.digest]);
  expect(spelled.hostNote.key.k0).toBe(true);
  expect(spelled.hostNote.key.sources).toMatchObject({ shape: 'declared', phase: 'declared', depth: 'declared' });
  const text = (await run(['position', '--root', root])).stdout.replace(/\s+/g, ' ');
  expect(text).toContain(
    'K0: seat workspace (default), shape context (default), phase orient (derived), primitive Attention (derived), depth 0 (default), budget 0 (default), word none (default)',
  );
  const told = (
    await run(['position', '--shape', 'context', '--phase', 'orient', '--depth', '0', '--budget', '0', '--root', root])
  ).stdout.replace(/\s+/g, ' ');
  expect(told).toContain('K0: seat workspace (default), shape context (declared), phase orient (declared)');
});

it('tells the body, its digest and the host note as text, with the widening keys as next commands', async () => {
  const root = native();
  const delivered = await json(['--root', root]);
  const { body } = delivered;
  const got = await run(['position', '--root', root], { env: { FORCE_COLOR: '1' } });
  expect(got.exitCode).toBe(0);
  expect(got.stderr).toBe('');
  const plain = await run(['position', '--root', root]);
  expect(plain.stdout).not.toMatch(ANSI);
  const text = plain.stdout;
  // Every listed pointer is a line of its own; the rest are told by their tallies, so listed plus tallied is every
  // pointer the body counts and nothing is collapsed.
  const flat = text.replace(/\s+/g, ' ');
  for (const line of body.pointers) expect(flat).toContain(` ${line.identity} ${line.word} hop ${String(line.hop)}`);
  expect(body.pointers).toHaveLength(48);
  expect(body.pointers.length + body.tallies.reduce((sum, tally) => sum + tally.count, 0)).toBe(body.counts.pointers);
  expect(text).toContain(`Pointers  ${body.pointers.length} of ${body.counts.pointers}`);
  for (const system of body.systems) expect(flat).toContain(system.read);
  // The digest and the revision are bare digests, shown as their first twelve characters.
  expect(text).toContain(`Digest  ${delivered.digest.slice(0, 12)}…`);
  expect(text).toContain(`revision ${body.revision.slice(0, 12)}…`);
  // The widening keys are commands a reader can run: one hop deeper, and the same key re-seated at a line.
  expect(text).toContain('ia position --shape context --phase orient --depth 1 --budget 0');
  expect(text).toContain('ia position --seat <identity> --shape context --phase orient --depth 1 --budget 16');
  // The host note is told apart from the body, never merged into it.
  const note = text.slice(text.indexOf('Host note'));
  expect(note).toContain('Captured   absent');
  expect(note).toContain('CLI        ia@9.9.9');
  // The whole text is a golden over the corpus, with its revision, digests and installed state masked.
  const masked = text
    .replaceAll(body.revision.slice(0, 12), '<revision>')
    .replaceAll(delivered.digest.slice(0, 12), '<digest>')
    .replaceAll((delivered.hostNote.installedStateDigest ?? '<none>').slice(0, 12), '<installed>');
  expect(masked).not.toMatch(/[0-9a-f]{12}…/);
  await expect(masked).toMatchFileSnapshot('golden/position/k0.txt');
});

it('prints --json as one value, byte for byte the same on every run, with no colour', async () => {
  const root = native();
  const asked = ['position', '--shape', 'governance', '--root', root, '--json'];
  const first = await run(asked, { isTTY: true, env: { FORCE_COLOR: '1' } }),
    second = await run(asked);
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).not.toMatch(ANSI);
  const value = JSON.parse(first.stdout) as Delivered;
  expect(JSON.stringify(value) + '\n').toBe(first.stdout);
  const note: HostNote = value.hostNote;
  expect(note.format).toBe('ia-host-note-1');
  expect(note.revision).toBe(value.body.revision);
  // Capturing changes the host note, never the body or its digest.
  expect((await run(['capture', '--root', root])).exitCode).toBe(0);
  const captured = JSON.parse((await run(asked)).stdout) as Delivered;
  expect([captured.body, captured.digest]).toEqual([value.body, value.digest]);
  expect(captured.hostNote.captured.freshness).toBe('current');
  expect(note.captured.freshness).toBe('absent');
});

it("refuses an invalid key with the runtime's code and a next command, before the workspace is read", async () => {
  const root = native(),
    absent = resolve(scratch('position-absent'), 'absent');
  const help = '"ia position --help"';
  const refused: readonly (readonly [readonly string[], string, number, string])[] = [
    [['--depth', '3', '--root', absent], 'IA-RUNTIME-REQUEST-INVALID', 2, help],
    [['--depth', 'deep', '--root', absent], 'IA-RUNTIME-REQUEST-INVALID', 2, help],
    [['--budget', '65', '--root', absent], 'IA-RUNTIME-REQUEST-INVALID', 2, help],
    [['--shape', 'unlisted', '--root', absent], 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN', 2, help],
    [['--phase', 'unlisted', '--root', absent], 'IA-GRAPH-COORDINATE-VALUE-UNKNOWN', 2, help],
    [['--json', '--params', '{}', '--root', root], 'IA-CLI-USAGE', 2, help],
    [['--seat', '../outside', '--root', root], 'IA-DB-PATH-UNSAFE', 1, '"ia position" without --seat'],
    [['--root', absent], 'IA-DB-ROOT-INVALID', 3, '--root <path>'],
  ];
  for (const [argv, code, exit, next] of refused) {
    const label = argv.join(' ');
    const machineForm = await run(['position', ...argv, ...(argv.includes('--json') ? [] : ['--json'])]);
    expect(machineForm.exitCode, label).toBe(exit);
    expect(machineForm.stderr, label).toBe('');
    const value = JSON.parse(machineForm.stdout) as { ok: boolean; code: string; next: string };
    expect(value, label).toMatchObject({ version: 1, ok: false, code });
    expect(value.next, label).toContain(next);
    if (argv.includes('--json')) continue;
    const human = await run(['position', ...argv]);
    expect([human.exitCode, human.stdout], label).toEqual([exit, '']);
    expect(human.stderr, label).toContain(code);
    expect(human.stderr.replace(/\s+/g, ' '), label).toContain(next);
  }
});

it('keeps --params and --schema on the machine route and names that form in the consumer help', async () => {
  // Every operation version 2 added now has its consumer command.
  for (const operation of SINCE_2_OPERATIONS) expect(findCommand(operation), operation).toBeDefined();
  const routed: (readonly string[])[] = [];
  const legacy = (args: readonly string[]) => {
    routed.push(args);
    return { exitCode: 7, stdout: '{"legacy":true}\n' };
  };
  const ask = (argv: readonly string[]): Promise<Result> => dispatch(argv, makeHost(), legacy, []);
  for (const argv of [
    ['position', '--params', '{"shape":"context"}'],
    ['position', '--schema'],
    ['position', '--root', '.', '--params', '-'],
  ]) {
    expect(await ask(argv), argv.join(' ')).toEqual({ exitCode: 7, stdout: '{"legacy":true}\n', stderr: '' });
    expect(routed.at(-1)).toEqual(argv);
  }
  // Without them the name is the consumer command's, whose help also names the machine form and where its help is.
  const before = routed.length;
  for (const operation of SINCE_2_OPERATIONS) {
    const help = await ask([operation, '--help']);
    expect([help.exitCode, help.stderr], operation).toEqual([0, '']);
    const since = MACHINE_PROTOCOL.operations.find((row) => row.name === operation)!.since;
    expect(help.stdout, operation).toContain(`Machine operation (protocol v${String(since)})`);
    expect(help.stdout, operation).toContain(`ia ${operation} --params <JSON|-> [--root <workspace>]`);
    expect(help.stdout, operation).toContain(`ia ${operation} --schema`);
    expect(help.stdout, operation).toContain(`ia ${operation} --params '{}' --help`);
  }
  const position = (await ask(['position', '--help'])).stdout;
  expect(position).toContain(
    'ia position [--seat <id|path>] [--shape <shape>] [--phase <phase>] [--depth 0-2] [--budget 0-64] [--word <word>] [--json]',
  );
  for (const part of ['--seat', '--shape', '--phase', '--depth', '--budget', '--word'])
    expect(position).toContain(part);
  expect(routed).toHaveLength(before);
});

it('runs from the built binary, whose position help is the consumer command help', async () => {
  const root = native();
  const got = await runBounded(process.execPath, [MAIN, 'position', '--root', root, '--json'], {
    cwd: repository,
    timeoutMs: 30_000,
  });
  expect([got.status, got.stderr]).toEqual([0, '']);
  const value = JSON.parse(got.stdout) as Delivered;
  expect(value.body.loaded.map((line) => line.identity)).toEqual([WS]);
  expect(value.digest).toBe(machine(root, {}).digest);
  const help = await runBounded(process.execPath, [MAIN, 'position', '--help'], { cwd: repository, timeoutMs: 30_000 });
  expect([help.status, help.stderr]).toEqual([0, '']);
  expect(help.stdout).toContain('ia position [--seat <id|path>]');
}, 60_000);
