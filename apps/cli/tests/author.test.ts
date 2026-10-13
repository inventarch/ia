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
import { open, readInputs } from '@inventarch/db';
import { digestValue } from '@inventarch/runtime/authoring';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, cli, commandsIn, nextArgv, repository, run, scratch } from './workspace-fixture.js';

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
  it('does not treat its attribution comment as a mandate when an unrelated work file later fails parsing', async () => {
    const root = workspace();
    await authored(root, ['--set', '@plan p1', 'work.title=Retitled']);
    const written = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
    expect(written).toMatch(/# authored-by @agent demo under @mandate demo-mandate at [0-9a-f]{64}\n@plan p1/);
    rewrite(root, '.ia/src/work.ia', (text) => text.replace('says "The demo plan."', 'says "unfinished'));
    expect((await unchanged(root, ['read', participant])).exitCode).toBe(0);
    const validated = await unchanged(root, ['validate']);
    expect(validated.exitCode).toBe(1);
    expect(validated.stdout).toContain('IA-LANG-STRING-UNTERMINATED');
    expect(validated.stdout).not.toContain('IA-RUNTIME-REQUEST-INVALID');
    // The comment does not exempt an unidentified declaration in the same rejected file.
    rewrite(root, '.ia/src/work.ia', (text) => `${text}\n@ mandate hidden\n`);
    await refused(root, ['read', participant], 'IA-RUNTIME-REQUEST-INVALID');
    expect(readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8')).toContain('# authored-by ');
  });
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
  it('previews a starter system but reserves its authority-bearing records for an owner source edit', async () => {
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
    const result = await unchanged(root, ['preview', 'system', 'notes']);
    expect(result.exitCode, result.stdout).toBe(0);
    const view = body(result);
    expect(view).toMatchObject({
      exists: false,
      path: '.ia/src/systems/notes/system.ia',
      identity: 'floor/definition/system/notes',
    });
    await refused(root, ['author', 'system', 'notes'], 'IA-CLI-EDIT-AUTHORITY');
  });
});

describe('administrative authority is not writable through ia author', () => {
  it('blocks indirect escalation without authored exclusions and does not accept another actor as approval', async () => {
    const root = workspace((at) => {
      moves(at, 'Observation, Verification, Synthesis');
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'scope [@workspace demo]'])}`,
      );
    });
    for (const form of [
      ['--set', '@workspace demo', 'composition.sources=[".ia/src/work.ia @authored"]'],
      ['--set', '@workspace demo', 'composition.steward=@agent ops'],
      ['--set', '@workspace demo', 'composition.systems=[@system work-system]'],
      ['agent', 'free', 'meaning.says=Unbound.', 'meaning.answers=Who?', 'governance.applies=[]'],
      ['mandate', 'open', 'meaning.says=Open.', 'meaning.answers=Who?', 'authority.moves=[Execution]'],
      ['--set', '@mandate ops-mandate', 'authority.scope=[]'],
      ['--set', '@mandate ops-mandate', 'authority.covers=["**"]'],
      ['--set', '@mandate ops-mandate', 'authority.excluded-words=[]'],
      ['--set', '@agent ops', 'meaning.says=Changed.'],
      ['--relate', '@workspace demo', 'cites', '@agent ops'],
      ['system', 'free-system'],
    ]) {
      const refusedEdit = await refused(root, ['author', ...form, '--digest', EMPTY], 'IA-CLI-EDIT-AUTHORITY');
      expect(refusedEdit['next']).toContain('An owner must make this administrative change in source');
      expect(refusedEdit['next']).toContain('naming an actor does not authorize it');
    }
    await refused(
      root,
      [
        'author',
        '--set',
        '@workspace demo',
        'composition.steward=@agent ops',
        '--actor',
        '@agent ops',
        '--digest',
        EMPTY,
      ],
      'IA-CLI-EDIT-AUTHORITY',
    );
    // Normal work records remain writable under the same restricted actor.
    await authored(root, ['--set', '@milestone m1', 'work.owner=Tom']);
  });
  it('freezes host actor mappings and guard declarations, including changes made without any mandate', async () => {
    const root = workspace((at) => {
      rmSync(resolve(at, '.ia/src/hooks.ia'));
      rewrite(at, '.ia/src/workspace.ia', (text) => text.slice(0, text.indexOf('@mandate demo-mandate')));
      writeFileSync(
        resolve(at, '.ia/src/protection.ia'),
        `#! ia 1.0\n\n@hook protect\n  meaning\n    says "Protect records."\n    answers "What is selected?"\n  hook\n    event PreToolUse\n    tools [Write, Edit, MultiEdit]\n    paths [".ia/src/**"]\n    message "Review the mandate."\n\n@agent-profile worker\n  meaning\n    says "Worker."\n    answers "Who works?"\n  composition\n    agent @agent demo\n    capabilities []\n  execution\n    role author\n    outcomes test-v1\n    mandate-contract test-v1\n`,
      );
    });
    for (const form of [
      ['--set', '@hook protect', 'hook.paths=["docs/**"]'],
      ['--set', '@hook protect', 'hook.tools=[Write]'],
      ['--set', '@agent-profile worker', 'composition.agent=@agent demo'],
      ['--set', '@workspace demo', 'composition.sources=[]'],
    ])
      await refused(root, ['author', ...form, '--digest', EMPTY], 'IA-CLI-EDIT-AUTHORITY');
  });
});

