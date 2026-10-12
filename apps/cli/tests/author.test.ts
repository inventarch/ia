/**
 * `ia author` and the mandate profile on every gated mode (milestone generation-binding plan amendments C1, C3, C19 and
 * C20; continuation lane C; review claude-v1 B2), on an `ia init` workspace with the CLI composition fixture laid over
 * it and a small plan authored. A successful author writes exactly the candidate its preview showed, with one
 * attribution comment, and moves no other record's digest; every refusal writes nothing, and its next command runs in
 * the state that refused.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { open } from '@inventarch/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, cli, nextArgv, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
afterAll(cleanup);

/**
 * Review C2-N3: every workspace session a command opens, counted at the distribution service the CLI's session module
 * opens it through (that module imports the dispatcher, so it is not mocked itself). Review C2-N15: `replaceError`, when
 * set, is what the distribution's `replace` throws, as a volume would.
 */
const sessions = vi.hoisted(() => ({ opened: 0, replaceError: undefined as Error | undefined }));
vi.mock('@inventarch/distribution/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/distribution/services')>();
  return {
    ...actual,
    openWorkspaceSession: (...args: Parameters<typeof actual.openWorkspaceSession>) => {
      sessions.opened++;
      return actual.openWorkspaceSession(...args);
    },
    replace: (...args: Parameters<typeof actual.replace>) => {
      if (sessions.replaceError !== undefined) throw sessions.replaceError;
      return actual.replace(...args);
    },
  };
});

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
  milestone = (name: string) => `work-system/definition/milestone/${name}`,
  EMPTY = createHash('sha256').update('').digest('hex');
const MANDATE = (name: string, authority: readonly string[]) =>
  `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
const AGENT = (name: string) =>
  `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;

let base = '';
beforeAll(async () => {
  base = resolve(scratch('author-base'), 'demo');
  const init = await run(['init', base, '--apply', '--yes', '--host', 'none', '--json']);
  expect(init.exitCode, init.stdout).toBe(0);
  cpSync(resolve(cli, 'tests/fixtures/composition-workspace'), base, { recursive: true });
  writeFileSync(resolve(base, '.ia/src/work.ia'), WORK);
});
function workspace(edit: (root: string) => void = () => {}): string {
  const root = resolve(scratch('author'), 'demo');
  cpSync(base, root, { recursive: true });
  edit(root);
  return root;
}
const rewrite = (root: string, path: string, change: (text: string) => string): void =>
  writeFileSync(resolve(root, path), change(readFileSync(resolve(root, path), 'utf8')));
const moves = (root: string, list: string): void =>
  rewrite(root, '.ia/src/workspace.ia', (text) =>
    text.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', `moves [${list}]`),
  );
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
/** Every admitted record's digest, read by a db handle of its own. */
function digests(root: string): ReadonlyMap<string, string> {
  const db = open(root, { cache: false });
  try {
    return new Map(db.records().map((node) => [node.identity, node.digest]));
  } finally {
    db.close();
  }
}
const body = (result: Result) => JSON.parse(result.stdout) as Record<string, unknown> & { readonly next?: string };
const ia = (root: string, argv: readonly string[]): Promise<Result> =>
  run([...argv, '--root', root, '--json'], { env: HOMES });
/** The IA homes every command here runs with (review C-N6), so a write to either is seen. */
const HOMES = { IA_HOST_HOME: scratch('author-host-home'), IA_CONFIG_HOME: scratch('author-config-home') };
const trees = (root: string) => ({
  root: tree(root),
  host: tree(HOMES.IA_HOST_HOME),
  config: tree(HOMES.IA_CONFIG_HOME),
});
/** One command that must write nothing, whatever it returns. */
async function unchanged(root: string, argv: readonly string[]): Promise<Result> {
  const before = trees(root);
  const result = await ia(root, argv);
  expect(trees(root), `ia ${argv.join(' ')} wrote`).toEqual(before);
  return result;
}
/**
 * A refusal that writes nothing, its code, and (unless `follow` is false) its next command run in the same state:
 * that command refuses nothing of its own (a preview whose candidate has findings is a verdict, at exit 1 with nothing
 * on stderr) and writes nothing unless it is itself an author form.
 */
async function refused(
  root: string,
  argv: readonly string[],
  code: string,
  follow = true,
): Promise<Record<string, unknown>> {
  const result = await unchanged(root, argv);
  expect(result.exitCode, result.stdout).not.toBe(0);
  const refusal = body(result);
  expect(refusal, argv.join(' ')).toMatchObject({ ok: false, code });
  if (!follow) return refusal;
  const next = nextArgv(refusal.next!);
  expect(next, refusal.next).toContain('--root');
  const before = tree(root);
  const followed = await run(next, { env: HOMES });
  expect(followed.stderr, refusal.next).toBe('');
  expect(followed.exitCode, `${refusal.next}\n${followed.stdout}`).toBeLessThanOrEqual(1);
  if (next[0] !== 'author') expect(tree(root), refusal.next).toEqual(before);
  return refusal;
}
/** The digest `ia preview` prints for a form, asserting the candidate is clean. */
async function previewed(root: string, argv: readonly string[]): Promise<string> {
  const result = await ia(root, ['preview', ...argv]);
  expect(result.exitCode, result.stdout).toBe(0);
  return body(result)['digest'] as string;
}
/** An author form after its preview: the result, and the admitted digests before and after. */
async function authored(root: string, argv: readonly string[], extra: readonly string[] = []) {
  const digest = await previewed(root, [...argv, ...extra]);
  const before = digests(root);
  const result = await ia(root, ['author', ...argv, ...extra, '--digest', digest]);
  expect(result.exitCode, result.stdout).toBe(0);
  return { view: body(result), before, after: digests(root), digest };
}
/** Of every admitted record, only `changed` may differ, appear or vanish. */
const onlyChanged = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id)).sort();

