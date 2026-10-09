/**
 * `ia init --apply`: the acceptance of docs/specs/workspace-initialization-apply/README.md §8 (M5.2)
 * and of docs/specs/workspace-initialization/README.md §7 (M5.1).
 *
 * Every installed byte comes from the bundled base the root build generates (tools/native/language-base.ts), so
 * this suite needs that generator as a prerequisite, which tools/testing/tasks.json declares. The end state an
 * interrupted run reaches is compared with an uninterrupted run's byte for byte, over every file and directory:
 * the id is derived from the directory name, so every compared target is named `demo`.
 *
 * Interruption at an `applyInstallation` checkpoint is exercised twice. At every checkpoint it is a throw, after which
 * the installer's `finally` releases its lock, as it does for any failure inside the transaction. At the first
 * `store:`, `pending`, `active` and `complete` checkpoints it is also a hard kill in a child (tests/init-kill.ts),
 * which leaves the lock behind. Interruption at an init step boundary is the signal, observed where M5.2 §5 says.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { INSTALL_PATHS, DISTRIBUTION_ENGINE_VERSION } from '@inventarch/db/distribution';
import {
  applyInstallation,
  cacheArchive,
  planInstallation,
  recoverInstallation,
} from '@inventarch/distribution/install';
import { resolveReleases } from '@inventarch/distribution/resolve';
import { resolveCatalog } from '@inventarch/distribution/services';
import { runBounded } from '@tools/testing/subprocess.js';
import { dispatch, Interrupted } from '../src/consumer.js';
import type { Result } from '../src/consumer.js';
import {
  applyInit,
  collectInit,
  gitAnswer,
  gitIn,
  INSTALL_LOCK,
  PIN_PATH,
  readBase,
  readProvenance,
  resolveTarget,
} from '../src/init.js';

import { GUARD_SCOPE, MACHINE_LOCAL, MCP_APPROVAL, rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { cleanup, cli, commandsIn, makeHost, nextArgv, repository, run, scratch } from './workspace-fixture.js';
import type { HostOptions } from './workspace-fixture.js';

afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(cleanup);

const base = readBase(cli);
const pin = base.pin;
/** The base package's id, read from the shipped pin, its only authority (apps/cli/SPEC.md C08). */
const BASE_ID = pin.id;

/** Every directory and file under `root`, with each file's bytes, so "byte-identical" is literal. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(resolve(root, relative)).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`,
        stat = lstatSync(resolve(root, path));
      if (stat.isDirectory()) {
        out[path + '/'] = 'directory';
        walk(path);
      } else
        out[path] = createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex');
    }
  };
  if (existsSync(root)) walk('');
  return out;
}
/** A target named `demo` under a fresh scratch parent, so every run plans the same id, `local/demo`. */
const target = (name = 'demo', create = true): string => {
  const root = resolve(scratch('init'), name);
  if (create) mkdirSync(root);
  return root;
};
const json = (result: Result): any => JSON.parse(result.stdout);
const apply = (root: string, extra: readonly string[] = [], options: HostOptions = {}) =>
  run(['init', root, '--apply', '--yes', '--json', ...extra], options);
const plan = (root: string, extra: readonly string[] = [], options: HostOptions = {}) =>
  run(['init', root, '--json', ...extra], options);
const view = (root: string) => collectInit({ root, host: 'none', packageRoot: cli, git: gitIn(root, {}) });

/** The uninterrupted run every interrupted one is compared with. */
let reference: Record<string, string> | undefined;
async function referenceTree(): Promise<Record<string, string>> {
  if (reference === undefined) {
    const root = target();
    expect((await apply(root)).exitCode).toBe(0);
    reference = tree(root);
  }
  return reference;
}
/** The checkpoint names one uninterrupted apply passes, in order. */
let checkpoints: readonly string[] | undefined;
async function checkpointNames(): Promise<readonly string[]> {
  if (checkpoints === undefined) {
    const root = target(),
      names: string[] = [];
    await applyInit(view(root), { packageRoot: cli, checkpoint: (name) => names.push(name) });
    checkpoints = names;
  }
  return checkpoints;
}

it('initializes an empty directory offline with no fetch and no cache, into exactly the M5.1 end state', async () => {
  const fetch = vi.fn(() => {
    throw new Error('No network request is permitted');
  });
  vi.stubGlobal('fetch', fetch);
  const root = target();
  expect(existsSync(resolve(root, '.ia/distributions/cache'))).toBe(false);
  const result = await apply(root);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  const envelope = json(result);
  expect(envelope.plan.state).toBe('fresh');
  expect(envelope.plan.steps).toEqual(
    ['install', 'system', 'records', 'descriptor'].map((id) => ({ id, status: 'pending' })),
  );
  expect(envelope.applied).toEqual({
    status: 'initialized',
    resumed: false,
    id: 'local/demo',
    distribution: 'workspace-system/definition/distribution/demo-distribution',
    generation: expect.stringMatching(/^[a-f0-9]{64}$/),
    counter: 1,
  });
  // M5.1 §7 item 1: validate passes, one package at the pinned version located by digest, generation 1 active.
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode).toBe(0);
  expect(json(validated).status).toBe('admitted');
  const lock = JSON.parse(readFileSync(resolve(root, INSTALL_PATHS.lock), 'utf8'));
  expect(lock.requests).toEqual([{ id: BASE_ID, range: `^${pin.version}` }]);
  expect(lock.packages).toEqual([
    {
      id: BASE_ID,
      version: pin.version,
      archive: pin.archive,
      manifest: pin.manifest,
      location: `sha256:${pin.archive}`,
      dependencies: [],
    },
  ]);
  const active = JSON.parse(readFileSync(resolve(root, INSTALL_PATHS.active), 'utf8'));
  expect(active).toMatchObject({ counter: 1, previous: null, generation: envelope.applied.generation });
  expect(fetch).not.toHaveBeenCalled();
  // M5.1 §2.1: exactly the listed paths and nothing else — no floor, no host configuration, no ignore file.
  expect(readdirSync(root).sort()).toEqual(['.ia']);
  expect(readdirSync(resolve(root, '.ia')).sort()).toEqual([
    'distributions',
    'distributions.lock.json',
    'release.json',
    'src',
  ]);
  expect(Object.keys(tree(resolve(root, '.ia/src'))).sort()).toEqual([
    'systems/',
    'systems/demo/',
    'systems/demo/records/',
    'systems/demo/records/workspace.ia',
    'systems/demo/system.ia',
  ]);
  expect(readFileSync(resolve(root, `.ia/distributions/cache/${pin.archive}.ia.tgz`)).equals(base.bytes)).toBe(true);
  const descriptor = JSON.parse(readFileSync(resolve(root, '.ia/release.json'), 'utf8'));
  expect(descriptor).toEqual({
    formatVersion: 1,
    id: 'local/demo',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/demo-distribution',
    engine: `^${DISTRIBUTION_ENGINE_VERSION}`,
    language: ['1.0'],
    dependencies: [{ id: BASE_ID, range: `^${pin.version}`, systems: base.systems }],
    assets: [],
    license: 'UNLICENSED',
    description: 'The demo workspace.',
    source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
  });
  expect(base.systems).toHaveLength(11);
  // Two uninterrupted runs in different parents are the same bytes, which is what makes §8 item 2 checkable.
  expect(tree(root)).toEqual(await referenceTree());
});