describe('doctor makes source protection declarations visible', () => {
  const hook = (paths: string, tools = '[Write, Edit, MultiEdit]', event = 'PreToolUse') =>
    `#! ia 1.0\n\n@hook protect\n  meaning\n    says "Protect records."\n    answers "What is selected?"\n  hook\n    event ${event}\n    tools ${tools}\n    paths ["${paths}"]\n    message "Review the mandate."\n`;
  async function protection(root: string) {
    const result = await unchanged(root, ['doctor']);
    return (body(result)['checks'] as { id: string; status: string; detail: string; remedy: string | null }[]).find(
      (check) => check.id === 'source-protection',
    )!;
  }
  it('warns without a selecting hook and does not treat narrow or unsupported hooks as protection', async () => {
    const root = workspace((at) => moves(at, 'Observation, Verification, Synthesis'));
    expect(await protection(root)).toMatchObject({ status: 'warn', remedy: expect.stringContaining('--root') });
    for (const declaration of [
      hook('docs/**'),
      hook('.ia/src/*'),
      hook('.ia/src/**', '[Write]'),
      hook('.ia/src/**', '[Write, Edit, MultiEdit]', 'PostToolUse'),
    ]) {
      writeFileSync(resolve(root, '.ia/src/protect.ia'), declaration);
      expect(await protection(root)).toMatchObject({ status: 'warn' });
    }
    writeFileSync(resolve(root, '.ia/src/protect.ia'), hook('.ia/src/**'));
    expect(await protection(root)).toMatchObject({
      status: 'info',
      detail: expect.stringContaining('not host registration or enforcement'),
    });
  });
  it('distinguishes unrestricted, excluded-word, execution-limit and invalid mandate states', async () => {
    const root = workspace((at) => rmSync(resolve(at, '.ia/src/hooks.ia')));
    expect(await protection(root)).toMatchObject({
      status: 'info',
      detail: expect.stringContaining('No authored mandate'),
    });
    const path = resolve(root, '.ia/src/workspace.ia'),
      original = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      original.replace('    scope [@workspace demo]', '    scope [@workspace demo]\n    excluded-words [task]'),
    );
    expect(await protection(root)).toMatchObject({ status: 'warn' });
    writeFileSync(path, `${original}\n  execution\n    limit-operations 0\n`);
    expect(await protection(root)).toMatchObject({ status: 'warn' });
    writeFileSync(
      path,
      original.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', 'moves [Bogus]'),
    );
    expect(await protection(root)).toMatchObject({ status: 'unknown', detail: expect.stringContaining('IA-RUNTIME-') });
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
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    const written = await ia(root, ['author', ...form, '--digest', digest, '--actor', '@agent demo']);
    expect(written.exitCode, written.stdout).toBe(0);
    const next = nextArgv(body(written).next!),
      at = next.indexOf('--actor');
    expect(next[0]).toBe('validate');
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
  it('retains the binding-mandate guard and refuses authoring another participant mandate too', async () => {
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
    // Another participant's mandate can be previewed but must be changed administratively in source.
    const other = draft('ops-mandate', [
      'authority.participant=@agent ops',
      'authority.moves=[Observation]',
      'authority.scope=[@workspace demo]',
    ]);
    const otherDigest = await previewed(root, other);
    await refused(root, ['author', ...other, '--digest', otherDigest], 'IA-CLI-EDIT-AUTHORITY');
    writeFileSync(
      resolve(root, '.ia/src/ops-mandate.ia'),
      `#! ia 1.0\n${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation]', 'scope [@workspace demo]'])}`,
    );
    await refused(
      root,
      ['author', '--set', '@mandate ops-mandate', 'authority.moves=[Observation, Verification]', '--digest', EMPTY],
      'IA-CLI-EDIT-AUTHORITY',
    );
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
  it('previews an ambiguous workspace steward choice but requires an administrative source edit to apply it', async () => {
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
    // No actor choice can authorize an administrative write, so the remedy must remain a read.
    const author = await refused(root, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(author['next'] as string)[0]).toBe('position');
    await refused(root, ['author', ...form, '--digest', digest, '--actor', participant], 'IA-CLI-EDIT-AUTHORITY');
    rewrite(root, '.ia/src/workspace.ia', (text) =>
      text.replace('  composition\n', '  composition\n    steward @agent demo\n'),
    );
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
  it('fails closed when a record an admitted mandate depends on fails admission: the D8 probes (D9)', async () => {
    const OPS = `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification, Synthesis, Delegation, Execution]', 'scope [@workspace demo]'])}`;
    /** An undeclared section after `anchor` in workspace.ia, so admission refuses the record holding it. */
    const broken = (at: string, anchor: string): void =>
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace(anchor, `${anchor}  bogus\n    note x\n`));
    // Before: demo-mandate observes only, so the steward's preview and validate refuse its move.
    const intact = workspace((at) => {
      moves(at, 'Observation');
      writeFileSync(resolve(at, '.ia/src/ops.ia'), OPS);
    });
    expect(body(await ia(intact, ['preview', 'task']))).toMatchObject({ code: 'IA-RUNTIME-MANDATE-MOVE' });
    // The steward participant's @agent fails admission: the default actor would switch to ops, which may make every move.
    const agent = workspace((at) => {
      moves(at, 'Observation');
      writeFileSync(resolve(at, '.ia/src/ops.ia'), OPS);
      broken(at, '    applies []\n');
    });
    for (const argv of [['preview', 'task'], ['validate']]) {
      const refusal = await failedClosed(
        agent,
        argv,
        { path: '.ia/src/workspace.ia', line: 12, identity: participant },
        'IA-COMP-SECTION-UNKNOWN',
      );
      expect(refusal['message'], argv.join(' ')).toContain('depends on @agent demo through');
    }
    // The workspace demo-mandate is scoped to fails admission: the mandate would govern nowhere.
    const scoped = workspace((at) => {
      moves(at, 'Observation');
      broken(at, '    steward @agent demo\n');
    });
    for (const argv of [['preview', 'task'], ['validate']]) {
      const refusal = await failedClosed(
        scoped,
        argv,
        { path: '.ia/src/workspace.ia', line: 3, identity: demo },
        'IA-COMP-SECTION-UNKNOWN',
      );
      expect(refusal['message'], argv.join(' ')).toContain(
        `${mandate('demo-mandate')} depends on @workspace demo through authority.scope`,
      );
    }
    expect((await ia(scoped, ['position'])).exitCode).toBe(0);
  });
  it('runs beside an unrelated refused @agent and a never-authored participant reference (D9)', async () => {
    const root = workspace((at) => {
      writeFileSync(
        resolve(at, '.ia/src/stray.ia'),
        `#! ia 1.0\n${AGENT('stray').replace('    applies []\n', '    applies []\n  bogus\n    note x\n')}`,
      );
      writeFileSync(
        resolve(at, '.ia/src/ghost.ia'),
        `#! ia 1.0\n${MANDATE('ghost-mandate', ['participant @agent ghost', 'moves [Observation]', 'covers ["ghost/"]'])}`,
      );
    });
    const db = open(root, { cache: false });
    try {
      expect(db.refused.map((record) => record.identity)).toContain('agent-system/binding/agent/stray');
    } finally {
      db.close();
    }
    const previewed = await ia(root, ['preview', 'task']);
    expect(previewed.exitCode, previewed.stdout).toBe(0);
    expect(body(previewed)).toMatchObject({ profile: { actor: participant, by: 'steward' } });
    // ia validate runs too and reports the stray agent's admission error, as before.
    const validated = await ia(root, ['validate']);
    expect(validated.exitCode).toBe(1);
    expect(body(validated)).toMatchObject({ status: 'refused' });
  });
  it('names an admission report that runs from the cwd alone, printing no character of the root (review D-R1, D-N2, D-N6)', async () => {
    for (const name of ['amp&er', 'par(en', 'dol$lar', 'back`tick', 'sp ace', `caf${String.fromCharCode(0xe9)}`]) {
      // Staged under an ASCII name and renamed: Node's cpSync spells a non-ASCII destination wrongly on win32.
      const parent = scratch('author-roots'),
        staging = resolve(parent, 'staging'),
        root = resolve(parent, name);
      cpSync(base, staging, { recursive: true });
      probe(staging);
      mkdirSync(resolve(staging, 'docs'), { recursive: true });
      renameSync(staging, root);
      // Without --root the workspace is found from the cwd, and the report is named relative to it, `.` or `..`.
      for (const [cwd, relative] of [
        [root, '.'],
        [resolve(root, 'docs'), '..'],
      ] as const)
        for (const argv of [['preview', 'task'], ['validate']]) {
          const label = `${name} ${argv[0]} from ${relative}`;
          const refusal = body(await run([...argv, '--json'], { cwd, env: HOMES }));
          expect(refusal, label).toMatchObject({
            code: 'IA-RUNTIME-REQUEST-INVALID',
            where: { path: '.ia/src/workspace.ia', line: 19, identity: mandate('demo-mandate') },
          });
          expect(commandsIn(refusal.next!), label).toEqual([`ia report --root ${relative}`]);
          const followed = await run(nextArgv(refusal.next!), { cwd, env: HOMES });
          expect(followed.exitCode, label).toBe(1);
          expect(followed.stderr, label).toBe('');
          expect(
            (JSON.parse(followed.stdout) as { result: { findings: Record<string, unknown>[] } }).result.findings,
            label,
          ).toContainEqual(
            expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', path: '.ia/src/workspace.ia', line: 27 }),
          );
        }
      // With --root, the invocation's own value is repeated as every next command repeats it (review C2-R8), and runs.
      const given = body(await run(['validate', '--root', root, '--json'], { env: HOMES }));
      expect(nextArgv(given.next!), name).toEqual(['report', '--root', root]);
      expect((await run(nextArgv(given.next!), { env: HOMES })).exitCode, name).toBe(1);
    }
    // Review D2-R1: a cwd reached through a link inside the workspace keeps the link's spelling, and the CLI and db read
    // a relative --root lexically against it, so the next names a root that resolves there to the workspace: a junction
    // (a directory symlink off win32) to a deeper folder, and a pnpm-style one under node_modules; and (review D2 recheck
    // F5) one above the root, a link to the workspace itself that the cwd is spelled through.
    const linked = workspace(probe);
    mkdirSync(resolve(linked, 'a/b/c'), { recursive: true });
    mkdirSync(resolve(linked, 'packages/pkg'), { recursive: true });
    mkdirSync(resolve(linked, 'node_modules'), { recursive: true });
    mkdirSync(resolve(linked, 'docs/deep'), { recursive: true });
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    let links = true;
    try {
      symlinkSync(resolve(linked, 'a/b/c'), resolve(linked, 'j'), kind);
      symlinkSync(resolve(linked, 'packages/pkg'), resolve(linked, 'node_modules/pkg'), kind);
      symlinkSync(linked, resolve(linked, '../jroot'), kind);
    } catch {
      links = false;
    }
    if (links)
      for (const [via, relative] of [
        ['j', '..'],
        ['node_modules/pkg', '../..'],
        ['../jroot/docs/deep', '../..'],
      ] as const)
        for (const argv of [['preview', 'task'], ['validate']]) {
          const cwd = resolve(linked, via),
            label = `${argv[0]} from ${via}`;
          const refusal = body(await run([...argv, '--json'], { cwd, env: HOMES }));
          expect(refusal, label).toMatchObject({ code: 'IA-RUNTIME-REQUEST-INVALID' });
          expect(commandsIn(refusal.next!), label).toEqual([`ia report --root ${relative}`]);
          const followed = await run(nextArgv(refusal.next!), { cwd, env: HOMES });
          expect(followed.exitCode, label).toBe(1);
          expect(
            (JSON.parse(followed.stdout) as { result: { findings: Record<string, unknown>[] } }).result.findings,
            label,
          ).toContainEqual(
            expect.objectContaining({ code: 'IA-COMP-FIELD-VALUE', path: '.ia/src/workspace.ia', line: 27 }),
          );
        }
  });
  it('names the admission report and a hand edit for a refused authored mandate shadowing an admitted installed one (review D-R2)', async () => {
    // The installed sample-mandate is admitted at band 90; an authored override of it fails admission.
    const root = resolve(scratch('author-shadow'), 'shadow'),
      vendor = 'vendor/foundation';
    cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, vendor, '.ia/src'), { recursive: true });
    const pinned = readInputs(resolve(root, vendor), { adopted: [] })
      .sources.filter((source) => !source.path.startsWith('.ia/src/floor/'))
      .map(({ path, text }) => ({ path, text }));
    mkdirSync(resolve(root, '.ia/src'), { recursive: true });
    writeFileSync(
      resolve(root, '.ia/workspace.json'),
      JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision: digestValue(pinned) }] }),
    );
    writeFileSync(
      resolve(root, '.ia/src/workspace.ia'),
      readFileSync(resolve(repository, 'packages/runtime/tests/fixtures/packet/workspace.ia'), 'utf8'),
    );
    writeFileSync(
      resolve(root, '.ia/src/override.ia'),
      readFileSync(
        resolve(repository, 'examples/conformance/native/systems/agent-system/records/sample-mandate.ia'),
        'utf8',
      ).replace('moves [Observation, Verification]', 'moves [Bogus]'),
    );
    const db = open(root, { cache: false });
    try {
      expect(db.get(mandate('sample-mandate'))?.band).toBe(90);
    } finally {
      db.close();
    }
    for (const argv of [['validate'], ['preview', 'task']]) {
      const refusal = await refused(root, argv, 'IA-RUNTIME-REQUEST-INVALID');
      expect(refusal['where'], argv[0]).toEqual({
        path: '.ia/src/override.ia',
        line: 3,
        identity: mandate('sample-mandate'),
      });
      expect(refusal['message'], argv[0]).toContain('correct it by hand in .ia/src/override.ia');
      expect(nextArgv(refusal['next'] as string), argv[0]).toEqual(['report', '--root', root]);
      const report = await run(nextArgv(refusal['next'] as string), { env: HOMES });
      expect(report.stdout, argv[0]).toContain('override.ia');
      expect(report.stdout, argv[0]).toContain('Bogus');
    }
  });
});
