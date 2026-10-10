/**
 * Host recovery acceptance: locks, pending journals and interruption at transaction boundaries.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { put, read, initialized, host, deadPid, HOST_LOCK, lockNext, doctor, row, RECEIPT } from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup, cli, nextArgv, run, scratch } from './workspace-fixture.js';
import { runBounded } from '@tools/testing/subprocess.js';
import { applyGuardRegistration, planGuardRegistration } from '@inventarch/distribution/guard-registration';
import { legacyRegistration, STEWARD, LEGACY_FILES } from './host-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

async function hostContext(root: string, env: { IA_HOST_HOME: string }, ...extra: string[]) {
  const { parseArguments } = await import('../src/args.js');
  const { findCommand } = await import('../src/commands.js');
  const { makeHost } = await import('./workspace-fixture.js');
  const { resolveCapabilities } = await import('../src/render.js');
  const command = findCommand('host')!;
  return {
    host: makeHost({ env }),
    command,
    args: parseArguments(['claude', ...extra, '--root', root, '--apply', '--yes'], command.grammar),
    caps: resolveCapabilities({ env: {}, isTTY: false }),
    json: true,
  };
}
type Raised = { code?: string; next?: string | null; where?: { path?: string } | null };
/** Applies the planned set, running `cut` once the element `at` completes; the refusal raised, if any. */
async function cutAfter(
  root: string,
  env: { IA_HOST_HOME: string },
  at: 'mcp' | 'projection',
  cut: () => void,
  ...extra: string[]
): Promise<Raised> {
  const { collectHost, applyHostSet } = await import('../src/host.js');
  const context = await hostContext(root, env, ...extra);
  try {
    applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
      if (id === at) cut();
    });
  } catch (error) {
    return error as Raised;
  }
  return {};
}
const cutAfterMcp = (root: string, env: { IA_HOST_HOME: string }, cut: () => void): Promise<Raised> =>
  cutAfter(root, env, 'mcp', cut);
it('names the rerun after a failure past the first element, the lock recovery, or the recovery a pending journal needs', async () => {
  // A removal runs projection, then mcp. .mcp.json changes once the projection is removed, so the mcp plan is stale:
  // the rerun finishes the set.
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const stale = await cutAfter(
    root,
    env,
    'projection',
    () => {
      const mcp = JSON.parse(read(root, '.mcp.json'));
      put(root, '.mcp.json', JSON.stringify({ ...mcp, note: 1 }, null, 2) + '\n');
    },
    '--remove',
  );
  expect(stale).toMatchObject({
    code: 'IA-DIST-PLAN-STALE',
    next: rootedNext('Run "ia host claude --remove --apply" to finish.', 'claude', root),
  });
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  const kept = JSON.parse(read(root, '.mcp.json'));
  expect(kept.note).toBe(1);
  expect(kept.mcpServers?.['ia-workspace']).toBeUndefined();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // Another transaction takes the host lock once mcp is written: the lock's recovery decides whether it is live.
  const lock = resolve(root, '.ia/distributions/hosts/lock.json');
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  const busy = await cutAfterMcp(root, env, () => writeFileSync(lock, JSON.stringify({ pid: process.pid }) + '\n'));
  expect(busy).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    where: { path: '.ia/distributions/hosts/lock.json' },
    next: lockNext(root),
  });
  rmSync(lock);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // A journal left pending names its recovery instead.
  const other = await initialized();
  const pending = await cutAfterMcp(other.root, other.env, () =>
    writeFileSync(resolve(other.root, '.ia/distributions/hosts/guard-pending.json'), '{}\n'),
  );
  expect(pending).toMatchObject({
    code: 'IA-DIST-RECOVERY-REQUIRED',
    where: { path: '.ia/distributions/hosts/guard-pending.json' },
  });
  expect(pending.next).toBe(`Run "ia recover guard --root ${quote(other.root)}", then rerun.`);
});