it('creates a target that did not exist yet, and renders what it applied', async () => {
  const root = target('demo', false);
  const human = await run(['init', root, '--apply', '--yes']);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stdout).toContain('Init  local/demo');
  expect(human.stdout).toContain('Initialized local/demo; release descriptor .ia/release.json.');
  expect(human.stdout).toContain('counter 1.');
  expect(tree(root)).toEqual(await referenceTree());
});

it('initializes a directory reached through a link, and a new one under a linked parent, at their real paths', async () => {
  // macOS /tmp and a linked checkout reach the target through a link; links below the root stay refused.
  const real = scratch('init-link-real'),
    linked = resolve(scratch('init-link-parent'), 'linked');
  symlinkSync(real, linked, 'junction');
  expect(resolveTarget(linked, undefined)).toBe(realpathSync(real));
  expect(resolveTarget(real, resolve(linked, 'demo'))).toBe(resolve(realpathSync(real), 'demo'));
  const applied = await run(['init', resolve(linked, 'demo'), '--apply', '--yes']);
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(existsSync(resolve(real, 'demo/.ia/release.json'))).toBe(true);
  // A decline reports the target as typed; only its decision key is the real path.
  const declined = json(
    await run(['init', linked, '--decline', 'today', '--json'], {
      env: { IA_HOME: resolve(scratch('init-link-home'), '.ia') },
    }),
  );
  expect(declined.root).toBe(linked);
});

it('packs the initialized workspace with null provenance and installs that archive into a second one, offline', async () => {
  const fetch = vi.fn(() => {
    throw new Error('No network request is permitted');
  });
  vi.stubGlobal('fetch', fetch);
  const root = target();
  expect((await apply(root)).exitCode).toBe(0);
  // M5.1 §7 item 2, the no-Git half.
  const packed = await run(['pack', '--root', root, '--descriptor', '.ia/release.json', '--json']);
  expect(packed.exitCode, packed.stderr).toBe(0);
  const archive = json(packed);
  expect(archive.manifest.source).toEqual({ repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 });
  expect(archive.manifest.roots).toEqual(['workspace-system/definition/workspace/demo']);
  expect(archive.manifest.systems.map((system: { name: string }) => system.name)).toEqual(['demo']);
  expect(archive.manifest.dependencies).toEqual([{ id: BASE_ID, range: `^${pin.version}` }]);
  // M5.1 §7 item 3: a second freshly initialized workspace installs it from a local catalog, offline.
  const consumer = target('consumer');
  expect((await apply(consumer)).exitCode).toBe(0);
  mkdirSync(resolve(consumer, '.ia/work/dist'), { recursive: true });
  cpSync(resolve(root, '.ia/work/dist', archive.path), resolve(consumer, '.ia/work/dist', archive.path));
  writeFileSync(
    resolve(consumer, '.ia/work/catalog.json'),
    JSON.stringify([
      { path: `.ia/work/dist/${archive.path}`, withdrawn: false },
      { path: `.ia/distributions/cache/${pin.archive}.ia.tgz`, withdrawn: false },
    ]) + '\n',
  );
  const installed = await run([
    'install',
    'local/demo@^0.1.0',
    '--root',
    consumer,
    '--catalog',
    '.ia/work/catalog.json',
    '--offline',
    '--apply',
    '--yes',
    '--json',
  ]);
  expect(installed.exitCode, installed.stdout).toBe(0);
  expect(json(installed).plan.changes.added).toEqual(['local/demo']);
  expect((await run(['validate', '--root', consumer, '--json'])).exitCode).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

const GIT_TIMEOUT = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 30_000;
/** A scratch Git checkout. Commit signing is disabled for this throwaway fixture repository only. */
async function git(root: string, ...args: string[]): Promise<string> {
  const got = await runBounded(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, timeoutMs: GIT_TIMEOUT },
  );
  if (got.status !== 0) throw new Error(`git ${args.join(' ')} failed (${String(got.status)}): ${got.stderr}`);
  return got.stdout.trim();
}
/** Git is looked for no higher than the scratch parent, so an enclosing checkout cannot change these results. */
const contained = (root: string): HostOptions => ({ env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });

it('sources provenance from an HTTPS remote and HEAD, and says which fact was missing otherwise', async () => {
  const root = target();
  expect(json(await plan(root, [], contained(root))).plan.starter.provenance).toEqual({
    status: 'local',
    missing: 'checkout',
  });
  await git(root, 'init', '--quiet');
  expect(json(await plan(root, [], contained(root))).plan.starter.provenance).toEqual({
    status: 'local',
    missing: 'commit',
  });
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  expect(json(await plan(root, [], contained(root))).plan.starter.provenance).toEqual({
    status: 'local',
    missing: 'https-remote',
  });
  // An SSH remote is not an HTTPS remote, and is never rewritten into a guessed one (M5.1 §2.3).
  await git(root, 'remote', 'add', 'origin', 'git@example.invalid:fixture/demo.git');
  const ssh = json(await plan(root, [], contained(root)));
  expect(ssh.plan.starter.provenance).toEqual({ status: 'local', missing: 'https-remote' });
  expect(ssh.plan.starter.descriptor.source.repository).toBeNull();
  await git(root, 'remote', 'set-url', 'origin', 'https://token@example.invalid/fixture/demo.git');
  expect(json(await plan(root, [], contained(root))).plan.starter.provenance.missing).toBe('https-remote');
  const repository = 'https://example.invalid/fixture/demo.git';
  await git(root, 'remote', 'set-url', 'origin', repository);
  const commit = await git(root, 'rev-parse', 'HEAD'),
    epoch = Number(await git(root, 'log', '-1', '--format=%ct'));
  const human = await run(['init', root], contained(root));
  expect(human.stdout).toContain(`${repository} at ${commit.slice(0, 12)}`);
  // M5.1 §7 item 2, the Git half: the packed manifest carries that remote and HEAD.
  expect((await apply(root, [], contained(root))).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(resolve(root, '.ia/release.json'), 'utf8')).source).toEqual({
    repository,
    commit,
    recipe: 'ustar-v1',
    epoch,
  });
  const packed = await run(['pack', '--root', root, '--descriptor', '.ia/release.json', '--json']);
  expect(packed.exitCode, packed.stderr).toBe(0);
  expect(json(packed).manifest.source).toEqual({ repository, commit, recipe: 'ustar-v1', epoch });
});

