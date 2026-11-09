/**
 * Host doctor acceptance: registered state, drift, damaged payloads and convergent remedies.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { materializeHostPayload } from '@inventarch/distribution/host-home';
import { JOINS } from '@inventarch/distribution/implementations';
import { HOST_TREE_LIMITS, packTree } from '@inventarch/distribution/ustar';
import { json, sha256 } from '@inventarch/distribution/services';
import { collectDoctor } from '../src/doctor.js';
import { applyHostProjection, renderProjectionFor } from '../src/host-projection.js';
import { SETTINGS } from '../src/host.js';
import { quoteCommandRoot as quote, cli, commandRoots, run, scratch, cleanup } from './workspace-fixture.js';

import {
  rootedCommandNext as rootedNext,
  put,
  read,
  initialized,
  host,
  human,
  doctor,
  row,
  rootedApply,
  legacyGuard,
  legacyRegistration,
  noDrift,
  RECEIPT,
  STEWARD,
} from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';

import type { Row } from './host-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup, 120_000);

it('doctor reports registered, then stale after a simulated upgrade, and projection drift', async () => {
  const { root, env } = await initialized();
  // No host state at all is a note, never a verdict (`absent`).
  const none = await doctor(root, env);
  expect(none.exitCode).toBe(0);
  // Given --root, each command it names carries it; discovered from the cwd, neither does.
  expect(row(none.checks, 'host')).toMatchObject({
    status: 'info',
    detail: `No host registered; run "ia host claude --root ${quote(root)}" or "ia host codex --root ${quote(root)}" to plan one`,
  });
  const unrooted = JSON.parse((await run(['doctor', '--json'], { env, cwd: root })).stdout).checks as Row[];
  expect(row(unrooted, 'host')).toMatchObject({
    status: 'info',
    detail: 'No host registered; run "ia host claude" or "ia host codex" to plan one',
  });
  expect(row(none.checks, 'host-lock')).toMatchObject({ status: 'info', detail: 'Not held', remedy: null });
  expect(row(none.checks, 'host-payload')).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('not materialized'),
  });

  const release = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).plan.release as string;
  const registered = await doctor(root, env);
  expect(registered.exitCode).toBe(0);
  expect(row(registered.checks, 'host-claude')).toMatchObject({
    status: 'ok',
    remedy: null,
    detail: expect.stringContaining('registered (mcp, projection); written; not observed answering; cache '),
  });
  expect(row(registered.checks, 'host')).toBeUndefined();
  expect(row(registered.checks, 'host-payload')!.detail).toBe(
    `Release ${release.slice(0, 12)}, present in ${resolve(env.IA_HOST_HOME, 'hosts')}`,
  );
  expect(registered.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([noDrift()]);
  // An unfinished `.stage-*` materialization is never listed as a payload; another release's directory is.
  mkdirSync(resolve(env.IA_HOST_HOME, 'hosts', '.stage-interrupted'));
  mkdirSync(resolve(env.IA_HOST_HOME, 'hosts', 'a'.repeat(64)));
  expect(row((await doctor(root, env)).checks, 'host-payload')!.detail).toBe(
    `Release ${release.slice(0, 12)}, present in ${resolve(env.IA_HOST_HOME, 'hosts')}; 1 other payload there: ${'a'.repeat(12)}`,
  );

  // A simulated upgrade: the state pins another release, in the encoding the mechanisms write (§7 `stale`, REQ-HRC-5).
  const state = resolve(root, '.ia/distributions/hosts/claude-workspace.json'),
    kept = read(root, '.ia/distributions/hosts/claude-workspace.json');
  writeFileSync(state, json({ ...JSON.parse(kept), release: '0'.repeat(64) }));
  const stale = await doctor(root, env);
  expect(stale.exitCode).toBe(1);
  expect(row(stale.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (release'),
  });
  expect(row(stale.checks, 'host-claude')!.detail).toContain(`this installation pins ${release.slice(0, 12)}`);
  // Discovered from the cwd rather than given, the root is not repeated in the remedy.
  const discovered = JSON.parse((await run(['doctor', '--json'], { env, cwd: root })).stdout).checks as Row[];
  expect(row(discovered, 'host-claude')!.remedy).toBe('ia host claude --apply');
  // The remedy alone, re-applying, restores `registered` and the bytes a fresh apply wrote.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const restored = await doctor(root, env);
  expect(restored.exitCode).toBe(0);
  expect(row(restored.checks, 'host-claude')!.status).toBe('ok');
  expect(read(root, '.ia/distributions/hosts/claude-workspace.json')).toBe(kept);

  // A payload that no longer verifies is named as such, not as a release mismatch.
  const launcher = resolve(env.IA_HOST_HOME, 'hosts', release, 'scripts/ia.mjs'),
    original = readFileSync(launcher);
  writeFileSync(launcher, Buffer.concat([original, Buffer.from('\n// edited\n')]));
  const unverified = row((await doctor(root, env)).checks, 'host-claude')!;
  expect(unverified.detail).toContain('stale (launcher-unverified');
  expect(unverified.detail).toContain(
    `the payload at ${resolve(env.IA_HOST_HOME, 'hosts', release)} fails verification`,
  );
  writeFileSync(launcher, original);

  // Drift is read from the receipt. A hand edit to a file it lists is `changed`, which apply refuses; the row
  // names the same repair `ia host` does.
  put(root, '.claude/rules/ia-workspace.md', read(root, '.claude/rules/ia-workspace.md') + 'edit\n');
  const drifted = await doctor(root, env);
  expect(drifted.exitCode).toBe(1);
  expect(row(drifted.checks, 'host-claude')!.status).toBe('ok');
  expect(row(drifted.checks, 'projection-claude:.claude/rules/ia-workspace.md')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('changed'),
    remedy: rootedApply(root),
  });
  expect(row(drifted.checks, 'projection-claude:.claude/rules/ia-workspace.md')!.detail).toContain(
    'move or delete it, then run the remedy',
  );
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).next).toBe(
    `Move or delete .claude/rules/ia-workspace.md, then run "${rootedApply(root)}".`,
  );
  rmSync(resolve(root, '.claude/rules/ia-workspace.md'));
  expect(row((await doctor(root, env)).checks, 'projection-claude:.claude/rules/ia-workspace.md')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('missing'),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // Doctor never writes: a clean report leaves every managed file as the apply left it.
  const managed = [
    '.mcp.json',
    '.claude/rules/ia-workspace.md',
    '.ia/distributions/hosts/claude-workspace.json',
    RECEIPT,
  ];
  const before = managed.map((path) => read(root, path));
  expect((await doctor(root, env)).exitCode).toBe(0);
  expect(managed.map((path) => read(root, path))).toEqual(before);
});

it('reports a newly authored local system as an outdated packet, and the rerun clears it (§10 item 6)', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // The starter's own declaration shape under a new name and steward, as a user authoring a second system writes it.
  const { starterSystem } = await import('../src/init.js');
  put(root, '.ia/src/systems/extra/system.ia', starterSystem('extra'));
  const authored = await doctor(root, env);
  // The workspace still admits: the drift is the projection's, not the records'.
  expect(row(authored.checks, 'records')).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining(', 0 errors,'),
  });
  // The packet carries the revision, so the receipt's packet digest is no longer the current render's; no steward
  // agent is missing, because none is rendered, and the files the receipt lists are as it wrote them.
  const drifted = authored.checks.filter((check) => check.id.startsWith('projection-claude'));
  expect(drifted).toEqual([
    expect.objectContaining({
      id: 'projection-claude-packet',
      status: 'warn',
      detail: expect.stringContaining('outdated: the current records render packet '),
      remedy: rootedApply(root),
    }),
  ]);
  expect(authored.exitCode).toBe(0);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, '.claude/agents'))).toBe(false);
  const cleared = await doctor(root, env);
  expect(cleared.exitCode).toBe(0);
  expect(cleared.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([noDrift()]);
});

it('reports an upgraded 1.x projection as unknown until a receipt exists, then lists what its apply removed', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  // A 1.x registration wrote no receipt.
  legacyRegistration(root, env);
  rmSync(resolve(root, RECEIPT));
  const legacy = await doctor(root, env);
  expect(row(legacy.checks, 'projection-claude')).toEqual({
    id: 'projection-claude',
    title: 'Projection claude',
    status: 'unknown',
    detail: `No receipt at ${RECEIPT}: this projection was written before receipts, or its receipt was deleted; the remedy writes one`,
    remedy: rootedApply(root),
    fix: {
      program: 'ia',
      argv: commandRoots(['host', 'claude', '--root', root, '--apply']),
      flow: 'preview-apply',
      writesTo: 'repo',
    },
  });
  expect(legacy.checks.filter((check) => check.id.startsWith('projection-claude:'))).toEqual([]);
  // The remedy, followed literally, writes the receipt; its removed and foreign files are listed and not checked.
  put(root, '.claude/agents/x.md', 'my own agent\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  rmSync(resolve(root, '.claude/agents/x.md'));
  const upgraded = await doctor(root, env);
  expect(upgraded.exitCode).toBe(0);
  expect(upgraded.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([
    noDrift(),
    expect.objectContaining({
      id: 'projection-claude-receipt',
      status: 'info',
      detail: `The last apply removed ${STEWARD}; foreign, left in place: .claude/agents/x.md; listed, not checked`,
      remedy: null,
    }),
  ]);
  // A receipt that cannot be read, is not exact UTF-8, or parses without the fields doctor checks is a fail row naming
  // its repair, never an exception.
  const written = JSON.parse(read(root, RECEIPT));
  const broken = [
    'garbage\n',
    // `ÿ` as its one Latin-1 byte, 0xFF: every other byte of the receipt is ASCII.
    Buffer.from(json({ ...written, cli: '@inventarch/cli@ÿ' }), 'latin1'),
    '{}\n',
    json({ ...written, host: 'codex' }),
    json({ ...written, packetDigest: 'not a digest' }),
    json({ ...written, files: [{ path: '.claude/rules/ia-workspace.md' }] }),
    json({ ...written, removed: null }),
    json({ ...written, foreign: [1] }),
  ];
  for (const [index, bytes] of broken.entries()) {
    writeFileSync(resolve(root, RECEIPT), bytes);
    const report = await doctor(root, env);
    expect(report.exitCode, `receipt ${index}`).toBe(1);
    expect(row(report.checks, `projection-claude:${RECEIPT}`), `receipt ${index}`).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining(`Delete ${RECEIPT}, then run "${rootedApply(root)}".`),
      remedy: rootedApply(root),
    });
  }
});

it('reports an interrupted projection apply as unknown, never as a hand edit, and its rerun converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const { starterSystem } = await import('../src/init.js');
  put(root, '.ia/src/systems/extra/system.ia', starterSystem('extra'));
  // The apply stops after rewriting the rules file: its state accepts both hashes, and the last receipt is gone.
  const real = realpathSync(root);
  expect(() =>
    applyHostProjection(real, 'claude', renderProjectionFor(real, 'claude'), (stage) => {
      if (stage === '.claude/rules/ia-workspace.md') throw new Error('interrupted');
    }),
  ).toThrow('interrupted');
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
  const interrupted = await doctor(root, env);
  expect(interrupted.exitCode).toBe(0);
  expect(interrupted.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([
    expect.objectContaining({ id: 'projection-claude', status: 'unknown', remedy: rootedApply(root) }),
  ]);
  // The remedy, followed literally, converges with nothing moved.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const converged = await doctor(root, env);
  expect(converged.exitCode).toBe(0);
  expect(converged.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([noDrift()]);
});

it("names ia host's own repair for a 1.x guard group changed by hand, and that repair converges", async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  legacyGuard(root, env);
  const settings = JSON.parse(read(root, SETTINGS));
  settings.hooks.PreToolUse[0].timeout = 99;
  put(root, SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  const repair = `Delete only the IA guard group in ${SETTINGS}, then run "ia host claude --apply".`;
  // ia host refuses the retirement with this repair, and doctor names the same one.
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout)).toMatchObject({
    ok: false,
    where: { path: SETTINGS },
    next: rootedNext(repair, 'claude', root),
  });
  const stale = row((await doctor(root, env)).checks, 'host-claude')!;
  expect(stale).toMatchObject({ status: 'fail', remedy: rootedApply(root) });
  expect(stale.detail).toContain(`${SETTINGS} does not hold the IA guard group an earlier ia host wrote`);
  expect(stale.detail).toContain(rootedNext(repair, 'claude', root));
  // Followed literally: with the group deleted, the remedy retires the ownership state alone.
  delete settings.hooks;
  put(root, SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);
});

it('names the unreadable ownership file and a repair that converges, in ia host and doctor alike', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);

  // The MCP ownership state: ia host refuses at that file, and doctor reports it stale without throwing.
  const state = '.ia/distributions/hosts/claude-workspace.json';
  put(root, state, 'garbage\n');
  const repair = `Delete ${state} and the ia-workspace entry in .mcp.json, then run "ia host claude --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout)).toMatchObject({
    ok: false,
    where: { path: state },
    next: rootedNext(repair, 'claude', root),
  });
  const broken = await doctor(root, env);
  expect(broken.exitCode).toBe(1);
  const claude = row(broken.checks, 'host-claude')!;
  expect(claude).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (state-invalid)'),
  });
  expect(claude.detail).toContain(rootedNext(repair, 'claude', root));
  // The named repair, followed literally, converges.
  rmSync(resolve(root, state));
  const mcp = JSON.parse(read(root, '.mcp.json'));
  delete mcp.mcpServers['ia-workspace'];
  put(root, '.mcp.json', JSON.stringify(mcp, null, 2) + '\n');
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // The guard's ownership state: the same shape of repair, naming the guard group.
  const guard = '.ia/distributions/hosts/claude-guard-workspace.json';
  put(root, guard, 'garbage\n');
  const guardRepair = `Delete ${guard} and the IA guard group in .claude/settings.local.json, then run "ia host claude --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout)).toMatchObject({
    ok: false,
    where: { path: guard },
    next: rootedNext(guardRepair, 'claude', root),
  });
  expect(row((await doctor(root, env)).checks, 'host-claude')!.detail).toContain(
    rootedNext(guardRepair, 'claude', root),
  );
  // ia host registers no guard group, so deleting the state file is the whole repair here.
  rmSync(resolve(root, guard));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // An unreadable projection state is a fail row of its own, never an exception; deleting it is the repair.
  put(root, '.ia/distributions/hosts/claude-projection.json', 'garbage\n');
  const projection = await doctor(root, env);
  expect(projection.exitCode).toBe(1);
  expect(row(projection.checks, 'projection-claude')).toMatchObject({ status: 'fail', remedy: rootedApply(root) });
  rmSync(resolve(root, '.ia/distributions/hosts/claude-projection.json'));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // A .mcp.json that no longer parses asks for valid JSON first, as ia host does; deleting an entry is not the repair.
  const kept = read(root, '.mcp.json');
  put(root, '.mcp.json', '{ not json\n');
  expect(row((await doctor(root, env)).checks, 'host-claude')!.detail).toContain(
    `Make .mcp.json parse as JSON, then run "${rootedApply(root)}".`,
  );
  put(root, '.mcp.json', kept);
  expect((await doctor(root, env)).exitCode).toBe(0);
});

it('doctor warns when a registration pins its payload outside the IA home, and re-applying clears it', async () => {
  // Host plugin distribution spec §3: registered before the move, under what stands in for the former per-OS home.
  const { root } = await initialized();
  const data = scratch('legacy-data'),
    before = { IA_HOST_HOME: join(data, 'ia') };
  expect((await host(root, before, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const moved = { IA_HOME: resolve(scratch('moved-home'), '.ia'), LOCALAPPDATA: data, XDG_DATA_HOME: data };
  const report = JSON.parse((await run(['doctor', '--json'], { env: moved, cwd: root })).stdout);
  const warning = row(report.checks, 'ia-home-moved-claude')!;
  expect(warning).toMatchObject({ status: 'warn', remedy: 'ia host claude --apply' });
  expect(warning.detail).toMatch(/^Host claude pins its payload under .+, outside the IA home /);
  expect(warning.detail).toContain(`outside the IA home ${moved.IA_HOME}`);
  // legacyHostHome reads LOCALAPPDATA on win32 and XDG_DATA_HOME on Linux; macOS derives it from the user's home.
  if (process.platform !== 'darwin') expect(warning.detail).toMatch(/ \(the per-OS location earlier releases used\)$/);
  // The registration still works, so doctor warns rather than fails; the briefing names the same remedy.
  expect(row(report.checks, 'host-claude')!.status).toBe('ok');
  expect(report.counts.fail).toBe(0);
  const briefed = JSON.parse((await run(['doctor', '--host', 'claude', '--json'], { env: moved, cwd: root })).stdout);
  expect(briefed.session.notice).toBe(
    'IA: the Claude host registration for this workspace is stale; run ia host claude --apply',
  );
  // Given --root, the remedy carries it, as every other ia host remedy doctor prints does.
  expect(row((await doctor(root, moved)).checks, 'ia-home-moved-claude')!.remedy).toBe(rootedApply(root));

  expect((await host(root, moved, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const after = JSON.parse((await run(['doctor', '--json'], { env: moved, cwd: root })).stdout);
  expect(row(after.checks, 'ia-home-moved-claude')).toBeUndefined();
  expect(row(after.checks, 'host-claude')!.status).toBe('ok');
});

it('doctor fails a forged registration and a vanished Node executable, and each named repair converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const state = '.ia/distributions/hosts/claude-workspace.json';
  // Rewrites the recorded server in the ownership state and in .mcp.json alike, so the file matches what the state claims.
  const rewrite = (server: { command: string; args: string[] }): void => {
    const config = JSON.parse(read(root, '.mcp.json'));
    config.mcpServers['ia-workspace'] = server;
    put(root, '.mcp.json', JSON.stringify(config, null, 2) + '\n');
    put(root, state, json({ ...JSON.parse(read(root, state)), owned: json(server) }));
  };
  const recorded = JSON.parse(read(root, '.mcp.json')).mcpServers['ia-workspace'] as {
    command: string;
    args: string[];
  };
  rewrite({ command: resolve(root, 'tools/run.cmd'), args: ['--anything'] });
  const forged = await doctor(root, env);
  expect(forged.exitCode).toBe(1);
  expect(row(forged.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('stale (mcp-modified)'),
  });
  expect(row(forged.checks, 'host-claude')!.detail).toContain(
    rootedNext(
      'Delete the ia-workspace entry in .mcp.json, then run "ia host claude --remove --apply" and register again.',
      'claude',
      root,
    ),
  );
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);

  // A Node executable that is gone (an upgrade moved it): the remedy alone records the running one.
  rewrite({ ...recorded, command: resolve(scratch('gone-node'), basename(process.execPath)) });
  const moved = await doctor(root, env);
  expect(moved.exitCode).toBe(1);
  expect(row(moved.checks, 'host-claude')).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root),
    detail: expect.stringContaining('stale (node-missing)'),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);
  expect(JSON.parse(read(root, '.mcp.json')).mcpServers['ia-workspace']).toEqual(recorded);
});

it('names the whole Codex IA block as the repair for an edit inside it, and the repair converges', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  const config = read(root, '.codex/config.toml');
  put(
    root,
    '.codex/config.toml',
    config.replace('[mcp_servers."ia-workspace"]\n', '[mcp_servers."ia-workspace"]\nstartup_timeout_sec = 30\n'),
  );
  const block =
    'Delete the IA block in .codex/config.toml, from "# BEGIN IA PROJECTION host-workspace" through "# END IA PROJECTION host-workspace", markers included';
  const next = `${block}, then run "ia host codex --remove --apply" and register again.`;
  expect(JSON.parse((await host(root, env, 'codex', '--apply', '--yes')).stdout)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    next: rootedNext(next, 'codex', root),
  });
  const stale = await doctor(root, env);
  expect(stale.exitCode).toBe(1);
  const codex = row(stale.checks, 'host-codex')!;
  expect(codex).toMatchObject({
    status: 'fail',
    remedy: rootedApply(root, 'codex'),
    detail: expect.stringContaining('stale (mcp-modified)'),
  });
  expect(codex.detail).toContain(rootedNext(next, 'codex', root));
  expect(codex.detail).not.toMatch(
    /claude-guard|claude-workspace|claude-projection|\.mcp\.json|settings\.local|ia host claude/,
  );
  // Followed literally: the markers and everything between them go, then removal and registration.
  const edited = read(root, '.codex/config.toml');
  const from = edited.indexOf('# BEGIN IA PROJECTION host-workspace'),
    through = edited.indexOf('# END IA PROJECTION host-workspace\n') + '# END IA PROJECTION host-workspace\n'.length;
  put(root, '.codex/config.toml', edited.slice(0, from) + edited.slice(through));
  expect((await host(root, env, 'codex', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  const healed = await doctor(root, env);
  expect(row(healed.checks, 'host-codex')!.status).toBe('ok');
  expect(healed.exitCode).toBe(0);

  // Codex's unreadable ownership state names Codex's own files only.
  put(root, '.ia/distributions/hosts/codex-workspace.json', 'garbage\n');
  const invalid = row((await doctor(root, env)).checks, 'host-codex')!;
  expect(invalid.detail).toContain(
    'Delete .ia/distributions/hosts/codex-workspace.json and the IA block in .codex/config.toml',
  );
  expect(invalid.detail).not.toMatch(
    /claude-guard|claude-workspace|claude-projection|\.mcp\.json|settings\.local|ia host claude/,
  );
});

it('doctor notes an installation without a host payload and still observes the host', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const { dispatch } = await import('../src/consumer.js');
  const { makeHost } = await import('./workspace-fixture.js');
  const result = await dispatch(
    ['doctor', '--root', root, '--json'],
    { ...makeHost({ env }), packageRoot: scratch('bare-package') },
    () => ({ exitCode: 2, stdout: '' }),
    [],
  );
  const checks = JSON.parse(result.stdout).checks as Row[];
  expect(row(checks, 'host-payload')).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('carries no host payload (IA-DIST-ARTIFACT-UNAVAILABLE)'),
  });
  // Without a pin the release comparison is skipped, so the registration is still `ok`.
  expect(row(checks, 'host-claude')!.status).toBe('ok');
  expect(result.exitCode).toBe(0);
});

it('names --root in every ia host next action only when the invocation gave it, in JSON and human output alike', async () => {
  const { root, env } = await initialized();
  put(root, '.claude/rules/ia-workspace.md', 'user\n');
  const bare = 'Move or delete .claude/rules/ia-workspace.md, then run "ia host claude --apply".';
  const rooted = `Move or delete .claude/rules/ia-workspace.md, then run "ia host claude --root ${quote(root)} --apply".`;
  expect(JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).next).toBe(rooted);
  const humanRefusal = await human(root, env, 'claude', '--apply', '--yes');
  expect(humanRefusal.exitCode).toBe(3);
  expect(humanRefusal.stderr.replace(/\s+/g, ' ')).toContain(rooted);
  // The preview's conflict row prints the same next action the refusal carries, and its undo line carries the root;
  // the JSON plan's `undo` stays the unrooted command.
  // A command too long for the line is broken with a trailing `\`, which a reader's shell joins back.
  const joined = (text: string): string => text.replace(/ \\\r?\n\s*/g, ' ').replace(/\s+/g, ' ');
  const preview = joined((await human(root, env, 'claude')).stdout);
  expect(preview).toContain(rooted);
  expect(preview).toContain(`Undo with "ia host claude --root ${quote(root)} --remove --apply".`);
  expect(JSON.parse((await host(root, env, 'claude')).stdout).plan.undo).toBe('ia host claude --remove --apply');
  expect(joined((await run(['host', 'claude'], { env, cwd: root })).stdout)).toContain(
    'Undo with "ia host claude --remove --apply".',
  );
  // A discovered root prints the bare command: it runs from the same cwd.
  const discovered = await run(['host', 'claude', '--apply', '--yes', '--json'], { env, cwd: root });
  expect(JSON.parse(discovered.stdout).next).toBe(bare);
  // Refusals raised before a plan exists carry the root too.
  const gated = await host(root, env, 'claude', '--context', 'x');
  expect(JSON.parse(gated.stdout).next).toBe(
    `Run "ia host claude --root ${quote(root)}" to plan the registration without the context element.`,
  );
});

