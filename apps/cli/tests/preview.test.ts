/**
 * `ia preview`: the read-only half of record authoring, on an `ia init` workspace with the CLI composition fixture
 * laid over it and a small plan authored. Every form, refused ones included, leaves the whole workspace directory
 * byte for byte as it was, and every refusal's next command runs in the state that caused it.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { open, pathKey } from '@inventarch/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, cli, commandRoots, nextArgv, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
afterAll(cleanup);

const WORK = `#! ia 1.0

@plan p1
  meaning
    says "The demo plan."
  work
    title "Demo plan"
    status open

@milestone m1
  meaning
    says "The first milestone."
  work
    title "First"
    status open
    plan @plan p1
    exit "Done."

@milestone m2
  meaning
    says "The second milestone."
  work
    title "Second"
    status open
    plan @plan p1
    exit "Done again."
`;
const demo = 'workspace-system/definition/workspace/demo',
  participant = 'agent-system/binding/agent/demo',
  ops = 'agent-system/binding/agent/ops',
  mandate = (name: string) => `agent-system/policy/mandate/${name}`,
  EMPTY = createHash('sha256').update('').digest('hex');

let base = '';
beforeAll(async () => {
  base = resolve(scratch('preview-base'), 'demo');
  const init = await run(['init', base, '--apply', '--yes', '--host', 'none', '--json']);
  expect(init.exitCode, init.stdout).toBe(0);
  cpSync(resolve(cli, 'tests/fixtures/composition-workspace'), base, { recursive: true });
  writeFileSync(resolve(base, '.ia/src/work.ia'), WORK);
  const validated = await run(['validate', '--root', base, '--json']);
  expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'admitted', counts: { errors: 0 } });
});
/** A fresh copy of the base workspace, with `edit` applied to its sources. */
function workspace(edit: (root: string) => void = () => {}): string {
  const root = resolve(scratch('preview'), 'demo');
  cpSync(base, root, { recursive: true });
  edit(root);
  return root;
}
const rewrite = (root: string, path: string, change: (text: string) => string): void =>
  writeFileSync(resolve(root, path), change(readFileSync(resolve(root, path), 'utf8')));
/** Every directory and file under `root`, files with the sha256 of their bytes; links are listed, never followed. */
function tree(root: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) entries[path] = 'link';
      else if (entry.isDirectory()) {
        entries[`${path}/`] = 'directory';
        walk(path);
      } else
        entries[path] = createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
    }
  };
  walk('');
  return entries;
}
/** One preview, with the workspace directory checked unchanged by it whatever it returned. */
/** The IA homes every command here runs with, so a write to either is seen. */
const HOMES = { IA_HOST_HOME: scratch('preview-host-home'), IA_CONFIG_HOME: scratch('preview-config-home') };
const trees = (root: string) => ({
  root: tree(root),
  host: tree(HOMES.IA_HOST_HOME),
  config: tree(HOMES.IA_CONFIG_HOME),
});
async function preview(root: string, argv: readonly string[], json = true): Promise<Result> {
  const before = trees(root);
  const result = await run(['preview', ...argv, '--root', root, ...(json ? ['--json'] : [])], { env: HOMES });
  expect(trees(root), `ia preview ${argv.join(' ')} wrote`).toEqual(before);
  return result;
}
const body = (result: Result) => JSON.parse(result.stdout) as Record<string, unknown> & { readonly next?: string };
/**
 * A refusal: its code, and its next command run in the same state, which must run without a refusal of its own (a
 * preview whose candidate has findings is a verdict, at exit 1 with nothing on stderr) and write nothing.
 */
async function refused(root: string, argv: readonly string[], code: string): Promise<Record<string, unknown>> {
  const result = await preview(root, argv);
  expect(result.exitCode, result.stdout).not.toBe(0);
  const refusal = body(result);
  expect(refusal).toMatchObject({ ok: false, code });
  const next = nextArgv(refusal.next!);
  expect(next, refusal.next).toContain('--root');
  const before = tree(root);
  const followed = await run(next, { env: HOMES });
  expect(followed.stderr, refusal.next).toBe('');
  expect(followed.exitCode, `${refusal.next}\n${followed.stdout}`).toBeLessThanOrEqual(1);
  expect(tree(root)).toEqual(before);
  return refusal;
}

