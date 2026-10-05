/**
 * Host recovery acceptance: locks, pending journals and interruption at transaction boundaries.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { put, read, initialized, host, deadPid, HOST_LOCK, lockNext, doctor, row } from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';

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
async function cutAfterMcp(root: string, env: { IA_HOST_HOME: string }, cut: () => void): Promise<Raised> {
  const { collectHost, applyHostSet } = await import('../src/host.js');
  const context = await hostContext(root, env);
  try {
    applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
      if (id === 'mcp') cut();
    });
  } catch (error) {
    return error as Raised;
  }
  return {};
}
it('names the rerun after a failure past the first element, the lock recovery, or the recovery a pending journal needs', async () => {
  // The settings file changes once mcp is written, so the guard's plan is stale: the rerun finishes the set.
  const { root, env } = await initialized();
  const stale = await cutAfterMcp(root, env, () =>
    put(root, '.claude/settings.local.json', '{\n  "permissions": {}\n}\n'),
  );
  expect(stale).toMatchObject({
    code: 'IA-DIST-PLAN-STALE',
    next: rootedNext('Run "ia host claude --apply" to finish.', 'claude', root),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, '.claude/settings.local.json')).permissions).toEqual({});
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
  expect(pending.next).toBe(
    rootedNext(
      `Run "ia-distribution recover-guard --root ${quote(other.root)}", then rerun "ia host claude".`,
      'claude',
      other.root,
    ),
  );
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
    remedy: `ia-distribution recover-host --root ${quote(root)}`,
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
      remedy: `ia-distribution ${command} --root ${quote(root)}`,
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
  const managed = [
    '.mcp.json',
    '.claude/settings.local.json',
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.claude/agents/demo-steward.md',
    '.ia/distributions/hosts/claude-workspace.json',
    '.ia/distributions/hosts/claude-guard-workspace.json',
    '.ia/distributions/hosts/claude-projection.json',
  ];
  const snapshot = (): (string | null)[] =>
    managed.map((path) => (existsSync(resolve(root, path)) ? read(root, path) : null));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const reference = snapshot();
  expect(reference.every((bytes) => bytes !== null)).toBe(true);
  for (const cut of ['mcp', 'hooks'] as const) {
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
    const context = await hostContext(root, env);
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect(existsSync(resolve(root, '.claude/settings.local.json')), cut).toBe(cut === 'hooks');
    expect(existsSync(resolve(root, '.claude/rules/ia-workspace.md')), cut).toBe(false);
    // No journal is left at a boundary, so the rerun alone finishes the set.
    expect(
      readdirSync(resolve(root, '.ia/distributions/hosts')).filter(
        (name) => name.endsWith('pending.json') || name === 'lock.json',
      ),
      cut,
    ).toEqual([]);
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
    const report = await doctor(root, env);
    expect(row(report.checks, 'host-claude')?.status, cut).toBe('ok');
    expect(
      report.checks.filter((check) => check.id.startsWith('projection-claude:')),
      cut,
    ).toEqual([]);
  }
  // Removal runs projection, hooks, mcp; cut after either of the first two, the rerun removes exactly the rest.
  for (const cut of ['projection', 'hooks'] as const) {
    const context = await hostContext(root, env, '--remove');
    expect(() =>
      applyHostSet(collectHost(context), context.host.packageRoot, undefined, (id) => {
        if (id === cut) throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(existsSync(resolve(root, '.mcp.json')), cut).toBe(true);
    expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(managed.map(() => null));
    expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode, cut).toBe(0);
    expect(snapshot(), cut).toEqual(reference);
  }
});
