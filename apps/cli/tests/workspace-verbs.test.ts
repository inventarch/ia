/**
 * `ia init`, `ia format`, `ia compile` and `ia doctor`, against the committed loop fixture. `ia compile` is the
 * deprecated 1.x verb, unchanged but for its one stderr line naming `ia capture` (decision release-bump).
 *
 * Every verb is exercised in its human and `--json` form and in each exit class its §2 section declares, because
 * the exit class is the part a script depends on and the part a renderer change cannot be trusted to preserve.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { applyHost, planHost } from '@inventarch/distribution/host';
import { materializeHostPayload, readHostPin } from '@inventarch/distribution/host-home';
import { json, sha256 } from '@inventarch/distribution/services';
import {
  ARTIFACT,
  collectCompile,
  compileEnvelope,
  compileExit,
  DEFAULT_OUT,
  DEPRECATION,
  renderCompile,
} from '../src/compile.js';
import { collectDoctor } from '../src/doctor.js';
import { resolveCapabilities } from '../src/render.js';
import { cleanup, cli, FORMATTABLE, run, scratch, workspace } from './workspace-fixture.js';

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

it('compiles a deterministic artifact, refuses to overwrite it, and never rolls not-evaluated into a pass', async () => {
  // Decision release-bump: in 1.x `ia compile` keeps this behaviour and adds one stderr line naming `ia capture`.
  const root = workspace();
  const first = await run(['compile', '--root', root]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain('ia.compiled.v1');
  expect(first.stdout).toContain('not evaluated');
  expect(first.stderr).toBe(DEPRECATION);
  expect(DEPRECATION.split('\n')).toEqual([expect.stringContaining('"ia capture"'), '']);
  const path = resolve(root, '.ia/work/compiled.json');
  const bytes = readFileSync(path);
  const artifact = JSON.parse(bytes.toString('utf8')) as {
    formatVersion: number;
    artifact: string;
    language: string;
    kernelDigest: string;
    revision: string;
    records: { identity: string }[];
    diagnostics: { code: string }[];
    counts: Record<string, number>;
  };
  expect(artifact.formatVersion).toBe(1);
  expect(artifact.artifact).toBe('ia.compiled.v1');
  expect(artifact.language).toBe('1.0');
  expect(artifact.kernelDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(artifact.counts['records']).toBe(artifact.records.length);
  // ia.compiled.v1 predates graph G13, so its records and digest stay without the per-record digest.
  expect(artifact.records.some((record) => 'digest' in record)).toBe(false);
  expect(artifact.counts['notEvaluated']).toBeGreaterThan(0);
  expect(artifact.diagnostics.some((finding) => finding.code === 'IA-COMP-NOT-EVALUATED')).toBe(true);
  // Sorted by canonical identity and serialized with sorted keys, so two runs are byte-identical.
  expect([...artifact.records].sort((a, b) => (a.identity < b.identity ? -1 : 1))).toEqual(artifact.records);
  expect(Object.keys(artifact)).toEqual([...Object.keys(artifact)].sort());
  // The verb writes the 1.x artifact only; the capture's snapshot is `ia capture`'s alone.
  expect(existsSync(resolve(root, '.ia/work/snapshot'))).toBe(false);

  const again = await run(['compile', '--root', root]);
  expect(again.exitCode).toBe(3);
  expect(again.stderr).toContain('IA-DIST-LOCAL-MODIFICATION');
  expect(again.stderr).toContain('--force');
  expect(again.stderr).not.toContain(DEPRECATION.trim());
  const forcedRun = await run(['compile', '--root', root, '--force', '--json']);
  expect(forcedRun.stderr).toBe(DEPRECATION);
  const forced = JSON.parse(forcedRun.stdout) as {
    version: number;
    artifact: string;
    digest: string;
    counts: Record<string, number>;
  };
  expect(Object.keys(forced)).toEqual(['version', 'artifact', 'revision', 'digest', 'counts']);
  expect(forced.artifact).toBe(resolve(realpathSync(root), DEFAULT_OUT));
  expect(readFileSync(path)).toEqual(bytes);
  expect(forced.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(forced.counts['notEvaluated']).toBe(artifact.counts['notEvaluated']);

  const outside = await run(['compile', '--root', root, '--out', '.ia/elsewhere.json']);
  expect(outside.exitCode).toBe(3);
  expect(outside.stderr).toContain('IA-DIST-PATH-UNSAFE');
  expect(existsSync(resolve(root, '.ia/elsewhere.json'))).toBe(false);
  expect((await run(['compile', '--root', root, '--out', 'x', '--stdout'])).exitCode).toBe(2);
  const elsewhere = await run(['compile', '--root', root, '--out', '.ia/work/x.json', '--json']);
  expect(elsewhere.exitCode).toBe(0);
  expect(readFileSync(resolve(root, '.ia/work/x.json'))).toEqual(bytes);

  const streamed = await run(['compile', '--root', root, '--stdout']);
  expect(streamed.exitCode).toBe(0);
  expect(streamed.stdout).toBe(bytes.toString('utf8'));
  expect(streamed.stdout).not.toMatch(ANSI);
  expect(streamed.stderr).toBe(DEPRECATION);

  // A workspace with an error still produces an artifact; the exit class carries the verdict, not the file.
  const broken = workspace({ foreign: true });
  const refused = await run(['compile', '--root', broken, '--json']);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).counts.errors).toBeGreaterThan(0);
  expect(existsSync(resolve(broken, '.ia/work/compiled.json'))).toBe(true);
});

it('keeps the ia.compiled.v1 builders of @inventarch/cli/internal/compile deterministic and never a pass', () => {
  const root = realpathSync(workspace());
  const view = collectCompile(root);
  expect(compileExit(view)).toBe(0);
  const artifact = JSON.parse(view.text) as {
    formatVersion: number;
    artifact: string;
    language: string;
    kernelDigest: string;
    root: string;
    revision: string;
    records: { identity: string }[];
    diagnostics: { path: string; line: number; code: string; message: string }[];
    counts: Record<string, number>;
  };
  expect(artifact).toEqual(JSON.parse(JSON.stringify(view.artifact)));
  expect(artifact.formatVersion).toBe(1);
  expect(artifact.artifact).toBe(ARTIFACT);
  expect(artifact.language).toBe('1.0');
  expect(artifact.kernelDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(artifact.root).toBe(root);
  expect(artifact.counts['records']).toBe(artifact.records.length);
  // ia.compiled.v1 predates graph G13, so its records and digest stay without the per-record digest.
  expect(artifact.records.some((record) => 'digest' in record)).toBe(false);
  expect(artifact.counts['notEvaluated']).toBeGreaterThan(0);
  expect(artifact.diagnostics.some((finding) => finding.code === 'IA-COMP-NOT-EVALUATED')).toBe(true);
  // Diagnostics by (path, line, code, message), found at more than one path so the order is observable.
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  expect(new Set(artifact.diagnostics.map((finding) => finding.path)).size).toBeGreaterThan(1);
  expect(artifact.diagnostics).toEqual(
    [...artifact.diagnostics].sort(
      (a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.code, b.code) || compare(a.message, b.message),
    ),
  );
  // Sorted by canonical identity and serialized with sorted keys, so two builds are byte-identical.
  expect([...artifact.records].sort((a, b) => (a.identity < b.identity ? -1 : 1))).toEqual(artifact.records);
  expect(Object.keys(artifact)).toEqual([...Object.keys(artifact)].sort());
  expect(view.digest).toBe(sha256(view.text));
  expect(collectCompile(root).text).toBe(view.text);
  expect(compileEnvelope(view, resolve(root, DEFAULT_OUT))).toEqual({
    version: 1,
    artifact: resolve(root, DEFAULT_OUT),
    revision: artifact.revision,
    digest: view.digest,
    counts: artifact.counts,
  });
  const rendered = renderCompile(view, DEFAULT_OUT, resolveCapabilities({ env: {}, isTTY: false }, {}));
  expect(rendered).toContain(ARTIFACT);
  expect(rendered).toContain('not evaluated');
  expect(rendered).not.toMatch(ANSI);
  // A workspace with an error still builds an artifact; the exit class carries the verdict, not the artifact.
  const broken = collectCompile(realpathSync(workspace({ foreign: true })));
  expect(compileExit(broken)).toBe(1);
  expect(broken.artifact.counts.errors).toBeGreaterThan(0);
  // Building writes nothing.
  expect(existsSync(resolve(root, '.ia/work'))).toBe(false);
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
    { argv: ['capture', '--root', root, '--json'], refusal: false },
    { argv: ['capture', '--root', root, '--json'], refusal: false },
    { argv: ['compile', '--root', root, '--json'], refusal: false },
    { argv: ['compile', '--root', root, '--json'], refusal: true },
    { argv: ['compile', '--root', root, '--stdout', '--json'], refusal: false },
    { argv: ['read', 'agent-system/binding/agent/agent-steward', '--root', root, '--json'], refusal: false },
    { argv: ['read', 'agent-system/binding/agent/absent', '--root', root, '--json'], refusal: true },
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
    // One value: --stdout carries the compiled artifact, which is one JSON document rather than one line.
    if (!argv.includes('--stdout')) expect(stream.slice(0, -1), argv.join(' ')).not.toContain('\n');
    expect(() => JSON.parse(stream), argv.join(' ')).not.toThrow();
    // The deprecated `ia compile` notes its deprecation on stderr whenever it runs; a refusal prints only the refusal.
    expect(result.stderr, argv.join(' ')).toBe(argv[0] === 'compile' && !refusal ? DEPRECATION : '');
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
