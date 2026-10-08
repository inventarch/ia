import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CAPTURE_FORMAT, writeCapture } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { Door, MACHINE_PROTOCOL, NEXT_CODES, RUNTIME_CODES, deliveryView } from '../src/index.js';
import type {
  DeliveryResult,
  DeliveryTask,
  DeliveryView,
  DoorOptions,
  DoorResponse,
  NextRefusal,
} from '../src/index.js';
import { database, lawId, put, workspace } from './workspace.js';

/**
 * The delivery fixtures (packages/runtime/tests/fixtures/delivery) are laid over the conformance corpus at `.ia/src`:
 * - base: one @workspace with composition.sources, the @plan release, the milestones foundation and build (build
 *   requires foundation), five tasks, the made decision guide-format and the open decision release-channel, the current
 *   @spec module-contract, and three observations: schema-checked (success at schema's current digest, named only by
 *   schema's work.exit-evidence), guide-checked (success at a digest guide does not have) and examples-checked
 *   (success at examples' current digest, by the agent examples' work.owner-agent names);
 * - cycle: the plan loop, whose tasks alpha, beta and gamma require each other in a cycle;
 * - plans: two authored plans, rollout (whose task deploy requires a task of another milestone) and research.
 */
const FIXTURES = resolve(import.meta.dirname, 'fixtures/delivery');
/** A fixture identity: a work-system definition, but a @spec is a contract and an @observation learning-system's. */
const PREFIXES: Readonly<Record<string, string>> = {
  spec: 'work-system/contract',
  observation: 'learning-system/definition',
};
const id = (word: string, name: string): string => `${PREFIXES[word] ?? 'work-system/definition'}/${word}/${name}`;
const task = (name: string): string => id('task', name),
  milestone = (name: string): string => id('milestone', name);
const OWNER = 'agent-system/binding/agent/fixture-owner';
const STEWARD = 'agent-system/binding/agent/work-steward';

function delivery(...overlays: string[]): string {
  const root = workspace();
  for (const overlay of overlays) cpSync(resolve(FIXTURES, overlay), resolve(root, '.ia/src'), { recursive: true });
  return root;
}
function read(root: string, seat?: string): { readonly db: Handle; readonly result: DeliveryResult } {
  const db = database(root);
  return { db, result: deliveryView(db, db.resolveScope().token, seat) };
}
function view(root: string, seat?: string): DeliveryView {
  const { result } = read(root, seat);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.view;
}
function refusal(root: string, seat?: string): NextRefusal {
  const { result } = read(root, seat);
  if (result.ok) throw new Error('Expected a refusal');
  return result;
}
const byIdentity = (delivered: DeliveryView, name: string): DeliveryTask =>
  delivered.tasks.find((t) => t.identity === task(name))!;
const state = (delivered: DeliveryView, name: string, dimension: string) =>
  byIdentity(delivered, name).states.find((line) => line.dimension === dimension)!;
/** An observation of `subject` with `verdict` at `revision`, as the fixtures spell one; a null evaluator is not recorded. */
function observation(
  name: string,
  subject: string,
  revision: string,
  evaluator: string | null = 'ia-compliance@1.1.0',
  verdict = 'success',
): string {
  return [
    `@observation ${name}`,
    '  meaning',
    `    says "A ${verdict} observed on ${subject}."`,
    '    answers "Did it work?"',
    '  evidence',
    '    origin check',
    `    actor "${evaluator ?? 'an unnamed check'}"`,
    '    observed-at "2026-10-08T00:00:00Z"',
    '    captured-at "2026-10-08T00:00:00Z"',
    '    workspace "delivery"',
    `    locator "${subject}"`,
    `    revision "${revision}"`,
    `    bundle ".ia/learning/observations/${name}.json"`,
    `    digest "${'0'.repeat(64)}"`,
    '    availability unavailable',
    `    subject ${subject}`,
    `    subject-revision "${revision}"`,
    ...(evaluator === null ? [] : [`    evaluator "${evaluator}"`]),
    '    move Verification',
    `    verdict ${verdict}`,
    '  interpretation',
    '    applies "The subject at the named revision only."',
    '    limits "A test record."',
    '    reason "Exit evidence for the delivery view."',
    '    basis inference',
    '  retention',
    '    status retained',
    '',
  ].join('\n');
}
/** Successes at the current digest of each named task, written beside the fixture. */
function evidence(root: string, names: readonly string[]): void {
  const db = database(root),
    scope = db.resolveScope().token;
  put(
    root,
    '.ia/src/more-evidence.ia',
    [
      '#! ia 1.0',
      '',
      ...names.map((name) =>
        observation(`${name}-done`, `@task ${name}`, db.get(task(name), { within: scope })!.digest),
      ),
    ].join('\n'),
  );
}
/** Every file under `root`, by path, hashed with its bytes. */
function tree(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), `${path}/`);
      else
        hash
          .update(`${path}\0`)
          .update(readFileSync(resolve(directory, entry.name)))
          .update('\0');
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

it('registers each delivery refusal in RUNTIME_CODES', () => {
  expect(NEXT_CODES).toEqual([
    'IA-RUNTIME-NEXT-SEAT',
    'IA-RUNTIME-NEXT-NO-PLAN',
    'IA-RUNTIME-NEXT-AMBIGUOUS',
    'IA-RUNTIME-NEXT-CYCLE',
  ]);
  for (const code of NEXT_CODES) expect(RUNTIME_CODES).toContain(code);
});

it('orders the plan in one sort, prerequisites first and ties by milestone then task, from any seat in it', () => {
  const root = delivery('base'),
    delivered = view(root);
  expect(delivered.format).toBe('ia.delivery-view.v1');
  expect(delivered.plan).toBe(id('plan', 'release'));
  // guide < schema by identity; examples requires schema; build requires foundation, though build sorts first.
  expect(delivered.tasks.map((t) => t.identity)).toEqual(
    ['guide', 'schema', 'examples', 'package', 'release-notes'].map(task),
  );
  expect(delivered.milestones.map((m) => [m.identity, m.tasks])).toEqual([
    [milestone('foundation'), ['guide', 'schema', 'examples'].map(task)],
    [milestone('build'), ['package', 'release-notes'].map(task)],
  ]);
  // The cross-milestone requirement (release-notes requires guide) is one of the order's prerequisites.
  expect(delivered.tasks.findIndex((t) => t.identity === task('guide'))).toBeLessThan(
    delivered.tasks.findIndex((t) => t.identity === task('release-notes')),
  );
  const { db } = read(root);
  expect(delivered.revision).toBe(db.revision);
  for (const seat of [id('plan', 'release'), milestone('build'), task('examples')])
    expect(JSON.stringify(view(root, seat)), seat).toBe(JSON.stringify(delivered));
});