it('reports real hand edits without a receipt and the repair converges', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  const path = '.claude/rules/ia-workspace.md';
  put(root, path, read(root, path) + 'my edit\n');
  const report = await doctor(root, env);
  expect(report.exitCode).toBe(1);
  const checks = report.checks;
  expect(checks).toContainEqual(
    expect.objectContaining({
      id: `projection-claude:${path}`,
      status: 'fail',
      detail: expect.stringContaining('move or delete'),
    }),
  );
  expect(checks).toContainEqual(
    expect.objectContaining({
      id: 'projection-claude',
      status: 'unknown',
      detail: expect.not.stringContaining('the remedy writes one'),
    }),
  );
  rmSync(resolve(root, path));
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect((await doctor(root, env)).exitCode).toBe(0);
});

/** Every entry under `roots`, with each file's size, modification time and digest: a write anywhere changes it. */
function tree(...roots: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const top of roots)
    for (const entry of readdirSync(top, { recursive: true, encoding: 'utf8' })) {
      const path = resolve(top, entry),
        stat = statSync(path);
      entries[path] = stat.isDirectory() ? 'directory' : `${stat.size} ${stat.mtimeMs} ${sha256(readFileSync(path))}`;
    }
  return entries;
}

it('doctor lists the installed-implementation catalog and the join ia host recorded, and writes nothing', async () => {
  const { root, env } = await initialized();
  /** Doctor in the current state, checked to leave the workspace and the IA home exactly as it found them. */
  const quiet = async () => {
    const before = tree(root, env.IA_HOST_HOME);
    const report = await doctor(root, env);
    expect(tree(root, env.IA_HOST_HOME)).toEqual(before);
    return report;
  };
  // Before any apply the payload is not materialized, and the catalog row says so.
  expect(row((await doctor(root, env)).checks, 'implementations')).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('is not materialized; ia host materializes it'),
  });
  const release = JSON.parse((await host(root, env, 'claude', '--apply', '--yes')).stdout).plan.release as string;
  // ia host records the claude join from its committed registration: the catalog the materialized payload carries,
  // at the workspace's authored revision, which the projection receipt names too.
  const recorded = JSON.parse(read(root, JOINS)),
    payload = resolve(env.IA_HOST_HOME, 'hosts', release);
  expect(recorded).toEqual({
    format: 'ia.host-joins.v1',
    joins: [
      {
        consumer: 'claude',
        implementation: 'installed-implementations',
        version: JSON.parse(read(cli, 'package.json')).version,
        digest: sha256(readFileSync(resolve(payload, 'implementations.json'))),
        release,
        consumerRevision: JSON.parse(read(root, RECEIPT)).revision,
      },
    ],
  });
  const before = tree(root, env.IA_HOST_HOME);
  const report = await doctor(root, env);
  expect(tree(root, env.IA_HOST_HOME)).toEqual(before);
  expect(report.exitCode).toBe(0);
  expect(row(report.checks, 'implementations')).toMatchObject({
    status: 'ok',
    remedy: null,
    detail: expect.stringContaining('captured-source-read available (handler captured-source-read, shipped bytes '),
  });
  expect(report.checks.filter((check) => check.id.startsWith('join'))).toEqual([
    expect.objectContaining({
      id: 'join-claude',
      status: 'ok',
      remedy: null,
      detail: expect.stringContaining('present: joined installed-implementations '),
    }),
  ]);

  // A module the inventory does not list, planted where Node would load it instead of a shipped one, fails host
  // verification, and the catalog and join rows agree: nothing in that payload is listed or joined as present.
  const planted = resolve(payload, 'runtime/node_modules/@inventarch/agent-composition-system/node_modules');
  put(planted, '@inventarch/agent-system/package.json', JSON.stringify({ name: '@inventarch/agent-system' }));
  put(planted, '@inventarch/agent-system/index.js', 'export const planted = true;\n');
  const shadowed = await quiet();
  expect(shadowed.exitCode).toBe(1);
  expect(row(shadowed.checks, 'host-claude')!.status).toBe('fail');
  expect(row(shadowed.checks, 'implementations')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('IA-DIST-INTEGRITY-MISMATCH'),
  });
  expect(row(shadowed.checks, 'join-claude')).toMatchObject({
    status: 'unknown',
    detail: expect.stringContaining('cannot be verified (IA-DIST-INTEGRITY-MISMATCH)'),
  });
  rmSync(planted, { recursive: true });
  expect(row((await doctor(root, env)).checks, 'implementations')!.status).toBe('ok');

  // A join that names another catalog is drifted, and the remedy records the current one again.
  put(root, JOINS, json({ ...recorded, joins: [{ ...recorded.joins[0], digest: '0'.repeat(64) }] }));
  const drifted = await quiet();
  expect(drifted.exitCode).toBe(0);
  expect(row(drifted.checks, 'join-claude')).toMatchObject({
    status: 'warn',
    remedy: rootedApply(root),
    detail: expect.stringContaining(`drifted: joined installed-implementations`),
  });
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, JOINS))).toEqual(recorded);
  expect(row((await doctor(root, env)).checks, 'join-claude')!.status).toBe('ok');

  // The join row trusts what ia validate trusts. A registration naming a copy of the payload
  // inside the workspace (another directory holding the same bytes) is drifted, with the apply that registers this
  // installation's own payload, where it used to read the copy and say ok.
  const registration = '.ia/distributions/hosts/claude-workspace.json',
    genuine = read(root, registration),
    copy = resolve(root, '.ia/work/payload-copy');
  cpSync(payload, copy, { recursive: true });
  put(root, registration, json({ ...JSON.parse(genuine), cache: copy }));
  expect(row((await quiet()).checks, 'join-claude')).toMatchObject({
    status: 'warn',
    remedy: rootedApply(root),
    detail: expect.stringContaining(
      `host claude's registration names a payload other than ${payload} (another directory or another spelling of it)`,
    ),
  });
  put(root, registration, genuine);
  rmSync(copy, { recursive: true });
  expect(row((await doctor(root, env)).checks, 'join-claude')!.status).toBe('ok');

  // Receipts that cannot be read fail with their repair; with none recorded, the registered host's join is unavailable.
  put(root, JOINS, '{broken');
  const broken = await quiet();
  expect(broken.exitCode).toBe(1);
  expect(row(broken.checks, 'joins')).toMatchObject({ status: 'fail', remedy: rootedApply(root) });
  expect(row(broken.checks, 'joins')!.detail).toContain(`Delete ${JOINS}`);
  // ia host never replaces them either; its refusal names the same repair, which converges.
  const refused = await host(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    where: { path: JOINS },
    next: `Delete ${JOINS}, then run "${rootedApply(root)}".`,
  });
  expect(read(root, JOINS)).toBe('{broken');
  rmSync(resolve(root, JOINS));
  expect(row((await doctor(root, env)).checks, 'join-claude')).toMatchObject({
    status: 'info',
    remedy: rootedApply(root),
    detail: expect.stringContaining('unavailable: no join recorded for host claude'),
  });

  // A registration deleted by hand leaves its join drifted, naming the removal that drops it; doctor writes nothing.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const state = '.ia/distributions/hosts/claude-workspace.json',
    kept = read(root, state);
  rmSync(resolve(root, state));
  expect(row((await quiet()).checks, 'join-claude')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('but host claude is not registered'),
    remedy: `ia host claude --root ${quote(root)} --remove --apply`,
  });
  put(root, state, kept);

  // Removing the registration drops its join, and doctor then lists none.
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, JOINS))).toBe(true);
  expect((await host(root, env, 'claude', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  const removed = await doctor(root, env);
  expect(removed.checks.filter((check) => check.id.startsWith('join'))).toEqual([]);
  expect(row(removed.checks, 'implementations')!.status).toBe('ok');
});

/** An installation package root whose bundled payload carries `catalog` (or none), materialized in `home`. */
function installation(home: string, catalog: unknown | null): string {
  const packageRoot = resolve(scratch('host-catalog-package'), 'cli'),
    files = new Map<string, Buffer>();
  if (catalog !== null) files.set('implementations.json', Buffer.from(json(catalog)));
  const inventory = json({
    format: 'ia.host-cache.v2',
    version: '9.9.9',
    packages: [],
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  });
  const launcher = '// launcher\n',
    release = json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) });
  const archive = packTree(
    new Map([
      ...files,
      ['inventory.json', Buffer.from(inventory)],
      ['scripts/ia.mjs', Buffer.from(launcher)],
      ['release.json', Buffer.from(release)],
    ]),
    HOST_TREE_LIMITS,
  );
  const pin = { release: sha256(release), archive: sha256(archive), files: files.size + 3, bytes: 0 };
  put(packageRoot, 'assets/host.json', JSON.stringify(pin));
  mkdirSync(resolve(packageRoot, 'assets/host'), { recursive: true });
  writeFileSync(resolve(packageRoot, `assets/host/${pin.archive}.tgz`), archive);
  materializeHostPayload({ home, archive, pin });
  return packageRoot;
}
it('notes a payload that carries no catalog and warns about one that lists an operation unavailable or revoked', async () => {
  const { root, env } = await initialized();
  const report = (packageRoot: string) =>
    collectDoctor({
      cwd: root,
      root,
      packageRoot,
      runtime: { version: process.version, platform: process.platform, arch: process.arch },
      env,
      home: env.IA_HOST_HOME,
    }).checks.find((check) => check.id === 'implementations');
  expect(report(installation(env.IA_HOST_HOME, null))).toMatchObject({
    status: 'info',
    detail: expect.stringContaining('carries no installed-implementation catalog'),
  });
  const degraded = report(
    installation(env.IA_HOST_HOME, {
      format: 'ia.installed-implementations.v1',
      evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
      operations: [
        { id: 'missing-read-v1', status: 'unavailable', reason: 'its package is not installed in this repository' },
        { id: 'withdrawn-read-v1', status: 'revoked', reason: 'withdrawn by its producer' },
      ],
    }),
  );
  expect(degraded).toMatchObject({ status: 'warn', remedy: null });
  expect(degraded!.detail).toContain('missing-read-v1 unavailable (its package is not installed in this repository)');
  expect(degraded!.detail).toContain('withdrawn-read-v1 revoked (withdrawn by its producer)');
});

it('records a codex join and an ia init --host join, and doctor lists each', async () => {
  const { root, env } = await initialized();
  expect((await host(root, env, 'codex', '--apply', '--yes')).exitCode).toBe(0);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, JOINS)).joins.map((join: { consumer: string }) => join.consumer)).toEqual([
    'claude',
    'codex',
  ]);
  const report = await doctor(root, env);
  for (const id of ['join-claude', 'join-codex']) expect(row(report.checks, id), id).toMatchObject({ status: 'ok' });
  expect((await host(root, env, 'codex', '--remove', '--apply', '--yes')).exitCode).toBe(0);
  expect(JSON.parse(read(root, JOINS)).joins.map((join: { consumer: string }) => join.consumer)).toEqual(['claude']);
  // ia init --host goes through the same apply, so it records the join too.
  const fresh = resolve(scratch('host-init-join'), 'demo');
  expect((await run(['init', fresh, '--apply', '--yes', '--json', '--host', 'claude'], { env })).exitCode).toBe(0);
  expect(JSON.parse(read(fresh, JOINS))).toMatchObject({
    joins: [{ consumer: 'claude', implementation: 'installed-implementations' }],
  });
});