it('names recover-host for a leftover host lock in apply, removal and doctor, and the named recovery converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, HOST_LOCK, JSON.stringify({ pid: deadPid() }) + '\n');
  for (const extra of [[], ['--remove']]) {
    const refused = await host(root, env, 'claude', ...extra, '--apply', '--yes');
    expect(refused.exitCode, extra.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'IA-DIST-INSTALL-BUSY',
      exit: 3,
      where: { path: HOST_LOCK },
      next: lockNext(root),
    });
  }
  const held = await doctor(root, env);
  expect(row(held.checks, 'host-lock')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining(`${HOST_LOCK} is held by another ia host run or was left by a killed one`),
    remedy: `ia recover host --root ${quote(root)}`,
  });
  // A held lock is a warning, not a failure: a live run holds it too.
  expect(held.exitCode).toBe(0);
  // Followed literally: the recovery clears a dead holder's lock, and the rerun converges.
  const { recoverHost } = await import('@inventarch/distribution/host');
  expect(recoverHost(root).status).toBe('current');
  expect(existsSync(resolve(root, HOST_LOCK))).toBe(false);
  expect(row((await doctor(root, env)).checks, 'host-lock')).toMatchObject({
    status: 'info',
    detail: 'Not held',
    remedy: null,
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // A live holder is refused by the same recovery, so the next action is right either way.
  put(root, HOST_LOCK, JSON.stringify({ pid: process.pid }) + '\n');
  expect(() => recoverHost(root)).toThrow(/still running/);
  rmSync(resolve(root, HOST_LOCK));
});

it('reports each pending host journal as a failure naming its own recovery', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const journals = [
    ['pending.json', 'recover-host'],
    ['guard-pending.json', 'recover-guard'],
    ['lifecycle-pending.json', 'recover-lifecycle'],
  ] as const;
  for (const [file, command] of journals) {
    const path = `.ia/distributions/hosts/${file}`;
    put(root, path, '{}\n');
    const report = await doctor(root, env);
    expect(report.exitCode, file).toBe(1);
    expect(row(report.checks, `host-journal:${path}`)).toMatchObject({
      status: 'fail',
      detail: `${path} exists; an ia host transaction was interrupted`,
      remedy: `ia recover ${command.replace('recover-', '')} --root ${quote(root)}`,
    });
    // ia host names the same recovery.
    expect(JSON.parse((await host(root, env, 'claude')).stdout)).toMatchObject({
      code: 'IA-DIST-RECOVERY-REQUIRED',
      where: { path },
    });
    rmSync(resolve(root, path));
  }
  expect((await doctor(root, env)).checks.filter((check) => check.id.startsWith('host-journal:'))).toEqual([]);
});

/**
 * §10 item 8 at the CLI: an interruption at each sub-transaction boundary, then the rerun, ends byte for byte where an
 * uninterrupted apply ends. The reference is taken in the same workspace, because every owned entry embeds the root.
 */