it('orders a task requirement across milestones that no milestone states, which per-milestone sorts cannot', () => {
  const delivered = view(delivery('plans'), id('plan', 'rollout'));
  // Ties go by milestone first: launch's announce precedes provision's accounts. A per-milestone sort would put deploy
  // (launch) before servers (provision), which it requires.
  expect(delivered.tasks.map((t) => t.identity)).toEqual(['announce', 'accounts', 'servers', 'deploy'].map(task));
  expect(byIdentity(delivered, 'deploy').line).toBe(`blocked (task ${task('servers')}: no exit evidence)`);
  expect(delivered.next).toBe(`ia position --seat ${task('announce')} --shape sequence`);
});

it('ranks a task a satisfied milestone releases against tasks already ready, as the task-level sort does', () => {
  const root = workspace();
  const work = (word: string, name: string, fields: readonly string[], requires: readonly string[] = []): string =>
    [
      `@${word} ${name}`,
      '  meaning',
      `    says "The ${word} ${name}."`,
      '  work',
      `    title "${name}"`,
      '    status open',
      ...fields.map((field) => `    ${field}`),
      ...(requires.length === 0 ? [] : ['  relationships', ...requires.map((target) => `    requires ${target}`)]),
      '',
    ].join('\n');
  put(
    root,
    '.ia/src/order.ia',
    [
      '#! ia 1.0',
      '',
      work('plan', 'p', []),
      work('milestone', 'a', ['plan @plan p', 'exit "a."'], ['@milestone b']),
      work('milestone', 'b', ['plan @plan p', 'exit "b."']),
      work('milestone', 'd', ['plan @plan p', 'exit "d."']),
      work('task', 'ta', ['milestone @milestone a']),
      work('task', 'tb', ['milestone @milestone b'], ['@task td1']),
      work('task', 'td1', ['milestone @milestone d']),
      work('task', 'td2', ['milestone @milestone d']),
    ].join('\n'),
  );
  // Once tb is done, b is satisfied and releases ta, which ranks before td2 by milestone (a < d).
  expect(view(root).tasks.map((t) => t.identity)).toEqual(['td1', 'tb', 'ta', 'td2'].map(task));
});

it('gives each verdict with its basis lines, and prints the self-declared status apart from them', () => {
  const delivered = view(delivery('base'));
  const guide = byIdentity(delivered, 'guide');
  expect(guide).toMatchObject({
    verdict: 'unblocked',
    line: 'no declared blocker',
    status: 'status open (self-declared)',
    prerequisites: [
      {
        target: id('decision', 'guide-format'),
        word: 'decision',
        satisfied: true,
        basis: `decision ${id('decision', 'guide-format')}: choice made`,
      },
    ],
  });
  expect(guide.evidence).toBeUndefined();
  // schema's observation names no subject; schema names it in work.exit-evidence, at schema's current digest.
  expect(byIdentity(delivered, 'schema')).toMatchObject({
    verdict: 'evidenced',
    status: 'status closed (self-declared)',
    line: `exit evidence recorded (${id('observation', 'schema-checked')}, evaluator ia-compliance@1.1.0)`,
    evidence: {
      observation: id('observation', 'schema-checked'),
      evaluator: 'ia-compliance@1.1.0',
      attribution: 'other',
    },
  });
  expect(byIdentity(delivered, 'examples')).toMatchObject({
    verdict: 'evidenced',
    line: `exit evidence recorded (${id('observation', 'examples-checked')}, evaluator ${OWNER}, self-attributed)`,
    evidence: { evaluator: OWNER, attribution: 'self' },
    prerequisites: [{ target: task('schema'), satisfied: true }],
  });
  const notes = byIdentity(delivered, 'release-notes');
  expect(notes.verdict).toBe('blocked');
  expect(notes.prerequisites.map((p) => [p.target, p.via, p.satisfied])).toEqual([
    [id('decision', 'release-channel'), undefined, false],
    [task('guide'), undefined, false],
    [milestone('foundation'), milestone('build'), false],
  ]);
  expect(notes.line).toBe(
    `blocked (decision ${id('decision', 'release-channel')}: no choice; task ${task('guide')}: no exit evidence; ` +
      `milestone ${milestone('foundation')}: exit evidence missing for 1 of 3 tasks (via ${milestone('build')}))`,
  );
});

it('counts only a success at the current digest as exit evidence, never a refusal or an inconclusive verdict', () => {
  const root = delivery('base'),
    { db } = read(root),
    digest = (name: string): string => db.get(task(name))!.digest;
  put(
    root,
    '.ia/src/verdicts.ia',
    [
      '#! ia 1.0',
      '',
      observation('guide-refused', '@task guide', digest('guide'), undefined, 'refusal'),
      observation('package-inconclusive', '@task package', digest('package'), undefined, 'inconclusive'),
    ].join('\n'),
  );
  const delivered = view(root);
  expect(byIdentity(delivered, 'guide')).toMatchObject({ verdict: 'unblocked', line: 'no declared blocker' });
  expect(byIdentity(delivered, 'guide').evidence).toBeUndefined();
  expect(state(delivered, 'guide', 'worked')).toEqual({
    dimension: 'worked',
    value: 'observed refusal',
    basis: `${id('observation', 'guide-refused')}: refusal at the current digest`,
  });
  expect(byIdentity(delivered, 'package').verdict).toBe('blocked');
  expect(state(delivered, 'package', 'worked')).toEqual({
    dimension: 'worked',
    value: 'unknown',
    basis: `${id('observation', 'package-inconclusive')}: verdict inconclusive at the current digest`,
  });
  // The task that requires guide still waits on it, and guide is still next.
  expect(byIdentity(delivered, 'release-notes').line).toContain(`task ${task('guide')}: no exit evidence`);
  expect(delivered.next).toBe(`ia position --seat ${task('guide')} --shape sequence`);
});

