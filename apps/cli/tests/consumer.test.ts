import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { discoverRoot, dispatch, iaHomeOf } from '../src/consumer.js';
import type { Extension, Host, Result } from '../src/consumer.js';
import { COMMANDS, CORE_TOKENS, EXTENSION_TOKEN, LEGACY_OPERATIONS, RESERVED_TOKEN } from '../src/commands.js';
import { fieldTypeText } from '@inventarch/compliance';
import { MACHINE_PROTOCOL } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { scratch } from './workspace-fixture.js';

/** Links a file. Windows grants file links only with a privilege (Developer Mode or elevation): without it, EPERM, and false. */
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

const root = resolve(import.meta.dirname, '../../..');
const cli = resolve(root, 'apps/cli');
const fixture = resolve(root, 'packages/compliance/fixtures/loop');
const ANSI = /\u001b\[/;

interface HostOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly interactive?: boolean;
}
function makeHost(options: HostOptions = {}): Host {
  const env = options.env ?? {};
  const terminal = { env, isTTY: options.isTTY ?? false, columns: options.columns };
  return {
    cwd: options.cwd ?? root,
    env,
    stdout: terminal,
    stderr: terminal,
    // §2.8 rule 3's interaction. No case in this file answers a question; `distribution-verbs.test.ts` owns those.
    interaction: { interactive: options.interactive ?? false, write: () => {}, read: () => Promise.resolve(null) },
    version: '9.9.9',
    packageRoot: cli,
  };
}
const calls: { legacy: (readonly string[])[]; extension: (readonly string[])[] } = { legacy: [], extension: [] };
const legacy = (args: readonly string[]) => {
  calls.legacy.push(args);
  return { exitCode: 7, stdout: '{"legacy":true}\n' };
};
const extensions: readonly Extension[] = [
  {
    token: 'preview',
    summary: 'A private namespace',
    run: async (args: readonly string[]) => {
      calls.extension.push(args);
      return { exitCode: 5, stdout: 'extension\n' };
    },
  },
];
const run = (argv: readonly string[], options: HostOptions = {}): Promise<Result> =>
  dispatch(argv, makeHost(options), legacy, extensions);

it('routes the seven dispatch steps in order and never shadows a legacy operation', async () => {
  calls.legacy = [];
  calls.extension = [];
  // Step 1: no arguments is a request for help, not a syntax error, and it never reaches the legacy route.
  const bare = await run([]);
  expect(bare.exitCode).toBe(0);
  expect(calls.legacy).toEqual([]);
  const help = await run(['--help']);
  expect(bare.stdout).toBe(help.stdout);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('Usage: ia');
  for (const operation of LEGACY_OPERATIONS) expect(help.stdout).toContain(operation);
  // spec-0012 CLI-04: the one row that points at each operation's own help.
  expect(help.stdout).toContain('ia <operation> --help');
  for (const command of COMMANDS) expect(help.stdout).toContain(command.name);
  expect(help.stdout).toContain('ia preview --help');
  expect((await run(['-h'])).stdout).toBe(help.stdout);
  expect(await run(['--version'])).toEqual({ exitCode: 0, stdout: '9.9.9\n', stderr: '' });
  // Step 3: the private namespace claims its token before anything else looks at it.
  expect((await run(['preview', 'inspect', '--json'])).exitCode).toBe(5);
  expect(calls.extension.at(-1)).toEqual(['inspect', '--json']);
  // Step 4: every frozen operation reaches the legacy entry point with its whole argv, unchanged.
  for (const operation of LEGACY_OPERATIONS) {
    const result = await run([operation, '--root', fixture]);
    expect(result).toEqual({ exitCode: 7, stdout: '{"legacy":true}\n', stderr: '' });
    expect(calls.legacy.at(-1)).toEqual([operation, '--root', fixture]);
  }
  // Step 6 reserves the token, and step 7 suggests only a genuinely near command.
  const reserved = await run(['agent', 'scope']);
  expect(reserved.exitCode).toBe(2);
  expect(reserved.stderr).toContain('reserved');
  expect(reserved.stderr).toContain('IA-CLI-USAGE');
  const unknown = await run(['validte']);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr).toContain('Unknown command validte');
  expect(unknown.stderr).toContain('Did you mean "ia validate"?');
  expect((await run(['xyzzy'])).stderr).toContain('Run "ia --help"');
});

