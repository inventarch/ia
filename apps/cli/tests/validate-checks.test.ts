/**
 * Milestone generation-binding task check-runner-join-validate (plan amendments C14, C15, C21, C22 and C23): `ia
 * validate` binds every `@check`, reports a Checks section, and records the bound checks that passed or failed as runtime
 * evidence, the one write it makes. A not-evaluated check is never a pass and records nothing; the authored revision,
 * the position packet and the host projection never move for it; and no other command writes or prunes evidence.
 * tests/equivalence.test.ts holds the two validation binaries to one result and one evidence file.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { open } from '@inventarch/db';
import { doctor, host, initialized, put } from './host-fixture.js';
import { cleanup, repository, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 240_000 });
// Every node:fs export calls through; a test can make one unlink fail as a file the process may not remove would.
vi.mock('node:fs', { spy: true });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
afterAll(cleanup, 120_000);

const EVIDENCE = '.ia/work/evidence',
  /** The workspace rules file `ia host claude` projects, the consumer's CLAUDE.md. */
  PROJECTED = '.claude/rules/ia-workspace.md';
/** A local check in an `ia init` workspace naming `runner`, with the text scope `scope`. */
const check = (name: string, runner: string, scope: string) => `@check ${name}
  meaning
    says "Bind ${name} for the test."
    answers "What does ${name} select?"
  check
    runs ${runner}
    scope "${scope}"
  governance
    severity blocking
`;
const CHECKS = `#! ia 1.0

${check('demo-schema-check', 'COMP-SCHEMA', '*')}
${check('prose-check', 'COMP-SCHEMA', 'every admitted record')}
${check('typing-check', 'acme-strict-typing', 'package')}`;
/** Only built-in evaluators, so every strict reader (`ia host`, `ia capture`, `ia position`) admits the workspace too. */
const BUILT_IN = `#! ia 1.0

${check('demo-schema-check', 'COMP-SCHEMA', '*')}
${check('prose-check', 'COMP-SCHEMA', 'every admitted record')}`;
const ID = (name: string) => `compliance-system/check/gate/${name}`;
const validate = async (root: string, env: Record<string, string>, ...extra: string[]) => {
  const result = await run(['validate', '--root', root, ...extra], { env });
  return { ...result, text: result.stdout.replace(/\s+/g, ' ') };
};
const json = async (root: string, env: Record<string, string>) => {
  const result = await run(['validate', '--root', root, '--json'], { env });
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) };
};
/** Every entry under each root and the root itself, with directory mtimes and file sizes, mtimes and digests. */
function tree(...roots: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  const describe = (path: string) => {
    const stat = statSync(path);
    return stat.isDirectory()
      ? `directory ${stat.mtimeMs}`
      : `${stat.size} ${stat.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  };
  for (const top of roots) {
    entries[top] = existsSync(top) ? describe(top) : 'absent';
    if (existsSync(top))
      for (const entry of readdirSync(top, { recursive: true, encoding: 'utf8' }))
        entries[resolve(top, entry)] = describe(resolve(top, entry));
  }
  return entries;
}
const authoredRevision = (root: string) => {
  const db = open(root, { cache: false });
  try {
    return db.authoredRevision;
  } finally {
    db.close();
  }
};

it('locates an unsafe evidence ancestor and never suggests repairing a child through its link', async () => {
  for (const linked of ['.ia/work', EVIDENCE]) {
    const { root, env } = await initialized();
    put(root, '.ia/src/checks.ia', BUILT_IN);
    const elsewhere = scratch('external-evidence');
    put(elsewhere, 'evidence/keep.ia', 'outside workspace\n');
    if (existsSync(resolve(root, '.ia/work'))) renameSync(resolve(root, '.ia/work'), resolve(root, 'saved-work'));
    mkdirSync(resolve(root, '.ia'), { recursive: true });
    if (linked === EVIDENCE) mkdirSync(resolve(root, '.ia/work'));
    symlinkSync(elsewhere, resolve(root, linked), 'junction');
    const before = tree(elsewhere);
    // Doctor is observational: it neither records evidence nor supplies a destructive evidence remedy.
    const observed = await doctor(root, env);
    expect(observed.checks.every((row) => !/delete.*work\/evidence/i.test(row.remedy ?? ''))).toBe(true);
    expect(tree(elsewhere)).toEqual(before);
    const refused = await json(root, env);
    expect(refused.exitCode).toBe(3);
    expect(refused.envelope).toMatchObject({
      code: 'IA-DB-PATH-UNSAFE',
      where: { path: linked },
      next: expect.stringContaining(`Replace only the unsafe entry ${linked}`),
    });
    expect(refused.envelope.next).toContain('without following it or deleting its target');
    expect(tree(elsewhere)).toEqual(before);
    // Only unlink the workspace entry; the external directory and every byte in it stay intact.
    rmSync(resolve(root, linked));
    mkdirSync(resolve(root, linked));
    expect((await json(root, env)).exitCode).toBe(0);
    expect(tree(elsewhere)).toEqual(before);
  }
});

it('binds every check, reports one Checks section, and records the passing one as admitted runtime evidence', async () => {
  const { root, env } = await initialized();
  // A workspace with no check keeps its report, with empty checks and nothing recorded in JSON.
  const plain = await validate(root, env);
  expect(plain.text).not.toContain('Checks');
  const before = await json(root, env);
  expect(before.envelope.checks).toEqual({ catalog: null, results: [] });
  expect(before.envelope.evidence).toEqual({ path: null, written: false, pruned: [], observations: [] });

  put(root, '.ia/src/checks.ia', CHECKS);
  const revision = authoredRevision(root),
    path = `${EVIDENCE}/${revision}.ia`,
    name = `demo-schema-check-${revision.slice(0, 12)}`;
  const { exitCode, envelope } = await json(root, env);
  expect(exitCode).toBe(0);
  const results = Object.fromEntries(envelope.checks.results.map((row: { name: string }) => [row.name, row])) as Record<
    string,
    Record<string, unknown>
  >;
  // A built-in evaluator over the whole-workspace token: bound, with the aggregate of its verdicts.
  expect(results['demo-schema-check']).toMatchObject({
    identity: ID('demo-schema-check'),
    runner: 'COMP-SCHEMA',
    scope: '*',
    status: 'bound',
    implementation: 'built-in',
    outcome: 'pass',
  });
  // A prose scope selects nothing, and an evaluator no catalog lists is unavailable: neither is a pass.
  expect(results['prose-check']).toMatchObject({ status: 'bound', outcome: 'not-evaluated', selected: 0 });
  expect(results['typing-check']).toMatchObject({
    status: 'unavailable',
    implementation: null,
    outcome: 'not-evaluated',
    reason: expect.stringContaining('no host has joined'),
  });
  // Only the passing check is recorded, as one observation of the authored revision.
  expect(envelope.evidence).toEqual({
    path,
    written: true,
    pruned: [],
    observations: [{ name, check: ID('demo-schema-check'), verdict: 'success' }],
  });
  const db = open(root, { cache: false, checks: 'structural', evidence: true });
  try {
    const observation = db.records().find((record) => record.name === name)!;
    expect(observation).toMatchObject({ discriminator: 'observation', band: 0 });
    const verdict = observation.sections
      .find((section) => section.name === 'evidence')!
      .fields.find((field) => 'key' in field && field.key === 'verdict');
    expect(verdict && 'value' in verdict && verdict.value).toMatchObject({ text: 'success' });
    expect(db.authoredRevision).toBe(revision);
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  } finally {
    db.close();
  }
  // The human report: one entry per check, its result and reason under its identity, and what was recorded.
  const human = await validate(root, env);
  expect(human.exitCode).toBe(0);
  expect(human.text).toContain(`✔ ${ID('demo-schema-check')} COMP-SCHEMA: bound, pass built-in COMP-SCHEMA: `);
  expect(human.text).toContain(
    `1 check names an evaluator that is not built in (${ID('typing-check')}): ia validate admits it to bind it, as ia preview and ia author do, but every other reader counts it as an IA-COMP-CHECK-UNKNOWN error, so ia host and ia project refuse the workspace and ia capture records it as an error; remove or replace it before ia host or ia project.`,
  );
  expect(human.text).toContain(
    `${ID('prose-check')} COMP-SCHEMA: bound, not-evaluated check.scope "every admitted record"`,
  );
  expect(human.text).toContain(`${ID('typing-check')} acme-strict-typing: unavailable, not-evaluated`);
  expect(human.text).toContain('2 checks were not evaluated; a not-evaluated check is not a pass.');
  expect(human.text).toContain(`Recorded 1 observation in ${path}, unchanged.`);
  expect(human.text).toContain('A not-evaluated result is not a pass. Supply the named evaluator to obtain one.');
});

it('leaves the authored revision, the position packet and the host projection unchanged across two validates', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', BUILT_IN);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const revision = authoredRevision(root),
    position = (await run(['position', '--root', root, '--json'], { env })).stdout,
    projected = readFileSync(resolve(root, PROJECTED));
  const first = await json(root, env),
    second = await json(root, env);
  expect(first.envelope.evidence).toMatchObject({ path: `${EVIDENCE}/${revision}.ia`, written: true });
  expect(second.envelope.evidence).toMatchObject({ path: `${EVIDENCE}/${revision}.ia`, written: false });
  expect(second.envelope.checks).toEqual(first.envelope.checks);
  expect(authoredRevision(root)).toBe(revision);
  expect((await run(['position', '--root', root, '--json'], { env })).stdout).toBe(position);
  expect(readFileSync(resolve(root, PROJECTED))).toEqual(projected);
  const rows = (await doctor(root, env)).checks;
  expect(rows.find((row) => row.id === 'projection-claude')).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining('No drift: '),
  });
});

it('never creates or prunes evidence from doctor, capture --preview or a refused effect (C23)', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', BUILT_IN);
  expect((await json(root, env)).envelope.evidence.written).toBe(true);
  // An older revision's file a writer would prune, beside the current one.
  put(root, `${EVIDENCE}/${'0'.repeat(64)}.ia`, '#! ia 1.0\n');
  const home = env.IA_HOST_HOME,
    before = tree(root, home);
  for (const argv of [
    ['doctor', '--root', root],
    ['doctor', '--root', root, '--json'],
    ['capture', '--root', root, '--preview'],
    ['capture', '--root', root, '--preview', '--json'],
    // Refused effects: an initialized target, and a host this release does not project.
    ['init', root, '--apply', '--yes'],
    ['host', 'cursor', '--root', root, '--apply', '--yes'],
  ]) {
    const result = await run(argv, { env });
    expect(tree(root, home), argv.join(' ')).toEqual(before);
    if (argv[0] === 'init' || argv[0] === 'host') expect(result.exitCode, argv.join(' ')).not.toBe(0);
  }
});

it('refuses a profile before replacing current evidence or pruning stale evidence (L6-04)', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', `#! ia 1.0\n\n${check('demo-schema-check', 'COMP-SCHEMA', '*')}`);
  const seeded = await json(root, env);
  expect(seeded.exitCode).toBe(0);
  expect(seeded.envelope.evidence.written).toBe(true);
  const stale = seeded.envelope.evidence.path as string;

  const source = '.ia/src/workspace.ia';
  const original = readFileSync(resolve(root, source), 'utf8');
  const restricted = original.replace(
    'moves [Observation, Verification, Synthesis, Delegation, Execution]',
    'moves [Observation]',
  );
  expect(restricted).not.toBe(original);
  put(
    root,
    source,
    `${restricted}\n@agent verifier
  meaning
    says "The separate participant authorized to validate this fixture."
    answers "Who can validate?"
  governance
    applies []

@mandate verifier-mandate
  meaning
    says "Allow verification in this fixture."
    answers "Which move is allowed?"
  governance
    requires "Claim no host permission or execution from this mandate."
  authority
    participant @agent verifier
    moves [Verification]
    scope [@workspace demo]
`,
  );
  const revision = authoredRevision(root);
  const current = `${EVIDENCE}/${revision}.ia`;
  expect(current).not.toBe(stale);
  // Both are writable: a late gate can replace the current receipt and prune the older revision before refusing.
  put(root, current, '#! ia 1.0\n# stale current evidence\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(resolve(root, stale), old, old);
  const before = tree(root, env.IA_HOST_HOME);
  const refused = await validate(root, env, '--actor', 'demo', '--json');
  expect(refused.exitCode, refused.stdout).toBe(1);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-RUNTIME-MANDATE-MOVE',
    message: expect.stringContaining('validate needs Verification'),
  });
  expect(tree(root, env.IA_HOST_HOME)).toEqual(before);

  // The very same source revision does produce evidence for its authorized participant. No malformed check or
  // unwritable path masks a late-gate bug, and the old receipt really is eligible for pruning.
  const allowed = await validate(root, env, '--actor', 'verifier', '--json');
  expect(allowed.exitCode, allowed.stdout).toBe(0);
  const envelope = JSON.parse(allowed.stdout);
  expect(envelope.authoredRevision).toBe(revision);
  expect(envelope.checks.results).toContainEqual(
    expect.objectContaining({
      name: 'demo-schema-check',
      status: 'bound',
      outcome: 'pass',
    }),
  );
  expect(envelope.evidence).toMatchObject({ path: current, written: true, pruned: [stale] });
  expect(existsSync(resolve(root, stale))).toBe(false);
  expect(readFileSync(resolve(root, current), 'utf8')).not.toBe('#! ia 1.0\n# stale current evidence\n');
});

