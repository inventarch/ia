/**
 * `ia init`, `ia format`, `ia compile`, `ia capture`, `ia read` and `ia doctor`, against the committed loop fixture.
 *
 * Every verb is exercised in its human and `--json` form and in each exit class its §2 section declares, because
 * the exit class is the part a script depends on and the part a renderer change cannot be trusted to preserve.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { applyHost, planHost } from '@inventarch/distribution/host';
import { materializeHostPayload, readHostPin } from '@inventarch/distribution/host-home';
import { json, sha256 } from '@inventarch/distribution/services';
import { ARTIFACT, collectCompile, COMPILE_DEPRECATION } from '../src/compile.js';
import { collectDoctor } from '../src/doctor.js';
import { NOT_EVALUATED } from '../src/validate.js';
import {
  cleanup,
  cli,
  FORMATTABLE,
  run,
  scratch,
  STEWARD,
  STEWARD_COPY,
  STEWARD_SAYS,
  withSteward,
  workspace,
} from './workspace-fixture.js';

const ANSI = /\u001b\[/;
afterAll(cleanup);

const deform = (root: string): void => {
  const path = resolve(root, FORMATTABLE);
  const text = readFileSync(path, 'utf8');
  const edited = text.replace('  meaning\n', '  meaning   \n');
  if (edited === text) throw new Error(`${FORMATTABLE} no longer contains the line this test perturbs`);
  writeFileSync(path, edited);
};

it('plans a workspace without creating one and plans the selected host without writing for it', async () => {
  const empty = scratch('init');
  const plan = await run(['init'], { cwd: empty });
  expect(plan.exitCode).toBe(0);
  expect(plan.stdout).toContain('Plan  init');
  expect(plan.stdout).toContain('.ia/distributions.lock.json');
  expect(plan.stdout).toContain('None. The target directory is empty.');
  expect(existsSync(resolve(empty, '.ia'))).toBe(false);

  const machine = JSON.parse((await run(['init', '--json'], { cwd: empty })).stdout) as {
    root: string;
    apply: boolean;
    plan: {
      state: string;
      owns: string[];
      conflicts: unknown[];
      steps: { id: string; status: string }[];
      starter: {
        id: string;
        paths: string[];
        descriptor: { id: string; dependencies: { id: string; range: string }[] };
        base: { id: string; version: string; archive: string };
      };
      host: { selected: string; status: string };
    };
  };
  expect(machine).toMatchObject({ version: 1, command: 'init', root: empty, apply: false });
  expect(machine.plan.state).toBe('fresh');
  expect(machine.plan.owns).toHaveLength(5);
  expect(machine.plan.owns).toContain('.ia/src/');
  expect(machine.plan.owns).toContain('.ia/release.json');
  expect(machine.plan.conflicts).toEqual([]);
  expect(machine.plan.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
    'install:pending',
    'system:pending',
    'records:pending',
    'descriptor:pending',
  ]);
  // M5.1 §7 item 4: the starter object carries the authored paths, the descriptor values and the base pin.
  const name = machine.plan.starter.id.slice('local/'.length);
  expect(machine.plan.starter.id).toMatch(/^local\/ia-cli-init-[a-z0-9-]+$/);
  expect(machine.plan.starter.paths).toEqual([
    `.ia/src/systems/${name}/system.ia`,
    `.ia/src/systems/${name}/records/workspace.ia`,
    '.ia/release.json',
  ]);
  expect(machine.plan.starter.descriptor.id).toBe(machine.plan.starter.id);
  const pin = JSON.parse(readFileSync(resolve(cli, 'assets/base.json'), 'utf8')) as { id: string };
  expect(machine.plan.starter.descriptor.dependencies.map((row) => row.id)).toEqual([pin.id]);
  expect(machine.plan.starter.base).toMatchObject({ id: pin.id, archive: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(machine.plan.host).toEqual({ selected: 'none', status: 'none' });
  // The rendered "Starter records" row shows the contents rather than the plan task that specified them.
  expect(plan.stdout).toContain(`@system ${name} and its steward`);
  expect(plan.stdout).not.toContain('M5.1');
  expect(JSON.parse((await run(['init', '--host', 'claude', '--json'], { cwd: empty })).stdout).plan.host).toEqual({
    selected: 'claude',
    status: 'planned',
  });

  // A directory that does not exist yet is a legal target, and the plan says so rather than implying a read.
  const fresh = await run(['init', 'new-workspace'], { cwd: empty });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('does not exist yet');
  expect(existsSync(resolve(empty, 'new-workspace'))).toBe(false);

  // Host registration spec §4: without --apply a selected host is planned and nothing is written for it, the
  // payload included; unattended --apply with a host still needs --yes, refused at parse time (contract §2.1).
  const hostHome = scratch('init-host-home');
  const hosted = await run(['init', '--host', 'claude'], { cwd: empty, env: { IA_HOST_HOME: hostHome } });
  expect(hosted.exitCode).toBe(0);
  // §6.4 wraps the row at 80 columns, so the words are compared with the break folded back to a space.
  expect(hosted.stdout.replace(/\s+/g, ' ')).toContain(
    '--host claude selected; registered after initialization by ia host',
  );
  for (const selected of ['claude', 'codex']) {
    const refusal = JSON.parse(
      (await run(['init', '--apply', '--host', selected, '--json'], { cwd: empty, env: { IA_HOST_HOME: hostHome } }))
        .stdout,
    );
    expect(refusal).toMatchObject({ version: 1, ok: false, code: 'IA-CLI-USAGE', exit: 2 });
  }
  expect(readdirSync(empty)).toEqual([]);
  expect(readdirSync(hostHome)).toEqual([]);
  // Class 2 precedes class 3: the confirmation check runs at parse time, before anything looks at the target.
  expect((await run(['init', '--apply'], { cwd: empty })).exitCode).toBe(2);
  expect((await run(['init', '--host', 'emacs'], { cwd: empty })).exitCode).toBe(2);
  writeFileSync(resolve(empty, 'file'), 'not a directory\n');
  const file = await run(['init', 'file'], { cwd: empty });
  expect(file.exitCode).toBe(2);
  // Same class as consumer.test.ts's root-discovery case: init.ts:48 interpolates the target into the message and
  // §6.4 wraps at 80, so the phrase straddles the break for target lengths 45-56 and 64-70. Both runners sit
  // outside those bands today, which is luck rather than design. The property asserted is the wording.
  expect(file.stderr.replace(/\s+/g, ' ')).toContain('not a directory');
  expect((await run(['init', 'absent/deeper'], { cwd: empty })).exitCode).toBe(2);
});

it('detects each conflict condition against a workspace that already exists', async () => {
  const root = workspace();
  const authored = await run(['init', root]);
  expect(authored.exitCode).toBe(0);
  expect(authored.stdout).toContain('.ia/src');
  expect(authored.stdout).toContain('already holds authored records');
  expect(authored.stdout).not.toContain('None. The target');

  writeFileSync(resolve(root, '.ia/distributions.lock.json'), '{}\n');
  const locked = JSON.parse((await run(['init', root, '--json'])).stdout) as {
    plan: { conflicts: { path: string }[] };
  };
  // The third row is the reader's own refusal to read a lock with no activation: its words, reported as a conflict.
  expect(locked.plan.conflicts.map((conflict) => conflict.path)).toEqual([
    '.ia/src',
    '.ia/distributions.lock.json',
    '.ia/distributions/',
  ]);

  // §2.1: an interrupted apply is not a conflict row but a refusal, because nothing may reason about the state.
  mkdirSync(resolve(root, '.ia/distributions'), { recursive: true });
  writeFileSync(resolve(root, '.ia/distributions/pending.json'), '{}\n');
  const pending = await run(['init', root]);
  expect(pending.exitCode).toBe(3);
  expect(pending.stderr).toContain('IA-DB-SOURCE-UNAVAILABLE');
  expect(pending.stderr).toContain('ia-distribution recover');
});

it('checks formatting by default, rewrites only with --write, and refuses a path outside the root', async () => {
  const root = workspace();
  const clean = await run(['format', '--root', root]);
  expect(clean.exitCode).toBe(0);
  expect(clean.stdout).toContain('files match the formatter');
  expect(clean.stdout).toContain("the formatter's domain");

  deform(root);
  const differs = await run(['format', '--root', root, '--check']);
  expect(differs.exitCode).toBe(1);
  expect(differs.stdout).toContain('1 of 18 files differ from the formatter');
  expect(differs.stdout).toContain(FORMATTABLE);
  const machine = JSON.parse((await run(['format', '--root', root, '--json'])).stdout) as {
    mode: string;
    changed: number;
    files: { path: string; status: string }[];
  };
  expect(machine).toMatchObject({ version: 1, root, mode: 'check', changed: 1 });
  expect(machine.files.find((file) => file.path === FORMATTABLE)?.status).toBe('differs');
  expect(machine.files.some((file) => file.status === 'unsupported')).toBe(true);
  // --check writes nothing, which is why it is the default.
  expect(readFileSync(resolve(root, FORMATTABLE), 'utf8')).toContain('  meaning   \n');

  const written = await run(['format', '--root', root, '--write']);
  expect(written.exitCode).toBe(0);
  expect(written.stdout).toContain('Rewrote 1 of 18 files');
  expect(readFileSync(resolve(root, FORMATTABLE), 'utf8')).not.toContain('  meaning   \n');
  expect((await run(['format', '--root', root])).exitCode).toBe(0);

  expect((await run(['format', '--root', root, '--check', '--write'])).exitCode).toBe(2);
  const unsafe = await run(['format', '--root', root, '../elsewhere']);
  expect(unsafe.exitCode).toBe(3);
  expect(unsafe.stderr).toContain('IA-DIST-PATH-UNSAFE');
  // Formatting requires an admitted workspace: the draft machinery refuses to reason about a refused one.
  const broken = workspace({ foreign: true });
  const closure = await run(['format', '--root', broken]);
  expect(closure.exitCode).toBe(3);
  expect(closure.stderr).toContain('IA-DIST-CLOSURE-INCOMPLETE');
});

it('runs ia compile as a deprecated alias of ia capture, mapping --force and refusing --out and --stdout', async () => {
  const root = workspace();
  // The alias is capture: the same report, the same snapshot store, and no compiled.json.
  const first = await run(['compile', '--root', root]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain('Capture');
  expect(first.stdout).toContain('.ia/work/snapshot');
  // Deprecated for 2.x: the notice is one stderr line, text mode only.
  expect(first.stderr).toBe(`${COMPILE_DEPRECATION}\n`);
  expect(first.stderr).toContain('ia capture');
  expect(existsSync(resolve(root, '.ia/work/compiled.json'))).toBe(false);
  const bytes = stored(root, 'current');
  const captured = await capture(root);
  expect(captured).toMatchObject({ written: false, changed: 0, unchanged: captured.records });

  // --json prints capture's envelope and keeps stderr empty; a second run is the ordinary case, never a refusal.
  const machine = await run(['compile', '--root', root, '--json']);
  expect(machine.exitCode).toBe(0);
  expect(machine.stderr).toBe('');
  expect(JSON.parse(machine.stdout)).toEqual(captured);

  // --force maps onto capture, which always replaces the stored current (rotating only on a revision change).
  const forced = await run(['compile', '--root', root, '--force', '--json']);
  expect(forced.exitCode).toBe(0);
  expect(JSON.parse(forced.stdout)).toEqual(captured);
  expect(stored(root, 'current')).toBe(bytes);

  // --out and --stdout have no capture equivalent: usage refusals, before any read, naming the capture command.
  for (const [flags, next] of [
    [['--out', '.ia/work/elsewhere.json'], 'Run "ia capture"'],
    [['--stdout'], 'Run "ia capture --preview --json"'],
  ] as const) {
    const refused = await run(['compile', '--root', root, ...flags, '--json']);
    expect(refused.exitCode, flags.join(' ')).toBe(2);
    expect(refused.stderr).toBe('');
    const body = JSON.parse(refused.stdout) as { code: string; next: string };
    expect(body.code).toBe('IA-CLI-USAGE');
    expect(body.next).toContain(next);
    const told = await run(['compile', '--root', root, ...flags]);
    expect(told.exitCode).toBe(2);
    expect(told.stderr).toContain(next);
    expect(told.stdout).toBe('');
  }
  expect(existsSync(resolve(root, '.ia/work/elsewhere.json'))).toBe(false);
  // Both former options together are refused the same way, naming the capture command, not the help text.
  const both = await run(['compile', '--root', root, '--out', 'x', '--stdout', '--json']);
  expect(both.exitCode).toBe(2);
  const bothBody = JSON.parse(both.stdout) as { code: string; next: string };
  expect(bothBody.code).toBe('IA-CLI-USAGE');
  expect(bothBody.next).toContain('Run "ia capture');
  expect(bothBody.next).not.toContain('--help');

  // Admission findings exit 1 as capture's do, and the snapshot is still kept.
  const broken = workspace({ foreign: true });
  const found = await run(['compile', '--root', broken, '--json']);
  expect(found.exitCode).toBe(1);
  expect(JSON.parse(found.stdout).validation.errors).toBeGreaterThan(0);
  expect(existsSync(resolve(broken, '.ia/work/snapshot/current.json'))).toBe(true);
  expect(existsSync(resolve(broken, '.ia/work/compiled.json'))).toBe(false);

  // The ./internal/compile module keeps its ia.compiled.v1 builder for 2.x, though no verb writes it.
  const artifact = collectCompile(root).artifact;
  expect(artifact.artifact).toBe(ARTIFACT);
  expect(artifact.records.length).toBeGreaterThanOrEqual(captured.records);
  expect(artifact.root).toBe(root);
});

it('keeps the ./internal/compile builder deterministic and never rolls not-evaluated into a pass', () => {
  const root = workspace();
  const view = collectCompile(root);
  // Read back from the serialized bytes, as a consumer of the document would.
  const artifact = JSON.parse(view.text) as {
    formatVersion: number;
    artifact: string;
    language: string;
    kernelDigest: string;
    records: { identity: string }[];
    diagnostics: { code: string; severity: string }[];
    counts: Record<string, number>;
  };
  expect(artifact.formatVersion).toBe(1);
  expect(artifact.artifact).toBe(ARTIFACT);
  expect(artifact.language).toBe('1.0');
  expect(artifact.kernelDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(artifact.counts['records']).toBe(artifact.records.length);
  // A check with no evaluator is carried into the diagnostics and its own count, never counted as a pass.
  expect(artifact.counts['notEvaluated']).toBeGreaterThan(0);
  expect(artifact.diagnostics.some((finding) => finding.code === 'IA-COMP-NOT-EVALUATED')).toBe(true);
  expect(artifact.counts['notEvaluated']).toBe(
    artifact.diagnostics.filter((finding) => NOT_EVALUATED.has(finding.code)).length,
  );
  // Sorted by canonical identity and serialized with sorted keys, so two builds are byte-identical.
  expect([...artifact.records].sort((a, b) => (a.identity < b.identity ? -1 : 1))).toEqual(artifact.records);
  const text = view.text;
  const keys = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(keys);
    else if (value !== null && typeof value === 'object') {
      expect(Object.keys(value)).toEqual([...Object.keys(value)].sort());
      Object.values(value).forEach(keys);
    }
  };
  keys(artifact);
  expect(text.endsWith('}\n')).toBe(true);
  expect(view.digest).toBe(sha256(text));
  const again = collectCompile(root);
  expect(again.text).toBe(text);
  expect(again.digest).toBe(view.digest);

  // A workspace with an error still builds; the error is counted, not hidden.
  const broken = collectCompile(workspace({ foreign: true })).artifact;
  expect(broken.counts.errors).toBeGreaterThan(0);
  expect(broken.counts.notEvaluated).toBeGreaterThan(0);
});

interface CaptureEnvelope {
  version: number;
  preview: boolean;
  store: string;
  revision: string;
  previous: string | null;
  written: boolean;
  rotated: boolean;
  records: number;
  changed: number;
  unchanged: number;
  new: number;
  removed: number;
  validation: { errors: number; warnings: number; notEvaluated: number };
}
interface StoredSnapshot {
  format: string;
  revision: string;
  membership: { identity: string; seat: string | null; root: string; band: number; digest: string }[];
}
const capture = async (root: string, ...flags: string[]): Promise<CaptureEnvelope> => {
  const got = await run(['capture', '--root', root, ...flags, '--json']);
  expect(got.stderr).toBe('');
  expect([0, 1], got.stdout).toContain(got.exitCode);
  return JSON.parse(got.stdout) as CaptureEnvelope;
};
const stored = (root: string, slot: 'current' | 'previous'): string =>
  readFileSync(resolve(root, `.ia/work/snapshot/${slot}.json`), 'utf8');
const reword = (root: string, from: string, to: string): void => {
  const path = resolve(root, FORMATTABLE);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${FORMATTABLE} no longer contains ${from}`);
  writeFileSync(path, text.replace(from, to));
};

it('captures current and previous snapshots with per-record digests and membership, rotating only on change', async () => {
  const root = workspace();
  const first = await capture(root);
  expect(first).toMatchObject({
    version: 1,
    preview: false,
    store: '.ia/work/snapshot',
    previous: null,
    written: true,
    rotated: false,
    changed: 0,
    unchanged: 0,
    removed: 0,
    validation: { errors: 0 },
  });
  expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(first.records).toBeGreaterThan(0);
  expect(first.new).toBe(first.records);
  expect(first.validation.notEvaluated).toBeGreaterThan(0);
  const bytes = stored(root, 'current');
  const snapshot = JSON.parse(bytes) as StoredSnapshot;
  expect(snapshot.format).toBe('ia-snapshot-1');
  expect(snapshot.revision).toBe(first.revision);
  expect(snapshot.membership).toHaveLength(first.records);
  for (const row of snapshot.membership) {
    expect(row.digest, row.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(row.root.startsWith('/'), row.identity).toBe(false);
  }
  expect(snapshot.membership.some((row) => row.seat !== null)).toBe(true);
  // The snapshot regenerates per clone: no absolute root, and the store ignores itself.
  expect(bytes).not.toContain(root);
  expect(bytes).not.toContain(realpathSync(root));
  expect(readFileSync(resolve(root, '.ia/work/snapshot/.gitignore'), 'utf8')).toContain('*');
  expect(existsSync(resolve(root, '.ia/work/snapshot/previous.json'))).toBe(false);

  // Two consecutive captures without edits: nothing changed, nothing rewritten, nothing rotated.
  const second = await capture(root);
  expect(second).toMatchObject({
    revision: first.revision,
    previous: null,
    written: false,
    rotated: false,
    records: first.records,
    changed: 0,
    unchanged: first.records,
    new: 0,
    removed: 0,
  });
  expect(stored(root, 'current')).toBe(bytes);

  // One record's text changes: exactly that record changed, and the old current becomes previous.
  reword(root, 'Sample fixture statement 1.', 'Sample fixture statement one.');
  const third = await capture(root);
  expect(third.revision).not.toBe(first.revision);
  expect(third).toMatchObject({ previous: first.revision, written: true, rotated: true, changed: 1, new: 0 });
  expect(third.unchanged).toBe(first.records - 1);
  expect(stored(root, 'previous')).toBe(bytes);
  const retained = stored(root, 'previous');

  // A re-capture with no change keeps previous.
  const fourth = await capture(root);
  expect(fourth).toMatchObject({ revision: third.revision, previous: first.revision, rotated: false, changed: 0 });
  expect(stored(root, 'previous')).toBe(retained);

  // --preview computes the same report and writes nothing.
  const current = stored(root, 'current');
  reword(root, 'Sample fixture statement 2.', 'Sample fixture statement two.');
  const preview = await capture(root, '--preview');
  expect(preview).toMatchObject({
    preview: true,
    written: false,
    rotated: false,
    previous: third.revision,
    changed: 1,
  });
  expect(preview.revision).not.toBe(third.revision);
  expect(stored(root, 'current')).toBe(current);
  expect(stored(root, 'previous')).toBe(retained);

  const text = await run(['capture', '--root', root]);
  expect(text.exitCode).toBe(0);
  expect(text.stderr).toBe('');
  expect(text.stdout).toContain('Capture');
  expect(text.stdout).toContain('1 changed');
  expect(text.stdout).toContain('.ia/work/snapshot');
  expect(text.stdout).not.toContain(root);
  expect(JSON.parse(stored(root, 'previous')).revision).toBe(third.revision);
});

it('retains admission findings in the capture, and refuses with a next command only when nothing can be admitted', async () => {
  // Unresolved and foreign records are findings, not refusals: the snapshot is written and the exit carries them.
  const foreign = workspace({ foreign: true });
  const found = await run(['capture', '--root', foreign, '--json']);
  expect(found.exitCode).toBe(1);
  expect(JSON.parse(found.stdout)).toMatchObject({ written: true, validation: { errors: expect.any(Number) } });
  expect(JSON.parse(found.stdout).validation.errors).toBeGreaterThan(0);
  expect(existsSync(resolve(foreign, '.ia/work/snapshot/current.json'))).toBe(true);

  // No @workspace at this root: refused before anything is written, naming ia init.
  const bare = workspace();
  rmSync(resolve(bare, '.ia/src/systems/workspace-system/records/foundation-workspace.ia'));
  const missing = await run(['capture', '--root', bare, '--json']);
  expect(missing.exitCode).toBe(3);
  expect(missing.stderr).toBe('');
  const refusal = JSON.parse(missing.stdout) as { ok: boolean; code: string; next: string };
  expect(refusal).toMatchObject({ ok: false, code: 'IA-CLI-WORKSPACE-UNDECLARED' });
  expect(refusal.next).toContain('ia init');
  expect(existsSync(resolve(bare, '.ia/work/snapshot'))).toBe(false);
  const told = await run(['capture', '--root', bare]);
  expect(told.exitCode).toBe(3);
  expect(told.stderr).toContain('IA-CLI-WORKSPACE-UNDECLARED');
  expect(told.stderr).toContain('ia init');

  // A floor input that fails to parse: refused, the previous snapshot kept, naming ia validate.
  const root = workspace();
  await capture(root);
  const kept = stored(root, 'current');
  const floor = resolve(root, '.ia/src/floor/move.ia');
  writeFileSync(floor, readFileSync(floor, 'utf8').replace('#! ia 1.0\n', ''));
  const unparsed = await run(['capture', '--root', root, '--json']);
  expect(unparsed.exitCode).toBe(3);
  const floored = JSON.parse(unparsed.stdout) as { code: string; next: string; where: { path: string } };
  expect(floored.code).toBe('IA-CLI-FLOOR-UNPARSED');
  expect(floored.where.path).toBe('.ia/src/floor/move.ia');
  expect(floored.next).toContain('ia validate');
  expect(stored(root, 'current')).toBe(kept);
  expect((await run(['capture', '--root', root, '--preview', '--json'])).exitCode).toBe(3);

  // An unreadable root is the open's own refusal, and it too names a next command.
  const absent = JSON.parse((await run(['capture', '--root', scratch('no-root'), '--json'])).stdout) as {
    next: string;
  };
  expect(absent.next.trim()).not.toBe('');
});

it('diagnoses runtime, workspace and installation state in five buckets without repairing anything', async () => {
  const empty = scratch('doctor');
  // Host plugin distribution spec §7.3's rows read the IA home, so a scratch one keeps them deterministic.
  const home = resolve(scratch('doctor-home'), '.ia'),
    env = { IA_HOME: home };
  const absent = await run(['doctor'], { cwd: empty, env });
  expect(absent.exitCode).toBe(0);
  expect(absent.stdout).toContain('Environment');
  expect(absent.stdout).toContain('No .ia/src directory here or in any parent');
  // §2.12: a check that could not be performed is `?`, never a pass, and the totals account for every row.
  expect(absent.stdout).toContain('Not checked; no workspace');
  expect(absent.stdout).not.toMatch(/✔ {2}(Records|Generation|Pending state)/);
  expect(absent.stdout).not.toMatch(/unsupported/i);

  const machine = JSON.parse((await run(['doctor', '--json'], { cwd: empty, env })).stdout) as {
    checks: { id: string; status: string; detail: string; remedy: string | null }[];
    counts: Record<string, number>;
  };
  const statuses = new Set(machine.checks.map((check) => check.status));
  expect([...statuses].sort()).toEqual(['info', 'ok', 'unknown', 'warn']);
  expect(Object.values(machine.counts).reduce((total, value) => total + value, 0)).toBe(machine.checks.length);
  expect(machine.counts['fail']).toBe(0);
  expect(machine.checks.find((check) => check.id === 'host')?.status).toBe('unknown');
  expect(machine.checks.find((check) => check.id === 'root')?.remedy).toBe('ia init');
  // §7.3: reported with or without a workspace; this package runs from this repository's checkout.
  expect(machine.checks.find((check) => check.id === 'install-channel')).toMatchObject({
    status: 'ok',
    detail: expect.stringMatching(/^checkout /),
  });
  expect(machine.checks.find((check) => check.id === 'ia-home')).toEqual({
    id: 'ia-home',
    title: 'IA home',
    status: 'info',
    detail: `${home} (not created yet)`,
    remedy: null,
  });
  expect(machine.checks.find((check) => check.id === 'plugin-claude')).toEqual({
    id: 'plugin-claude',
    title: 'Claude plugin',
    status: 'info',
    detail: 'Not installed',
    remedy: 'ia host claude --user --apply',
  });
  expect(machine.checks.find((check) => check.id === 'workspace-decision')).toEqual({
    id: 'workspace-decision',
    title: 'Initialization decision',
    status: 'info',
    detail: 'None recorded',
    remedy: null,
  });
  expect(existsSync(home)).toBe(false);

  const root = workspace();
  const present = await run(['doctor', '--root', root], { env });
  expect(present.exitCode).toBe(0);
  expect(present.stdout).toContain('158 records, 0 errors');
  expect(present.stdout).toContain('0 archives in .ia/distributions/cache');
  // §9.2: a decision is a fact about a directory that is not a workspace, so a workspace has no such row.
  const presentRows = JSON.parse((await run(['doctor', '--root', root, '--json'], { env })).stdout).checks as {
    id: string;
  }[];
  expect(presentRows.map((check) => check.id)).toEqual(
    expect.arrayContaining(['install-channel', 'ia-home', 'plugin-claude']),
  );
  expect(presentRows.find((check) => check.id === 'workspace-decision')).toBeUndefined();

  // An interrupted apply is the one installation fail, and its remedy is on the other binary, which it says.
  mkdirSync(resolve(root, '.ia/distributions'), { recursive: true });
  writeFileSync(resolve(root, '.ia/distributions/pending.json'), '{}\n');
  const interrupted = await run(['doctor', '--root', root], { env });
  expect(interrupted.exitCode).toBe(1);
  expect(interrupted.stdout).toContain('.ia/distributions/pending.json exists');
  expect(interrupted.stdout).toContain('ia-distribution recover --root');
  expect(interrupted.stdout).toContain('Not checked; installation recovery is required first');
  const failed = JSON.parse((await run(['doctor', '--root', root, '--json'], { env })).stdout) as {
    checks: { id: string; status: string }[];
    counts: Record<string, number>;
  };
  expect(failed.counts['fail']).toBe(1);
  expect(failed.checks.find((check) => check.id === 'records')?.status).toBe('unknown');
  rmSync(resolve(root, '.ia/distributions/pending.json'));

  // The runtime is a parameter, so the declared support target is compared against an observation, not assumed.
  const foreign = collectDoctor({
    cwd: root,
    packageRoot: cli,
    runtime: { version: 'v20.11.0', platform: 'darwin', arch: 'arm64' },
    env,
  });
  const support = foreign.checks.find((check) => check.id === 'support-target')!;
  expect(support.status).toBe('warn');
  expect(support.detail).toContain('not qualified');
  expect(support.detail).not.toMatch(/unsupported/i);
  expect(foreign.checks.find((check) => check.id === 'node')?.status).toBe('fail');
  const current = collectDoctor({
    cwd: root,
    packageRoot: cli,
    runtime: { version: 'v22.22.0', platform: 'win32', arch: 'x64' },
    env: { ...env, npm_config_user_agent: 'pnpm/12.9.0 npm/? node/v22.22.0 win32 x64' },
  });
  expect(current.checks.find((check) => check.id === 'support-target')?.status).toBe('ok');
  const doctorOn = (platform: string, arch: string) =>
    collectDoctor({
      cwd: root,
      packageRoot: cli,
      runtime: { version: 'v22.22.0', platform, arch },
      env: {},
    }).checks.find((check) => check.id === 'support-target')!;
  expect(doctorOn('darwin', 'arm64').status).toBe('ok');
  // The whole sentence, because its list of targets is built from the same pairs the verdict checks.
  expect(doctorOn('darwin', 'x64')).toMatchObject({
    status: 'warn',
    detail:
      'darwin x64 on Node v22.22.0 is outside the declared target of Linux x64, Windows x64 and macOS arm64 on Node 22 from 22.22.0; it is not qualified',
    remedy:
      'If this Mac has Apple silicon, this x64 build of Node runs under Rosetta: install the arm64 build. Intel Macs are outside the declared target.',
  });
  // Only the Rosetta case has a remedy: another unsupported pair has no install to suggest.
  expect(doctorOn('linux', 'arm64').remedy).toBeNull();
  expect(doctorOn('darwin', 'arm64').remedy).toBeNull();
  // The Rosetta remedy is for macOS only: an unsupported x64 pair elsewhere gets none.
  expect(doctorOn('freebsd', 'x64').remedy).toBeNull();
  // The target is a list of pairs, so each pair is pinned: Linux x64 is in, and no other ARM platform is.
  expect(doctorOn('linux', 'x64').status).toBe('ok');
  expect(doctorOn('linux', 'arm64').status).toBe('warn');
  expect(doctorOn('win32', 'arm64').status).toBe('warn');
  // pnpm is a contributor requirement, so it is a note in both directions and never decides the exit class.
  expect(current.checks.find((check) => check.id === 'package-manager')?.status).toBe('info');
  expect(current.checks.find((check) => check.id === 'package-manager')?.detail).toBe(
    'pnpm 12.9.0 invoked this command',
  );
  // Without a user agent, the note names no pnpm version: a consumer installation cannot know the repository's pin.
  const unreported = collectDoctor({
    cwd: root,
    packageRoot: cli,
    runtime: { version: 'v22.22.0', platform: 'win32', arch: 'x64' },
    env: {},
  }).checks.find((check) => check.id === 'package-manager');
  expect(unreported).toMatchObject({
    status: 'info',
    detail: 'Not reported by this invocation; pnpm is a contributor requirement, not a consumer one',
  });
});

it('reads the body behind a locator and prints that body only, refusing with a next command', async () => {
  const root = withSteward(workspace());
  // The plan's exit: an @agent's says text, and nothing else on either stream.
  expect(await run(['read', STEWARD, '--root', root])).toEqual({
    exitCode: 0,
    stdout: `${STEWARD_SAYS}\n`,
    stderr: '',
  });
  const machine = JSON.parse((await run(['read', STEWARD, '--root', root, '--json'])).stdout) as Record<
    string,
    unknown
  >;
  const inspected = JSON.parse((await run(['inspect', STEWARD, '--root', root, '--json'])).stdout) as {
    records: { digest: string }[];
  };
  expect(machine).toEqual({
    version: 1,
    identity: STEWARD,
    fragment: null,
    source: 'record',
    digest: inspected.records[0]!.digest,
    body: STEWARD_SAYS,
  });

  // A cell, a requirement and a source line each read their own text; structure stays in ia inspect.
  const procedure = 'governance-system/definition/procedure/sample-procedure';
  expect((await run(['read', `${procedure}#orient/Decision`, '--root', root])).stdout).toBe(
    'Sample fixture statement 6.\n',
  );
  expect(
    JSON.parse((await run(['read', `${procedure}#orient/Decision`, '--root', root, '--json'])).stdout),
  ).toMatchObject({ identity: procedure, fragment: 'orient/Decision' });
  expect(
    (
      await run([
        'read',
        'compliance-system/contract/signature/foundation-authoring-contract#REQ-FOUNDATION-INPUT',
        '--root',
        root,
      ])
    ).stdout,
  ).toBe('Supply the intended owner, complete native registry closure and authored record source.\n');
  expect((await run(['read', `${STEWARD_COPY}:5`, '--root', root])).stdout).toBe(`${STEWARD_SAYS}\n`);
  // `./`, `../` and doubled slashes reach the same source line.
  const [stewardDir, stewardFile] = [
    STEWARD_COPY.slice(0, STEWARD_COPY.lastIndexOf('/')),
    STEWARD_COPY.slice(STEWARD_COPY.lastIndexOf('/') + 1),
  ];
  for (const spelled of [
    `./${STEWARD_COPY}`,
    `${stewardDir}/../records/${stewardFile}`,
    `${stewardDir}//${stewardFile}`,
  ])
    expect((await run(['read', `${spelled}:5`, '--root', root])).stdout, spelled).toBe(`${STEWARD_SAYS}\n`);

  // Every refusal names one next command, in both forms.
  const refused: readonly (readonly [readonly string[], string, number, string])[] = [
    [['read', 'Not/An/Identity/X'], 'IA-RUNTIME-REQUEST-INVALID', 2, '"ia read --help"'],
    [['read', `${procedure}#orient`], 'IA-RUNTIME-REQUEST-INVALID', 2, '"ia read --help"'],
    [['read'], 'IA-CLI-USAGE', 2, '"ia read --help"'],
    [['read', 'no-such/definition/procedure/record'], 'IA-DB-SOURCE-UNAVAILABLE', 1, '"ia inspect"'],
    [['read', `${procedure}#REQ-NOT-HERE`], 'IA-DB-SOURCE-UNAVAILABLE', 1, `"ia inspect ${procedure}"`],
    [['read', 'floor/contract/head/agent'], 'IA-DB-SOURCE-UNAVAILABLE', 1, '"ia inspect floor/contract/head/agent"'],
    [['read', `${STEWARD_COPY}:1`], 'IA-DB-SOURCE-UNAVAILABLE', 1, `"ia inspect --path ${STEWARD_COPY}"`],
    // A path the shell would split is quoted inside the next command.
    [['read', 'my notes/x.ia:1'], 'IA-DB-SOURCE-UNAVAILABLE', 1, '"ia inspect --path "my notes/x.ia""'],
    // A line held by a record with no body names that record, whose structure is what there is to see.
    [
      ['read', '.ia/src/floor/kernel.schema.ia:3'],
      'IA-DB-SOURCE-UNAVAILABLE',
      1,
      '"ia inspect floor/contract/head/kernel-kind"',
    ],
  ];
  for (const [argv, code, exit, next] of refused) {
    const label = argv.join(' ');
    const machine = await run([...argv, '--root', root, '--json']);
    expect(machine.exitCode, label).toBe(exit);
    expect(machine.stderr, label).toBe('');
    const body = JSON.parse(machine.stdout) as { ok: boolean; code: string; next: string };
    expect(body, label).toMatchObject({ ok: false, code });
    expect(body.next, label).toContain(next);
    const human = await run([...argv, '--root', root]);
    expect(human.exitCode, label).toBe(exit);
    expect(human.stdout, label).toBe('');
    expect(human.stderr, label).toContain(code);
    // The human block wraps at the terminal width, so the next command is compared with its spacing collapsed.
    expect(human.stderr.replace(/\s+/g, ' '), label).toContain(next);
  }
  const bodyless = JSON.parse(
    (await run(['read', '.ia/src/floor/kernel.schema.ia:3', '--root', root, '--json'])).stdout,
  ) as { where: unknown };
  expect(bodyless.where).toEqual({
    path: '.ia/src/floor/kernel.schema.ia',
    line: 3,
    identity: 'floor/contract/head/kernel-kind',
  });

  // A `#` in a source path is part of the path, not a fragment.
  const hashed = '.ia/src/systems/agent-system/records/steward#copy.ia';
  renameSync(resolve(root, STEWARD_COPY), resolve(root, hashed));
  expect(await run(['read', `${hashed}:5`, '--root', root])).toEqual({
    exitCode: 0,
    stdout: `${STEWARD_SAYS}\n`,
    stderr: '',
  });

  // An unreadable root is the open's own refusal, and it too names a next command.
  const absent = await run(['read', STEWARD, '--root', resolve(scratch('no-read-root'), 'absent'), '--json']);
  expect(absent.exitCode).toBe(3);
  expect((JSON.parse(absent.stdout) as { next: string }).next.trim()).not.toBe('');
});

it("keeps every new verb's --json stdout one parseable value with no ANSI, in success and in refusal", async () => {
  const root = workspace();
  const empty = scratch('json');
  // IA_HOST_HOME keeps `init --host`'s payload in scratch rather than the real IA home.
  const options = { isTTY: true, columns: 120, env: { FORCE_COLOR: '1', IA_HOST_HOME: scratch('json-host-home') } };
  const invocations: readonly { readonly argv: readonly string[]; readonly refusal: boolean }[] = [
    { argv: ['init', '--json'], refusal: false },
    { argv: ['init', 'hosted', '--apply', '--yes', '--host', 'claude', '--json'], refusal: false },
    { argv: ['init', 'applied', '--apply', '--yes', '--json'], refusal: false },
    { argv: ['init', 'applied', '--apply', '--yes', '--json'], refusal: true },
    { argv: ['format', '--root', root, '--json'], refusal: false },
    { argv: ['format', '--root', root, '../outside', '--json'], refusal: true },
    { argv: ['compile', '--root', root, '--json'], refusal: false },
    { argv: ['compile', '--root', root, '--out', '.ia/work/x.json', '--json'], refusal: true },
    { argv: ['compile', '--root', root, '--stdout', '--json'], refusal: true },
    { argv: ['capture', '--root', root, '--json'], refusal: false },
    { argv: ['capture', '--root', root, '--preview', '--json'], refusal: false },
    { argv: ['capture', '--root', empty, '--json'], refusal: true },
    {
      argv: ['read', 'governance-system/definition/procedure/sample-procedure', '--root', root, '--json'],
      refusal: false,
    },
    { argv: ['read', 'no-such/definition/procedure/record', '--root', root, '--json'], refusal: true },
    { argv: ['doctor', '--json'], refusal: false },
    { argv: ['pack', '--root', root, '--descriptor', '.ia/work/absent.json', '--json'], refusal: true },
    { argv: ['install', 'a/b', '--root', root, '--offline', '--json'], refusal: true },
    { argv: ['remove', 'a/b', '--root', root, '--json'], refusal: true },
  ];
  for (const { argv, refusal } of invocations) {
    const result = await run(argv, { ...options, cwd: empty });
    // §5 and §4.3: the result envelope and the refusal object are both the one value on stdout.
    const stream = result.stdout;
    expect(stream, argv.join(' ')).not.toMatch(ANSI);
    expect(stream.endsWith('\n'), argv.join(' ')).toBe(true);
    expect(stream.slice(0, -1), argv.join(' ')).not.toContain('\n');
    expect(() => JSON.parse(stream), argv.join(' ')).not.toThrow();
    expect(result.stderr, argv.join(' ')).toBe('');
    if (refusal) expect(JSON.parse(stream), argv.join(' ')).toMatchObject({ version: 1, ok: false });
  }
});

it('keeps ia inspect working when a host state file is corrupted, reporting it stale rather than crashing', async () => {
  const root = workspace(),
    cache = scratch('host-cache');
  const inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] }),
    launcher = '// l\n';
  mkdirSync(resolve(cache, 'scripts'), { recursive: true });
  writeFileSync(resolve(cache, 'inventory.json'), inventory);
  writeFileSync(resolve(cache, 'scripts/ia.mjs'), launcher);
  writeFileSync(
    resolve(cache, 'release.json'),
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  applyHost(planHost(root, 'claude', cache));
  // Disk corruption or a truncated write, not anything `ia host` itself produces.
  writeFileSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'), 'not json at all');
  const result = await run(['inspect', '--root', root, '--json']);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as {
    overview: { installation: { hosts: readonly { host: string; status: string }[] } };
  };
  expect(body.overview.installation.hosts).toEqual([{ host: 'claude', status: 'stale' }]);
  // The human overview names the host, its status and, for a stale one, why.
  const human = await run(['inspect', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toMatch(/Host +claude stale \(state-invalid\)/);
  expect(human.stdout).not.toContain('Not reported');
});

it('shows the observed host state in the inspect overview, compared against the payload this installation pins', async () => {
  const root = workspace();
  const none = await run(['inspect', '--root', root]);
  expect(none.exitCode).toBe(0);
  expect(none.stdout).toMatch(/Host +No host registered/);
  expect(none.stdout).not.toContain('Not reported');
  // The payload this package pins, materialized as `ia host --apply` would, so the registration matches the pin.
  const bundled = readHostPin(cli);
  const cache = materializeHostPayload({
    home: scratch('host-home'),
    archive: bundled.archive(),
    pin: bundled.pin,
  }).directory;
  applyHost(planHost(root, 'claude', cache));
  const human = await run(['inspect', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toMatch(/Host +claude registered/);
  const machine = JSON.parse((await run(['inspect', '--root', root, '--json'])).stdout) as {
    overview: { installation: { hosts: unknown } };
  };
  expect(machine.overview.installation.hosts).toEqual([{ host: 'claude', status: 'registered' }]);
  // A registration pinned to another release than this installation's is stale here, as it is in ia doctor.
  const other = scratch('host-cache');
  const inventory = json({ format: 'ia.host-cache.v2', version: '0.1.0', packages: [], files: [] }),
    launcher = '// l\n';
  mkdirSync(resolve(other, 'scripts'), { recursive: true });
  writeFileSync(resolve(other, 'inventory.json'), inventory);
  writeFileSync(resolve(other, 'scripts/ia.mjs'), launcher);
  writeFileSync(
    resolve(other, 'release.json'),
    json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) }),
  );
  applyHost(planHost(root, 'claude', other));
  expect((await run(['inspect', '--root', root])).stdout).toMatch(/Host +claude stale \(release\)/);
});

it('refuses to capture a @workspace whose composition.sources entry is malformed, naming the entry and the form', async () => {
  const root = workspace();
  await capture(root);
  const kept = stored(root, 'current');
  const schema = resolve(root, '.ia/src/systems/workspace-system/schemas/workspace.schema.ia'),
    record = resolve(root, '.ia/src/systems/workspace-system/records/foundation-workspace.ia');
  writeFileSync(
    schema,
    readFileSync(schema, 'utf8').replace(
      /( +)must have composition\.systems as list of ref[^\n]*\n/,
      (line, indent: string) => `${line}${indent}may have composition.sources as list of text\n`,
    ),
  );
  writeFileSync(
    record,
    readFileSync(record, 'utf8').replace(
      /( +)systems \[[^\n]*\n/,
      (line, indent: string) => `${line}${indent}sources ["docs"]\n`,
    ),
  );
  const got = await run(['capture', '--root', root, '--json']);
  expect(got.exitCode).toBe(3);
  expect(got.stderr).toBe('');
  const refusal = JSON.parse(got.stdout) as { ok: boolean; code: string; message: string; next: string };
  expect(refusal).toMatchObject({ ok: false, code: 'IA-DB-SOURCES-INVALID' });
  expect(refusal.message).toContain('"docs"');
  expect(refusal.message).toContain('foundation-workspace.ia:');
  expect(refusal.next).toContain('<root> @<placement>');
  expect(refusal.next).toContain('ia capture');
  // Nothing is written: the stored snapshot is the one captured before the edit.
  expect(stored(root, 'current')).toBe(kept);
  const told = await run(['capture', '--root', root]);
  expect(told.exitCode).toBe(3);
  expect(told.stderr).toContain('IA-DB-SOURCES-INVALID');
});
