/**
 * Host installation acceptance: preflight refusals and projection refresh after install or removal.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { json } from '@inventarch/distribution/services';
import { rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { DESCRIPTOR, packable, run, scratch } from './workspace-fixture.js';
import {
  put,
  read,
  initialized,
  host,
  deadPid,
  HOST_LOCK,
  lockNext,
  GUARD_STATE,
  guardGroups,
  LEGACY_FILES,
  legacyRegistration,
  RECEIPT,
  STEWARD,
} from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

/**
 * A seam on apps/distribution's applyProjection, which writes and deletes every projection file, so a test can fail
 * the first file change of an install's projection refresh at its `pending` stage. Every call passes through.
 */
const seams = vi.hoisted(() => ({ failAt: undefined as string | undefined }));
vi.mock('@inventarch/distribution/projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/distribution/projection')>();
  return {
    ...actual,
    applyProjection: (plan: Parameters<typeof actual.applyProjection>[0], checkpoint?: (name: string) => void) =>
      actual.applyProjection(plan, (name) => {
        if (name === seams.failAt) throw new Error('file write failed');
        checkpoint?.(name);
      }),
  };
});

/**
 * Spec §4 "install, update, remove": a workspace offered fixture/foundation, packed from the loop fixture, and a
 * request set naming only it. Applying the set replaces the bundled base, so the projection — the position packet of
 * the admitted records — must change. The two cannot be installed side by side: both ship agent-system. A second
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
  // The starter composes the base's eleven systems, and its @workspace and @mandate state fields the loop fixture's
  // closed schemas do not declare (`composition.sources` and `steward`, the `authority` section). A consumer who
  // replaces the bundled base with fixture/foundation authors records that foundation admits first, or admission
  // refuses: its five systems, and a participant @agent with no @mandate.
  const starter = '.ia/src/workspace.ia';
  expect(read(root, starter)).toContain('    sources [".ia/src @authored"]\n');
  put(
    root,
    starter,
    [
      '#! ia 1.0',
      '',
      '@workspace demo',
      '  meaning',
      '    says "The demo workspace and the systems fixture/foundation ships."',
      '    answers "Which systems does this workspace compose?"',
      '  composition',
      `    systems [${['agent-system', 'compliance-system', 'governance-system', 'session-system', 'workspace-system'].map((name) => `@system ${name}`).join(', ')}]`,
      '',
      '@agent demo',
      '  meaning',
      '    says "The IDE agent operating in the demo workspace, any vendor."',
      '    answers "Which participant acts in the demo workspace?"',
      '  governance',
      '    applies []',
      '',
    ].join('\n'),
  );
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
/** The packet digest of the receipt the last projection apply wrote (B12). */
const packetDigest = (root: string): string => JSON.parse(read(root, RECEIPT)).packetDigest;
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
  const based = { rules: read(root, RULES), digest: packetDigest(root) };
  expect(JSON.parse((await install('--json')).stdout).refresh).toEqual(['claude']);
  expect(flat((await install()).stdout)).toContain('Registered host projections (claude) are refreshed after apply.');

  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  // `applied` is exactly applyInstallation's return, its host literal included (contract §2.8).
  expect(Object.keys(envelope.applied).sort()).toEqual(['counter', 'generation', 'host', 'status']);
  expect(envelope.applied).toMatchObject({ status: 'installed', host: 'pending' });
  expect(envelope.refresh).toEqual(['claude']);
  // No steward guard was registered, so the refresh retired none.
  expect(envelope.retired).toBeUndefined();
  // The packet is rendered from the new generation's records: the receipt names another packet, the current one.
  expect(read(root, RULES)).not.toBe(based.rules);
  expect(packetDigest(root)).not.toBe(based.digest);
  const installed = read(root, RULES);
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
  const extra = read(root, RULES);
  expect(extra).not.toBe(installed);
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });
  const removed = await run(['remove', 'fixture/extra', '--root', root, '--apply', '--yes', '--json'], { env });
  expect(removed.exitCode, removed.stdout).toBe(0);
  expect(JSON.parse(removed.stdout).refresh).toEqual(['claude']);
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(read(root, RULES)).not.toBe(extra);
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });
});

/**
 * Milestone position-packet's upgrade path through the install refresh (B9, B11, B12): a workspace a 1.x `ia host
 * claude --apply` registered, its guard group and state, its projection state listing demo-steward.md and that
 * marked file. The refresh goes through the same writer as `ia host`, so it retires the guard before any file.
 */