describe('ia author', () => {
  it('writes one relationship row with its attribution, and the workspace still validates', async () => {
    const root = workspace();
    const work = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
    const db = open(root, { cache: false }),
      authoredRevision = db.authoredRevision;
    db.close();
    const { view, before, after, digest } = await authored(root, [
      '--relate',
      '@milestone m2',
      'requires',
      '@milestone m1',
    ]);
    expect(onlyChanged(before, after)).toEqual([milestone('m2')]);
    const written = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
    const attribution = `# authored-by @agent demo under @mandate demo-mandate at ${view['authoredRevision']}`;
    expect(view).toMatchObject({
      mode: 'relate',
      path: '.ia/src/work.ia',
      created: false,
      previousDigest: digest,
      digest: createHash('sha256').update(written).digest('hex'),
      identity: milestone('m2'),
      attribution,
      profile: { actor: participant, grantedBy: mandate('demo-mandate') },
    });
    // The file gains the attribution line and the relationships section, and nothing else.
    expect(written).toBe(
      work.replace('\n@milestone m2\n', `\n${attribution}\n@milestone m2\n`) +
        '  relationships\n    requires @milestone m1\n',
    );
    // The attribution names the authored revision the candidate was compiled against (db's, not the full revision).
    expect(view['authoredRevision']).toBe(authoredRevision);
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    // A second author replaces the attribution rather than stacking another.
    await authored(root, ['--set', '@milestone m2', 'work.owner=Tom']);
    expect(readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8').match(/# authored-by/g)).toHaveLength(1);
  });
  it('sets one field and appends one new record, moving no other digest', async () => {
    const root = workspace();
    const set = await authored(root, ['--set', '@milestone m1', 'work.owner=Tom Crown']);
    expect(onlyChanged(set.before, set.after)).toEqual([milestone('m1')]);
    expect(set.view['record']).toContain('    owner "Tom Crown"');
    const created = await authored(root, [
      'task',
      't1',
      'meaning.says=The first task',
      'work.title=First task',
      'work.status=open',
      'work.milestone=@milestone m1',
    ]);
    expect(created.digest).toBe(EMPTY);
    expect(created.view).toMatchObject({
      created: true,
      path: '.ia/src/task.ia',
      identity: 'work-system/definition/task/t1',
    });
    expect(onlyChanged(created.before, created.after)).toEqual(['work-system/definition/task/t1']);
    expect(readFileSync(resolve(root, '.ia/src/task.ia'), 'utf8')).toMatch(
      /^#! ia 1\.0\n\n# authored-by @agent demo under @mandate demo-mandate at [0-9a-f]{64}\n@task t1\n/,
    );
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
  });
  it('writes an edit beside an error already in another record of the file (review C-R4)', async () => {
    const root = workspace((at) =>
      rewrite(
        at,
        '.ia/src/work.ia',
        (text) =>
          `${text}\n@milestone m4\n  meaning\n    says "No exit."\n  work\n    title "Fourth"\n    status open\n    plan @plan p1\n`,
      ),
    );
    const { before, after } = await authored(root, ['--set', '@milestone m1', 'work.owner=Tom']);
    expect(onlyChanged(before, after)).toEqual([milestone('m1')]);
  });
  it('writes a starter system, whose next command composes it into the workspace', async () => {
    const root = workspace();
    const guidance = body(await ia(root, ['preview', 'system']));
    expect(guidance).toMatchObject({ word: 'system', system: 'floor', template: '.ia/src/systems/<name>/system.ia' });
    expect((guidance['schema'] as { fields: { path: string }[] }).fields.map((field) => field.path)).toEqual([
      'head.provider',
      'head.version',
      'head.steward',
      'head.describes',
    ]);
    expect(body(await ia(root, ['preview', 'schema']))).toMatchObject({ word: 'schema', system: 'floor' });
    const before = digests(root);
    const result = await ia(root, ['author', 'system', 'notes']);
    expect(result.exitCode, result.stdout).toBe(0);
    const view = body(result);
    expect(view).toMatchObject({
      created: true,
      path: '.ia/src/systems/notes/system.ia',
      identity: 'floor/definition/system/notes',
    });
    expect(onlyChanged(before, digests(root))).toEqual([
      'agent-system/binding/agent/notes-steward',
      'floor/definition/system/notes',
    ]);
    const next = nextArgv(view['next'] as string);
    expect(next.slice(0, 4)).toEqual(['author', '--set', demo, 'composition.systems+=@system notes']);
    const composed = await run([...next, '--json']);
    expect(composed.exitCode, composed.stdout).toBe(0);
    expect(readFileSync(resolve(root, '.ia/src/workspace.ia'), 'utf8')).toContain(
      '@system workspace-system, @system notes]',
    );
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    // The file now exists, so a second one refuses.
    await refused(root, ['author', 'system', 'notes'], 'IA-CLI-EDIT-INVALID');
  });
});

describe('structural check admission on the authoring paths (C21)', () => {
  const check = (name: string, runner: string, scope: string) =>
    `\n@check ${name}\n  meaning\n    says "Bind ${name} for the test."\n    answers "What does ${name} select?"\n  check\n    runs ${runner}\n    scope "${scope}"\n`;
  const ID = (name: string) => `compliance-system/check/gate/${name}`;
  const revisions = (root: string, options: Parameters<typeof open>[1]) => {
    const db = open(root, { cache: false, ...options });
    try {
      return { revision: db.revision, authored: db.authoredRevision };
    } finally {
      db.close();
    }
  };
  it('previews and authors beside a check whose evaluator is not built in, as validate admits it, reading no evidence', async () => {
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/checks.ia'),
        `#! ia 1.0\n${check('demo-schema-check', 'COMP-SCHEMA', '*')}${check('typing-check', 'acme-strict-typing', 'package')}`,
      ),
    );
    // Validate admits the check structurally and names it in its summary; the passing built-in check is recorded.
    const summary = `1 check names an evaluator that is not built in (${ID('typing-check')}): ia validate admits it to bind it, as ia preview and ia author do, but every other reader counts it as an IA-COMP-CHECK-UNKNOWN error, so ia host and ia project refuse the workspace and ia capture records it as an error; remove or replace it before ia host or ia project.`;
    const validated = await ia(root, ['validate']);
    expect(validated.exitCode, validated.stdout).toBe(0);
    expect(body(validated)['evidence']).toMatchObject({ written: true });
    expect((await run(['validate', '--root', root], { env: HOMES })).stdout.replace(/\s+/g, ' ')).toContain(summary);
    // The evidence file is this authored revision's, one a reader that asks for evidence reads.
    const plain = revisions(root, {}),
      evidenced = revisions(root, { checks: 'structural', evidence: true });
    expect(existsSync(resolve(root, `.ia/work/evidence/${plain.authored}.ia`))).toBe(true);
    expect(evidenced.revision).not.toBe(plain.revision);
    expect(evidenced.authored).toBe(plain.authored);
    // A field of an unrelated record previews clean, as it did; and the check itself, which validate admits, is an
    // owned record to edit. No evidence file is read into either snapshot: its revision is the evidence-free one.
    const milestoneForm = ['--set', '@milestone m1', 'work.owner=Tom'],
      typingForm = ['--set', '@check typing-check', 'check.scope=workspace'];
    for (const [form, identity] of [
      [milestoneForm, milestone('m1')],
      [typingForm, ID('typing-check')],
    ] as const) {
      const previewed = await unchanged(root, ['preview', ...form]);
      expect(previewed.exitCode, previewed.stdout).toBe(0);
      expect(body(previewed)).toMatchObject({ clean: true, findings: [], identity, baseRevision: plain.revision });
    }
    // Both are written.
    expect((await authored(root, milestoneForm)).view).toMatchObject({ mode: 'set', identity: milestone('m1') });
    expect((await authored(root, typingForm)).view).toMatchObject({ mode: 'set', identity: ID('typing-check') });
    // A new check naming another evaluator that is not built in drafts clean and is written.
    const created = await authored(root, [
      'check',
      'lint-check',
      'meaning.says=Lint the package.',
      'meaning.answers=Is the package linted?',
      'check.runs=acme-lint',
      'check.scope=package',
    ]);
    expect(created.view).toMatchObject({ created: true, identity: ID('lint-check') });
    // A check naming no evaluator still counts against the candidate, as it does for validate.
    const bare = await unchanged(root, [
      'preview',
      'check',
      'bare-check',
      'meaning.says=Name nothing.',
      'meaning.answers=What runs?',
      'check.scope=package',
    ]);
    expect(bare.exitCode, bare.stdout).toBe(1);
    expect(body(bare)).toMatchObject({
      clean: false,
      findings: [expect.objectContaining({ code: 'IA-COMP-CHECK-UNKNOWN' })],
    });
    // Validate still admits structurally and names both checks; every strict reader counts them as errors.
    const after = await run(['validate', '--root', root], { env: HOMES });
    expect(after.exitCode, after.stdout).toBe(0);
    const named =
      /2 checks name evaluators that are not built in \(([^)]*)\): ia validate admits them to bind them, as ia preview and ia author do, but every other reader counts them as IA-COMP-CHECK-UNKNOWN errors, so ia host and ia project refuse the workspace and ia capture records them as errors; remove or replace them before ia host or ia project\./.exec(
        after.stdout.replace(/\s+/g, ' '),
      );
    expect(named?.[1]?.split(' and ').sort(), after.stdout).toEqual([ID('lint-check'), ID('typing-check')]);
    const strict = open(root, { cache: false });
    try {
      expect(strict.report.findings.filter((finding) => finding.code === 'IA-COMP-CHECK-UNKNOWN')).toHaveLength(2);
    } finally {
      strict.close();
    }
  });
});