it('reads evidence as self-attributed only when its evaluator is the agent the task names in owner-agent', () => {
  const root = delivery('base');
  const owned = (name: string): string =>
    [
      `@task ${name}`,
      '  meaning',
      `    says "A task the fixture owner owns: ${name}."`,
      '  work',
      `    title "${name}"`,
      '    status open',
      '    milestone @milestone foundation',
      '    owner-agent @agent fixture-owner',
      '',
    ].join('\n');
  put(root, '.ia/src/owned.ia', ['#! ia 1.0', '', owned('checked'), owned('unsigned')].join('\n'));
  const { db } = read(root);
  put(
    root,
    '.ia/src/owned-evidence.ia',
    [
      '#! ia 1.0',
      '',
      observation('checked-done', '@task checked', db.get(task('checked'))!.digest),
      observation('unsigned-done', '@task unsigned', db.get(task('unsigned'))!.digest, null),
    ].join('\n'),
  );
  const delivered = view(root);
  expect(byIdentity(delivered, 'checked')).toMatchObject({
    line: `exit evidence recorded (${id('observation', 'checked-done')}, evaluator ia-compliance@1.1.0)`,
    evidence: { evaluator: 'ia-compliance@1.1.0', attribution: 'other' },
  });
  // An observation that records no evaluator cannot say whether the owner-agent took it.
  expect(byIdentity(delivered, 'unsigned')).toMatchObject({
    line: `exit evidence recorded (${id('observation', 'unsigned-done')}, evaluator not recorded, self-attribution unknown)`,
    evidence: { observation: id('observation', 'unsigned-done'), attribution: 'unknown' },
  });
  expect(byIdentity(delivered, 'unsigned').evidence!.evaluator).toBeUndefined();
});

it('reads no milestone satisfied through its tasks while admission refuses a @task or a file, and lists them', () => {
  const root = delivery('base'),
    migrate = (status: string, more = ''): string =>
      [
        '#! ia 1.0',
        '',
        '@task migrate',
        '  meaning',
        '    says "Migrate the fixture data."',
        '  work',
        '    title "Migrate"',
        `    status ${status}`,
        '    milestone @milestone foundation',
        more,
      ].join('\n');
  evidence(root, ['guide']);
  put(root, '.ia/src/migrate.ia', migrate('bogus'));
  const refused = view(root),
    unknown = 'every task the view reads has exit evidence; records admission refused are unknown';
  expect(refused.milestones.map((m) => [m.satisfied, m.basis])).toEqual([
    [false, unknown],
    [false, 'exit evidence missing for 2 of 2 tasks'],
  ]);
  expect(byIdentity(refused, 'package').line).toBe(
    `blocked (milestone ${milestone('foundation')}: ${unknown} (via ${milestone('build')}))`,
  );
  expect(refused.next).toBeNull();
  expect(refused.summary).toBe('3 of 5 tasks have exit evidence; every other task is blocked');
  expect(refused.review).toEqual([
    {
      kind: 'admission',
      records: [task('migrate')],
      owner: STEWARD,
      message: `admission refused ${task('migrate')} at .ia/src/migrate.ia:3 (IA-COMP-FIELD-VALUE), so no plan can place it; ia validate reports why`,
    },
  ]);
  evidence(root, ['guide', 'package', 'release-notes']);
  expect(view(root).summary).toBe(
    'every task the view reads has exit evidence (5 of 5); records admission refused are unknown',
  );
  // A language error refuses its whole file, naming no record (db D03): its tasks are unknown just the same.
  put(root, '.ia/src/migrate.ia', migrate('open', '  !!! nonsense\n'));
  const unparsed = view(root);
  expect(unparsed.milestones.map((m) => m.satisfied)).toEqual([false, false]);
  expect(unparsed.review).toEqual([
    {
      kind: 'admission',
      records: [],
      message:
        'IA-LANG-HEAD-FIELD-AFTER-SECTION at .ia/src/migrate.ia:10 refuses every record in that file, so no plan can ' +
        'read them; ia validate reports why',
    },
  ]);
});

it('blocks a task of the later milestone through its milestone, and never recommends it', () => {
  const delivered = view(delivery('base'));
  const pack = byIdentity(delivered, 'package');
  expect(pack.prerequisites).toEqual([
    {
      target: milestone('foundation'),
      word: 'milestone',
      via: milestone('build'),
      satisfied: false,
      basis: `milestone ${milestone('foundation')}: exit evidence missing for 1 of 3 tasks (via ${milestone('build')})`,
    },
  ]);
  expect(pack.line).toBe(`blocked (${pack.prerequisites[0]!.basis})`);
  expect(delivered.milestones.map((m) => [m.satisfied, m.basis])).toEqual([
    [false, 'exit evidence missing for 1 of 3 tasks'],
    [false, 'exit evidence missing for 2 of 2 tasks'],
  ]);
  expect(delivered.next).toBe(`ia position --seat ${task('guide')} --shape sequence`);
  expect(delivered.summary).toBe(`2 of 5 tasks have exit evidence; next: ${task('guide')}, with no declared blocker`);
});

it('prints the five state lines of each task from their own bases', () => {
  const root = delivery('base'),
    delivered = view(root),
    { db } = read(root);
  expect(byIdentity(delivered, 'guide').states).toEqual([
    {
      dimension: 'intent',
      value: 'accepted',
      basis: `${id('decision', 'guide-format')}: choice made, effective-revision ${'0'.repeat(63)}1`,
    },
    { dimension: 'definition', value: 'admitted', basis: `db admission at digest ${db.get(task('guide'))!.digest}` },
    { dimension: 'realizable', value: 'not applicable', basis: 'a @task binds nothing' },
    { dimension: 'realized', value: 'not applicable', basis: 'no effect owner realizes a @task' },
    {
      dimension: 'worked',
      value: 'unknown',
      basis: `${id('observation', 'guide-checked')}: its subject-revision matches neither retained snapshot`,
    },
  ]);
  expect(state(delivered, 'release-notes', 'intent')).toMatchObject({
    value: 'unknown',
    basis: `${id('decision', 'release-channel')}: no choice`,
  });
  expect(state(delivered, 'package', 'intent')).toMatchObject({ value: 'unknown', basis: 'no @decision grounds it' });
  expect(state(delivered, 'package', 'worked')).toMatchObject({
    value: 'unobserved',
    basis: 'no @observation names it',
  });
  expect(state(delivered, 'schema', 'worked')).toMatchObject({
    value: 'observed success',
    basis: `${id('observation', 'schema-checked')}: success at the current digest`,
  });
});

