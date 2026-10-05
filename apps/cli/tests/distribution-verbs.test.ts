/**
 * `ia pack`, `ia install`, `ia update`, `ia remove` and `ia restore`.
 *
 * The package installed here is packed from the committed loop fixture by this file, so every digest, version and
 * plan in these assertions is one the mechanisms produced rather than one written down. The one stubbed thing is
 * the transport: §2.8's class 4 cannot be reached without a remote that fails, and a test that reached a real host
 * would be a test of the network.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup, cli, FORMATTABLE, makeHost, packable, run, scratch, workspace } from './workspace-fixture.js';
import { dispatch } from '../src/consumer.js';
import { collectDoctor } from '../src/doctor.js';
import { quote } from '../src/render.js';

it('doctor keeps real discovery by default and explicit roots precede fixture observations', () => {
  const root = workspace(),
    cwd = resolve(root, 'empty');
  mkdirSync(cwd);
  const request = {
    cwd,
    packageRoot: cli,
    runtime: { version: '22.22.0', platform: 'win32', arch: 'x64' },
    env: {},
    home: scratch('doctor-observation-home'),
  };
  const rootRow = (view: ReturnType<typeof collectDoctor>) => view.checks.find((row) => row.id === 'root');
  expect(rootRow(collectDoctor(request))).toMatchObject({ status: 'ok', detail: realpathSync(root) });
  const discover = vi.fn(() => undefined);
  expect(rootRow(collectDoctor({ ...request, discover }))).toMatchObject({
    status: 'warn',
    detail: 'No .ia/src directory here or in any parent',
  });
  expect(discover).toHaveBeenCalledTimes(1);
  expect(rootRow(collectDoctor({ ...request, root, discover }))).toMatchObject({
    status: 'ok',
    detail: realpathSync(root),
  });
  expect(discover).toHaveBeenCalledTimes(1);
});

const ANSI = /\u001b\[/;
const ID = 'fixture/foundation';
afterAll(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** Packs the fixture and returns a fresh workspace holding that archive and a catalog naming it. */
async function catalogued(): Promise<{ readonly root: string; readonly archive: string }> {
  const source = packable();
  const packed = await run(['pack', '--root', source, '--descriptor', '.ia/work/descriptor.json', '--json']);
  expect(packed.exitCode).toBe(0);
  const result = JSON.parse(packed.stdout) as { path: string; archive: string };
  const root = resolve(scratch('install'), 'target');
  mkdirSync(resolve(root, '.ia/work/dist'), { recursive: true });
  copyFileSync(resolve(source, '.ia/work/dist', result.path), resolve(root, '.ia/work/dist', result.path));
  writeFileSync(
    resolve(root, '.ia/work/catalog.json'),
    JSON.stringify([{ path: `.ia/work/dist/${result.path}`, withdrawn: false }]) + '\n',
  );
  return { root, archive: result.archive };
}

it('does not apply when cancellation arrives with a confirmation answer', async () => {
  const { root } = await catalogued(),
    controller = new AbortController();
  const host = makeHost({ interactive: true });
  const result = await dispatch(
    ['install', ID, '--root', root, '--catalog', '.ia/work/catalog.json', '--apply'],
    {
      ...host,
      signal: controller.signal,
      interaction: {
        ...host.interaction,
        read: async () => {
          controller.abort();
          return 'yes';
        },
      },
    },
    () => {
      throw new Error('Unexpected machine route');
    },
    [],
  );
  expect(result).toEqual({ exitCode: 130, stdout: '', stderr: 'Interrupted.\n' });
  for (const path of [
    '.ia/distributions.lock.json',
    '.ia/distributions/active.json',
    '.ia/distributions/install-lock.json',
  ])
    expect(existsSync(resolve(root, path)), path).toBe(false);
});

it('packs a reviewable archive, prints its integrity values and refuses to replace it', async () => {
  const root = packable();
  const human = await run(['pack', '--root', root, '--descriptor', '.ia/work/descriptor.json']);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain(`Pack  ${ID} 0.1.0`);
  expect(human.stdout).toContain('Archive   sha256');
  expect(human.stdout).toContain('Manifest  sha256');
  expect(human.stdout).toContain('Source    sha256');
  expect(human.stdout).toContain('bytes expanded');
  expect(human.stdout).toContain('Members');
  expect(human.stdout).toContain('and 16 more');
  const names = readdirSync(resolve(root, '.ia/work/dist'));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[0-9a-f]{64}\.ia\.tgz$/);

  const again = await run(['pack', '--root', root, '--descriptor', '.ia/work/descriptor.json']);
  expect(again.exitCode).toBe(3);
  expect(again.stderr).toContain('IA-DIST-LOCAL-MODIFICATION');
  expect(again.stderr).toContain('--force');
  const forced = await run(['pack', '--root', root, '--descriptor', '.ia/work/descriptor.json', '--force', '--json']);
  expect(forced.exitCode).toBe(0);
  expect(forced.stdout).not.toMatch(ANSI);
  const result = JSON.parse(forced.stdout) as {
    version: number;
    status: string;
    archive: string;
    manifest: { id: string };
  };
  expect(result).toMatchObject({ version: 1, status: 'packed' });
  expect(result.manifest.id).toBe(ID);
  expect(`${result.archive}.ia.tgz`).toBe(names[0]);
  expect(readdirSync(resolve(root, '.ia/work/dist'))).toEqual(names);

  // §2.7: a descriptor that is not there is a refusal, and packing never invents a "ran correctly, bad" class 1.
  const missing = await run(['pack', '--root', root, '--descriptor', '.ia/work/absent.json']);
  expect(missing.exitCode).toBe(3);
  expect(missing.stderr).toContain('IA-DIST-INPUT-INVALID');
  const elsewhere = await run([
    'pack',
    '--root',
    root,
    '--descriptor',
    '.ia/work/descriptor.json',
    '--out',
    resolve(root, 'absent-dir'),
  ]);
  expect(elsewhere.exitCode).toBe(3);
  expect(existsSync(resolve(root, 'absent-dir'))).toBe(false);
});