describe('the four forms', () => {
  it('previews a new record into the default file, clean with its fields, and prints the absent file digest', async () => {
    const root = workspace();
    const clean = await preview(root, [
      'task',
      't1',
      'meaning.says=The first task',
      'work.title=First',
      'task',
      'work.status=open',
      'milestone=@milestone',
      'm1',
    ]);
    expect(clean.exitCode, clean.stdout).toBe(0);
    expect(body(clean)).toMatchObject({
      mode: 'record',
      path: '.ia/src/task.ia',
      exists: false,
      digest: EMPTY,
      identity: 'work-system/definition/task/t1',
      admitted: true,
      before: null,
      after:
        '@task t1\n  meaning\n    says "The first task"\n  work\n    title "First task"\n    status open\n    milestone @milestone m1',
      clean: true,
      counts: { errors: 0, warnings: 0 },
      records: [{ identity: 'work-system/definition/task/t1', before: null, after: expect.any(String) }],
      profile: { actor: participant, by: 'steward', mandates: [mandate('demo-mandate')] },
    });
    expect(body(clean)['revision']).not.toBe(body(clean)['baseRevision']);
    // The literal plan form prints the candidate and its digest, with the schema's missing fields as findings.
    const bare = await preview(root, ['task', 't1', 'milestone=@milestone', 'm1'], false);
    expect(bare.exitCode).toBe(1);
    expect(bare.stdout).toContain('Preview  .ia/src/task.ia');
    expect(bare.stdout).toContain(EMPTY);
    expect(bare.stdout).toContain('    milestone @milestone m1');
    expect(bare.stdout).toContain("IA-COMP-FIELD-MISSING  @schema task requires 'meaning.says'");
    expect(bare.stdout).toContain('Preview writes nothing.');
  });
  it('previews into an existing owned file named by --at, keeping every other record of it', async () => {
    const root = workspace();
    const result = await preview(root, [
      'milestone',
      'm3',
      'meaning.says=Third',
      'work.title=Third',
      'work.status=proposed',
      'work.plan=@plan p1',
      'work.exit=Shipped',
      '--at',
      '.ia/src/work.ia',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const view = body(result);
    expect(view).toMatchObject({ path: '.ia/src/work.ia', exists: true, clean: true });
    expect(view['digest']).toBe(
      createHash('sha256')
        .update(readFileSync(resolve(root, '.ia/src/work.ia')))
        .digest('hex'),
    );
    const records = view['records'] as readonly { identity: string; before: string | null; after: string | null }[];
    expect(records.map((row) => row.identity)).toEqual([
      'work-system/definition/milestone/m1',
      'work-system/definition/milestone/m2',
      'work-system/definition/milestone/m3',
      'work-system/definition/plan/p1',
    ]);
    for (const row of records)
      if (row.identity.endsWith('/m3')) expect(row.before).toBeNull();
      else expect(row.after, row.identity).toBe(row.before);
  });
  it('previews --relate as exactly one changed record, its digest the only one that moves', async () => {
    const root = workspace();
    for (const argv of [
      ['--relate', '@milestone', 'm2', 'requires', '@milestone', 'm1'],
      ['--relate', '@milestone m2', 'requires', '@milestone m1'],
      ['--relate', 'work-system/definition/milestone/m2', 'requires', 'work-system/definition/milestone/m1'],
    ]) {
      const result = await preview(root, argv);
      expect(result.exitCode, result.stdout).toBe(0);
      const view = body(result);
      expect(view).toMatchObject({ mode: 'relate', identity: 'work-system/definition/milestone/m2', clean: true });
      expect(view['after']).toBe(
        `${view['before']}\n  relationships\n    requires ${argv.at(-1) === 'm1' ? '@milestone m1' : argv.at(-1)}`,
      );
      const records = view['records'] as readonly { identity: string; before: string; after: string }[];
      expect(records.filter((row) => row.before !== row.after).map((row) => row.identity)).toEqual([
        'work-system/definition/milestone/m2',
      ]);
      expect(records).toHaveLength(3);
    }
  });
  it('previews --set and += as exactly one changed record', async () => {
    const root = workspace();
    const set = await preview(root, ['--set', '@milestone', 'm1', 'work.owner=Tom', 'Crown']);
    expect(set.exitCode, set.stdout).toBe(0);
    expect(body(set)['after']).toBe(`${body(set)['before']}\n    owner "Tom Crown"`);
    expect(
      (body(set)['records'] as readonly { identity: string; before: string; after: string }[])
        .filter((row) => row.before !== row.after)
        .map((row) => row.identity),
    ).toEqual(['work-system/definition/milestone/m1']);
    const appended = await preview(root, ['--set', '@agent demo', 'applies+=task']);
    expect(appended.exitCode, appended.stdout).toBe(0);
    expect(body(appended)).toMatchObject({ path: '.ia/src/workspace.ia', identity: participant, clean: true });
    expect(body(appended)['after']).toContain('    applies [task]');
    expect(
      (body(appended)['records'] as readonly { identity: string; before: string; after: string }[])
        .filter((row) => row.before !== row.after)
        .map((row) => row.identity),
    ).toEqual([participant]);
  });
  it("prints a word's lowering, schema, default file and consent", async () => {
    const root = workspace();
    const human = await preview(root, ['task'], false);
    expect(human.exitCode).toBe(0);
    for (const text of [
      'Word  task',
      'work-system',
      'lowers to  definition',
      'must work.milestone',
      'ref to milestone',
      'work-system: require task, milestone, decision using task, milestone, any-adopter',
      'ia preview task <name> meaning.says=<text>',
    ])
      expect(human.stdout).toContain(text);
    const json = body(await preview(root, ['task']));
    expect(json).toMatchObject({
      mode: 'word',
      word: 'task',
      system: 'work-system',
      lowering: { kind: 'definition', category: 'process', primitive: 'Decision', move: 'Execution' },
      file: { path: '.ia/src/task.ia', exists: false, digest: EMPTY },
      profile: { actor: participant },
    });
    expect((json['schema'] as { fields: { path: string; type: string; must: boolean }[] }).fields).toContainEqual({
      path: 'work.status',
      type: 'id in [proposed, open, held, closed, dropped, superseded]',
      must: true,
    });
  });
});

describe('a repository root the workspace shares with another', () => {
  const second = 'workspace-system/definition/workspace/second';
  /** `demo` and `second` both list `.`, and the workspace's mandates only observe, scoped to both. */
  const shared = (): string =>
    workspace((root) => {
      rewrite(root, '.ia/src/workspace.ia', (text) =>
        text
          .replace('sources [".ia/src @authored"]', 'sources [". @authored"]')
          .replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', 'moves [Observation]')
          .replace('scope [@workspace demo]', 'scope [@workspace demo, @workspace second]'),
      );
      mkdirSync(resolve(root, '.ia/src/second'), { recursive: true });
      writeFileSync(
        resolve(root, '.ia/src/second/workspace.ia'),
        '#! ia 1.0\n\n@workspace second\n  meaning\n    says "A department."\n    answers "Which sources make up the department?"\n  composition\n    systems [@system work-system]\n    sources [". @authored"]\n',
      );
    });
  it('keeps the root governed: ia validate and ia capture --preview refuse', async () => {
    const root = shared();
    const db = open(root, { cache: false });
    try {
      expect(db.resolveSeat('')).toMatchObject({ by: 'shared', declarers: [demo, second] });
    } finally {
      db.close();
    }
    for (const argv of [
      ['validate', '--root', root, '--json'],
      ['capture', '--preview', '--root', root, '--json'],
    ]) {
      const result = await run(argv);
      expect(result.exitCode, argv[0]).toBe(1);
      expect(result.stdout + result.stderr, argv[0]).toContain('IA-RUNTIME-MANDATE-MOVE');
    }
  });
  it('owns its authored path as a declarer, and refuses what the mandate does not allow', async () => {
    const refusal = await refused(shared(), ['law', 'probe', '--at', '.ia/src/probe.ia'], 'IA-RUNTIME-MANDATE-MOVE');
    expect(refusal['message']).toContain('allows Observation');
  });
  it('composes a default position of each declarer', async () => {
    const root = shared();
    const composition = async (seat: readonly string[]) => {
      const json = await run(['position', ...seat, '--root', root, '--json']);
      expect(json.exitCode, json.stdout).toBe(0);
      return (JSON.parse(json.stdout) as { body: { counts: { composition: number } } }).body.counts.composition;
    };
    expect(await composition([])).toBe(2);
    expect(await composition(['--seat', '.'])).toBe(2);
  });
});

describe('a repository root two other workspaces share (#228)', () => {
  const EVERYTHING = 'Observation, Verification, Synthesis, Delegation, Execution';
  /** `aaa` and `zzz` list `.`; `demo` lists only `.ia/src`, so it is no declarer. Each mandate is scoped to its own declarer. */
  const apart = (grants: readonly [string, string]): string =>
    workspace((root) => {
      for (const [name, moves] of [
        ['aaa', grants[0]],
        ['zzz', grants[1]],
      ] as const) {
        mkdirSync(resolve(root, `.ia/src/${name}`), { recursive: true });
        writeFileSync(
          resolve(root, `.ia/src/${name}/workspace.ia`),
          `#! ia 1.0\n\n@workspace ${name}\n  meaning\n    says "A department."\n    answers "Which sources make up the department?"\n  composition\n    systems [@system work-system]\n    sources [". @authored"]\n\n@mandate ${name}-mandate\n  meaning\n    says "Fixture mandate."\n    answers "What may it do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n    moves [${moves}]\n    scope [@workspace ${name}]\n`,
        );
      }
    });
  it.each([
    ['the first declarer grants', [EVERYTHING, 'Observation']],
    ['the last declarer grants', ['Observation', EVERYTHING]],
  ] as const)('governs the root by no grant scoped to one declarer, when %s', async (_name, grants) => {
    const root = apart(grants),
      db = open(root, { cache: false });
    try {
      expect(db.resolveSeat('')).toMatchObject({ by: 'shared' });
    } finally {
      db.close();
    }
    // Neither mandate names both declarers: the root is ungoverned, and no declarer's mandate (the granting one
    // included) is listed as governing it.
    for (const argv of [
      ['validate', '--root', root, '--json'],
      ['capture', '--preview', '--root', root, '--json'],
    ]) {
      const result = await run(argv);
      expect(result.stdout + result.stderr, argv[0]).not.toContain('IA-RUNTIME-MANDATE');
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    }
    const position = await run(['position', '--shape', 'governance', '--root', root, '--json']);
    expect(position.exitCode, position.stdout).toBe(0);
    const listed = (JSON.parse(position.stdout) as { body: { mandates: { identity: string }[] } }).body.mandates.map(
      (entry) => entry.identity,
    );
    expect(listed).not.toContain(mandate('zzz-mandate'));
    expect(listed).not.toContain(mandate('aaa-mandate'));
  });
});

describe('a root the workspace shares with another', () => {
  // `alpha` sorts before `demo` and declares `.ia/src/shared` too: the root seats as shared (db D02b), so the
  // repository's workspace owns it as one of its declarers, not by sorting first.
  const alpha = 'workspace-system/definition/workspace/alpha';
  const shared = (): string =>
    workspace((root) => {
      rewrite(root, '.ia/src/workspace.ia', (text) =>
        text.replace('sources [".ia/src @authored"]', 'sources [".ia/src @authored", ".ia/src/shared @authored"]'),
      );
      mkdirSync(resolve(root, '.ia/src/alpha'), { recursive: true });
      writeFileSync(
        resolve(root, '.ia/src/alpha/workspace.ia'),
        '#! ia 1.0\n\n@workspace alpha\n  meaning\n    says "A department."\n    answers "Which sources make up the department?"\n  composition\n    systems [@system work-system]\n    sources [".ia/src/alpha @authored", ".ia/src/shared @authored"]\n',
      );
      mkdirSync(resolve(root, '.ia/src/shared'), { recursive: true });
      writeFileSync(
        resolve(root, '.ia/src/shared/work.ia'),
        '#! ia 1.0\n\n@mandate shared-mandate\n  meaning\n    says "The authority both declarers grant over the shared records."\n    answers "Who may change the shared records?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n    participant @agent demo\n    moves [Observation, Verification, Synthesis]\n    scope [@workspace alpha, @workspace demo]\n\n@milestone m5\n  meaning\n    says "A shared milestone."\n  work\n    title "Shared"\n    status open\n    plan @plan p1\n    exit "Done."\n',
      );
    });
  it('previews a new record and a --set under the shared root, governed by the mandate scoped to every declarer', async () => {
    const root = shared();
    const db = open(root, { cache: false });
    try {
      expect(db.resolveSeat('.ia/src/shared/work.ia')).toMatchObject({ by: 'shared', declarers: [alpha, demo] });
    } finally {
      db.close();
    }
    const created = await preview(root, [
      'task',
      't1',
      'meaning.says=A shared task',
      'work.title=Shared',
      'work.status=open',
      'milestone=@milestone m5',
      '--at',
      '.ia/src/shared/task.ia',
    ]);
    expect(created.exitCode, created.stdout).toBe(0);
    expect(body(created)).toMatchObject({
      path: '.ia/src/shared/task.ia',
      exists: false,
      clean: true,
      profile: { actor: participant, mandates: [mandate('shared-mandate')] },
    });
    const set = await preview(root, ['--set', '@milestone m5', 'work.owner=Tom']);
    expect(set.exitCode, set.stdout).toBe(0);
    expect(body(set)).toMatchObject({
      path: '.ia/src/shared/work.ia',
      identity: 'work-system/definition/milestone/m5',
      clean: true,
      profile: { mandates: [mandate('shared-mandate')] },
    });
    // ia position names both declarers, seats at neither, and lists the mandate scoped to every declarer.
    const seated = await run(['position', '--seat', '.ia/src/shared/work.ia', '--shape', 'governance', '--root', root]);
    expect(seated.exitCode, seated.stdout).toBe(0);
    expect(seated.stdout).toMatch(new RegExp(`shared by\\s+${alpha}\\s+${demo}`));
    expect(seated.stdout).toMatch(/one of the workspaces that\s+declare the shared root it lies under/);
    const json = await run([
      'position',
      '--seat',
      '.ia/src/shared/work.ia',
      '--shape',
      'governance',
      '--root',
      root,
      '--json',
    ]);
    const positioned = JSON.parse(json.stdout) as {
      body: { seat: unknown; mandates: readonly { identity: string }[] };
    };
    expect(positioned.body.seat).toEqual({
      kind: 'location',
      path: '.ia/src/shared/work.ia',
      declarers: [alpha, demo],
    });
    expect(positioned.body.mandates.map((entry) => entry.identity)).toEqual([mandate('shared-mandate')]);
    // A root only the other workspace declares stays unowned.
    const theirs = await refused(root, ['task', 't2', '--at', '.ia/src/alpha/task.ia'], 'IA-CLI-EDIT-UNOWNED');
    expect(theirs['message']).toContain(`${demo} declares in composition.sources`);
  });
});

describe('what counts against a candidate', () => {
  /** An error already in the workspace, at `path`: a milestone missing its required exit, which admission refuses. */
  const BROKEN =
    '\n@milestone m4\n  meaning\n    says "No exit."\n  work\n    title "Fourth"\n    status open\n    plan @plan p1\n';
  const broken = (path: string) =>
    workspace((at) =>
      writeFileSync(
        resolve(at, path),
        `${existsSync(resolve(at, path)) ? readFileSync(resolve(at, path), 'utf8') : '#! ia 1.0\n'}${BROKEN}`,
      ),
    );
  it('leaves an error already in another record of the target file, or in another file, out of the verdict', async () => {
    for (const path of ['.ia/src/work.ia', '.ia/src/broken.ia']) {
      const root = broken(path);
      const view = body(await preview(root, ['--set', '@milestone m1', 'work.owner=Tom']));
      expect(view, path).toMatchObject({ clean: true, counts: { errors: 0 } });
      // A new record's own findings count, and the error already there still does not.
      const added = body(await preview(root, ['task', 't9', 'milestone=@milestone', 'm1', '--at', path]));
      expect(added, path).toMatchObject({ clean: false });
      const findings = added['findings'] as { code: string; identity?: string }[];
      expect(findings.length, path).toBeGreaterThan(0);
      expect(new Set(findings.map((finding) => finding.identity)), path).toEqual(
        new Set(['work-system/definition/task/t9']),
      );
    }
  });
  it('matches an identity-less error the edit moves down the file against the base', async () => {
    // A graph finding with no identity (an unknown severity) below the edited record: the edit shifts its line.
    const root = workspace((at) =>
      rewrite(
        at,
        '.ia/src/work.ia',
        (text) =>
          `${text}\n@principle pr1\n  meaning\n    says "A principle."\n    answers "Which?"\n  governance\n    severity bogus\n`,
      ),
    );
    const db = open(root, { cache: false });
    expect(db.report.findings.some((finding) => finding.severity === 'error' && finding.identity === undefined)).toBe(
      true,
    );
    db.close();
    for (const argv of [
      ['--set', '@milestone m1', 'work.owner=Tom'],
      ['--relate', '@milestone m2', 'requires', '@milestone m1'],
    ])
      expect(body(await preview(root, argv)), argv.join(' ')).toMatchObject({ clean: true, counts: { errors: 0 } });
  });
});

describe('shared authored-root ownership', () => {
  const fields = [
    'meaning.says=Shared task',
    'work.title=Shared task',
    'work.status=open',
    'work.milestone=@milestone m1',
  ];
  function shared(other: string, ownPlacement = 'authored'): string {
    return workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace(
          'sources [".ia/src @authored"]',
          `sources [".ia/src/shared @${ownPlacement}", ".ia/src @authored"]`,
        ),
      );
      writeFileSync(
        resolve(at, '.ia/src/other.ia'),
        `#! ia 1.0\n\n@workspace ${other}\n  meaning\n    says "Another declarer."\n    answers "Who also declares the shared root?"\n  composition\n    systems [@system work-system, @system workspace-system]\n    sources [".ia/src/shared @authored", ".ia/src/shared/foreign @authored"]\n`,
      );
      mkdirSync(resolve(at, '.ia/src/shared'), { recursive: true });
      writeFileSync(
        resolve(at, '.ia/src/shared/existing.ia'),
        '#! ia 1.0\n\n@plan shared-plan\n  meaning\n    says "Shared plan."\n  work\n    title "Shared plan"\n    status open\n',
      );
      const db = open(at, { cache: false });
      try {
        expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
        expect(db.resolveSeat('').seat).toBe(demo);
        expect(db.roots().filter((entry) => entry.root === '.ia/src/shared')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ workspace: demo, placement: ownPlacement }),
            expect.objectContaining({
              workspace: `workspace-system/definition/workspace/${other}`,
              placement: 'authored',
            }),
          ]),
        );
      } finally {
        db.close();
      }
    });
  }
  it.each(['alpha', 'zeta'])(
    'accepts a co-declarer regardless of %s identity ordering for explicit, default and existing targets',
    async (other) => {
      const root = shared(other);
      for (const argv of [
        ['task', 'shared-task', ...fields, '--at', '.ia/src/shared/new.ia'],
        ['task', 'shared-task', ...fields],
        ['--set', '@plan shared-plan', 'work.title=Updated shared plan'],
      ]) {
        const result = await preview(root, argv);
        expect(result.exitCode, result.stdout).toBe(0);
        expect(body(result)).toMatchObject({ clean: true });
        expect(body(result)['path']).toMatch(/^\.ia\/src\/shared\//);
      }
    },
  );
  it.each(['alpha', 'zeta'])('does not borrow a differently cased root from %s', async (other) => {
    const root = shared(other);
    rewrite(root, '.ia/src/other.ia', (text) => text.replaceAll('.ia/src/shared', '.ia/src/Shared'));
    // Two renames establish the exact disk spelling on case-sensitive and case-insensitive volumes alike.
    renameSync(resolve(root, '.ia/src/shared'), resolve(root, '.ia/src/moving-shared'));
    renameSync(resolve(root, '.ia/src/moving-shared'), resolve(root, '.ia/src/Shared'));
    const db = open(root, { cache: false });
    try {
      expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      expect(db.resolveSeat('.ia/src/Shared/existing.ia').seat).toBe(`workspace-system/definition/workspace/${other}`);
    } finally {
      db.close();
    }
    for (const argv of [
      ['task', 'foreign-case-task', ...fields, '--at', '.ia/src/Shared/new.ia'],
      ['--set', '@plan shared-plan', 'work.title=Must stay foreign'],
    ]) {
      const result = await preview(root, argv);
      expect(body(result)).toMatchObject({ ok: false, code: 'IA-CLI-EDIT-UNOWNED' });
    }
  });
  it('refuses a more-specific foreign root even when the workspace owns both containing ancestors', async () => {
    const root = shared('alpha');
    const result = await preview(root, ['task', 'foreign-task', ...fields, '--at', '.ia/src/shared/foreign/new.ia']);
    expect(body(result)).toMatchObject({ ok: false, code: 'IA-CLI-EDIT-UNOWNED' });
  });
  it('does not borrow another declarer authored placement when its own identical root is adopted', async () => {
    const root = shared('alpha', 'adopted');
    const result = await preview(root, ['task', 'adopted-task', ...fields, '--at', '.ia/src/shared/new.ia']);
    expect(body(result)).toMatchObject({ ok: false, code: 'IA-CLI-EDIT-UNOWNED' });
  });
  it('does not apply a repository-only mandate restriction on a shared target (db D02b, runtime R21)', async () => {
    const root = shared('alpha');
    rewrite(root, '.ia/src/workspace.ia', (text) =>
      text.replace('    scope [@workspace demo]', '    scope [@workspace demo]\n    excluded-words [task]'),
    );
    // A mandate governs a shared root only when its scope names every declarer; this one names the repository alone.
    const result = await preview(root, ['task', 'restricted-task', ...fields, '--at', '.ia/src/shared/restricted.ia']);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(body(result)).not.toHaveProperty('code');
    expect(body(result)).toMatchObject({ path: '.ia/src/shared/restricted.ia', exists: false });
  });
  it('authors an authorized shared target using the preview digest and admits the result', async () => {
    const root = shared('alpha');
    const argv = ['task', 'shared-task', ...fields, '--at', '.ia/src/shared/new.ia'];
    const candidate = await preview(root, argv);
    expect(candidate.exitCode, candidate.stdout).toBe(0);
    const authored = await run(
      ['author', ...argv, '--digest', body(candidate)['digest'] as string, '--root', root, '--json'],
      { env: HOMES },
    );
    expect(authored.exitCode, authored.stdout).toBe(0);
    expect(readFileSync(resolve(root, '.ia/src/shared/new.ia'), 'utf8')).toContain('@task shared-task');
    const validated = await run(['validate', '--root', root, '--json']);
    expect(validated.exitCode, validated.stdout).toBe(0);
  });
});