it('reads an observation at the previous snapshot digest as stale, and never as exit evidence', () => {
  const root = delivery('base');
  // The capture at another revision becomes the previous snapshot, holding the digest guide-checked recorded.
  writeCapture(
    root,
    JSON.stringify({
      format: CAPTURE_FORMAT,
      revision: 'a'.repeat(64),
      membership: [{ identity: task('guide'), root: '.ia/src', band: 100, digest: '1'.repeat(64) }],
    }),
  );
  const delivered = view(root);
  expect(state(delivered, 'guide', 'worked')).toEqual({
    dimension: 'worked',
    value: 'stale',
    basis: `${id('observation', 'guide-checked')}: its subject-revision is the digest in the previous snapshot`,
  });
  expect(byIdentity(delivered, 'guide').verdict).toBe('unblocked');
  expect(delivered.milestones[0]!.satisfied).toBe(false);
});

it('reads intent superseded when an accepted record supersedes the task, unknown without an effective revision', () => {
  const root = delivery('base');
  put(
    root,
    '.ia/src/supersede.ia',
    [
      '#! ia 1.0',
      '',
      '@task guide-v2',
      '  meaning',
      '    says "Rewrite the guide."',
      '  work',
      '    title "Guide, again"',
      '    status open',
      '    milestone @milestone foundation',
      '  relationships',
      '    supersedes @task guide',
      '',
      '@decision rewrite-guide',
      '  meaning',
      '    says "The guide is rewritten."',
      '  work',
      '    title "Rewrite the guide"',
      '    status made',
      '  decision',
      '    question "Is the guide rewritten?"',
      '    choice "yes"',
      `    effective-revision "${'2'.repeat(64)}"`,
      '  relationships',
      '    grounds @task guide-v2',
      '',
      '@decision package-scope',
      '  meaning',
      '    says "What the package holds."',
      '  work',
      '    title "Package scope"',
      '    status made',
      '  decision',
      '    question "What does the package hold?"',
      '    choice "the module only"',
      '  relationships',
      '    grounds @task package',
      '',
    ].join('\n'),
  );
  const delivered = view(root);
  expect(state(delivered, 'guide', 'intent')).toEqual({
    dimension: 'intent',
    value: 'superseded',
    basis: `${task('guide-v2')} supersedes it, grounded by ${id('decision', 'rewrite-guide')} @${'2'.repeat(64)}`,
  });
  expect(state(delivered, 'guide-v2', 'intent').value).toBe('accepted');
  expect(state(delivered, 'package', 'intent')).toMatchObject({
    value: 'unknown',
    basis: `${id('decision', 'package-scope')}: no effective-revision`,
  });
});

it('lists decisions grounding one record and accepted specs one of which supersedes the other as review items', () => {
  const root = delivery('base');
  const decision = (name: string, grounds: string, supersedes?: string, made = false): string =>
    [
      `@decision ${name}`,
      '  meaning',
      `    says "Decision ${name}."`,
      '  work',
      `    title "${name}"`,
      `    status ${made ? 'made' : 'open'}`,
      '  decision',
      `    question "Which ${name}?"`,
      ...(made ? ['    choice "yes"', `    effective-revision "${'3'.repeat(64)}"`] : []),
      '  relationships',
      `    grounds @task ${grounds}`,
      ...(supersedes === undefined ? [] : [`    supersedes @decision ${supersedes}`]),
      '',
    ].join('\n');
  const spec = (name: string, status: string, supersedes?: string, more = ''): string =>
    [
      `@spec ${name}`,
      '  meaning',
      `    says "Spec ${name}."`,
      '  work',
      `    title "${name}"`,
      `    status ${status}`,
      more,
      ...(supersedes === undefined ? [] : ['  relationships', `    supersedes @spec ${supersedes}`]),
      '',
    ]
      .filter(Boolean)
      .join('\n');
  put(
    root,
    '.ia/src/review.ia',
    [
      '#! ia 1.0',
      '',
      decision('guide-alternative', 'guide'),
      decision('package-first', 'package', undefined, true),
      decision('package-second', 'package', 'package-first'),
      // Two decisions superseding each other remove neither, so the pair is one item.
      decision('examples-one', 'examples', 'examples-two'),
      decision('examples-two', 'examples', 'examples-one'),
      spec('module-contract-v2', 'accepted', 'module-contract'),
      spec(
        'module-contract-part',
        'accepted',
        'module-contract',
        '    replaced-scope "Only the module\'s error codes."',
      ),
      // A draft successor, and a successor of a spec already marked superseded, leave one accepted spec each.
      spec('module-contract-draft', 'draft', 'module-contract'),
      spec('old-contract', 'superseded'),
      spec('new-contract', 'accepted', 'old-contract'),
    ].join('\n'),
  );
  const delivered = view(root);
  expect(delivered.review).toEqual([
    {
      kind: 'grounding',
      records: [task('guide'), id('decision', 'guide-alternative'), id('decision', 'guide-format')],
      owner: STEWARD,
      message: `${id('decision', 'guide-alternative')} and ${id('decision', 'guide-format')} each ground ${task('guide')}; none supersedes another`,
    },
    {
      kind: 'grounding',
      records: [task('examples'), id('decision', 'examples-one'), id('decision', 'examples-two')],
      owner: STEWARD,
      message:
        `${id('decision', 'examples-one')} and ${id('decision', 'examples-two')} each ground ${task('examples')}; ` +
        `${id('decision', 'examples-one')} and ${id('decision', 'examples-two')} supersede one another in a cycle`,
    },
    {
      kind: 'currency',
      records: [id('spec', 'module-contract-v2'), id('spec', 'module-contract')],
      owner: STEWARD,
      message: `${id('spec', 'module-contract-v2')} supersedes ${id('spec', 'module-contract')} with no replaced-scope, yet both declare status accepted`,
    },
  ]);
  // A superseded decision is no basis of intent, though it is made: package reads its successor, which has no choice.
  expect(state(delivered, 'package', 'intent')).toMatchObject({
    value: 'unknown',
    basis: `${id('decision', 'package-second')}: no choice`,
  });
});