it('opens a --root reached through a link at its real path for every verb, and still refuses a link below the root', async () => {
  // macOS /tmp and a linked checkout reach the root through a link. A junction needs no privilege on Windows; elsewhere
  // the type is ignored and a directory symlink is made.
  const root = packable(),
    linked = resolve(scratch('linked-root'), 'linked'),
    descriptor = '.ia/work/descriptor.json';
  symlinkSync(root, linked, 'junction');
  const formattable = resolve(root, FORMATTABLE),
    formatted = readFileSync(formattable, 'utf8');
  writeFileSync(formattable, formatted.replace('  meaning\n', '  meaning   \n'));
  const real = await run(['validate', '--root', root, '--json']),
    through = await run(['validate', '--root', linked, '--json']);
  expect([through.exitCode, JSON.parse(through.stdout).counts]).toEqual([
    real.exitCode,
    JSON.parse(real.stdout).counts,
  ]);
  for (const argv of [
    ['format', '--write'],
    ['compile'],
    ['pack', '--descriptor', descriptor],
    ['pack', '--descriptor', descriptor, '--force'],
  ]) {
    const got = await run([argv[0]!, '--root', linked, ...argv.slice(1)]);
    expect(got.exitCode, `${argv.join(' ')}: ${got.stderr}`).toBe(0);
  }
  expect(readFileSync(formattable, 'utf8')).toBe(formatted);
  expect(existsSync(resolve(root, '.ia/work/compiled.json'))).toBe(true);
  expect(readdirSync(resolve(root, '.ia/work/dist'))).toHaveLength(1);
  const env = { IA_HOME: resolve(scratch('linked-doctor-home'), '.ia') };
  const rows = async (at: string) =>
    (
      JSON.parse((await run(['doctor', '--root', at, '--json'], { env })).stdout) as {
        checks: { id: string; status: string }[];
      }
    ).checks.map((check) => [check.id, check.status]);
  expect(await rows(linked)).toEqual(await rows(root));
  // A link below the root stays refused: with .ia/work leading outside the workspace, pack writes nothing through it.
  const below = packable(),
    outside = scratch('outside');
  copyFileSync(resolve(below, descriptor), resolve(below, '.ia/descriptor.json'));
  rmSync(resolve(below, '.ia/work'), { recursive: true, force: true });
  symlinkSync(outside, resolve(below, '.ia/work'), 'junction');
  const escaped = await run(['pack', '--root', below, '--descriptor', '.ia/descriptor.json']);
  expect([escaped.exitCode, escaped.stderr.includes('IA-DIST-PATH-UNSAFE')]).toEqual([3, true]);
  expect(
    readdirSync(outside, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      statSync(resolve(outside, entry)).isFile(),
    ),
  ).toEqual([]);
});

it('discovers a workspace from a cwd inside a link and opens it at its real path, as a --root through the link opens', async () => {
  // Windows keeps a junction's spelling in the cwd (POSIX getcwd resolves links), and the §8.1 session hook runs doctor from the
  // project directory without --root, so the discovered root must not be refused as a link.
  const root = packable(),
    linked = resolve(scratch('linked-cwd'), 'linked');
  symlinkSync(root, linked, 'junction');
  const env = { IA_HOME: resolve(scratch('linked-cwd-home'), '.ia') };
  const real = JSON.parse((await run(['validate', '--root', root, '--json'])).stdout) as { counts: unknown };
  const rows = async (cwd: string) =>
    (
      JSON.parse((await run(['doctor', '--json'], { cwd, env })).stdout) as {
        checks: { id: string; status: string; detail: string }[];
      }
    ).checks;
  for (const cwd of [linked, resolve(linked, '.ia/src')]) {
    const through = await run(['validate', '--json'], { cwd });
    expect(through.exitCode, through.stderr).toBe(0);
    expect(JSON.parse(through.stdout)).toMatchObject({ root: realpathSync(root), counts: real.counts });
    const checks = await rows(cwd);
    expect(checks.find((check) => check.id === 'root')).toMatchObject({ status: 'ok', detail: realpathSync(root) });
    expect(checks.map((check) => [check.id, check.status])).toEqual(
      (await rows(root)).map((check) => [check.id, check.status]),
    );
    expect(
      checks
        .filter((check) => check.status === 'unknown')
        .map((check) => check.detail)
        .join('\n'),
    ).not.toContain('IA-DIST-PATH-UNSAFE');
  }
});