it('converges byte for byte after an interruption at each apply and removal boundary', async () => {
  const { root, env } = await initialized();
  const { collectHost, applyHostSet } = await import('../src/host.js');
  // The receipt records when it was written, so it is compared by presence, not bytes.
  const managed = [
    '.mcp.json',
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.ia/distributions/hosts/claude-workspace.json',
    '.ia/distributions/hosts/claude-projection.json',
  ];
  const snapshot = (): (string | null)[] =>
    managed.map((path) => (existsSync(resolve(root, path)) ? read(root, path) : null));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const reference = snapshot();
  expect(reference.every((bytes) => bytes !== null)).toBe(true);
  for (const cut of ['mcp'] as const) {
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
    const context = await hostContext(root, env);
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect(existsSync(resolve(root, '.claude/rules/ia-workspace.md')), cut).toBe(false);
    expect(existsSync(resolve(root, RECEIPT)), cut).toBe(false);
    // No journal is left at a boundary, so the rerun alone finishes the set.
    expect(
      readdirSync(resolve(root, '.ia/distributions/hosts')).filter(
        (name) => name.endsWith('pending.json') || name === 'lock.json',
      ),
      cut,
    ).toEqual([]);
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
    expect(existsSync(resolve(root, RECEIPT)), cut).toBe(true);
    const report = await doctor(root, env);
    expect(row(report.checks, 'host-claude')?.status, cut).toBe('ok');
    expect(
      report.checks.filter((check) => check.id.startsWith('projection-claude:')),
      cut,
    ).toEqual([]);
  }
  // Removal runs projection, then mcp; cut after the first, the rerun removes exactly the rest.
  for (const cut of ['projection'] as const) {
    const context = await hostContext(root, env, '--remove');
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(managed.map(() => null));
    expect(existsSync(resolve(root, RECEIPT)), cut).toBe(false);
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
  }
});

it('routes explicit-root recovery modes without admission, validates usage, and preserves live-owner refusal', async () => {
  const root = resolve(scratch('recovery'), 'space root');
  mkdirSync(root);
  const help = await run(['recover', '--help']);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('installation|host|guard|lifecycle');
  expect(help.stdout).not.toContain('nearest ancestor');
  for (const args of [
    [],
    ['bogus', '--root', root],
    ['host', 'guard', '--root', root],
    ['host', '--root', root, '--apply'],
  ])
    expect((await run(['recover', ...args, '--json'])).exitCode).toBe(2);
  for (const kind of [undefined, 'installation', 'host', 'guard', 'lifecycle']) {
    const result = await run(['recover', ...(kind === undefined ? [] : [kind]), '--root', root, '--json']);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      recovery: kind ?? 'installation',
      result: { status: 'current' },
    });
  }
  put(root, HOST_LOCK, JSON.stringify({ pid: process.pid }));
  const args = ['recover', 'guard', '--root', root];
  const refused = await run([...args, '--json']);
  const text = await run(args);
  expect(refused.exitCode).toBe(3);
  expect(text.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    message: expect.stringContaining('still running'),
  });
  expect(text.stderr.replace(/\s+/g, ' ')).toContain(JSON.parse(refused.stdout).next);
  expect(existsSync(resolve(root, HOST_LOCK))).toBe(true);
});

it('replays the printed guard remedy through the emitted ia entry and finishes the original apply', async () => {
  const workspace = await initialized();
  const root = resolve(scratch('recovery-spaces'), 'demo workspace');
  renameSync(workspace.root, root);
  const { env } = workspace;
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  legacyRegistration(root, env);
  const settings = read(root, '.claude/settings.local.json');
  expect(() =>
    applyGuardRegistration(planGuardRegistration(root, { remove: 'workspace' }), (stage) => {
      if (stage === 'pending') throw new Error('interrupted');
    }),
  ).toThrow('interrupted');
  const failed = await host(root, env, 'claude', '--apply', '--yes');
  expect(failed.exitCode).toBe(3);
  const next = JSON.parse(failed.stdout).next;
  expect(next).toContain(`ia recover guard --root ${quote(root)}`);
  const recovered = await runBounded(process.execPath, [resolve(cli, 'dist/main.js'), ...nextArgv(next)], {
    cwd: scratch('recovery-cwd'),
    env: { ...process.env, ...env, NODE_OPTIONS: '' },
    timeoutMs: 30_000,
  });
  expect(recovered.status, String(recovered.stderr)).toBe(0);
  expect(existsSync(resolve(root, '.ia/distributions/hosts/guard-pending.json'))).toBe(false);
  expect(read(root, '.claude/settings.local.json')).toBe(settings);
  expect(read(root, STEWARD)).toBe(LEGACY_FILES[STEWARD]);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({ guard: 'retired', removed: [{ path: STEWARD }] });
});