it('blocks on a requirement no admitted record answers, and on a required milestone with no task', () => {
  const root = delivery('base');
  put(
    root,
    '.ia/src/unanswered.ia',
    [
      '#! ia 1.0',
      '',
      '@milestone docs',
      '  meaning',
      '    says "Documentation, with no task yet."',
      '  work',
      '    title "Docs"',
      '    status open',
      '    plan @plan release',
      '    exit "The docs are written."',
      '',
      '@task smoke-test',
      '  meaning',
      '    says "Smoke-test the package."',
      '  work',
      '    title "Smoke test"',
      '    status open',
      '    milestone @milestone build',
      '  relationships',
      '    requires @task load-test',
      '    requires @milestone docs',
      '',
    ].join('\n'),
  );
  const delivered = view(root);
  expect(delivered.milestones.map((m) => m.identity)).toEqual(['docs', 'foundation', 'build'].map(milestone));
  expect(delivered.milestones[0]).toMatchObject({ tasks: [], satisfied: false, basis: 'no task and no exit evidence' });
  expect(byIdentity(delivered, 'smoke-test').prerequisites.map((p) => [p.target, p.satisfied, p.basis])).toEqual([
    [milestone('docs'), false, `milestone ${milestone('docs')}: no task and no exit evidence`],
    ['@task load-test', false, '@task load-test: no admitted record answers it'],
    [
      milestone('foundation'),
      false,
      `milestone ${milestone('foundation')}: exit evidence missing for 1 of 3 tasks (via ${milestone('build')})`,
    ],
  ]);
  expect(byIdentity(delivered, 'smoke-test').verdict).toBe('blocked');
});

it('inherits a milestone requirement no admitted record answers, and lists a target its milestone also requires once', () => {
  const root = delivery('base'),
    path = resolve(root, '.ia/src/work.ia');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '    requires @milestone foundation\n',
      '    requires @milestone foundation\n    requires @task ghost\n',
    ),
  );
  put(
    root,
    '.ia/src/bundle.ia',
    [
      '#! ia 1.0',
      '',
      '@task bundle',
      '  meaning',
      '    says "Bundle the package, once the foundation is laid."',
      '  work',
      '    title "Bundle"',
      '    status open',
      '    milestone @milestone build',
      '  relationships',
      '    requires @milestone foundation',
      '',
    ].join('\n'),
  );
  const delivered = view(root),
    foundation = `milestone ${milestone('foundation')}: exit evidence missing for 1 of 3 tasks`,
    ghost = `@task ghost: no admitted record answers it (via ${milestone('build')})`;
  expect(byIdentity(delivered, 'bundle').prerequisites.map((p) => [p.target, p.via, p.basis])).toEqual([
    [milestone('foundation'), undefined, foundation],
    ['@task ghost', milestone('build'), ghost],
  ]);
  expect(byIdentity(delivered, 'package').prerequisites.map((p) => [p.target, p.via, p.basis])).toEqual([
    [milestone('foundation'), milestone('build'), `${foundation} (via ${milestone('build')})`],
    ['@task ghost', milestone('build'), ghost],
  ]);
});

it('satisfies a required milestone by its own exit evidence', () => {
  const root = delivery('base'),
    { db } = read(root);
  put(
    root,
    '.ia/src/milestone-evidence.ia',
    `#! ia 1.0\n\n${observation('foundation-done', '@milestone foundation', db.get(milestone('foundation'))!.digest)}`,
  );
  const delivered = view(root);
  expect(delivered.milestones[0]).toMatchObject({
    identity: milestone('foundation'),
    satisfied: true,
    basis: `exit evidence ${id('observation', 'foundation-done')}`,
  });
  expect(byIdentity(delivered, 'package').line).toBe('no declared blocker');
  // guide, the first task in order, still has no exit evidence and no blocker.
  expect(delivered.next).toBe(`ia position --seat ${task('guide')} --shape sequence`);
});

it('skips tasks with exit evidence: next is the first task in order with no declared blocker', () => {
  const root = delivery('base');
  evidence(root, ['guide']);
  const delivered = view(root);
  expect(delivered.tasks.map((t) => t.verdict)).toEqual([
    'evidenced',
    'evidenced',
    'evidenced',
    'unblocked',
    'blocked',
  ]);
  expect(delivered.milestones[0]).toMatchObject({ satisfied: true, basis: 'every task has exit evidence' });
  expect(delivered.next).toBe(`ia position --seat ${task('package')} --shape sequence`);
  expect(delivered.summary).toBe(`3 of 5 tasks have exit evidence; next: ${task('package')}, with no declared blocker`);
});

it('returns no next command when every task has exit evidence, and says so', () => {
  const root = delivery('base');
  evidence(root, ['guide', 'package', 'release-notes']);
  const delivered = view(root);
  expect(delivered.tasks.every((t) => t.verdict === 'evidenced')).toBe(true);
  expect(delivered.milestones.every((m) => m.satisfied)).toBe(true);
  expect(delivered.next).toBeNull();
  expect(delivered.summary).toBe('every task has exit evidence (5 of 5)');
});

it('returns no next command when every task without exit evidence is blocked, and says so', () => {
  const root = delivery('base'),
    path = resolve(root, '.ia/src/work.ia');
  writeFileSync(path, readFileSync(path, 'utf8').replace('    choice "written by hand"\n', ''));
  const delivered = view(root);
  expect(byIdentity(delivered, 'guide').line).toBe(`blocked (decision ${id('decision', 'guide-format')}: no choice)`);
  expect(delivered.next).toBeNull();
  expect(delivered.summary).toBe('2 of 5 tasks have exit evidence; every other task is blocked');
});

