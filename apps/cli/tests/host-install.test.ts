/**
 * Host installation acceptance: preflight refusals and projection refresh after install or removal.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { rootedNext } from '../src/host.js';
import { DESCRIPTOR, packable, run, scratch } from './workspace-fixture.js';
import { put, read, initialized, host, deadPid, HOST_LOCK, lockNext } from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

/**
 * Spec §4 "install, update, remove": a workspace offered fixture/foundation, packed from the loop fixture, and a
 * request set naming only it. Applying the set replaces the bundled base, so the projection's "Installed
 * distributions" section must change. The two cannot be installed side by side: both ship agent-system. A second
 * package, fixture/extra, is the same distribution under another id, so it installs beside fixture/foundation and can
 * be removed from it. Both archives are packed once for the file and copied into each workspace.
 */
const CATALOG = '.ia/work/catalog.json',
  REQUESTS = '.ia/work/requests.json',
  LOCK = '.ia/distributions.lock.json',
  RULES = '.claude/rules/ia-workspace.md',
  PROJECTION_STATE = '.ia/distributions/hosts/claude-projection.json';
async function packAs(id: string): Promise<string> {
  const source = packable();
  put(source, '.ia/work/descriptor.json', JSON.stringify({ ...DESCRIPTOR, id }) + '\n');
  const packed = await run(['pack', '--root', source, '--descriptor', '.ia/work/descriptor.json', '--json']);
  expect(packed.exitCode, packed.stderr).toBe(0);
  return resolve(source, '.ia/work/dist', (JSON.parse(packed.stdout) as { path: string }).path);
}
let packedArchives: Promise<readonly string[]> | undefined;
const fixtureArchives = (): Promise<readonly string[]> =>
  (packedArchives ??= Promise.all([packAs('fixture/foundation'), packAs('fixture/extra')]));
async function offered(): Promise<{
  root: string;
  env: { IA_HOST_HOME: string };
  install: (...extra: string[]) => ReturnType<typeof run>;
}> {
  const { root, env } = await initialized();
  // The starter requires work-system, which fixture/foundation (the loop fixture) does not ship. A consumer who
  // replaces the bundled base with a foundation lacking it must drop the requirement first, or admission refuses.
  const starter = '.ia/src/systems/demo/system.ia',
    text = read(root, starter);
  expect(text).toContain('    - work-system\n');
  put(root, starter, text.replace('    - work-system\n', ''));
  mkdirSync(resolve(root, '.ia/work/dist'), { recursive: true });
  const entries = (await fixtureArchives()).map((archive) => {
    copyFileSync(archive, resolve(root, '.ia/work/dist', basename(archive)));
    return { path: `.ia/work/dist/${basename(archive)}`, withdrawn: false };
  });
  put(root, CATALOG, JSON.stringify(entries) + '\n');
  put(root, REQUESTS, JSON.stringify([{ id: 'fixture/foundation', range: '^0.1.0' }]) + '\n');
  const install = (...extra: string[]) =>
    run(['install', '--requests', REQUESTS, '--catalog', CATALOG, '--root', root, ...extra], { env });
  return { root, env, install };
}
const installedSection = (root: string): string =>
  read(root, RULES).split('## Installed distributions')[1]!.split('##')[0]!.trim();
const lockedIds = (root: string): string[] =>
  JSON.parse(read(root, LOCK)).packages.map((pkg: { id: string }) => pkg.id);
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const projectionRows = async (root: string, env: Record<string, string>) => {
  const doctor = await run(['doctor', '--root', root, '--json'], { env });
  return {
    exitCode: doctor.exitCode,
    rows: (JSON.parse(doctor.stdout).checks as { id: string; status: string; detail: string }[]).filter((check) =>
      check.id.startsWith('projection-'),
    ),
  };
};