describe('the next command after an author (review C2-N11, C2-N13)', () => {
  it('names the governance position, not an ia validate the profile refuses, under Synthesis without Verification', async () => {
    const root = workspace((at) => moves(at, 'Observation, Synthesis'));
    const digest = createHash('sha256')
      .update(readFileSync(resolve(root, '.ia/src/work.ia')))
      .digest('hex');
    const written = await ia(root, ['author', '--set', '@milestone m1', 'work.owner=Tom', '--digest', digest]);
    expect(written.exitCode, written.stdout).toBe(0);
    expect(nextArgv(body(written).next!).slice(0, 3)).toEqual(['position', '--seat', mandate('demo-mandate')]);
  });
  it('carries a named actor as the participant it resolved, not as spelled', async () => {
    const root = workspace();
    const written = await ia(root, ['author', 'system', 'notes', '--actor', '@agent demo']);
    expect(written.exitCode, written.stdout).toBe(0);
    const next = nextArgv(body(written).next!),
      at = next.indexOf('--actor');
    expect(next.slice(0, 4)).toEqual(['author', '--set', demo, 'composition.systems+=@system notes']);
    expect(next.slice(at, at + 2)).toEqual(['--actor', participant]);
    expect(body(written).next).not.toContain('@agent demo');
  });
});