it('returns no next command for a plan with no task, and says so', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/empty.ia',
    '#! ia 1.0\n\n@plan empty\n  meaning\n    says "A plan with nothing in it yet."\n  work\n    title "Empty"\n    status open\n',
  );
  expect(view(root)).toMatchObject({
    plan: id('plan', 'empty'),
    milestones: [],
    tasks: [],
    next: null,
    summary: `${id('plan', 'empty')} has no task`,
  });
});

it('refuses a seat that is no admitted @plan, @milestone or @task, naming one next command', () => {
  const root = delivery('base');
  expect(refusal(root, lawId)).toMatchObject({
    ok: false,
    code: 'IA-RUNTIME-NEXT-SEAT',
    message: `${lawId} is a @law; the delivery view is read from a @plan, @milestone or @task`,
    next: `ia position --seat ${lawId}`,
  });
  expect(refusal(root, task('absent'))).toMatchObject({
    code: 'IA-RUNTIME-NEXT-SEAT',
    message: `${task('absent')} is not an admitted record in this scope`,
    next: 'ia next',
  });
});

it('refuses without an authored plan, and a seat whose milestone names no admitted plan', () => {
  expect(refusal(workspace())).toEqual({
    ok: false,
    code: 'IA-RUNTIME-NEXT-NO-PLAN',
    message: 'No admitted @plan at authored placement (band 100) in this scope',
    next: 'ia next --help',
  });
  const root = workspace();
  put(
    root,
    '.ia/src/orphan.ia',
    [
      '#! ia 1.0',
      '',
      '@milestone orphan',
      '  meaning',
      '    says "A milestone whose plan is not authored."',
      '  work',
      '    title "Orphan"',
      '    status open',
      '    plan @plan absent',
      '    exit "Never."',
      '',
      '@task stray',
      '  meaning',
      '    says "A task whose milestone is not authored."',
      '  work',
      '    title "Stray"',
      '    status open',
      '    milestone @milestone absent',
      '',
    ].join('\n'),
  );
  for (const seat of [milestone('orphan'), task('stray')])
    expect(refusal(root, seat), seat).toEqual({
      ok: false,
      code: 'IA-RUNTIME-NEXT-NO-PLAN',
      message: `${seat} belongs to no admitted @plan in this scope`,
      next: 'ia next --help',
    });
});

it('chooses the only plan at band 100 without a seat, whatever plans other placements admit', () => {
  const root = delivery('base'),
    path = '.ia/src/adopted-plan.ia';
  put(
    root,
    path,
    '#! ia 1.0\n\n@plan elsewhere\n  meaning\n    says "A plan an adopted source holds."\n  work\n    title "Elsewhere"\n    status open\n',
  );
  const db = database(root, {
    locations: { [path]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
  });
  expect(db.get(id('plan', 'elsewhere'))?.band).toBe(90);
  const result = deliveryView(db, db.resolveScope().token);
  expect(result.ok && result.view.plan).toBe(id('plan', 'release'));
});

it('refuses several authored plans without a seat, listing them, and reads the plan a seat names', () => {
  const root = delivery('plans'),
    plans = [id('plan', 'research'), id('plan', 'rollout')];
  expect(refusal(root)).toEqual({
    ok: false,
    code: 'IA-RUNTIME-NEXT-AMBIGUOUS',
    message: `2 admitted @plan records at band 100 and no seat to choose one: ${plans.join(', ')}`,
    next: `ia next --seat ${plans[0]!}`,
    plans,
  });
  expect(view(root, milestone('findings')).tasks.map((t) => t.identity)).toEqual([task('survey')]);
});

it('refuses a require cycle among tasks, naming its declared rows and the first task in it', () => {
  const cycle = refusal(delivery('cycle'));
  expect(cycle.code).toBe('IA-RUNTIME-NEXT-CYCLE');
  expect(cycle.next).toBe(`ia position --seat ${task('alpha')} --shape sequence`);
  // beta requires gamma is declared on gamma, in the inverse spelling; delta waits on the cycle without being in it.
  expect(cycle.cycle!.map((row) => [row.from, row.to, row.declaredOn])).toEqual([
    [task('alpha'), task('beta'), task('alpha')],
    [task('beta'), task('gamma'), task('gamma')],
    [task('gamma'), task('alpha'), task('gamma')],
  ]);
  expect(cycle.cycle!.every((row) => row.path === '.ia/src/work.ia' && row.line > 0)).toBe(true);
  expect(cycle.message).toBe(
    `The require rows of ${id('plan', 'loop')} form a cycle, so no order exists: ` +
      `${task('alpha')} requires ${task('beta')}, ${task('beta')} requires ${task('gamma')}, ${task('gamma')} requires ${task('alpha')}`,
  );
});

it('refuses a require cycle between milestones, naming the milestone rows', () => {
  const root = delivery('base'),
    path = resolve(root, '.ia/src/work.ia');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '    exit "The schema, the guide and the examples are written."\n',
      '    exit "The schema, the guide and the examples are written."\n  relationships\n    requires @milestone build\n',
    ),
  );
  const cycle = refusal(root);
  expect(cycle.code).toBe('IA-RUNTIME-NEXT-CYCLE');
  expect(cycle.cycle!.map((row) => [row.from, row.to])).toEqual([
    [milestone('build'), milestone('foundation')],
    [milestone('foundation'), milestone('build')],
  ]);
  expect(cycle.next).toBe(`ia position --seat ${milestone('build')} --shape sequence`);
});