it('normalizes the directory name into the id, asks for --id when it cannot, and never invents one', async () => {
  const spaced = target('My Project!');
  expect(json(await plan(spaced)).plan.starter.id).toBe('local/my-project');
  for (const name of ['123', '---', 'agent-system']) {
    const root = target(name);
    const planned = json(await plan(root));
    expect(planned.plan.state, name).toBe('conflict');
    expect(planned.plan.starter.id, name).toBeNull();
    expect(planned.plan.conflicts[0].reason, name).toContain('--id');
    const refused = await apply(root);
    expect(refused.exitCode, name).toBe(3);
    expect(json(refused).code, name).toBe('IA-CLI-CONFLICT');
    expect(readdirSync(root), name).toEqual([]);
  }
  // --id supplies the name segment; its provider is the user's.
  const named = target('123');
  const applied = await apply(named, ['--id', 'acme/tools']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  expect(json(applied).applied).toMatchObject({
    id: 'acme/tools',
    distribution: 'workspace-system/definition/distribution/tools-distribution',
  });
  expect(existsSync(resolve(named, '.ia/src/systems/tools/system.ia'))).toBe(true);
  // A malformed --id is usage, decided before the target is read.
  const malformed = await apply(target(), ['--id', 'Not/Valid']);
  expect(malformed.exitCode).toBe(2);
  expect(json(malformed).code).toBe('IA-CLI-USAGE');
});

it('keeps the verified starter shape and its minimum refusals', async () => {
  // M5.1 §2.2 requires M5.2 to keep an equivalent of the shape check: the starter admits and packs (above), and
  // removing `agent-system` from `requires`, or the steward's `governance`, is refused with the recorded codes.
  const codes = async (edit: (text: string) => string): Promise<readonly string[]> => {
    const root = target(),
      controller = new AbortController();
    await expect(
      applyInit(view(root), {
        packageRoot: cli,
        signal: controller.signal,
        checkpoint: (name) => {
          if (name === 'init:records') controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(Interrupted);
    const path = resolve(root, '.ia/src/systems/demo/system.ia'),
      text = readFileSync(path, 'utf8'),
      edited = edit(text);
    expect(edited).not.toBe(text);
    writeFileSync(path, edited);
    const result = json(await run(['validate', '--root', root, '--json']));
    return result.findings
      .filter((finding: { severity: string }) => finding.severity === 'error')
      .map((finding: { code: string }) => finding.code);
  };
  expect(await codes((text) => text.replace('    - agent-system\n', ''))).toContain('IA-COMP-DISCRIMINATOR-FOREIGN');
  const governance = await codes((text) => text.replace('  governance\n    applies []\n', ''));
  expect(governance).toContain('IA-COMP-SECTION-MISSING');
  expect(governance).toContain('IA-COMP-STEWARD-MISSING');
});

it('admits one plan, milestone, task and decision in a fresh workspace with no edit to the starter (WS-A05)', async () => {
  // docs/specs/work-system/README.md §9.4 WS-A05: the starter requires work-system, so the neutral public
  // example records are admitted as written. Without the requirement each is IA-COMP-DISCRIMINATOR-FOREIGN.
  const root = target();
  expect((await apply(root)).exitCode).toBe(0);
  expect(base.systems).toContain('work-system');
  const system = resolve(root, '.ia/src/systems/demo/system.ia'),
    starter = readFileSync(system, 'utf8');
  expect(starter).toContain('  requires\n    - agent-system\n    - work-system\n    - workspace-system\n');
  cpSync(
    resolve(repository, 'examples/public-language/records/work.ia'),
    resolve(root, '.ia/src/systems/demo/records/work.ia'),
  );
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  const result = json(validated);
  expect(result.status).toBe('admitted');
  expect(result.findings.filter((finding: { severity: string }) => finding.severity === 'error')).toEqual([]);
  // The example is self-contained: every field reference resolves inside the starter's closure.
  expect(result.findings.filter((finding: { code: string }) => finding.code === 'IA-COMP-FIELD-REF-MISSING')).toEqual(
    [],
  );
  expect(readFileSync(system, 'utf8')).toBe(starter);
  const inspected = await run(['inspect', '--root', root, '--path', '.ia/src/systems/demo/records/work.ia', '--json']);
  expect(inspected.exitCode, inspected.stdout).toBe(0);
  expect(
    json(inspected)
      .records.map((record: { identity: string }) => record.identity)
      .sort(),
  ).toEqual([
    'work-system/contract/spec/example-reference-spec',
    'work-system/contract/spec/example-spec',
    'work-system/definition/decision/example-decision',
    'work-system/definition/decision/example-split-decision',
    ...['milestone', 'plan', 'task'].map((word) => `work-system/definition/${word}/example-${word}`),
  ]);
  // The selected work example also contains two spec contracts, one partially superseding the other. The
  // requirement admits all seven; without it every definition and both spec contracts must refuse through the same
  // foreign-discriminator check.
  writeFileSync(system, starter.replace('    - work-system\n', ''));
  const refused = json(await run(['validate', '--root', root, '--json']));
  const errors = refused.findings.filter((finding: { severity: string }) => finding.severity === 'error');
  expect(errors.map((finding: { code: string }) => finding.code)).toEqual(
    Array(7).fill('IA-COMP-DISCRIMINATOR-FOREIGN'),
  );
});

/** Interrupts one apply at `name`, recovers when a pending generation is left, and resumes to the uninterrupted end state. */
async function interruptAndResume(name: string): Promise<void> {
  const root = target();
  await expect(
    applyInit(view(root), {
      packageRoot: cli,
      checkpoint: (at) => {
        if (at === name) throw new Error(`interrupted at ${at}`);
      },
    }),
  ).rejects.toThrow(`interrupted at ${name}`);
  if (existsSync(resolve(root, INSTALL_PATHS.pending))) {
    // M5.2 §4.1 recovery-required: refused before any write, naming the recovery command.
    const before = tree(root),
      refused = await plan(root);
    expect(refused.exitCode, name).toBe(3);
    expect(json(refused).next, name).toContain('ia-distribution recover');
    expect(tree(root), name).toEqual(before);
    recoverInstallation(root);
  }
  const resumed = await apply(root);
  expect(resumed.exitCode, `${name}: ${resumed.stdout}`).toBe(0);
  expect(tree(root), name).toEqual(await referenceTree());
}

it.each(['manifest:', 'generation:', 'pending', 'portable-lock', 'active', 'complete'])(
  'reaches the uninterrupted end state after an interruption at every %s checkpoint',
  async (prefix) => {
    const names = (await checkpointNames()).filter((name) => name.startsWith(prefix));
    expect(names.length, prefix).toBeGreaterThan(0);
    for (const name of names) await interruptAndResume(name);
  },
  120_000,
);

// One `store:` checkpoint per file of the base package: dozens, which together outran one case's budget on Windows CI.
// Each is its own case, named before collection by one uninterrupted apply, so the budget is per checkpoint and a
// failure names the file.
const storeCheckpoints = (await checkpointNames()).filter((name) => name.startsWith('store:'));
it('passes at least one store: checkpoint, one per file of the base package', () => {
  expect(storeCheckpoints.length).toBeGreaterThan(0);
});
it.each(storeCheckpoints)(
  'reaches the uninterrupted end state after an interruption at the %s checkpoint',
  interruptAndResume,
  120_000,
);

it.each(['install', 'system', 'records'] as const)(
  'stops at the %s boundary on a signal, names the rerun, and the rerun finishes',
  async (step) => {
    const root = target(),
      controller = new AbortController();
    const interrupted = applyInit(
      { ...view(root), invocation: `ia init ${root}` },
      {
        packageRoot: cli,
        signal: controller.signal,
        checkpoint: (name) => {
          if (name === `init:${step}`) controller.abort();
        },
      },
    );
    await expect(interrupted).rejects.toBeInstanceOf(Interrupted);
    await expect(interrupted).rejects.toMatchObject({
      next: `Run "ia init ${root} --apply --yes" again to finish initializing.`,
    });
    const planned = json(await plan(root));
    expect(planned.plan.state).toBe('resumable');
    const done = ['install', 'system', 'records'].slice(0, ['install', 'system', 'records'].indexOf(step) + 1);
    expect(planned.plan.steps).toEqual(
      ['install', 'system', 'records', 'descriptor'].map((id) => ({
        id,
        status: done.includes(id) ? 'done' : 'pending',
      })),
    );
    const resumed = await apply(root);
    expect(resumed.exitCode).toBe(0);
    expect(json(resumed).applied.resumed).toBe(true);
    expect(tree(root)).toEqual(await referenceTree());
  },
);

it('treats a completed workspace as initialized: the rerun refuses and changes nothing', async () => {
  const root = target();
  expect((await apply(root)).exitCode).toBe(0);
  const before = tree(root);
  const planned = json(await plan(root));
  expect(planned.plan.state).toBe('conflict');
  expect(planned.plan.conflicts).toEqual([{ path: '.ia/release.json', reason: 'The target is already initialized' }]);
  const refused = await apply(root);
  expect(refused.exitCode).toBe(3);
  expect(json(refused)).toMatchObject({
    code: 'IA-CLI-CONFLICT',
    exit: 3,
    message: 'The target is already initialized: .ia/release.json',
  });
  const human = await run(['init', root, '--apply', '--yes']);
  expect(human.stderr).toContain('already initialized');
  expect(tree(root)).toEqual(before);
});

/** A target interrupted after `step`, so the starter paths exist and a rerun would otherwise resume. */
async function interruptedAfter(step: 'install' | 'system' | 'records', name = 'demo'): Promise<string> {
  const root = target(name),
    controller = new AbortController();
  await expect(
    applyInit(view(root), {
      packageRoot: cli,
      signal: controller.signal,
      checkpoint: (at) => {
        if (at === `init:${step}`) controller.abort();
      },
    }),
  ).rejects.toBeInstanceOf(Interrupted);
  return root;
}
async function refusesUnchanged(root: string, extra: readonly string[] = []): Promise<any> {
  const before = tree(root),
    planned = json(await plan(root, extra));
  expect(planned.plan.state).toBe('conflict');
  const refused = await apply(root, extra);
  expect(refused.exitCode).toBe(3);
  expect(json(refused).code).toBe('IA-CLI-CONFLICT');
  expect(tree(root)).toEqual(before);
  return planned.plan;
}

it('makes an edited starter, a foreign system folder, another lock request and a different --id conflicts', async () => {
  const edited = await interruptedAfter('system');
  writeFileSync(
    resolve(edited, '.ia/src/systems/demo/system.ia'),
    readFileSync(resolve(edited, '.ia/src/systems/demo/system.ia'), 'utf8') + '\n',
  );
  expect((await refusesUnchanged(edited)).conflicts).toEqual([
    { path: '.ia/src/systems/demo/system.ia', reason: 'Differs from the starter this initialization writes' },
  ]);

  const foreign = await interruptedAfter('install');
  mkdirSync(resolve(foreign, '.ia/src/systems/other'), { recursive: true });
  writeFileSync(resolve(foreign, '.ia/src/systems/other/system.ia'), '#! ia 1.0\n');
  expect((await refusesUnchanged(foreign)).conflicts.map((row: { path: string }) => row.path)).toEqual(['.ia/src']);

  // The base installed under a request other than the one init plans.
  const locked = target();
  cacheArchive(locked, base.bytes, pin.archive);
  const choices = await resolveCatalog({
    root: locked,
    entries: [{ path: `.ia/distributions/cache/${pin.archive}.ia.tgz`, withdrawn: false }],
    offline: true,
  });
  applyInstallation(
    planInstallation(
      locked,
      resolveReleases([{ id: BASE_ID, range: '*' }], choices, DISTRIBUTION_ENGINE_VERSION).lock,
      'install',
    ),
  );
  expect((await refusesUnchanged(locked)).conflicts.map((row: { path: string }) => row.path)).toEqual([
    INSTALL_PATHS.lock,
    INSTALL_PATHS.active,
  ]);

  // A different --id plans a different system folder, which makes the existing one foreign (M5.2 §4.1).
  const renamed = await interruptedAfter('records');
  const plan = await refusesUnchanged(renamed, ['--id', 'local/other']);
  expect(plan.conflicts.map((row: { path: string }) => row.path)).toEqual(['.ia/src']);
  expect(plan.conflicts[0].reason).toContain('.ia/src/systems/demo/');
});

it('lists and removes leftover temporary files, and keeps any other extra file a conflict', async () => {
  const root = await interruptedAfter('install');
  const leftovers = [
    `.ia/src/systems/demo/system.ia.${randomUUID()}.tmp`,
    `.ia/src/systems/demo/records/workspace.ia.${randomUUID()}.tmp`,
    `.ia/release.json.${randomUUID()}.tmp`,
  ];
  for (const path of leftovers) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), 'partial');
  }
  const planned = json(await plan(root));
  expect(planned.plan.state).toBe('resumable');
  expect(planned.plan.leftovers).toEqual(
    [...leftovers].sort().map((path) => ({ path, reason: 'leftover temporary file' })),
  );
  expect((await run(['init', root])).stdout).toContain('leftover temporary file');
  expect((await apply(root)).exitCode).toBe(0);
  expect(tree(root)).toEqual(await referenceTree());

  for (const extra of [
    '.ia/src/systems/demo/notes.txt',
    '.ia/src/systems/demo/system.ia.tmp',
    `.ia/src/systems/demo/system.ia.${randomUUID().toUpperCase()}.tmp`,
  ]) {
    const other = await interruptedAfter('install');
    mkdirSync(dirname(resolve(other, extra)), { recursive: true });
    writeFileSync(resolve(other, extra), 'extra');
    expect((await refusesUnchanged(other)).conflicts, extra).toEqual([
      { path: extra, reason: 'A file this initialization does not write' },
    ]);
  }
});

it('leaves the directory byte-identical when the signal arrives before the first write', async () => {
  for (const create of [true, false]) {
    const root = target('demo', create),
      before = tree(root),
      controller = new AbortController();
    const host = makeHost({ interactive: true });
    const result = await dispatch(
      ['init', root, '--apply'],
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
    expect(result).toEqual({
      exitCode: 130,
      stdout: '',
      stderr: `Interrupted. Run "ia init ${quote(root)} --apply" again.\n`,
    });
    expect(existsSync(root)).toBe(create);
    expect(tree(root)).toEqual(before);
  }
});

it('asks once on a terminal, and a declined question writes nothing', async () => {
  const root = target(),
    prompts: string[] = [];
  const declined = await run(['init', root, '--apply'], { interactive: true, answers: ['n'], prompts });
  expect(declined.exitCode).toBe(0);
  expect(declined.stdout).toContain('Nothing was applied.');
  expect(prompts.join('')).toContain('Steps');
  expect(prompts.at(-1)).toBe('Apply these changes? [y/N] ');
  expect(readdirSync(root)).toEqual([]);
  const accepted = await run(['init', root, '--apply'], { interactive: true, answers: ['yes'] });
  expect(accepted.exitCode).toBe(0);
  expect(tree(root)).toEqual(await referenceTree());
});

/*
 * Host plugin distribution spec §3: a workspace is never created in, around or inside the IA home. The plain
 * `ia init` in a new terminal targets the user's home directory, which holds `~/.ia`, so this is one command away.
 */
it('refuses to initialize a directory holding the IA home, the home itself or a directory inside it, and writes nothing', async () => {
  const parent = target('owner'),
    home = resolve(parent, '.ia'),
    inside = resolve(home, 'project');
  mkdirSync(inside, { recursive: true });
  const env = { IA_HOME: home };
  for (const root of [parent, home, inside]) {
    const before = tree(parent);
    for (const result of [await plan(root, [], { env }), await apply(root, [], { env })]) {
      expect(result.exitCode, `${root} ${result.stdout}`).toBe(3);
      expect(json(result)).toMatchObject({ ok: false, code: 'IA-DIST-PATH-UNSAFE', exit: 3 });
      // Design row 27: the one command is the plan of this target again, once IA_HOME is moved outside it.
      expect(commandsIn(json(result).next), root).toEqual([`ia init ${quote(root)}`]);
    }
    expect(tree(parent), root).toEqual(before);
  }
  // A decline writes nothing into the target, so it stays available wherever the home is.
  expect((await run(['init', parent, '--decline', 'today', '--json'], { env })).exitCode).toBe(0);
});

/*
 * Host registration spec §4 "init --host" and §10 item 10. Every case points IA_HOST_HOME (the alias for IA_HOME) at
 * a scratch directory, so no test writes the real IA home. A root-level `.mcp.json` is not an init conflict — M5.2 §4.1
 * inspects only `.ia/`, the lock and the install state — so the refusal case seeds it before the one apply.
 */
it.each(['claude', 'codex'] as const)('init --host %s --apply ends initialized and registered', async (selected) => {
  const root = target(),
    env = { IA_HOST_HOME: scratch('init-host-home') };
  const result = await apply(root, ['--host', selected], { env });
  expect(result.exitCode, result.stdout).toBe(0);
  const envelope = json(result);
  expect(envelope.plan.host).toEqual({ selected, status: 'planned' });
  expect(envelope.applied).toMatchObject({
    status: 'initialized',
    resumed: false,
    id: 'local/demo',
    host: { status: 'host-registered', observed: false },
  });
  // Milestone position-packet (B11): ia host registers no steward guard, so the host step has no hooks element.
  expect(envelope.applied.host.elements.map((row: { id: string }) => row.id)).toEqual(['mcp', 'context', 'projection']);
  expect(existsSync(resolve(root, '.ia/release.json'))).toBe(true);
  expect(existsSync(resolve(root, selected === 'claude' ? '.mcp.json' : '.codex/config.toml'))).toBe(true);
  // The host step is the `ia host` path itself: planning it again finds its MCP entry already in place.
  const replanned = JSON.parse((await run(['host', selected, '--root', root, '--json'], { env })).stdout);
  expect(replanned.plan.elements.find((row: { id: string }) => row.id === 'mcp').action).toBe('unchanged');
});

it.each(['claude', 'codex'] as const)(
  'init --host %s --apply asks once on a terminal and renders the registration as written, with its machine-local notes',
  async (selected) => {
    const root = target(),
      env = { IA_HOST_HOME: scratch('init-host-home') },
      prompts: string[] = [];
    const result = await run(['init', root, '--host', selected, '--apply'], {
      env,
      interactive: true,
      answers: ['y'],
      prompts,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    // One question, and its summary names the host step it covers.
    expect(prompts.filter((text) => text.endsWith('[y/N] '))).toEqual(['Apply these changes? [y/N] ']);
    expect(prompts.join('').replace(/\s+/g, ' ')).toContain(
      `--host ${selected} selected; registered after initialization by ia host`,
    );
    // §6.4 wraps at 80 columns, so the notes are compared with each break folded back to a space.
    const text = result.stdout.replace(/\s+/g, ' ');
    expect(text).toContain(`Registered with ${selected}; written, not observed answering.`);
    // Spec §5.3's machine-local sentence for this host, and §5.4's approval note for Claude alone.
    expect(text).toContain(MACHINE_LOCAL[selected]);
    expect(text.includes(MCP_APPROVAL)).toBe(selected === 'claude');
    expect(text.includes(GUARD_SCOPE)).toBe(selected === 'claude');
    expect(existsSync(resolve(root, selected === 'claude' ? '.mcp.json' : '.codex/config.toml'))).toBe(true);
  },
);

it('init --host claude --apply stays initialized when the host step refuses, and names the rerun for its root', async () => {
  const root = target(),
    env = { IA_HOST_HOME: scratch('init-host-home') },
    cwd = dirname(root);
  const teammate = JSON.stringify({ mcpServers: { 'ia-workspace': { command: 'x' } } }) + '\n';
  writeFileSync(resolve(root, '.mcp.json'), teammate);
  expect(json(await plan(root)).plan.conflicts).toEqual([]);
  // The target is named relative to its parent, so a rerun from this cwd reaches it only through --root.
  const result = await run(['init', 'demo', '--apply', '--yes', '--json', '--host', 'claude'], { env, cwd });
  expect(result.exitCode, result.stdout).toBe(3);
  // The service's code and location are kept (contract §4.1). The next action is ia host's own remedy for an unowned
  // entry (spec §5.3), after the sentence saying initialization completed, with --root in the command it names.
  expect(json(result)).toMatchObject({
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    exit: 3,
    where: { path: '.mcp.json' },
  });
  expect(json(result).next).toBe(
    `The workspace is initialized. Remove that entry, then run "ia host claude --root ${quote(root)} --apply".`,
  );
  expect(existsSync(resolve(root, '.ia/release.json'))).toBe(true);
  expect(readFileSync(resolve(root, '.mcp.json'), 'utf8')).toBe(teammate);
  // The host step refused while planning, before its payload or any host file was written.
  expect(existsSync(resolve(root, '.claude'))).toBe(false);
  expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);
  // Initialization completed, so rerunning init is the already-initialized conflict; ia host is the way on.
  expect(json(await plan(root)).plan.conflicts).toEqual([
    { path: '.ia/release.json', reason: 'The target is already initialized' },
  ]);
  // Once the entry is removed, the named command, run from the same cwd, finishes the registration.
  writeFileSync(resolve(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }) + '\n');
  const finished = await run(['host', 'claude', '--root', root, '--apply', '--yes', '--json'], { env, cwd });
  expect(finished.exitCode, finished.stdout).toBe(0);
  expect(json(finished).applied.status).toBe('host-registered');
});

it('init --host claude --apply interrupted after initialization names the rooted rerun and writes nothing host-side', async () => {
  // Design row 27: the rerun the verb supplies is the interruption's next command, on stderr and in the --json object.
  for (const machine of [false, true]) {
    const root = target(),
      env = { IA_HOST_HOME: scratch('init-host-home') },
      release = resolve(root, '.ia/release.json');
    // runInit exposes no checkpoint through dispatch, so this signal is aborted exactly when the last init write has
    // landed: it reads the descriptor's existence, which is the moment M5.2 §4.1 calls completion. Only `aborted` and
    // `throwIfAborted` are read on this path (consumer.ts, init.ts, host.ts).
    const signal = {
      get aborted() {
        return existsSync(release);
      },
      get reason() {
        return new Error('Interrupted');
      },
      throwIfAborted() {
        if (existsSync(release)) throw new Error('Interrupted');
      },
    } as unknown as AbortSignal;
    const result = await dispatch(
      ['init', root, '--apply', '--yes', '--host', 'claude', ...(machine ? ['--json'] : [])],
      { ...makeHost({ env }), signal },
      () => {
        throw new Error('Unexpected machine route');
      },
      [],
    );
    const next = `The workspace is initialized. Run "ia host claude --root ${quote(root)} --apply" to finish host registration.`;
    expect(result).toEqual({
      exitCode: 130,
      stdout: machine
        ? `${JSON.stringify({ version: 1, ok: false, code: 'IA-CLI-INTERRUPTED', message: 'Interrupted.', exit: 130, next })}
`
        : '',
      stderr: `Interrupted. ${next}
`,
    });
    expect(existsSync(release)).toBe(true);
    expect(existsSync(resolve(root, '.mcp.json'))).toBe(false);
    expect(existsSync(resolve(root, '.claude'))).toBe(false);
    expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);
  }
});

it('roots every ia host command a remedy names, and only those', () => {
  const next =
    'Delete the ia-workspace entry, then run "ia host claude --remove --apply" and "ia host claude --apply".';
  expect(rootedNext(next, 'claude', 'C:/work/my demo')).toBe(
    'Delete the ia-workspace entry, then run "ia host claude --root "C:/work/my demo" --remove --apply" and "ia host claude --root "C:/work/my demo" --apply".',
  );
  const recover = 'Run "ia-distribution recover-host --root /w", then rerun "ia host codex".';
  expect(rootedNext(recover, 'codex', '/w')).toBe(
    'Run "ia-distribution recover-host --root /w", then rerun "ia host codex --root /w".',
  );
  expect(rootedNext('Run "ia host claude --root /w --apply".', 'claude', '/w')).toBe(
    'Run "ia host claude --root /w --apply".',
  );
});

/*
 * A recovery whose follow-up is "rerun" cannot follow init --host: the init has completed, and running it again refuses
 * the initialized target. The next action names `ia host`, which names that recovery itself and is what runs again.
 */
it('names ia host, which names the recovery, when a pending journal stops the host step of init --host', async () => {
  const root = target(),
    env = { IA_HOST_HOME: scratch('init-host-home') };
  mkdirSync(resolve(root, '.ia/distributions/hosts'), { recursive: true });
  writeFileSync(resolve(root, '.ia/distributions/hosts/guard-pending.json'), '{}\n');
  const refused = await apply(root, ['--host', 'claude'], { env });
  expect(refused.exitCode, refused.stdout).toBe(3);
  const host = `ia host claude --root ${quote(root)} --apply`;
  expect(json(refused)).toMatchObject({
    code: 'IA-DIST-RECOVERY-REQUIRED',
    next: `The workspace is initialized. Run "${host}" for the recovery it names, then run it again to finish host registration.`,
  });
  expect(existsSync(resolve(root, '.ia/release.json'))).toBe(true);
  const named = await run([...nextArgv(json(refused).next), '--yes', '--json'], { env });
  expect(json(named)).toMatchObject({
    code: 'IA-DIST-RECOVERY-REQUIRED',
    next: `Run "ia-distribution recover-guard --root ${quote(realpathSync(root))}", then rerun.`,
  });
});

/** tests/init-kill.ts: a child that runs the apply and calls `process.exit` inside one installer checkpoint. */
const KILL = resolve(import.meta.dirname, 'init-kill.ts');
it.each(['store:', 'pending', 'active', 'complete'])(
  'classifies a hard kill at the first %s checkpoint as recovery-required, and recovery then reaches the end state',
  async (prefix) => {
    const name = (await checkpointNames()).find((at) => at.startsWith(prefix))!,
      root = target();
    // A real kill: the installer's `finally` never runs, so its lock survives, with or without a journal.
    const child = await runBounded(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', KILL, name, root, cli],
      { cwd: repository, timeoutMs: 120_000 },
    );
    expect(child.status, `${name}: ${child.stderr}`).toBe(86);
    expect(existsSync(resolve(root, INSTALL_LOCK)), name).toBe(true);
    const journal = existsSync(resolve(root, INSTALL_PATHS.pending));
    expect(journal, name).toBe(prefix === 'pending' || prefix === 'active');
    // M5.2 §4.1 recovery-required: the plan and the apply both refuse at class 3 before any write, naming recovery.
    const before = tree(root);
    for (const refused of [await plan(root), await apply(root)]) {
      expect(refused.exitCode, name).toBe(3);
      expect(json(refused).next, name).toContain(`"ia-distribution recover --root ${quote(root)}"`);
      if (!journal)
        expect(json(refused), name).toMatchObject({
          code: 'IA-CLI-RECOVERY-REQUIRED',
          message: `An installer holds or left the install lock ${INSTALL_LOCK}`,
        });
    }
    expect(tree(root), name).toEqual(before);
    // `ia-distribution recover`'s own function clears the dead holder's lock, and rolls a journal back or forward.
    expect(recoverInstallation(root).status, name).toBe(journal ? 'recovered' : 'current');
    expect(existsSync(resolve(root, INSTALL_LOCK)), name).toBe(false);
    const resumed = await apply(root);
    expect(resumed.exitCode, `${name}: ${resumed.stdout}`).toBe(0);
    expect(tree(root), name).toEqual(await referenceTree());
  },
  120_000,
);

it('refuses while a live installer holds the lock, and recovery does not take it from that installer', async () => {
  const root = target();
  mkdirSync(resolve(root, '.ia/distributions'), { recursive: true });
  writeFileSync(resolve(root, INSTALL_LOCK), JSON.stringify({ pid: process.pid }));
  const before = tree(root),
    refused = await apply(root);
  expect(refused.exitCode).toBe(3);
  expect(json(refused).code).toBe('IA-CLI-RECOVERY-REQUIRED');
  expect(() => recoverInstallation(root)).toThrow('Native lock belongs to a running process');
  expect(tree(root)).toEqual(before);
});

it('ships a base pin that matches the native version policy and its one archive', () => {
  // M5.2 §2.3's apps/cli half; tools/native/language-base.test.ts shows each check failing on disagreement.
  const shipped = JSON.parse(readFileSync(resolve(cli, PIN_PATH), 'utf8'));
  expect(shipped.version).toBe(
    JSON.parse(readFileSync(resolve(repository, 'examples/public-language/versions.json'), 'utf8')).language,
  );
  expect(readdirSync(resolve(cli, 'assets/base'))).toEqual([`${shipped.archive}.ia.tgz`]);
  const bytes = readFileSync(resolve(cli, `assets/base/${shipped.archive}.ia.tgz`));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(shipped.archive);
  expect(readBase(cli).pin).toEqual(shipped);
});

it('refuses before any write when the bundled bytes do not match the pin', async () => {
  const packageRoot = resolve(scratch('package'), 'cli');
  cpSync(resolve(cli, 'assets'), resolve(packageRoot, 'assets'), { recursive: true });
  const archive = resolve(packageRoot, `assets/base/${pin.archive}.ia.tgz`),
    bytes = readFileSync(archive);
  bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
  writeFileSync(archive, bytes);
  const root = target(),
    host = { ...makeHost(), packageRoot };
  const refused = await dispatch(
    ['init', root, '--apply', '--yes', '--json'],
    host,
    () => ({ exitCode: 2, stdout: '' }),
    [],
  );
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-ARCHIVE-INVALID',
    next: 'The ia installation is damaged; run "ia doctor" for its install channel and reinstall @inventarch/cli through it.',
  });
  writeFileSync(resolve(packageRoot, PIN_PATH), '{}');
  expect(
    JSON.parse((await dispatch(['init', root, '--json'], host, () => ({ exitCode: 2, stdout: '' }), [])).stdout),
  ).toMatchObject({ code: 'IA-CLI-FAILED', exit: 3 });
  expect(readdirSync(root)).toEqual([]);
});
it('reads the macOS git stub that asks for the Command Line Tools as git being unavailable (#323)', () => {
  const stub = (stderr: string) => gitAnswer({ status: 1, stdout: '', stderr });
  expect(
    stub(
      'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n',
    ),
  ).toBeNull();
  expect(stub('xcode-select: note: No developer tools were found, requesting install.\n')).toBeNull();
  // Without a GUI session (SSH, CI, a launchd agent) libxcselect prints an error instead of the note.
  expect(
    stub(
      'xcode-select: error: No developer tools were found and no install could be requested (possibly because there is no active GUI session).\n',
    ),
  ).toBeNull();
  // Only a failing run whose stderr starts a line with the stub's words is the stub.
  expect(gitAnswer({ status: 0, stdout: 'true\n', stderr: 'xcrun: error: unrelated note\n' })).toEqual({
    status: 0,
    stdout: 'true\n',
  });
  expect(
    gitAnswer({ status: 128, stdout: '', stderr: 'fatal: unable to run hook: xcrun: error: unable to find utility\n' }),
  ).toEqual({ status: 128, stdout: '' });
  expect(
    gitAnswer({ status: 1, stdout: '', stderr: 'hook: xcode-select: note: No developer tools were found\n' }),
  ).toEqual({ status: 1, stdout: '' });
  // A real git that answers, even with a failure, is an answer; one that cannot start is not there.
  expect(
    gitAnswer({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    }),
  ).toEqual({ status: 128, stdout: '' });
  expect(gitAnswer({ status: 0, stdout: 'true\n', stderr: '' })).toEqual({ status: 0, stdout: 'true\n' });
  expect(gitAnswer({ error: new Error('spawn git ENOENT'), status: null, stdout: '', stderr: '' })).toBeNull();
  expect(readProvenance(() => stub('xcrun: error: invalid active developer path\n'))).toMatchObject({ missing: 'git' });
  if (process.platform === 'win32') return;
  // The same through a real process: a `git` on PATH that behaves like the stub.
  const bin = resolve(scratch('git-stub'), 'bin'),
    stubGit = resolve(bin, 'git');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    stubGit,
    '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2\nexit 1\n',
  );
  chmodSync(stubGit, 0o755);
  expect(readProvenance(gitIn(bin, { PATH: bin }))).toMatchObject({ missing: 'git' });
});