it('refuses cleanly where the evidence cannot be written, leaving what it found, and reads none from a broken .ia/work', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', CHECKS);
  const revision = authoredRevision(root),
    target = resolve(root, `${EVIDENCE}/${revision}.ia`),
    directory = resolve(root, EVIDENCE);
  // A stale file at this revision that the writer must replace: not admitted as evidence, so validate rewrites it.
  put(root, `${EVIDENCE}/${revision}.ia`, '#! ia 1.0\n// stale\n');
  const lock = process.platform === 'win32' ? target : directory;
  if (process.platform !== 'win32' && process.getuid?.() === 0) return;
  chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
  try {
    const refused = await run(['validate', '--root', root, '--json'], { env });
    expect(refused.exitCode).toBe(3);
    const body = JSON.parse(refused.stdout || refused.stderr);
    expect(body).toMatchObject({
      ok: false,
      code: 'IA-DIST-EVIDENCE-UNWRITABLE',
      next: expect.stringContaining(`Make ${EVIDENCE} writable, then run "ia validate --root`),
    });
    expect(readFileSync(target, 'utf8')).toBe('#! ia 1.0\n// stale\n');
    expect(readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  } finally {
    chmodSync(lock, process.platform === 'win32' ? 0o644 : 0o755);
  }
  expect((await json(root, env)).envelope.evidence.written).toBe(true);
  // A file where .ia/work goes: nothing is read from it, and with a passing check to record validate refuses with the
  // repair; without one, it validates as a released reader did.
  rmSync(resolve(root, '.ia/work'), { recursive: true });
  put(root, '.ia/work', 'not a directory\n');
  const blocked = await run(['validate', '--root', root, '--json'], { env });
  expect(blocked.exitCode).toBe(3);
  expect(JSON.parse(blocked.stdout || blocked.stderr)).toMatchObject({
    code: 'IA-DB-PATH-UNSAFE',
    next: expect.stringContaining(`then run "ia validate --root`),
  });
  put(root, '.ia/src/checks.ia', `#! ia 1.0\n\n${check('prose-check', 'COMP-SCHEMA', 'every admitted record')}`);
  expect((await json(root, env)).exitCode).toBe(0);
  expect(readFileSync(resolve(root, '.ia/work'), 'utf8')).toBe('not a directory\n');
});