it('reads only through the scope it is given, deterministically, and writes nothing', () => {
  const root = delivery('base');
  writeCapture(root, JSON.stringify({ format: CAPTURE_FORMAT, revision: 'a'.repeat(64), membership: [] }));
  const db = database(root, { cache: true }),
    scope = db.resolveScope().token;
  // The handle writes its cache when it opens; the view writes nothing, its reads of the capture pair included.
  const before = tree(root),
    first = deliveryView(db, scope);
  expect(tree(root)).toBe(before);
  expect(Object.isFrozen(first)).toBe(true);
  // Another copy at another root reads byte-equal.
  expect(JSON.stringify(view(delivery('base')))).toBe(JSON.stringify(first.ok ? first.view : first));
  // A scope without the package task does not list it.
  const narrowed = db.resolveScope({
    identities: db
      .records()
      .map((node) => node.identity)
      .filter((identity) => identity !== task('package')),
  }).token;
  const narrow = deliveryView(db, narrowed);
  expect(narrow.ok && narrow.view.tasks.map((t) => t.identity)).toEqual(
    ['guide', 'schema', 'examples', 'release-notes'].map(task),
  );
  expect(() => deliveryView(db, 'not-a-token')).toThrow(/IA-DB-SCOPE-UNAVAILABLE/);
  // The plans the snapshot of the scope holds are the only ones counted, and a seat outside it is refused as a value.
  const plans = database(delivery('plans')),
    rollout = plans.resolveScope({
      identities: plans
        .records()
        .map((node) => node.identity)
        .filter((identity) => identity !== id('plan', 'research')),
    }).token;
  const only = deliveryView(plans, rollout);
  expect(only.ok && only.view.plan).toBe(id('plan', 'rollout'));
  expect(deliveryView(plans, rollout, id('plan', 'research'))).toEqual({
    ok: false,
    code: 'IA-RUNTIME-NEXT-SEAT',
    message: `${id('plan', 'research')} is not an admitted record in this scope`,
    next: 'ia next',
  });
  expect(deliveryView(plans, rollout, milestone('findings'))).toMatchObject({ code: 'IA-RUNTIME-NEXT-NO-PLAN' });
});

it('reads what a narrowed scope leaves out as unknown, never as met', () => {
  const root = delivery('base'),
    db = database(root),
    all = db.records().map((node) => node.identity);
  const without = (...excluded: string[]): string =>
    db.resolveScope({ identities: all.filter((identity) => !excluded.includes(identity)) }).token;
  const result = deliveryView(db, without(id('decision', 'release-channel'), task('guide')));
  if (!result.ok) throw new Error(result.message);
  const delivered = result.view,
    unknown = 'every task the view reads has exit evidence; records outside this scope are unknown';
  // release-notes states both requirements itself; the rows answering them are outside the scope.
  expect(byIdentity(delivered, 'release-notes').prerequisites.map((p) => [p.target, p.via, p.basis])).toEqual([
    ['@task guide', undefined, '@task guide: no record in this scope answers it (unknown)'],
    ['@decision release-channel', undefined, '@decision release-channel: no record in this scope answers it (unknown)'],
    [
      milestone('foundation'),
      milestone('build'),
      `milestone ${milestone('foundation')}: ${unknown} (via ${milestone('build')})`,
    ],
  ]);
  expect(delivered.milestones[0]).toMatchObject({
    identity: milestone('foundation'),
    satisfied: false,
    basis: unknown,
  });
  expect(delivered.tasks.map((t) => [t.identity, t.verdict])).toEqual([
    [task('schema'), 'evidenced'],
    [task('examples'), 'evidenced'],
    [task('package'), 'blocked'],
    [task('release-notes'), 'blocked'],
  ]);
  expect(delivered.next).toBeNull();
  expect(delivered.summary).toBe('2 of 4 tasks have exit evidence; every other task is blocked');
  expect(state(delivered, 'package', 'worked')).toEqual({
    dimension: 'worked',
    value: 'unknown',
    basis: 'no @observation in this scope names it',
  });
  expect(state(delivered, 'release-notes', 'intent')).toMatchObject({
    value: 'unknown',
    basis: 'no @decision in this scope grounds it',
  });
  // examples names its owner-agent, which this scope does not admit, so whether its evaluator is that agent is unknown.
  const ownerless = deliveryView(db, without(OWNER));
  expect(ownerless.ok && byIdentity(ownerless.view, 'examples')).toMatchObject({
    line: `exit evidence recorded (${id('observation', 'examples-checked')}, evaluator ${OWNER}, self-attribution unknown)`,
    evidence: { evaluator: OWNER, attribution: 'unknown' },
  });
});

/** A door over `root`, closed with the test's handles. */
function door(root: string, options: DoorOptions = {}): Door {
  const opened = new Door(root, { cache: false, ...options });
  doors.push(opened);
  return opened;
}
const doors: Door[] = [];
afterEach(() => {
  for (const opened of doors.splice(0)) opened.close();
});