it('runs every class-2 check at parse time, before any workspace or network read', async () => {
  const empty = mkdtempSync(resolve(tmpdir(), 'ia-usage-'));
  try {
    // §2.1: unattended --apply with a host still needs --yes, and that usage refusal precedes every read and write.
    const bootstrap = await run(['init', '--apply', '--host', 'codex'], { cwd: empty });
    expect(bootstrap.exitCode).toBe(2);
    expect(bootstrap.stderr).toContain('IA-CLI-USAGE');
    expect(bootstrap.stdout).toBe('');
    expect(readdirSync(empty)).toEqual([]);
    // Class 2 precedes class 3: every usage check runs at parse time, before the target is looked at.
    expect((await run(['init', '--apply'], { cwd: empty })).exitCode).toBe(2);
    expect((await run(['update', 'a/b', '--registry', 'r', '--offline'], { cwd: empty })).exitCode).toBe(2);
    expect((await run(['pack'], { cwd: empty })).stderr).toContain('Option --descriptor is required');
    expect((await run(['init', '--root', '.'], { cwd: empty })).stderr).toContain('--root is not accepted');
    expect((await run(['compile', '--out', 'x', '--stdout'], { cwd: empty })).exitCode).toBe(2);
    const apply = await run(['install', 'a/b', '--apply', '--offline'], { cwd: empty });
    expect(apply.exitCode).toBe(2);
    expect(apply.stderr).toContain('--apply without a terminal requires --yes');
    // The confirmation is settled before the root is, so a missing workspace is still reported as usage.
    expect(existsSync(resolve(empty, '.ia'))).toBe(false);
    // With a terminal the same invocation may proceed, and then fails on the root it never reached before.
    const rooted = await run(['install', 'a/b', '--apply', '--offline'], { cwd: empty, interactive: true });
    expect(rooted.exitCode).toBe(3);
    expect(rooted.stderr).toContain('IA-DB-ROOT-INVALID');
  } finally {
    if (dirname(empty) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    rmSync(empty, { recursive: true, force: true });
  }
});

it('prints per-command help without opening a workspace and refusing on the rest of the grammar', async () => {
  for (const command of COMMANDS) {
    const help = await run([command.name, '--help', '--nonsense']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(`ia ${command.name}`);
    expect(help.stdout).toContain('Options');
    expect(help.stderr).toBe('');
  }
  expect((await run(['vocabulary', '-h'])).stdout).toContain('--search <text>');
  expect((await run(['inspect', '--help'])).stdout).toContain('--edges <in|out|both>');
});

it('looks words up from the shipped catalogue with no workspace anywhere above the cwd', async () => {
  const empty = mkdtempSync(resolve(tmpdir(), 'ia-vocabulary-'));
  try {
    const list = await run(['vocabulary'], { cwd: empty });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('Vocabulary');
    expect(list.stdout).toContain('@playbook');
    const one = await run(['vocabulary', '@check', '--schema'], { cwd: empty });
    expect(one.exitCode).toBe(0);
    expect(one.stdout).toContain('Word');
    expect(one.stdout).toContain('compliance-system/check/<facet>/<name>');
    expect(one.stdout).toContain('Fields');
    // A field's quoted schema description sits on its own lines under its row, at the value column, so no line of it
    // starts where field labels start; a field without one shows its type and obligation only.
    for (const flags of [[], ['--ascii']]) {
      const described = await run(['vocabulary', 'workspace', '--schema', ...flags], { cwd: empty });
      const lines = described.stdout.split('\n');
      const row = lines.findIndex((line) => /^ {2}composition\.sources +list of text {2}optional$/.test(line));
      expect(row, described.stdout).toBeGreaterThan(0);
      const valueColumn = lines[row]!.indexOf('list of text');
      const note = lines.slice(
        row + 1,
        lines.findIndex((line) => line.startsWith('  composition.steward')),
      );
      expect(note.length).toBeGreaterThan(0);
      expect(note[0]!.trim()).toMatch(/^A root and the placement/);
      for (const line of note) expect(line.length - line.trimStart().length).toBe(valueColumn);
      expect(described.stdout).toMatch(/\n {2}composition\.steward +ref to agent {2}optional\n/);
      if (flags.length > 0) expect(/[^\x00-\x7f]/.test(described.stdout)).toBe(false);
    }
    const filtered = await run(['vocabulary', '--domain', 'taxonomy', '--kind', 'definition'], { cwd: empty });
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain('@kind');
    const searched = await run(['vocabulary', '--search', 'steward'], { cwd: empty });
    expect(searched.exitCode).toBe(0);
    const none = await run(['vocabulary', '--search', 'no-such-substring'], { cwd: empty });
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain('--search no-such-substring');
    expect(none.stdout).toBe('');
    // §2.0's exception: this verb resolves no root, so it refuses --root rather than discarding it.
    const rooted = await run(['vocabulary', '--root', '.'], { cwd: empty });
    expect(rooted.exitCode).toBe(2);
    expect(rooted.stderr).toContain('--root is not accepted for this verb');
    const typo = await run(['vocabulary', 'playbok'], { cwd: empty });
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain('Unknown word @playbok');
    expect(typo.stderr).toContain('Did you mean "ia vocabulary playbook"?');
    // §2.2: the shipped catalogue carries no example field, and the command says so instead of composing one.
    const example = await run(['vocabulary', 'playbook', '--example'], { cwd: empty });
    expect(example.exitCode).toBe(1);
    expect(example.stderr).toBe('No example is shipped for @playbook.\n');
    expect(example.stdout).not.toContain('Example');
    const machine = JSON.parse((await run(['vocabulary', 'check', '--json'], { cwd: empty })).stdout);
    expect(machine.words).toHaveLength(1);
    expect(Object.keys(machine.words[0].schema)).toEqual(['name', 'path', 'closed']);
    expect(machine.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    const full = JSON.parse((await run(['vocabulary', 'check', '--schema', '--json'], { cwd: empty })).stdout);
    expect(full.words[0].schema.fields.length).toBeGreaterThan(0);
    expect(full.words[0].example).toBeUndefined();
  } finally {
    if (dirname(empty) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    rmSync(empty, { recursive: true, force: true });
  }
});

it('reports validation findings from the real fixture and keeps path filters out of the verdict', async () => {
  const human = await run(['validate', '--root', fixture]);
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toContain('Refused. 158 records, 1 errors, 5 warnings.');
  expect(human.stdout).toContain('IA-COMP-DISCRIMINATOR-FOREIGN');
  // §6.5: a finding with no location of its own names the check that produced it, never `:1`.
  expect(human.stdout).toContain('(whole workspace)  COMP-FIXTURES');
  expect(human.stdout).not.toContain(':1\n');
  // §6.5: the duplicated `path:line: identity: ` and `CODE: ` prefixes are stripped before printing.
  expect(human.stdout).not.toContain('IA-COMP-NOT-EVALUATED  COMP-FIXTURES:');

  const machine = JSON.parse((await run(['validate', '--root', fixture, '--json'])).stdout);
  expect(machine).toMatchObject({ version: 1, root: fixture, status: 'refused', reportOutcome: 'fail' });
  expect(machine.counts).toEqual({ errors: 1, warnings: 5, notEvaluated: 5 });
  expect(machine.truncated).toBe(false);

  const severity = await run(['validate', '--root', fixture, '--severity', 'error']);
  expect(severity.exitCode).toBe(1);
  expect(severity.stdout).toContain('5 warnings hidden by --severity error.');
  expect(severity.stdout).not.toContain('IA-COMP-NOT-EVALUATED');

  // §6.5's two grouping rules. Five warnings carry one code, so one action closes the run rather than five.
  expect(human.stdout.match(/→ {2}Supply the evaluator/g)).toHaveLength(1);
  // Three of them share a code, path, line and identity and differ only in the fragment named, so they collapse.
  expect(human.stdout).toContain('2 more on this record: #REQ-FOUNDATION-REFUSE, #REQ-FOUNDATION-VALID');
  expect(human.stdout.match(/No structural evaluator is supplied/g)).toHaveLength(1);
  // A run of one is still a run: the fixture's single error carries its own code-keyed action, printed once.
  expect(severity.stdout.match(/→ {2}Declare the owning system as a direct requirement/g)).toHaveLength(1);

  // A positional restricts reporting only: the counts and the exit class stay whole-workspace.
  const filtered = JSON.parse(
    (await run(['validate', '--root', fixture, '.ia/src/systems/agent-system', '--json'])).stdout,
  );
  expect(filtered.counts).toEqual({ errors: 1, warnings: 5, notEvaluated: 5 });
  expect(
    filtered.findings.every((finding: { path: string }) => finding.path.startsWith('.ia/src/systems/agent-system')),
  ).toBe(true);
  const absent = JSON.parse((await run(['validate', '--root', fixture, 'nowhere', '--json'])).stdout);
  expect(absent.findings).toEqual([]);
  expect(absent.counts.errors).toBe(1);
  const text = await run(['validate', '--root', fixture, 'nowhere']);
  expect(text.exitCode).toBe(1);
  expect(text.stdout).toContain('hidden by the path filter');

  const truncated = JSON.parse((await run(['validate', '--root', fixture, '--max-findings', '1', '--json'])).stdout);
  expect(truncated.findings).toHaveLength(1);
  expect(truncated.truncated).toBe(true);
  expect((await run(['validate', '--root', fixture, '--max-findings', '1'])).stdout).toContain('and 5 more');
});

it('refuses an unavailable root as a precondition rather than as a finding', async () => {
  const missing = await run(['validate', '--root', resolve(fixture, 'absent')]);
  expect(missing.exitCode).toBe(3);
  expect(missing.stderr).toContain('IA-DB-ROOT-INVALID');
  const empty = mkdtempSync(resolve(tmpdir(), 'ia-noroot-'));
  try {
    const discovery = await run(['validate'], { cwd: empty });
    expect(discovery.exitCode).toBe(3);
    expect(discovery.stderr).toContain('IA-DB-ROOT-INVALID');
    // §6.4 wraps at 80 columns with a hanging indent, so this phrase straddles the break for some lengths of
    // the interpolated path and not others — /tmp/ia-noroot-XXXXXX splits it where the Windows temp path does not.
    // The property here is what the message says; C14 puts layout in render.test.ts and §7, not in this file.
    expect(discovery.stderr.replace(/\s+/g, ' ')).toContain('or in any parent');
    const machine = JSON.parse((await run(['validate', '--json'], { cwd: empty })).stdout);
    expect(machine).toMatchObject({ version: 1, ok: false, code: 'IA-DB-ROOT-INVALID', exit: 3 });
    expect(machine.where.path).toBe(empty);
  } finally {
    if (dirname(empty) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    rmSync(empty, { recursive: true, force: true });
  }
});

it('never discovers the IA home as a workspace root', () => {
  const base = scratch('home-skip');
  mkdirSync(resolve(base, '.ia/src'), { recursive: true });
  mkdirSync(resolve(base, 'project'));
  expect(discoverRoot(resolve(base, 'project'))).toBe(base);
  expect(discoverRoot(resolve(base, 'project'), resolve(base, '.ia'))).toBeUndefined();
  // The home is recognized on disk, however IA_HOME spells it: APFS and NTFS open `.IA` as `.ia` (#315).
  expect(discoverRoot(resolve(base, 'project'), resolve(base, '.IA'))).toBe(
    existsSync(resolve(base, '.IA')) ? undefined : base,
  );
  // An IA_HOME that cannot be examined, here a link loop, is compared by spelling and never fails discovery (#323).
  if (process.platform !== 'win32') {
    const loop = resolve(base, 'loop');
    symlinkSync(loop, loop);
    expect(discoverRoot(resolve(base, 'project'), loop)).toBe(base);
  }
});

it('returns undefined from iaHomeOf when IA_HOME is relative, and the resolved path otherwise', () => {
  expect(iaHomeOf({ IA_HOME: 'relative/path' }, '/u')).toBeUndefined();
  expect(iaHomeOf({}, '/u')).toBe(join('/u', '.ia'));
});

it('inspects admitted structure only, and never through the private assessment namespace', async () => {
  const overview = await run(['inspect', '--root', fixture]);
  expect(overview.exitCode).toBe(0);
  expect(overview.stdout).toContain('Systems');
  expect(overview.stdout).toContain('Kinds');
  expect(overview.stdout).toContain('Installation');
  // Host state is observed (host registration spec §7): the fixture registers none, and nothing says "not reported".
  expect(overview.stdout).toMatch(/Host +No host registered/);
  expect(overview.stdout).not.toContain('Not reported');
  const identity = 'governance-system/definition/procedure/sample-procedure';
  const record = await run(['inspect', identity, '--root', fixture, '--edges', 'both']);
  expect(record.exitCode).toBe(0);
  expect(record.stdout).toContain(identity);
  expect(record.stdout).toContain('Edges');
  expect(record.stdout).not.toMatch(/score|assessment|recommend/i);

  const machine = JSON.parse((await run(['inspect', identity, '--root', fixture, '--json'])).stdout);
  expect(machine).toMatchObject({ version: 1, root: fixture });
  expect(machine.records).toHaveLength(1);
  expect(machine.records[0].identity).toBe(identity);
  expect(machine.records[0].digest).toMatch(/^[0-9a-f]{64}$/);
  // §2.6: this envelope is not the frozen `ia get` one, which wraps its record in {ok, result}.
  expect(machine.ok).toBeUndefined();
  expect(Array.isArray(machine.edges)).toBe(true);
  expect(
    JSON.parse((await run(['inspect', identity, '--root', fixture, '--depth', '0', '--json'])).stdout).edges,
  ).toEqual([]);

  const byPath = await run(['inspect', '--path', '.ia/src/systems/agent-system/steward.ia', '--root', fixture]);
  expect(byPath.exitCode).toBe(0);
  expect(byPath.stdout).toContain('Record');
  const absent = await run(['inspect', 'no-such/definition/procedure/record', '--root', fixture]);
  expect(absent.exitCode).toBe(1);
  expect(absent.stderr).toContain('IA-DB-SOURCE-UNAVAILABLE');
  const malformed = await run(['inspect', 'Not/An/Identity/X', '--root', fixture]);
  expect(malformed.exitCode).toBe(2);
  expect(malformed.stderr).toContain('Malformed identity');
  expect((await run(['inspect', 'a/b/c/d', '--path', 'x', '--root', fixture])).exitCode).toBe(2);
});

it('lists typed field references in the asked direction of inspect, apart from the edges', async () => {
  // agent-steward is named only by its system's head `steward` field: no edge reaches it, but inspect must not
  // present it as unreferenced (graph G06a).
  const identity = 'agent-system/binding/agent/agent-steward';
  const row = {
    from: 'floor/definition/system/agent-system',
    field: 'head.steward',
    to: identity,
    source: { path: '.ia/src/systems/agent-system/system.ia', line: 7 },
  };
  const inbound = JSON.parse((await run(['inspect', identity, '--root', fixture, '--edges', 'in', '--json'])).stdout);
  expect(inbound.referencedBy).toEqual([row]);
  expect(inbound.edges.some((edge: { from: string }) => edge.from === row.from)).toBe(false);
  expect(
    JSON.parse((await run(['inspect', identity, '--root', fixture, '--edges', 'both', '--json'])).stdout).referencedBy,
  ).toEqual([row]);
  expect(
    JSON.parse((await run(['inspect', identity, '--root', fixture, '--edges', 'in', '--depth', '0', '--json'])).stdout)
      .referencedBy,
  ).toEqual([]);
  // `--edges out` keeps the keys it always had, with no `referencedBy` rather than an empty claim, and adds the view.
  const outward = JSON.parse((await run(['inspect', identity, '--root', fixture, '--json'])).stdout);
  expect(Object.keys(outward)).toEqual(['version', 'root', 'revision', 'records', 'edges', 'directed']);
  expect(outward.directed).toEqual([]);
  // The same reference is a derived field-ref row of the directed view, read from the named record's side.
  expect(inbound.directed).toEqual([
    {
      identity,
      depth: 1,
      kind: 'field-ref',
      derived: true,
      direction: 'in',
      field: 'head.steward',
      counterpart: row.from,
      declaredOn: row.from,
      source: row.source,
    },
  ]);

  const human = await run(['inspect', identity, '--root', fixture, '--edges', 'in']);
  expect(human.stdout).toMatch(
    /Field references\n.*head\.steward\s+floor\/definition\/system\/agent-system *\n\s+in, derived,\s+\.ia\/src\/systems\/agent-system\/system\.ia:7/,
  );
  const out = (await run(['inspect', identity, '--root', fixture])).stdout;
  expect(out).not.toContain('head.steward');
  expect(out).toContain('This record names no record in a typed field.');
  const unnamed = await run([
    'inspect',
    'governance-system/definition/procedure/sample-procedure',
    '--root',
    fixture,
    '--edges',
    'in',
  ]);
  expect(unnamed.stdout).toContain('No record names this one in a typed field.');

  // The holder lists the same reference under the default `--edges out`, and only there.
  const holder = row.from;
  const held = {
    identity: holder,
    depth: 1,
    kind: 'field-ref',
    derived: true,
    direction: 'out',
    field: 'head.steward',
    counterpart: identity,
    declaredOn: holder,
    source: row.source,
  };
  const fieldRefs = (args: readonly string[]) =>
    run(['inspect', holder, '--root', fixture, ...args, '--json']).then((result) =>
      JSON.parse(result.stdout).directed.filter((listed: { kind: string }) => listed.kind === 'field-ref'),
    );
  expect(await fieldRefs([])).toEqual([held]);
  expect(await fieldRefs(['--edges', 'both'])).toContainEqual(held);
  expect(await fieldRefs(['--edges', 'in'])).toEqual([
    expect.objectContaining({ direction: 'in', field: 'composition.systems' }),
  ]);
  expect((await run(['inspect', holder, '--root', fixture])).stdout).toMatch(
    /Field references\n.*head\.steward\s+agent-system\/binding\/agent\/agent-steward *\n\s+out, derived,\s+\.ia\/src\/systems\/agent-system\/system\.ia:7/,
  );
  expect((await run(['inspect', holder, '--root', fixture, '--edges', 'in'])).stdout).not.toContain('head.steward');

  // At depth 0 nothing is read, so the section says so rather than denying the references the record holds.
  for (const direction of ['out', 'in', 'both']) {
    const shallow = (await run(['inspect', holder, '--root', fixture, '--edges', direction, '--depth', '0'])).stdout;
    expect(shallow).toMatch(/Field references\n\s+None at this depth and direction\./);
    for (const claim of [
      'This record names no record in a typed field.',
      'No record names this one in a typed field.',
      'No typed field names this record or is held by it.',
    ])
      expect(shallow).not.toContain(claim);
  }
});

it('labels declared edges, derived inverses and their declaring side from the directed view', async () => {
  const check = 'compliance-system/check/gate/instance-schema-check',
    contract = 'compliance-system/contract/signature/foundation-authoring-contract',
    law = 'governance-system/governance/law/sample-rule',
    procedure = 'governance-system/definition/procedure/sample-procedure';
  const both = await run(['inspect', check, '--root', fixture, '--edges', 'both']);
  expect(both.exitCode).toBe(0);
  const section = (name: string, next: string): string =>
    both.stdout.slice(both.stdout.indexOf(`\n${name}\n`), both.stdout.indexOf(`\n${next}\n`));
  // The check's own `enforces` line is declared; the law's `enforced-by` line reads here in the active spelling.
  const declared = section('Edges', 'Derived inverses');
  expect(declared).toMatch(
    /enforces\s+compliance-system\/contract\/signature\/foundation-authoring-contract\s+out,\s+depth\s+1,\s+declared\s+by\s+source/,
  );
  expect(declared).not.toContain('derived');
  const derived = section('Derived inverses', 'Field references');
  expect(derived).toMatch(
    /enforce\s+governance-system\/governance\/law\/sample-rule\s+out,\s+depth\s+1,\s+derived,\s+declared\s+by\s+target,\s+when\s+phase\s+is\s+act\s+and\s+severity\s+is\s+blocking/,
  );
  expect(derived).toMatch(
    /governed-by\s+compliance-system\/contract\/signature\/foundation-authoring-contract\s+in,\s+depth\s+1,\s+derived,\s+declared\s+by\s+source/,
  );
  expect(derived).toMatch(
    /used-by\s+governance-system\/definition\/procedure\/sample-procedure\s+in,\s+depth\s+1,\s+derived,\s+declared\s+by\s+source/,
  );
  expect(both.stdout).toContain('No typed field names this record or is held by it.');

  // Two assertions differing only by fragment stay apart, the fragment printed on the record it addresses: beside the
  // referenced counterpart of a declared row, and on the viewed record of a derived one.
  const scenario = 'compliance-system/definition/scenario/valid-native-record';
  const implemented = (await run(['inspect', contract, '--root', fixture, '--edges', 'in'])).stdout;
  const implementing = (await run(['inspect', scenario, '--root', fixture])).stdout;
  for (const requirement of ['REQ-FOUNDATION-INPUT', 'REQ-FOUNDATION-VALID']) {
    expect(implemented).toMatch(
      new RegExp(
        `implemented-by\\s+${scenario}\\s+in,\\s+depth\\s+1,\\s+derived,\\s+declared\\s+by\\s+source,\\s+at\\s+#${requirement}\\n`,
      ),
    );
    expect(implementing).toMatch(
      new RegExp(`implements\\s+${contract}#${requirement}\\s+out,\\s+depth\\s+1,\\s+declared\\s+by\\s+source\\n`),
    );
  }

  const machine = JSON.parse((await run(['inspect', check, '--root', fixture, '--edges', 'both', '--json'])).stdout);
  const brief = (row: Record<string, unknown>) => [
    row['kind'],
    row['direction'],
    row['spelling'],
    row['counterpart'],
    row['declaredOn'],
    row['declaredBy'],
    row['derived'],
  ];
  expect(machine.directed.map(brief)).toEqual([
    ['edge', 'out', 'enforces', contract, check, 'source', false],
    ['inverse', 'out', 'enforce', law, law, 'target', true],
    ['inverse', 'in', 'governed-by', contract, contract, 'source', true],
    ['inverse', 'in', 'used-by', procedure, procedure, 'source', true],
  ]);
  expect(machine.directed[1]).toMatchObject({
    predicate: 'enforce',
    condition: [
      { axis: 'phase', value: 'act' },
      { axis: 'severity', value: 'blocking' },
    ],
    source: { path: '.ia/src/systems/governance-system/records/sample-rule.ia', line: 13 },
  });
  // The traversal rows keep their shape: one per relationship, normalized to the active direction.
  expect(machine.edges).toContainEqual({ from: contract, predicate: 'govern', to: check, depth: 1 });
  for (const direction of ['out', 'in'])
    expect(
      JSON.parse((await run(['inspect', check, '--root', fixture, '--edges', direction, '--json'])).stdout).directed,
    ).toEqual(machine.directed.filter((row: { direction: string }) => row.direction === direction));

  // Deeper rows are read from the nearer record's view and name it.
  const deep = JSON.parse(
    (await run(['inspect', law, '--root', fixture, '--edges', 'both', '--depth', '2', '--json'])).stdout,
  );
  expect(
    deep.directed
      .filter((row: { depth: number }) => row.depth === 2)
      .map((row: Record<string, unknown>) => [row['identity'], ...brief(row)]),
  ).toEqual([
    [check, 'edge', 'out', 'enforces', contract, check, 'source', false],
    [check, 'inverse', 'in', 'governed-by', contract, contract, 'source', true],
  ]);
  expect((await run(['inspect', law, '--root', fixture, '--edges', 'both', '--depth', '2'])).stdout).toMatch(
    /governed-by\s+compliance-system\/contract\/signature\/foundation-authoring-contract\s+in,\s+depth\s+2\s+via\s+compliance-system\/check\/gate\/instance-schema-check,\s+derived,\s+declared\s+by\s+source/,
  );
});

it('keeps --json a single parseable value with no ANSI, and resolves colour by §6.7 precedence', async () => {
  const invocations: readonly (readonly string[])[] = [
    ['vocabulary', '--json'],
    ['vocabulary', 'check', '--schema', '--json'],
    ['validate', '--root', fixture, '--json'],
    ['inspect', '--root', fixture, '--json'],
    ['inspect', 'no-such/definition/procedure/record', '--root', fixture, '--json'],
    ['doctor', '--json'],
  ];
  for (const argv of invocations) {
    const result = await run(argv, { isTTY: true, columns: 120, env: { FORCE_COLOR: '1' } });
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.slice(0, -1)).not.toContain('\n');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe('');
  }
  const colored = await run(['validate', '--root', fixture, '--color']);
  expect(colored.stdout).toMatch(ANSI);
  expect((await run(['validate', '--root', fixture])).stdout).not.toMatch(ANSI);
  expect((await run(['validate', '--root', fixture, '--color'], { env: { NO_COLOR: '' } })).stdout).not.toMatch(ANSI);
  const ascii = await run(['validate', '--root', fixture, '--ascii']);
  expect(ascii.stdout).toContain('[error]');
  expect(ascii.stdout).not.toContain('✖');
  expect((await run(['validate', '--root', fixture], { env: { IA_ASCII: '1' } })).stdout).toContain('[error]');
});

const binary = (args: readonly string[], env?: NodeJS.ProcessEnv) =>
  runBounded(process.execPath, [resolve(cli, 'dist/main.js'), ...args], {
    cwd: root,
    timeoutMs: 20000,
    ...(env === undefined ? {} : { env }),
  });

it('preserves the frozen machine protocol and the consumer streams in the built binary', async () => {
  for (const operation of LEGACY_OPERATIONS) {
    const got = await binary([operation, '--root', fixture, '--params', '{}']);
    expect(got.stderr).toBe('');
    expect(got.stdout).not.toMatch(ANSI);
    expect(got.stdout.endsWith('\n')).toBe(true);
    expect(got.stdout.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(got.stdout)).toHaveProperty('ok');
    expect([0, 1, 2]).toContain(got.status);
  }
  const help = await binary(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('Usage: ia');
  expect(help.stderr).toBe('');
  const version = await binary(['--version']);
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  const machine = await binary(['validate', '--root', fixture, '--json']);
  expect(machine.status).toBe(1);
  expect(machine.stderr).toBe('');
  expect(JSON.parse(machine.stdout).status).toBe('refused');
  // A scratch IA home keeps doctor's host plugin distribution rows off the real ~/.ia.
  const report = await binary(['doctor'], { ...process.env, IA_HOME: resolve(scratch('consumer-doctor-home'), '.ia') });
  expect(report.status).toBe(0);
  expect(report.stderr).toBe('');
  expect(report.stdout).toContain('Environment');
  // Contract §2.1: piped with no --yes, the class-2 refusal precedes every read and write, which is why it is safe to
  // run with this repository as cwd; the built binary's stdin is not a terminal.
  const refusal = await binary(['init', '--apply', '--host', 'claude']);
  expect(refusal.status).toBe(2);
  expect(refusal.stdout).toBe('');
  expect(refusal.stderr).toContain('IA-CLI-USAGE');
  expect(refusal.stderr).toContain('--apply without a terminal requires --yes');
});

it('runs the built binary when a link reaches it, as npm .bin entries and global installs do', async () => {
  // Node loads an entry from its real path, so a check that compares the invoked path with import.meta.url never
  // matches through a link and the binary exits 0 having done nothing. A directory junction needs no privilege on
  // Windows; a file link does, so that case runs wherever it is granted.
  const version = (JSON.parse(readFileSync(resolve(cli, 'package.json'), 'utf8')) as { version: string }).version;
  const base = mkdtempSync(resolve(tmpdir(), 'ia entry link '));
  try {
    const linked = resolve(base, 'linked dist'),
      bin = resolve(base, 'ia');
    symlinkSync(resolve(cli, 'dist'), linked, 'junction');
    const entries = [resolve(linked, 'main.js')];
    if (fileLink(resolve(cli, 'dist/main.js'), bin)) entries.push(bin);
    for (const entry of entries) {
      const got = await runBounded(process.execPath, [entry, '--version'], { cwd: base, timeoutMs: 20000 });
      expect({ entry, status: got.status, stdout: got.stdout, stderr: got.stderr }).toEqual({
        entry,
        status: 0,
        stdout: `${version}\n`,
        stderr: '',
      });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it('§1.6: extension tokens are well-formed and never shadow a core token', async () => {
  // The shipped table: every token well-formed, none in L ∪ C ∪ R, no two alike.
  const { EXTENSIONS } = await import('../src/main.js');
  for (const extension of EXTENSIONS) {
    expect(extension.token).toMatch(EXTENSION_TOKEN);
    expect(CORE_TOKENS.has(extension.token)).toBe(false);
  }
  expect(new Set(EXTENSIONS.map((extension) => extension.token)).size).toBe(EXTENSIONS.length);
  for (const token of [
    ...LEGACY_OPERATIONS,
    ...COMMANDS.map((command) => command.name),
    RESERVED_TOKEN,
    '--help',
    '-h',
    '--version',
  ])
    expect(CORE_TOKENS.has(token), token).toBe(true);
  // At run time a core token falls through to its core route even when an extension claims it.
  const claimed: string[] = [];
  const shadows: readonly Extension[] = ['host', 'scope', 'agent'].map((token) => ({
    token,
    summary: 'shadow',
    run: async () => {
      claimed.push(token);
      return { exitCode: 42, stdout: '' };
    },
  }));
  const help = await dispatch(['host', '--help'], makeHost(), legacy, shadows);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('ia host');
  expect((await dispatch(['scope', '--root', fixture], makeHost(), legacy, shadows)).exitCode).toBe(7);
  expect((await dispatch(['agent'], makeHost(), legacy, shadows)).exitCode).toBe(2);
  expect(claimed).toEqual([]);
});

it('spells a catalogue field type through the language renderer the vocabulary view uses', () => {
  expect(fieldTypeText({ type: 'text' })).toBe('text');
  expect(fieldTypeText({ type: 'id', values: ['todo', 'done'] })).toBe('id in [todo, done]');
  expect(fieldTypeText({ type: 'list of ref', target: 'task' })).toBe('list of ref to task');
  expect(fieldTypeText({ type: 'text', form: 'iso-date' })).toBe('text form iso-date');
});

// spec-0012 DRF-03: the routing table and the protocol description name the same operations, in the same order. The
// routes are the version 1 rows; a row a later version appends (`since`) is a Door and MCP operation (plan amendment A2).
it('routes exactly the version 1 operations the machine protocol table describes', () => {
  expect(
    MACHINE_PROTOCOL.operations.filter((operation) => operation.since === undefined).map((operation) => operation.name),
  ).toEqual([...LEGACY_OPERATIONS]);
  for (const operation of MACHINE_PROTOCOL.operations.filter((row) => row.since !== undefined))
    expect(LEGACY_OPERATIONS as readonly string[], operation.name).not.toContain(operation.name);
});