it('names registered projections in the plan only when one is registered, and refreshes them after apply', async () => {
  const { root, env, install } = await offered();
  // Nothing registered: the plan says nothing about a refresh, in either form.
  expect(JSON.parse((await install('--json')).stdout).refresh).toBeUndefined();
  expect((await install()).stdout).not.toContain('Registered host projections');

  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // The bundled base, named from the lock: the pin is its id's only authority (apps/cli/SPEC.md C08).
  const [base] = JSON.parse(read(root, LOCK)).packages as { id: string; version: string }[];
  expect(installedSection(root)).toBe(`- ${base!.id} ${base!.version}`);
  expect(JSON.parse((await install('--json')).stdout).refresh).toEqual(['claude']);
  expect(flat((await install()).stdout)).toContain('Registered host projections (claude) are refreshed after apply.');

  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  // `applied` is exactly applyInstallation's return, its host literal included (contract §2.8).
  expect(Object.keys(envelope.applied).sort()).toEqual(['counter', 'generation', 'host', 'status']);
  expect(envelope.applied).toMatchObject({ status: 'installed', host: 'pending' });
  expect(envelope.refresh).toEqual(['claude']);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });

  // Human output of an applied update: what was refreshed, never "configured".
  const updated = await run(
    ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
    { env },
  );
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(flat(updated.stdout)).toContain(
    'Registered host projections (claude) were refreshed; run "ia doctor" for host state.',
  );
  expect(updated.stdout).not.toContain('configured');

  // An applied removal refreshes too: install the second package beside the first, then remove it.
  expect(
    (await run(['install', 'fixture/extra@^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'], { env }))
      .exitCode,
  ).toBe(0);
  expect(installedSection(root)).toBe('- fixture/extra 0.1.0\n- fixture/foundation 0.1.0');
  const removed = await run(['remove', 'fixture/extra', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).refresh).toEqual(['claude']);
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });
});

it('refuses an install before touching the lock when a registered projection was edited by hand', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, RULES, read(root, RULES) + 'hand\n');
  const lock = readFileSync(resolve(root, LOCK));
  const cache = readdirSync(resolve(root, '.ia/distributions/cache'));
  const next = rootedNext(`Move or delete ${RULES}, then run "ia host claude --apply".`, 'claude', root);
  for (const refused of [
    await install('--apply', '--yes', '--json'),
    await run(['remove', lockedIds(root)[0]!, '--root', root, '--apply', '--yes', '--json'], { env }),
  ]) {
    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'IA-DIST-LOCAL-MODIFICATION',
      exit: 3,
      where: { path: RULES },
      next,
    });
  }
  // Nothing was acquired or written: the lock is byte for byte, the cache holds no new archive.
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  expect(readdirSync(resolve(root, '.ia/distributions/cache'))).toEqual(cache);
  expect(read(root, RULES).endsWith('hand\n')).toBe(true);
  // A preview is a report, not an apply: it still plans.
  expect((await install()).exitCode).toBe(0);
  // Without --root, the remedy is the bare command, as from the cwd it runs in.
  const discovered = await run(
    ['install', '--requests', REQUESTS, '--catalog', CATALOG, '--apply', '--yes', '--json'],
    { env, cwd: root },
  );
  expect(JSON.parse(discovered.stdout).next).toBe(`Move or delete ${RULES}, then run "ia host claude --apply".`);
});