describe('refusals', () => {
  it('refuses an unconsented relationship row, naming the system whose registration refuses it', async () => {
    const root = workspace();
    const refusal = await refused(
      root,
      ['--relate', '@milestone m1', 'requires', '@plan p1'],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    expect(refusal['message']).toBe(
      'The source system work-system, which registers @milestone, does not consent to require milestone -> plan: no row of its consent ledger admits it',
    );
    expect(refusal['next']).toContain('ia preview milestone');
    const target = await refused(
      root,
      ['--relate', '@agent reviewer', 'requires', '@milestone m1'],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    expect(target['message']).toContain('The target system work-system');
  });
  it('refuses a type mismatch, an unknown field and a value that would inject syntax', async () => {
    const root = workspace();
    for (const [argv, message] of [
      [['--set', '@milestone m1', 'work.status=alien'], 'work.status expects one of proposed'],
      [['--set', '@milestone m1', 'work.plan=@milestone m2'], 'work.plan expects a reference to @plan'],
      [['--set', '@milestone m1', 'work.status=open # hidden'], 'without a comment'],
      [['--set', '@milestone m1', 'work.status=open when phase act'], 'one unconditional value'],
      [['--set', '@milestone m1', 'work.title=x\n  relationships\n    requires @milestone m2'], 'single-line'],
      [['--set', '@milestone m1', 'work.foo=x'], '@milestone declares no field work.foo'],
      [['--set', '@milestone m1', 'title+=x'], 'not a list'],
      [['task', 't9', 'meaning.colour=blue'], '@task declares no field meaning.colour'],
      [['task', 't9', 'work.due=tomorrow'], 'ISO date'],
      [['task', 't9', 'work.title=a', 'work.title=b'], '@task field work.title is given twice'],
      [['task', 't9', 'says=first', 'meaning.says=second'], '@task field meaning.says is given twice'],
    ] as const) {
      const refusal = await refused(root, argv, 'IA-CLI-EDIT-INVALID');
      expect(refusal['message'], argv.join(' ')).toContain(message);
    }
  });
  it('refuses a record that is not owned, an unadmitted record and a path outside the authored root', async () => {
    const root = workspace();
    const installed = await refused(
      root,
      ['--set', 'agent-system/binding/agent/public-work-system-steward', 'meaning.says=Mine now'],
      'IA-CLI-EDIT-UNOWNED',
    );
    expect(installed['message']).toContain('adopted placement (band 90)');
    expect(installed['next']).toContain('ia position --seat floor/definition/system/agent-system');
    await refused(root, ['--relate', '@milestone m9', 'requires', '@milestone m1'], 'IA-CLI-EDIT-MISSING');
    await refused(root, ['--relate', '@milestone m1', 'requires', '@milestone m9'], 'IA-CLI-EDIT-MISSING');
    await refused(root, ['--set', 'work-system/definition/milestone/m9', 'work.owner=x'], 'IA-CLI-EDIT-MISSING');
    const outside = await refused(root, ['task', 't9', '--at', 'docs/task.ia'], 'IA-CLI-EDIT-UNOWNED');
    expect(outside['message']).toBe('docs/task.ia is no .ia file inside .ia/src');
    await refused(root, ['task', 't9', '--at', '.ia/src/floor/task.ia'], 'IA-CLI-EDIT-UNOWNED');
    await refused(root, ['task', 't9', '--at', '.ia/src/../task.ia'], 'IA-DB-PATH-UNSAFE');
    await refused(root, ['nosuchword', 't9'], 'IA-CLI-EDIT-INVALID');
  });
  it('refuses malformed forms as usage before reading the workspace', async () => {
    const root = workspace();
    for (const argv of [
      ['--relate', '@milestone m1', 'needs', '@milestone m2'],
      ['--relate', '@milestone m1', 'requires'],
      ['--relate', '@milestone m1', 'requires', '@milestone m2', 'extra'],
      ['--set', '@milestone m1', 'no assignment'],
      ['--set', '--relate', '@milestone m1', 'requires', '@milestone m2'],
      ['--relate', '@milestone m1', 'requires', '@milestone m2', '--at', '.ia/src/x.ia'],
      ['Task'],
      ['task', '9t'],
      ['task', 't1', 'loose'],
    ]) {
      const result = await preview(root, argv);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(body(result)).toMatchObject({ code: 'IA-CLI-USAGE' });
    }
  });
});

describe('path spelling', () => {
  const FIELDS = ['meaning.says=x', 'work.title=x', 'work.status=open', 'work.milestone=@milestone m1'];
  /** A directory `.ia/src/restricted/` and a mandate whose covers claims it, excluding @task there. */
  const fenced = () =>
    workspace((at) => {
      mkdirSync(resolve(at, '.ia/src/restricted'));
      writeFileSync(
        resolve(at, '.ia/src/fence.ia'),
        '#! ia 1.0\n\n@mandate fence\n  meaning\n    says "Fixture fence."\n    answers "What may happen under restricted?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n    participant @agent demo\n    covers [".ia/src/restricted/"]\n    excluded-words [task]\n',
      );
    });
  it('judges --at as the volume spells it, so another spelling of a fenced directory refuses', async () => {
    const root = fenced();
    // The fence governs the path as spelled on disk.
    await refused(root, ['task', 't9', ...FIELDS, '--at', '.ia/src/restricted/t9.ia'], 'IA-RUNTIME-MANDATE-WORD');
    const caseless = existsSync(resolve(root, '.IA/SRC')),
      short = existsSync(resolve(root, '.ia/src/RESTRI~1'));
    for (const [spelled, applies] of [
      ['.ia/src/Restricted/t9.ia', caseless],
      ['.ia/src/RESTRI~1/t9.ia', short],
    ] as const) {
      if (!applies) continue;
      const alias = body(await preview(root, ['task', 't9', ...FIELDS, '--at', spelled]));
      expect(alias, spelled).toMatchObject({ ok: false, code: 'IA-DB-PATH-UNSAFE' });
      expect(alias['message'], spelled).toBe(`${spelled} names .ia/src/restricted/t9.ia in another spelling`);
      // The next command names the path as the volume spells it, and the fence then refuses it as it should.
      const next = nextArgv(alias.next!);
      expect(next).toContain('.ia/src/restricted/t9.ia');
      expect(body(await run([...next, '--json']))).toMatchObject({ code: 'IA-RUNTIME-MANDATE-WORD' });
    }
  });
  it('matches covers as the edit guard does where pathKey folds case: a missing covered directory, a covers in another case, never a longer name', async ({
    skip,
  }) => {
    const FENCE = (name: string, covers: string) =>
      `\n@mandate ${name}\n  meaning\n    says "Fixture fence ${name}."\n    answers "What may happen under ${covers}?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n    participant @agent demo\n    covers ["${covers}"]\n    excluded-words [task]\n`;
    const root = workspace((at) => {
      mkdirSync(resolve(at, '.ia/src/restricted'));
      writeFileSync(
        resolve(at, '.ia/src/fence.ia'),
        `#! ia 1.0\n${FENCE('future-fence', '.ia/src/future/')}${FENCE('upper-fence', '.ia/src/Restricted/')}`,
      );
    });
    // db pathKey folds case on win32 and darwin whatever the volume, as the edit guard keys paths; elsewhere case counts.
    skip(pathKey('A') === 'A', 'pathKey keeps case on this platform, so each case is its own path');
    // `.ia/src/future/` does not exist yet, so `--at` keeps its typed `Future`, which the fence claims in any case. And
    // `.ia/src/Restricted/` claims the directory on disk spelled `restricted`.
    expect(existsSync(resolve(root, '.ia/src/future'))).toBe(false);
    for (const [at, fence] of [
      ['.ia/src/Future/t9.ia', 'future-fence'],
      ['.ia/src/restricted/t9.ia', 'upper-fence'],
    ] as const) {
      const refusal = await refused(root, ['task', 't9', ...FIELDS, '--at', at], 'IA-RUNTIME-MANDATE-WORD');
      expect(refusal['message'], at).toBe(`${mandate(fence)} excludes task`);
      expect(nextArgv(refusal['next'] as string), at).toEqual(
        commandRoots(['position', '--seat', mandate(fence), '--shape', 'governance', '--root', root]),
      );
      // `ia author` judges the same profile before it writes anything.
      const before = tree(root);
      const authored = await run(
        ['author', 'task', 't9', ...FIELDS, '--at', at, '--digest', EMPTY, '--root', root, '--json'],
        { env: HOMES },
      );
      expect(body(authored), at).toMatchObject({ ok: false, code: 'IA-RUNTIME-MANDATE-WORD' });
      expect(tree(root)).toEqual(before);
    }
    // A sibling directory whose name only begins with the covered one's is not claimed: it previews clean.
    const sibling = await preview(root, ['task', 't9', ...FIELDS, '--at', '.ia/src/futures/t9.ia']);
    expect(sibling.exitCode, sibling.stdout).toBe(0);
    expect(body(sibling)).toMatchObject({ clean: true, path: '.ia/src/futures/t9.ia' });
    expect((body(sibling)['profile'] as { mandates: string[] }).mandates).not.toContain(mandate('future-fence'));
  });
  it('names the source as the volume spells it, never the file to move aside, for another spelling of a source', async () => {
    const root = workspace();
    const variants = [
      ...(existsSync(resolve(root, '.IA/SRC')) ? ['.ia/src/Work.ia'] : []),
      ...(existsSync(resolve(root, '.ia/src/COMPOS~1.IA')) ? ['.ia/src/COMPOS~1.IA'] : []),
    ];
    for (const spelled of variants) {
      const expected = spelled.endsWith('Work.ia') ? '.ia/src/work.ia' : '.ia/src/composition.ia';
      const alias = await refused(root, ['milestone', 'm3', 'meaning.says=x', '--at', spelled], 'IA-DB-PATH-UNSAFE');
      expect(alias['message'], spelled).toBe(`${spelled} names ${expected} in another spelling`);
      expect(alias['next']).not.toContain('aside');
      expect(nextArgv(alias['next'] as string)).toContain(expected);
    }
  });
  it('names a position that runs when a repository with no @workspace refuses --at', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) => `#! ia 1.0\n${text.slice(text.indexOf('\n@agent demo'))}`),
    );
    // A path no fixture mandate covers (docs/ is covered by the composition fixture's docs-mandate, which grants only
    // Synthesis, so the profile would refuse a preview there first).
    const refusal = await refused(root, ['task', 't9', 'meaning.says=x', '--at', 'notes/t9.ia'], 'IA-CLI-EDIT-UNOWNED');
    expect(nextArgv(refusal['next'] as string)).toEqual(commandRoots(['position', '--root', root]));
  });
});