// MACHINE_PROTOCOL version 2 (R12): the Door's `next` is deliveryView through the door's own token, its view as the
// result and its refusal, `next`, `plans` and `cycle` included, as the response; a version 1 refusal keeps its shape.
it('serves the delivery view on the Door through its token, and answers a refusal with its next command', () => {
  const root = delivery('base'),
    gate = door(root);
  const before = tree(root);
  const { db, result: direct } = read(root);
  if (!direct.ok) throw new Error(direct.message);
  const served = JSON.stringify({ ok: true, result: direct.view });
  expect(JSON.stringify(gate.request({ operation: 'next' }))).toBe(served);
  // Every seat of the plan, the plan itself, each milestone and each task, reads the same view.
  const seats = [
    direct.view.plan,
    ...direct.view.milestones.map((m) => m.identity),
    ...direct.view.tasks.map((t) => t.identity),
  ];
  expect(seats).toHaveLength(8);
  for (const seat of seats)
    expect(JSON.stringify(gate.request({ operation: 'next', params: { seat } })), seat).toBe(served);
  // A token the door issued narrows the view as it narrows any read.
  const scope = gate.request({
    operation: 'scope',
    params: { identities: db.records().flatMap((node) => (node.identity === task('package') ? [] : [node.identity])) },
  });
  if (!scope.ok) throw new Error(scope.message);
  const narrowed = gate.request({ operation: 'next', params: { within: (scope.result as { token: string }).token } });
  expect(narrowed.ok && (narrowed.result as DeliveryView).tasks.map((t) => t.identity)).toEqual(
    ['guide', 'schema', 'examples', 'release-notes'].map(task),
  );
  // The refusal is deliveryView's own value, its next command and its extras included.
  const refused = new Map<string, DoorResponse>();
  for (const [fixture, seat] of [
    ['plans', undefined],
    ['cycle', undefined],
    ['base', lawId],
  ] as const) {
    const where = delivery(fixture),
      expected = read(where, seat).result,
      response = door(where).request({ operation: 'next', params: seat === undefined ? {} : { seat } });
    expect(expected.ok, fixture).toBe(false);
    expect(response, fixture).toEqual(expected);
    refused.set(fixture, response);
  }
  expect(refused.get('plans')).toMatchObject({
    code: 'IA-RUNTIME-NEXT-AMBIGUOUS',
    next: `ia next --seat ${id('plan', 'research')}`,
    plans: [id('plan', 'research'), id('plan', 'rollout')],
  });
  // A version 1 operation's refusal, and the Door's own refusals of a next request, keep the three keys 1.1.0's had.
  for (const request of [
    { operation: 'get', params: { identity: lawId, within: 'forged' } },
    { operation: 'next', params: { within: 'forged' } },
    { operation: 'next', params: { seat: 1 } },
    { operation: 'next', params: { seat: task('guide'), unlisted: 1 } },
  ]) {
    const response = gate.request(request);
    expect(Object.keys(response), JSON.stringify(request)).toEqual(['ok', 'code', 'message']);
  }
  expect(gate.request({ operation: 'next', params: { seat: 1 } })).toMatchObject({
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message: 'IA-RUNTIME-REQUEST-INVALID: seat must be a string',
  });
  // The door opened without the db cache, and the view writes nothing.
  expect(tree(root)).toBe(before);
  // A door serving version 1, as the CLI's machine routes do, knows no next operation.
  expect(door(root, { protocol: 1 }).request({ operation: 'next' })).toEqual({
    ok: false,
    code: 'IA-RUNTIME-REQUEST-INVALID',
    message:
      "IA-RUNTIME-REQUEST-INVALID: Unknown operation 'next'; admitted: scope, context, select, get, records, resolve, search, traverse",
  });
});

// db PT5 through the Door (R12): only the initial token of a door opened without a boundary is a whole-workspace one,
// so only it names the records admission refused. A token the door issued narrower, or the initial token of a door
// opened with a boundary, names none, even one that admits every record the workspace admits.
it('names the records admission refused on the Door only through a whole-workspace token', () => {
  const root = delivery('base');
  put(
    root,
    '.ia/src/migrate.ia',
    [
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
    ].join('\n'),
  );
  const every = database(root)
      .records()
      .map((node) => node.identity),
    gate = door(root);
  const whole = gate.request({ operation: 'next' });
  if (!whole.ok) throw new Error(whole.message);
  expect((whole.result as DeliveryView).review).toEqual([
    {
      kind: 'admission',
      records: [task('migrate')],
      owner: STEWARD,
      message: `admission refused ${task('migrate')} at .ia/src/migrate.ia:3 (IA-COMP-FIELD-VALUE), so no plan can place it; ia validate reports why`,
    },
  ]);
  const scope = gate.request({ operation: 'scope', params: { identities: every } });
  if (!scope.ok) throw new Error(scope.message);
  for (const [label, response] of [
    ['narrowed', gate.request({ operation: 'next', params: { within: (scope.result as { token: string }).token } })],
    ['bounded', door(root, { boundary: { identities: every } }).request({ operation: 'next' })],
  ] as const) {
    if (!response.ok) throw new Error(`${label}: ${response.message}`);
    const narrow = response.result as DeliveryView;
    expect(narrow.review, label).toEqual([]);
    expect(
      narrow.tasks.map((t) => t.identity),
      label,
    ).toEqual((whole.result as DeliveryView).tasks.map((t) => t.identity));
    // It reads as a narrowed scope reads, what it cannot see unknown, and nothing in it names the refused task.
    expect(state(narrow, 'package', 'worked'), label).toEqual({
      dimension: 'worked',
      value: 'unknown',
      basis: 'no @observation in this scope names it',
    });
    expect(JSON.stringify(narrow), label).not.toContain('migrate');
  }
});

// spec-0012 DRF-02 for the next row: its example reads the delivery fixture (the loop fixture the other rows' examples
// read authors no plan, so there it is refused), it requires no parameter, and its refusal list is proven both ways.
it('holds the next row of the machine protocol table to the Door', () => {
  const row = MACHINE_PROTOCOL.operations.find((operation) => operation.name === 'next')!;
  expect(row).toMatchObject({ since: 2, mcp: 'ia_next' });
  expect((row.params as { required: readonly string[] }).required).toEqual([]);
  const base = door(delivery('base'));
  expect(base.request({ operation: 'next', params: row.example })).toMatchObject({
    ok: true,
    result: { format: 'ia.delivery-view.v1', plan: id('plan', 'release') },
  });
  expect(
    door(resolve(import.meta.dirname, '../../compliance/fixtures/loop')).request({
      operation: 'next',
      params: row.example,
    }),
  ).toMatchObject({ ok: false, code: 'IA-RUNTIME-NEXT-NO-PLAN', next: 'ia next --help' });
  const triggers: Readonly<Record<string, readonly [Door, Record<string, unknown>]>> = {
    'IA-RUNTIME-REQUEST-INVALID': [base, { unlisted: 1 }],
    'IA-DB-SCOPE-UNAVAILABLE': [base, { within: 'forged' }],
    'IA-RUNTIME-NEXT-SEAT': [base, { seat: lawId }],
    'IA-RUNTIME-NEXT-NO-PLAN': [door(workspace()), {}],
    'IA-RUNTIME-NEXT-AMBIGUOUS': [door(delivery('plans')), {}],
    'IA-RUNTIME-NEXT-CYCLE': [door(delivery('cycle')), {}],
  };
  const observed = Object.values(triggers).map(([gate, params]) => {
    const response = gate.request({ operation: 'next', params });
    return response.ok ? 'accepted' : response.code;
  });
  expect(observed).toEqual(Object.keys(triggers));
  expect(row.refusals.map((refusal) => refusal.code).sort()).toEqual(Object.keys(triggers).sort());
  expect(NEXT_CODES.every((code) => row.refusals.some((refusal) => refusal.code === code))).toBe(true);
});