it('locates an unreadable managed file or ownership state at that file, and each named repair converges', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const lock = readFileSync(resolve(root, LOCK));

  // A hardlinked rules file: the refusal names it, not the ownership state, and so does doctor.
  linkSync(resolve(root, RULES), resolve(scratch('host-alias'), 'alias.md'));
  const aliased = await install('--apply', '--yes', '--json');
  expect(aliased.exitCode).toBe(3);
  expect(JSON.parse(aliased.stdout)).toMatchObject({
    code: 'IA-DIST-PATH-UNSAFE',
    where: { path: RULES },
    next: rootedNext(`Move or delete ${RULES}, then run "ia host claude --apply".`, 'claude', root),
  });
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  const doctor = await projectionRows(root, env);
  expect(doctor.exitCode).toBe(1);
  expect(doctor.rows).toEqual([
    expect.objectContaining({
      id: `projection-claude:${RULES}`,
      status: 'fail',
      detail: expect.stringContaining(`${RULES} cannot be read (IA-DIST-PATH-UNSAFE)`),
    }),
  ]);
  // Followed literally: with the file deleted, the install applies and its refresh writes the file again.
  rmSync(resolve(root, RULES));
  expect((await install('--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');

  // An ownership state that cannot be read: its own repair, located at it.
  put(root, PROJECTION_STATE, 'garbage\n');
  const garbage = await run(
    [
      'update',
      'fixture/foundation',
      '--to',
      '^0.1.0',
      '--catalog',
      CATALOG,
      '--root',
      root,
      '--apply',
      '--yes',
      '--json',
    ],
    { env },
  );
  expect(garbage.exitCode).toBe(3);
  expect(JSON.parse(garbage.stdout)).toMatchObject({
    where: { path: PROJECTION_STATE },
    next: rootedNext(`Delete ${PROJECTION_STATE}, then run "ia host claude --apply".`, 'claude', root),
  });
  rmSync(resolve(root, PROJECTION_STATE));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(
    (
      await run(
        ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
        { env },
      )
    ).exitCode,
  ).toBe(0);
});

it('refuses at class 3 naming the applied install when its projection refresh is refused, and the repair converges', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // An authored system the projection has not rendered yet, and the user's own file where its steward would go.
  // The pre-check sees no hand edit — the file is not one this workspace's projection owns — so the install applies,
  // and the refresh then refuses the unmanaged file rather than replace it (§6.3).
  put(
    root,
    '.ia/src/systems/extra/system.ia',
    [
      '#! ia 1.0',
      '',
      '@system extra',
      '  provider "local"',
      '  version "0.1.0"',
      '  describes "An extra authored system."',
      '  steward @agent extra-steward',
      '  requires',
      '    - agent-system',
      '',
      '@agent extra-steward',
      '  meaning',
      '    says "Owns the extra system."',
      '    answers "Who owns this system?"',
      '  governance',
      '    applies []',
      '',
    ].join('\n'),
  );
  const mine = '.claude/agents/extra-steward.md';
  put(root, mine, 'mine\n');
  const rules = read(root, RULES),
    active = read(root, '.ia/distributions/active.json');
  const next = rootedNext(
    `The installation is applied. Move or delete ${mine}, then run "ia host claude --apply".`,
    'claude',
    root,
  );
  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(3);
  expect(JSON.parse(applied.stdout)).toEqual({
    version: 1,
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    message: expect.stringContaining('Refusing unmanaged file at a managed path'),
    exit: 3,
    where: { path: mine, line: null, identity: null },
    next,
  });
  // The install is committed; the projection is exactly as it was, and the user's file untouched.
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(read(root, '.ia/distributions/active.json')).not.toBe(active);
  expect(read(root, RULES)).toBe(rules);
  expect(read(root, mine)).toBe('mine\n');
  // Doctor reports the drift the refusal left behind.
  expect((await projectionRows(root, env)).rows).toContainEqual(
    expect.objectContaining({ id: `projection-claude:${RULES}`, status: 'warn' }),
  );

  // The human form: the error block on stderr names the file and says the installation is applied.
  const human = await run(
    ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
    { env },
  );
  expect(human.exitCode).toBe(3);
  expect(human.stdout).toBe('');
  expect(flat(human.stderr)).toContain('IA-DIST-LOCAL-MODIFICATION');
  expect(flat(human.stderr)).toContain(next);

  // The named repair, followed literally, finishes the refresh.
  rmSync(resolve(root, mine));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
  expect(existsSync(resolve(root, mine))).toBe(true);
  expect((await projectionRows(root, env)).rows).toEqual([]);
});

it('names the host lock recovery when an install refresh finds the lock held', async () => {
  const { root, env, install } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, HOST_LOCK, JSON.stringify({ pid: deadPid() }) + '\n');
  const refused = await install('--apply', '--yes', '--json');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    where: { path: HOST_LOCK },
    next: `The installation is applied. ${lockNext(root)}`,
  });
  const { recoverHost } = await import('@inventarch/distribution/host');
  expect(recoverHost(root).status).toBe('current');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(installedSection(root)).toBe('- fixture/foundation 0.1.0');
});

it('names the host rerun when an install refresh fails with an error no refusal carries', async () => {
  const { root, env } = await offered();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // The renderer fails with a plain error: no code, no file, no next action of its own. Only this case's own copy of
  // the CLI sees it; the host registration above and every other case use the real renderer.
  vi.doMock('../src/host-projection.js', async (original) => ({
    ...(await original<typeof import('../src/host-projection.js')>()),
    renderProjectionFor: () => {
      throw new Error('The renderer stopped.');
    },
  }));
  vi.resetModules();
  // The re-imported fixture keeps its own list of scratch directories (the config home it hands this run); only its own
  // cleanup removes them, so the finally below calls it.
  let fresh: typeof import('./workspace-fixture.js') | undefined;
  try {
    fresh = await import('./workspace-fixture.js');
    const refused = await fresh.run(
      ['install', '--requests', REQUESTS, '--catalog', CATALOG, '--root', root, '--apply', '--yes', '--json'],
      { env },
    );
    expect(refused.exitCode, refused.stdout).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      code: 'IA-CLI-FAILED',
      message: 'The renderer stopped.',
      next: rootedNext('The installation is applied. Run "ia host claude --apply" to finish.', 'claude', root),
    });
    expect(lockedIds(root)).toEqual(['fixture/foundation']);
  } finally {
    fresh?.cleanup();
    vi.doUnmock('../src/host-projection.js');
    vi.resetModules();
  }
});