describe('ia author refusals, each writing nothing', () => {
  it('refuses a missing, malformed or stale digest, naming the preview that prints the current one', async () => {
    const root = workspace();
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const missing = await refused(root, ['author', ...form], 'IA-CLI-USAGE');
    expect(nextArgv(missing['next'] as string)).toEqual([
      'preview',
      '@milestone m1',
      'work.owner=Tom',
      '--set',
      '--root',
      root,
    ]);
    await refused(root, ['author', ...form, '--digest', 'abc'], 'IA-CLI-USAGE');
    const digest = await previewed(root, form);
    rewrite(root, '.ia/src/work.ia', (text) =>
      text.replace('says "The second milestone."', 'says "Edited after the preview."'),
    );
    const stale = await refused(root, ['author', ...form, '--digest', digest], 'IA-CLI-EDIT-STALE');
    expect(stale['message']).toContain('is not the file the preview named');
    // A new file that appeared after its preview is stale too.
    const draft = ['task', 't1', 'meaning.says=x', 'work.title=x', 'work.status=open', 'work.milestone=@milestone m1'];
    const empty = await previewed(root, draft);
    writeFileSync(resolve(root, '.ia/src/task.ia'), '#! ia 1.0\n');
    await refused(root, ['author', ...draft, '--digest', empty], 'IA-CLI-EDIT-STALE');
  });
  it('refuses a write the volume refuses as IA-CLI-FAILED naming the repair, never as a raw errno (review C2-N15)', async () => {
    const root = workspace();
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    sessions.replaceError = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    try {
      const refusal = await refused(root, ['author', ...form, '--digest', digest], 'IA-CLI-FAILED');
      expect(refusal['message']).toContain('EPERM');
      expect(refusal['next']).toContain('.ia/src/work.ia writable');
      expect(nextArgv(refusal['next'] as string)[0]).toBe('preview');
    } finally {
      sessions.replaceError = undefined;
    }
    // A distribution code is kept as it is.
    sessions.replaceError = Object.assign(new Error('Unsafe relative path'), { code: 'IA-DIST-PATH-UNSAFE' });
    try {
      await refused(root, ['author', ...form, '--digest', digest], 'IA-DIST-PATH-UNSAFE');
    } finally {
      sessions.replaceError = undefined;
    }
  });
  it('refuses a source replaced by a link or junction between the preview and the author', async () => {
    const root = workspace((at) => {
      mkdirSync(resolve(at, '.ia/src/notes'));
      writeFileSync(
        resolve(at, '.ia/src/notes/notes.ia'),
        '#! ia 1.0\n\n@milestone m3\n  meaning\n    says "Third."\n  work\n    title "Third"\n    status open\n    plan @plan p1\n    exit "Done."\n',
      );
    });
    const form = ['--set', '@milestone m3', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    const moved = resolve(scratch('author-moved'), 'notes');
    renameSync(resolve(root, '.ia/src/notes'), moved);
    symlinkSync(moved, resolve(root, '.ia/src/notes'), 'junction');
    const outside = tree(moved);
    // The db refuses to read a source through the junction, so nothing is compiled or written; its next asks for the
    // link to go first, a step the CLI cannot take.
    const linked = await refused(root, ['author', ...form, '--digest', digest], 'IA-DB-PATH-UNSAFE', false);
    expect(linked['next']).toContain('Replace or remove the source path named above');
    expect(tree(moved)).toEqual(outside);
    // A file link, where this host grants one.
    rmSync(resolve(root, '.ia/src/notes'));
    renameSync(moved, resolve(root, '.ia/src/notes'));
    const target = resolve(root, '.ia/src/notes/notes.ia'),
      elsewhere = resolve(scratch('author-file'), 'notes.ia');
    renameSync(target, elsewhere);
    try {
      symlinkSync(elsewhere, target, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      return;
    }
    await refused(root, ['author', ...form, '--digest', digest], 'IA-DB-PATH-UNSAFE', false);
  });
  it('refuses an unowned target, an unconsented relation, a type mismatch and an unclean candidate', async () => {
    const root = workspace();
    const fake = 'a'.repeat(64);
    await refused(
      root,
      [
        'author',
        '--set',
        'agent-system/binding/agent/public-work-system-steward',
        'meaning.says=Mine',
        '--digest',
        fake,
      ],
      'IA-CLI-EDIT-UNOWNED',
    );
    await refused(
      root,
      ['author', 'task', 't9', 'meaning.says=x', '--at', 'docs/task.ia', '--digest', EMPTY],
      'IA-CLI-EDIT-UNOWNED',
    );
    // Another spelling of an existing source is judged as the volume spells it (review C-R1), on a volume that folds case.
    if (existsSync(resolve(root, '.IA/SRC'))) {
      const digest = createHash('sha256')
        .update(readFileSync(resolve(root, '.ia/src/work.ia')))
        .digest('hex');
      const alias = await refused(
        root,
        ['author', 'milestone', 'm3', 'meaning.says=x', '--at', '.ia/src/WORK.ia', '--digest', digest],
        'IA-DB-PATH-UNSAFE',
      );
      expect(nextArgv(alias['next'] as string)).toContain('.ia/src/work.ia');
    }
    await refused(
      root,
      ['author', '--relate', '@milestone m1', 'requires', '@plan p1', '--digest', fake],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    await refused(
      root,
      ['author', '--set', '@milestone m1', 'work.status=alien', '--digest', fake],
      'IA-CLI-EDIT-INVALID',
    );
    // A candidate with errors (a new task missing its required fields) refuses, naming the preview that lists them.
    const unclean = await refused(
      root,
      ['author', 'task', 't9', 'milestone=@milestone', 'm1', '--digest', EMPTY],
      'IA-CLI-EDIT-UNCLEAN',
    );
    expect(unclean['message']).toContain('IA-COMP-FIELD-MISSING');
    expect(nextArgv(unclean['next'] as string)[0]).toBe('preview');
    // Review C2-N12: the first error is located once, not as `path:line: path:line:`.
    const located = /at (\S+:\d+): /.exec(unclean['message'] as string)![1]!;
    expect(unclean['message']).not.toContain(`${located}: ${located}:`);
  });
  it('tells an empty --digest from an absent one, and an absent file from an empty one (review C2-N12)', async () => {
    const root = workspace();
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    // An empty value is the parser's usage error; an absent one is judged after the profile and names the preview.
    const empty = await ia(root, ['author', ...form, '--digest', '']);
    expect(empty.exitCode, empty.stdout).toBe(2);
    expect(body(empty)).toMatchObject({ ok: false, code: 'IA-CLI-USAGE' });
    expect(body(empty)['message']).toContain('--digest');
    const absent = await refused(root, ['author', ...form], 'IA-CLI-USAGE');
    expect(nextArgv(absent['next'] as string)[0]).toBe('preview');
    // A new record's preview digests an absent file as the empty one, so an empty file in its place is the same file.
    const draft = ['task', 't1', 'meaning.says=x', 'work.title=x', 'work.status=open', 'work.milestone=@milestone m1'];
    expect(await previewed(root, draft)).toBe(EMPTY);
    writeFileSync(resolve(root, '.ia/src/task.ia'), '');
    const written = await ia(root, ['author', ...draft, '--digest', EMPTY]);
    expect(written.exitCode, written.stdout).toBe(0);
    expect(body(written)).toMatchObject({ created: false, previousDigest: EMPTY });
    expect(readFileSync(resolve(root, '.ia/src/task.ia'), 'utf8')).toContain('@task t1');
  });
  it('refuses a move outside the mandate and an excluded word', async () => {
    const root = workspace((at) => moves(at, 'Observation, Verification'));
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    const move = await refused(root, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-MOVE');
    expect(move['message']).toBe(`${mandate('demo-mandate')} allows Observation, Verification; author needs Synthesis`);
    const excluded = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace(
          '    scope [@workspace demo]\n',
          '    scope [@workspace demo]\n    excluded-words [milestone, system]\n',
        ),
      ),
    );
    await refused(excluded, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-WORD');
    await refused(excluded, ['author', 'system', 'notes'], 'IA-RUNTIME-MANDATE-WORD');
  });
  it('refuses a change to a @mandate that binds the acting participant, and allows one for another (review C2-R6)', async () => {
    const root = workspace((at) => writeFileSync(resolve(at, '.ia/src/ops.ia'), `#! ia 1.0\n${AGENT('ops')}`));
    const draft = (name: string, authority: readonly string[]) => [
      'mandate',
      name,
      'meaning.says=Fixture mandate.',
      'meaning.answers=What may its participant do?',
      ...authority,
    ];
    // A new mandate that would bind demo, by naming it or by naming no participant where demo acts, is refused.
    for (const authority of [
      ['authority.participant=@agent demo', 'authority.moves=[Execution]'],
      ['authority.moves=[Execution]', 'authority.scope=[@workspace demo]'],
      ['authority.covers=[src/]'],
    ]) {
      const form = draft('self', authority);
      const preview = await refused(root, ['preview', ...form], 'IA-CLI-EDIT-MANDATE');
      expect(preview['message'], authority.join(' ')).toContain(participant);
      expect(nextArgv(preview['next'] as string).slice(0, 4)).toEqual(['position', '--seat', demo, '--shape']);
      await refused(root, ['author', ...form, '--digest', EMPTY], 'IA-CLI-EDIT-MANDATE');
    }
    // Its own mandate is refused any change, and the refusal names that mandate's governance position.
    for (const form of [
      ['--set', '@mandate demo-mandate', 'authority.moves=[Observation]'],
      ['--set', '@mandate demo-mandate', 'authority.excluded-words=[hook]'],
      ['--set', '@mandate demo-mandate', 'authority.participant=@agent ops'],
    ]) {
      const own = await refused(root, ['preview', ...form], 'IA-CLI-EDIT-MANDATE');
      expect(nextArgv(own['next'] as string).slice(0, 3)).toEqual(['position', '--seat', mandate('demo-mandate')]);
      const digest = createHash('sha256')
        .update(readFileSync(resolve(root, '.ia/src/workspace.ia')))
        .digest('hex');
      await refused(root, ['author', ...form, '--digest', digest], 'IA-CLI-EDIT-MANDATE');
    }
    // A mandate for another participant is written, and so is a change to it that keeps it another's.
    const other = draft('ops-mandate', [
      'authority.participant=@agent ops',
      'authority.moves=[Observation]',
      'authority.scope=[@workspace demo]',
    ]);
    expect((await authored(root, other)).view['identity']).toBe(mandate('ops-mandate'));
    await authored(root, ['--set', '@mandate ops-mandate', 'authority.moves=[Observation, Verification]']);
    // Handing it to demo would bind the actor, so that is refused.
    await refused(
      root,
      ['preview', '--set', '@mandate ops-mandate', 'authority.participant=@agent demo'],
      'IA-CLI-EDIT-MANDATE',
    );
  });
  it('holds a restricting mandate against its own participant when it excludes workspace, agent and mandate (review C3-R1)', async () => {
    // The documented recipe: a mandate that should hold against its own participant excludes the words that would let it
    // move the mandate out of the closure, add a participant with a broader mandate, or name a new steward.
    const root = workspace((at) => {
      moves(at, 'Observation, Verification, Synthesis');
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace(
          '    scope [@workspace demo]\n',
          '    scope [@workspace demo]\n    excluded-words [workspace, agent, mandate]\n',
        ),
      );
    });
    const digest = createHash('sha256')
      .update(readFileSync(resolve(root, '.ia/src/workspace.ia')))
      .digest('hex');
    const attempts: readonly (readonly [string, readonly string[], string])[] = [
      // (a) moving its mandate out of the workspace's closure by changing the authored roots.
      ['a', ['--set', '@workspace demo', 'composition.sources=["elsewhere/"]', '--digest', digest], 'workspace'],
      // (b) a second participant, then a broader mandate for it to act as.
      ['b', ['agent', 'b', 'meaning.says=A second participant.', '--digest', EMPTY], 'agent'],
      ['b', ['mandate', 'b-mandate', 'meaning.says=x', 'authority.participant=@agent b', '--digest', EMPTY], 'mandate'],
      // (c) a participant-less mandate, a new agent, and that agent named as steward.
      ['c', ['mandate', 'open', 'meaning.says=x', 'authority.moves=[Execution]', '--digest', EMPTY], 'mandate'],
      ['c', ['agent', 'free', 'meaning.says=Unbound.', '--digest', EMPTY], 'agent'],
      ['c', ['--set', '@workspace demo', 'composition.steward=@agent free', '--digest', digest], 'workspace'],
    ];
    for (const [route, argv, word] of attempts) {
      const refusal = await refused(root, ['author', ...argv], 'IA-RUNTIME-MANDATE-WORD');
      expect(refusal['message'], `(${route}) ${argv.join(' ')}`).toBe(`${mandate('demo-mandate')} excludes ${word}`);
    }
  });
  it('judges the profile before a missing or malformed digest, so the preview it names runs (review C2-R4)', async () => {
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    // An open actor choice is refused before the digest.
    const ambiguous = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification]', 'scope [@workspace demo]'])}`,
      );
    });
    // Review C3-R2: without a usable digest the next is the preview with the actor named, one hop that runs and prints
    // the digest; with one, it is the author form itself, the digest kept.
    for (const digest of [[], ['--digest', 'abc']]) {
      const open = await refused(ambiguous, ['author', ...form, ...digest], 'IA-RUNTIME-MANDATE-ACTOR');
      const named = nextArgv(open['next'] as string);
      expect(named, open['next'] as string).toEqual([
        'preview',
        '@milestone m1',
        'work.owner=Tom',
        '--set',
        '--actor',
        participant,
        '--root',
        ambiguous,
      ]);
      const preview = await run([...named, '--json'], { env: HOMES });
      expect(preview.exitCode, preview.stdout).toBe(0);
      const printed = body(preview)['digest'] as string;
      const author = await refused(
        ambiguous,
        ['author', ...form, '--digest', printed],
        'IA-RUNTIME-MANDATE-ACTOR',
        false,
      );
      expect(nextArgv(author['next'] as string).slice(0, 7)).toEqual([
        'author',
        '@milestone m1',
        'work.owner=Tom',
        '--set',
        '--digest',
        printed,
        '--actor',
      ]);
    }
    // A move the mandate does not grant and an excluded word are refused before the digest.
    const observer = workspace((at) => moves(at, 'Observation, Verification'));
    await refused(observer, ['author', ...form], 'IA-RUNTIME-MANDATE-MOVE');
    const excluded = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    scope [@workspace demo]\n', '    scope [@workspace demo]\n    excluded-words [milestone]\n'),
      ),
    );
    await refused(excluded, ['author', ...form, '--digest', 'abc'], 'IA-RUNTIME-MANDATE-WORD');
    // Synthesis without Verification: the digest refusal names the governance position, not a preview it refuses.
    const writer = workspace((at) => moves(at, 'Observation, Synthesis'));
    const usage = await refused(writer, ['author', ...form], 'IA-CLI-USAGE');
    expect(nextArgv(usage['next'] as string).slice(0, 4)).toEqual([
      'position',
      '--seat',
      mandate('demo-mandate'),
      '--shape',
    ]);
  });
});