describe('the mandate profile', () => {
  const MANDATE = (name: string, authority: readonly string[]) =>
    `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
  const AGENT = (name: string) =>
    `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;
  const moves = (root: string, list: string) =>
    rewrite(root, '.ia/src/workspace.ia', (text) =>
      text.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', `moves [${list}]`),
    );
  it('refuses preview under a mandate without Verification, naming its governance position, while position runs', async () => {
    const root = workspace((at) => moves(at, 'Observation, Synthesis'));
    const refusal = await refused(root, ['task'], 'IA-RUNTIME-MANDATE-MOVE');
    expect(refusal['message']).toBe(
      `${mandate('demo-mandate')} allows Observation, Synthesis; validate needs Verification`,
    );
    expect(nextArgv(refusal['next'] as string)).toEqual(
      commandRoots(['position', '--seat', mandate('demo-mandate'), '--shape', 'governance', '--root', root]),
    );
    await refused(root, ['--set', '@milestone m1', 'work.owner=x'], 'IA-RUNTIME-MANDATE-MOVE');
    // An unadmitted record does not get past the move either, and `ia position` stays ungated.
    await refused(root, ['--set', '@milestone m9', 'work.owner=x'], 'IA-RUNTIME-MANDATE-MOVE');
    expect((await run(['position', '--root', root])).exitCode).toBe(0);
  });
  it('refuses an excluded word in every form that previews it, and no other', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    scope [@workspace demo]\n', '    scope [@workspace demo]\n    excluded-words [milestone]\n'),
      ),
    );
    const refusal = await refused(root, ['milestone'], 'IA-RUNTIME-MANDATE-WORD');
    expect(refusal['message']).toBe(`${mandate('demo-mandate')} excludes milestone`);
    await refused(root, ['milestone', 'm3', 'meaning.says=x'], 'IA-RUNTIME-MANDATE-WORD');
    await refused(root, ['--set', '@milestone m1', 'work.owner=x'], 'IA-RUNTIME-MANDATE-WORD');
    await refused(root, ['--relate', '@milestone m2', 'requires', '@milestone m1'], 'IA-RUNTIME-MANDATE-WORD');
    expect((await preview(root, ['task'])).exitCode).toBe(0);
  });
  it.each(['covers', 'participant'])('refuses a sole participant without an actor when located by %s', async (kind) => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text
          .replace('    steward @agent demo\n', '')
          .replace('    scope [@workspace demo]\n', kind === 'covers' ? '    covers [".ia/src/**"]\n' : ''),
      ),
    );
    const refusal = await refused(root, ['plan'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(refusal['message']).toContain('no acting @agent was established');
    expect(nextArgv(refusal['next'] as string)).toEqual(
      commandRoots(['position', '--seat', demo, '--shape', 'governance', '--root', root]),
    );
    // A path-only mandate does not make its participant an eligible workspace CLI actor.
    await refused(root, ['plan', '--actor', participant], 'IA-RUNTIME-MANDATE-ACTOR');
    // An owner's authored steward establishes the same participant; the read then succeeds without writing.
    rewrite(root, '.ia/src/workspace.ia', (text) =>
      text.replace(
        '    sources [".ia/src @authored"]\n',
        '    sources [".ia/src @authored"]\n    steward @agent demo\n',
      ),
    );
    const chosen = await preview(root, ['plan']);
    expect(chosen.exitCode, chosen.stdout).toBe(0);
    expect(body(chosen)).toMatchObject({ profile: { actor: participant, by: 'steward' } });
  });
  it('refuses an open actor choice, and --actor resolves it without lifting moves or excluded words', async () => {
    // Two participants and no steward: there is no default actor.
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification]', 'scope [@workspace demo]', 'excluded-words [task]'])}`,
      );
    });
    const ambiguous = await refused(root, ['task'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(ambiguous['message']).toContain('its authored mandates name 2 participants');
    // The next command is this one as the first participant whose mandates allow it: demo, since ops excludes task.
    expect(nextArgv(ambiguous['next'] as string)).toEqual(
      commandRoots(['preview', 'task', '--actor', participant, '--root', root]),
    );
    const milestone = await refused(root, ['milestone'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(milestone['next'] as string)).toEqual(
      commandRoots(['preview', 'milestone', '--actor', participant, '--root', root]),
    );
    const chosen = body(await preview(root, ['milestone', '--actor', ops]));
    expect(chosen).toMatchObject({
      mode: 'word',
      profile: { actor: ops, by: 'actor', mandates: [mandate('demo-mandate'), mandate('ops-mandate')] },
    });
    expect(body(await preview(root, ['milestone', '--actor', '@agent ops']))).toMatchObject({
      profile: { actor: ops },
    });
    expect(body(await preview(root, ['milestone', '--actor', 'demo']))).toMatchObject({
      profile: { actor: participant },
    });
    // Naming ops never lifts its own mandate's exclusion, and a move its mandate lacks stays refused.
    expect((await refused(root, ['task', '--actor', ops], 'IA-RUNTIME-MANDATE-WORD'))['message']).toBe(
      `${mandate('ops-mandate')} excludes task`,
    );
    rewrite(root, '.ia/src/ops.ia', (text) => text.replace('moves [Observation, Verification]', 'moves [Observation]'));
    await refused(root, ['milestone', '--actor', ops], 'IA-RUNTIME-MANDATE-MOVE');
  });
  it('refuses an --actor that is not an authored participant of the workspace', async () => {
    const root = workspace();
    for (const actor of [
      '@agent reviewer',
      'agent-system/binding/agent/public-work-system-steward',
      'nobody',
      mandate('demo-mandate'),
    ]) {
      const refusal = await refused(root, ['task', '--actor', actor], 'IA-RUNTIME-MANDATE-ACTOR');
      expect(refusal['message'], actor).toContain(
        `is not an authored participant of ${demo}; its participants are ${participant}`,
      );
      // The workspace's default actor (its steward) may run it, so the next command drops --actor.
      expect(nextArgv(refusal['next'] as string)).toEqual(commandRoots(['preview', 'task', '--root', root]));
    }
  });
  it('keeps a generated profile agent separate from CLI actor selection', async () => {
    const root = workspace();
    await refused(root, ['plan', '--actor', '@agent reviewer'], 'IA-RUNTIME-MANDATE-ACTOR');
    const selected = await preview(root, ['plan']);
    expect(selected.exitCode, selected.stdout).toBe(0);
    expect(body(selected)).toMatchObject({ profile: { actor: participant, by: 'steward' } });
  });
  it('refuses, rather than fails, under a mandate whose authority the resolver cannot read', async () => {
    // A child under `authority.moves`: admission admits the record, the runtime's mandate reader refuses the field.
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/unreadable.ia'),
        `#! ia 1.0\n${MANDATE('unreadable-mandate', ['participant @agent demo', 'moves [Observation]', '  note x', 'scope [@workspace demo]'])}`,
      ),
    );
    const db = open(root, { cache: false });
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    db.close();
    const refusal = await refused(root, ['task'], 'IA-RUNTIME-REQUEST-INVALID');
    expect(refusal['message']).toBe(
      `The mandate profile cannot be read: ${mandate('unreadable-mandate')}: authority.moves must be an unconditional inline value`,
    );
    expect(refusal['where']).toEqual({
      path: '.ia/src/unreadable.ia',
      line: 3,
      identity: mandate('unreadable-mandate'),
    });
    expect(nextArgv(refusal['next'] as string)).toEqual(
      commandRoots(['position', '--seat', mandate('unreadable-mandate'), '--shape', 'governance', '--root', root]),
    );
  });
  it('refuses at a mandate admission refused, a stated empty move list among them, naming the admission report', async () => {
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/empty.ia'),
        `#! ia 1.0\n${MANDATE('empty-mandate', ['participant @agent demo', 'moves []', 'scope [@workspace demo]'])}`,
      ),
    );
    // Admission refuses `moves []` (compliance C05), so the mandate governs nothing it states: every preview fails closed.
    const db = open(root, { cache: false });
    expect(db.report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code)).toEqual(
      ['IA-COMP-FIELD-VALUE'],
    );
    db.close();
    for (const form of [['task'], ['milestone', 'm3', 'meaning.says=x'], ['--set', '@milestone m1', 'work.owner=x']]) {
      const refusal = await refused(root, form, 'IA-RUNTIME-REQUEST-INVALID');
      expect(refusal['where'], form.join(' ')).toEqual({
        path: '.ia/src/empty.ia',
        line: 3,
        identity: mandate('empty-mandate'),
      });
      expect(refusal['message'], form.join(' ')).toContain(
        `${mandate('empty-mandate')} (.ia/src/empty.ia:3) failed admission: IA-COMP-FIELD-VALUE`,
      );
      expect(nextArgv(refusal['next'] as string), form.join(' ')).toEqual(commandRoots(['report', '--root', root]));
    }
    // From a clean workspace, a candidate that would leave a refused mandate is a verdict, not clean, as it was.
    const clean = workspace();
    const candidate = await preview(clean, ['--set', '@mandate reviewer-docs', 'authority.moves=[]']);
    expect(candidate.exitCode, candidate.stdout).toBe(1);
    expect(body(candidate)).toMatchObject({ identity: mandate('reviewer-docs'), admitted: false, clean: false });
    expect(body(candidate)['findings']).toContainEqual(
      expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', identity: mandate('reviewer-docs') }),
    );
  });
  it('restricts nothing where no mandate governs, and says so', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) => text.slice(0, text.indexOf('\n@mandate demo-mandate')) + '\n'),
    );
    const view = body(await preview(root, ['task']));
    expect(view['profile']).toEqual({
      actor: participant,
      by: 'steward',
      mandates: [],
      notice: 'no authored @mandate governs here, so no move or word is restricted (a mandate only adds restrictions)',
    });
  });
});

