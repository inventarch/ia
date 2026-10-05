/**
 * Host doctor acceptance: registered state, drift, damaged payloads and convergent remedies.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 * See docs/specs/host-registration/README.md §§4–10.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { json } from '@inventarch/distribution/services';
import { rootedNext } from '../src/host.js';
import { quote } from '../src/render.js';
import { run, scratch } from './workspace-fixture.js';
import { put, read, initialized, host, human, doctor, row, rootedApply } from './host-fixture.js';
import { afterAll, expect, it, vi } from 'vitest';
import { cleanup } from './workspace-fixture.js';
import type { Row } from './host-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

it('doctor reports registered, then stale after a simulated upgrade, and projection drift', async () => {
  const { root, env } = await initialized();
  // No host state at all is a note, never a verdict (spec §7 `absent`).
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
    detail: expect.stringContaining('registered (mcp, hooks, projection); written; not observed answering; cache '),
  });
  expect(row(registered.checks, 'host')).toBeUndefined();
  expect(row(registered.checks, 'host-payload')!.detail).toBe(
    `Release ${release.slice(0, 12)}, present in ${resolve(env.IA_HOST_HOME, 'hosts')}`,
  );
  expect(registered.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([]);
  // §3.3: an unfinished `.stage-*` materialization is never listed as a payload; another release's directory is.
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
  // §10 item 3's second half: the remedy alone, re-applying, restores `registered` and the bytes a fresh apply wrote.
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

  // A hand edit to a projected file is `changed`, which apply refuses; the row names the same repair `ia host` does.
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
    '.claude/settings.local.json',
    '.claude/rules/ia-workspace.md',
    '.ia/distributions/hosts/claude-workspace.json',
  ];
  const before = managed.map((path) => read(root, path));
  expect((await doctor(root, env)).exitCode).toBe(0);
  expect(managed.map((path) => read(root, path))).toEqual(before);
});

it('reports a newly authored local system as outdated and missing projection files, and the rerun clears both (§10 item 6)', async () => {
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
  // Every projected file embeds the source revision, so each existing one is outdated; the new steward's is missing.
  const drifted = authored.checks.filter((check) => check.id.startsWith('projection-claude:'));
  expect(drifted).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'projection-claude:.claude/rules/ia-workspace.md',
        status: 'warn',
        detail: expect.stringContaining('outdated'),
      }),
      expect.objectContaining({
        id: 'projection-claude:.claude/agents/extra-steward.md',
        status: 'warn',
        detail: expect.stringContaining('missing'),
      }),
    ]),
  );
  expect(drifted.every((check) => check.status === 'warn' && /\b(outdated|missing)\b/.test(check.detail))).toBe(true);
  expect(authored.exitCode).toBe(0);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(read(root, '.claude/rules/ia-workspace.md')).toContain('extra-steward');
  expect(existsSync(resolve(root, '.claude/agents/extra-steward.md'))).toBe(true);
  const cleared = await doctor(root, env);
  expect(cleared.exitCode).toBe(0);
  expect(cleared.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([]);
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
  rmSync(resolve(root, guard));
  const settings = JSON.parse(read(root, '.claude/settings.local.json'));
  settings.hooks.PreToolUse = [];
  put(root, '.claude/settings.local.json', JSON.stringify(settings, null, 2) + '\n');
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
  // Host plugin distribution spec §3: registered before the move, under what stands in for M5.3's per-OS directory.
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
  if (process.platform !== 'darwin') expect(warning.detail).toMatch(/ \(the M5\.3 per-OS location\)$/);
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
      'Delete the ia-workspace entry in .mcp.json, then run "ia host claude --remove --apply" and "ia host claude --apply".',
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
  const next = `${block}, then run "ia host codex --remove --apply" and "ia host codex --apply".`;
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
  // the JSON plan's `undo` stays the unrooted command (§4 `--json`).
  // A command too long for the line is broken with a trailing `\` (§6.4), which a reader's shell joins back.
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
  expect(JSON.parse(gated.stdout).next).toBe(`Run "ia host claude --root ${quote(root)}" without --context.`);
});