describe('the mandate profile on every gated mode', () => {
  it('refuses each gated mode its mandate does not grant, naming a position that runs, and never gates position', async () => {
    const root = workspace((at) => moves(at, 'Delegation'));
    const fake = 'a'.repeat(64);
    for (const [argv, mode, move] of [
      [['read', participant], 'read', 'Observation'],
      [['next'], 'read', 'Observation'],
      [['validate'], 'validate', 'Verification'],
      [['preview', 'task'], 'validate', 'Verification'],
      [['author', '--set', '@milestone m1', 'work.owner=x', '--digest', fake], 'author', 'Synthesis'],
      [['capture'], 'effect', 'Execution'],
      [['capture', '--preview'], 'effect', 'Execution'],
      [['compile'], 'effect', 'Execution'],
      [['project', 'claude'], 'effect', 'Execution'],
    ] as const) {
      const refusal = await refused(root, argv, 'IA-RUNTIME-MANDATE-MOVE');
      expect(refusal['message'], argv.join(' ')).toBe(
        `${mandate('demo-mandate')} allows Delegation; ${mode} needs ${move}`,
      );
      expect(nextArgv(refusal['next'] as string), argv.join(' ')).toEqual([
        'position',
        '--seat',
        mandate('demo-mandate'),
        '--shape',
        'governance',
        '--root',
        root,
      ]);
    }
    expect((await ia(root, ['position'])).exitCode).toBe(0);
    expect((await ia(root, ['position', '--seat', mandate('demo-mandate'), '--shape', 'governance'])).exitCode).toBe(0);
  });
  it('gates a workspace ia host --apply as an effect, and leaves its plan, --remove and --user alone (review C2-R7)', async () => {
    const root = workspace((at) => moves(at, 'Observation, Verification'));
    const refusal = await refused(root, ['host', 'claude', '--apply', '--yes'], 'IA-RUNTIME-MANDATE-MOVE');
    expect(refusal['message']).toBe(
      `${mandate('demo-mandate')} allows Observation, Verification; effect needs Execution`,
    );
    expect(nextArgv(refusal['next'] as string).slice(0, 3)).toEqual(['position', '--seat', mandate('demo-mandate')]);
    // The plan writes nothing and is not gated; a removal restores editing and is not gated either.
    expect((await unchanged(root, ['host', 'claude'])).exitCode).toBe(0);
    const removal = body(await ia(root, ['host', 'claude', '--remove', '--apply', '--yes']));
    expect(String(removal['code'] ?? ''), JSON.stringify(removal)).not.toMatch(/^IA-RUNTIME-MANDATE-/);
    // A next command naming the apply is judged by the profile; the plan and the removal are left as they are.
    const { gatedNext } = await import('../src/profile.js');
    const { Refusal } = await import('../src/consumer.js');
    const restricted = {
      identity: mandate('demo-mandate'),
      band: 100 as const,
      participant,
      binds: true,
      moves: ['Observation', 'Verification'] as const,
      scope: [demo],
    };
    const gate = {
      state: { workspace: demo, actor: participant, by: 'steward' as const, mandates: [restricted], rooted: '' },
    };
    const nextOf = (command: string): string =>
      gatedNext(new Refusal('IA-CLI-FAILED', 'failed', 1, null, `Run "${command}" to repair it.`), gate).next!;
    expect(nextArgv(nextOf('ia host claude --apply')).slice(0, 3)).toEqual([
      'position',
      '--seat',
      mandate('demo-mandate'),
    ]);
    for (const command of ['ia host claude', 'ia host claude --remove --apply', 'ia host claude --user --apply'])
      expect(nextOf(command), command).toBe(`Run "${command}" to repair it.`);
  });
  it('judges validate, capture and project on the session that reads the verdict or the effect (review C2-N3)', async () => {
    const root = workspace();
    for (const argv of [['validate'], ['capture', '--preview'], ['project', 'claude']]) {
      sessions.opened = 0;
      const result = await ia(root, argv);
      expect(result.exitCode, `${argv.join(' ')}: ${result.stdout}`).toBe(0);
      expect(sessions.opened, argv.join(' ')).toBe(1);
    }
  });
  it('applies the projection its gate judged, through that one session, for project and host --apply (review C3-N2)', async () => {
    for (const argv of [
      ['project', 'claude', '--apply', '--yes'],
      ['host', 'claude', '--apply', '--yes'],
    ]) {
      const root = workspace();
      sessions.opened = 0;
      const result = await ia(root, argv);
      expect(result.exitCode, `${argv.join(' ')}: ${result.stdout}`).toBe(0);
      expect(sessions.opened, argv.join(' ')).toBe(1);
      expect(existsSync(resolve(root, '.claude/rules/ia-workspace.md')), argv.join(' ')).toBe(true);
    }
  });
  it('names the actor-less command after a mistyped actor only where its profile allows it (review C2-N7)', async () => {
    // No steward and no participant: the one mandate names none and grants Observation alone.
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    steward @agent demo\n', '').replace('    participant @agent demo\n', ''),
      );
      moves(at, 'Observation');
    });
    const refusal = await refused(root, ['validate', '--actor', 'nobody'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(refusal['next'] as string).slice(0, 3)).toEqual(['position', '--seat', demo]);
    // Where the actor-less profile allows the command, the next is that command.
    const read = await refused(root, ['read', participant, '--actor', 'nobody'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(read['next'] as string)).toEqual(['read', participant, '--root', root]);
  });
  it('judges excluded words only for preview and author, leaving read, validate, next and capture alone (review C2-N10)', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace(
          '    scope [@workspace demo]\n',
          '    scope [@workspace demo]\n    excluded-words [milestone, plan, mandate, workspace, agent]\n',
        ),
      ),
    );
    for (const argv of [
      ['read', milestone('m1')],
      ['read', mandate('demo-mandate')],
      ['validate'],
      ['next'],
      ['capture', '--preview'],
      ['project', 'claude'],
    ]) {
      const result = await unchanged(root, argv);
      expect(result.exitCode, `${argv.join(' ')}: ${result.stdout}`).toBe(0);
    }
    // The words they read are excluded only from what preview and author write.
    await refused(root, ['preview', 'milestone', 'm9'], 'IA-RUNTIME-MANDATE-WORD');
  });
  it("lets ia next name ia preview plan only when the actor's profile allows Verification", async () => {
    const noPlan = (list: string) =>
      workspace((at) => {
        rmSync(resolve(at, '.ia/src/work.ia'));
        moves(at, list);
      });
    const allowed = noPlan('Observation, Verification');
    const named = body(await unchanged(allowed, ['next']));
    expect(nextArgv(named.next!)).toEqual(['preview', 'plan', '--root', allowed]);
    const readOnly = noPlan('Observation');
    const refusal = await refused(readOnly, ['next'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(refusal['next'] as string)).toEqual([
      'position',
      '--seat',
      mandate('demo-mandate'),
      '--shape',
      'governance',
      '--root',
      readOnly,
    ]);
    expect(refusal['next']).toContain('preview needs Verification and @plan');
    // Review C-R6: an excluded @plan is no command the profile allows either.
    const excluded = workspace((at) => {
      rmSync(resolve(at, '.ia/src/work.ia'));
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    scope [@workspace demo]\n', '    scope [@workspace demo]\n    excluded-words [plan]\n'),
      );
    });
    const word = await refused(excluded, ['next'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(word['next'] as string)[0]).toBe('position');
    // Under an open actor choice, the named actor's preview carries --actor.
    const open = workspace((at) => {
      rmSync(resolve(at, '.ia/src/work.ia'));
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation]', 'scope [@workspace demo]'])}`,
      );
    });
    const actor = await refused(open, ['next', '--actor', participant], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(actor['next'] as string)).toEqual(['preview', 'plan', '--root', open, '--actor', participant]);
    // ops may read but not preview: its next names no preview.
    const ops = await refused(open, ['next', '--actor', 'agent-system/binding/agent/ops'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(ops['next'] as string)[0]).toBe('position');
  });
  it('keeps CRLF line endings and a byte-order mark in what it writes (review C-R8)', async () => {
    const bom = String.fromCharCode(0xfeff);
    for (const [label, encode] of [
      ['CRLF', (text: string) => text.replaceAll('\n', '\r\n')],
      ['BOM', (text: string) => `${bom}${text}`],
    ] as const) {
      const root = workspace((at) => rewrite(at, '.ia/src/work.ia', encode));
      const original = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
      const { before, after } = await authored(root, ['--set', '@milestone m2', 'work.owner=Tom']);
      expect(onlyChanged(before, after), label).toEqual([milestone('m2')]);
      const written = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
      // Everything before the attribution of m2 is the file's own bytes.
      expect(written.slice(0, written.indexOf('# authored-by')), label).toBe(
        original.slice(0, original.indexOf('@milestone m2')),
      );
      if (label === 'CRLF') expect(/[^\r]\n/.test(written), label).toBe(false);
      else expect(written.startsWith(bom), label).toBe(true);
      expect((await ia(root, ['validate'])).exitCode, label).toBe(0);
    }
  });
  it('resolves an open actor choice with --actor on every gated mode, carrying it into the next command', async () => {
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation]', 'scope [@workspace demo]'])}`,
      );
    });
    for (const argv of [
      ['read', participant],
      ['next'],
      ['validate'],
      ['capture', '--preview'],
      ['project', 'claude'],
    ]) {
      const ambiguous = await refused(root, argv, 'IA-RUNTIME-MANDATE-ACTOR');
      expect(nextArgv(ambiguous['next'] as string), argv.join(' ')).toContain('--actor');
      expect((await ia(root, [...argv, '--actor', participant])).exitCode, argv.join(' ')).toBe(0);
    }
    // ops may read but not validate: naming it lifts no move.
    expect((await ia(root, ['read', participant, '--actor', ops])).exitCode).toBe(0);
    await refused(root, ['validate', '--actor', ops], 'IA-RUNTIME-MANDATE-MOVE');
    // A non-participant refuses on every gated mode.
    await refused(root, ['validate', '--actor', '@agent reviewer'], 'IA-RUNTIME-MANDATE-ACTOR');
    await refused(root, ['next', '--actor', 'nobody'], 'IA-RUNTIME-MANDATE-ACTOR');
    // A refusal raised after the profile names a gated command with the actor this invocation named.
    const seat = await refused(
      root,
      ['next', '--seat', milestone('m9'), '--actor', participant],
      'IA-RUNTIME-NEXT-SEAT',
    );
    expect(nextArgv(seat['next'] as string)).toContain('--actor');
  });
  it('lets an ambiguous workspace name its steward with --actor and the preview digest, then run without one', async () => {
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification]', 'scope [@workspace demo]'])}`,
      );
    });
    const form = ['--set', `@workspace demo`, 'composition.steward=@agent demo'];
    // The preview refuses the open choice and names itself with the first participant allowed to run it.
    const ambiguous = await refused(root, ['preview', ...form], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(ambiguous['next'] as string)).toEqual([
      'preview',
      '@workspace demo',
      'composition.steward=@agent demo',
      '--set',
      '--actor',
      participant,
      '--root',
      root,
    ]);
    const digest = await previewed(root, [...form, '--actor', participant]);
    // The author without --actor refuses the same way, and its next command is the author naming demo, which writes.
    const author = await refused(root, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(author['next'] as string)).toContain('--actor');
    expect(readFileSync(resolve(root, '.ia/src/workspace.ia'), 'utf8')).toContain('    steward @agent demo\n');
    // The workspace names its steward now, so commands resolve the default actor again.
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    expect(body(await ia(root, ['preview', 'task']))).toMatchObject({ profile: { actor: participant, by: 'steward' } });
  });
  it('refuses every gated mode, rather than failing, under an admitted mandate whose authority the resolver cannot read', async () => {
    // A child under `authority.moves`: admission admits the record, the resolver refuses the field.
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/unreadable.ia'),
        `#! ia 1.0\n${MANDATE('unreadable-mandate', ['participant @agent demo', 'moves [Observation]', '  note x', 'scope [@workspace demo]'])}`,
      ),
    );
    for (const argv of [['read', participant], ['validate'], ['next'], ['capture'], ['project', 'claude']]) {
      const refusal = await refused(root, argv, 'IA-RUNTIME-REQUEST-INVALID');
      expect(refusal['where'], argv.join(' ')).toEqual({
        path: '.ia/src/unreadable.ia',
        line: 3,
        identity: mandate('unreadable-mandate'),
      });
      // Its governance position runs, as the seat is admitted, and shows the authority the profile cannot read.
      expect(nextArgv(refusal['next'] as string), argv.join(' ')).toEqual([
        'position',
        '--seat',
        mandate('unreadable-mandate'),
        '--shape',
        'governance',
        '--root',
        root,
      ]);
    }
  });
});