describe('the catalog row', () => {
  it('lets ia next, on a workspace that registers @plan and authors none, name ia preview plan', async () => {
    const root = workspace((at) => rmSync(resolve(at, '.ia/src/work.ia')));
    const refusal = await run(['next', '--root', root, '--json']);
    expect(refusal.exitCode).toBe(1);
    const next = body(refusal);
    expect(next).toMatchObject({ code: 'IA-RUNTIME-NEXT-NO-PLAN' });
    expect(nextArgv(next.next!)).toEqual(commandRoots(['preview', 'plan', '--root', root]));
    const before = tree(root);
    const followed = await run(nextArgv(next.next!));
    expect(followed.exitCode).toBe(0);
    expect(followed.stdout).toContain('Word  plan');
    expect(tree(root)).toEqual(before);
  });
});

describe('next commands', () => {
  const MANDATE = (name: string, authority: readonly string[]) =>
    `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
  const AGENT = (name: string) =>
    `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;
  /** Two participants and no steward: there is no default actor. */
  const ambiguous = (opsMoves = 'Observation, Verification') =>
    workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', `moves [${opsMoves}]`, 'scope [@workspace demo]'])}`,
      );
    });
  /** Every argument of the command a next action names, the --root value aside, is free of shell syntax. */
  const inert = (next: string): boolean => {
    const argv = nextArgv(next);
    return argv.every((arg, index) => argv[index - 1] === '--root' || /^[A-Za-z0-9@+=:,./_~#\- ]*$/.test(arg));
  };
  it('keeps the named actor in every next command of an open actor choice', async () => {
    const root = ambiguous();
    for (const [argv, code] of [
      [['--set', '@milestone m1', 'work.foo=x'], 'IA-CLI-EDIT-INVALID'],
      [['--relate', '@milestone m1', 'requires', '@plan p1'], 'IA-LANG-EDGE-UNCONSENTED'],
      [['milestones', 'm9'], 'IA-CLI-EDIT-INVALID'],
    ] as const) {
      const refusal = await refused(root, [...argv, '--actor', participant], code);
      expect(nextArgv(refusal['next'] as string), argv.join(' ')).toEqual(
        expect.arrayContaining(['--actor', participant]),
      );
    }
  });
  it('repeats no value that holds shell syntax in a printed next command', async () => {
    const values = ['$(echo INJECTED)', '`echo INJECTED`', '%PATH%', 'a;rm -rf x', 'say "hi"', "it's"];
    const open = ambiguous();
    const plain = workspace();
    for (const value of values) {
      const checks: (readonly [string, readonly string[]])[] = [
        [plain, ['task', 't9', `meaning.says=${value}`, '--at', 'docs/t9.ia']],
        [open, ['task', 't9', `meaning.says=${value}`]],
      ];
      for (const [root, argv] of checks) {
        const refusal = body(await preview(root, argv));
        expect(refusal['ok'], `${value} ${argv.join(' ')}`).toBe(false);
        expect(inert(refusal.next!), `${value}: ${refusal.next}`).toBe(true);
      }
      const missing = body(
        await run(['author', '--set', '@milestone m1', `work.owner=${value}`, '--root', plain, '--json']),
      );
      expect(inert(missing.next!), `${value}: ${missing.next}`).toBe(true);
    }
  });
  it('names the same command without --actor when a mistyped actor stands in for an allowed default', async () => {
    const root = workspace();
    const refusal = await refused(root, ['task', '--actor', '@agent reviewer'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(refusal['next'] as string)).toEqual(commandRoots(['preview', 'task', '--root', root]));
  });
  it('offers a participant the mandates bind when none binds the steward, and reads no installed steward as default', async () => {
    const unbound = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.slice(0, text.indexOf('\n@mandate demo-mandate')) + '\n');
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'scope [@workspace demo]'])}`,
      );
    });
    const refusal = await refused(unbound, ['task'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(refusal['next'] as string)).toEqual(
      commandRoots(['preview', 'task', '--actor', ops, '--root', unbound]),
    );
    const installed = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    steward @agent demo\n', '    steward @agent public-work-system-steward\n'),
      ),
    );
    expect(body(await preview(installed, ['task']))).toMatchObject({
      profile: { actor: participant, by: 'participant' },
    });
  });
  it('exempts only the real --root value and quotes a bare #, @ or ~ token', async () => {
    const { inertNext } = await import('../src/profile.js');
    const { Refusal } = await import('../src/consumer.js');
    const { parseArguments } = await import('../src/args.js');
    const { findCommand } = await import('../src/commands.js');
    const command = findCommand('preview')!,
      args = parseArguments(['task', '--root', 'C:/ws'], command.grammar);
    const nextOf = (next: string): string =>
      inertNext(new Refusal('IA-CLI-EDIT-INVALID', 'refused', 1, null, `Run "${next}" again.`), { command, args })
        .next!;
    const FALLBACK = ['preview', 'task', '--root', 'C:/ws'];
    // A `--root` after `--` is a positional, and a --root value other than the invocation's is no exemption.
    expect(nextArgv(nextOf('ia preview task -- --root $(id) --root C:/ws'))).toEqual(commandRoots(FALLBACK));
    expect(nextArgv(nextOf('ia preview task --root $(id)'))).toEqual(commandRoots(FALLBACK));
    // A value with a space is quoted, but `$()` stays live in double quotes, so it is never repeated.
    expect(nextArgv(nextOf('ia preview task "a $(id)" --root C:/ws'))).toEqual(commandRoots(FALLBACK));
    // A bare token opening a comment, a PowerShell splat or a tilde expansion is repeated quoted, and so is one holding a
    // comma (a PowerShell array) or a tilde anywhere.
    for (const token of ['#x', '@milestone', 'a,b', 'work.peers=x,y', 'x~y', 'k=~/x']) {
      const next = nextOf(`ia preview task ${token} --root C:/ws`);
      expect(next, token).toBe(`Run "ia preview task ${JSON.stringify(token)} --root C:/ws" again.`);
      expect(nextArgv(next)).toEqual(commandRoots(['preview', 'task', token, '--root', 'C:/ws']));
    }
    // A token that opens with `~` is never repeated: pwsh expands it even double-quoted through an npm-style .ps1
    // shim, so the next falls back to the word's preview.
    expect(nextArgv(nextOf('ia preview task ~/x --root C:/ws'))).toEqual(commandRoots(FALLBACK));
    expect(nextArgv(nextOf('ia preview task m-1 --actor ~x --root C:/ws'))).toEqual(commandRoots(FALLBACK));
    // The invocation's own --root value is repeated as every command repeats it.
    expect(nextOf('ia preview task m-1 --root C:/ws')).toBe('Run "ia preview task m-1 --root C:/ws" again.');
    // A quoted value full of `\"` is split in one pass (CodeQL js/polynomial-redos): a quote is shell syntax, so it falls
    // back, and a long one costs no more than a short one.
    const quotes = (count: number): string => `ia preview task ${JSON.stringify('"'.repeat(count))} --root C:/ws`;
    expect(nextArgv(nextOf(quotes(3)))).toEqual(commandRoots(FALLBACK));
    const started = performance.now();
    expect(nextArgv(nextOf(quotes(200_000)))).toEqual(commandRoots(FALLBACK));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  it('escapes terminal controls from caller input in human refusals', async () => {
    const root = workspace();
    const esc = String.fromCharCode(0x1b),
      rlo = String.fromCharCode(0x202e);
    const human = await run(['preview', 'task', '--actor', `evil${esc}[2J${rlo}x`, '--root', root]);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).not.toContain(esc);
    expect(human.stderr).not.toContain(rlo);
    expect(human.stderr).toContain('\\u001b');
  });
});