it('retires a 1.x steward guard and deletes its steward file when an install refreshes the projection', async () => {
  const { root, env, install } = await offered();
  legacyRegistration(root, env);
  put(root, '.claude/agents/x.md', 'my own agent\n');
  expect(guardGroups(root)).toBe(1);
  // The plan names the refresh and the retirement it starts with (B11), and writes nothing.
  expect(JSON.parse((await install('--json')).stdout)).toMatchObject({ refresh: ['claude'], retire: ['claude'] });
  expect(flat((await install()).stdout)).toContain(
    'Registered host projections (claude) are refreshed after apply; the refresh first retires the steward guard registered in .claude/settings.local.json (claude).',
  );
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(true);
  const applied = await install('--apply', '--yes', '--json');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  // The result reports the retirement; the guard group and its state file are gone.
  expect(envelope).toMatchObject({ refresh: ['claude'], retire: ['claude'], retired: ['claude'] });
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  // demo-steward.md is deleted and the receipt lists it; the unmarked agent file is left and listed foreign.
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(read(root, '.claude/agents/x.md')).toBe('my own agent\n');
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({
    guard: 'retired',
    removed: [{ path: STEWARD, sha256: createHash('sha256').update(LEGACY_FILES[STEWARD]!).digest('hex') }],
    foreign: ['.claude/agents/x.md'],
  });
  expect(read(root, RULES)).toContain('# IA position packet: demo');
  // The human report of the next refresh names no retirement, since nothing was left to retire.
  const updated = await run(
    ['update', 'fixture/foundation', '--to', '^0.1.0', '--catalog', CATALOG, '--root', root, '--apply', '--yes'],
    { env },
  );
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(flat(updated.stdout)).toContain(
    'Registered host projections (claude) were refreshed; run "ia doctor" for host state.',
  );
  // Nor does a plan once nothing is left to retire.
  const planned = JSON.parse((await install('--json')).stdout);
  expect(planned.refresh).toEqual(['claude']);
  expect(planned).not.toHaveProperty('retire');
});

it('retires the guard before the refresh changes any projection file: a failing file write leaves it retired', async () => {
  const { root, env, install } = await offered();
  legacyRegistration(root, env);
  // The refresh's first file change fails after the install committed; the guard retirement has already run.
  seams.failAt = 'pending';
  let failed: Awaited<ReturnType<typeof install>>;
  try {
    failed = await install('--apply', '--yes', '--json');
  } finally {
    seams.failAt = undefined;
  }
  expect(failed.exitCode, failed.stdout).toBe(3);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    message: 'file write failed',
    next: rootedNext('The installation is applied. Run "ia host claude --apply" to finish.', 'claude', root),
  });
  expect(lockedIds(root)).toEqual(['fixture/foundation']);
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  expect(read(root, RULES)).toBe(LEGACY_FILES[RULES]);
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
  // The named rerun converges: nothing is left to retire, and the steward file goes now.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'none', removed: [{ path: STEWARD }] });
});

it('names the retirement in the human report of an install that retired the steward guard', async () => {
  const { root, env, install } = await offered();
  legacyRegistration(root, env);
  const applied = await install('--apply', '--yes');
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(flat(applied.stdout)).toContain(
    'Registered host projections (claude) were refreshed, and the steward guard an earlier release registered was retired first (claude); run "ia doctor" for host state.',
  );
});

it('refuses an install before touching the lock when the guard the refresh would retire was changed by hand', async () => {
  const { root, env, install } = await offered();
  legacyRegistration(root, env);
  const settings = JSON.parse(read(root, '.claude/settings.local.json'));
  settings.hooks.PreToolUse[0].timeout = 99;
  put(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2) + '\n');
  const lock = readFileSync(resolve(root, LOCK));
  const refused = await install('--apply', '--yes', '--json');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: '.claude/settings.local.json' },
    next: rootedNext(
      'Delete the IA guard group in .claude/settings.local.json, then run "ia host claude --apply".',
      'claude',
      root,
    ),
  });
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  // Followed literally: with the group deleted, the retirement removes the ownership state alone.
  delete settings.hooks;
  put(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2) + '\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
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
  expect(read(root, RULES)).toContain('# IA position packet: demo');
  expect(await projectionRows(root, env)).toEqual({ exitCode: 0, rows: [] });

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
  // A projection state that owns the rules file alone, as one written before the skill was projected, and the user's
  // own file where the skill goes. The pre-check sees no hand edit — the file is not one this workspace's projection
  // owns — so the install applies, and the refresh then refuses the unmanaged file rather than replace it (§6.3).
  const state = JSON.parse(read(root, PROJECTION_STATE));
  put(root, PROJECTION_STATE, json({ ...state, files: { [RULES]: state.files[RULES] } }));
  const mine = '.claude/skills/ia-authoring/SKILL.md';
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
  // Doctor reports the drift the refusal left behind: the receipt's packet is not the new generation's.
  expect((await projectionRows(root, env)).rows).toContainEqual(
    expect.objectContaining({ id: 'projection-claude-packet', status: 'warn' }),
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
  expect(read(root, RULES)).not.toBe(rules);
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
  expect((await projectionRows(root, env)).rows).toEqual([]);
});

it('names the pending journal recovery, not a projection file, when a journal blocks the guard retirement a refresh would run', async () => {
  const { root, env, install } = await offered();
  legacyRegistration(root, env);
  const journal = '.ia/distributions/hosts/guard-pending.json';
  put(root, journal, '{}\n');
  const lock = readFileSync(resolve(root, LOCK));
  const refused = await install('--apply', '--yes', '--json');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-DIST-RECOVERY-REQUIRED',
    where: { path: journal },
    next: `Run "ia-distribution recover-guard --root ${quote(root)}", then rerun.`,
  });
  // Nothing was acquired or written.
  expect(readFileSync(resolve(root, LOCK)).equals(lock)).toBe(true);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  expect(guardGroups(root)).toBe(1);
});