describe('a @mandate that fails admission (lane D, operator ruling 2026-10-12)', () => {
  /** The probe: demo-mandate states an unknown move and excludes task, so admission refuses it. */
  const probe = (at: string): void => {
    moves(at, 'Bogus');
    rewrite(at, '.ia/src/workspace.ia', (text) =>
      text.replace('moves [Bogus]', 'moves [Bogus]\n    excluded-words [task]'),
    );
  };
  /** A refusal of a mandate that failed admission: located at it, naming the admission report, which runs and shows it. */
  async function failedClosed(
    root: string,
    argv: readonly string[],
    where: { readonly path: string; readonly line: number; readonly identity: string },
    code: string,
  ): Promise<Record<string, unknown>> {
    const refusal = await refused(root, argv, 'IA-RUNTIME-REQUEST-INVALID');
    const label = argv.join(' ');
    expect(refusal['exit'], label).toBe(1);
    expect(refusal['where'], label).toEqual(where);
    expect(refusal['message'], label).toContain(
      `${where.identity} (${where.path}:${where.line}) failed admission: ${code}`,
    );
    expect(refusal['message'], label).toContain('correct it by hand');
    expect(refusal['message'], label).toContain('ia preview and ia author cannot target a record admission refused');
    expect(nextArgv(refusal['next'] as string), label).toEqual(['report', '--root', root]);
    return refusal;
  }
  it('refuses every gated mode at the refused mandate, naming an admission report that runs and shows it', async () => {
    const root = workspace(probe);
    const fake = 'a'.repeat(64),
      where = { path: '.ia/src/workspace.ia', line: 19, identity: mandate('demo-mandate') };
    for (const argv of [
      ['read', participant],
      ['next'],
      ['validate'],
      ['preview', 'task'],
      ['author', '--set', '@milestone m1', 'work.owner=x', '--digest', fake],
      ['capture'],
      ['capture', '--preview'],
      ['compile'],
      ['project', 'claude'],
      ['host', 'claude', '--apply', '--yes'],
    ])
      await failedClosed(root, argv, where, 'IA-COMP-FIELD-VALUE');
    // The report the refusals name runs for the same actor in the same state, writes nothing, and shows the finding.
    const report = await run(['report', '--root', root], { env: HOMES });
    expect(report.exitCode).toBe(1);
    expect(report.stderr).toBe('');
    const shown = JSON.parse(report.stdout) as { ok: boolean; result: { findings: Record<string, unknown>[] } };
    expect(shown.ok).toBe(true);
    expect(shown.result.findings).toContainEqual(
      expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', path: '.ia/src/workspace.ia', line: 27 }),
    );
    // Position is never gated, and a removal still restores editing.
    expect((await ia(root, ['position'])).exitCode).toBe(0);
    expect((await ia(root, ['position', '--seat', demo, '--shape', 'governance'])).exitCode).toBe(0);
    const removal = await ia(root, ['host', 'claude', '--remove', '--apply', '--yes']);
    expect(removal.exitCode, removal.stdout).toBe(0);
  });
  it('restores editing with ia host claude --remove --apply while a refused mandate is present', async () => {
    const root = workspace();
    const applied = await ia(root, ['host', 'claude', '--apply', '--yes']);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-hooks-workspace.json'))).toBe(true);
    probe(root);
    await failedClosed(
      root,
      ['host', 'claude', '--apply', '--yes'],
      { path: '.ia/src/workspace.ia', line: 19, identity: mandate('demo-mandate') },
      'IA-COMP-FIELD-VALUE',
    );
    const removed = await ia(root, ['host', 'claude', '--remove', '--apply', '--yes']);
    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(existsSync(resolve(root, '.ia/distributions/hosts/claude-hooks-workspace.json'))).toBe(false);
  });
  it('refuses a stated empty move list through admission, with the same shape', async () => {
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/empty.ia'),
        `#! ia 1.0\n${MANDATE('empty-mandate', ['participant @agent demo', 'moves []', 'scope [@workspace demo]'])}`,
      ),
    );
    for (const argv of [
      ['read', participant],
      ['validate'],
      ['next'],
      ['preview', 'task'],
      ['capture'],
      ['project', 'claude'],
    ]) {
      const refusal = await failedClosed(
        root,
        argv,
        { path: '.ia/src/empty.ia', line: 3, identity: mandate('empty-mandate') },
        'IA-COMP-FIELD-VALUE',
      );
      expect(refusal['message'], argv.join(' ')).toContain(
        "'authority.moves' must name at least one kernel move when stated",
      );
    }
    expect((await ia(root, ['position'])).exitCode).toBe(0);
  });
  it('fails closed for a mandate in a file refused whole, and names it with no identity when only its text shows it', async () => {
    const root = workspace((at) =>
      writeFileSync(resolve(at, '.ia/src/header.ia'), '#! ia 1.0\n\n@mandate Bad_Name!\n  meaning\n    says "x"\n'),
    );
    const refusal = await refused(root, ['preview', 'task'], 'IA-RUNTIME-REQUEST-INVALID');
    expect(refusal['where']).toEqual({ path: '.ia/src/header.ia', line: 3, identity: null });
    expect(refusal['message']).toContain(
      'the @mandate at .ia/src/header.ia:3 failed admission: IA-LANG-HEADER-MALFORMED',
    );
    expect(nextArgv(refusal['next'] as string)).toEqual(['report', '--root', root]);
    // A parse error in a file that declares no mandate fails nothing closed: the preview runs.
    const plain = workspace((at) =>
      writeFileSync(resolve(at, '.ia/src/plain.ia'), '#! ia 1.0\n\n@agent plain\n  meaning\n    says "x\n'),
    );
    const previewed = await ia(plain, ['preview', 'task']);
    expect(previewed.exitCode, previewed.stdout).toBe(0);
  });
});