it('keeps one whole evidence file when several validates run at once', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', CHECKS);
  const main = resolve(repository, 'apps/cli/dist/main.js');
  const runs = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<{ code: number | null; stdout: string }>((done) => {
          const child = spawn(process.execPath, [main, 'validate', '--root', root, '--json'], {
            env: { ...process.env, ...env, NODE_OPTIONS: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.on('close', (code) => done({ code, stdout }));
        }),
    ),
  );
  for (const result of runs) expect(result.code, result.stdout).toBe(0);
  const revision = authoredRevision(root);
  expect(readdirSync(resolve(root, EVIDENCE))).toEqual([`${revision}.ia`]);
  const db = open(root, { cache: false, checks: 'structural', evidence: true });
  try {
    expect(db.records().filter((record) => record.band === 0 && record.discriminator === 'observation')).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});

it('binds and reports from the authored view alone, so planted evidence changes nothing validate says (B3-R4, B3-N4)', async () => {
  const { root, env } = await initialized();
  put(
    root,
    '.ia/src/checks.ia',
    `#! ia 1.0\n\n${check('demo-schema-check', 'COMP-SCHEMA', '*')}\n${check('consent-check', 'COMP-CONSENT', 'graph')}`,
  );
  const first = await json(root, env),
    template = readFileSync(resolve(root, first.envelope.evidence.path), 'utf8'),
    start = template.indexOf('@observation '),
    end = template.indexOf('\n\n@observation', start),
    block = template.slice(start, end < 0 ? undefined : end + 1);
  // An authored observation citing one no source authors: a dangling reference validate reports as a warning.
  put(
    root,
    '.ia/src/authored.ia',
    `#! ia 1.0\n\n${block.replace(/^@observation \S+/, '@observation authored-one').trimEnd()}\n  relationships\n    cites @observation forged-one\n`,
  );
  const before = await json(root, env),
    path = resolve(root, before.envelope.evidence.path);
  expect(before.envelope.findings.map((finding: { code: string }) => finding.code)).toContain(
    'IA-GRAPH-TARGET-MISSING',
  );
  // Planted into this authored revision's evidence file: the observation the dangling reference names, with edges.
  const planted = `${readFileSync(path, 'utf8')}\n${block.replace(/^@observation \S+/, '@observation forged-one').trimEnd()}\n  relationships\n    supersedes @check demo-schema-check\n`;
  actualFs.writeFileSync(path, planted);
  const after = await json(root, env);
  expect(after.exitCode).toBe(before.exitCode);
  for (const key of ['revision', 'authoredRevision', 'status', 'counts', 'findings', 'checks'])
    expect(after.envelope[key], key).toEqual(before.envelope[key]);
  // The revision is the evidence-free one every other reader reports for the workspace (2.0.0 readers included).
  const strict = open(root, { cache: false });
  try {
    expect(after.envelope.revision).toBe(strict.revision);
    expect(after.envelope.authoredRevision).toBe(strict.authoredRevision);
  } finally {
    strict.close();
  }
  // The writer replaces the planted file with exactly what it records.
  expect(readFileSync(path, 'utf8')).not.toContain('forged-one');
  expect(after.envelope.evidence.observations).toEqual(before.envelope.evidence.observations);
});

it('prunes best effort, so a file it may not remove never refuses validate, and records nothing when refused (B3-R1, B3-N11)', async () => {
  const { root, env } = await initialized();
  const stalePath = `${EVIDENCE}/${'3'.repeat(64)}.ia`,
    stale = resolve(root, stalePath);
  put(root, stalePath, '#! ia 1.0\n');
  const undeletable = Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
  vi.mocked(unlinkSync).mockImplementation((target) => {
    if (String(target).endsWith(`${'3'.repeat(64)}.ia`)) throw undeletable;
    actualFs.unlinkSync(target);
  });
  try {
    // No check at all: nothing to record, and the stale file it may not remove is skipped.
    expect((await json(root, env)).exitCode).toBe(0);
    put(root, '.ia/src/checks.ia', BUILT_IN);
    const recorded = await json(root, env);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.envelope.evidence).toMatchObject({ written: true, pruned: [] });
    // Unchanged bytes: nothing to write, and still no refusal.
    const unchanged = await json(root, env);
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.envelope.evidence).toMatchObject({ written: false, pruned: [] });
    expect(existsSync(stale)).toBe(true);
  } finally {
    vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync);
  }
  // A refused admission records and prunes nothing.
  const evidenceBefore = readdirSync(resolve(root, EVIDENCE)).sort();
  put(root, '.ia/src/broken.ia', '#! ia 1.0\n\n@check broken-check\n  meaning\n    says "x"\n    answers "y"\n');
  const refused = await json(root, env);
  expect(refused.exitCode).toBe(1);
  expect(refused.envelope.status).toBe('refused');
  expect(refused.envelope.evidence).toEqual({ path: null, written: false, pruned: [], observations: [] });
  expect(readdirSync(resolve(root, EVIDENCE)).sort()).toEqual(evidenceBefore);
  const human = await validate(root, env);
  expect(human.text).toContain('No evidence recorded: admission was refused, so nothing is recorded or pruned.');
});

it('keeps prior times only from a file the writer itself would write (B4-RC2)', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', BUILT_IN);
  const first = await json(root, env),
    path = resolve(root, first.envelope.evidence.path),
    genuine = readFileSync(path, 'utf8');
  // Review finding F3: times in the writer's exact stamp, observed and captured together and long past, which the
  // writer would keep from a file it wrote; beside a forged reason, this file is not one it wrote.
  const planted = genuine
    .replace(/(observed|captured)-at "[^"]+"/g, '$1-at "2001-01-01T00:00:00.000Z"')
    .replace(/reason "built-in COMP-SCHEMA[^"]*"/, 'reason "planted: an auditor passed it"');
  expect(planted).not.toBe(genuine);
  actualFs.writeFileSync(path, planted);
  const second = await json(root, env);
  expect(second.envelope.evidence).toMatchObject({ written: true });
  const rewritten = readFileSync(path, 'utf8');
  expect(rewritten).not.toContain('2001-01-01');
  expect(rewritten).not.toContain('planted');
  // The writer's own file, by contrast, lends its times: a third validate writes nothing.
  expect((await json(root, env)).envelope.evidence).toMatchObject({ written: false });
});