it('plans and applies an installation, an update, a restore and a removal through one lock', async () => {
  const { root, archive } = await catalogued();
  const preview = await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json']);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout).toContain('Plan  install');
  expect(preview.stdout).toContain('This is a preview. Nothing has been written.');
  expect(preview.stdout).toContain(`+  ${ID}  0.1.0  sha256 ${archive.slice(0, 12)}`);
  expect(preview.stdout).toContain('direct');
  expect(preview.stdout).toContain('1 added, 0 removed, 0 updated, 0 shadowed.');
  expect(preview.stdout).toContain('Would write');
  expect(preview.stdout).toContain('Authored sources under .ia/src are not touched.');
  expect(preview.stdout).toContain('Apply with "ia install fixture/foundation@^0.1.0');
  // A preview writes no installation state; the cache it fills is the verified bytes resolution reads.
  expect(existsSync(resolve(root, '.ia/distributions.lock.json'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/distributions/active.json'))).toBe(false);

  const machine = JSON.parse(
    (await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--json'])).stdout,
  ) as {
    plan: { operation: string; engine: string; changes: { added: string[] }; digest: string };
    applied?: unknown;
  };
  expect(machine).toMatchObject({ version: 1, command: 'install' });
  expect(machine.plan.operation).toBe('install');
  expect(machine.plan.engine).toBe('0.1.0');
  expect(machine.plan.changes.added).toEqual([ID]);
  expect(machine.applied).toBeUndefined();

  const saved = await run([
    'install',
    `${ID}@^0.1.0`,
    '--root',
    root,
    '--catalog',
    '.ia/work/catalog.json',
    '--plan-out',
    '.ia/work/install-plan.json',
  ]);
  expect(saved.exitCode).toBe(0);
  expect(existsSync(resolve(root, '.ia/work/install-plan.json'))).toBe(true);
  // §2.8: a saved plan must be a new file, which is the same newness rule `ia compile` meets.
  const twice = await run([
    'install',
    `${ID}@^0.1.0`,
    '--root',
    root,
    '--catalog',
    '.ia/work/catalog.json',
    '--plan-out',
    '.ia/work/install-plan.json',
  ]);
  expect(twice.exitCode).toBe(3);
  expect(twice.stderr).toContain('IA-DIST-LOCAL-MODIFICATION');

  const applied = JSON.parse(
    (
      await run([
        'install',
        `${ID}@^0.1.0`,
        '--root',
        root,
        '--catalog',
        '.ia/work/catalog.json',
        '--apply',
        '--yes',
        '--json',
      ])
    ).stdout,
  ) as {
    applied: { status: string; generation: string; counter: number; host: string };
  };
  expect(applied.applied.status).toBe('installed');
  expect(applied.applied.counter).toBe(1);
  expect(applied.applied.host).toBe('pending');
  expect(existsSync(resolve(root, '.ia/distributions.lock.json'))).toBe(true);
  // A scratch IA home keeps host plugin distribution spec §7.3's rows off the real one.
  const installed = await run(['doctor', '--root', root], { env: { IA_HOME: resolve(scratch('doctor-home'), '.ia') } });
  expect(installed.stdout).toContain(applied.applied.generation.slice(0, 12));
  expect(installed.stdout).toContain('1 archive in .ia/distributions/cache');

  const update = await run(['update', ID, '--to', '^0.1.0', '--root', root, '--catalog', '.ia/work/catalog.json']);
  expect(update.exitCode).toBe(0);
  expect(update.stdout).toContain('Plan  update');
  expect(update.stdout).toContain('0 added, 0 removed, 0 updated, 0 shadowed.');

  const restore = await run(['restore', '--root', root, '--offline', '--apply', '--yes', '--json']);
  expect(restore.exitCode).toBe(0);
  expect(JSON.parse(restore.stdout).applied.counter).toBe(2);

  const removal = await run(['remove', ID, '--root', root]);
  expect(removal.exitCode).toBe(0);
  expect(removal.stdout).toContain(`-  ${ID}`);
  expect(removal.stdout).toContain('0 added, 1 removed, 0 updated, 0 shadowed.');
  const removed = await run(['remove', ID, '--root', root, '--apply', '--yes', '--json']);
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout).applied.counter).toBe(3);
  const after = JSON.parse(
    (await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--json'])).stdout,
  ) as {
    plan: { changes: { added: string[] } };
  };
  expect(after.plan.changes.added).toEqual([ID]);
});

it('asks one question before applying on a terminal and does exactly what the answer says', async () => {
  const { root, archive } = await catalogued();
  const args = ['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--apply'];
  const lock = resolve(root, '.ia/distributions.lock.json');

  // §2.8 rule 3: the question shows the change summary, and the summary is the preview's own change table.
  const declined: string[] = [];
  const no = await run(args, { interactive: true, answers: ['n'], prompts: declined });
  expect(no.exitCode).toBe(0);
  expect(declined.join('')).toContain(`+  ${ID}  0.1.0  sha256 ${archive.slice(0, 12)}`);
  expect(declined.join('')).toContain('1 added, 0 removed, 0 updated, 0 shadowed.');
  expect(declined.join('')).toContain('Would write');
  expect(declined.at(-1)).toBe('Apply these changes? [y/N] ');
  // Declining is an answer, not a failure: exit 0, nothing applied, and stdout carries no part of the question.
  expect(no.stdout).toContain('Nothing was applied.');
  expect(no.stdout).toContain('Apply with "ia install fixture/foundation@^0.1.0');
  expect(no.stdout).not.toContain('Apply these changes?');
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(resolve(root, '.ia/distributions/active.json'))).toBe(false);

  // EOF — nothing on stdin at all — declines. It is neither consent nor a crash.
  const eof = await run(args, { interactive: true, answers: [] });
  expect(eof.exitCode).toBe(0);
  expect(eof.stdout).toContain('Nothing was applied.');
  expect(existsSync(lock)).toBe(false);
  // Neither does an answer that is not `y` or `yes`; only those two consent.
  expect((await run(args, { interactive: true, answers: ['yep'] })).stdout).toContain('Nothing was applied.');
  expect(existsSync(lock)).toBe(false);

  // Case and surrounding space are ignored, and consent applies the plan the summary showed.
  const asked: string[] = [];
  const yes = await run(args, { interactive: true, answers: [' YES '], prompts: asked });
  expect(yes.exitCode).toBe(0);
  expect(yes.stdout).toContain('Installed generation');
  expect(asked.at(-1)).toBe('Apply these changes? [y/N] ');
  expect(existsSync(lock)).toBe(true);

  // The question is the shared shape of all four verbs, not a property of `install`.
  const removal: string[] = [];
  const kept = await run(['remove', ID, '--root', root, '--apply'], {
    interactive: true,
    answers: ['n'],
    prompts: removal,
  });
  expect(kept.exitCode).toBe(0);
  expect(removal.join('')).toContain(`-  ${ID}`);
  expect(kept.stdout).toContain('Nothing was applied.');
  expect(
    JSON.parse(
      (await run(['doctor', '--root', root, '--json'], { env: { IA_HOME: resolve(scratch('doctor-home'), '.ia') } }))
        .stdout,
    ).counts.fail,
  ).toBe(0);
  expect(existsSync(lock)).toBe(true);
});

it('refuses an --apply whose question could not be asked, and skips the question for --yes', async () => {
  const { root } = await catalogued();
  const args = ['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--apply'];
  // §5: `--json` stdout is one parseable value with no prompt in it, so a terminal does not make it askable.
  const machine = await run([...args, '--json'], { interactive: true, answers: ['y'] });
  expect(machine.exitCode).toBe(2);
  expect(JSON.parse(machine.stdout)).toMatchObject({ version: 1, ok: false, code: 'IA-CLI-USAGE', exit: 2 });
  expect(JSON.parse(machine.stdout).message).toContain('--apply --json requires --yes');
  // Both halves of rule 3 refuse at parse time, so neither reached a workspace read or an installation write.
  expect(existsSync(resolve(root, '.ia/distributions'))).toBe(false);

  // `--yes` skips the question entirely, on a terminal as well as off one; nothing is written to the interaction.
  const bypass: string[] = [];
  const applied = await run([...args, '--yes'], { interactive: true, answers: ['n'], prompts: bypass });
  expect(applied.exitCode).toBe(0);
  expect(bypass).toEqual([]);
  expect(existsSync(resolve(root, '.ia/distributions.lock.json'))).toBe(true);
});

it('refuses without a confirmation and without an existing installation', async () => {
  const { root } = await catalogued();
  // §2.8: both checks are class 2 and run at parse time, so nothing was read and nothing was written. A command with
  // no source flag resolves from registries (registry spec §6.1); registry.test.ts covers that route and its refusals.
  const unconfirmed = await run(['install', ID, '--root', root, '--catalog', '.ia/work/catalog.json', '--apply']);
  expect(unconfirmed.exitCode).toBe(2);
  expect(unconfirmed.stderr).toContain('--apply without a terminal requires --yes');
  expect(existsSync(resolve(root, '.ia/distributions'))).toBe(false);
  expect((await run(['install', 'Not-An-Id', '--root', root, '--offline'])).exitCode).toBe(2);

  // Registry spec §6.2: --to is optional, and an update still needs an installation to update, with or without it.
  for (const to of [['--to', '^0.2.0'], []]) {
    const absent = await run(['update', ID, ...to, '--root', root, '--catalog', '.ia/work/catalog.json']);
    expect(absent.exitCode).toBe(3);
    expect(absent.stderr).toContain('IA-DIST-INPUT-INVALID');
    expect(absent.stderr).toContain('existing installation');
  }
  // §2.8–2.11: `remove` reads only the current lock, so it can refuse but can never reach class 4.
  const nothing = await run(['remove', ID, '--root', root]);
  expect(nothing.exitCode).toBe(3);
  expect(nothing.stderr).toContain('IA-DIST-INPUT-INVALID');
  const offlineOnly = await run(['restore', '--root', root, '--offline', '--apply', '--yes']);
  expect(offlineOnly.exitCode).toBe(3);
});

it('separates an unreachable artifact from a refusal by exit class', async () => {
  const root = resolve(scratch('remote'), 'target');
  const digest = 'a'.repeat(64);
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  const url = `https://dist.example.invalid/artifacts/${digest}.ia.tgz`;
  writeFileSync(resolve(root, '.ia/work/catalog.json'), JSON.stringify([{ url, digest, withdrawn: false }]) + '\n');

  // §2.8: an offline run never reaches the network, so a cache miss is a refusal and not an acquisition failure.
  const offline = await run([
    'install',
    `${ID}@^0.1.0`,
    '--root',
    root,
    '--catalog',
    '.ia/work/catalog.json',
    '--offline',
  ]);
  expect(offline.exitCode).toBe(3);
  expect(offline.stderr).toContain('IA-DIST-RESTORE-REQUIRED');

  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
  const unavailable = await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json']);
  expect(unavailable.exitCode).toBe(4);
  expect(unavailable.stderr).toContain('IA-DIST-ARTIFACT-UNAVAILABLE');
  // The renderer wraps long lines, so the message is compared with its whitespace collapsed.
  expect(unavailable.stderr.replace(/\s+/g, ' ')).toContain(`Artifact request ${url} returned 503`);
  // The block names the artifact it was reaching for, whole: a truncated digest inside a URL is not a URL.
  expect(unavailable.stderr).toContain(url);
  const machine = JSON.parse(
    (await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--json'])).stdout,
  );
  expect(machine).toMatchObject({ version: 1, ok: false, code: 'IA-DIST-ARTIFACT-UNAVAILABLE', exit: 4 });
  // The catalog route's remedy names the catalog it resolves from: --offline alone reads no catalog (registry spec §5.4).
  expect(machine.next).toContain('re-run with --catalog <file> --offline');

  // Registry spec §6.4: the service maps a transport failure to ARTIFACT-UNAVAILABLE naming the URL, still class 4.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const transport = await run(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json']);
  expect(transport.exitCode).toBe(4);
  expect(transport.stderr).toContain('IA-DIST-ARTIFACT-UNAVAILABLE');
  expect(transport.stderr.replace(/\s+/g, ' ')).toContain(`Artifact request ${url} failed: fetch failed`);
  vi.unstubAllGlobals();
});

// ---- Host plugin distribution spec §7.3 and §8.2: doctor --host ----------------------------------------------------

it('doctor --host claude adds the session briefing outside a workspace', async () => {
  const cwd = scratch('doctor-host'),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  const report = JSON.parse((await run(['doctor', '--host', 'claude', '--json'], { env, cwd })).stdout);
  expect(report.session.notice).toBeNull();
  expect(report.session.context.join(' ')).toContain('not an InventArch workspace');
  expect(report.nextActions).toEqual([{ intent: 'init', argv: ['ia', 'init', '.'], host: '/ia:init' }]);
  // Without --host the envelope is unchanged: no session and no next actions.
  const plain = JSON.parse((await run(['doctor', '--json'], { env, cwd })).stdout);
  expect(plain).not.toHaveProperty('session');
  expect(plain).not.toHaveProperty('nextActions');
});

it('doctor --host: codex gets plain commands, and a --root with no workspace above is offered init by its path', async () => {
  const project = scratch('doctor-project'),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  const found = JSON.parse((await run(['doctor', '--host', 'codex', '--json'], { env, cwd: project })).stdout);
  expect(found.session.context.join(' ')).toContain('This directory is not an InventArch workspace');
  expect(found.nextActions).toEqual([{ intent: 'init', argv: ['ia', 'init', '.'], host: 'ia init .' }]);
  // A supplied --root is literal; init takes its target as a positional, so the directory rides there.
  const report = JSON.parse((await run(['doctor', '--host', 'claude', '--root', project, '--json'], { env })).stdout);
  expect(report.session.context.join(' ')).toContain(`${project} is not an InventArch workspace`);
  expect(report.nextActions).toEqual([
    { intent: 'init', argv: ['ia', 'init', project], host: `ia init ${quote(project)}` },
  ]);
  expect(report.checks.find((check: { id: string }) => check.id === 'workspace-decision')).toMatchObject({
    status: 'info',
    detail: 'None recorded',
  });
  // Contract §3: a host outside the closed set is usage.
  expect((await run(['doctor', '--host', 'vim', '--json'], { env })).exitCode).toBe(2);
});

it('doctor reports a recorded decline and the briefing reminds once', async () => {
  const project = scratch('doctor-declined'),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  expect((await run(['init', project, '--decline', 'forever', '--host', 'claude', '--json'], { env })).exitCode).toBe(
    0,
  );
  const report = JSON.parse((await run(['doctor', '--host', 'claude', '--json'], { env, cwd: project })).stdout);
  // The user's local calendar date, as the declined-today expiry is (§9.1).
  const today = new Date().toLocaleDateString('en-CA');
  expect(report.checks.find((check: { id: string }) => check.id === 'workspace-decision')).toMatchObject({
    status: 'info',
    detail: `Declined permanently on ${today}`,
    remedy: 'ia init --forget-decline',
  });
  expect(report.session.notice).toMatch(/^IA not installed in .+; declined by user \d{4}-\d{2}-\d{2}$/);
  expect(report.nextActions).toEqual([]);
  // An IA home that holds a decision exists and is marked, so the row is ok.
  expect(report.checks.find((check: { id: string }) => check.id === 'ia-home')).toMatchObject({
    status: 'ok',
    detail: env.IA_HOME,
  });
});

it('doctor never creates the IA home', async () => {
  const home = resolve(scratch('doctor-readonly'), 'never', '.ia');
  for (const argv of [['doctor', '--json'], ['doctor', '--host', 'claude', '--json'], ['doctor']]) {
    const result = await run(argv, { env: { IA_HOME: home }, cwd: scratch('doctor-readonly-cwd') });
    expect(result.exitCode, argv.join(' ')).toBe(0);
    expect(existsSync(resolve(home, '..')), argv.join(' ')).toBe(false);
  }
  // A due refresh is only named (Amendment item 4): the vector is returned, never run, so the home is still absent.
  const report = JSON.parse(
    (
      await run(['doctor', '--host', 'claude', '--json'], {
        env: { IA_HOME: home },
        cwd: scratch('doctor-readonly-cwd'),
      })
    ).stdout,
  );
  expect(report.session.refresh).toEqual(expect.arrayContaining(['refresh-updates', '--home', home]));
  expect(existsSync(resolve(home, '..'))).toBe(false);
});

// ---- Host plugin distribution spec §11: the cached update check and local compatibility ---------------------------

type Report = {
  checks: { id: string; status: string; detail: string; remedy: string | null }[];
  session: { refresh: string[] | null; notice: string | null; nudge: string | null };
};
const rowOf = (report: Report, id: string) => report.checks.find((check) => check.id === id);
const writeCheck = (home: string, cli: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
  mkdirSync(resolve(home, 'state'), { recursive: true });
  writeFileSync(
    resolve(home, 'state/update-check.json'),
    JSON.stringify({
      schema: 'ia.update-check.v1',
      checkedAt: new Date().toISOString(),
      cli: { channel: 'checkout', current: '9.9.9', latest: null, behind: null, checked: true, ...cli },
      packages: { checked: false },
      ...extra,
    }),
  );
};

it('doctor reports the cached update check and names a due refresh without running it', async () => {
  const home = resolve(scratch('doctor-updates'), '.ia'),
    cwd = scratch('doctor-updates-cwd');
  const doctor = async (env: Record<string, string> = {}): Promise<Report> =>
    JSON.parse(
      (await run(['doctor', '--host', 'claude', '--json'], { env: { IA_HOME: home, ...env }, cwd })).stdout,
    ) as Report;
  // Turned off by the environment: a note, and no refresh.
  for (const env of [{ IA_NO_UPDATE_CHECK: '1' }, { CI: 'true' }]) {
    const off = await doctor(env);
    expect(rowOf(off, 'updates'), JSON.stringify(env)).toMatchObject({ status: 'info' });
    expect(off.session.refresh, JSON.stringify(env)).toBeNull();
  }
  // No cache: not checked, and the vector names the built mechanism, this home and this checkout. An empty CI is unset.
  const due = await doctor({ CI: '' });
  expect(rowOf(due, 'updates')).toMatchObject({
    status: 'unknown',
    detail: 'Not checked yet; a check runs in the background',
  });
  expect(due.session.refresh?.[0]).toBe(process.execPath);
  // The package bin, which exists, although this config resolves the development condition (src/updates.ts).
  expect(existsSync(due.session.refresh![1]!), due.session.refresh![1]).toBe(true);
  expect(due.session.refresh![1]!.endsWith(`dist${sep}cli.js`)).toBe(true);
  expect(due.session.refresh?.slice(2)).toEqual([
    'refresh-updates',
    '--home',
    home,
    '--channel',
    'checkout',
    '--current',
    '9.9.9',
    '--checkout',
    expect.any(String),
  ]);
  expect(existsSync(home)).toBe(false);
  // A fresh cache for this channel and version: its facts, the channel's update instruction, the nudge, and no refresh.
  writeCheck(home, { behind: 3 }, { account: { notices: ['Your organization supports language 1.0'] } });
  const behind = await doctor();
  expect(rowOf(behind, 'updates')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('3 commits behind upstream as of the last fetch'),
  });
  expect(rowOf(behind, 'updates')?.remedy).toContain('git pull, pnpm build');
  expect(rowOf(behind, 'updates-account')).toMatchObject({
    status: 'info',
    detail: 'Your organization supports language 1.0',
  });
  expect(behind.session).toMatchObject({ refresh: null, nudge: 'update' });
  expect(behind.session.notice).toContain('your checkout is 3 commits behind its upstream');
  writeCheck(home, { behind: 0 });
  expect(rowOf(await doctor(), 'updates')).toMatchObject({
    status: 'ok',
    detail: expect.stringMatching(/^Up to date as of \d{4}-\d{2}-\d{2}$/),
  });
  // The IA home's config.json turns it off too.
  writeFileSync(resolve(home, 'config.json'), JSON.stringify({ updateCheck: false }));
  const configured = await doctor();
  expect(rowOf(configured, 'updates')?.status).toBe('info');
  expect(rowOf(configured, 'updates-account')).toBeUndefined();
  expect(configured.session.refresh).toBeNull();
  rmSync(resolve(home, 'config.json'));
  // A cache written by another ia version is not about this one: not checked, and a refresh is due.
  writeCheck(home, { current: '9.9.8', behind: 5 });
  const other = await doctor();
  expect(rowOf(other, 'updates')?.status).toBe('unknown');
  expect(other.session.refresh).toEqual(expect.arrayContaining(['refresh-updates']));
  // A week-old check means the background refresh keeps failing: a warning, and a refresh is due.
  writeCheck(home, { behind: 0 }, { checkedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
  const old = await doctor();
  expect(rowOf(old, 'updates')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('no background check has completed since'),
  });
  expect(old.session.refresh).not.toBeNull();
  // A home holding src/ fails the ia-home row, and refresh-updates would refuse it, so no refresh is named.
  mkdirSync(resolve(home, 'src'));
  const unusable = await doctor();
  expect(rowOf(unusable, 'ia-home')?.status).toBe('fail');
  expect(unusable.session.refresh).toBeNull();
});

it('doctor on the npm channel: only a newer release is an update, and the vector names the package', () => {
  const home = resolve(scratch('doctor-npm'), '.ia'),
    channel = { kind: 'npm', name: '@inventarch/cli', version: '0.2.0' } as const;
  const doctor = (now = new Date()) =>
    collectDoctor({
      cwd: scratch('doctor-npm-cwd'),
      packageRoot: cli,
      runtime: { version: 'v22.22.0', platform: 'linux', arch: 'x64' },
      env: { IA_HOME: home },
      version: '0.2.0',
      host: 'claude',
      channel,
      now,
    });
  const due = doctor();
  expect(due.briefing?.session.refresh?.slice(2)).toEqual([
    'refresh-updates',
    '--home',
    home,
    '--channel',
    'npm',
    '--current',
    '0.2.0',
    '--name',
    '@inventarch/cli',
  ]);
  writeCheck(home, { channel: 'npm', current: '0.2.0', latest: '0.3.0' });
  const newer = doctor();
  expect(newer.checks.find((check) => check.id === 'updates')).toMatchObject({
    status: 'warn',
    remedy: 'npm i -g @inventarch/cli@latest, then ia host claude --user --apply',
  });
  expect(newer.briefing?.session).toMatchObject({ nudge: 'update', refresh: null });
  // A registry that lags this build is not an update.
  writeCheck(home, { channel: 'npm', current: '0.2.0', latest: '0.1.9' });
  const older = doctor();
  expect(older.checks.find((check) => check.id === 'updates')?.status).toBe('ok');
  expect(older.briefing?.session.nudge).toBeNull();
  // Refreshed at most every 24 hours.
  expect(doctor(new Date(Date.now() + 25 * 3600 * 1000)).briefing?.session.refresh).not.toBeNull();
  // A prerelease ranks below its release, so a user on 0.3.0-rc.1 is told about 0.3.0.
  writeCheck(home, { channel: 'npm', current: '0.3.0-rc.1', latest: '0.3.0' });
  const candidate = collectDoctor({
    cwd: scratch('doctor-npm-cwd'),
    packageRoot: cli,
    runtime: { version: 'v22.22.0', platform: 'linux', arch: 'x64' },
    env: { IA_HOME: home },
    version: '0.3.0-rc.1',
    host: 'claude',
    channel,
  });
  expect(candidate.checks.find((check) => check.id === 'updates')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('ia 0.3.0 is available; this is 0.3.0-rc.1'),
  });
  expect(candidate.briefing?.session).toMatchObject({
    nudge: 'update',
    notice: expect.stringContaining('ia 0.3.0 is available (you have 0.3.0-rc.1)'),
  });
});

it('doctor compares the workspace language with what this ia reads, only for a workspace', async () => {
  const root = workspace(),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia'), IA_NO_UPDATE_CHECK: '1' };
  const doctor = async () => {
    const result = await run(['doctor', '--root', root, '--json'], { env });
    return { exitCode: result.exitCode, row: rowOf(JSON.parse(result.stdout) as Report, 'compatibility') };
  };
  expect((await doctor()).row).toMatchObject({ status: 'unknown', detail: 'Not checked; .ia/release.json is absent' });
  const release = resolve(root, '.ia/release.json');
  writeFileSync(release, JSON.stringify({ language: [] }));
  expect((await doctor()).row).toMatchObject({
    status: 'unknown',
    detail: 'Not checked; .ia/release.json names no language version',
  });
  writeFileSync(release, JSON.stringify({ language: ['1.0'] }));
  expect(await doctor()).toMatchObject({
    exitCode: 0,
    row: { status: 'ok', detail: 'Workspace language 1.0; this ia reads 1.0' },
  });
  writeFileSync(release, JSON.stringify({ language: ['0.9'] }));
  expect(await doctor()).toMatchObject({ exitCode: 0, row: { status: 'warn' } });
  // A workspace newer than this ia fails, and the remedy is the channel's update instruction.
  writeFileSync(release, JSON.stringify({ language: ['9.0'] }));
  const newer = await doctor();
  expect(newer).toMatchObject({
    exitCode: 1,
    row: { status: 'fail', detail: expect.stringContaining('9.0 is newer than this ia can read') },
  });
  expect(newer.row?.remedy).toContain('git pull');
  // No workspace, no row.
  const none = JSON.parse(
    (await run(['doctor', '--json'], { env, cwd: scratch('doctor-no-workspace') })).stdout,
  ) as Report;
  expect(rowOf(none, 'compatibility')).toBeUndefined();
});

it('doctor --root <workspace subdirectory> stays literal and only names the enclosing workspace', async () => {
  const root = workspace(),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  const nested = resolve(root, 'apps/cli');
  mkdirSync(nested, { recursive: true });
  const report = JSON.parse((await run(['doctor', '--host', 'claude', '--root', nested, '--json'], { env })).stdout);
  // One report, one root: the rows and the briefing are both about the supplied directory.
  expect(report.checks.find((check: { id: string }) => check.id === 'root').detail).toBe(nested);
  expect(report.checks.find((check: { id: string }) => check.id === 'workspace-decision')).toBeUndefined();
  expect(report.session.context).toContain(
    `${nested} is inside InventArch workspace ${root}; run ia doctor --root ${quote(root)} for its state.`,
  );
  expect(report.session.context.join(' ')).not.toContain('not an InventArch workspace');
  expect(report.session.notice).toBeNull();
  expect(report.nextActions).toEqual([]);
});

it('doctor --root <workspace> briefs it and every next action carries the root', async () => {
  const root = workspace(),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  const report = JSON.parse(
    (await run(['doctor', '--host', 'claude', '--root', root, '--json'], { env, cwd: scratch('doctor-elsewhere') }))
      .stdout,
  );
  const apply = ['ia', 'host', 'claude', '--root', root, '--apply'];
  expect(report.session.context.join(' ')).toContain(`InventArch workspace ${root}: 158 records, 0 errors`);
  expect(report.session.notice).toBe(
    `IA: this workspace has no Claude host registration; run ${apply.map(quote).join(' ')}`,
  );
  expect(report.nextActions).toEqual([{ intent: 'host', argv: apply, host: apply.map(quote).join(' ') }]);
  // The same root, rows and briefing alike, as the host row's own remedy words it.
  expect(report.checks.find((check: { id: string }) => check.id === 'host').detail).toContain(
    `"ia host claude --root ${quote(root)}"`,
  );
});

it('doctor --host names recovery for an interrupted installation and never suggests ia host', async () => {
  const root = workspace(),
    env = { IA_HOME: resolve(scratch('doctor-home'), '.ia') };
  mkdirSync(resolve(root, '.ia/distributions'), { recursive: true });
  writeFileSync(resolve(root, '.ia/distributions/pending.json'), '{}\n');
  const result = await run(['doctor', '--host', 'claude', '--json'], { env, cwd: root });
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout);
  const pending = report.checks.find((check: { id: string }) => check.id === 'pending');
  expect(pending.status).toBe('fail');
  expect(report.session.notice).toBe(`IA: an interrupted installation needs recovery; run ${pending.remedy}`);
  expect(report.session.context.join(' ')).toContain(
    'Host Claude: not checked (installation recovery is required first).',
  );
  expect(report.session.context.join(' ')).not.toContain('ia host claude --apply');
  expect(report.nextActions).toEqual([]);
});