describe('the portable path rule', () => {
  it("refuses exactly the paths db's opened-handle reader refuses as unsafe", async () => {
    const root = workspace();
    const { portable } = await import('../src/preview.js');
    const { readWorkspaceBytes } = await import('@inventarch/db');
    // `.` and `..` segments and empty ones db normalizes away, and reader.preview refuses as non-canonical; the CLI refuses
    // them outright, so they are no part of this parity.
    expect(['.ia/src/../new.ia', '.ia/src/./new.ia', '.ia//src/new.ia'].some(portable)).toBe(false);
    for (const path of [
      '.ia/src/new.ia',
      '.ia/src/a b.ia',
      '.ia/src/new.ia.',
      '.ia/src/new.ia ',
      '.ia/src/con.ia',
      '.ia/src/aux/new.ia',
      '.ia/src/x:y.ia',
      '.ia/src/x?.ia',
      '.ia/src/x*.ia',
      '.ia/src/x|y.ia',
      '.ia/src/x<y.ia',
      '.ia/src/x"y.ia',
      '.ia/src/tab\there.ia',
    ]) {
      let unsafe = false;
      try {
        readWorkspaceBytes(root, path, 1024);
      } catch (error) {
        unsafe = (error as { readonly code?: string }).code === 'IA-DB-PATH-UNSAFE';
      }
      expect(portable(path), path).toBe(!unsafe);
    }
    // A deliberate difference: the CLI also refuses DEL, a C1 control, the line and paragraph separators
    // and the bidirectional controls, which db's reader admits.
    for (const code of [0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0x202e, 0x2066]) {
      const path = `.ia/src/x${String.fromCharCode(code)}y.ia`;
      let unsafe = false;
      try {
        readWorkspaceBytes(root, path, 1024);
      } catch (error) {
        unsafe = (error as { readonly code?: string }).code === 'IA-DB-PATH-UNSAFE';
      }
      expect(unsafe, `db: U+${code.toString(16)}`).toBe(false);
      expect(portable(path), `cli: U+${code.toString(16)}`).toBe(false);
    }
  });
  it('refuses an --at path holding a control db admits, naming a path that runs', async () => {
    const root = workspace();
    const path = `.ia/src/x${String.fromCharCode(0x202e)}y.ia`;
    await refused(root, ['task', 't9', '--at', path], 'IA-DB-PATH-UNSAFE');
    const human = await run(['preview', 'task', 't9', '--at', path, '--root', root]);
    expect(human.exitCode).toBe(3);
    expect(human.stderr).not.toContain(String.fromCharCode(0x202e));
  });
});
