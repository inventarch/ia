/**
 * `ia position` (position-and-projection §1, §6 and §7, design item 10; decisions scope-key-caps and
 * scope-verb-dispatch), end to end against copies of the conformance corpus and of the runtime's delivery fixture laid
 * over it, whose workspace declares its sources.
 *
 * The exit evidence of plan task ia-position-verb: `ia position --shape governance --phase act --word law` loads the seat
 * plus only `@law` records and its tallies count only `@law`; `ia position --json` on the conformance corpus is the
 * Door's position byte for byte; `ia position` writes nothing; and `ia scope`, `ia scope --root <dir>` and
 * `ia scope --params '{}'` are the frozen route, which issues a token over the same revision.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { open } from '@inventarch/db';
import { Door, K0, RuntimeError } from '@inventarch/runtime';
import type { DoorResponse, PositionOutput } from '@inventarch/runtime';
import { parseArguments } from '../src/args.js';
import { findCommand } from '../src/commands.js';
import type { Refusal } from '../src/consumer.js';
import { positionRefusal, renderPosition } from '../src/position.js';
import { quote, resolveCapabilities, truncateDigest } from '../src/render.js';
import { cleanup, commandsIn, delivery, nextArgv, repository, run, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const LAW = 'governance-system/governance/law/sample-rule',
  LAW_PATH = '.ia/src/systems/governance-system/records/sample-rule.ia',
  RECORDS = '.ia/src/systems/governance-system/records',
  DELIVERY = 'workspace-system/definition/workspace/delivery',
  STEWARD = 'agent-system/binding/agent/governance-steward';
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const rooted = (root: string): string => `--root ${quote(root)}`;

interface Envelope {
  readonly version: number;
  readonly ok: boolean;
  readonly body: PositionOutput['body'];
  readonly digest: string;
  readonly hostNote: PositionOutput['hostNote'];
}
interface RefusalBody {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly exit: number;
  readonly where: {
    readonly path: string | null;
    readonly line: number | null;
    readonly identity: string | null;
  } | null;
  readonly next: string;
}
/** A copy of the conformance corpus as a workspace's own `.ia/src`. */
function conformance(): string {
  const root = resolve(scratch('position'), 'workspace');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  return root;
}
/** `ia position --json`: one value on stdout and nothing on stderr. */
async function positioned(root: string, flags: readonly string[] = [], exitCode = 0): Promise<Envelope & RefusalBody> {
  const result = await run(['position', ...flags, '--root', root, '--json']);
  expect(result.exitCode, result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.slice(0, -1)).not.toContain('\n');
  return JSON.parse(result.stdout) as Envelope & RefusalBody;
}
/** The runtime Door's `position` on `root`, with its own handle. */
function door(root: string, params: Record<string, unknown> = {}): DoorResponse {
  const gate = new Door(root, { cache: false });
  try {
    return gate.request({ operation: 'position', params });
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
/** A fixture @law or @convention of `severity`, with no header when `header` is false. */
const rule = (word: 'law' | 'convention', name: string, severity: string, header = true): string =>
  `${header ? '#! ia 1.0\n' : ''}@${word} ${name}\n  meaning\n    says "Fixture ${word} ${name}."\n    answers "What does ${name} require?"\n  governance\n    severity ${severity}\n`;
/**
 * The delivery fixture with seventy advisory laws and a blocking convention under its declared root, so a key with the
 * word law loads laws, lists laws past the budget and tallies laws past 48, while two rules block: the conformance
 * corpus's law and the convention, which is of another word.
 */
function governed(): string {
  const root = delivery();
  const laws = Array.from({ length: 70 }, (_, i) => rule('law', `many-${i}`, 'advisory', i === 0));
  writeFileSync(resolve(root, RECORDS, 'many-rules.ia'), laws.join('\n'));
  writeFileSync(resolve(root, RECORDS, 'block-convention.ia'), rule('convention', 'block-convention', 'blocking'));
  return root;
}

it("prints the Door's position as one --json value, for K0 and for each flag", async () => {
  const root = conformance(),
    absolute = resolve(realpathSync(root), LAW_PATH);
  const rows: readonly (readonly [readonly string[], Record<string, unknown>])[] = [
    [[], {}],
    [['--shape', 'governance', '--phase', 'act', '--word', 'law'], { shape: 'governance', phase: 'act', word: 'law' }],
    [['--seat', LAW, '--shape', 'governance'], { seat: LAW, shape: 'governance' }],
    [['--seat', LAW_PATH, '--depth', '0', '--budget', '0'], { seat: { path: LAW_PATH }, depth: 0, budget: 0 }],
    [['--seat', absolute], { seat: { path: absolute } }],
    [['--shape', 'sequence', '--depth', '2'], { shape: 'sequence', depth: 2 }],
    [['--seat', '.'], { seat: { path: '.' } }],
  ];
  for (const [flags, params] of rows) {
    const label = flags.join(' ') || '(K0)',
      machine = await positioned(root, flags),
      served = door(root, params);
    if (!served.ok) throw new Error(`${label}: ${served.message}`);
    expect(Object.keys(machine), label).toEqual(['version', 'ok', 'body', 'digest', 'hostNote']);
    expect(JSON.stringify(machine), label).toBe(JSON.stringify({ version: 1, ok: true, ...(served.result as object) }));
  }
  // No flag is K0, read over the live admitted revision whatever the capture (plan amendment A9).
  const k0 = await positioned(root);
  expect(k0.body.key).toEqual(K0);
  expect(k0.hostNote).toEqual({ revision: k0.body.revision, freshness: 'no-capture', key: K0 });
  // An absolute seat inside the root is the location it names: the body never carries the root, the note the spelling.
  const spelled = await positioned(root, ['--seat', absolute]);
  expect(spelled.body.key.seat).toEqual({ path: LAW_PATH });
  expect(spelled.hostNote.key.seat).toEqual({ path: absolute });
  expect(JSON.stringify(spelled.body)).not.toContain(JSON.stringify(realpathSync(root)).slice(1, -1));
});

it('loads the seat plus only @law records under --word law, tallies only @law and keeps every blocking rule', async () => {
  const root = governed(),
    flags = ['--shape', 'governance', '--phase', 'act', '--word', 'law'];
  const { body } = await positioned(root, flags);
  // The seat, then the budget's sixteen laws: the workspace's capture members of the word.
  expect(body.loaded[0]).toMatchObject({ identity: DELIVERY, word: 'workspace' });
  expect(body.loaded).toHaveLength(17);
  expect(body.loaded.slice(1).every((entry) => 'word' in entry && entry.word === 'law')).toBe(true);
  // The other 54 laws are pointers, 48 listed and 6 tallied, and every pointer and tally counts @law only.
  expect(body.pointers).toHaveLength(48);
  expect(body.pointers.every((pointer) => pointer.word === 'law')).toBe(true);
  expect(body.pointerTallies).toEqual([{ system: 'governance-system', word: 'law', steward: STEWARD, count: 6 }]);
  expect(body.frontier).toEqual([]);
  expect(body.counts).toMatchObject({ loaded: 17, pointers: 54, truncatedLoaded: 54, truncatedPointers: 6 });
  // The word restricts what loads and what is listed and tallied, never the blocking rules reserved outside the budget
  // (decision scope-key-caps): the convention blocks whatever the word, as it does without one.
  const { body: whole } = await positioned(root, ['--shape', 'governance', '--phase', 'act']);
  expect(body.rules.map((entry) => entry.identity)).toEqual([
    LAW,
    'governance-system/governance/convention/block-convention',
  ]);
  expect(body.rules).toEqual(whole.rules);
  // Human output prints the key used and the freshness, then the sections, and the tally of the laws past 48.
  const human = await run(['position', ...flags, '--root', root]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stderr).toBe('');
  const text = flat(human.stdout);
  expect(text).toContain(`Position ${DELIVERY}`);
  expect(text).toContain(
    "key seat the repository's workspace, shape governance, phase act, depth 1, budget 16, word law freshness no-capture",
  );
  expect(text).toContain(`Pointer tallies • governance-system: 6 more @law, steward ${STEWARD}`);
  let at = 0;
  for (const label of [
    'Loaded',
    'Pointers',
    'Pointer tallies',
    'Applies by word (field match, not a row)',
    'Cells',
    'Rules (reserved outside the budget)',
    'Mandates',
    'Frontier',
    'Unknowns',
  ]) {
    const found = human.stdout.indexOf(`\n${label}\n`, at);
    expect(found, label).toBeGreaterThan(at);
    at = found;
  }
  for (const entry of body.loaded.slice(1)) expect(text).toContain((entry as { identity: string }).identity);
});

it('names the two widening keys as ia position commands that run, with the root it was given', async () => {
  const root = conformance(),
    k0 = await positioned(root);
  const human = await run(['position', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toBe(
    renderPosition(
      { body: k0.body, digest: k0.digest, hostNote: k0.hostNote },
      resolveCapabilities({ env: {}, isTTY: false }),
      ` ${rooted(root)}`,
    ),
  );
  const steps = human.stdout
    .split('\n→')
    .slice(1)
    .map((step) => commandsIn(flat(step)));
  // One hop deeper, every part spelled, so K0's budget 0 stays 0; and the re-seat template at any pointer.
  expect(steps).toEqual([
    [`ia position --shape context --phase orient --depth 1 --budget 0 ${rooted(root)}`],
    [`ia position --seat <identity> --shape context --phase orient --depth 1 --budget 16 ${rooted(root)}`],
  ]);
  const deeper = await positioned(root, nextArgv(`"${steps[0]![0]!}"`).slice(1, -2));
  expect(deeper.body.key).toEqual(k0.body.widening.deeper);
  const pointer = k0.body.pointers[0]!.identity,
    reseated = await positioned(root, nextArgv(`"${steps[1]![0]!.replace('<identity>', pointer)}"`).slice(1, -2));
  expect(reseated.body.key).toEqual({ seat: pointer, ...k0.body.widening.reseat });
  // At depth 2 there is no deeper key, so only the re-seat is named.
  const deepest = await run(['position', '--depth', '2', '--root', root]);
  expect(deepest.stdout.split('\n→')).toHaveLength(2);
});

it('reads --seat as an identity when it spells one, else as a path, the absolute root as the workspace root', async () => {
  const root = conformance(),
    real = realpathSync(root);
  const located = async (seat: string) => (await positioned(root, ['--seat', seat])).body;
  expect((await located(LAW)).seat).toEqual({ kind: 'record', identity: LAW });
  // A path spelled as an identity is read as one; `./` makes it a location.
  expect((await located(`./${LAW}`)).seat).toMatchObject({ kind: 'location', path: LAW });
  // The root, however it is spelled, is the location '', and an in-root name that only begins with `..` is inside it.
  for (const spelling of [real, `${real}/`, './'])
    expect(await located(spelling), spelling).toEqual(await located('.'));
  expect(await located(resolve(real, '..cache/notes.md'))).toEqual(await located('..cache/notes.md'));
  expect((await located('..cache/notes.md')).seat).toMatchObject({ kind: 'location', path: '..cache/notes.md' });
});

it('writes nothing, needs no capture, and moves only the note when a capture is written', async () => {
  const root = governed(),
    before = tree(root);
  const flags = ['--shape', 'governance', '--word', 'law'],
    first = await positioned(root, flags);
  expect((await run(['position', '--root', root])).exitCode).toBe(0);
  expect(tree(root)).toBe(before);
  expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
  expect(first.hostNote.freshness).toBe('no-capture');
  // A capture written by ia capture moves the host note to current and leaves the body and its digest as they were.
  expect((await run(['capture', '--root', root])).exitCode).toBe(0);
  const captured = await positioned(root, flags);
  expect(captured.hostNote).toMatchObject({ freshness: 'current', capturedRevision: first.body.revision });
  expect(JSON.stringify(captured.body)).toBe(JSON.stringify(first.body));
  expect(captured.digest).toBe(first.digest);
  const freshness = async () => flat((await run(['position', ...flags, '--root', root])).stdout);
  expect(await freshness()).toContain('freshness current: the capture is at this revision digest');
  // An edit after the capture moves the body's revision, and the note names the captured one, truncated as digests are.
  writeFileSync(resolve(root, RECORDS, 'late-law.ia'), rule('law', 'late-law', 'advisory'));
  const stale = await positioned(root, flags);
  expect(stale.body.revision).not.toBe(first.body.revision);
  expect(stale.hostNote).toMatchObject({ freshness: 'stale', capturedRevision: first.body.revision });
  const ascii = resolveCapabilities({ env: {}, isTTY: false }).ascii;
  expect(await freshness()).toContain(
    `freshness stale: the capture is at revision ${truncateDigest(first.body.revision, ascii)} digest`,
  );
});

it('refuses a key or seat with the runtime code and message, naming one command that runs', async () => {
  const root = conformance(),
    absent = resolve(scratch('position-absent'), 'absent');
  const outside = resolve(realpathSync(root), '..', 'elsewhere.md');
  const rows: readonly {
    readonly flags: readonly string[];
    readonly params: Record<string, unknown>;
    readonly exit: number;
    readonly command: string;
    /** The placeholder the named command carries, and the value that fills it in. */
    readonly fill?: readonly [string, string];
    readonly identity?: string;
  }[] = [
    // The key's form, refused before the workspace is read: the same call with the closed set or the cap.
    {
      flags: ['--shape', 'bogus', '--word', 'law'],
      params: { shape: 'bogus', word: 'law' },
      exit: 2,
      command: `ia position --shape <context|governance|execution|sequence|learning> --word law ${rooted(root)}`,
      fill: ['<context|governance|execution|sequence|learning>', 'governance'],
    },
    {
      flags: ['--phase', 'later'],
      params: { phase: 'later' },
      exit: 2,
      command: `ia position --phase <orient|plan|act|learn> ${rooted(root)}`,
      fill: ['<orient|plan|act|learn>', 'act'],
    },
    {
      flags: ['--seat', LAW, '--depth', '3'],
      params: { seat: LAW, depth: 3 },
      exit: 2,
      command: `ia position --seat ${LAW} --depth 2 ${rooted(root)}`,
    },
    {
      flags: ['--depth', 'deep'],
      params: { depth: 'deep' },
      exit: 2,
      command: `ia position --depth 2 ${rooted(root)}`,
    },
    { flags: ['--budget', '65'], params: { budget: 65 }, exit: 2, command: `ia position --budget 64 ${rooted(root)}` },
    // What the workspace does not answer: the vocabulary for a word, K0 for a seat.
    { flags: ['--word', 'nope'], params: { word: 'nope' }, exit: 1, command: 'ia vocabulary' },
    {
      flags: ['--seat', 'governance-system/governance/law/absent'],
      params: { seat: 'governance-system/governance/law/absent' },
      exit: 1,
      command: `ia position ${rooted(root)}`,
      identity: 'governance-system/governance/law/absent',
    },
    {
      flags: ['--seat', '../outside.md'],
      params: { seat: { path: '../outside.md' } },
      exit: 1,
      command: `ia position ${rooted(root)}`,
    },
    {
      flags: ['--seat', outside],
      params: { seat: { path: outside } },
      exit: 1,
      command: `ia position ${rooted(root)}`,
    },
  ];
  for (const row of rows) {
    const label = row.flags.join(' '),
      body = await positioned(root, row.flags, row.exit),
      expected = door(root, row.params);
    if (expected.ok) throw new Error(`${label}: the Door read a position`);
    expect(body, label).toMatchObject({
      ok: false,
      code: 'IA-RUNTIME-REQUEST-INVALID',
      message: expected.message.replace('IA-RUNTIME-REQUEST-INVALID: ', ''),
      exit: row.exit,
    });
    expect(body.where, label).toEqual(
      row.exit === 2 ? null : { path: realpathSync(root), line: null, identity: row.identity ?? null },
    );
    expect(commandsIn(body.next), label).toEqual([row.command]);
    const argv = nextArgv(row.fill === undefined ? body.next : body.next.replace(row.fill[0], row.fill[1]));
    expect((await run(argv)).exitCode, `${label}: ${body.next}`).toBe(0);
    // Human output names the same command on its `→` line.
    const human = await run(['position', ...row.flags, '--root', root]);
    expect(human.exitCode, label).toBe(row.exit);
    expect(flat(human.stderr).split('→ ')[1], label).toBe(flat(body.next));
  }
  // The key's form is refused before the workspace is read, so even an absent root is not reached.
  expect(await positioned(absent, ['--depth', '3'], 2)).toMatchObject({ code: 'IA-RUNTIME-REQUEST-INVALID' });
  // A usage error names the verb's help.
  const usage = await positioned(root, ['stray'], 2);
  expect(usage).toMatchObject({ code: 'IA-CLI-USAGE' });
  expect(commandsIn(usage.next)).toEqual(['ia position --help']);
  // A seat at runtime placement, which the workspace this CLI opens never places, names K0, or the overview when it is
  // the seat K0 takes, as the runtime's error says (R15), with the root the invocation gave.
  const command = findCommand('position')!,
    context = { command, args: parseArguments(['--seat', LAW, '--root', 'a b'], command.grammar) };
  for (const [next, named] of [
    ['ia position', 'ia position --root "a b"'],
    ['ia inspect', 'ia inspect --root "a b"'],
  ] as const) {
    const refusal = positionRefusal(
      new RuntimeError('IA-RUNTIME-REQUEST-INVALID', `The seat '${LAW}' is at runtime placement (band 0)`, next),
      context,
      '/w',
    );
    expect(refusal).toMatchObject({
      code: 'IA-RUNTIME-REQUEST-INVALID',
      exit: 1,
      where: { path: '/w', identity: LAW },
    });
    expect(commandsIn((refusal as Refusal).next!)).toEqual([named]);
  }
});

it('keeps ia scope, ia scope --root and ia scope --params {} the frozen route over the same revision', async () => {
  const root = conformance(),
    main = resolve(repository, 'apps/cli/dist/main.js');
  const scope = async (args: readonly string[], cwd: string) => {
    const got = await runBounded(process.execPath, [main, 'scope', ...args], { cwd, timeoutMs: SUBPROCESS });
    expect(got.status, `${args.join(' ')}: ${got.stdout}${got.stderr}`).toBe(0);
    expect(got.stderr).toBe('');
    const response = JSON.parse(got.stdout) as { ok: boolean; result: Record<string, unknown> };
    expect(response.ok).toBe(true);
    expect(Object.keys(response.result)).toEqual(['token', 'root', 'revision']);
    return response.result;
  };
  const position = (await positioned(root)).hostNote.revision;
  const handle = open(root, { cache: false }),
    revision = handle.revision;
  handle.close();
  expect(position).toBe(revision);
  for (const [args, cwd] of [
    [[], root],
    [['--root', root], repository],
    [['--params', '{}'], root],
  ] as const)
    expect(await scope(args, cwd), args.join(' ') || '(bare)').toMatchObject({ root: '', revision });
});
